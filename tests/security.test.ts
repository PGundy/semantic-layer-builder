// Reproductions of the read-only and data-exposure bypasses found in review. Each runs once
// through the CLI, where lib/sql-guard.ts refuses it first, and once against the adapter directly
// (no guard), where the connection itself refuses it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { openAdapter, type Adapter } from "../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { statementTimeout } from "../skills/semantic-layer/scripts/lib/adapters/postgres.ts";
import { compareRows, goldenQueryId } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { formatTable, plainText, PROTECTED_VALUE } from "../skills/semantic-layer/scripts/lib/output.ts";
import { executePlan } from "../skills/semantic-layer/scripts/lib/plan.ts";
import {
  assertSourceSafe,
  globInsideViews,
  parseViewRelation,
  setupProblem,
  sourceSafetyIssues,
  viewFiles,
} from "../skills/semantic-layer/scripts/lib/source-safety.ts";
import { assertReadOnly, tokenize } from "../skills/semantic-layer/scripts/lib/sql-guard.ts";
import type { Model, QueryPlan, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, isLocalPg, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function temp() {
  const t = tempRoot();
  cleanup = t.cleanup;
  return t;
}

async function refused(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => (e as Error).message,
  );
}

// The reviewers' Postgres bypasses: several statements hidden in what a regex reads as a string.
const pgMulti = (table: string) => [
  `select E'\\''; commit; set default_transaction_read_only = off; commit; delete from ${table}; commit; select 'x'`,
  `select $$'$$; commit; set default_transaction_read_only = off; commit; delete from ${table}; commit; select '$$'`,
  `select $tag$'$tag$; delete from ${table}; select '$tag$'`,
];

// The reviewers' DuckDB bypasses, writing a file under `dir`.
const duckWrites = (dir: string) => ({
  dollar: `select $$'$$; copy (select 'owned' as x) to '${join(dir, "PWNED.txt")}'; select '$$'`,
  estring: `select E'\\''; copy (select 'owned' as x) to '${join(dir, "PWNED2.txt")}'; select 'x'`,
  explainAnalyze: `explain analyze copy (select 42 as x) to '${join(dir, "EA_PWNED.csv")}'`,
  copy: `copy (select 1 as x) to '${join(dir, "COPY.csv")}'`,
});
const WRITTEN = ["PWNED.txt", "PWNED2.txt", "EA_PWNED.csv", "COPY.csv"];

describe("the guard refuses every reviewer bypass", () => {
  const bypasses = [
    ...pgMulti("t"),
    ...Object.values(duckWrites("/tmp/x")),
    "explain (analyze) select 1",
    "explain analyse copy (select 1) to 'x.csv'",
    "select set_config('default_transaction_read_only', 'off', false)",
    "select pg_read_file('/etc/passwd')",
    "select pg_catalog.\"pg_read_file\"('/etc/passwd')",
    "select pg_read_binary_file('/etc/passwd')",
    "select * from pg_ls_dir('.')",
    "select pg_stat_file('/etc/passwd')",
    "select lo_import('/etc/passwd')",
    "select lo_export(1, '/tmp/x')",
    "select lo_get(1)",
    "select * from dblink('host=x', 'delete from t') as r(x int)",
    "select dblink_exec('host=x', 'delete from t')",
    "select pg_terminate_backend(1)",
    "select pg_cancel_backend(1)",
    "select content from read_text('/etc/hostname')",
    "select * from read_blob('/etc/hostname')",
    "select * from glob('/etc/*')",
    "select query_to_xml('select pg_read_file(''/etc/passwd'')', true, true, '')",
    "select * from query('select 1')",
    "select * into t2 from t",
    "select * from t for update",
    "with a as (delete from t returning *) select * from a",
    "with a as (select 1) delete from t",
  ];
  test.each(bypasses)("refuses %s", (q) => {
    expect(() => assertReadOnly(q)).toThrow();
  });

  const reads = [
    "select id as comment from t",
    "select count(load), max(start) as reset from t",
    "select 'a;b' as s, $$c;d$$ as d, E'it\\'s' as e",
    "select \"set\", \"copy\" from t",
    "select case when (a > 0) then 1 end as x from t",
    "explain select * from t",
    "select 1 -- ; drop table t\n",
    "/* nested /* ; */ comment */ select 1;",
  ];
  test.each(reads)("allows %s", (q) => {
    expect(() => assertReadOnly(q)).not.toThrow();
  });

  test("glob is allowed only inside the paths a source's views read", () => {
    const root = "/r/semantic";
    const source = { connection: { views: { ev: "read_parquet('../lake/events/*.parquet')" } } };
    const opts = { globAllowed: (p: string) => globInsideViews(root, source, p) };
    expect(() => assertReadOnly("select * from glob('../lake/events/*.parquet')", opts)).not.toThrow();
    expect(() => assertReadOnly("select * from glob('/r/lake/events/x.parquet')", opts)).not.toThrow();
    expect(() => assertReadOnly("select * from glob('/etc/*')", opts)).toThrow("glob");
    expect(() => assertReadOnly("select * from glob('/r/lake/events/../../../etc/*')", opts)).toThrow("glob");
    expect(() => assertReadOnly("select * from glob('../lake/*')", opts)).toThrow("glob");
  });

  test("the tokenizer reads E-strings, dollar quotes, identifiers and nested comments as the databases do", () => {
    const kinds = (q: string) => tokenize(q).map((t) => `${t.kind}:${t.text}`);
    expect(kinds("select E'a\\'b;c' x")).toEqual(["word:select", "string:a'b;c", "word:x"]);
    expect(kinds("select $q$ a;'$$ $q$, $1")).toEqual(["word:select", "string: a;'$$ ", "op:,", "param:$1"]);
    expect(kinds('select "a""b;" /* x /* y */ ; */ ;')).toEqual(["word:select", 'ident:a"b;', "semicolon:;"]);
    expect(() => tokenize("select 'open")).toThrow("unterminated string");
    expect(() => tokenize("select $a$ open")).toThrow("unterminated dollar-quoted string");
    expect(() => tokenize("select /* open")).toThrow("unterminated comment");
  });
});

describe("DuckDB refuses writes at the driver, without the guard", () => {
  async function adapter(dir: string, root: string, source: Partial<SourceConfig> = {}): Promise<Adapter> {
    return openAdapter(root, { source: "lake", dialect: "duckdb", ...source }, {});
  }

  test("multi-statement, EXPLAIN ANALYZE and COPY writes create no file", async () => {
    const t = temp();
    mkdirSync(t.dir, { recursive: true });
    const a = await adapter(t.dir, t.dir);
    try {
      for (const q of Object.values(duckWrites(t.dir))) await refused(a.query(q));
      expect(await refused(a.query(duckWrites(t.dir).dollar))).toContain("one statement");
      for (const f of WRITTEN) expect(existsSync(join(t.dir, f))).toBe(false);
    } finally {
      await a.close();
    }
  });

  test("local files outside the views, settings, extensions and attachments are out of reach", async () => {
    const t = temp();
    mkdirSync(join(t.dir, "lake"), { recursive: true });
    const secret = join(t.dir, "secret.txt");
    writeFileSync(secret, "top secret\n");
    writeFileSync(join(t.dir, "outside.csv"), "a\n1\n");
    const a = await adapter(t.dir, t.dir);
    try {
      expect(await refused(a.query(`select content from read_text('${secret}')`))).toContain("disabled by configuration");
      expect(await refused(a.query(`select * from read_csv('${join(t.dir, "outside.csv")}')`))).toContain("disabled by configuration");
      expect(await refused(a.query(`select * from glob('${t.dir}/*')`))).toContain("disabled by configuration");
      for (const q of [
        "set enable_external_access = true",
        "set lock_configuration = false",
        "select set_config('enable_external_access', 'true')",
        `attach '${join(t.dir, "x.duckdb")}' as x`,
        "install httpfs",
        "load httpfs",
        "create table t as select 1 as x",
        "call pragma_version()",
        "pragma enable_profiling",
        "begin transaction",
      ]) {
        await refused(a.query(q));
      }
      expect(existsSync(join(t.dir, "x.duckdb"))).toBe(false);
      expect((await a.query("select current_setting('enable_external_access') as e, current_setting('lock_configuration') as l")).rows).toEqual([
        { e: false, l: true },
      ]);
      expect((await a.query("describe select 1 as x")).rows.length).toBe(1);
    } finally {
      await a.close();
    }
  });

  test("views over files keep reading them, and nothing else under the root opens", async () => {
    const t = temp();
    const lake = join(t.dir, "lake", "events");
    mkdirSync(lake, { recursive: true });
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    await c.run(`copy (select 1 as id) to '${join(lake, "a.parquet")}' (format parquet)`);
    await c.run(`copy (select 2 as id) to '${join(lake, "b.parquet")}' (format parquet)`);
    await c.run(`copy (select 3 as id) to '${join(t.dir, "lake", "one.parquet")}' (format parquet)`);
    c.closeSync();
    db.closeSync();
    writeFileSync(join(t.dir, "lake", "other.csv"), "a\n1\n");
    const root = join(t.dir, "semantic");
    mkdirSync(root, { recursive: true });
    const a = await adapter(t.dir, root, {
      connection: { views: { events: "read_parquet('../lake/events/*.parquet')", one: "read_parquet('../lake/one.parquet')" } },
    });
    try {
      expect((await a.query("select sum(id) as n from events")).rows).toEqual([{ n: 3 }]);
      expect((await a.query("select id from one")).rows).toEqual([{ id: 3 }]);
      expect((await a.query(`select count(*) as n from glob('${lake}/*.parquet')`)).rows).toEqual([{ n: 2 }]);
      expect(await refused(a.query("select * from read_csv('../lake/other.csv')"))).toContain("disabled by configuration");
      // File access is open inside the views' directory, so the statement type is what refuses these.
      expect(await refused(a.query(`copy (select 1) to '${join(lake, "c.parquet")}'`))).toContain("COPY");
      expect(await refused(a.query(`explain analyze copy (select 1) to '${join(lake, "d.csv")}'`))).toContain("EXPLAIN ANALYZE");
      expect(await refused(a.query(`select 1; copy (select 1) to '${join(lake, "e.csv")}'`))).toContain("one statement");
      for (const f of ["c.parquet", "d.csv", "e.csv"]) expect(existsSync(join(lake, f))).toBe(false);
    } finally {
      await a.close();
    }
  });

  test("a source with an unsafe setup statement or view is refused before anything runs", async () => {
    const t = temp();
    mkdirSync(t.dir, { recursive: true });
    const out = join(t.dir, "SETUP_PWNED.csv");
    const cases: Partial<SourceConfig>[] = [
      { connection: { setup: [`COPY (select 1) TO '${out}'`] } },
      { connection: { setup: ["INSTALL httpfs; COPY (select 1) TO 'x.csv'"] } },
      { connection: { setup: [`ATTACH '${join(t.dir, "a.duckdb")}' AS a`] } },
      { connection: { setup: ["SET enable_external_access = true"] } },
      { connection: { setup: ["CREATE SECRET (TYPE s3, KEY_ID 'AKIA', SECRET 'abc')"] } },
      { connection: { views: { v: `(select 1); copy (select 1) to '${out}'` } } },
      { connection: { views: { v: "(select * from read_text('/etc/hostname'))" } } },
      { connection: { views: { v: "read_text('/etc/hostname')" } } },
      { connection: { views: { v: "read_csv('x.csv', columns = (select 1))" } } },
    ];
    for (const extra of cases) {
      const message = await refused(adapter(t.dir, t.dir, extra));
      expect(message).toContain("may not run on connect");
      expect(message).toContain("review sources/ like code");
      expect(message).not.toContain("AKIA");
    }
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(t.dir, "a.duckdb"))).toBe(false);
  });

  test("sl run refuses each bypass and writes no file", async () => {
    const t = temp();
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb", connection: { database: ":memory:" } });
    for (const q of Object.values(duckWrites(t.dir))) {
      const r = await sl(t.root, ["run", "--source", "lake", "--sql", q]);
      expect(r.code).toBe(1);
      expect(r.err).not.toContain("unexpected error");
    }
    const text = await sl(t.root, ["run", "--source", "lake", "--sql", "select content from read_text('/etc/hostname')"]);
    expect(text.code).toBe(1);
    expect(text.err).toContain("read_text");
    for (const f of WRITTEN) expect(existsSync(join(t.dir, f))).toBe(false);
  });

  test("a golden with a dollar-quoted COPY is refused by goldens run, and at the driver without the guard", async () => {
    const t = temp();
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer)"]);
    const sql = duckWrites(t.dir).dollar;
    writeFileSync(
      join(t.root, "goldens", "evil.yaml"),
      `name: evil\nquestion: q\nrequest:\n  source: wh\n  measures: [orders.n]\nsql: ${JSON.stringify(sql)}\nstatus: draft\n`,
    );
    const r = await sl(t.root, ["goldens", "run", "--name", "evil"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("one statement");
    const plan: QueryPlan = { command: "goldens", source: "wh", dialect: "duckdb", queries: [{ id: goldenQueryId("evil"), purpose: "q", sql }] };
    const message = await refused(executePlan(plan, { root: t.root, source, env: {} }));
    expect(message).toContain("one statement");
    expect(existsSync(join(t.dir, "PWNED.txt"))).toBe(false);
  });
});

describe("source safety", () => {
  test.each([
    "INSTALL httpfs",
    "LOAD httpfs",
    "load 'json'",
    "SET threads=2",
    "SET threads TO 4;",
    "SET memory_limit = '2GB'",
    "SET secret_directory='/tmp/s'",
    "SET s3_region = 'eu-west-1'",
    "CREATE SECRET (TYPE s3, PROVIDER credential_chain)",
    "CREATE OR REPLACE TEMPORARY SECRET lake (TYPE s3, PROVIDER credential_chain, CHAIN 'env;config', REGION 'eu-west-1')",
    "CREATE SECRET IF NOT EXISTS az (TYPE azure, PROVIDER credential_chain, ACCOUNT_NAME 'acct')",
  ])("allows setup %s", (stmt) => {
    expect(setupProblem(stmt)).toBeUndefined();
  });

  test.each([
    ["COPY (select 1) TO 'x.csv'", "only INSTALL, LOAD, SET and CREATE SECRET"],
    ["INSTALL httpfs; COPY (select 1) TO 'x.csv'", "more than one statement"],
    ["INSTALL evil FROM 'http://example.com'", "one core extension"],
    ["INSTALL shellfs", "one core extension"],
    ["FORCE INSTALL httpfs", "only INSTALL"],
    ["ATTACH 'x.duckdb'", "only INSTALL"],
    ["SET enable_external_access=true", "SET may change only"],
    ["SET lock_configuration=false", "SET may change only"],
    ["SET allowed_directories=['/']", "SET may change only"],
    ["SET TimeZone='America/New_York'", "SET may change only"],
    ["SET s3_secret_access_key='wJalr'", "SET may change only"],
    ["SET threads = (select 2)", "one literal value"],
    ["CREATE SECRET (TYPE s3, KEY_ID 'AKIA', SECRET 'abc')", "may set only"],
    ["CREATE SECRET (TYPE s3, PROVIDER config, KEY_ID 'AKIA')", "may set only"],
    ["CREATE SECRET (TYPE s3, PROVIDER config)", "PROVIDER credential_chain"],
    ["CREATE PERSISTENT SECRET (TYPE s3, PROVIDER credential_chain)", "PERSISTENT"],
    ["CREATE TABLE t AS SELECT 1", "only INSTALL"],
    ["SELECT 1", "only INSTALL"],
    ["SET threads='2", "unterminated"],
  ])("refuses setup %s", (stmt, reason) => {
    expect(setupProblem(stmt)).toContain(reason);
  });

  test("a view is one table name or one reading table function over literal paths", () => {
    expect(parseViewRelation("read_parquet('../data/x/*.parquet')")).toEqual({ kind: "function", name: "read_parquet", paths: ["../data/x/*.parquet"] });
    expect(parseViewRelation("read_csv(['a.csv', 'b.csv'], header = true, delim = ',', columns = {'a': 'INT', 'b': 'DECIMAL(10,2)'})")).toEqual({
      kind: "function",
      name: "read_csv",
      paths: ["a.csv", "b.csv"],
    });
    expect(parseViewRelation("read_csv('../data/a=b/hits.csv', header=true)")).toMatchObject({ paths: ["../data/a=b/hits.csv"] });
    expect(parseViewRelation("iceberg_scan('s3://bucket/t')")).toMatchObject({ name: "iceberg_scan" });
    expect(parseViewRelation('main."Orders"')).toEqual({ kind: "table", name: ["main", "Orders"] });
    for (const bad of [
      "(select 1)",
      "read_text('/etc/hostname')",
      "read_parquet('x') where 1=1",
      "read_parquet('x'), other",
      "read_csv('x', columns = (select 1))",
      "read_csv(getenv('HOME'))",
      "read_parquet('x'); copy (select 1) to 'y'",
      "t union all select 1",
      "",
    ]) {
      expect(typeof parseViewRelation(bad)).toBe("string");
    }
  });

  test("sourceSafetyIssues names the setup statements and views at fault, never their text", () => {
    const issues = sourceSafetyIssues({
      source: "lake",
      dialect: "duckdb",
      connection: { setup: ["SET threads=2", "SET s3_secret_access_key='wJalrSECRET'"], views: { ok: "read_parquet('x.parquet')", bad: "(select 1)" } },
    });
    expect(issues.map((i) => i.path)).toEqual(["connection.setup[1]", "connection.views.bad"]);
    expect(JSON.stringify(issues)).not.toContain("wJalrSECRET");
    expect(sourceSafetyIssues({ source: "pg", dialect: "postgres", connection: { setup: ["COPY x"] } })).toEqual([]);
    expect(() => assertSourceSafe({ source: "lake", dialect: "duckdb", connection: { views: { v: "t" } } })).not.toThrow();
  });

  test("viewFiles lists a glob's directory, single files and table roots, resolved from the root", () => {
    const files = viewFiles("/r/semantic", {
      connection: {
        views: {
          a: "read_parquet('../lake/events/*.parquet')",
          b: "read_parquet(['../lake/one.parquet', '/abs/two.parquet'])",
          c: "read_parquet('../lake/hive/**/*.parquet', hive_partitioning = true)",
          d: "iceberg_scan('s3://bucket/table')",
          e: "some_table",
        },
      },
    });
    expect(files).toEqual({
      directories: ["/r/lake/events/", "/r/lake/hive/", "s3://bucket/table/"],
      files: ["/abs/two.parquet", "/r/lake/one.parquet"],
    });
  });
});

describe("protected values and terminal output", () => {
  async function project() {
    const t = temp();
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", [
      "create table customers (id integer, email varchar, nickname varchar, city varchar, phone varchar, notes_internal varchar, shown_email varchar)",
      "insert into customers values (1, 'ana@example.com', 'ana', 'Lisbon', '555-0100', 'vip', 'pub@example.com')",
    ]);
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), {
      model: "customers",
      source: "wh",
      table: "customers",
      status: "draft",
      primary_key: ["id"],
      ignored_columns: ["notes_internal"],
      dimensions: [
        { name: "nickname", expr: "nickname", type: "string", tags: ["pii"], status: "draft" },
        { name: "city", expr: "city", type: "string", status: "draft" },
        { name: "shown_email", expr: "shown_email", type: "string", tags: ["public"], status: "draft" },
      ],
      measures: [],
    });
    return t;
  }

  test("sl run shows protected columns as [protected] unless --show-protected", async () => {
    const t = await project();
    const sql = "select id, email, nickname, city, phone, notes_internal, shown_email from customers";
    const r = await sl(t.root, ["run", "--source", "wh", "--sql", sql, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ rows: Record<string, unknown>[]; protected_columns: string[] }>();
    expect(out.protected_columns).toEqual(["email", "nickname", "phone", "notes_internal"]);
    expect(out.rows).toEqual([
      { id: 1, email: PROTECTED_VALUE, nickname: PROTECTED_VALUE, city: "Lisbon", phone: PROTECTED_VALUE, notes_internal: PROTECTED_VALUE, shown_email: "pub@example.com" },
    ]);
    const plain = await sl(t.root, ["run", "--source", "wh", "--sql", sql]);
    expect(plain.out).not.toContain("ana@example.com");
    expect(plain.out).not.toContain("555-0100");
    expect(plain.out).toContain("Protected columns shown as [protected]: email, nickname, phone, notes_internal.");
    const shown = await sl(t.root, ["run", "--source", "wh", "--sql", sql, "--json", "--show-protected"]);
    expect(shown.json<{ rows: Record<string, unknown>[]; protected_columns: string[] }>()).toMatchObject({
      protected_columns: [],
      rows: [{ email: "ana@example.com", phone: "555-0100" }],
    });
  });

  test("goldens run, confirm and check never print protected values by default", async () => {
    const t = await project();
    // The request compiles to the email column, which looks personal, as its cross_check_sql reads it.
    const ok = { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" };
    const model = readYaml<Model>(join(t.root, "models", "wh", "customers.yaml"));
    model.dimensions = [...model.dimensions.map((d) => (d.name === "city" ? { ...d, ...ok } : d)), { name: "email", expr: "email", type: "string", ...ok }];
    writeYaml(join(t.root, "models", "wh", "customers.yaml"), { ...model, ...ok, measures: [{ name: "n", agg: "count", description: "Customers.", ...ok }] });
    writeFileSync(
      join(t.root, "goldens", "by_email.yaml"),
      "name: by_email\nquestion: Orders by email\nrequest:\n  source: wh\n  measures: [customers.n]\n  dimensions: [customers.email, customers.city]\n" +
        "sql: select email, city, count(*) as n from customers group by email, city\nstatus: draft\n",
    );
    const run = await sl(t.root, ["goldens", "run", "--name", "by_email"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(PROTECTED_VALUE);
    expect(run.out).not.toContain("ana@example.com");
    const runJson = await sl(t.root, ["goldens", "run", "--name", "by_email", "--json"]);
    expect(runJson.out).not.toContain("ana@example.com");
    const confirm = await sl(t.root, ["goldens", "confirm", "--name", "by_email", "--by", "Dana", "--tolerance", "0"]);
    expect(confirm.code).toBe(0);
    expect(confirm.out).not.toContain("ana@example.com");
    const db = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await db.connect();
    await c.run("update customers set email = 'bo@example.com'");
    c.closeSync();
    db.closeSync();
    const check = await sl(t.root, ["goldens", "check"]);
    expect(check.code).toBe(1);
    expect(check.out).not.toContain("ana@example.com");
    expect(check.out).not.toContain("bo@example.com");
    expect(check.out).toContain(PROTECTED_VALUE);
    const shown = await sl(t.root, ["goldens", "check", "--show-protected"]);
    expect(shown.out).toContain("bo@example.com");
  });

  test("compareRows shows protected columns' values as [protected]", () => {
    const r = compareRows([{ email: "a@x.com", n: 1 }], [{ email: "b@x.com", n: 1 }], { ordered: true, tolerance: 0, protectedColumns: ["email"] });
    expect(r.diffs).toEqual(["Row 1, column email: expected [protected], got [protected]."]);
    const u = compareRows([{ email: "a@x.com", n: 1 }], [{ email: "a@x.com", n: 2 }], { ordered: false, tolerance: 0, protectedColumns: ["email"] });
    expect(u.diffs.join(" ")).not.toContain("a@x.com");
  });

  test("duplicate output column names are refused with a hint to alias them", async () => {
    const t = await project();
    const r = await sl(t.root, ["run", "--source", "wh", "--sql", "select 1 as a, 2 as a"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('more than one column named "a"; alias them');
    writeFileSync(
      join(t.root, "goldens", "dupes.yaml"),
      "name: dupes\nquestion: q\nrequest:\n  source: wh\n  measures: [customers.n]\nsql: select 1 as n, 2 as N\nstatus: draft\n",
    );
    const g = await sl(t.root, ["goldens", "run", "--name", "dupes"]);
    expect(g.code).toBe(1);
    expect(g.err).toContain("alias them");
  });

  test("printed values have ANSI escapes and control characters stripped", async () => {
    const t = await project();
    const r = await sl(t.root, ["run", "--source", "wh", "--sql", "select chr(27) || '[31mred' || chr(27) || '[0m' || chr(7) || chr(8) || 'x' as \"col\" || chr(27)"]);
    expect(r.code).toBe(1);
    const ok = await sl(t.root, ["run", "--source", "wh", "--sql", "select chr(27) || '[31mred' || chr(27) || '[0m' || chr(7) || chr(8) || chr(10) || 'x' as s"]);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(ok.out).toContain("red x");
    expect(plainText("a\x1b]0;title\x07b\x1b[2Jc\u009bd")).toBe("abcd");
    expect(formatTable([{ "\x1b[1mh": "v\tw" }])).toBe("h    \n---  \nv w".split("\n").map((l) => l.trimEnd()).join("\n"));
  });
});

describe("statement timeout setting", () => {
  test("SL_STATEMENT_TIMEOUT_MS must be whole milliseconds", () => {
    expect(statementTimeout(undefined)).toBe(120000);
    expect(statementTimeout("5000")).toBe(5000);
    expect(() => statementTimeout("abc")).toThrow("whole number of milliseconds");
    expect(() => statementTimeout("1.5")).toThrow("whole number of milliseconds");
  });

  test("a malformed connection URL is a user error that does not echo the URL", async () => {
    const message = await refused(
      openAdapter("/tmp", { source: "pg", dialect: "postgres", connection: { env: "BAD_URL" } }, { BAD_URL: "not a url with secret-pw" }),
    );
    expect(message).toContain("BAD_URL does not hold a valid Postgres connection URL");
    expect(message).not.toContain("secret-pw");
  });
});

describe("live tests run only against a local Postgres", () => {
  test("isLocalPg accepts localhost, loopback and sockets only", () => {
    for (const url of [
      "postgres://postgres@localhost:54329/postgres?host=/tmp/sl-pg",
      "postgres://u@localhost/db",
      "postgres://u@127.0.0.1:5432/db",
      "postgres://u@[::1]:5432/db",
      "postgres:///db?host=/var/run/postgresql",
      "postgres://%2Ftmp%2Fsock/db",
    ]) {
      expect(isLocalPg(url)).toBe(true);
    }
    for (const url of ["postgres://u@db.example.com/prod", "postgres://u@10.0.0.5/db", "postgres://u@localhost/db?host=db.example.com", "not a url"]) {
      expect(isLocalPg(url)).toBe(false);
    }
  });

  test("assertLocalPg refuses a remote URL unless SL_TEST_ALLOW_REMOTE=1", () => {
    expect(() => assertLocalPg("postgres://u@db.example.com/prod", {})).toThrow("SL_TEST_ALLOW_REMOTE=1");
    expect(() => assertLocalPg("postgres://u@db.example.com/prod", { SL_TEST_ALLOW_REMOTE: "1" })).not.toThrow();
    expect(() => assertLocalPg("postgres://u@localhost/db", {})).not.toThrow();
    expect(() => assertLocalPg(undefined, {})).toThrow("PG_URL is not set");
  });

  test("uniqueSchema gives each call its own name", () => {
    const a = uniqueSchema("t_sec");
    expect(a).toMatch(new RegExp(`^t_sec_${process.pid}_[a-z0-9]+$`));
    expect(uniqueSchema("t_sec")).not.toBe(a);
  });
});

describe.skipIf(!PG_URL)("Postgres refuses writes at the driver, without the guard", () => {
  const schema = uniqueSchema("t_security");
  const table = `${schema}.t`;
  let admin: SQL;
  const source: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "PG_URL" } };
  const count = async () => Number((await admin.unsafe(`select count(*)::int as n from ${table}`))[0].n);

  beforeAll(async () => {
    assertLocalPg(PG_URL);
    admin = new SQL({ url: PG_URL!, max: 1 });
    await admin.unsafe(`drop schema if exists ${schema} cascade; create schema ${schema}; create table ${table} (x int); insert into ${table} values (1), (2)`);
  });
  afterAll(async () => {
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.close();
  });

  test("E-string and dollar-quoted multi-statement DELETEs delete nothing", async () => {
    const warnings: string[] = [];
    const a = await openAdapter("/tmp", source, { PG_URL }, { warn: (m) => warnings.push(m) });
    try {
      for (const q of pgMulti(table)) expect(await refused(a.query(q))).toContain("cannot insert multiple commands");
      expect(await refused(a.query(`delete from ${table}`))).toContain("read-only transaction");
      await a.query("commit").catch(() => {});
      expect(await refused(a.query(`delete from ${table}`))).toContain("read-only transaction");
      expect(await count()).toBe(2);
    } finally {
      await a.close();
    }
  });

  test("set_config and SET do not outlive their query", async () => {
    const a = await openAdapter("/tmp", source, { PG_URL }, { warn: () => {} });
    try {
      await a.query("select set_config('default_transaction_read_only', 'off', false)");
      await a.query("set default_transaction_read_only = off").catch(() => {});
      await a.query("set session characteristics as transaction read write").catch(() => {});
      await a.query("set statement_timeout = 0").catch(() => {});
      expect((await a.query("show default_transaction_read_only")).rows).toEqual([{ default_transaction_read_only: "on" }]);
      expect((await a.query("select current_setting('statement_timeout') as st")).rows).toEqual([{ st: "2min" }]);
      expect(await refused(a.query(`delete from ${table}`))).toContain("read-only transaction");
      expect(await count()).toBe(2);
    } finally {
      await a.close();
    }
  });

  test("a reconnect keeps read-only, the statement timeout and UTC", async () => {
    const a = await openAdapter("/tmp", source, { PG_URL, SL_STATEMENT_TIMEOUT_MS: "45000" }, { warn: () => {} });
    try {
      const pid = (await a.query("select pg_backend_pid() as pid")).rows[0]!.pid;
      await admin.unsafe(`select pg_terminate_backend(${Number(pid)})`);
      await a.query("select 1").catch(() => {});
      const settings =
        "select pg_backend_pid() as pid, current_setting('default_transaction_read_only') as ro, " +
        "current_setting('statement_timeout') as st, current_setting('TimeZone') as tz";
      const after = (await a.query(settings)).rows[0]!;
      expect(after.pid).not.toBe(pid);
      expect(after).toMatchObject({ ro: "on", st: "45s", tz: "UTC" });
      expect(await refused(a.query(`delete from ${table}`))).toContain("read-only transaction");
    } finally {
      await a.close();
    }
  });

  test("a superuser or a role that can write gets one warning, and still connects", async () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    for (let i = 0; i < 2; i++) {
      const a = await openAdapter("/tmp", source, { PG_URL }, { warn });
      await a.close();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("connect with a SELECT-only role");
  });

  test("sl run refuses each bypass, set_config and pg_read_file, and deletes nothing", async () => {
    const t = temp();
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), source);
    for (const q of [
      ...pgMulti(table),
      "select set_config('default_transaction_read_only', 'off', false)",
      "select pg_read_file('/etc/hostname')",
      "select pg_terminate_backend(pg_backend_pid())",
    ]) {
      const r = await sl(t.root, ["run", "--source", "pg", "--sql", q], { PG_URL });
      expect(r.code).toBe(1);
      expect(r.err).not.toContain("unexpected error");
    }
    expect(await count()).toBe(2);
    const ok = await sl(t.root, ["run", "--source", "pg", "--sql", "select current_setting('transaction_read_only') as ro"], { PG_URL });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("on");
    expect(ok.err).toContain("connect with a SELECT-only role");
  });

  test("a golden whose sql hides a DELETE deletes nothing at the driver", async () => {
    const t = temp();
    await initProject(t.root);
    const plan: QueryPlan = { command: "goldens", source: "pg", dialect: "postgres", queries: [{ id: goldenQueryId("evil"), purpose: "q", sql: pgMulti(table)[1]! }] };
    expect(await refused(executePlan(plan, { root: t.root, source, env: { PG_URL }, warn: () => {} }))).toContain("cannot insert multiple commands");
    expect(await count()).toBe(2);
  });
});

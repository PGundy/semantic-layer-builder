// HR-8, invariant 3: SQL the compiler did not write (sl run, a golden's cross_check_sql) never shows
// a protected column's values because it renamed or wrapped the column. Each statement runs on
// DuckDB and, with PG_URL set, on Postgres. All data is synthetic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { type ProtectedNames, PROTECTED_VALUE, protectedNames, sqlMask } from "../skills/semantic-layer/scripts/lib/output.ts";
import { loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import type { Golden } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, confirmWithYes, duckdbSource, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

// Every value of a protected column in the test tables: none may reach a command's output or a file.
const SECRETS = ["ana@example.com", "bo@example.com", "cy@example.com", "ana@work.example", "bo@work.example", "cy@work.example", "gold-tier", "basic-tier"];

const TABLES = [
  'create table customers (id integer, email varchar, "WorkEmail" varchar, city varchar, segment varchar)',
  "insert into customers values (1, 'ana@example.com', 'ana@work.example', 'Lisbon', 'gold-tier'), (2, 'bo@example.com', 'bo@work.example', 'Porto', 'basic-tier'), (3, 'cy@example.com', 'cy@work.example', 'Lisbon', 'basic-tier')",
  // orders.segment is a shipping segment: it shares its name with the protected customers.segment.
  "create table orders (id integer, customer_id integer, amount integer, status varchar, segment varchar)",
  "insert into orders values (10, 1, 100, 'paid', 'air'), (11, 1, 50, 'paid', 'sea'), (12, 2, 70, 'open', 'air')",
];

interface Project {
  dialect: "duckdb" | "postgres";
  root: string;
  env: Record<string, string | undefined>;
  // A table's name as a statement writes it.
  t: (name: string) => string;
}

interface RunJson {
  columns: string[];
  rows: Record<string, unknown>[];
  protected_columns: string[];
  protected_reads: string[];
  protected_note?: string;
}

const noSecrets = (text: string): void => {
  for (const s of SECRETS) expect(text).not.toContain(s);
};

// A model over customers: segment is tagged pii, city is approved for the goldens below.
function writeModels(p: Project): void {
  const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-15" };
  writeYaml(join(p.root, "models", "wh", "customers.yaml"), {
    model: "customers",
    source: "wh",
    table: p.t("customers"),
    primary_key: ["id"],
    ...ok,
    dimensions: [
      { name: "city", expr: "city", type: "string", ...ok },
      { name: "segment", expr: "segment", type: "string", tags: ["pii"], ...ok },
    ],
    measures: [{ name: "n", agg: "count", description: "Customers.", ...ok }],
  });
}

async function duckdbProject(): Promise<Project> {
  const t = tempRoot();
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", TABLES);
  const p: Project = { dialect: "duckdb", root: t.root, env: {}, t: (name) => name };
  expect((await sl(p.root, ["introspect", "--source", "wh"])).code).toBe(0);
  writeModels(p);
  return p;
}

async function run(p: Project, sql: string, ...flags: string[]): Promise<RunJson> {
  const r = await sl(p.root, ["run", "--source", "wh", "--sql", sql, "--json", ...flags], p.env);
  // On failure the message shows the statement and what the command said.
  expect({ sql, code: r.code, err: r.code === 0 ? "" : r.err }).toEqual({ sql, code: 0, err: "" });
  return r.json<RunJson>();
}

// The statement's masked columns, after checking that no protected value is in the output.
async function masked(p: Project, sql: string): Promise<string[]> {
  const out = await run(p, sql);
  noSecrets(JSON.stringify(out));
  for (const c of out.protected_columns) for (const r of out.rows) expect(r[c] === null || r[c] === PROTECTED_VALUE).toBe(true);
  return out.protected_columns;
}

// Statements whose failure quotes a row's value in an error that reads like a wrong name.
const failsOnAValue: Record<Project["dialect"], (c: string) => string[]> = {
  duckdb: (c) => [`select count(error(email)) from ${c}`],
  postgres: (c) => [
    `select count(email::regclass) from ${c}`,
    `select current_setting(email) from ${c}`,
    `select id from ${c} where current_setting(email) is null`,
    `select id from ${c} where email::regconfig is null`,
    `select id from ${c} where email::regproc is null`,
    // A value read as a type's name fails as a syntax error, with a position inside the value.
    `select count(email::regtype) from ${c}`,
  ],
};

const PG_SCHEMA = uniqueSchema("sl_mask");
let pg: SQL | undefined;

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  pg = new SQL({ url: PG_URL, max: 1 });
  await pg.unsafe(`create schema ${PG_SCHEMA}`);
  for (const s of TABLES) await pg.unsafe(s.replace(/(create table|insert into) /, `$1 ${PG_SCHEMA}.`));
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${PG_SCHEMA} cascade`);
  await pg.close();
});

async function postgresProject(): Promise<Project> {
  const t = tempRoot();
  await initProject(t.root);
  writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres", connection: { env: "MASK_PG_URL" } });
  const p: Project = { dialect: "postgres", root: t.root, env: { MASK_PG_URL: PG_URL }, t: (name) => `${PG_SCHEMA}.${name}` };
  expect((await sl(p.root, ["introspect", "--source", "wh", "--schemas", PG_SCHEMA], p.env)).code).toBe(0);
  writeModels(p);
  return p;
}

const DIALECTS: ["duckdb" | "postgres", () => Promise<Project>][] = [
  ["duckdb", duckdbProject],
  ["postgres", postgresProject],
];

for (const [dialect, project] of DIALECTS) {
  describe.skipIf(dialect === "postgres" && !PG_URL)(`sl run masks protected values under any name (${dialect})`, () => {
    let p: Project;
    let c: string;
    let o: string;
    beforeAll(async () => {
      p = await project();
      c = p.t("customers");
      o = p.t("orders");
    });

    test("an alias, a function, a concatenation and an aggregate over a protected column are masked", async () => {
      expect(await masked(p, `select email as e from ${c}`)).toEqual(["e"]);
      for (const expr of ["lower(email)", "email || ''", "max(email)"]) {
        const out = await run(p, `select ${expr} from ${c}`);
        noSecrets(JSON.stringify(out));
        expect({ expr, masked: out.protected_columns }).toEqual({ expr, masked: out.columns });
        expect(out.protected_reads).toEqual(["customers.email"]);
      }
      // A column tagged pii in its model is as protected as one the name rules flag.
      expect(await masked(p, `select upper(segment) as s, id from ${c}`)).toEqual(["s"]);
    });

    test("the masked output says why, once", async () => {
      const r = await sl(p.root, ["run", "--source", "wh", "--sql", `select id, email as e, lower(email) as le from ${c} order by id`], p.env);
      expect(r.code).toBe(0);
      noSecrets(r.out);
      expect(r.out).toContain(
        "2 columns masked: the statement reads protected column customers.email. Counts are shown; values are not. " +
          "To see a column that is not protected, select it by its own name and leave the protected one out.",
      );
      expect(r.out.match(/masked:/g)!.length).toBe(1);
      expect(r.out).not.toContain("Protected column");
      const one = await sl(p.root, ["run", "--source", "wh", "--sql", `select email as e from ${c}`], p.env);
      expect(one.out).toContain("1 column masked: the statement reads protected column customers.email.");
    });

    test("a subquery and a CTE that rename a protected column are masked, through * too", async () => {
      expect(await masked(p, `select e from (select email as e from ${c}) s`)).toEqual(["e"]);
      expect(await masked(p, `select id, s.e from (select id, email as e from ${c}) s`)).toEqual(["e"]);
      expect(await masked(p, `with x as (select id, email as e from ${c}) select id, e from x`)).toEqual(["e"]);
      expect(await masked(p, `with x as (select email as e from ${c}), y as (select e as f from x) select f as g from y`)).toEqual(["g"]);
      expect(await masked(p, `select * from (select id, email as e from ${c}) s`)).toEqual(["e"]);
      // The subquery's expression has no alias, so the database names its column: nothing but a count is shown.
      const unnamed = await run(p, `select * from (select id, lower(email) from ${c}) s`);
      noSecrets(JSON.stringify(unnamed));
      expect(unnamed.protected_columns).toEqual(unnamed.columns);
    });

    test("select * and t.* keep masking by the real column names", async () => {
      for (const sql of [`select * from ${c} order by id`, `select t.* from ${c} t order by id`]) {
        const out = await run(p, sql);
        noSecrets(JSON.stringify(out));
        expect(out.protected_columns).toEqual(["email", "WorkEmail", "segment"]);
        expect(out.rows.map((r) => [r.id, r.city])).toEqual([[1, "Lisbon"], [2, "Porto"], [3, "Lisbon"]]);
        expect(out.protected_note).toBeUndefined();
      }
      // An expression beside the star is masked by what it reads; the star's columns by their names.
      const beside = await run(p, `select *, lower(email) as le from ${c} order by id`);
      noSecrets(JSON.stringify(beside));
      expect(beside.protected_columns).toEqual(["email", "WorkEmail", "segment", "le"]);
      expect(beside.rows[0]).toMatchObject({ id: 1, city: "Lisbon" });
    });

    test("quoted and mixed-case identifiers are read as the column they name", async () => {
      expect(await masked(p, `select "email" as e1, EMAIL as e2, "WorkEmail" as w, CITY as town from ${c}`)).toEqual(["e1", "e2", "w"]);
      expect(await masked(p, `select Lower("WorkEmail") as "W", "city" from ${c}`)).toEqual(["W"]);
    });

    test("a case expression over a protected column is masked", async () => {
      const out = await run(p, `select case when email like 'ana%' then email else city end as bucket, city from ${c} order by id`);
      noSecrets(JSON.stringify(out));
      expect(out.protected_columns).toEqual(["bucket"]);
      expect(out.rows.map((r) => r.city)).toEqual(["Lisbon", "Porto", "Lisbon"]);
    });

    test("count(email) and count(distinct email) are shown, whatever their column is called", async () => {
      for (const expr of ["count(email)", "count(distinct email)", "count(email) as email_count", "count(*) filter (where email like '%example.com') as with_email"]) {
        const out = await run(p, `select ${expr} from ${c}`);
        expect({ expr, masked: out.protected_columns }).toEqual({ expr, masked: [] });
        expect(Number(Object.values(out.rows[0]!)[0])).toBe(3);
        expect(out.protected_note).toBeUndefined();
      }
      // A count beside a masked value is still shown.
      const both = await run(p, `select max(email) as m, count(distinct email) as n from ${c}`);
      expect(both.protected_columns).toEqual(["m"]);
      expect(Number(both.rows[0]!.n)).toBe(3);
    });

    test("a statement that names no protected column is unchanged", async () => {
      const sql = `select city, count(*) as n, sum(id) as ids from ${c} group by city order by city`;
      const out = await run(p, sql);
      expect(out).toMatchObject({ columns: ["city", "n", "ids"], protected_columns: [], protected_reads: [] });
      expect(out.rows.map((r) => [r.city, Number(r.n), Number(r.ids)])).toEqual([["Lisbon", 2, 4], ["Porto", 1, 2]]);
      expect("protected_note" in out).toBe(false);
      const plain = await sl(p.root, ["run", "--source", "wh", "--sql", sql], p.env);
      expect(plain.out).not.toContain("masked");
      expect(plain.out).not.toContain(PROTECTED_VALUE);
      // An alias written without `as` that is also a table's name, or a table's alias, is still an alias.
      const implicit = await run(p, `select x.city, sum(y.amount) orders from ${c} x left join ${o} y on y.customer_id = x.id group by 1 order by 1`);
      expect(implicit).toMatchObject({ columns: ["city", "orders"], protected_columns: [], protected_reads: [] });
      expect(implicit.rows.map((r) => [r.city, Number(r.orders)])).toEqual([["Lisbon", 150], ["Porto", 70]]);
      expect("protected_note" in implicit).toBe(false);
      expect((await run(p, `select city c1 from ${c} c1`)).protected_columns).toEqual([]);
      // Tables the snapshot does not hold are read as before: nothing is known to be protected there.
      const catalog = await run(p, `select t.table_name from information_schema.tables t where t.table_name = 'customers'`);
      expect(catalog.protected_columns).toEqual([]);
      expect(catalog.rows.length).toBeGreaterThan(0);
      expect(catalog.rows.every((r) => r.table_name === "customers")).toBe(true);
    });

    test("columns that are not protected stay readable when the statement only filters or joins on a protected one", async () => {
      const filtered = await run(p, `select id, city from ${c} where email like 'ana%'`);
      expect(filtered).toMatchObject({ protected_columns: [], protected_reads: ["customers.email"], rows: [{ id: 1, city: "Lisbon" }] });
      // No value reaches a result through where, on, group by or order by, whatever the statement's shape.
      const union = await run(p, `select city as place from ${c} where email like 'ana%' union all select status from ${o} where id = 12 order by 1`);
      expect(union).toMatchObject({ protected_columns: [], rows: [{ place: "Lisbon" }, { place: "open" }] });
      const joined = await run(
        p,
        `select x.city, sum(y.amount) filter (where x.email not like '%@test.example') as total, count(*) as n from ${o} y join ${c} x on x.id = y.customer_id where x.email is not null group by x.city order by x.city`,
      );
      expect(joined.protected_columns).toEqual([]);
      expect(joined.rows.map((r) => [r.city, Number(r.total), Number(r.n)])).toEqual([["Lisbon", 150, 2], ["Porto", 70, 1]]);
      // A CTE whose aliases read nothing protected keeps its figures.
      const cte = await run(
        p,
        `with paid as (select y.customer_id, sum(y.amount) as total from ${o} y join ${c} x on x.id = y.customer_id where x.email like '%example.com' group by 1) select customer_id, total * 2 as twice from paid order by 1`,
      );
      expect(cte.protected_columns).toEqual([]);
      expect(cte.rows.map((r) => Number(r.twice))).toEqual([300, 140]);
    });

    test("whole rows, column lists and set operations over * are masked, though they name no protected column", async () => {
      for (const sql of [`select x from ${c} x`, `select customers from ${c}`, `select 'a' as a, 'b' as b, 'c' as c, 'd' as d, 'e' as e union all select cast(id as varchar), email, "WorkEmail", city, segment from ${c}`]) {
        const out = await run(p, sql);
        noSecrets(JSON.stringify(out));
        expect({ sql, masked: out.protected_columns }).toEqual({ sql, masked: out.columns });
        expect(out.protected_note).toContain("masked: the statement reads");
      }
      const renamed = await run(p, `select * from ${c} as x(a, b, c, d, e)`);
      noSecrets(JSON.stringify(renamed));
      expect(renamed.protected_columns).toEqual(["a", "b", "c", "d", "e"]);
      expect(renamed.protected_note).toContain("5 columns masked: the statement renames the columns of customers.");
      const union = await run(p, `select 1 as a, 'b' as b, 'c' as c, 'd' as d, 'e' as e union all select * from ${c}`);
      noSecrets(JSON.stringify(union));
      expect(union.protected_columns).toEqual(["a", "b", "c", "d", "e"]);
      // A count is still a count.
      expect((await run(p, `select count(*) as n from ${c} x where x is not null`)).protected_columns).toEqual([]);
      // A whole row through a subquery, a WITH entry or a qualified alias.
      for (const sql of [`select t from (select * from ${c}) t`, `with t as (select * from ${c}) select t from t`, `select s.x from (select x as x from ${c} x) s`]) {
        const out = await run(p, sql);
        noSecrets(JSON.stringify(out));
        expect({ sql, extra: out.protected_note !== undefined }).toEqual({ sql, extra: true });
      }
      // The column that is not the row stays readable.
      expect(await masked(p, `select x.city, x as r from ${c} x`)).toEqual(["r"]);
    });

    test("an alias of columns that are not protected stays readable; a WITH entry named as its column reads as a row", async () => {
      expect(await masked(p, `select s.twice, s.e from (select id * 2 as twice, lower(email) as e from ${c}) s`)).toEqual(["e"]);
      const bare = await run(p, `with total as (select sum(amount) as total from ${o}) select total from total`);
      expect(bare.protected_columns).toEqual(["total"]);
      expect(bare.protected_note).toContain("To see a column, select it by its own name from its table, as <table>.<column>.");
      expect((await run(p, `with total as (select sum(amount) as total from ${o}) select total.total from total`)).protected_columns).toEqual([]);
    });

    test("failing closed masks a column that shares a protected column's name in another table", async () => {
      // orders.segment is not protected, but customers.segment is, and the scan knows names, not tables.
      expect(await masked(p, `select id, segment from ${o}`)).toEqual(["segment"]);
      expect(await masked(p, `select id, upper(y.segment) as s from ${o} y`)).toEqual(["s"]);
    });

    test("a failed statement that reads a protected column does not print the database's message", async () => {
      const cast = await sl(p.root, ["run", "--source", "wh", "--sql", `select cast(email as integer) as n from ${c}`], p.env);
      expect(cast.code).toBe(1);
      noSecrets(cast.err + cast.out);
      expect(cast.err).toContain("Query failed. The database's message can quote a value, and the statement reads protected column customers.email, so it is not shown.");
      expect(cast.err).toContain("then run sl run again");
      // A name the statement gets wrong quotes no value: the message stays.
      const typo = await sl(p.root, ["run", "--source", "wh", "--sql", `select emial, email from ${c}`], p.env);
      expect(typo.code).toBe(1);
      expect(typo.err).toContain("Query failed:");
      expect(typo.err).toContain("emial");
      // A statement that reads nothing protected keeps the database's message.
      const plain = await sl(p.root, ["run", "--source", "wh", "--sql", `select cast(city as integer) from ${c}`], p.env);
      expect(plain.err).toContain("Query failed:");
      expect(plain.err).toContain("Lisbon");
      // A count shows no value, but its failure would: the message is guarded there and in a filter too.
      for (const sql of [`select count(cast(email as integer)) from ${c}`, `select id from ${c} where cast(email as integer) = 1`, ...failsOnAValue[p.dialect](c)]) {
        const r = await sl(p.root, ["run", "--source", "wh", "--sql", sql], p.env);
        expect({ sql, code: r.code }).toEqual({ sql, code: 1 });
        noSecrets(r.err + r.out);
        expect(r.err).not.toContain("ana@");
        expect(r.err).toContain("Query failed. The database's message can quote a value, and the statement reads protected column customers.email, so it is not shown.");
      }
      // A whole row inside a count: its failure would quote the row.
      const row = p.dialect === "postgres" ? `select count((x.*)::text::integer) + count(x::text::integer) from ${c} x` : `select count(cast(x::varchar as integer)) from ${c} x`;
      const counted = await sl(p.root, ["run", "--source", "wh", "--sql", row], p.env);
      expect(counted.code).toBe(1);
      noSecrets(counted.err + counted.out);
      expect(counted.err).toContain("Query failed. The database's message can quote a value, and the statement reads rows or columns the tool cannot place (");
    });

    test("--show-protected is unchanged: the owner sees the values", async () => {
      const out = await run(p, `select email as e, lower(email) as le from ${c} order by id`, "--show-protected");
      expect(out).toMatchObject({ protected_columns: [], rows: [{ e: "ana@example.com", le: "ana@example.com" }, { e: "bo@example.com" }, { e: "cy@example.com" }] });
      expect("protected_note" in out).toBe(false);
    });

    test("a golden's cross_check_sql never shows or stores a renamed protected column", async () => {
      const goldens = join(p.root, "goldens");
      mkdirSync(goldens, { recursive: true });
      const snapshot = readFileSync(join(p.root, "snapshots", "wh.json"), "utf8");

      // The request does not compile (the layer has no such measure), so the rows are cross_check_sql's.
      writeYaml(join(goldens, "by_mail.yaml"), {
        name: "by_mail",
        question: "Customers by address",
        request: { source: "wh", measures: ["customers.missing"] },
        cross_check_sql: `select email as contact, max(email) as latest, count(*) as n from ${c} group by 1 order by 1`,
        status: "draft",
      });
      const text = await sl(p.root, ["goldens", "run", "--name", "by_mail"], p.env);
      expect(text.code).toBe(0);
      noSecrets(text.out + text.err);
      expect(text.out).toContain("2 columns masked: the statement reads protected column customers.email. Counts are shown; values are not.");
      const json = await sl(p.root, ["goldens", "run", "--name", "by_mail", "--json"], p.env);
      noSecrets(json.out);
      const doc = json.json<{ rows: Record<string, unknown>[]; protected_columns: string[]; protected_note: string }>();
      expect(doc.protected_columns).toEqual(["contact", "latest"]);
      expect(doc.rows.map((r) => [r.contact, r.latest, Number(r.n)])).toEqual([1, 2, 3].map(() => [PROTECTED_VALUE, PROTECTED_VALUE, 1]));
      expect(doc.protected_note).toContain("2 columns masked");
      // The readback the owner hears, and the file it is stored in, hold no value either.
      const rb = await sl(p.root, ["readback", "--targets", "golden:by_mail", "--json"], p.env);
      expect(rb.code).toBe(0);
      noSecrets(rb.out + rb.err);
      for (const f of readdirSync(join(p.root, ".sl", "pending"))) noSecrets(readFileSync(join(p.root, ".sl", "pending", f), "utf8"));
      expect((await sl(p.root, ["goldens", "run", "--name", "by_mail", "--show-protected"], p.env)).out).toContain("ana@example.com");

      // Its plan stores SQL only, and sl results add refuses rows that hold the renamed column.
      const emitted = await sl(p.root, ["goldens", "run", "--name", "by_mail", "--emit-sql"], p.env);
      expect(emitted.code).toBe(0);
      const plan = emitted.json<{ plan_id: string; queries: { id: string }[] }>();
      expect(plan.queries.map((q) => q.id)).toEqual(["golden:by_mail:cross_check"]);
      const rows = join(p.root, "..", "rows.json");
      writeJson(rows, [{ contact: "ana@example.com", latest: "ana@example.com", n: 1 }, { contact: "bo@example.com", latest: "bo@example.com", n: 1 }]);
      const add = await sl(p.root, ["results", "add", "--plan", plan.plan_id, "--query", "golden:by_mail:cross_check", "--file", rows], p.env);
      expect(add.code).toBe(1);
      expect(add.err).toContain("has protected columns contact, latest, and .sl/plans keeps no protected values, so it is not stored");
      noSecrets(add.err);
      expect(existsSync(join(p.root, ".sl", "plans", plan.plan_id))).toBe(false);
      noSecrets(readFileSync(join(p.root, ".sl", "plans", `${plan.plan_id}.json`), "utf8"));
      // Finished from a scratch file, the rows are in no order the statement gives: all are masked but none shown.
      const fromFile = join(p.root, "..", "results.json");
      writeJson(fromFile, { "golden:by_mail:cross_check": [{ n: 1, latest: "ana@example.com", contact: "ana@example.com" }] });
      const finished = await sl(p.root, ["goldens", "run", "--name", "by_mail", "--results", fromFile, "--json"], p.env);
      expect(finished.code).toBe(0);
      noSecrets(finished.out);
      expect(finished.json<{ protected_columns: string[] }>().protected_columns.sort()).toEqual(["contact", "latest"]);

      // A cross_check_sql that only filters on the protected column stores its rows, matched by name.
      writeYaml(join(goldens, "by_city.yaml"), {
        name: "by_city",
        question: "Customers by city",
        request: { source: "wh", measures: ["customers.n"], dimensions: ["customers.city"] },
        cross_check_sql: `select city, count(*) as n from ${c} where email like '%example.com' group by 1`,
        status: "draft",
      });
      const cityPlan = (await sl(p.root, ["goldens", "run", "--name", "by_city", "--emit-sql"], p.env)).json<{ plan_id: string }>();
      writeJson(rows, [{ n: 2, city: "Lisbon" }, { n: 1, city: "Porto" }]);
      const stored = await sl(p.root, ["results", "add", "--plan", cityPlan.plan_id, "--query", "golden:by_city:cross_check", "--file", rows], p.env);
      expect({ code: stored.code, err: stored.code === 0 ? "" : stored.err }).toEqual({ code: 0, err: "" });
      writeJson(rows, [{ n: 1, city: "ana@example.com" }]);
      writeFileSync(join(goldens, "by_city.yaml"), readFileSync(join(goldens, "by_city.yaml"), "utf8").replace("select city, count", "select email as city, count"));
      const leaky = (await sl(p.root, ["goldens", "run", "--name", "by_city", "--emit-sql"], p.env)).json<{ plan_id: string }>();
      const refused = await sl(p.root, ["results", "add", "--plan", leaky.plan_id, "--query", "golden:by_city:cross_check", "--file", rows], p.env);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("has protected column city");

      // The compiled rows and cross_check_sql disagree: the difference shows no value of the renamed column.
      const diff = await sl(p.root, ["goldens", "run", "--name", "by_city"], p.env);
      expect(diff.code).toBe(0);
      noSecrets(diff.out + diff.err);
      expect(diff.out).toContain("cross_check_sql gives other rows");
      expect(diff.out).toContain(PROTECTED_VALUE);
      const refusedReadback = await sl(p.root, ["readback", "--targets", "golden:by_city"], p.env);
      expect(refusedReadback.code).toBe(1);
      noSecrets(refusedReadback.out + refusedReadback.err);

      // A confirmed golden whose cross_check_sql is then changed to read the column: goldens check masks it.
      writeYaml(join(goldens, "cities.yaml"), {
        name: "cities",
        question: "Customers by city",
        request: { source: "wh", measures: ["customers.n"], dimensions: ["customers.city"] },
        cross_check_sql: `select city, count(*) as n from ${c} group by 1`,
        status: "draft",
      });
      const confirm = await confirmWithYes(p.root, ["--name", "cities", "--tolerance", "0"], {}, p.env);
      expect({ code: confirm.code, err: confirm.code === 0 ? "" : confirm.err }).toEqual({ code: 0, err: "" });
      const path = join(goldens, "cities.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("select city, count", "select email as city, count"));
      const check = await sl(p.root, ["goldens", "check", "--name", "cities"], p.env);
      expect(check.code).toBe(1);
      noSecrets(check.out + check.err);
      expect(check.out).toContain("cross_check_sql:");
      expect(check.out).toContain(PROTECTED_VALUE);
      expect((await sl(p.root, ["goldens", "check", "--name", "cities", "--show-protected"], p.env)).out).toContain("ana@example.com");
      // A cross_check_sql that fails on a protected value does not print the database's message.
      writeFileSync(path, readFileSync(path, "utf8").replace("select email as city, count", "select cast(email as integer) as city, count"));
      for (const args of [["goldens", "check", "--name", "cities"], ["goldens", "run", "--name", "cities"]]) {
        const failed = await sl(p.root, args, p.env);
        expect(failed.code).toBe(1);
        noSecrets(failed.out + failed.err);
        expect(failed.out + failed.err).toContain(`cross_check_sql of golden "cities" failed. The database's message can quote a value`);
      }

      // None of these commands wrote a value to the snapshot or to .sl/plans.
      expect(readFileSync(join(p.root, "snapshots", "wh.json"), "utf8")).toBe(snapshot);
      noSecrets(snapshot);
      const plans = join(p.root, ".sl", "plans");
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      for (const f of walk(plans)) noSecrets(readFileSync(f, "utf8"));
    });
  });
}

describe("sl run masks what only DuckDB writes", () => {
  test("a column by position, columns(), * replace, SUMMARIZE and a later use of an alias", async () => {
    const p = await duckdbProject();
    for (const sql of [
      "select #2 as e from customers",
      "select lower(#2) as e from customers",
      "select columns('em.*') as e from customers",
      "select * replace (email as city) from customers",
      "select email as e, e || '' as town from customers",
      "select x: email, x || '' as town from customers",
      "select c.to_json() as j from customers c",
      "select main.customers.to_json() as j from customers",
      "select c['email'] as e from customers c",
      "from t: customers select t.to_json() as j",
      "summarize customers",
      "from customers select email as e",
      // A field of a value built from a protected column, by name, by star or through another subquery.
      "select x.e from (select {'e': email} as x from customers)",
      "select x.* from (select {'e': email} as x from customers)",
      "select t.x.e from (select {'e': email} as x from customers) t",
      "select s.e as town from (select struct_pack(e := email) as s from customers)",
      "select x.e || '' as y from (select {'e': email} as x from customers)",
      "select s.e.f from (select {'e': {'f': email}} as s from customers)",
      "select e from (select s.* from (select {'e': email} as s from customers))",
      "select city from (select s.* from (select {'city': email} as s from customers))",
      "select s.city from (select x.city from (select {'city': email} as x from customers) t) s",
      // A whole row under a schema-qualified name, or from a subquery that starts with FROM.
      "select main.customers from customers",
      "select t.x from (select main.customers as x from customers) t",
      "select * from (with a as (select 1) from customers c select c) t",
      // A function in FROM that reads the table under names of its own.
      "select stats from pragma_storage_info('customers')",
    ]) {
      const out = await run(p, sql);
      noSecrets(JSON.stringify(out));
      expect({ sql, extra: out.protected_note !== undefined }).toEqual({ sql, extra: true });
    }
    // FROM first reads every column under its own name, as select * does.
    expect(await masked(p, "from customers")).toEqual(["email", "WorkEmail", "segment"]);
    expect(await masked(p, "select * exclude (id) from customers")).toEqual(["email", "WorkEmail", "segment"]);
    expect(await masked(p, "select * like 'em%' from customers")).toEqual(["email"]);
    // A method call on a column that is not protected is that column's value.
    expect(await masked(p, "select c.city.upper() as u, c.email.upper() as e from customers c")).toEqual(["e"]);
  });
});

describe.skipIf(!PG_URL)("sl run masks what only Postgres writes", () => {
  test("a row function called as a column, a U& name and the planner's statistics", async () => {
    const p = await postgresProject();
    const c = p.t("customers");
    for (const sql of [
      `select x.to_jsonb from ${c} x`,
      `select to_jsonb(x) as j, x.city from ${c} x`,
      `select email(x) as e from ${c} x`,
      `select U&"\\0065mail" as e from ${c}`,
      `select 0 as a, 'b' as b, 'c' as c, 'd' as d, 'e' as e union all table ${c}`,
      // An alias the scan would miss if it read FROM by its grammar, and a row function it has no list of.
      `select x from only ${c} x`,
      `select x from ${c} * x`,
      `select row_to_json(x) from only ${c} x`,
      `select qualify from ${c} qualify`,
      `select positional from ${c} positional`,
      `select between from ${c} as between`,
      `select anti from ${c} anti`,
      `select semi from ${c} as semi`,
      `select asof.city, asof from ${c} asof`,
      `select t.jsonb_agg_strict from (select * from ${c}) t`,
      `with t as (select * from ${c}) select t.json_agg_strict from t`,
      `select '' operator(pg_catalog.||) x from ${c} x`,
    ]) {
      const out = await run(p, sql);
      noSecrets(JSON.stringify(out));
      expect({ sql, extra: out.protected_note !== undefined }).toEqual({ sql, extra: true });
    }
    expect(await masked(p, `select x.to_jsonb as j, x.city from ${c} x`)).toEqual(["j"]);
    const stats = await run(p, "select tablename, attname, most_common_vals from pg_stats where schemaname = 'pg_catalog' limit 1");
    expect(stats.protected_columns).toEqual(stats.columns);
    expect(await masked(p, `table ${c}`)).toEqual(["email", "WorkEmail", "segment"]);
  });
});

describe("sqlMask reads a statement's tokens and fails closed", () => {
  const prot: ProtectedNames = {
    names: new Set(["email", "notes"]),
    publicNames: new Set(),
    tables: new Map([["email", ["customers"]], ["notes", ["orders"]]]),
    columns: new Map([["customers", new Set(["id", "email", "city"])], ["orders", new Set(["id", "customer_id", "amount", "status", "notes", "created_at"])]]),
  };
  const mask = (sql: string, columns: string[], ordered = true) => sqlMask(sql, columns, prot, { ordered });

  test.each([
    // [statement, result columns, masked columns]
    ["select email as e from customers", ["e"], ["e"]],
    ["select city as town, id from customers", ["town", "id"], []],
    ["select c.city, o.amount * 2 as twice from orders o join customers c on c.id = o.customer_id order by c.email", ["city", "twice"], []],
    ["select (select email from customers limit 1) as x, 1 as one", ["x", "one"], ["x"]],
    ["select string_agg(c.email, ',') as all_of_them, count(*) as n from customers c", ["all_of_them", "n"], ["all_of_them"]],
    ["select first_value(city) over (order by email) as f from customers", ["f"], ["f"]],
    ["select count(*) over (partition by email) as per, city from customers", ["per", "city"], []],
    ["select round(count(email) * 100.0 / count(*), 1) as pct from customers", ["pct"], []],
    ["select e.* from (select email from customers) e", ["email"], ["email"]],
    ["select s.x from (select c as x from customers c) s", ["x"], ["x"]],
    ["select row_to_json(c.*) as j from customers c", ["j"], ["j"]],
    ["select v.column1 from customers c cross join lateral (values (c.email)) v", ["column1"], ["column1"]],
    ["select unnest from customers c, unnest(array[c.email])", ["unnest"], ["unnest"]],
    ["select city from (select case when true then email else city end from customers) s", ["city"], ["city"]],
    ["with c(a, b) as (select id, email from customers) select a, b from c", ["a", "b"], ["a", "b"]],
    ["select $1 as e from customers", ["e"], ["e"]],
    ["(select email as e from customers)", ["e"], ["e"]],
    ["select 'x' as kind, city as place from customers union all select 'y', email from customers", ["kind", "place"], ["kind", "place"]],
    ["select 'orders' as t, count(*) as n from orders union all select 'customers', count(*) from customers", ["t", "n"], []],
    ["select date_trunc('month', created_at)::date as m, sum(amount) as total from orders where notes is null group by 1", ["m", "total"], []],
    ["select o.ctid, o.status from orders o where o.notes is null", ["ctid", "status"], ["ctid"]],
    ["explain select email as e from customers", ["QUERY PLAN"], []],
    ["select 'unterminated from customers", ["a", "b"], ["a", "b"]],
  ])("%s", (sql, columns, expected) => {
    expect(mask(sql, columns).columns).toEqual(expected);
  });

  test("rows from a file match a select item by its name only", () => {
    const sql = "select city, sum(amount) as total, count(*) as n, max(o.amount), min(c.email) as first from orders o join customers c on c.id = o.customer_id group by 1";
    // In the statement's order every item is placed; a file's columns in another order are placed by alias.
    expect(mask(sql, ["city", "total", "n", "max", "first"]).columns).toEqual(["first"]);
    expect(mask(sql, ["first", "max", "n", "total", "city"], false).columns).toEqual(["first", "max"]);
    // A star, or a column count that differs, places nothing: every column is masked.
    expect(mask("select *, lower(email) as le from customers", ["le", "id", "city", "email"], false).columns).toEqual(["le", "id", "city", "email"]);
    expect(mask(sql, ["city", "total"], false).columns).toEqual(["city", "total"]);
    // A statement that only filters on a protected column puts no value in a column, in any order.
    expect(mask("select city, max(o.amount) from orders o join customers c on c.id = o.customer_id where c.email like 'a%' group by 1", ["max", "city"], false).columns).toEqual([]);
    // One item and one column need no order: an unaliased count is still a count.
    expect(mask("select count(*) from customers where email like 'a%'", ["count"], false).columns).toEqual([]);
    expect(mask("select max(email) from customers", ["max"], false).columns).toEqual(["max"]);
    // A statement that reads nothing protected is masked by name, as before.
    expect(mask("select city, status from x", ["status", "city", "email"], false).columns).toEqual(["email"]);
  });

  test("the reason names each protected column once, with the table the statement reads it from", () => {
    const m = mask("select lower(c.email) as e, o.notes as n, c.email as again from orders o join customers c on c.id = o.customer_id", ["e", "n", "again"]);
    const reason = "the statement reads protected columns customers.email, orders.notes";
    expect(m).toEqual({ columns: ["e", "n", "again"], reads: ["customers.email", "orders.notes"], reason, guard: reason, extra: true });
    // A name protected in another table is still read as protected, without that table's name.
    expect(mask("select upper(x.notes) as n from customers x", ["n"]).reason).toBe("the statement reads protected column notes");
    // A count, a filter and a sort show no value, so nothing is masked; a failure's message is still guarded.
    expect(mask("select count(email) as n from customers", ["n"])).toEqual({ columns: [], reads: [], guard: "the statement reads protected column customers.email", extra: false });
    expect(mask("select city from customers where email is null order by email", ["city"])).toEqual({ columns: [], reads: ["customers.email"], guard: "the statement reads protected column customers.email", extra: false });
    expect(mask("select city, count(*) as n from customers group by 1", ["city", "n"])).toEqual({ columns: [], reads: [], extra: false });
  });
});

describe("Acme's goldens under the scan", () => {
  const files = readdirSync(join(ACME, "goldens")).filter((f) => f.endsWith(".yaml")).sort();

  test("every cross_check_sql keeps its figures readable: only a column protected by its own name is masked", () => {
    const masked: Record<string, string[]> = {};
    for (const f of files) {
      const g = readYaml<Golden>(join(ACME, "goldens", f));
      const columns = Object.keys(g.expected?.rows?.[0] ?? {});
      const prot = protectedNames(ACME, loadSource(ACME, g.request.source));
      for (const ordered of [true, false]) {
        const m = sqlMask(g.cross_check_sql!, columns, prot, { ordered });
        if (m.columns.length) masked[`${g.name} ${ordered}`] = m.columns;
        expect({ f, extra: m.extra }).toEqual({ f, extra: false });
      }
    }
    // The warehouse goldens filter on dim_customers.email; the one masked column is a person's name.
    expect(masked).toEqual({ "analyst_rep_101_by_name_2025 true": ["full_name"], "analyst_rep_101_by_name_2025 false": ["full_name"] });
  });

  test("the lake's goldens still check with their cross_check_sql", async () => {
    const r = await sl(ACME, ["goldens", "check", "--source", "lake", "--json"]);
    expect(r.code).toBe(0);
    const doc = r.json<{ passed: number; failed: number; results: { cross_check?: string }[] }>();
    expect(doc.failed).toBe(0);
    expect(doc.results.every((x) => x.cross_check === "pass")).toBe(true);
  });
});

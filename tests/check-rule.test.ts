import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { checkRule, closestNames, ruleCounts } from "../skills/semantic-layer/scripts/lib/compiler/check-rule.ts";
import { listModels, loadModel, loadSnapshot, loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DATA = join(import.meta.dir, "..", "fixtures", "acme", "data");

interface Yes {
  expressible: true;
  source: string;
  model: string;
  kind: string;
  rule: string;
  joins_used: string[];
  joins: { alias: string; via: string; model: string; type: string; for: string }[];
  sql: string;
  rows_matched: number;
  rows_total: number;
  next: string;
}
interface No {
  expressible: false;
  code: string;
  reason: string;
  suggestion: string;
}

// A copy of Acme in a temp root: the lake's views read the fixture's Parquet files by absolute
// path, and the warehouse reads `schema` on `dialect` (the duckdb file `database`, or PG_URL).
function acmeCopy(warehouse: { dialect: "duckdb" | "postgres"; schema: string; database?: string }): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  cpSync(ACME, t.root, { recursive: true });
  const lake = readFileSync(join(t.root, "sources", "lake.yaml"), "utf8").replaceAll("../../../fixtures/acme/data", DATA);
  writeFileSync(join(t.root, "sources", "lake.yaml"), lake);
  const conn = warehouse.dialect === "duckdb" ? `connection:\n  database: ${JSON.stringify(warehouse.database)}\n` : "connection:\n  env: PG_URL\n";
  writeFileSync(join(t.root, "sources", "warehouse.yaml"), `source: warehouse\ndialect: ${warehouse.dialect}\n${conn}`);
  if (warehouse.schema !== "acme") {
    const dir = join(t.root, "models", "warehouse");
    for (const f of readdirSync(dir)) {
      const m = readYaml<Model>(join(dir, f));
      m.table = m.table.replace(/^acme\./, `${warehouse.schema}.`);
      writeYaml(join(dir, f), m);
    }
    const snap = join(t.root, "snapshots", "warehouse.json");
    writeFileSync(snap, readFileSync(snap, "utf8").replaceAll('"schema": "acme"', `"schema": "${warehouse.schema}"`));
  }
  return t.root;
}

// The Acme warehouse tables in schema acme of a fresh duckdb file.
async function warehouseDuckdb(): Promise<string> {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  const file = join(t.dir, "warehouse.duckdb");
  const instance = await DuckDBInstance.create(file);
  const cx = await instance.connect();
  await cx.run("create schema acme");
  for (const tb of WAREHOUSE_TABLES) await cx.run(`create table acme.${tb.name} as select * from ${readCsvSql(join(DATA, "warehouse", `${tb.name}.csv`), tb)}`);
  cx.closeSync();
  instance.closeSync();
  return file;
}

async function duckCount(file: string, sql: string): Promise<number> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    const rows = (await cx.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
    return Number(rows[0]!.n);
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// Adds a one_to_many join orders (customers -> orders) to the copy's customers model.
function withCustomerOrders(root: string): void {
  const path = join(root, "models", "warehouse", "customers.yaml");
  const m = readYaml<Model>(path);
  m.joins = [...(m.joins ?? []), { name: "orders", to: "orders", relationship: "one_to_many", type: "left", keys: [{ from: "customer_id", to: "customer_id" }] } as never];
  writeYaml(path, m);
}

// Every file under root with its size and modification time, .sl/plans left out.
function files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const rel = relative(root, p);
      if (rel.startsWith(join(".sl", "plans"))) continue;
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out[rel] = `${s.size}:${s.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

const rule = (root: string, source: string, model: string, flag: "--filter" | "--dimension-expr", text: string, extra: string[] = [], env = {}) =>
  sl(root, ["check-rule", "--source", source, "--model", model, flag, text, ...extra], env);

// Expected counts on the fixture, from hand-written SQL over its tables.
const ONE_HOP = "customer.acquisition_channel = 'paid_search'";
const ONE_HOP_SQL = {
  matched: "select count(*) as n from acme.fct_orders o left join acme.dim_customers c on o.customer_id = c.customer_id where c.acquisition_channel = 'paid_search'",
  total: "select count(*) as n from acme.fct_orders",
};
const TWO_HOP = "coalesce(order.test_account.is_test_account, false)";
const TWO_HOP_SQL = {
  matched:
    "select count(*) as n from acme.fct_refunds r left join acme.fct_orders o on r.order_id = o.order_id " +
    "left join acme.dim_customers c on o.customer_id = c.customer_id where coalesce(c.is_test_account, false)",
  total: "select count(*) as n from acme.fct_refunds",
};

describe("check-rule on Acme's lake (duckdb)", () => {
  test("an expressible filter over the model's own columns counts exactly, with the next step named", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const r = await rule(root, "lake", "sessions", "--filter", "device = 'mobile'", ["--json"]);
    expect(r.code).toBe(0);
    const y = r.json<Yes>();
    expect(y).toMatchObject({ expressible: true, source: "lake", model: "sessions", kind: "filter", joins_used: [], joins: [], rows_matched: 4380, rows_total: 8000 });
    expect(y.sql).toBe('select\n  count(*) filter (where device = \'mobile\') as "rows_matched",\n  count(*) as "rows_total"\nfrom "main"."sessions"');
    expect(y.next).toContain("sl set lake.sessions.<measure> filter 'device = '\\''mobile'\\'''");
    const plain = await rule(root, "lake", "sessions", "--filter", "device = 'mobile'");
    expect(plain.out).toBe(
      "The layer can express this filter on lake.sessions.\nIt matches 4380 of 8000 rows of sessions (54.8%).\n" +
        "Put it on a field with sl set lake.sessions.<measure> filter 'device = '\\''mobile'\\''', read it back to the owner, and approve it only after they say yes.",
    );
    const dim = (await rule(root, "lake", "sessions", "--dimension-expr", "utm_channel -- the raw channel", ["--json"])).json<Yes>();
    expect(dim.sql).toBe('select\n  count((utm_channel -- the raw channel\n)) as "rows_matched",\n  count(*) as "rows_total"\nfrom "main"."sessions"');
    expect(dim.rows_total).toBe(8000);
    expect(dim.rows_matched).toBeLessThan(8000);
    expect(dim.next).toContain("sl set lake.sessions.<dimension> expr");
  }, 30_000);

  test("an aggregate, a window function, a subquery and an unknown column are refused with what to do", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const no = async (text: string, flag: "--filter" | "--dimension-expr" = "--filter") => {
      const r = await rule(root, "lake", "sessions", flag, text, ["--json"]);
      expect(r.code).toBe(1);
      return r.json<No>();
    };
    expect(await no("count(*) > 1")).toMatchObject({
      code: "aggregate",
      reason: "the filter needs an aggregate (count()) over sessions; a rule is read row by row on sessions",
      suggestion: "Ask the owner for a view with one row per session and count_sessions, model it with a join from sessions, and run sl check-rule again with the rule over that join.",
    });
    expect((await no("started_at = min(started_at) over (partition by device)")).suggestion).toContain("one row per device and min_started_at");
    expect((await no("row_number() over (order by started_at)", "--dimension-expr")).code).toBe("aggregate");
    const sub = await no("session_id in (select session_id from web_events)");
    expect(sub.code).toBe("subquery");
    expect(sub.suggestion).toContain("ask the owner for a view with one row per session");
    const unknown = await no("devise = 'mobile'");
    expect(unknown).toMatchObject({
      code: "unknown_column",
      reason: '"devise" is not a column of main.sessions, the table of model sessions; the closest names are device',
      suggestion: "Write one of the closest names (device), or, if the column is new, run sl introspect --source lake and check the rule again.",
    });
    const plain = await rule(root, "lake", "sessions", "--filter", "devise = 'mobile'");
    expect(plain.out.split("\n")[0]).toBe('The layer cannot express this filter on lake.sessions: "devise" is not a column of main.sessions, the table of model sessions; the closest names are device.');
  });

  test("emit-sql then results, and emit-sql then results add and --plan, give the live answer; nothing but the plan store is written", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const before = files(root);
    const live = (await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--json"])).json<Yes>();
    const emitted = await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--emit-sql"]);
    expect(emitted.code).toBe(0);
    const plan = emitted.json<{ plan_id: string; queries: { id: string; sql: string; max_rows: number }[] }>();
    const id = plan.queries[0]!.id;
    expect(id).toMatch(/^rule:sessions:[0-9a-f]{8}$/);
    expect(plan.queries).toEqual([{ id, purpose: "Rows of sessions the filter matches", sql: live.sql, max_rows: 2 } as never]);
    expect(emitted.err).toContain(`--plan ${plan.plan_id}`);
    const again = (await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--emit-sql"])).json<{ plan_id: string }>();
    expect(again.plan_id).toBe(plan.plan_id);
    const row = { rows_matched: live.rows_matched, rows_total: live.rows_total };
    const resultsFile = join(root, "..", "results.json");
    writeJson(resultsFile, { [id]: [row] });
    const fromFile = await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--results", resultsFile, "--json"]);
    expect(fromFile.json()).toEqual(live);
    const rows = join(root, "..", "rows.json");
    writeJson(rows, [row]);
    expect((await sl(root, ["results", "add", "--plan", plan.plan_id, "--query", id, "--file", rows])).code).toBe(0);
    const fromPlan = await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--plan", plan.plan_id, "--json"]);
    expect(fromPlan.json()).toEqual(live);
    expect(files(root)).toEqual(before);
    // A results row that is not two counts, or counts more matches than rows, is refused.
    writeJson(resultsFile, { [id]: [{ rows_matched: 9, rows_total: 3 }] });
    const bad = await rule(root, "lake", "sessions", "--filter", "utm_channel is null", ["--results", resultsFile]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("rows_matched (9) is above rows_total (3)");
    // A results file stored for one rule does not answer another rule on the same model.
    writeJson(resultsFile, { [id]: [row] });
    const other = await rule(root, "lake", "sessions", "--filter", "utm_channel is not null", ["--results", resultsFile]);
    expect(other.code).toBe(1);
  }, 30_000);

  test("the same rule and layer give the same JSON, SQL and plan id (invariant 7)", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const a = await rule(root, "lake", "sessions", "--filter", "device <> 'tablet' and started_at >= date '2025-01-01'", ["--json"]);
    const b = await rule(root, "lake", "sessions", "--filter", "device <> 'tablet' and started_at >= date '2025-01-01'", ["--json"]);
    expect(a.out).toBe(b.out);
    const input = () => ({
      source: loadSource(root, "lake"),
      snapshot: loadSnapshot(root, "lake"),
      models: listModels(root, "lake").map((l) => l.model),
      model: loadModel(root, "lake", "sessions").model,
      kind: "filter" as const,
      text: "device = 'mobile'",
    });
    expect(checkRule(input())).toEqual(checkRule(input()));
  });
});

describe("check-rule on Acme's warehouse, loaded into duckdb", () => {
  test("a one-hop and a two-hop filter count exactly, as SQL the compiler's join planner writes", async () => {
    const file = await warehouseDuckdb();
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: file });
    const one = (await rule(root, "warehouse", "orders", "--filter", ONE_HOP, ["--json"])).json<Yes>();
    expect(one).toMatchObject({ expressible: true, joins_used: ["customer"], joins: [{ alias: "orders~customer", via: "orders.customer", model: "customers", type: "left", for: "definition" }] });
    expect(one.sql).toBe(
      [
        "select",
        `  count(*) filter (where "orders~customer".acquisition_channel = 'paid_search') as "rows_matched",`,
        '  count(*) as "rows_total"',
        'from "acme"."fct_orders" as "orders"',
        'left join "acme"."dim_customers" as "orders~customer" on "orders"."customer_id" = "orders~customer"."customer_id"',
      ].join("\n"),
    );
    expect(one.rows_matched).toBe(await duckCount(file, ONE_HOP_SQL.matched));
    expect(one.rows_total).toBe(await duckCount(file, ONE_HOP_SQL.total));
    expect([one.rows_matched, one.rows_total]).toEqual([1193, 5000]);

    const two = (await rule(root, "warehouse", "refunds", "--filter", TWO_HOP, ["--json"])).json<Yes>();
    expect(two.joins_used).toEqual(["order.test_account"]);
    expect(two.joins.map((j) => j.alias)).toEqual(["refunds~order", "refunds~order.test_account"]);
    expect(two.rows_matched).toBe(await duckCount(file, TWO_HOP_SQL.matched));
    expect(two.rows_total).toBe(await duckCount(file, TWO_HOP_SQL.total));
    expect(two.rows_matched).toBeGreaterThan(0);

    const plain = await rule(root, "warehouse", "refunds", "--filter", TWO_HOP);
    expect(plain.out.split("\n")[0]).toBe("The layer can express this filter on warehouse.refunds, through the join order.test_account.");
    const dim = (await rule(root, "warehouse", "orders", "--dimension-expr", "customer.home_region.region_name", ["--json"])).json<Yes>();
    expect(dim.joins_used).toEqual(["customer.home_region"]);
    expect(dim.rows_total).toBe(5000);
  }, 60_000);

  test("an aggregate over a to-many join, a to-many reference, another table and unknown columns are refused", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    withCustomerOrders(root);
    const no = async (model: string, text: string) => {
      const r = await rule(root, "warehouse", model, "--filter", text, ["--json"]);
      expect(r.code).toBe(1);
      return r.json<No>();
    };
    expect(await no("customers", "min(orders.created_at) >= date '2025-01-01'")).toMatchObject({
      code: "aggregate",
      reason: "the filter needs an aggregate (min()) over orders; a rule is read row by row on customers",
      suggestion: "Ask the owner for a view with one row per customer and min_created_at, model it with a join from customers, and run sl check-rule again with the rule over that join.",
    });
    expect((await no("orders", "created_at = min(created_at) over (partition by customer_id)")).suggestion).toContain("one row per customer and min_created_at");
    expect(await no("customers", "orders.status = 'cancelled'")).toMatchObject({
      code: "to_many_join",
      reason: "orders.status reads through join customers.orders, which is one_to_many: it would repeat rows of customers",
      suggestion:
        "Add a many_to_one or one_to_one join from customers that reaches the column (sl check-join measures it), or ask the owner for a view with one row per customer that holds what the rule needs, model it, and run sl check-rule on it.",
    });
    expect((await no("orders", "acme.dim_customers.email like '%@x.test'")).code).toBe("other_table");
    expect((await no("orders", "dim_regions.region_name = 'x'")).code).toBe("other_table");
    expect(await no("orders", "customer.emial like '%@example-test.com'")).toMatchObject({
      code: "unknown_column",
      reason: 'customer.emial: "emial" is not a column of acme.dim_customers, the table of model customers that customer reaches; the closest names are email',
    });
    const dim = await no("orders", "order_date >= date '2025-01-01'");
    expect(dim.code).toBe("unknown_column");
    expect(dim.suggestion).toBe("order_date is a dimension of orders, and a rule reads columns: write its expr, created_at, in the rule.");
    expect((await no("refunds", "order.customer.home_region.region_name = 'x'")).code).toBe("too_many_hops");
    expect(await no("orders", "customer.address = 'x'")).toMatchObject({
      reason: 'customer.address: "address" is not a column of acme.dim_customers, the table of model customers that customer reaches; no name of it is close',
      suggestion: "Write customer.<column> with a column of acme.dim_customers, or, if the column is new, run sl introspect --source warehouse and check the rule again.",
    });
    expect((await no("orders", "customr = 1")).reason).toContain("the closest names are customer.<column>");
    // Aggregates quoted or schema-qualified, and a schema-qualified function, are refused before the database reads them.
    for (const t of [`"count"(*) > 1`, "main.count(*) > 1", "status.count() > 1"]) expect((await no("orders", t)).code).toBe("aggregate");
    expect(await no("orders", "pg_catalog.lower(status) = 'x'")).toMatchObject({ code: "other_table", suggestion: "Write lower(...) without pg_catalog., and run sl check-rule again." });
  });

  test("a join whose evidence shows fan-out is refused naming sl check-join", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const path = join(root, "models", "warehouse", "orders.yaml");
    const m = readYaml<Model>(path);
    const j = m.joins!.find((x) => x.name === "customer")!;
    j.evidence = { ...(j.evidence ?? {}), to: "customers", keys: j.keys, right_key_unique: false, max_fanout: 2, suggested_relationship: "one_to_many" } as never;
    delete (j as { fanout_override?: string }).fanout_override;
    writeYaml(path, m);
    const r = (await rule(root, "warehouse", "orders", "--filter", ONE_HOP, ["--json"])).json<No>();
    expect(r.code).toBe("join_fans_out");
    expect(r.suggestion).toContain("sl check-join --source warehouse --model orders --join customer");
    expect(r.suggestion).toEndWith("then run sl check-rule again.");
  });

  test("a rule that is not one read-only expression is refused (invariant 1)", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    const code = async (text: string) => (await rule(root, "lake", "sessions", "--filter", text, ["--json"])).json<No>().code;
    expect(await code("device = 'x'; drop table sessions")).toBe("invalid_rule");
    expect(await code("true) as rows_matched, count(*) as rows_total from web_events --")).toBe("invalid_rule");
    expect(await code("device = $1")).toBe("invalid_rule");
    expect(await code("device = '{{user.region}}' or device = {{user.region}}")).toBe("invalid_rule");
    expect(await code("read_text('/etc/hosts') is not null")).toBe("not_read_only");
    expect(await code(`"read_text"('/etc/hosts') is not null`)).toBe("not_read_only");
    expect(await code("")).toBe("invalid_rule");
    // Postgres and DuckDB nest block comments: a rule must not close filter (where ...) or hide a
    // subquery from the checks by reading one way here and another in the database.
    expect(await code("/* /* */ ( */ true) as device, 1 as utm_channel, (1 /* /* */ ) */")).toBe("invalid_rule");
    const file = join(DATA, "lake", "marketing_spend.parquet");
    expect(await code(`device = 'mobile' and exists( /* /* */ */ from read_parquet('${file}'))`)).toBe("invalid_rule");
    expect(await code("device = 'mobile' and exists(from web_events)")).toBe("subquery");
    expect(await code("status in (table acme.dim_customers)")).toBe("subquery");
    // An unterminated string or comment is a refusal that --json prints, naming what to close.
    const open = (await rule(root, "lake", "sessions", "--filter", "device = 'mobile", ["--json"])).json<No>();
    expect(open).toMatchObject({ code: "invalid_rule", reason: "the filter has an unterminated string, so it is not one SQL expression", suggestion: "Close the string and run sl check-rule again." });
    expect(await code("device = 'x' /* note")).toBe("invalid_rule");
    // A comment of its own, and a line comment, are still read.
    expect((await rule(root, "lake", "sessions", "--filter", "device = 'mobile' /* the app */ -- note", ["--json"])).json<Yes>().rows_matched).toBe(4380);
  });

  test("a failing count query over a protected column never prints one of its values (invariant 3)", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: await warehouseDuckdb() });
    const r = await rule(root, "warehouse", "customers", "--filter", "cast(email as integer) > 0", ["--json"]);
    expect(r.code).toBe(1);
    expect(`${r.out}\n${r.err}`).not.toMatch(/@[a-z0-9-]+\.example\.com/);
    expect(r.err).toContain("The rule reads the protected column email");
    expect(r.err).toContain("run sl check-rule again");
    // Over unprotected columns the database's message is kept.
    const plain = await rule(root, "warehouse", "orders", "--filter", "cast(status as integer) > 0");
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("Query failed:");
  }, 60_000);
});

describe("check-rule on a dialect the CLI cannot run", () => {
  test("a snowflake source uses the query-plan protocol, with portable SQL", async () => {
    const root = acmeCopy({ dialect: "duckdb", schema: "acme", database: ":memory:" });
    writeFileSync(join(root, "sources", "warehouse.yaml"), "source: warehouse\ndialect: snowflake\nconnection:\n  env: WH_URL\n");
    const live = await rule(root, "warehouse", "orders", "--filter", ONE_HOP);
    expect(live.code).toBe(1);
    expect(live.err).toContain("Rerun with --emit-sql");
    const plan = (await rule(root, "warehouse", "orders", "--filter", ONE_HOP, ["--emit-sql"])).json<{ queries: { id: string; sql: string }[] }>();
    expect(plan.queries[0]!.sql.split("\n")[1]).toBe(`  coalesce(sum(case when "orders~customer".acquisition_channel = 'paid_search' then 1 else 0 end), 0) as "rows_matched",`);
    const results = join(root, "..", "results.json");
    writeJson(results, { [plan.queries[0]!.id]: [{ ROWS_MATCHED: "1193", ROWS_TOTAL: "5000" }] });
    const done = (await rule(root, "warehouse", "orders", "--filter", ONE_HOP, ["--results", results, "--json"])).json<Yes>();
    expect([done.rows_matched, done.rows_total]).toEqual([1193, 5000]);
  });
});

describe("check-rule helpers", () => {
  test("closestNames ranks by edits, then by name; ruleCounts reads bigint and text counts", () => {
    expect(closestNames("devise", ["device", "session_id", "started_at", "devices"])).toEqual(["device", "devices"]);
    expect(closestNames("zzz", ["device"])).toEqual([]);
    expect(ruleCounts([{ rows_matched: 2n, rows_total: "5" }], "rule:x")).toEqual({ rows_matched: 2, rows_total: 5 });
    expect(() => ruleCounts([{ rows_matched: 1.5, rows_total: 5 }], "rule:x")).toThrow("not a count");
    expect(() => ruleCounts([], "rule:x")).toThrow("must be one row");
  });
});

describe("check-rule on Acme's warehouse on postgres", () => {
  test.skipIf(!PG_URL)(
    "a one-hop and a two-hop filter count exactly; an aggregate and a to-many reference are refused",
    async () => {
      assertLocalPg(PG_URL);
      const schema = uniqueSchema("sl_rule");
      const db = new SQL({ url: PG_URL!, max: 1 });
      try {
        await loadPostgres(PG_URL!, DATA, schema);
        const root = acmeCopy({ dialect: "postgres", schema });
        withCustomerOrders(root);
        const env = { PG_URL };
        const count = async (sql: string) => Number(((await db.unsafe(sql.replaceAll("acme.", `${schema}.`))) as { n: unknown }[])[0]!.n);
        const one = (await rule(root, "warehouse", "orders", "--filter", ONE_HOP, ["--json"], env)).json<Yes>();
        expect(one.joins_used).toEqual(["customer"]);
        expect([one.rows_matched, one.rows_total]).toEqual([await count(ONE_HOP_SQL.matched), await count(ONE_HOP_SQL.total)]);
        expect([one.rows_matched, one.rows_total]).toEqual([1193, 5000]);
        const two = (await rule(root, "warehouse", "refunds", "--filter", TWO_HOP, ["--json"], env)).json<Yes>();
        expect(two.joins_used).toEqual(["order.test_account"]);
        expect([two.rows_matched, two.rows_total]).toEqual([await count(TWO_HOP_SQL.matched), await count(TWO_HOP_SQL.total)]);
        const agg = await rule(root, "warehouse", "customers", "--filter", "max(orders.created_at) > now()", ["--json"], env);
        expect(agg.code).toBe(1);
        expect(agg.json<No>().suggestion).toContain("one row per customer and max_created_at");
        expect((await rule(root, "warehouse", "customers", "--filter", "orders.status = 'x'", ["--json"], env)).json<No>().code).toBe("to_many_join");
        const pii = await rule(root, "warehouse", "customers", "--filter", "cast(email as integer) > 0", ["--json"], env);
        expect(pii.code).toBe(1);
        expect(`${pii.out}\n${pii.err}`).not.toMatch(/@[a-z0-9-]+\.example\.com/);
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await db.close();
      }
    },
    120_000,
  );
});

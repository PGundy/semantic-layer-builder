import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { ROLES, slRefusal } from "../skills/semantic-layer/scripts/lib/roles.ts";
import type { Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { catalogFor, plainLiteral, type UsageFile } from "../skills/semantic-layer/scripts/lib/usage.ts";
import { readStatement, splitStatements } from "../skills/semantic-layer/scripts/lib/usage-sql.ts";
import { schemaValidator } from "../skills/semantic-layer/scripts/mcp/schema.ts";
import { sl, tempDir, tempRoot } from "./helpers.ts";

// sl usage (spec: Usage evidence): saved queries and query logs read as evidence, on a copy of the
// Acme example layer and the synthetic fixture under fixtures/acme/usage. All data is synthetic.

const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");
const FIXTURE = join(REPO, "fixtures", "acme", "usage");
const SL = join(REPO, "skills", "semantic-layer", "scripts", "sl.ts");
const SCHEMA = JSON.parse(readFileSync(join(REPO, "skills", "semantic-layer", "schemas", "usage.schema.json"), "utf8")) as object;
const validateUsage = schemaValidator().compile(SCHEMA);
// The month every fixture file's modification time is set to.
const MTIME = new Date("2023-05-10T12:00:00Z");

// A copy of the Acme example layer whose warehouse snapshot also holds legacy.dim_regions, so an
// unqualified dim_regions is ambiguous.
function acme(): { root: string; dir: string } {
  const { root, dir } = tempRoot();
  cpSync(ACME, root, { recursive: true });
  const p = join(root, "snapshots", "warehouse.json");
  const s = JSON.parse(readFileSync(p, "utf8")) as Snapshot;
  const regions = s.tables.find((t) => t.name === "dim_regions")!;
  s.tables.push({ ...structuredClone(regions), schema: "legacy" });
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
  return { root, dir };
}

// A copy of the fixture with every file's modification time in 2023-05.
function fixture(dir: string): string {
  const to = join(dir, "queries");
  cpSync(FIXTURE, to, { recursive: true });
  const touch = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) touch(p);
      utimesSync(p, MTIME, MTIME);
    }
  };
  touch(to);
  return to;
}

function usageFile(root: string): UsageFile {
  return JSON.parse(readFileSync(join(root, "snapshots", "warehouse.usage.json"), "utf8")) as UsageFile;
}

async function ok(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = await sl(root, args, env);
  if (r.code !== 0) throw new Error(`sl ${args.join(" ")}: ${r.err}`);
  return r;
}

// A snapshot for the reader's own tests: acme.orders and acme.customers, legacy.customers, crm.accounts.
function snapshotOf(tables: [string, string, string[]][]): Snapshot {
  return {
    snapshot_version: 1,
    source: "wh",
    dialect: "postgres",
    captured_at: "2026-01-01T00:00:00Z",
    method: "introspect",
    tables: tables.map(([schema, name, cols]) => ({ schema, name, kind: "table", columns: cols.map((c) => ({ name: c, type: "text", nullable: true })) }) as unknown as SnapshotTable),
  } as unknown as Snapshot;
}
const SNAP = snapshotOf([
  ["acme", "orders", ["order_id", "customer_id", "status", "amount_cents", "created_at", "region"]],
  ["acme", "customers", ["customer_id", "email", "is_test", "channel"]],
  ["acme", "staging_orders", ["order_id"]],
  ["legacy", "customers", ["customer_id", "email"]],
  ["crm", "accounts", ["account_id", "customer_id", "tier"]],
]);
const KEPT = new Set(["acme.orders", "acme.customers"]);
const CAT = catalogFor(SNAP, { kept: (t) => KEPT.has(`${t.schema}.${t.name}`), schemas: new Set(["acme"]) });
const read = (sql: string) => readStatement(sql, CAT);

describe("the statement reader", () => {
  test("splits a .sql file at semicolons outside strings, quoted names, dollar quotes and comments", () => {
    const text = "select ';' from acme.orders; select $x$a;b$x$, \"c;d\" from acme.orders; -- e;\nselect 1 /* f; /* g; */ */;\n\\set ON_ERROR_STOP on\nselect E'h\\';' from acme.orders";
    const parts = splitStatements(text).map((s) => read(s).status);
    expect(parts.filter((s) => s !== "empty")).toEqual(["read", "read", "no_table", "read"]);
  });

  test("subsetting: qualified, unqualified unique, ambiguous, out of scope, other schema, not in the snapshot", () => {
    const kinds = (sql: string) => Object.fromEntries(read(sql).tables);
    expect(kinds("select * from acme.orders")).toEqual({ "acme.orders": "kept" });
    expect(kinds("select * from orders")).toEqual({ "acme.orders": "kept" });
    expect(kinds("select * from customers")).toEqual({ customers: "ambiguous" });
    expect(kinds("select * from staging_orders")).toEqual({ "acme.staging_orders": "out_of_scope" });
    expect(kinds("select * from crm.accounts")).toEqual({ "crm.accounts": "other" });
    expect(kinds("select * from analytics.events")).toEqual({ "analytics.events": "other" });
    expect(kinds("select * from acme.orders_old")).toEqual({ "acme.orders_old": "not_in_snapshot" });
    expect(kinds("select * from warehouse.acme.orders")).toEqual({ "acme.orders": "kept" });
    expect(kinds('select * from "acme"."orders"')).toEqual({ "acme.orders": "kept" });
  });

  test("CTE names, subquery aliases and table functions are not tables", () => {
    const r = read("with orders as (select * from acme.customers) select o.* from orders o, (select 1) s, generate_series(1, 3) g");
    expect(Object.fromEntries(r.tables)).toEqual({ "acme.customers": "kept" });
    expect(read("select * from generate_series(1, 3)").status).toBe("no_table");
  });

  test("a statement reading a kept table and another schema's is kept with the other listed", () => {
    const r = read("select sum(o.amount_cents) from acme.orders o join crm.accounts a on a.customer_id = o.customer_id");
    expect(Object.fromEntries(r.tables)).toEqual({ "acme.orders": "kept", "crm.accounts": "other" });
    expect(r.aggregates.map((a) => [a.table, a.fn, a.expr])).toEqual([["acme.orders", "sum", "amount_cents"]]);
    expect(r.joins).toEqual([]);
  });

  test("joins from ON, USING and WHERE equalities, with their keys", () => {
    expect(read("select 1 from acme.orders o join acme.customers c on c.customer_id = o.customer_id").joins).toEqual([{ a: "acme.customers", b: "acme.orders", keys: [["customer_id", "customer_id"]] }]);
    expect(read("select 1 from acme.orders join acme.customers using (customer_id)").joins).toEqual([{ a: "acme.customers", b: "acme.orders", keys: [["customer_id", "customer_id"]] }]);
    expect(read("select 1 from acme.orders o, acme.customers c where o.customer_id = c.customer_id and o.status = 'x'").joins).toEqual([
      { a: "acme.customers", b: "acme.orders", keys: [["customer_id", "customer_id"]] },
    ]);
  });

  test("aggregates with the column inside, attributed by the columns, and conditions from WHERE, FILTER and CASE", () => {
    const r = read(
      "select count(distinct customer_id), sum(amount_cents) filter (where status <> 'cancelled'), sum(case when status in ('a', 'b') then amount_cents else 0 end), avg(amount_cents / 100.0), count(*) " +
        "from acme.orders where region = 'NE' and (status = 'completed' or status = 'shipped')",
    );
    expect(r.aggregates.map((a) => [a.fn, a.expr])).toEqual([
      ["count_distinct", "customer_id"],
      ["sum", "amount_cents"],
      ["sum", "amount_cents"],
      ["avg", "amount_cents / ?"],
      ["count", "*"],
    ]);
    const own = (i: number) => r.aggregates[i]!.conditions.map((c) => `${c.column} ${c.op} ${c.values.map((v) => v.text).join(",")}`);
    expect(own(1)).toEqual(["status <> cancelled", "region = NE", "status in completed,shipped"]);
    expect(own(2)).toEqual(["status in a,b", "region = NE", "status in completed,shipped"]);
    expect(r.conditions.map((c) => `${c.column} ${c.op}`)).toEqual(["region =", "status in"]);
  });

  test("an outer join's ON condition, a window aggregate and a HAVING aggregate are not read as what a statement sums by", () => {
    const left = read("select sum(o.amount_cents) from acme.orders o left join acme.customers c on c.customer_id = o.customer_id and c.is_test = false");
    expect(left.aggregates.map((a) => [a.fn, a.expr, a.conditions.length])).toEqual([["sum", "amount_cents", 0]]);
    // It still counts as a condition on its table, and the join is read.
    expect(left.conditions.map((c) => `${c.table}.${c.column} ${c.op}`)).toEqual(["acme.customers.is_test ="]);
    expect(left.joins).toEqual([{ a: "acme.customers", b: "acme.orders", keys: [["customer_id", "customer_id"]] }]);
    const inner = read("select sum(o.amount_cents) from acme.orders o join acme.customers c on c.customer_id = o.customer_id and c.is_test = false");
    expect(inner.aggregates[0]!.conditions.map((c) => c.column)).toEqual(["is_test"]);
    expect(read("select sum(amount_cents) over (partition by customer_id) from acme.orders").aggregates).toEqual([]);
    expect(read("select sum(amount_cents) filter (where status = 'a') over () from acme.orders").aggregates).toEqual([]);
    expect(read("select customer_id from acme.orders group by customer_id having sum(amount_cents) > 100000").aggregates).toEqual([]);
  });

  test("conditions: operators, flipped literals, booleans, wrapped columns, subqueries and placeholders", () => {
    const r = read(
      "select 1 from acme.orders o join acme.customers c on c.customer_id = o.customer_id " +
        "where not c.is_test and lower(c.email) not like '%@x.example' and 'done' = o.status and o.created_at between '2025-01-01' and '2025-12-31' " +
        "and o.region is not null and o.amount_cents >= $1 and o.customer_id not in (select customer_id from acme.customers where is_test) and o.status = :st and o.region = %s",
    );
    expect(r.conditions.map((c) => [c.fn ?? "", c.column, c.op, c.values.map((v) => `${v.kind}:${v.text}`).join(",")])).toEqual([
      ["", "is_test", "=", "bool:false"],
      ["lower", "email", "not like", "string:%@x.example"],
      ["", "status", "=", "string:done"],
      ["", "created_at", "between", "string:2025-01-01,string:2025-12-31"],
      ["", "region", "is not null", ""],
      ["", "amount_cents", ">=", "placeholder:?"],
      ["", "customer_id", "not in", "subquery:<subquery>"],
      ["", "status", "=", "placeholder:?"],
      ["", "region", "=", "placeholder:?"],
      ["", "is_test", "=", "bool:true"],
    ]);
  });

  test("group by name, alias and position, with time grains", () => {
    const r = read(
      "select date_trunc('month', created_at) as m, created_at::date as d, region, extract(year from created_at) y, count(*) from acme.orders group by m, 2, region, 4",
    );
    expect(r.groupBy.map((g) => `${g.column}${g.grain ? `/${g.grain}` : ""}`)).toEqual(["created_at/month", "created_at/day", "region", "created_at/year"]);
  });

  test("columns pass through CTEs and subqueries, and a CTE's WHERE holds for the aggregate over it", () => {
    const r = read(
      "with counted as (select order_id, customer_id, amount_cents from acme.orders where status = 'completed') " +
        "select c.channel, sum(k.amount_cents) from counted k join acme.customers c on c.customer_id = k.customer_id group by c.channel",
    );
    expect(r.aggregates.map((a) => [a.table, a.expr, a.conditions.map((c) => `${c.column} ${c.op}`)])).toEqual([["acme.orders", "amount_cents", ["status ="]]]);
    expect(r.joins).toEqual([{ a: "acme.customers", b: "acme.orders", keys: [["customer_id", "customer_id"]] }]);
    expect(r.groupBy).toEqual([{ table: "acme.customers", column: "channel" }]);
  });

  test("a column it cannot place is left out, never guessed", () => {
    // customer_id is in both tables; the unqualified one is not placed.
    const r = read("select count(distinct customer_id) from acme.orders o join acme.customers c on c.customer_id = o.customer_id where status = 'x'");
    expect(r.aggregates).toEqual([]);
    expect(r.conditions.map((c) => c.column)).toEqual(["status"]);
    // A column of a table whose columns cannot be told is not placed either.
    expect(read("select sum(amount_cents) from acme.orders o join analytics.events e on e.id = o.order_id").aggregates).toEqual([]);
  });

  test("dbt's ref and source resolve by table name; any other template where a table belongs is not understood", () => {
    const r = read("{{ config(materialized='table') }} select sum(amount_cents) from {{ ref('orders') }} where status = '{{ var(\"s\") }}' {% if x %} and 1 = 1 {% endif %}");
    expect(Object.fromEntries(r.tables)).toEqual({ "acme.orders": "kept" });
    expect(read("select * from {{ source('acme', 'customers') }}").tables.get("customers")).toBe("ambiguous");
    expect(read("select count(*) from {{ var('t') }}").status).toBe("not_understood");
    expect(read("select count(*) from acme.orders o join {{ this }} t on t.id = o.order_id").status).toBe("read");
  });

  test("broken SQL is not understood, and comments are never read", () => {
    expect(read("select ( from acme.orders").status).toBe("not_understood");
    expect(read("select 'open from acme.orders").status).toBe("not_understood");
    expect(read("-- select * from acme.orders\n/* from acme.customers */").status).toBe("empty");
  });

  test("a literal is kept only when short and plain", () => {
    for (const v of ["completed", "NE", "2025-01-01", "42", "paid_search"]) expect(plainLiteral(v)).toBe(true);
    for (const v of ["dana@acme.example", "%@example-test.com", "postgres://u:p@h/db", "password=x", "4111111111111111", "+1 415 555 0100", "x".repeat(33), "AKIA0123456789ABCDEFGH", "a\nb"])
      expect(plainLiteral(v)).toBe(false);
  });
});

describe("sl usage add on the Acme fixture", () => {
  let root: string;
  let dir: string;
  let queries: string;
  let file: UsageFile;
  let out: string;
  beforeAll(async () => {
    ({ root, dir } = acme());
    queries = fixture(dir);
    out = (await ok(root, ["usage", "add", "--source", "warehouse", queries])).out;
    file = usageFile(root);
  });

  test("the file matches its schema and sl validate checks it", async () => {
    if (!validateUsage(file)) throw new Error(JSON.stringify(validateUsage.errors));
    const v = await sl(root, ["validate", "--json"]);
    const issues = (v.json<{ issues: { file: string }[] }>().issues ?? []).filter((i) => i.file.includes("usage"));
    expect(issues).toEqual([]);
  });

  test("the summary counts each statement once, by hand count", () => {
    expect(file.summary).toEqual({
      files: 8,
      statements: 32,
      kept: 20,
      other_schemas: 4,
      out_of_scope: 1,
      ambiguous: 1,
      not_in_snapshot: 1,
      no_table: 2,
      not_understood: 3,
      not_understood_files: ["purchase_events.sql", "query_history.jsonl"],
    });
    expect(out).toContain("Read 8 files and 32 statements: 20 statements kept, 4 statements left out as other schemas");
    expect(out).toContain("3 statements not understood (in purchase_events.sql, query_history.jsonl)");
    // notes.txt and README.md.
    expect(out).toContain("2 other files in those folders are not a query file and were not read.");
    expect(file.not_in_snapshot).toEqual([{ table: "acme.orders_v1", count: 1, last: "2023-05" }]);
    expect(file.ambiguous).toEqual([{ name: "dim_regions", count: 1 }]);
  });

  test("inputs are listed by name, size and hash, never by path", () => {
    expect(file.inputs.map((i) => [i.name, i.kind, i.statements])).toEqual([
      ["2023-revenue.sql", "sql", 3],
      ["2024-other-schemas.sql", "sql", 6],
      ["2024-refunds.sql", "sql", 4],
      ["pasted-from-chat.sql", "sql", 5],
      ["pg_stat_statements.json", "json", 6],
      ["purchase_events.sql", "sql", 1],
      ["query_history.jsonl", "jsonl", 6],
      ["revenue_by_region.sql", "sql", 1],
    ]);
    expect(JSON.stringify(file)).not.toContain(dir);
    expect(JSON.stringify(file)).not.toContain("queries/");
  });

  test("per table: statements, call-weighted count, files, users and months, by hand count", () => {
    const t = (q: string) => {
      const x = file.tables[q]!;
      return [x.statements, x.weighted, x.files, x.users, x.first, x.last];
    };
    expect(Object.keys(file.tables)).toEqual(["acme.dim_customers", "acme.dim_products", "acme.dim_regions", "acme.fct_order_items", "acme.fct_orders", "acme.fct_refunds"]);
    // fct_orders: 3 + 2 + 1 + 1 + 1 statements in .sql files, 3 in the pg_stat_statements log (412 + 1890 + 57 calls), 3 in the query history.
    expect(t("acme.fct_orders")).toEqual([14, 2370, 7, 4, "2023-05", "2025-06"]);
    expect(t("acme.dim_customers")).toEqual([8, 64, 5, 2, "2023-05", "2024-11"]);
    expect(t("acme.fct_refunds")).toEqual([3, 3, 1, 0, "2023-05", "2023-05"]);
    expect(t("acme.dim_regions")).toEqual([1, 1, 1, 0, "2023-05", "2023-05"]);
    expect(t("acme.fct_order_items")).toEqual([1, 12, 1, 1, "2023-05", "2023-05"]);
  });

  test("aggregates and the conditions kept with them, by hand count", () => {
    const orders = file.tables["acme.fct_orders"]!;
    expect(orders.aggregates.map((a) => [a.fn, a.expr, a.count])).toEqual([
      ["sum", "amount_cents", 10],
      ["count", "*", 2],
      ["count_distinct", "customer_id", 1],
    ]);
    expect(orders.aggregates[0]!.conditions.slice(0, 2)).toEqual([
      { table: "acme.fct_orders", column: "status", op: "in", values: ["completed", "shipped"], count: 5 },
      { table: "acme.dim_customers", column: "is_test_account", op: "=", values: ["false"], count: 3 },
    ]);
    // The case when inside a sum.
    expect(orders.aggregates[0]!.conditions).toContainEqual({ table: "acme.fct_orders", column: "status", op: "=", values: ["refunded"], count: 1 });
    const refunds = file.tables["acme.fct_refunds"]!;
    expect(refunds.aggregates.map((a) => [a.fn, a.expr, a.count])).toEqual([
      ["sum", "refunded_cents", 2],
      ["count", "*", 1],
    ]);
    // The filter (where ...) of a sum, and the CTE's condition on the orders it reads.
    expect(refunds.conditions).toEqual([{ column: "reason", op: "<>", values: ["price_adjustment"], count: 1 }]);
    expect(refunds.aggregates[0]!.conditions.map((c) => `${c.column} ${c.op}`).sort()).toEqual(["reason <>", "status in"]);
    expect(file.tables["acme.fct_order_items"]!.aggregates.map((a) => a.expr)).toEqual(["quantity * unit_price_cents"]);
  });

  test("conditions per table, by hand count", () => {
    expect(file.tables["acme.fct_orders"]!.conditions.slice(0, 3)).toEqual([
      { column: "status", op: "in", values: ["completed", "shipped"], count: 7 },
      { column: "status", op: "=", values: ["completed"], count: 2 },
      { column: "status", op: "in", values: ["?"], count: 2 },
    ]);
    expect(file.tables["acme.dim_customers"]!.conditions).toEqual([
      { column: "is_test_account", op: "=", values: ["false"], count: 3 },
      { column: "email", op: "=", values: ["?"], count: 1 },
      { column: "email", op: "not like", values: ["?"], count: 1 },
      { column: "email", fn: "lower", op: "like", values: ["?"], count: 1 },
      { column: "first_name", op: "=", values: ["?"], count: 1 },
      { column: "is_test_account", op: "=", values: ["?"], count: 1 },
      { column: "last_name", op: "=", values: ["?"], count: 1 },
    ]);
  });

  test("joins, splits and other-schema tables, by hand count", () => {
    const orders = file.tables["acme.fct_orders"]!;
    expect(orders.joins).toEqual([
      { with: "acme.dim_customers", keys: ["customer_id = customer_id"], count: 5 },
      { with: "acme.dim_regions", keys: ["ship_region = region_code"], count: 1 },
      { with: "acme.fct_refunds", keys: ["order_id = order_id"], count: 1 },
    ]);
    expect(file.tables["acme.dim_products"]!.joins).toEqual([{ with: "acme.fct_order_items", keys: ["product_id = product_id"], count: 1 }]);
    expect(orders.group_by).toEqual([
      { column: "created_at", grain: "month", count: 4 },
      { column: "ship_region", count: 3 },
    ]);
    expect(file.tables["acme.fct_refunds"]!.group_by).toEqual([{ column: "reason", count: 2 }]);
    expect(orders.outside).toEqual([{ table: "crm.accounts", count: 1 }]);
    expect(file.tables["acme.dim_customers"]!.outside).toEqual([]);
  });

  test("the same bytes whatever the order of the paths, and two adds equal one add of both", async () => {
    const bytes = readFileSync(join(root, "snapshots", "warehouse.usage.json"), "utf8");
    const other = acme();
    const q = fixture(other.dir);
    await ok(other.root, ["usage", "add", "--source", "warehouse", join(q, "logs"), join(q, "scratch", "dbt"), join(q, "scratch")]);
    expect(readFileSync(join(other.root, "snapshots", "warehouse.usage.json"), "utf8")).toBe(bytes);
    const twice = acme();
    const q2 = fixture(twice.dir);
    await ok(twice.root, ["usage", "add", "--source", "warehouse", join(q2, "scratch")]);
    const second = await ok(twice.root, ["usage", "add", "--source", "warehouse", join(q2, "logs"), join(q2, "scratch", "2023-revenue.sql")]);
    expect(second.out).toContain("Already read, skipped: 2023-revenue.sql.");
    expect(readFileSync(join(twice.root, "snapshots", "warehouse.usage.json"), "utf8")).toBe(bytes);
    const again = await ok(twice.root, ["usage", "add", "--source", "warehouse", q2]);
    expect(again.out).toContain("Nothing new");
  });

  test("no protected value, e-mail literal, user or connection string reaches the file or any output", async () => {
    const outputs = [
      readFileSync(join(root, "snapshots", "warehouse.usage.json"), "utf8"),
      out,
      (await ok(root, ["usage", "show", "--source", "warehouse"])).out,
      (await ok(root, ["usage", "show", "--source", "warehouse", "--json"])).out,
      (await ok(root, ["usage", "show", "--source", "warehouse", "--table", "dim_customers"])).out,
      (await ok(root, ["tables", "--source", "warehouse"])).out,
      (await ok(root, ["tables", "--source", "warehouse", "--json"])).out,
      // The layer's own files quote the test-account domain; the usage blocks are what this adds.
      JSON.stringify((await ok(root, ["brief", "--source", "warehouse", "--tables", "fct_orders,dim_customers", "--json"])).json<{ tables: { usage: unknown }[] }>().tables.map((t) => t.usage)),
      JSON.stringify((await ok(root, ["baseline", "--source", "warehouse", "--json"])).json<{ tables: { usage: unknown }[] }>().tables.map((t) => t.usage)),
      (await ok(root, ["brief", "--source", "warehouse", "--tables", "fct_orders,dim_customers"])).out,
    ].join("\n").toLowerCase();
    for (const secret of ["sup3rs3cret", "postgres://", "postgresql://", "warehouse.acme.example", "qa.lead", "example-test.com", "avery", "okafor", "4412873", "dana.ruiz", "dana_ruiz", "ops_bot", "password"])
      expect(`${secret}: ${outputs.includes(secret)}`).toBe(`${secret}: false`);
  });

  test("an instruction in a comment or a string changes nothing", async () => {
    const { root: r2, dir: d2 } = acme();
    const q = fixture(d2);
    const state = () =>
      JSON.stringify(
        readdirSync(r2, { recursive: true })
          .map(String)
          .filter((f) => !f.endsWith(".usage.json") && statSync(join(r2, f)).isFile())
          .sort()
          .map((f) => [f, readFileSync(join(r2, f), "utf8")]),
      );
    const before = [state(), (await sl(r2, ["next", "--json"])).out, (await sl(r2, ["status", "--json"])).out];
    await ok(r2, ["usage", "add", "--source", "warehouse", q]);
    const after = [state(), (await sl(r2, ["next", "--json"])).out, (await sl(r2, ["status", "--json"])).out];
    expect(after).toEqual(before);
    const text = readFileSync(join(r2, "snapshots", "warehouse.usage.json"), "utf8").toLowerCase();
    for (const s of ["ignore previous", "approve --recursive", "approved by", "every status"]) expect(text).not.toContain(s);
  });

  test("sl tables shows each table's count and names the unused ones", async () => {
    const json = (await ok(root, ["tables", "--source", "warehouse", "--json"])).json<{ tables: { table: string; usage: number }[]; unused: string[] }>();
    expect(Object.fromEntries(json.tables.map((t) => [t.table, t.usage]))).toMatchObject({ "acme.fct_orders": 14, "acme.dim_customers": 8, "acme.dim_sales_reps": 0 });
    expect(json.unused).toEqual(["acme.dim_sales_reps", "legacy.dim_regions", "acme.sales_team_closure"]);
    const plain = (await ok(root, ["tables", "--source", "warehouse"])).out;
    expect(plain.split("\n")[0]).toMatch(/profiled\s+used$/);
    expect(plain).toContain("3 in-scope tables appear in no saved query: acme.dim_sales_reps, legacy.dim_regions, acme.sales_team_closure.");
  });

  const REVENUE = "5 of the 10 statements that sum orders.amount_cents keep only status in (completed, shipped): is that the rule for revenue?";
  const TEST_ACCOUNTS = "3 of the 10 statements that sum orders.amount_cents keep only customers.is_test_account = false: is that the rule for revenue?";

  test("sl brief and the scoped sl baseline --json carry a usage block with the evidence for the revenue rule", async () => {
    const brief = (await ok(root, ["brief", "--source", "warehouse", "--tables", "fct_orders,dim_sales_reps", "--json"])).json<{ tables: { table: string; usage: { statements: number; evidence?: string[]; from: string } }[] }>();
    const orders = brief.tables.find((t) => t.table === "acme.fct_orders")!;
    expect(orders.usage.from).toBe("query files");
    expect(orders.usage.statements).toBe(14);
    expect(orders.usage.evidence).toEqual([
      REVENUE,
      TEST_ACCOUNTS,
      "5 statements join orders to customers on customer_id = customer_id: is that how they relate?",
      "4 statements split orders by created_at (by month): is that a split you report by?",
    ]);
    expect(brief.tables.find((t) => t.table === "acme.dim_sales_reps")!.usage).toEqual({ from: "query files", statements: 0 });
    const baseline = (await ok(root, ["baseline", "--source", "warehouse", "--json"])).json<{ tables: { table: string; usage: { evidence?: string[] } }[] }>();
    expect(baseline.tables.find((t) => t.table === "acme.fct_orders")!.usage.evidence).toContain(REVENUE);
    const show = (await ok(root, ["usage", "show", "--source", "warehouse", "--table", "fct_orders"])).out;
    expect(show).toContain(`Evidence to ask about: ${REVENUE}`);
    expect(show).toContain("Next: put the evidence to the owner as a question");
  });

  test("sl draft writes nothing from usage", async () => {
    const { root: r2, dir: d2 } = acme();
    const q = fixture(d2);
    const models = () => readdirSync(join(r2, "models", "warehouse")).sort().map((f) => readFileSync(join(r2, "models", "warehouse", f), "utf8"));
    const before = models();
    await ok(r2, ["usage", "add", "--source", "warehouse", q]);
    await sl(r2, ["draft", "--source", "warehouse", "--tables", "dim_sales_reps,fct_orders"]);
    expect(models()).toEqual(before);
  });
});

describe("without a usage file every output is as before", () => {
  test("sl tables, sl brief and sl baseline print the same bytes before an add and after a clear", async () => {
    const { root, dir } = acme();
    const q = fixture(dir);
    const outputs = async () =>
      Promise.all([
        ["tables", "--source", "warehouse"],
        ["tables", "--source", "warehouse", "--json"],
        ["brief", "--source", "warehouse", "--tables", "fct_orders", "--json"],
        ["brief", "--source", "warehouse", "--tables", "fct_orders"],
        ["baseline", "--source", "warehouse", "--json"],
      ].map(async (a) => (await ok(root, a)).out));
    const before = await outputs();
    expect(before.join("\n")).not.toContain("usage");
    await ok(root, ["usage", "add", "--source", "warehouse", q]);
    expect(await outputs()).not.toEqual(before);
    const cleared = await ok(root, ["usage", "clear", "--source", "warehouse"]);
    expect(cleared.out).toContain("Removed snapshots/warehouse.usage.json");
    expect(existsSync(join(root, "snapshots", "warehouse.usage.json"))).toBe(false);
    expect(await outputs()).toEqual(before);
    expect((await ok(root, ["usage", "show", "--source", "warehouse"])).out).toContain("No usage evidence for warehouse yet");
  });
});

describe("input forms", () => {
  let root: string;
  let dir: string;
  beforeAll(() => ({ root, dir } = acme()));
  const add = async (files: Record<string, string>, extra: string[] = []) => {
    const d = join(dir, `in-${Math.random().toString(36).slice(2)}`);
    mkdirSync(d, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(d, name), text);
      utimesSync(join(d, name), MTIME, MTIME);
    }
    await sl(root, ["usage", "clear", "--source", "warehouse"]);
    const r = await sl(root, ["usage", "add", "--source", "warehouse", ...extra, ...Object.keys(files).map((f) => join(d, f))]);
    return { r, file: existsSync(join(root, "snapshots", "warehouse.usage.json")) ? usageFile(root) : null };
  };
  const Q = "select sum(amount_cents) from acme.fct_orders where status = 'completed'";

  test("a JSON array of strings, and of objects under any common key, with calls, times and users", async () => {
    const { file } = await add({
      "a.json": JSON.stringify([Q, { SQL_TEXT: Q, EXECUTION_COUNT: 3, CREATION_TIME: "2024-02-03T00:00:00Z", USER_EMAIL: "x@acme.example" }, { querytxt: Q, last_seen: 1717200000 }]),
    });
    const t = file!.tables["acme.fct_orders"]!;
    // The string has no time, so it takes the file's month.
    expect([t.statements, t.weighted, t.users, t.first, t.last]).toEqual([3, 5, 1, "2023-05", "2024-06"]);
  });

  test("JSON Lines and NDJSON, a jsonb object exported as text, and --query-key", async () => {
    const { file } = await add({ "b.jsonl": `${JSON.stringify({ statement: Q })}\n${JSON.stringify(JSON.stringify({ query: Q, calls: 4 }))}\n`, "c.ndjson": `${JSON.stringify({ text: Q })}\n` });
    expect([file!.tables["acme.fct_orders"]!.statements, file!.tables["acme.fct_orders"]!.weighted]).toEqual([3, 6]);
    const keyed = await add({ "d.json": JSON.stringify([{ the_sql: Q, query: "select 1" }]) }, ["--query-key", "THE_SQL"]);
    expect(keyed.file!.tables["acme.fct_orders"]!.statements).toBe(1);
  });

  test("a malformed file is skipped with its reason and the rest are read; a file of another kind is refused by name", async () => {
    const { r, file } = await add({ "bad.json": "[{", "obj.json": '{"query": "select 1"}', "good.sql": `${Q};` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Skipped bad.json: it is not valid JSON");
    expect(r.out).toContain("Skipped obj.json: it holds a JSON value that is not an array");
    expect(file!.inputs.find((i) => i.name === "bad.json")!.skipped).toContain("not valid JSON");
    expect(file!.tables["acme.fct_orders"]!.statements).toBe(1);
    const refused = await add({ "q.txt": Q });
    expect(refused.r.code).toBe(1);
    expect(refused.r.err).toContain("q.txt is neither SQL nor a query log. sl usage add reads .sql");
    expect(refused.file).toBeNull();
  });

  test("a log time with no zone is read as UTC, so the bytes do not depend on the machine's time zone", async () => {
    const d = join(dir, "tz");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "log.jsonl"),
      [
        JSON.stringify({ query: Q, start_time: "2025-03-31 23:30:00" }),
        JSON.stringify({ query: "select count(*) from acme.dim_customers", end_time: "2025-01-01 00:10:00" }),
        JSON.stringify({ query: "select count(*) from acme.dim_customers", end_time: "2024-10-31 23:00:00 -0800" }),
      ].join("\n"),
    );
    const bytes: string[] = [];
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      await sl(root, ["usage", "clear", "--source", "warehouse"]);
      const r = Bun.spawnSync(["bun", SL, "usage", "add", "--source", "warehouse", d, "--root", root], { env: { ...process.env, TZ: tz }, cwd: root });
      expect(r.exitCode).toBe(0);
      bytes.push(readFileSync(join(root, "snapshots", "warehouse.usage.json"), "utf8"));
    }
    expect(new Set(bytes).size).toBe(1);
    const f = usageFile(root);
    expect([f.tables["acme.fct_orders"]!.first, f.tables["acme.fct_orders"]!.last]).toEqual(["2025-03", "2025-03"]);
    // An explicit offset is converted: 2024-10-31 23:00 at -08:00 is November in UTC.
    expect([f.tables["acme.dim_customers"]!.first, f.tables["acme.dim_customers"]!.last]).toEqual(["2024-11", "2025-01"]);
  });

  test("a byte-order mark and CRLF line ends are read in every kind of file", async () => {
    const { file } = await add({
      "a.sql": `\uFEFF${Q};\r\nselect count(*) from acme.fct_orders;\r\n`,
      "b.json": `\uFEFF${JSON.stringify([Q])}`,
      "c.jsonl": `\uFEFF${JSON.stringify({ query: Q })}\r\n${JSON.stringify(Q)}\r\n`,
    });
    expect(file!.inputs.filter((i) => i.skipped)).toEqual([]);
    expect([file!.summary.kept, file!.summary.not_understood]).toEqual([5, 0]);
  });

  test("an add that keeps no statement says so and names the fixes", async () => {
    const { r } = await add({ "o.sql": "select * from sales.orders_x; select * from crm.accounts_x;" });
    expect(r.out).toContain("0 tables of warehouse appear in saved queries.");
    expect(r.out).toContain("No statement read here reads a table warehouse keeps. If these queries are for another source, run sl usage clear --source warehouse");
  });

  test("--schema keeps every table of a schema whatever the scope, and a schema the snapshot lacks is refused", async () => {
    const { file } = await add({ "e.sql": "select * from acme.stg_orders; select * from legacy.dim_regions; select * from acme.fct_orders;" }, ["--schema", "legacy"]);
    expect(Object.keys(file!.tables)).toEqual(["legacy.dim_regions"]);
    expect(file!.summary.out_of_scope).toBe(0);
    expect(file!.summary.other_schemas).toBe(2);
    const bad = await add({ "f.sql": Q }, ["--schema", "crm"]);
    expect(bad.r.err).toContain("--schema crm: the snapshot of warehouse has no table in that schema. Its schemas are acme, legacy");
  });
});

describe("what sl usage add refuses to read", () => {
  test("the project's env file, by name or as the env file the lookup reads, and a path inside the semantic root", async () => {
    const { root, dir } = acme();
    const q = join(dir, "q");
    mkdirSync(q);
    writeFileSync(join(q, "a.sql"), "select 1 from acme.fct_orders;");
    writeFileSync(join(dir, ".env"), "WAREHOUSE_URL=postgres://u:secret@h/db\n");
    const named = await sl(root, ["usage", "add", "--source", "warehouse", join(dir, ".env")]);
    expect(named.code).toBe(1);
    expect(named.err).toContain(".env is an env file, which holds the connection secret; sl usage add never reads it.");
    writeFileSync(join(q, "conn.json"), "[]");
    const viaFlag = await sl(root, ["usage", "add", "--source", "warehouse", q, "--env-file", join(q, "conn.json")]);
    expect(viaFlag.code).toBe(1);
    expect(viaFlag.err).toContain("is an env file");
    const inside = await sl(root, ["usage", "add", "--source", "warehouse", join(root, "snapshots")]);
    expect(inside.code).toBe(1);
    expect(inside.err).toContain("is inside the semantic root; query files stay outside it");
    expect(existsSync(join(root, "snapshots", "warehouse.usage.json"))).toBe(false);
    // A link with a query file's name that leads to the env file is refused too.
    symlinkSync(join(dir, ".env"), join(dir, "linked.sql"));
    const linked = await sl(root, ["usage", "add", "--source", "warehouse", join(dir, "linked.sql")]);
    expect(linked.code).toBe(1);
    expect(linked.err).toContain("linked.sql is an env file");
    // A hidden file in a folder is never read: the .env beside the queries stays unread.
    writeFileSync(join(q, ".env"), "X=1\n");
    const r = await ok(root, ["usage", "add", "--source", "warehouse", q, "--env-file", join(dir, ".env")]);
    expect(r.out).not.toContain(".env");
    expect(usageFile(root).inputs.map((i) => i.name)).toEqual(["a.sql", "conn.json"]);
    // The env file SL_ENV_FILE names is refused whatever its name, and the refusal names the source.
    const viaEnv = await sl(root, ["usage", "add", "--source", "warehouse", join(q, "a.sql")], { SL_ENV_FILE: join(q, "a.sql") });
    expect(viaEnv.code).toBe(1);
    expect(viaEnv.err).toContain("a.sql is an env file, which holds the connection secret; sl usage add never reads it. Give the query files or their folder without it, as in sl usage add --source warehouse ./queries.");
  });

  test("a model's pii tag keeps a literal out of every output even when the column name looks harmless", async () => {
    const { root, dir } = acme();
    const p = join(root, "models", "warehouse", "customers.yaml");
    const text = readFileSync(p, "utf8");
    const tagged = text.replace("  - name: acquisition_channel\n    expr: acquisition_channel\n", "  - name: acquisition_channel\n    expr: acquisition_channel\n    tags:\n      - pii\n");
    expect(tagged).not.toBe(text);
    writeFileSync(p, tagged);
    const q = join(dir, "q");
    mkdirSync(q);
    writeFileSync(
      join(q, "a.sql"),
      "select count(*) from acme.dim_customers where acquisition_channel = 'Referralzz';\n" +
        "select count(*) from acme.dim_customers c where 'Referralzz' = c.acquisition_channel;\n" +
        "select sum(o.amount_cents) filter (where c.acquisition_channel in ('Referralzz')) from acme.fct_orders o join acme.dim_customers c on c.customer_id = o.customer_id;\n",
    );
    await ok(root, ["usage", "add", "--source", "warehouse", q]);
    const all = [
      readFileSync(join(root, "snapshots", "warehouse.usage.json"), "utf8"),
      (await ok(root, ["usage", "show", "--source", "warehouse"])).out,
      (await ok(root, ["brief", "--source", "warehouse", "--tables", "fct_orders,dim_customers", "--json"])).out,
    ].join("\n");
    expect(all).toContain("acquisition_channel");
    expect(all.toLowerCase()).not.toContain("referralzz");
  });
});

describe("roles and the hook", () => {
  const call = (agent: string | undefined, command: string, cwd: string): Verdict => {
    const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd, hook_event_name: "PreToolUse" };
    if (agent !== undefined) Object.assign(payload, { agent_type: agent, agent_id: "a1b2c3" });
    return checkToolUse(JSON.stringify(payload));
  };

  test("the interviewer may run sl usage add, show and clear; no other role may", () => {
    for (const sub of ["add --source wh ./queries", "show --source wh", "clear --source wh"]) {
      const args = ["usage", ...sub.split(" ")];
      expect(slRefusal(ROLES.interviewer, args)).toBeUndefined();
      for (const role of [ROLES.batch_analyst, ROLES.connector_runner, ROLES.readback_verifier, ROLES.golden_builder]) expect(slRefusal(role, args)).toContain("may not run sl usage");
    }
    const dir = tempDir("usage-hook");
    mkdirSync(join(dir, "semantic"));
    writeFileSync(join(dir, "semantic", "semantic.yaml"), "name: hooktest\n");
    const v = call("sl-interviewer", `bun ${SL} usage add --source wh ./queries --root semantic`, dir);
    expect(v.message ?? "").toBe("");
    expect(v.allow).toBe(true);
    const b = call("sl-batch-analyst", `bun ${SL} usage show --source wh --root semantic`, dir);
    expect(b.allow).toBe(false);
    expect(b.message).toContain("may not run sl usage");
  });

  test("the usage file is written by the command alone, as a whole file under the lock", async () => {
    const { root, dir } = acme();
    const q = fixture(dir);
    // A live process that is not this one holds the lock.
    const other = Bun.spawn(["sleep", "30"]);
    try {
      mkdirSync(join(root, ".sl"), { recursive: true });
      writeFileSync(join(root, ".sl", "lock"), `${JSON.stringify({ pid: other.pid, command: "set", started: "2026-01-01T00:00:00Z" })}\n`);
      const held = await sl(root, ["usage", "add", "--source", "warehouse", q], { SL_LOCK_WAIT_MS: "50" });
      expect(held.code).toBe(1);
      expect(held.err).toContain("sl set");
      expect(existsSync(join(root, "snapshots", "warehouse.usage.json"))).toBe(false);
    } finally {
      other.kill();
    }
    rmSync(join(root, ".sl", "lock"));
    await ok(root, ["usage", "add", "--source", "warehouse", q]);
    // No temporary file is left beside it.
    expect(readdirSync(join(root, "snapshots")).sort()).toEqual(["lake.json", "warehouse.json", "warehouse.usage.json"]);
  });
});

describe("the usage file stays inside the semantic root", () => {
  test("a link in its place is refused, and the file it leads to is neither read nor written", async () => {
    const { root, dir } = acme();
    const q = fixture(dir);
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, join(root, "snapshots", "warehouse.usage.json"));
    const r = await sl(root, ["usage", "add", "--source", "warehouse", q]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("snapshots/warehouse.usage.json is a link");
    expect(readFileSync(outside, "utf8")).toBe("{}\n");
    await ok(root, ["usage", "clear", "--source", "warehouse"]);
    expect(existsSync(outside)).toBe(true);
    await ok(root, ["usage", "add", "--source", "warehouse", q]);
    expect(lstatSync(join(root, "snapshots", "warehouse.usage.json")).isFile()).toBe(true);
  });
});

describe("sl validate on the usage file", () => {
  test("a usage file that does not match its schema, or names another source, is an error", async () => {
    const { root, dir } = acme();
    await ok(root, ["usage", "add", "--source", "warehouse", fixture(dir)]);
    const p = join(root, "snapshots", "warehouse.usage.json");
    const good = readFileSync(p, "utf8");
    writeFileSync(p, good.replace('"usage_version": 1', '"usage_version": 2'));
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ issues: { file: string; path: string; level: string }[] }>().issues.filter((i) => i.file === "snapshots/warehouse.usage.json")).toEqual([
      expect.objectContaining({ level: "error", path: "usage_version" }),
    ]);
    writeFileSync(p, good.replace('"source": "warehouse"', '"source": "lake"'));
    const w = await sl(root, ["validate", "--json"]);
    expect(w.json<{ issues: { file: string; path: string }[] }>().issues.filter((i) => i.file === "snapshots/warehouse.usage.json").map((i) => i.path)).toEqual(["source"]);
    // A malformed file is refused by the readers with the file named.
    writeFileSync(p, good.replace('"tables": {', '"tables": [').replace(/\}\s*\n\}\s*$/, "]\n}\n"));
    const t = await sl(root, ["tables", "--source", "warehouse"]);
    expect(t.code).toBe(1);
    expect(t.err).toContain("snapshots/warehouse.usage.json");
  });
});

describe("performance", () => {
  test("a 20,000-statement log is read in a few seconds", async () => {
    const { root, dir } = acme();
    const rows = Array.from({ length: 20000 }, (_, i) => ({
      query:
        i % 2
          ? `select o.ship_region, sum(o.amount_cents) from acme.fct_orders o join acme.dim_customers c on c.customer_id = o.customer_id where o.status in ('completed', 'shipped') and o.order_id > ${i} group by o.ship_region`
          : `with r as (select order_id, sum(refunded_cents) as cents from acme.fct_refunds group by order_id) select date_trunc('month', o.created_at), sum(r.cents) from r join acme.fct_orders o on o.order_id = r.order_id group by 1`,
      calls: (i % 5) + 1,
      usename: `user${i % 17}`,
    }));
    writeFileSync(join(dir, "big.json"), JSON.stringify(rows));
    const start = performance.now();
    await ok(root, ["usage", "add", "--source", "warehouse", join(dir, "big.json")]);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(5000);
    expect(usageFile(root).summary.kept).toBe(20000);
  });

  test("deeply nested subqueries and CTEs are read without a crash, quickly", async () => {
    const { root, dir } = acme();
    let s = "select order_id from acme.fct_orders";
    for (let i = 0; i < 3000; i++) s = `select * from (${s}) t${i}`;
    let c = "select order_id from acme.fct_orders";
    for (let i = 0; i < 2000; i++) c = `with c${i} as (${c}) select * from c${i}`;
    writeFileSync(join(dir, "deep.sql"), `${s};\n${c};\n`);
    const start = performance.now();
    const r = await ok(root, ["usage", "add", "--source", "warehouse", join(dir, "deep.sql"), "--json"]);
    expect(r.json<{ summary: { kept: number } }>().summary.kept).toBe(2);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

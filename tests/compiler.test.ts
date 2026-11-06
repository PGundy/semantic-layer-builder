import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, warehouseTable } from "../fixtures/acme/schema.ts";
import { type Compiled, type CompileResult, compileRequest } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { compareRows } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { listGoldens, loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import { resolvedRelation } from "../skills/semantic-layer/scripts/lib/source-safety.ts";
import type { Golden, Model, QueryRequest, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DATA = join(import.meta.dir, "..", "fixtures", "acme", "data");

function compiled(r: CompileResult): Compiled {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

// Runs compiled SQL on a duckdb source with its parameters bound, as the adapter opens the source
// (views resolved from the root, session time zone UTC).
async function runDuckdb(root: string, source: SourceConfig, c: Compiled): Promise<Row[]> {
  const conn = source.connection ?? {};
  const file = conn.database && conn.database !== ":memory:" ? (isAbsolute(conn.database) ? conn.database : resolve(root, conn.database)) : ":memory:";
  const instance = await DuckDBInstance.create(file, file === ":memory:" ? {} : { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    for (const [name, rel] of Object.entries(conn.views ?? {})) await cx.run(`CREATE TEMP VIEW "${name}" AS SELECT * FROM ${resolvedRelation(root, rel)}`);
    const p = await cx.prepare(c.sql);
    if (c.params.length) p.bind(c.params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

async function duckdbQuery(file: string, text: string): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file);
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    return (await cx.runAndReadAll(text)).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// Runs compiled SQL on Postgres with its parameters bound, read-only, session time zone UTC.
async function runPg(c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const db = new SQL({ url: PG_URL!, max: 1 });
  try {
    return await db.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL TIME ZONE 'UTC'");
      const rows = (await tx.unsafe(c.sql, c.params as never[])) as Row[];
      return [...rows].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
    });
  } finally {
    await db.close();
  }
}

function sameRows(expected: Row[], actual: Row[], ordered: boolean, tolerance = 0): string[] {
  return compareRows(expected, actual, { ordered, tolerance }).diffs;
}

// --- a small synthetic shop ------------------------------------------------------------------

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };

function ordersModel(source: string): Model {
  return {
    model: "orders",
    source,
    table: "main.shop_orders",
    ...ok,
    primary_key: ["order_id"],
    grain: "One row per order.",
    dimensions: [
      { name: "status", expr: "status", type: "string", ...ok },
      { name: "region", expr: "upper(region)", type: "string", ...ok },
      { name: "is_big", expr: "amount_cents >= 5000 or status = 'vip'", type: "boolean", ...ok },
      { name: "created", expr: "created_at", type: "time", time_grains: ["hour", "day", "week", "month", "quarter", "year"], ...ok },
      { name: "placed_on", expr: "cast(created_at as date)", type: "time", time_grains: ["month"], ...ok },
      { name: "email", expr: "email", type: "string", tags: ["pii"], ...ok },
      { name: "note", expr: "note", type: "string", status: "draft" },
      { name: "customer_region", expr: "customer.region", type: "string", ...ok },
    ],
    measures: [
      { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "status <> 'cancelled'", ...ok },
      { name: "order_count", agg: "count", filter: "status <> 'cancelled'", ...ok },
      { name: "all_orders", agg: "count", ...ok },
      { name: "customers", expr: "customer_id", agg: "count_distinct", filter: "status <> 'cancelled'", ...ok },
      { name: "avg_cents", expr: "amount_cents", agg: "avg", ...ok },
      { name: "min_cents", expr: "amount_cents", agg: "min", ...ok },
      { name: "max_cents", expr: "amount_cents", agg: "max", ...ok },
      { name: "real_revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "coalesce(customer.is_test, false) = false", ...ok },
    ],
    joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", type: "left", ...ok }],
  } as Model;
}

function customersModel(source: string): Model {
  return {
    model: "customers",
    source,
    table: "main.shop_customers",
    ...ok,
    primary_key: ["customer_id"],
    grain: "One row per customer.",
    dimensions: [{ name: "region", expr: "region", type: "string", ...ok }],
    measures: [{ name: "customer_count", agg: "count", ...ok }],
  } as Model;
}

const SHOP = [
  "create table shop_orders (order_id integer, customer_id integer, status varchar, amount_cents integer, created_at timestamptz, region varchar, email varchar, note varchar)",
  `insert into shop_orders values
    (1, 10, 'completed', 1250, '2025-01-01 00:30:00+00', 'ne', 'a@x.test', null),
    (2, 10, 'completed', 5000, '2025-01-01 23:59:00+00', 'ne', 'a@x.test', 'gift'),
    (3, 11, 'cancelled', 9999, '2025-01-15 10:00:00+00', 'wc', 'b@x.test', null),
    (4, 12, 'shipped', 2500, '2025-02-03 08:00:00+00', 'wc', 'c@x.test', null),
    (5, 12, 'vip', 100, '2025-03-31 23:00:00+00', null, 'c@x.test', null),
    (6, 13, 'completed', 7300, '2025-04-01 00:00:00+00', 'se', 'd@x.test', null),
    (7, null, 'completed', 800, '2024-12-31 23:59:59+00', 'se', null, null)`,
  "create table shop_customers (customer_id integer, region varchar, is_test boolean)",
  "insert into shop_customers values (10, 'NE', false), (11, 'WC', true), (12, 'WC', false), (13, 'SE', false)",
];

async function shop(): Promise<{ root: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", SHOP);
  writeYaml(join(t.root, "sources", "pg.yaml"), { source: "pg", dialect: "postgres", connection: { env: "PG_URL" } });
  writeYaml(join(t.root, "sources", "snow.yaml"), { source: "snow", dialect: "snowflake" });
  for (const s of ["shop", "pg", "snow"]) {
    writeYaml(join(t.root, "models", s, "orders.yaml"), ordersModel(s));
    writeYaml(join(t.root, "models", s, "customers.yaml"), customersModel(s));
  }
  return { root: t.root, file: src.connection!.database! };
}

const req = (r: Partial<QueryRequest>, source = "shop"): QueryRequest => ({ source, ...r }) as QueryRequest;

describe("compiled SQL", () => {
  test("measures, filters inside aggregates, grains, request filters, order and limit, with quoted identifiers", async () => {
    const { root } = await shop();
    const request: Partial<QueryRequest> = {
      measures: ["orders.revenue", "orders.order_count", "orders.customers"],
      dimensions: ["orders.created:month", "orders.region"],
      filters: [
        { field: "orders.created", op: "gte", value: "2025-01-01" },
        { field: "orders.status", op: "in", value: ["completed", "shipped"] },
        { field: "orders.revenue", op: "gt", value: 1 },
      ],
      order_by: [{ field: "orders.created" }, { field: "orders.revenue", direction: "desc" }],
      limit: 10,
    };
    const expected = [
      "select",
      `  cast(date_trunc('month', created_at) as date) as "created_month",`,
      `  upper(region) as "region",`,
      `  sum(amount_cents * 0.01) filter (where status <> 'cancelled') as "revenue",`,
      `  count(*) filter (where status <> 'cancelled') as "order_count",`,
      `  count(distinct customer_id) filter (where status <> 'cancelled') as "customers"`,
      `from "main"."shop_orders"`,
    ].join("\n");
    const tail = [
      "where (created_at) >= $1",
      "  and (status) in ($2, $3)",
      "group by 1, 2",
      "having (sum(amount_cents * 0.01) filter (where status <> 'cancelled')) > $4",
      "order by 1 asc nulls last, 3 desc nulls last",
      "limit 10",
    ].join("\n");
    for (const source of ["shop", "pg"]) {
      const c = compiled(compileRequest(root, req(request, source)));
      expect(c.sql).toBe(`${expected}\n${tail}`);
      expect(c.params).toEqual(["2025-01-01", "completed", "shipped", 1]);
      expect(c.dialect).toBe(source === "pg" ? "postgres" : "duckdb");
      expect(c.columns.map((x) => x.name)).toEqual(["created_month", "region", "revenue", "order_count", "customers"]);
      expect(c.session_time_zone).toBe("UTC");
    }
  });

  test("the same request and layer give the same SQL text and parameters (invariant 7)", async () => {
    const { root } = await shop();
    const r = req({ measures: ["orders.revenue"], dimensions: ["orders.status"], filters: [{ field: "orders.region", op: "eq", value: "NE" }] });
    const a = compiled(compileRequest(root, r));
    const b = compiled(compileRequest(root, JSON.parse(JSON.stringify(r))));
    expect(b).toEqual(a);
    const cli1 = await sl(root, ["sql", "--request", JSON.stringify(r), "--json"]);
    const cli2 = await sl(root, ["sql", "--request", JSON.stringify(r), "--json"]);
    expect(cli1.out).toBe(cli2.out);
  });

  test("filter values are bound parameters and never enter the SQL text (invariant 4)", async () => {
    const { root, file } = await shop();
    const hostile = "x'); drop table shop_orders; --";
    const c = compiled(
compileRequest(root, req({ measures: ["orders.all_orders"], filters: [{ field: "orders.status", op: "neq", value: hostile }] })));
    expect(c.sql).not.toContain("drop");
    expect(c.sql).toContain("(status) <> $1");
    expect(c.params).toEqual([hostile]);
    const rows = await runDuckdb(root, loadSource(root, "shop"), c);
    expect(await duckdbQuery(file, "select count(*) as n from shop_orders")).toEqual([{ n: "7" }]);
    expect(sameRows([{ all_orders: 7 }], rows, true)).toEqual([]);
  });
});

describe("compiled results on duckdb equal hand-written SQL", () => {
  // Each case: a request and the SQL a person would write for it.
  const CASES: [string, Partial<QueryRequest>, string][] = [
    [
      "day grain over a timestamptz buckets in UTC",
      { measures: ["orders.all_orders"], dimensions: ["orders.created:day"], order_by: [{ field: "orders.created:day" }] },
      "select cast(date_trunc('day', created_at) as date) as created_day, count(*) as all_orders from shop_orders group by 1 order by 1",
    ],
    [
      "hour, week, quarter and year grains",
      { measures: ["orders.all_orders"], dimensions: ["orders.created:hour", "orders.created:week", "orders.created:quarter", "orders.created:year"] },
      "select date_trunc('hour', created_at) as created_hour, cast(date_trunc('week', created_at) as date) as created_week, cast(date_trunc('quarter', created_at) as date) as created_quarter, cast(date_trunc('year', created_at) as date) as created_year, count(*) as all_orders from shop_orders group by 1, 2, 3, 4",
    ],
    [
      "a grain on a date expr, and a filter on the grained value",
      { measures: ["orders.revenue"], dimensions: ["orders.placed_on:month"], filters: [{ field: "orders.placed_on:month", op: "eq", value: "2025-01-01" }] },
      "select cast(date_trunc('month', cast(created_at as date)) as date) as placed_on_month, sum(amount_cents * 0.01) filter (where status <> 'cancelled') as revenue from shop_orders where cast(date_trunc('month', cast(created_at as date)) as date) = '2025-01-01' group by 1",
    ],
    [
      "every aggregation, with and without filters",
      { measures: ["orders.revenue", "orders.order_count", "orders.all_orders", "orders.customers", "orders.avg_cents", "orders.min_cents", "orders.max_cents"] },
      "select sum(amount_cents * 0.01) filter (where status <> 'cancelled') as revenue, count(*) filter (where status <> 'cancelled') as order_count, count(*) as all_orders, count(distinct customer_id) filter (where status <> 'cancelled') as customers, avg(amount_cents) as avg_cents, min(amount_cents) as min_cents, max(amount_cents) as max_cents from shop_orders",
    ],
    [
      "neq, not_in, between, lte, is_null and not_null",
      {
        measures: ["orders.all_orders"],
        dimensions: ["orders.status"],
        filters: [
          { field: "orders.status", op: "neq", value: "vip" },
          { field: "orders.region", op: "not_in", value: ["SE"] },
          { field: "orders.created", op: "between", value: ["2025-01-01", "2025-03-01"] },
          { field: "orders.max_cents", op: "lte", value: 9999 },
          { field: "orders.region", op: "not_null" },
        ],
      },
      "select status, count(*) as all_orders from shop_orders where status <> 'vip' and upper(region) not in ('SE') and created_at between '2025-01-01' and '2025-03-01' and upper(region) is not null group by 1 having max(amount_cents) <= 9999",
    ],
    [
      "a boolean dimension whose expr has or, filtered by eq",
      { measures: ["orders.all_orders"], filters: [{ field: "orders.is_big", op: "eq", value: true }] },
      "select count(*) as all_orders from shop_orders where (amount_cents >= 5000 or status = 'vip') = true",
    ],
    [
      "nulls sort last both ways, and limit",
      { dimensions: ["orders.region"], order_by: [{ field: "orders.region", direction: "desc" }], limit: 2, filters: [{ field: "orders.region", op: "is_null" }, { field: "orders.status", op: "lt", value: "z" }] },
      "select upper(region) as region from shop_orders where region is null and status < 'z' group by 1 order by 1 desc nulls last limit 2",
    ],
    [
      "no measures: the distinct values of the dimensions",
      { dimensions: ["orders.region"], order_by: [{ field: "orders.region", direction: "desc" }] },
      "select upper(region) as region from shop_orders group by 1 order by 1 desc nulls last",
    ],
  ];
  for (const [name, request, hand] of CASES) {
    test(name, async () => {
      const { root, file } = await shop();
      const c = compiled(compileRequest(root, req(request)));
      const actual = await runDuckdb(root, loadSource(root, "shop"), c);
      const expected = await duckdbQuery(file, hand);
      expect(actual.length).toBeGreaterThan(0);
      expect(sameRows(expected, actual, (request.order_by ?? []).length > 0)).toEqual([]);
    });
  }
});

describe("layer text and filter order", () => {
  test("a -- line comment in a dimension expr, a measure expr or a measure filter ends at its own line, and the SQL runs", async () => {
    const { root, file } = await shop();
    const m = ordersModel("shop");
    m.dimensions.push({ name: "state", expr: "status -- lifecycle state", type: "string", ...ok } as never);
    m.dimensions.push({ name: "made", expr: "created_at -- when placed", type: "time", time_grains: ["month"], ...ok } as never);
    m.measures.push({ name: "kept", expr: "amount_cents -- cents", agg: "sum", filter: "status <> 'cancelled' -- not cancelled", ...ok } as never);
    writeYaml(join(root, "models", "shop", "orders.yaml"), m);
    const r = req({
      measures: ["orders.kept"],
      dimensions: ["orders.state", "orders.made:month"],
      filters: [{ field: "orders.state", op: "neq", value: "vip" }],
      order_by: [{ field: "orders.made" }, { field: "orders.state" }],
    });
    const c = compiled(compileRequest(root, r));
    expect(c.sql).toContain("  (status -- lifecycle state\n) as \"state\",");
    expect(c.sql).toContain("sum((amount_cents -- cents\n)) filter (where (status <> 'cancelled' -- not cancelled\n)) as \"kept\"");
    const hand =
      "select status as state, cast(date_trunc('month', created_at) as date) as made_month, sum(amount_cents) filter (where status <> 'cancelled') as kept " +
      "from shop_orders where status <> 'vip' group by 1, 2 order by 2, 1";
    const rows = await runDuckdb(root, loadSource(root, "shop"), c);
    expect(rows.length).toBeGreaterThan(2);
    expect(sameRows(await duckdbQuery(file, hand), rows, true)).toEqual([]);
  });

  test("parameters are numbered in the order the SQL reads them, WHERE before HAVING, whatever the filters' order", async () => {
    const { root, file } = await shop();
    const c = compiled(
      compileRequest(
        root,
        req({
          measures: ["orders.all_orders"],
          dimensions: ["orders.status"],
          filters: [
            { field: "orders.all_orders", op: "gte", value: 2 },
            { field: "orders.region", op: "in", value: ["NE", "SE"] },
          ],
        }),
      ),
    );
    expect(c.sql).toContain("where (upper(region)) in ($1, $2)\ngroup by 1\nhaving (count(*)) >= $3");
    expect(c.params).toEqual(["NE", "SE", 2]);
    const hand = "select status, count(*) as all_orders from shop_orders where upper(region) in ('NE', 'SE') group by 1 having count(*) >= 2";
    expect(sameRows(await duckdbQuery(file, hand), await runDuckdb(root, loadSource(root, "shop"), c), false)).toEqual([]);
  });

  test("a filter on a measure with no dimension is HAVING without GROUP BY", async () => {
    const { root } = await shop();
    const r = (value: number) => compiled(compileRequest(root, req({ measures: ["orders.all_orders"], filters: [{ field: "orders.all_orders", op: "gt", value }] })));
    expect(r(1).sql).not.toContain("group by");
    expect(await runDuckdb(root, loadSource(root, "shop"), r(1))).toEqual([{ all_orders: "7" }]);
    expect(await runDuckdb(root, loadSource(root, "shop"), r(9))).toEqual([]);
  });

  test("a dimension expr that converts to New York time buckets days there", async () => {
    const { root } = await shop();
    const m = ordersModel("shop");
    m.dimensions.push({ name: "created_ny", expr: "created_at at time zone 'America/New_York'", type: "time", time_grains: ["day"], ...ok } as never);
    writeYaml(join(root, "models", "shop", "orders.yaml"), m);
    const c = compiled(compileRequest(root, req({ measures: ["orders.all_orders"], dimensions: ["orders.created_ny:day"], order_by: [{ field: "orders.created_ny" }], limit: 2 })));
    // 2025-01-01 00:30 UTC is 2024-12-31 in New York, so that day holds two orders, not one.
    expect(await runDuckdb(root, loadSource(root, "shop"), c)).toEqual([
      { created_ny_day: "2024-12-31", all_orders: "2" },
      { created_ny_day: "2025-01-01", all_orders: "1" },
    ]);
  });
});

describe("refusals", () => {
  async function refusal(root: string, request: unknown, opts: Parameters<typeof compileRequest>[2] = {}) {
    const r = compileRequest(root, request, opts);
    if (r.ok) throw new Error(`compiled: ${r.sql}`);
    return r;
  }

  test("row filters are refused, naming what is missing and that a later version adds it; joins and metrics compile (tests/compiler-joins.test.ts, tests/compiler-metrics.test.ts)", async () => {
    const { root } = await shop();
    expect(compileRequest(root, req({ measures: ["orders.real_revenue"], dimensions: ["orders.customer_region", "customers.region"] })).ok).toBe(true);
    const two = await refusal(root, req({ measures: ["orders.revenue", "customers.customer_count"] }));
    expect(two.refusals.map((x) => x.code)).toEqual(["invalid_request"]);
    expect(two.reason).toContain("a request's measures must share one model, or be one metric");

    writeYaml(join(root, "metrics.yaml"), { metrics: [{ name: "avg_order", source: "shop", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", ...ok, description: "x" }] });
    expect(compileRequest(root, req({ measures: ["avg_order"] })).ok).toBe(true);

    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      user_attributes: [{ name: "region", type: "string" }],
      roles: [{ name: "rep", assign_when: "user.region is set", row_filters: [{ model: "shop.orders", expr: "upper(region) = {{ user.region }}" }] }],
    });
    const rf = await refusal(root, req({ measures: ["orders.revenue"] }), { user: { region: "NE" } });
    expect(rf.refusals).toEqual([
      { code: "unsupported_row_filter", ref: "shop.orders", message: "a row filter limits this user's rows of orders (role rep); a later version of sl sql adds row filters" },
    ]);
    // The default audience holds no role, so no row filter applies.
    expect(compileRequest(root, req({ measures: ["orders.revenue"] })).ok).toBe(true);
  });

  test("hidden, draft and unknown fields, unknown roles and a draft access.yaml are refused through checkRequest", async () => {
    const { root } = await shop();
    const hidden = await refusal(root, req({ measures: ["orders.all_orders"], dimensions: ["orders.email", "orders.note"], filters: [{ field: "orders.nope", op: "eq", value: 1 }] }));
    expect(hidden.refusals.map((x) => [x.code, x.ref])).toEqual([
      ["not_visible", "orders.email"],
      ["not_visible", "orders.note"],
      ["not_visible", "orders.nope"],
    ]);
    expect(hidden.refusals[0]!.message).toBe("dimensions[0] names orders.email, which this user may not see (protected_tag:pii)");
    expect(hidden.refusals[1]!.message).toContain("(draft)");

    writeYaml(join(root, "access.yaml"), { ...ok, mode: "open", roles: [{ name: "hr", allow: { tags: ["pii"] } }] });
    expect(compiled(compileRequest(root, req({ measures: ["orders.all_orders"], dimensions: ["orders.email"] }), { role: "hr" })).columns.map((c) => c.name)).toEqual(["email", "all_orders"]);
    const role = await refusal(root, req({ measures: ["orders.all_orders"] }), { role: "boss" });
    expect(role.refusals.map((x) => x.code)).toEqual(["unknown_role"]);

    writeYaml(join(root, "access.yaml"), { status: "draft", mode: "open" });
    const draft = await refusal(root, req({ measures: ["orders.all_orders"] }));
    expect(draft.refusals[0]!.message).toContain("access.yaml is a draft awaiting sign-off");
  });

  test("malformed requests are refused with what to fix", async () => {
    const { root } = await shop();
    const cases: [unknown, string][] = [
      [req({ measures: ["orders.revenue"], metrics: ["x"] } as never), "request.metrics is not a known property; there is no metrics key"],
      [req({ measures: ["orders.revenue"], filters: [{ field: "orders.status", op: "like", value: "a" }] } as never), "request.filters[0].op must be one of"],
      [req({ measures: ["orders.revenue"], dimensions: ["orders.placed_on:day"] }), "orders.placed_on has the grains month"],
      [req({ measures: ["orders.revenue"], dimensions: ["orders.status:month"] }), "orders.status is not a time dimension"],
      [req({ measures: ["orders.revenue"], order_by: [{ field: "orders.status" }] }), "order_by[0] names orders.status, which the request does not select"],
      [req({ measures: ["orders.revenue"], dimensions: ["orders.created:month", "orders.created:month"] }), "selects the column created_month twice"],
      [req({ measures: ["orders.status"] }), "measures[0] names orders.status, which is a dimension"],
      [req({ dimensions: ["orders.revenue"] }), "dimensions[0] names orders.revenue, which is a measure"],
      [req({ filters: [{ field: "orders.status", op: "eq", value: "a" }] }), "the request names no measure or dimension"],
      [req({ measures: ["orders.revenue"], filters: [{ field: "orders.status", op: "in", value: [null] }] }), "use is_null or not_null for null"],
      [req({ measures: ["orders.revenue"] }, "snow"), "source snow is snowflake; sl sql compiles for postgres and duckdb sources, and a later version of sl sql adds other dialects"],
    ];
    for (const [request, message] of cases) expect((await refusal(root, request)).reason).toContain(message);
    expect((await refusal(root, { measures: ["orders.revenue"], source: "pg" }, { source: "shop" })).reason).toBe("the request is on source pg, not shop");
  });

  test("a layer expr that is not read-only or holds a subquery is refused (invariant 1)", async () => {
    const { root } = await shop();
    const m = ordersModel("shop");
    m.measures.push({ name: "leak", expr: "length(pg_read_file('/etc/passwd'))", agg: "sum", ...ok } as never);
    m.measures.push({ name: "sub", expr: "(select 1)", agg: "sum", ...ok } as never);
    m.dimensions.push({ name: "blank", type: "string", ...ok } as never);
    writeYaml(join(root, "models", "shop", "orders.yaml"), m);
    const leak = await refusal(root, req({ measures: ["orders.leak"] }));
    expect(leak.refusals[0]!.code).toBe("invalid_layer");
    expect(leak.reason).toContain("the compiled SQL is not read-only");
    expect((await refusal(root, req({ measures: ["orders.sub"] }))).reason).toContain("orders.sub has an expr or filter the compiler cannot use; run sl validate");
    expect((await refusal(root, req({ dimensions: ["orders.blank"] }))).reason).toContain("orders.blank has an expr or filter the compiler cannot use");
  });
});

describe("sl sql", () => {
  test("prints the SQL and its parameters, and never runs it", async () => {
    const { root } = await shop();
    const r = await sl(root, ["sql", "--source", "shop", "--request", JSON.stringify({ measures: ["orders.revenue"], filters: [{ field: "orders.region", op: "eq", value: "NE" }] })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`sum(amount_cents * 0.01) filter (where status <> 'cancelled') as "revenue"`);
    expect(r.out).toContain('Parameters, bound in order: $1 = "NE"');
    expect(r.out).toContain("sl sql never runs it");
    expect(r.out).toContain("sl goldens check");
  });

  test("a golden file gives the request, role and user; a refusal exits 1 naming the next command", async () => {
    const goldenFile = join(ACME, "goldens", "sales_rep_101_2025.yaml");
    const r = await sl(ACME, ["sql", "--request", goldenFile]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("a row filter limits this user's rows of orders (role sales); a later version of sl sql adds row filters");
    expect(r.err).toContain("sl goldens run --name sales_rep_101_2025");
    const j = await sl(ACME, ["sql", "--request", goldenFile, "--json"]);
    const out = j.json<{ ok: boolean; refusals: { code: string }[]; next: string }>();
    expect(out.ok).toBe(false);
    expect(out.refusals.map((x) => x.code)).toEqual(["unsupported_row_filter"]);

    const hidden = await sl(ACME, ["sql", "--request", JSON.stringify({ source: "warehouse", measures: ["refunds.refund_amount"] })]);
    expect(hidden.code).toBe(1);
    expect(hidden.err).toContain("which this user may not see (model_hidden)");
    expect(hidden.err).toContain("see what this user may see with sl access --user '{}'.");
    const quote = await sl(ACME, ["sql", "--request", JSON.stringify({ source: "warehouse", measures: ["refunds.refund_amount"] }), "--user", '{"name":"O\'Brien"}']);
    expect(quote.err).toContain(`sl access --user '{"name":"O'\\''Brien"}'`);

    const spend = await sl(ACME, ["sql", "--request", join(ACME, "goldens", "spend_2025.yaml"), "--json"]);
    expect(spend.code).toBe(0);
    expect(spend.json<Compiled>().params).toEqual(["2025-01-01", "2026-01-01"]);
  });

  test("bad flags are plain errors, and a refusal without a golden names the command to run instead", async () => {
    const { root } = await shop();
    expect((await sl(root, ["sql"])).err).toContain("--request is required");
    expect((await sl(root, ["sql", "--request", "{nope"])).err).toContain("--request is not valid JSON");
    expect((await sl(root, ["sql", "--request", "missing.yaml"])).err).toContain("no file missing.yaml");
    expect((await sl(root, ["sql", "--request", '{"source":"shop","measures":["orders.revenue"]}', "--user", "[1]"])).err).toContain("--user must be a JSON object");
    const snow = await sl(root, ["sql", "--request", '{"source":"snow","measures":["orders.revenue"]}']);
    expect(snow.err).toContain("and a later version of sl sql adds other dialects");
    expect(snow.err).toContain("Until a later version compiles it, hand-written SQL computes this figure: write it from the model YAML and run it with your own tool.");
    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      user_attributes: [{ name: "region", type: "string" }],
      roles: [{ name: "rep", assign_when: "user.region is set", row_filters: [{ model: "shop.orders", expr: "upper(region) = {{ user.region }}" }] }],
    });
    const joined = await sl(root, ["sql", "--request", '{"source":"shop","measures":["orders.revenue"]}', "--user", '{"region":"NE"}']);
    expect(joined.err).toContain("write it from the model YAML and run it with sl run --source shop --file <query.sql>.");
  });
});

// --- Acme ----------------------------------------------------------------------------------

const UNSUPPORTED = new Set(["unsupported_metric", "unsupported_row_filter"]);
const asUser = (g: Golden) => ({ ...(g.role ? { role: g.role } : {}), user: g.user ?? {} });

describe("Acme's approved goldens", () => {
  test("every one with no row filter compiles, the lake's to its recorded rows; the rest are refused for what a later version adds", async () => {
    const compiledNames: string[] = [];
    for (const { golden: g } of listGoldens(ACME)) {
      if (g.status !== "approved") continue;
      const r = compileRequest(ACME, g.request, asUser(g));
      if (!r.ok) {
        expect(r.refusals.length).toBeGreaterThan(0);
        for (const x of r.refusals) expect(UNSUPPORTED.has(x.code)).toBe(true);
        continue;
      }
      compiledNames.push(g.name);
      if (loadSource(ACME, g.request.source).dialect !== "duckdb") continue; // the warehouse runs in tests/compiler-joins.test.ts
      const rows = await runDuckdb(ACME, loadSource(ACME, g.request.source), r);
      expect(sameRows(g.expected!.rows, rows, (g.request.order_by ?? []).length > 0, g.expected!.tolerance ?? 0)).toEqual([]);
    }
    expect(compiledNames.sort()).toEqual([
      "analyst_rep_101_by_name_2025",
      "discount_2025",
      "finance_net_revenue_2025",
      "net_revenue_2025",
      "order_count_by_region_2025",
      "refunds_2025",
      "revenue_2025",
      "revenue_by_region_2025",
      "sessions_2025",
      "spend_2025",
      "spend_by_channel_2025",
    ]);
  });
});

// The Acme warehouse with each definition join written out without one, so a request on orders
// alone reaches its recorded figures: the test-account rule as a list of the test customers' ids,
// and the region name as a case over the regions. A later version compiles the joins themselves.
async function standInOrders(root: string, dialect: "duckdb" | "postgres", schema: string, testIds: number[], regions: Row[]): Promise<void> {
  const path = join(root, "models", "warehouse", "orders.yaml");
  const m = readYaml<Model>(path);
  m.table = `${schema}.fct_orders`;
  const rule = "coalesce(test_account.is_test_account, false) = false and coalesce(test_account.email, '') not like '%@example-test.com'";
  for (const x of m.measures) {
    if (x.filter) {
      expect(x.filter).toContain(rule);
      x.filter = x.filter.replace(rule, `customer_id not in (${testIds.join(", ")})`);
    }
    if (dialect === "duckdb" && x.expr) x.expr = x.expr.replace(" / 100.0", " * 0.01");
  }
  const name = m.dimensions.find((d) => d.name === "ship_region_name")!;
  name.expr = `case ship_region ${regions.map((r) => `when '${r.region_code}' then '${r.region_name}'`).join(" ")} end`;
  writeYaml(path, m);
}

const golden = (name: string) => readYaml<Golden>(join(ACME, "goldens", `${name}.yaml`));

function withCancelled(root: string): void {
  const path = join(root, "models", "warehouse", "orders.yaml");
  const m = readYaml<Model>(path);
  const revenue = m.measures.find((x) => x.name === "revenue")!;
  expect(revenue.filter).toContain("status in ('completed', 'shipped')");
  revenue.filter = revenue.filter!.replace("status in ('completed', 'shipped')", "status in ('completed', 'shipped', 'cancelled')");
  writeYaml(path, m);
}

async function acmeCopy(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  cpSync(ACME, t.root, { recursive: true });
  return t;
}

async function acmeFacts(): Promise<{ testIds: number[]; regions: Row[] }> {
  const csv = (t: string) => readCsvSql(join(DATA, "warehouse", `${t}.csv`), warehouseTable(t));
  const ids = await duckdbQuery(":memory:", `select customer_id from ${csv("dim_customers")} where is_test_account or email like '%@example-test.com' order by 1`);
  const regions = await duckdbQuery(":memory:", `select region_code, region_name from ${csv("dim_regions")} order by 1`);
  return { testIds: ids.map((r) => Number(r.customer_id)), regions };
}

describe("Acme's warehouse goldens on duckdb, with definition joins written out", () => {
  test("revenue and order count by region compile to the recorded rows, and revenue counting cancelled orders does not", async () => {
    const { root, dir } = await acmeCopy();
    const { testIds, regions } = await acmeFacts();
    expect(testIds.length).toBe(20);
    const orders = readCsvSql(join(DATA, "warehouse", "fct_orders.csv"), warehouseTable("fct_orders"));
    const source = await duckdbSource(root, dir, "warehouse", ["create schema acme", `create table acme.fct_orders as select * from ${orders}`]);
    await standInOrders(root, "duckdb", "acme", testIds, regions);
    for (const name of ["revenue_by_region_2025", "order_count_by_region_2025"]) {
      const g = golden(name);
      const c = compiled(compileRequest(root, g.request, asUser(g)));
      expect(sameRows(g.expected!.rows, await runDuckdb(root, source, c), true)).toEqual([]);
    }
    withCancelled(root);
    const g = golden("revenue_by_region_2025");
    const c = compiled(compileRequest(root, g.request, asUser(g)));
    expect(c.sql).toContain("'cancelled'");
    const diffs = sameRows(g.expected!.rows, await runDuckdb(root, source, c), true);
    expect(diffs.length).toBe(6);
    expect(diffs[0]).toMatch(/^Row 1, column revenue: expected 18016\.52, got /);
  });
});

describe("Acme's warehouse goldens on postgres, with definition joins written out", () => {
  test.skipIf(!PG_URL)(
    "revenue, order count by region and discount compile to the recorded rows; grains match hand-written SQL; cancelled orders change revenue",
    async () => {
      assertLocalPg(PG_URL);
      const schema = uniqueSchema("sl_compiler");
      const db = new SQL({ url: PG_URL!, max: 1 });
      try {
        await loadPostgres(PG_URL!, DATA, schema);
        await db.unsafe(readFileSync(join(DATA, "..", "evolve.sql"), "utf8").replace(/(?<!@)\bacme\./g, `${schema}.`));
        const { root } = await acmeCopy();
        writeFileSync(join(root, "sources", "warehouse.yaml"), "source: warehouse\ndialect: postgres\nconnection:\n  env: PG_URL\n");
        const { testIds, regions } = await acmeFacts();
        await standInOrders(root, "postgres", schema, testIds, regions);
        for (const name of ["revenue_by_region_2025", "order_count_by_region_2025", "discount_2025"]) {
          const g = golden(name);
          const c = compiled(compileRequest(root, g.request, asUser(g)));
          expect(c.dialect).toBe("postgres");
          expect(sameRows(g.expected!.rows, await runPg(c), (g.request.order_by ?? []).length > 0)).toEqual([]);
        }
        const monthly = compiled(
          compileRequest(root, {
            source: "warehouse",
            measures: ["orders.revenue"],
            dimensions: ["orders.order_date:month", "orders.order_date:week"],
            filters: [{ field: "orders.order_date:year", op: "eq", value: "2025-01-01" }],
            order_by: [{ field: "orders.order_date:week" }],
          }),
        );
        const hand = await runPg({
          sql: `select cast(date_trunc('month', created_at) as date) as order_date_month, cast(date_trunc('week', created_at) as date) as order_date_week,
                  sum(amount_cents / 100.0) filter (where status in ('completed', 'shipped') and customer_id not in (${testIds.join(", ")})) as revenue
                from ${schema}.fct_orders where created_at >= '2025-01-01' and created_at < '2026-01-01' group by 1, 2 order by 2`,
          params: [],
        });
        expect(hand.length).toBeGreaterThan(52);
        expect(sameRows(hand, await runPg(monthly), true)).toEqual([]);

        // A dimension expr that converts to New York time buckets days there, on postgres too.
        const path = join(root, "models", "warehouse", "orders.yaml");
        const m = readYaml<Model>(path);
        m.dimensions.push({ ...m.dimensions[0]!, name: "order_date_ny", expr: "created_at at time zone 'America/New_York'", time_grains: ["day"] });
        writeYaml(path, m);
        const ny = compiled(compileRequest(root, { source: "warehouse", measures: ["orders.order_count"], dimensions: ["orders.order_date_ny:day"], order_by: [{ field: "orders.order_date_ny" }] }));
        const nyHand = await runPg({
          sql: `select cast(created_at at time zone 'America/New_York' as date) as order_date_ny_day,
                  count(*) filter (where status in ('completed', 'shipped') and customer_id not in (${testIds.join(", ")})) as order_count
                from ${schema}.fct_orders group by 1 order by 1`,
          params: [],
        });
        expect(sameRows(nyHand, await runPg(ny), true)).toEqual([]);
        const utc = await runPg({
          sql: `select cast(created_at at time zone 'UTC' as date) as order_date_ny_day,
                  count(*) filter (where status in ('completed', 'shipped') and customer_id not in (${testIds.join(", ")})) as order_count
                from ${schema}.fct_orders group by 1 order by 1`,
          params: [],
        });
        expect(sameRows(utc, nyHand, true).length).toBeGreaterThan(0);

        withCancelled(root);
        const g = golden("revenue_by_region_2025");
        expect(sameRows(g.expected!.rows, await runPg(compiled(compileRequest(root, g.request, asUser(g)))), true).length).toBe(6);
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await db.close();
      }
    },
    120_000,
  );
});

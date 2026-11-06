import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { parseFormula } from "../skills/semantic-layer/scripts/lib/compiler/metrics.ts";
import type { Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function compiled(r: CompileResult): Compiled {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
function refused(r: CompileResult): Refused {
  if (r.ok) throw new Error(`compiled: ${r.sql}`);
  return r;
}

async function runDuckdb(file: string, c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    const p = await cx.prepare(c.sql);
    if (c.params.length) p.bind(c.params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

async function runPg(c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const db = new SQL({ url: PG_URL!, max: 1 });
  try {
    return await db.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL TIME ZONE 'UTC'");
      return [...((await tx.unsafe(c.sql, c.params as never[])) as Row[])];
    });
  } finally {
    await db.close();
  }
}

// Rows with every number as a JS number, so both dialects' results compare.
const plain = (rows: Row[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));

// --- a synthetic shop: orders, their refunds, and web visits by region ----------------------

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const time = { type: "time", time_grains: ["day", "month", "year"], ...ok };

function shopModels(schema: string): Model[] {
  return [
    {
      model: "orders",
      source: "shop",
      table: `${schema}.shop_orders`,
      ...ok,
      primary_key: ["order_id"],
      grain: "One row per order.",
      dimensions: [
        { name: "region", expr: "region", type: "string", ...ok },
        { name: "status", expr: "status", type: "string", ...ok },
        { name: "created", expr: "created_at", ...time },
      ],
      measures: [
        { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "status <> 'cancelled'", ...ok },
        { name: "order_count", agg: "count", filter: "status <> 'cancelled'", ...ok },
      ],
    },
    {
      model: "refunds",
      source: "shop",
      table: `${schema}.shop_refunds`,
      ...ok,
      primary_key: ["refund_id"],
      grain: "One row per refund.",
      dimensions: [
        { name: "region", expr: "order.region", type: "string", ...ok },
        { name: "created", expr: "order.created_at", ...time },
      ],
      measures: [
        { name: "refund_amount", expr: "refunded_cents * 0.01", agg: "sum", ...ok },
        { name: "refund_count", agg: "count", ...ok },
      ],
      joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "order_id" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    {
      model: "visits",
      source: "shop",
      table: `${schema}.shop_visits`,
      ...ok,
      primary_key: ["visit_id"],
      grain: "One row per visit.",
      dimensions: [{ name: "region", expr: "region", type: "string", ...ok }],
      measures: [{ name: "visit_count", agg: "count", ...ok }],
    },
  ] as Model[];
}

const METRICS = [
  { name: "refund_rate", source: "shop", type: "ratio", numerator: "refunds.refund_count", denominator: "orders.order_count", ...ok, description: "Refunds per order." },
  { name: "conversion", source: "shop", type: "ratio", numerator: "orders.order_count", denominator: "visits.visit_count", ...ok, description: "Orders per visit." },
  { name: "avg_order", source: "shop", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", ...ok, description: "Revenue per order." },
  { name: "net_revenue", source: "shop", type: "derived", expr: "{orders.revenue} - {refunds.refund_amount}", ...ok, description: "Revenue after refunds." },
  { name: "net_per_visit", source: "shop", type: "derived", expr: "({orders.revenue} - {refunds.refund_amount}) / {visits.visit_count}", ...ok, description: "Net revenue per visit." },
];

const tables = (schema: string, ts: string) => [
  `create table ${schema}.shop_orders (order_id integer, region varchar, status varchar, amount_cents integer, created_at ${ts})`,
  `insert into ${schema}.shop_orders values
    (1, 'ne', 'completed', 1000, '2025-01-05 10:00:00+00'),
    (2, 'ne', 'completed', 3000, '2025-02-10 10:00:00+00'),
    (3, 'wc', 'shipped', 2000, '2025-01-20 10:00:00+00'),
    (4, 'se', 'cancelled', 5000, '2025-03-01 10:00:00+00'),
    (5, null, 'completed', 700, '2025-03-15 10:00:00+00'),
    (6, 'wc', 'completed', 1500, '2024-12-30 10:00:00+00')`,
  `create table ${schema}.shop_refunds (refund_id integer, order_id integer, refunded_cents integer)`,
  `insert into ${schema}.shop_refunds values (1, 1, 200), (2, 1, 300), (3, 4, 5000), (4, 3, 100)`,
  `create table ${schema}.shop_visits (visit_id integer, region varchar)`,
  `insert into ${schema}.shop_visits values (1, 'ne'), (2, 'ne'), (3, 'ne'), (4, 'ne'), (5, 'wc'), (6, 'wc'), (7, 'mw'), (8, 'mw'), (9, 'mw'), (10, null)`,
];

function writeLayer(root: string, schema: string): void {
  for (const m of shopModels(schema)) writeYaml(join(root, "models", "shop", `${m.model}.yaml`), m);
  writeYaml(join(root, "metrics.yaml"), { metrics: METRICS });
}

async function shop(): Promise<{ root: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", tables("main", "timestamptz"));
  writeLayer(t.root, "main");
  return { root: t.root, file: src.connection!.database! };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const byRegion = (measures: string[], extra: Partial<QueryRequest> = {}) =>
  req({ measures, dimensions: ["orders.region"], order_by: [{ field: "orders.region" }], ...extra });

// The figures by region, worked out from the rows above. se's orders are all cancelled, so its
// order count is 0; mw has visits and no orders; the null region has an order and a visit but no refund.
const EXPECTED: Record<string, Row[]> = {
  refund_rate: [
    { region: "ne", refund_rate: 1 },
    { region: "se", refund_rate: null },
    { region: "wc", refund_rate: 0.5 },
    { region: null, refund_rate: 0 },
  ],
  conversion: [
    { region: "mw", conversion: 0 },
    { region: "ne", conversion: 0.5 },
    { region: "se", conversion: null },
    { region: "wc", conversion: 1 },
    { region: null, conversion: 1 },
  ],
  net_revenue: [
    { region: "ne", net_revenue: 35 },
    { region: "se", net_revenue: -50 },
    { region: "wc", net_revenue: 34 },
    { region: null, net_revenue: 7 },
  ],
  net_per_visit: [
    { region: "mw", net_per_visit: 0 },
    { region: "ne", net_per_visit: 8.75 },
    { region: "se", net_per_visit: null },
    { region: "wc", net_per_visit: 17 },
    { region: null, net_per_visit: 7 },
  ],
};

describe("compiled metrics", () => {
  test("a cross-model ratio grouped by a shared dimension: each model aggregated in its own CTE, combined on the groups", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, byRegion(["refund_rate"])));
    expect(c.sql).toBe(
      [
        `with "refunds measures" as (`,
        "select",
        '  "refunds.order".region as "region",',
        '  count(*) as "refund_count"',
        'from "main"."shop_refunds" as "refunds"',
        'left join "main"."shop_orders" as "refunds.order" on "refunds"."order_id" = "refunds.order"."order_id"',
        "group by 1",
        "),",
        `"orders measures" as (`,
        "select",
        "  region as \"region\",",
        "  count(*) filter (where status <> 'cancelled') as \"order_count\"",
        'from "main"."shop_orders"',
        "group by 1",
        "),",
        `"request groups" as (`,
        'select "region" from "refunds measures"',
        "union",
        'select "region" from "orders measures"',
        ")",
        "select",
        '  "request groups"."region" as "region",',
        '  coalesce("refunds measures"."refund_count", 0) / nullif("orders measures"."order_count", 0) as "refund_rate"',
        'from "request groups"',
        'left join "refunds measures" on "refunds measures"."region" is not distinct from "request groups"."region"',
        'left join "orders measures" on "orders measures"."region" is not distinct from "request groups"."region"',
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(c.model).toBe("refunds");
    expect(c.columns).toEqual([
      { name: "region", ref: "orders.region", kind: "dimension" },
      { name: "refund_rate", ref: "refund_rate", kind: "metric" },
    ]);
    expect(c.joins).toEqual([{ alias: "refunds.order", via: "refunds.order", model: "orders", type: "left", for: "request" }]);
    expect(plain(await runDuckdb(file, c))).toEqual(EXPECTED.refund_rate!);
  });

  test("a zero denominator gives null, and a total a group has no rows for counts as 0", async () => {
    const { root, file } = await shop();
    const rows = plain(await runDuckdb(file, compiled(compileRequest(root, byRegion(["conversion"])))));
    expect(rows).toEqual(EXPECTED.conversion!);
    // A ratio on one model: se has revenue over no counted order.
    const aov = compiled(compileRequest(root, byRegion(["orders.revenue", "orders.order_count", "avg_order"])));
    expect(aov.sql).not.toContain("request groups");
    expect(plain(await runDuckdb(file, aov))).toEqual([
      { region: "ne", revenue: 40, order_count: 2, avg_order: 20 },
      { region: "se", revenue: null, order_count: 0, avg_order: null },
      { region: "wc", revenue: 35, order_count: 2, avg_order: 17.5 },
      { region: null, revenue: 7, order_count: 1, avg_order: 7 },
    ]);
  });

  test("derived metrics over two and three models, a division in one of them guarded against zero", async () => {
    const { root, file } = await shop();
    const net = compiled(compileRequest(root, byRegion(["net_revenue"])));
    expect(net.sql).toContain(`coalesce("orders measures"."revenue", 0) - coalesce("refunds measures"."refund_amount", 0) as "net_revenue"`);
    expect(plain(await runDuckdb(file, net))).toEqual(EXPECTED.net_revenue!);
    const per = compiled(compileRequest(root, byRegion(["net_per_visit"])));
    expect(per.sql).toContain(
      `(coalesce("orders measures"."revenue", 0) - coalesce("refunds measures"."refund_amount", 0)) / nullif("visits measures"."visit_count", 0) as "net_per_visit"`,
    );
    expect(per.sql).toContain(`select "region" from "orders measures"\nunion\nselect "region" from "refunds measures"\nunion\nselect "region" from "visits measures"`);
    expect(plain(await runDuckdb(file, per))).toEqual(EXPECTED.net_per_visit!);
    // With no dimensions each part is one row.
    const total = compiled(compileRequest(root, req({ measures: ["net_revenue"] })));
    expect(total.sql).toContain(`from "orders measures"\ncross join "refunds measures"`);
    expect(plain(await runDuckdb(file, total))).toEqual([{ net_revenue: 26 }]);
  });

  test("dimension filters apply inside every part, metric and measure filters in the outer WHERE; parameters in reading order, then order and limit", async () => {
    const { root, file } = await shop();
    const r = req({
      measures: ["net_revenue"],
      dimensions: ["orders.created:month"],
      filters: [
        { field: "net_revenue", op: "gt", value: 0 },
        { field: "orders.created", op: "gte", value: "2025-01-01" },
        { field: "orders.revenue", op: "lt", value: 1000 },
        { field: "orders.region", op: "in", value: ["ne", "wc", "se"] },
      ],
      order_by: [{ field: "net_revenue", direction: "desc" }],
      limit: 2,
    });
    const c = compiled(compileRequest(root, r));
    expect(c.params).toEqual(["2025-01-01", "ne", "wc", "se", "2025-01-01", "ne", "wc", "se", 0, 1000]);
    expect(c.sql).toContain(`where ("refunds.order".created_at) >= $5\n  and ("refunds.order".region) in ($6, $7, $8)\ngroup by 1`);
    expect(c.sql).toContain(
      `where (coalesce("orders measures"."revenue", 0) - coalesce("refunds measures"."refund_amount", 0)) > $9\n  and ("orders measures"."revenue") < $10\norder by 2 desc nulls last\nlimit 2`,
    );
    expect(c.sql.match(/\$\d+/g)).toEqual(["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "$10"]);
    // Jan 2025: ne 10.00 - 5.00 and wc 20.00 - 1.00; Feb: ne 30.00; Mar: se -50.00 is left out by net_revenue > 0.
    expect(plain(await runDuckdb(file, c))).toEqual([
      { created_month: "2025-02-01", net_revenue: 30 },
      { created_month: "2025-01-01", net_revenue: 24 },
    ]);
  });

  test("the same request and layer give the same SQL text, parameters and joins (invariant 7); values never enter the SQL (invariant 4)", async () => {
    const { root } = await shop();
    const r = byRegion(["net_per_visit"], { filters: [{ field: "orders.region", op: "eq", value: "x'; drop table shop_orders; --" }] });
    const a = compiled(compileRequest(root, r));
    const b = compiled(compileRequest(root, structuredClone(r)));
    expect(b.sql).toBe(a.sql);
    expect(b.params).toEqual(a.params);
    expect(b.joins).toEqual(a.joins);
    expect(a.sql).not.toContain("drop table");
    expect(a.params).toEqual(["x'; drop table shop_orders; --", "x'; drop table shop_orders; --", "x'; drop table shop_orders; --"]);
  });

  test("the formula reader keeps precedence and parentheses, and refuses anything but placeholders, numbers and + - * /", () => {
    expect(parseFormula("{a.x} - {b.y} * 2")).toEqual({
      k: "bin",
      op: "-",
      a: { k: "ref", model: "a", measure: "x" },
      b: { k: "bin", op: "*", a: { k: "ref", model: "b", measure: "y" }, b: { k: "num", v: "2" } },
    });
    expect(parseFormula("-({a.x} + 1) / { b.y }")).toBeDefined();
    for (const bad of ["{a.x} +", "({a.x}", "{a.x} % 2", "sqrt({a.x})", "{a.x}; select 1", "{a}"]) expect(parseFormula(bad)).toBeUndefined();
  });
});

describe("metric refusals", () => {
  test("a dimension a part's model neither reaches nor has is refused, naming the dimension, the model and the next step", async () => {
    const { root } = await shop();
    // refunds reaches orders through its join, so it groups by the order's status.
    expect(compileRequest(root, req({ measures: ["refund_rate"], dimensions: ["orders.status"] })).ok).toBe(true);
    const r = refused(compileRequest(root, req({ measures: ["conversion"], dimensions: ["orders.status"] })));
    expect(r.refusals).toEqual([
      {
        code: "no_shared_dimension",
        ref: "orders.status",
        message:
          "the request groups by orders.status, but its measures come from orders and visits, each aggregated on its own model, so each of them needs to reach orders through one path of to-one joins or have a dimension named status; visits has neither",
        next: "Add a many_to_one join from visits toward orders (sl check-join measures it), or a dimension status to visits that gives the same value, approve it after its readback, and run sl sql again; or leave orders.status out of the request.",
      },
    ]);
    const f = refused(compileRequest(root, req({ measures: ["conversion"], filters: [{ field: "orders.created", op: "gte", value: "2025-01-01" }] })));
    expect(f.refusals.map((x) => [x.code, x.message])).toEqual([
      [
        "no_shared_dimension",
        "a filter of the request is on orders.created, but its measures come from orders and visits, each aggregated on its own model, so each of them needs to reach orders through one path of to-one joins or have a dimension named created; visits has neither",
      ],
    ]);
    const cli = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["conversion"], dimensions: ["orders.status"] }))]);
    expect(cli.code).toBe(1);
    expect(cli.err).toContain("Add a many_to_one join from visits toward orders");
  });

  test("measures of two models that are not one metric, a metric under dimensions and a filter on another model's measure are refused", async () => {
    const { root } = await shop();
    const two = refused(compileRequest(root, req({ measures: ["net_revenue", "orders.revenue"] })));
    expect(two.refusals.map((x) => x.code)).toEqual(["invalid_request"]);
    expect(two.reason).toContain("a request's measures must share one model, or be one metric");
    expect(compileRequest(root, req({ measures: ["orders.revenue", "avg_order"] })).ok).toBe(true);
    const dim = refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["avg_order"] })));
    expect(dim.reason).toContain("dimensions[0] names avg_order, which is a metric; list it under measures");
    const other = refused(compileRequest(root, req({ measures: ["avg_order"], filters: [{ field: "visits.visit_count", op: "gt", value: 1 }] })));
    expect(other.reason).toContain("filters[0] names visits.visit_count, a measure of model visits; a request filters only on measures of the models its measures and metrics use");
    const order = refused(compileRequest(root, req({ measures: ["avg_order"], order_by: [{ field: "net_revenue" }] })));
    expect(order.reason).toContain("order_by[0] names net_revenue, which the request does not select");
  });

  test("a metric type sl sql does not compile is refused by name, a metric that reads a missing measure as hidden, and an unreadable expr as a layer error", async () => {
    const { root } = await shop();
    writeYaml(join(root, "metrics.yaml"), {
      metrics: [
        { name: "running", source: "shop", type: "cumulative", expr: "{orders.revenue}", ...ok, description: "x" },
        { name: "ghost", source: "shop", type: "ratio", numerator: "orders.nothing", denominator: "orders.order_count", ...ok, description: "x" },
        { name: "odd", source: "shop", type: "derived", expr: "{orders.revenue} % 2", ...ok, description: "x" },
      ],
    });
    expect(refused(compileRequest(root, req({ measures: ["running"] }))).refusals).toEqual([
      { code: "unsupported_metric", ref: "running", message: "metric running is of type cumulative, and sl sql compiles ratio and derived metrics only; run sl validate" },
    ]);
    const ghost = refused(compileRequest(root, req({ measures: ["ghost"] })));
    // checkRequest hides a metric whose measure does not exist, before the compiler reads it.
    expect(ghost.refusals.map((x) => x.code)).toEqual(["not_visible"]);
    expect(ghost.reason).toContain("measures[0] names ghost, which this user may not see");
    expect(refused(compileRequest(root, req({ measures: ["odd"] }))).reason).toContain("metric odd has an expr sl sql cannot read");
  });

  test("a draft metric, and a row filter on any model a metric reads, are refused", async () => {
    const { root } = await shop();
    writeYaml(join(root, "metrics.yaml"), { metrics: [{ ...METRICS[0], status: "draft" }] });
    expect(refused(compileRequest(root, req({ measures: ["refund_rate"] }))).refusals.map((x) => x.code)).toEqual(["not_visible"]);
    writeYaml(join(root, "metrics.yaml"), { metrics: METRICS });
    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      user_attributes: [{ name: "region", type: "string" }],
      roles: [{ name: "rep", assign_when: "user.region is set", row_filters: [{ model: "shop.visits", expr: "region = {{ user.region }}" }] }],
    });
    const rf = refused(compileRequest(root, byRegion(["conversion"]), { user: { region: "ne" } }));
    expect(rf.refusals).toEqual([
      {
        code: "unsupported_row_filter",
        ref: "shop.visits",
        message: "for the measures of visits: a row filter limits this user's rows of visits (role rep); a later version of sl sql adds row filters",
      },
    ]);
    expect(compileRequest(root, byRegion(["conversion"])).ok).toBe(true);
  });
});

// A shop where orders carry a ship-to region and customers a home region that differs from it; orders
// reach customers through a join, refunds through their order.
const REACH_MODELS = [
  {
    model: "orders",
    table: "main.o",
    primary_key: ["order_id"],
    grain: "One row per order.",
    dimensions: [{ name: "region", expr: "ship_region", type: "string", ...ok }],
    measures: [{ name: "revenue", expr: "amount", agg: "sum", ...ok }],
    joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", type: "left", ...ok }],
  },
  { model: "customers", table: "main.c", primary_key: ["customer_id"], grain: "One row per customer.", dimensions: [{ name: "region", expr: "home_region", type: "string", ...ok }] },
  {
    model: "refunds",
    table: "main.r",
    primary_key: ["refund_id"],
    grain: "One row per refund.",
    dimensions: [{ name: "region", expr: "order.ship_region", type: "string", ...ok }],
    measures: [{ name: "refund_amount", expr: "amount", agg: "sum", ...ok }],
    joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "order_id" }], relationship: "many_to_one", type: "left", ...ok }],
  },
];

async function reachShop(): Promise<{ root: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", [
    "create table c (customer_id integer, home_region varchar)",
    "insert into c values (1, 'north'), (2, 'south')",
    "create table o (order_id integer, customer_id integer, ship_region varchar, amount integer)",
    // customer 1 (north) ships to east and west; customer 2 (south) ships to east.
    "insert into o values (1, 1, 'east', 100), (2, 1, 'west', 50), (3, 2, 'east', 30)",
    "create table r (refund_id integer, order_id integer, amount integer)",
    "insert into r values (1, 1, 10), (2, 3, 5)",
  ]);
  for (const m of REACH_MODELS) writeYaml(join(t.root, "models", "shop", `${m.model}.yaml`), { source: "shop", ...ok, ...m });
  writeYaml(join(t.root, "metrics.yaml"), {
    metrics: [
      { name: "net_revenue", source: "shop", type: "derived", expr: "{orders.revenue} - {refunds.refund_amount}", ...ok, description: "x" },
      { name: "net_neg", source: "shop", type: "derived", expr: "{orders.revenue}--{refunds.refund_amount}", ...ok, description: "x" },
    ],
  });
  return { root: t.root, file: src.connection!.database! };
}

describe("parts that reach the dimension's model", () => {
  test("group by the requested dimension through their to-one paths, not by a same-named dimension of their own", async () => {
    const { root, file } = await reachShop();
    const c = compiled(compileRequest(root, req({ measures: ["net_revenue"], dimensions: ["customers.region"], order_by: [{ field: "customers.region" }] })));
    expect(c.sql).toContain(`"orders.customer".home_region as "region"`);
    expect(c.sql).toContain(`"refunds.order.customer".home_region as "region"`);
    expect(c.columns[0]).toEqual({ name: "region", ref: "customers.region", kind: "dimension" });
    // north: 150 - 10; south: 30 - 5. Grouping by the ship-to region would give east 115, west 50.
    expect(plain(await runDuckdb(file, c))).toEqual([
      { region: "north", net_revenue: 140 },
      { region: "south", net_revenue: 25 },
    ]);
  });

  test("a doubled minus never becomes a SQL comment, and a metric filter with a measure selected filters outside", async () => {
    const { root, file } = await reachShop();
    const neg = compiled(compileRequest(root, req({ measures: ["net_neg"] })));
    expect(neg.sql).not.toContain("--");
    expect(plain(await runDuckdb(file, neg))).toEqual([{ net_neg: 195 }]);
    const c = compiled(
      compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["orders.region"], filters: [{ field: "net_revenue", op: "gt", value: 60 }], order_by: [{ field: "orders.region" }] })),
    );
    expect(c.params).toEqual([60]);
    expect(plain(await runDuckdb(file, c))).toEqual([{ region: "east", revenue: 130 }]);
  });
});

describe("compiled metrics on postgres", () => {
  test.skipIf(!PG_URL)(
    "give the rows duckdb gives, and a ratio of two counts divides as a fraction",
    async () => {
      assertLocalPg(PG_URL);
      const schema = uniqueSchema("sl_metrics");
      const db = new SQL({ url: PG_URL!, max: 1 });
      try {
        await db.unsafe(`create schema ${schema}`);
        for (const s of tables(schema, "timestamptz")) await db.unsafe(s);
        const t = tempRoot();
        cleanup = t.cleanup;
        await initProject(t.root);
        writeFileSync(join(t.root, "sources", "shop.yaml"), "source: shop\ndialect: postgres\nconnection:\n  env: PG_URL\n");
        writeLayer(t.root, schema);
        const conversion = compiled(compileRequest(t.root, byRegion(["conversion"])));
        expect(conversion.sql).toContain(`cast(coalesce("orders measures"."order_count", 0) as numeric) / nullif("visits measures"."visit_count", 0)`);
        for (const name of Object.keys(EXPECTED)) expect(plain(await runPg(compiled(compileRequest(t.root, byRegion([name])))))).toEqual(EXPECTED[name]!);
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await db.close();
      }
    },
    60_000,
  );
});

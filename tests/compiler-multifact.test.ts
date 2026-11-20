// Multi-fact requests (spec: Bridges and multi-fact requests): plain measures of several models compile
// to one CTE per model, each grouped by the request's dimensions, combined on those dimensions, so a
// group only one model has still appears and neither model's total is multiplied by the other's rows.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { goldenDraftFields } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import type { Golden, Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

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

// Rows with every number as a JS number and every date as YYYY-MM-DD, so both dialects' results compare.
const plain = (rows: Row[]) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v,
      ]),
    ),
  );

// --- a synthetic shop: orders and refunds, each with its own date, and the customers both reach ------

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const time = { type: "time", time_grains: ["day", "month", "year"], ...ok };

function shopModels(schema: string): Model[] {
  return [
    {
      model: "orders",
      source: "shop",
      table: `${schema}.mf_orders`,
      ...ok,
      primary_key: ["order_id"],
      grain: "One row per order.",
      dimensions: [
        { name: "status", expr: "status", type: "string", ...ok },
        { name: "created", expr: "created_at", ...time },
      ],
      measures: [
        { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "status <> 'cancelled'", ...ok },
        { name: "order_count", agg: "count", filter: "status <> 'cancelled'", ...ok },
      ],
      joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    {
      // A refund is dated by when it was issued, and declares no join to its order: by month it groups
      // by its own created dimension, the dimension of the same name.
      model: "refunds",
      source: "shop",
      table: `${schema}.mf_refunds`,
      ...ok,
      primary_key: ["refund_id"],
      grain: "One row per refund.",
      dimensions: [{ name: "created", expr: "refunded_at", ...time }],
      measures: [
        { name: "refund_amount", expr: "refunded_cents * 0.01", agg: "sum", ...ok },
        { name: "refund_count", agg: "count", ...ok },
      ],
      joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    {
      model: "customers",
      source: "shop",
      table: `${schema}.mf_customers`,
      ...ok,
      primary_key: ["customer_id"],
      grain: "One row per customer.",
      dimensions: [{ name: "segment", expr: "segment", type: "string", ...ok }],
      measures: [{ name: "customer_count", agg: "count", ...ok }],
    },
  ] as Model[];
}

const tables = (schema: string, ts: string) => [
  `create table ${schema}.mf_customers (customer_id integer, segment varchar)`,
  `insert into ${schema}.mf_customers values (1, 'retail'), (2, 'business'), (3, 'retail')`,
  `create table ${schema}.mf_orders (order_id integer, customer_id integer, status varchar, amount_cents integer, created_at ${ts})`,
  `insert into ${schema}.mf_orders values
    (1, 1, 'completed', 1000, '2025-01-05 10:00:00+00'),
    (2, 2, 'completed', 3000, '2025-01-20 10:00:00+00'),
    (3, 1, 'completed', 2000, '2025-02-10 10:00:00+00'),
    (4, 3, 'cancelled', 5000, '2025-02-11 10:00:00+00'),
    (5, 2, 'completed', 700, '2025-03-15 10:00:00+00')`,
  `create table ${schema}.mf_refunds (refund_id integer, order_id integer, customer_id integer, refunded_cents integer, refunded_at ${ts})`,
  `insert into ${schema}.mf_refunds values
    (1, 1, 1, 200, '2025-01-25 10:00:00+00'),
    (2, 1, 1, 300, '2025-02-02 10:00:00+00'),
    (3, 3, 1, 500, '2025-04-03 10:00:00+00'),
    (4, 5, 2, 100, '2025-04-20 10:00:00+00')`,
];

function writeLayer(root: string, schema: string): void {
  for (const m of shopModels(schema)) writeYaml(join(root, "models", "shop", `${m.model}.yaml`), m);
}

async function shop(): Promise<{ root: string; file: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", tables("main", "timestamptz"));
  writeLayer(t.root, "main");
  return { root: t.root, file: src.connection!.database!, dir: t.dir };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const BY_MONTH = req({ measures: ["orders.revenue", "refunds.refund_amount"], dimensions: ["orders.created:month"], order_by: [{ field: "orders.created:month" }] });

// Worked out by hand from the rows above. Revenue leaves out order 4 (cancelled): January 10 + 30,
// February 20, March 7. Refunds by the month they were issued: January 2, February 3, April 5 + 1.
// February has a group for order 4 though its revenue is 20 only; April has refunds and no orders,
// so its revenue is null; March has no refunds, so its refund_amount is null, never 0.
const BY_MONTH_ROWS: Row[] = [
  { created_month: "2025-01-01", revenue: 40, refund_amount: 2 },
  { created_month: "2025-02-01", revenue: 20, refund_amount: 3 },
  { created_month: "2025-03-01", revenue: 7, refund_amount: null },
  { created_month: "2025-04-01", revenue: null, refund_amount: 6 },
];
// The same figures from two one-model requests.
const ORDERS_ALONE: Row[] = [
  { created_month: "2025-01-01", revenue: 40 },
  { created_month: "2025-02-01", revenue: 20 },
  { created_month: "2025-03-01", revenue: 7 },
];
const REFUNDS_ALONE: Row[] = [
  { created_month: "2025-01-01", refund_amount: 2 },
  { created_month: "2025-02-01", refund_amount: 3 },
  { created_month: "2025-04-01", refund_amount: 6 },
];
// By customer segment, reached through each model's customer join: retail orders 1 and 3 (4 is
// cancelled), business 2 and 5; retail refunds 1 to 3, business refund 4.
const BY_SEGMENT_ROWS: Row[] = [
  { segment: "business", revenue: 37, refund_count: 1 },
  { segment: "retail", revenue: 30, refund_count: 3 },
];

const sumOf = (rows: Row[], col: string) => rows.reduce((t, r) => t + (typeof r[col] === "number" ? (r[col] as number) : 0), 0);

describe("a request of measures of two models", () => {
  test("orders.revenue and refunds.refund_amount by month: two CTEs combined on the month, a month only refunds have still appears", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, BY_MONTH));
    expect(c.sql).toBe(
      [
        `with "orders measures" as (`,
        "select",
        `  cast(date_trunc('month', created_at) as date) as "created_month",`,
        `  sum(amount_cents * 0.01) filter (where status <> 'cancelled') as "revenue"`,
        'from "main"."mf_orders"',
        "group by 1",
        "),",
        `"refunds measures" as (`,
        "select",
        `  cast(date_trunc('month', refunded_at) as date) as "created_month",`,
        `  sum(refunded_cents * 0.01) as "refund_amount"`,
        'from "main"."mf_refunds"',
        "group by 1",
        "),",
        `"request groups" as (`,
        `select "created_month" from "orders measures"`,
        "union",
        `select "created_month" from "refunds measures"`,
        ")",
        "select",
        `  "request groups"."created_month" as "created_month",`,
        `  "orders measures"."revenue" as "revenue",`,
        `  "refunds measures"."refund_amount" as "refund_amount"`,
        `from "request groups"`,
        `left join "orders measures" on "orders measures"."created_month" is not distinct from "request groups"."created_month"`,
        `left join "refunds measures" on "refunds measures"."created_month" is not distinct from "request groups"."created_month"`,
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(c.model).toBe("orders");
    expect(c.columns).toEqual([
      { name: "created_month", ref: "orders.created:month", kind: "dimension" },
      { name: "revenue", ref: "orders.revenue", kind: "measure" },
      { name: "refund_amount", ref: "refunds.refund_amount", kind: "measure" },
    ]);
    const rows = plain(await runDuckdb(file, c));
    expect(rows).toEqual(BY_MONTH_ROWS);

    // The totals equal two one-model requests: neither model's rows multiply the other's.
    const orders = plain(await runDuckdb(file, compiled(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["orders.created:month"], order_by: [{ field: "orders.created:month" }] })))));
    const refunds = plain(await runDuckdb(file, compiled(compileRequest(root, req({ measures: ["refunds.refund_amount"], dimensions: ["refunds.created:month"], order_by: [{ field: "refunds.created:month" }] })))));
    expect(orders).toEqual(ORDERS_ALONE);
    expect(refunds).toEqual(REFUNDS_ALONE);
    expect([sumOf(rows, "revenue"), sumOf(rows, "refund_amount")]).toEqual([sumOf(orders, "revenue"), sumOf(refunds, "refund_amount")]);
    expect([sumOf(rows, "revenue"), sumOf(rows, "refund_amount")]).toEqual([67, 11]);
  });

  test("a dimension both reach through their joins groups each part by it; without dimensions the parts are one row each", async () => {
    const { root, file } = await shop();
    const seg = compiled(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_count"], dimensions: ["customers.segment"], order_by: [{ field: "customers.segment" }] })));
    expect(seg.sql).toContain('left join "main"."mf_customers" as "refunds.customer" on "refunds"."customer_id" = "refunds.customer"."customer_id"');
    expect(seg.joins.map((j) => [j.part, j.alias])).toEqual([
      ["orders", "orders.customer"],
      ["refunds", "refunds.customer"],
    ]);
    expect(plain(await runDuckdb(file, seg))).toEqual(BY_SEGMENT_ROWS);

    const total = compiled(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_amount", "orders.order_count"] })));
    expect(total.sql).toContain(`from "orders measures"\ncross join "refunds measures"`);
    expect(total.columns.map((x) => x.name)).toEqual(["revenue", "refund_amount", "order_count"]);
    expect(plain(await runDuckdb(file, total))).toEqual([{ revenue: 67, refund_amount: 11, order_count: 4 }]);
  });

  test("a dimension one model neither reaches nor has gives no_shared_dimension, as does a filter on one, and nothing is cross joined", async () => {
    const { root } = await shop();
    const r = refused(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_amount"], dimensions: ["orders.status"] })));
    expect(r.refusals.map((x) => [x.code, x.ref, x.message])).toEqual([
      [
        "no_shared_dimension",
        "orders.status",
        "the request groups by orders.status, but its measures come from orders and refunds, each aggregated on its own model, so each of them needs to reach orders through one path of to-one joins or have a dimension named status; refunds has neither",
      ],
    ]);
    expect(r.refusals[0]!.next).toContain("Add a many_to_one join from refunds toward orders");
    const f = refused(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_amount"], filters: [{ field: "orders.status", op: "eq", value: "completed" }] })));
    expect(f.refusals.map((x) => x.code)).toEqual(["no_shared_dimension"]);
    // semlayer validate errors on the same golden request before it is written.
    const cli = await semlayer(root, ["goldens", "new", "--name", "by_status", "--question", "Q?", "--request", JSON.stringify(req({ measures: ["orders.revenue", "refunds.refund_amount"], dimensions: ["orders.status"] }))]);
    expect(cli.code).toBe(1);
    expect(cli.err).toContain('refunds has no dimension "status" and no such path to orders');
  });

  test("a request of one model's measures compiles as before, with no CTE", async () => {
    const { root } = await shop();
    const one = compiled(compileRequest(root, req({ measures: ["orders.revenue", "orders.order_count"], dimensions: ["orders.created:month"] })));
    expect(one.sql).toBe(
      [
        "select",
        `  cast(date_trunc('month', created_at) as date) as "created_month",`,
        `  sum(amount_cents * 0.01) filter (where status <> 'cancelled') as "revenue",`,
        `  count(*) filter (where status <> 'cancelled') as "order_count"`,
        'from "main"."mf_orders"',
        "group by 1",
      ].join("\n"),
    );
  });

  test("a filter on a measure of one of the models goes in the outer WHERE, after every part's parameters", async () => {
    const { root, file } = await shop();
    const c = compiled(
      compileRequest(root, { ...BY_MONTH, filters: [{ field: "orders.created", op: "gte", value: "2025-02-01" }, { field: "refunds.refund_amount", op: "gt", value: 2 }] }),
    );
    expect(c.params).toEqual(["2025-02-01", "2025-02-01", 2]);
    expect(c.sql).toContain(`where ("refunds measures"."refund_amount") > $3`);
    expect(plain(await runDuckdb(file, c))).toEqual([BY_MONTH_ROWS[1]!, BY_MONTH_ROWS[3]!]);
  });

  test("request segments are refused, join.multi_fact_segments; a segment a measure names applies inside its part", async () => {
    const { root, file } = await shop();
    const path = join(root, "models", "shop", "orders.yaml");
    const orders = readYaml<Model>(path);
    orders.segments = [{ name: "big", filter: "amount_cents >= 2000", ...ok }] as Model["segments"];
    orders.measures!.push({ name: "big_revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "status <> 'cancelled'", segments: ["big"], ...ok } as never);
    writeYaml(path, orders);
    const r = refused(compileRequest(root, { ...BY_MONTH, segments: ["orders.big"] }));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["join.multi_fact_segments", "orders.big"]]);
    expect(r.refusals[0]!.message).toBe(
      "the request names segments orders.big, but its measures come from orders and refunds, each aggregated on its own model; a request's segments apply to a request of one model's measures",
    );
    expect(r.refusals[0]!.next).toContain("Ask for each model's measures in a request of its own");
    // big_revenue's segment narrows it inside the orders part: January 30, February 20 (order 4 is
    // cancelled), March none (700 cents), April no orders.
    const seg = compiled(compileRequest(root, { ...BY_MONTH, measures: ["orders.big_revenue", "refunds.refund_amount"] }));
    expect(plain(await runDuckdb(file, seg)).map((x) => [x.created_month, x.big_revenue])).toEqual([
      ["2025-01-01", 30],
      ["2025-02-01", 20],
      ["2025-03-01", null],
      ["2025-04-01", null],
    ]);
  });

  test("the :month shorthand reads the first measure's default time dimension, and the other part groups by the dimension of that name", async () => {
    const { root, file } = await shop();
    const path = join(root, "models", "shop", "orders.yaml");
    const orders = readYaml<Model>(path);
    orders.default_time_dimension = "created";
    writeYaml(path, orders);
    const c = compiled(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_amount"], dimensions: [":month"], order_by: [{ field: ":month" }] })));
    expect(c.columns[0]).toEqual({ name: "created_month", ref: "orders.created:month", kind: "dimension" });
    expect(c.sql).toBe(compiled(compileRequest(root, BY_MONTH)).sql);
    expect(plain(await runDuckdb(file, c))).toEqual(BY_MONTH_ROWS);
    // With refunds first, the shorthand reads refunds' default, and there is none.
    const r = refused(compileRequest(root, req({ measures: ["refunds.refund_amount", "orders.revenue"], dimensions: [":month"] })));
    expect(r.refusals.map((x) => x.code)).toEqual(["metric.default_time_missing"]);
  });
});

describe("access in a multi-fact request", () => {
  const access = (extra: Record<string, unknown> = {}) => ({
    ...ok,
    mode: "open",
    user_attributes: [{ name: "segment", type: "string" }],
    roles: [
      { name: "finance", description: "Finance." },
      { name: "retail_desk", description: "The retail desk.", row_filters: [{ model: "shop.customers", expr: "segment = {{ user.segment }}" }, { model: "shop.refunds", expr: "customer_id in (1, 3)" }] },
    ],
    restrictions: [{ name: "refunds_for_finance", description: "Refunds are for finance only.", targets: ["shop.refunds.refund_amount"], allow: { roles: ["finance"] } }],
    ...extra,
  });

  test("a user who may not see one model's measure is refused the whole request, never given the other part", async () => {
    const { root } = await shop();
    writeYaml(join(root, "access.yaml"), access());
    const r = refused(compileRequest(root, BY_MONTH, { role: "retail_desk", user: { segment: "retail" } }));
    expect([...new Set(r.refusals.map((x) => `${x.code} ${x.ref}`))]).toEqual(["not_visible refunds.refund_amount"]);
    expect(compileRequest(root, BY_MONTH, { role: "finance" }).ok).toBe(true);
  });

  test("each part applies the user's row filters to its own model", async () => {
    const { root, file } = await shop();
    writeYaml(join(root, "access.yaml"), access({ restrictions: [] }));
    const c = compiled(compileRequest(root, req({ measures: ["orders.revenue", "refunds.refund_count"], dimensions: ["customers.segment"], order_by: [{ field: "customers.segment" }] }), { role: "retail_desk", user: { segment: "retail" } }));
    expect(c.row_filters.map((x) => [x.part, x.model, x.in])).toEqual([
      ["orders", "customers", "on"],
      ["refunds", "customers", "on"],
      ["refunds", "refunds", "where"],
    ]);
    expect(c.params).toEqual(["retail", "retail"]);
    // A left join keeps business orders with a blank segment; refunds are only customers 1 and 3's.
    expect(plain(await runDuckdb(file, c))).toEqual([
      { segment: "retail", revenue: 30, refund_count: 3 },
      { segment: null, revenue: 37, refund_count: null },
    ]);
  });

  test("a protected measure in either part is masked in the golden's run, and the readback and run name both models' measures", async () => {
    const { root } = await shop();
    const path = join(root, "models", "shop", "refunds.yaml");
    const refunds = readYaml<Model>(path);
    (refunds.measures![0] as { tags?: string[] }).tags = ["sensitive"];
    writeYaml(path, refunds);
    writeYaml(join(root, "access.yaml"), access({ restrictions: [], roles: [{ name: "finance", description: "Finance.", allow: { tags: ["sensitive"] } }] }));
    const made = await semlayer(root, ["goldens", "new", "--name", "orders_refunds_by_month", "--question", "Orders and refunds by month?", "--request", JSON.stringify(BY_MONTH), "--role", "finance", "--json"]);
    expect(made.code).toBe(0);
    const run = await semlayer(root, ["goldens", "run", "--name", "orders_refunds_by_month", "--json"]);
    expect(run.code).toBe(0);
    const out = run.json<{ rows: Row[]; protected_columns: string[]; sql: string }>();
    expect(out.protected_columns).toEqual(["refund_amount"]);
    expect(plain(out.rows).map((x) => [x.revenue, x.refund_amount])).toEqual([
      [40, "[protected]"],
      [20, "[protected]"],
      [7, null],
      [null, "[protected]"],
    ]);
    expect(out.sql).toContain('"refunds measures"');
    const rb = await semlayer(root, ["readback", "--targets", "golden:orders_refunds_by_month"]);
    expect(rb.code).toBe(0);
    expect(rb.out).toContain("orders.revenue");
    expect(rb.out).toContain("refunds.refund_amount");
    // The readers of a golden's fields see both models.
    const golden = readYaml<Golden>(join(root, "goldens", "orders_refunds_by_month.yaml"));
    const models = shopModels("main").map((m) => ({ ...m, status: "draft" as const, measures: m.measures!.map((x) => ({ ...x, status: "draft" as const })) }));
    expect(goldenDraftFields(golden, models as Model[], [])).toEqual(["shop.orders.revenue", "shop.refunds.refund_amount"]);
    expect(validateProject(root).filter((i) => i.file === "goldens/orders_refunds_by_month.yaml" && i.level === "error")).toEqual([]);
  });
});

describe("multi-fact totals on postgres", () => {
  test.skipIf(!PG_URL)("the same request gives the same rows, equal to two one-model requests", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("t_multifact");
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      await db.unsafe(`create schema ${schema}`);
      for (const s of tables(schema, "timestamptz")) await db.unsafe(s);
      const t = tempRoot();
      cleanup = t.cleanup;
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "PG_URL" } });
      writeLayer(t.root, schema);
      const rows = plain(await runPg(compiled(compileRequest(t.root, BY_MONTH))));
      expect(rows).toEqual(BY_MONTH_ROWS);
      const orders = plain(await runPg(compiled(compileRequest(t.root, req({ measures: ["orders.revenue"], dimensions: ["orders.created:month"], order_by: [{ field: "orders.created:month" }] })))));
      const refunds = plain(await runPg(compiled(compileRequest(t.root, req({ measures: ["refunds.refund_amount"], dimensions: ["refunds.created:month"], order_by: [{ field: "refunds.created:month" }] })))));
      expect([orders, refunds]).toEqual([ORDERS_ALONE, REFUNDS_ALONE]);
      expect(plain(await runPg(compiled(compileRequest(t.root, req({ measures: ["orders.revenue", "refunds.refund_count"], dimensions: ["customers.segment"], order_by: [{ field: "customers.segment" }] })))))).toEqual(BY_SEGMENT_ROWS);
    } finally {
      await db.unsafe(`drop schema if exists ${schema} cascade`);
      await db.close();
    }
  });
});

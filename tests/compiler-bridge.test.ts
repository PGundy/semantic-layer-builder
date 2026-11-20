// Bridge joins in the compiler (spec: Bridges and multi-fact requests): a request grouped by a field of a
// bridge join's target reads the bridge deduped to one row per (order, tag) pair, so no figure is
// multiplied or shrunk, and each dedupe rule gives the figures its readback sentence (lib/readback-bridge.ts
// dedupeWords) promises. Every figure is worked out by hand from fixtures/semantics/bridge.sql and checked
// beside a hand-written query that computes it another way, on DuckDB and, with PG_URL, on PostgreSQL.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { dedupeWords } from "../skills/semantic-layer/scripts/lib/readback-bridge.ts";
import type { Join, Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;
const FIXTURE = readFileSync(join(import.meta.dir, "..", "fixtures", "semantics", "bridge.sql"), "utf8");
const STATEMENTS = FIXTURE.replace(/--[^\n]*\n/g, "\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

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

async function duck(file: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    const p = await cx.prepare(sql);
    if (params.length) p.bind(params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// Rows with each figure a number rounded to 6 decimals (equal_split and weight give fractions) and
// sorted by their first column, an empty one last.
const plain = (rows: Row[]) =>
  rows
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? Math.round(Number(v) * 1e6) / 1e6 : v])))
    .sort((a, b) => {
      const [x, y] = [Object.values(a)[0], Object.values(b)[0]];
      return x === null ? 1 : y === null ? -1 : String(x).localeCompare(String(y));
    });
// A column's total to the cent: shares of a third are rounded by the database.
const total = (rows: Row[], col: string) => Math.round(rows.reduce((t, r) => t + Number(r[col] ?? 0), 0) * 100) / 100;

// --- the layer of bridge.sql: orders, tags and the order_tags bridge ----------------------------

const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-10" };
const dim = (name: string, expr = name, extra: Record<string, unknown> = {}) => ({ name, expr, type: name.endsWith("_id") ? "number" : "string", ...ok, ...extra }) as NonNullable<Model["dimensions"]>[number];

function bridgeJoin(through: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Join {
  return {
    name: "tag",
    to: "tags",
    keys: [{ from: "order_id", to: "order_id" }],
    relationship: "one_to_many",
    type: "left",
    through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], dedupe: "distinct_pairs", ...through },
    ...ok,
    ...extra,
  } as Join;
}

function models(schema: string, joins: Join[] | undefined, extra: { orders?: Partial<Model>; bridge?: Partial<Model>; tags?: Partial<Model> } = {}): Model[] {
  return [
    {
      model: "orders",
      source: "shop",
      table: `${schema}.orders`,
      primary_key: ["order_id"],
      grain: "One row per order.",
      ...ok,
      dimensions: [dim("order_id"), dim("customer_name")],
      measures: [
        { name: "revenue", expr: "amount_cents", agg: "sum", ...ok },
        { name: "order_count", agg: "count", ...ok },
        { name: "big_orders", expr: "order_id", agg: "count", filter: "amount_cents >= 2000", ...ok },
        { name: "average", expr: "amount_cents", agg: "avg", ...ok },
        { name: "customers", expr: "customer_name", agg: "count_distinct", ...ok },
      ],
      ...(joins ? { joins } : {}),
      ...extra.orders,
    },
    { model: "tags", source: "shop", table: `${schema}.tags`, primary_key: ["tag_id"], grain: "One row per tag.", ...ok, dimensions: [dim("tag_id"), dim("tag_name")], measures: [{ name: "tag_count", agg: "count", ...ok }], ...extra.tags },
    { model: "order_tags", source: "shop", table: `${schema}.order_tags`, grain: "One row per order and tag.", ...ok, dimensions: [dim("order_id"), dim("tag_id"), dim("share")], measures: [], ...extra.bridge },
  ] as Model[];
}

function writeLayer(root: string, ms: Model[]): void {
  for (const m of ms) writeYaml(join(root, "models", "shop", `${m.model}.yaml`), m);
}

async function shop(joins: Join[] | undefined = [bridgeJoin()], extraStatements: string[] = []): Promise<{ root: string; file: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", [...STATEMENTS, ...extraStatements]);
  writeLayer(t.root, models("main", joins));
  return { root: t.root, file: src.connection!.database!, dir: t.dir };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const BY_TAG = req({ measures: ["orders.revenue", "orders.order_count"], dimensions: ["tags.tag_name"] });

// --- the figures, worked out by hand from bridge.sql ------------------------------------------------
// Orders (cents): 1 = 1000 (gift, rush), 2 = 2000 (gift, rush, wholesale), 3 = 3000 (wholesale),
// 4 = 4000 (no tag), 5 = 500 (gift, listed twice). The true total is 10500; tagged orders total 6500.

// distinct_pairs: each order adds its whole figure to each of its tags. Gift 1000 + 2000 + 500, rush
// 1000 + 2000, wholesale 2000 + 3000; order 4 under an empty tag (a left join). 15500 by tag > 10500.
const DISTINCT: Row[] = [
  { tag_name: "gift", revenue: 3500, order_count: 3 },
  { tag_name: "rush", revenue: 3000, order_count: 2 },
  { tag_name: "wholesale", revenue: 5000, order_count: 2 },
  { tag_name: null, revenue: 4000, order_count: 1 },
];
// equal_split: an order with n tags gives each 1/n. Gift 500 + 666.667 + 500, rush 500 + 666.667,
// wholesale 666.667 + 3000; counts 1/2 + 1/3 + 1, 1/2 + 1/3, 1/3 + 1. By tag they add up to 10500.
const SPLIT: Row[] = [
  { tag_name: "gift", revenue: 1666.666667, order_count: 1.833333 },
  { tag_name: "rush", revenue: 1166.666667, order_count: 0.833333 },
  { tag_name: "wholesale", revenue: 3666.666667, order_count: 1.333333 },
  { tag_name: null, revenue: 4000, order_count: 1 },
];
// weight by order_tags.share: order 1 shares 1:3 (250, 750), order 2 1:1:2 (500, 500, 1000), order 3
// all to wholesale, order 5's two rows of 1 are one pair of weight 2, all to gift. Counts: gift
// 1/4 + 1/4 + 1, rush 3/4 + 1/4, wholesale 1/2 + 1.
const WEIGHT: Row[] = [
  { tag_name: "gift", revenue: 1250, order_count: 1.5 },
  { tag_name: "rush", revenue: 1250, order_count: 1 },
  { tag_name: "wholesale", revenue: 4000, order_count: 1.5 },
  { tag_name: null, revenue: 4000, order_count: 1 },
];

// The same figures written by hand another way, with no bridge subselect: tags matched to orders with
// EXISTS for distinct_pairs, and each order's share from its count (or total weight) of distinct tags.
const HAND = {
  distinct_pairs: (s: string) => `
    select t.tag_name, sum(o.amount_cents) as revenue, count(*) as order_count
    from ${s}.tags t join ${s}.orders o on exists (select 1 from ${s}.order_tags b where b.order_id = o.order_id and b.tag_id = t.tag_id)
    group by t.tag_name
    union all
    select null, sum(amount_cents), count(*) from ${s}.orders o where not exists (select 1 from ${s}.order_tags b where b.order_id = o.order_id)`,
  equal_split: (s: string) => `
    select t.tag_name, sum(o.amount_cents * 1.0 / n.n) as revenue, sum(1.0 / n.n) as order_count
    from (select distinct order_id, tag_id from ${s}.order_tags) p
    join (select order_id, count(distinct tag_id) as n from ${s}.order_tags group by order_id) n on n.order_id = p.order_id
    join ${s}.orders o on o.order_id = p.order_id join ${s}.tags t on t.tag_id = p.tag_id
    group by t.tag_name
    union all
    select null, sum(amount_cents), count(*) from ${s}.orders o where not exists (select 1 from ${s}.order_tags b where b.order_id = o.order_id)`,
  weight: (s: string) => `
    select t.tag_name, sum(o.amount_cents * 1.0 * p.w / w.w) as revenue, sum(1.0 * p.w / w.w) as order_count
    from (select order_id, tag_id, sum(share) as w from ${s}.order_tags group by order_id, tag_id) p
    join (select order_id, sum(share) as w from ${s}.order_tags group by order_id) w on w.order_id = p.order_id
    join ${s}.orders o on o.order_id = p.order_id join ${s}.tags t on t.tag_id = p.tag_id
    group by t.tag_name
    union all
    select null, sum(amount_cents), count(*) from ${s}.orders o where not exists (select 1 from ${s}.order_tags b where b.order_id = o.order_id)`,
};

const RULES = [
  ["distinct_pairs", DISTINCT],
  ["equal_split", SPLIT],
  ["weight", WEIGHT],
] as const;
const through = (rule: string) => (rule === "weight" ? { dedupe: "weight", weight: "share" } : { dedupe: rule });

describe("a request grouped by a bridge join's target", () => {
  test("distinct_pairs compiles to a deduped (order, tag) subselect, then the target, both left joins", async () => {
    const { root } = await shop();
    const c = compiled(compileRequest(root, BY_TAG));
    expect(c.sql).toBe(
      [
        "select",
        `  "orders.tag".tag_name as "tag_name",`,
        `  sum("orders".amount_cents) as "revenue",`,
        `  count(*) as "order_count"`,
        `from "main"."orders" as "orders"`,
        `left join (`,
        `  select "orders.tag bridge"."order_id", "orders.tag bridge"."tag_id"`,
        `  from "main"."order_tags" as "orders.tag bridge"`,
        `  group by "orders.tag bridge"."order_id", "orders.tag bridge"."tag_id"`,
        `) as "orders.tag bridge" on "orders"."order_id" = "orders.tag bridge"."order_id"`,
        `left join "main"."tags" as "orders.tag" on "orders.tag bridge"."tag_id" = "orders.tag"."tag_id"`,
        "group by 1",
      ].join("\n"),
    );
    expect(c.joins).toEqual([
      { alias: "orders.tag bridge", via: "orders.tag", model: "order_tags", type: "left", for: "request", through: "bridge" },
      { alias: "orders.tag", via: "orders.tag", model: "tags", type: "left", for: "request", through: "target" },
    ]);
  });

  for (const [rule, expected] of RULES)
    test(`${rule}: each tag's figure equals the hand-computed one and the hand-written query's`, async () => {
      const { root, file } = await shop([bridgeJoin(through(rule))]);
      const c = compiled(compileRequest(root, BY_TAG));
      const rows = plain(await duck(file, c.sql, c.params));
      expect(rows).toEqual(expected as unknown as Row[]);
      expect(plain(await duck(file, HAND[rule]("main")))).toEqual(rows);
      // What the readback promises: distinct_pairs totals by tag exceed the overall total, which counts
      // each order once; the shares of equal_split and weight add up to it.
      const overall = plain(await duck(file, compiled(compileRequest(root, req({ measures: ["orders.revenue"] }))).sql))[0]!.revenue;
      expect(overall).toBe(10500);
      if (rule === "distinct_pairs") expect(total(rows, "revenue")).toBe(15500);
      else {
        expect(total(rows, "revenue")).toBe(10500);
        expect(total(rows.filter((r) => r.tag_name !== null), "revenue")).toBe(6500);
        expect(total(rows, "order_count")).toBe(5);
      }
      const words = dedupeWords("orders", bridgeJoin(through(rule))).join(" ");
      expect(words).toContain(rule === "distinct_pairs" ? "Totals by tag can add up to more than the overall total" : "Totals by tag add up to the overall total of the orders that have a tag");
    });

  test("the ungrouped total is the same SQL and figure with and without the bridge join declared", async () => {
    const { root, file } = await shop();
    const ask = req({ measures: ["orders.revenue", "orders.order_count"] });
    const withJoin = compiled(compileRequest(root, ask));
    writeLayer(root, models("main", undefined));
    const without = compiled(compileRequest(root, ask));
    expect(withJoin.sql).toBe(without.sql);
    expect(withJoin.joins).toEqual([]);
    expect(plain(await duck(file, withJoin.sql))).toEqual([{ revenue: 10500, order_count: 5 }]);
    const direct = await duck(file, "select sum(amount_cents) as revenue, count(*) as order_count from main.orders");
    expect(plain(direct)).toEqual([{ revenue: 10500, order_count: 5 }]);
  });

  test("repeating bridge rows leaves distinct_pairs, equal_split and weight's shares unchanged", async () => {
    // Order 1's gift pair and order 2's wholesale pair listed twice more, each with share 0: a pair's
    // weight is the total of its rows, so weight is unchanged too.
    const extra = ["insert into order_tags values (1, 1, 0), (1, 1, 0), (2, 3, 0)"];
    for (const [rule, expected] of RULES) {
      const { root, file } = await shop([bridgeJoin(through(rule))], extra);
      const c = compiled(compileRequest(root, BY_TAG));
      expect({ rule, rows: plain(await duck(file, c.sql, c.params)) }).toEqual({ rule, rows: expected as unknown as Row[] });
      cleanup?.();
      cleanup = undefined;
    }
  });

  test("an inner join leaves out the order with no tag; a bridge row naming no tag follows the join's type", async () => {
    // Order 3 gains a bridge row for tag 9, which tags lacks: a left join shows its share under an empty
    // tag, an inner join leaves the pair out.
    const extra = ["insert into order_tags values (3, 9, 1)"];
    const { root, file } = await shop([bridgeJoin({ dedupe: "equal_split" }, { type: "inner" })], extra);
    const inner = plain(await duck(file, compiled(compileRequest(root, BY_TAG)).sql));
    // Wholesale gets half of order 3 (1500), and the tag-9 half is left out with order 4.
    expect(inner).toEqual([
      { tag_name: "gift", revenue: 1666.666667, order_count: 1.833333 },
      { tag_name: "rush", revenue: 1166.666667, order_count: 0.833333 },
      { tag_name: "wholesale", revenue: 2166.666667, order_count: 0.833333 },
    ]);
    writeLayer(root, models("main", [bridgeJoin({ dedupe: "equal_split" })]));
    const left = plain(await duck(file, compiled(compileRequest(root, BY_TAG)).sql));
    expect(left.at(-1)).toEqual({ tag_name: null, revenue: 5500, order_count: 1.5 });
    expect(total(left, "revenue")).toBe(10500);
  });

  test("a filter on the grouped target narrows the pairs; a measure's own filter applies inside the share", async () => {
    const { root, file } = await shop([bridgeJoin({ dedupe: "equal_split" })]);
    const c = compiled(compileRequest(root, { ...BY_TAG, measures: ["orders.revenue", "orders.big_orders"], filters: [{ field: "tags.tag_name", op: "in", value: ["gift", "wholesale"] }] }));
    expect(c.params).toEqual(["gift", "wholesale"]);
    // big_orders counts orders of 2000 cents or more: order 2's third under gift; order 2's third and
    // order 3 under wholesale.
    expect(plain(await duck(file, c.sql, c.params))).toEqual([
      { tag_name: "gift", revenue: 1666.666667, big_orders: 0.333333 },
      { tag_name: "wholesale", revenue: 3666.666667, big_orders: 1.333333 },
    ]);
  });
});

describe("what a bridge route refuses", () => {
  test("a filter on the target without grouping by it is refused: join.through_filter_ungrouped", async () => {
    const { root } = await shop();
    const r = refused(compileRequest(root, req({ measures: ["orders.revenue"], filters: [{ field: "tags.tag_name", op: "eq", value: "gift" }] })));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["join.through_filter_ungrouped", "tags.tag_name"]]);
    expect(r.refusals[0]!.message).toContain("would count a row of orders once for each of its rows of tags that match");
    expect(r.refusals[0]!.next).toContain("Add tags.tag_name to the request's dimensions");
    // Grouped by another field of the target, a filter on tag_id is still refused.
    const other = refused(compileRequest(root, { ...BY_TAG, filters: [{ field: "tags.tag_id", op: "eq", value: 1 }] }));
    expect(other.refusals.map((x) => x.code)).toEqual(["join.through_filter_ungrouped"]);
  });

  test("under equal_split and weight only sum and count are shared; distinct_pairs takes any aggregate", async () => {
    const { root, file } = await shop([bridgeJoin({ dedupe: "equal_split" })]);
    const r = refused(compileRequest(root, req({ measures: ["orders.average", "orders.customers"], dimensions: ["tags.tag_name"] })));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([
      ["join.through_aggregate_unsupported", "orders.average"],
      ["join.through_aggregate_unsupported", "orders.customers"],
    ]);
    writeLayer(root, models("main", [bridgeJoin()]));
    const c = compiled(compileRequest(root, req({ measures: ["orders.average", "orders.customers"], dimensions: ["tags.tag_name"] })));
    // Gift: orders 1, 2, 5 average 3500 / 3; rush 1, 2; wholesale 2, 3; no tag: order 4.
    expect(plain(await duck(file, c.sql))).toEqual([
      { tag_name: "gift", average: 1166.666667, customers: 3 },
      { tag_name: "rush", average: 1500, customers: 2 },
      { tag_name: "wholesale", average: 2500, customers: 2 },
      { tag_name: null, average: 4000, customers: 1 },
    ]);
  });

  test("a second bridge, a join without its rule and a semi-additive measure are refused by name", async () => {
    const second = bridgeJoin({}, { name: "label", to: "labels" });
    const { root } = await shop([bridgeJoin(), second]);
    const ms = models("main", [bridgeJoin(), second]);
    ms.push({ ...ms[1]!, model: "labels", dimensions: [dim("label", "tag_name")], measures: [] } as Model);
    writeLayer(root, ms);
    const two = refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["tags.tag_name", "labels.label"] })));
    expect(two.refusals.map((x) => [x.code, x.ref])).toEqual([["join.through_second_path", "labels.label"]]);
    expect(two.refusals[0]!.next).toBe("Ask for the figures by one bridge at a time, in a request each, and run semlayer sql again.");

    writeLayer(root, models("main", [bridgeJoin({ dedupe: undefined }, { status: "draft" })]));
    const none = refused(compileRequest(root, BY_TAG));
    expect(none.refusals.map((x) => x.code)).toEqual(["invalid_layer"]);
    expect(none.refusals[0]!.message).toBe("bridge join orders.tag has no dedupe rule, so the compiler does not know how the figure of one row of orders is shared among its rows of tags");
    expect(none.refusals[0]!.next).toContain("semlayer add-bridge --dedupe <rule>");

    const semi = models("main", [bridgeJoin()], {
      orders: {
        dimensions: [dim("order_id"), dim("placed", "order_id", { type: "time", time_grains: ["day"] })],
        measures: [{ name: "latest", expr: "amount_cents", agg: "sum", non_additive_dimension: { name: "placed", window: "last" }, ...ok }] as Model["measures"],
      },
    });
    writeLayer(root, semi);
    const s = refused(compileRequest(root, req({ measures: ["orders.latest"], dimensions: ["tags.tag_name"] })));
    expect(s.refusals.map((x) => [x.code, x.ref])).toEqual([["join.through_semi_additive", "orders.latest"]]);
  });

  test("a measure filter or segment that reads the target through the bridge is refused; only a request groups by it", async () => {
    const { root } = await shop();
    writeLayer(root, models("main", [bridgeJoin()], { orders: { measures: [{ name: "gift_revenue", expr: "amount_cents", agg: "sum", filter: "tag.tag_name = 'gift'", ...ok }] as Model["measures"] } }));
    const r = refused(compileRequest(root, req({ measures: ["orders.gift_revenue"] })));
    expect(r.refusals.map((x) => x.code)).toEqual(["invalid_layer"]);
    expect(r.refusals[0]!.message).toContain("reads through the bridge join orders.tag");
  });
});

describe("bridge edge cases", () => {
  test("weight: an order whose bridge weights total 0 splits equally, so its figure is neither lost nor multiplied", async () => {
    // Order 2 (2000; gift, rush, wholesale) gets weight 0 on all three rows: each tag gets 1/3 of it,
    // 666.666667, and the other orders keep their weights, so the tags add up to the 6500 of tagged orders.
    const { root, file } = await shop([bridgeJoin(through("weight"))], ["update order_tags set share = 0 where order_id = 2"]);
    const c = compiled(compileRequest(root, BY_TAG));
    const rows = plain(await duck(file, c.sql));
    // Gift 250 + 666.667 + 500, rush 750 + 666.667, wholesale 666.667 + 3000, no tag 4000.
    expect(rows).toEqual([
      { tag_name: "gift", revenue: 1416.666667, order_count: 1.583333 },
      { tag_name: "rush", revenue: 1416.666667, order_count: 1.083333 },
      { tag_name: "wholesale", revenue: 3666.666667, order_count: 1.333333 },
      { tag_name: null, revenue: 4000, order_count: 1 },
    ]);
    expect(total(rows, "revenue")).toBe(10500);
  });

  test("distinct_pairs refuses a computed target field; a plain column and the other rules take it", async () => {
    const kind = dim("kind", "case when tag_id in (1, 2) then 'retail' else 'trade' end");
    const ask = req({ measures: ["orders.revenue"], dimensions: ["tags.kind"] });
    const { root, file } = await shop();
    writeLayer(root, models("main", [bridgeJoin()], { tags: { dimensions: [dim("tag_id"), dim("tag_name"), kind] as Model["dimensions"] } }));
    const r = refused(compileRequest(root, ask));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["join.through_coarse_group", "orders.revenue"]]);
    // equal_split: retail is orders 1, 2 (gift, rush) and 5: 1000 + 2000 * 2/3 + 500; trade is order 3 and wholesale's third of
    // order 2 (3666.67) and order 4 with no tag (4000, its empty tag is not in 1 and 2); they add up to 10500.
    writeLayer(root, models("main", [bridgeJoin({ dedupe: "equal_split" })], { tags: { dimensions: [dim("tag_id"), dim("tag_name"), kind] as Model["dimensions"] } }));
    expect(plain(await duck(file, compiled(compileRequest(root, ask)).sql))).toEqual([
      { kind: "retail", revenue: 2833.333333 },
      { kind: "trade", revenue: 7666.666667 },
    ]);
  });

  test("a segment on a measure that reads the target through the bridge is refused", async () => {
    const { root } = await shop();
    writeLayer(root, models("main", [bridgeJoin()], { orders: { segments: [{ name: "gifted", filter: "tag.tag_name = 'gift'", ...ok }] as Model["segments"], measures: [{ name: "gifted_revenue", expr: "amount_cents", agg: "sum", segments: ["gifted"], ...ok }] as Model["measures"] } }));
    const r = refused(compileRequest(root, req({ measures: ["orders.gifted_revenue"] })));
    expect(r.refusals.map((x) => x.code)).toEqual(["invalid_layer"]);
    expect(r.refusals[0]!.message).toContain("reads through the bridge join orders.tag");
  });
});

describe("access through a bridge", () => {
  const access = (roles: unknown[]) => ({ ...ok, mode: "open", roles });

  test("the user's row filter on the bridge limits its pairs before the shares are taken", async () => {
    const { root, file } = await shop([bridgeJoin({ dedupe: "equal_split" })]);
    writeYaml(join(root, "access.yaml"), { ...access([{ name: "no_rush", description: "Sees no rush tags.", row_filters: [{ model: "shop.order_tags", expr: "tag_id <> {{ user.hidden_tag }}" }] }]), user_attributes: [{ name: "hidden_tag", type: "number" }] });
    const c = compiled(compileRequest(root, BY_TAG, { role: "no_rush", user: { hidden_tag: 2 } }));
    expect(c.sql).toContain(`  where ("orders.tag bridge".tag_id <> $1)\n`);
    expect(c.params).toEqual([2]);
    expect(c.row_filters).toEqual([{ model: "order_tags", alias: "orders.tag bridge", in: "on", roles: ["no_rush"], rows: "filtered" }]);
    // Without rush pairs: order 1 gives all 1000 to gift, order 2 halves 2000 between gift and wholesale.
    const rows = plain(await duck(file, c.sql, c.params));
    expect(rows).toEqual([
      { tag_name: "gift", revenue: 2500, order_count: 2.5 },
      { tag_name: "wholesale", revenue: 4000, order_count: 1.5 },
      { tag_name: null, revenue: 4000, order_count: 1 },
    ]);
    const hand = `
      select t.tag_name, sum(o.amount_cents * 1.0 / n.n) as revenue, sum(1.0 / n.n) as order_count
      from (select distinct order_id, tag_id from main.order_tags where tag_id <> 2) p
      join (select order_id, count(distinct tag_id) as n from main.order_tags where tag_id <> 2 group by order_id) n on n.order_id = p.order_id
      join main.orders o on o.order_id = p.order_id join main.tags t on t.tag_id = p.tag_id group by t.tag_name
      union all select null, sum(amount_cents), count(*) from main.orders o where not exists (select 1 from main.order_tags b where b.order_id = o.order_id and b.tag_id <> 2)`;
    expect(plain(await duck(file, hand))).toEqual(rows);
  });

  test("a bridge or a target the user may not see refuses the whole request as not_visible", async () => {
    const { root } = await shop();
    writeYaml(join(root, "access.yaml"), access([{ name: "no_bridge", description: "No bridge.", deny: { models: ["shop.order_tags"] } }, { name: "no_tags", description: "No tags.", deny: { models: ["shop.tags"] } }]));
    const b = refused(compileRequest(root, BY_TAG, { role: "no_bridge" }));
    expect(b.refusals.map((x) => [x.code, x.ref])).toEqual([["not_visible", "tags.tag_name"]]);
    expect(b.refusals[0]!.message).toBe("tags.tag_name is on model tags, which a request on orders reaches through the bridge order_tags, which this user may not see (denied:no_bridge)");
    // Dimensions alone are refused too: the bridge decides which tags each order has.
    expect(refused(compileRequest(root, req({ dimensions: ["orders.order_id", "tags.tag_name"] }), { role: "no_bridge" })).refusals.map((x) => x.code)).toEqual(["not_visible"]);
    const t = refused(compileRequest(root, BY_TAG, { role: "no_tags" }));
    expect([...new Set(t.refusals.map((x) => x.code))]).toEqual(["not_visible"]);
    expect(t.refusals.map((x) => x.ref)).toContain("tags.tag_name");
  });

  test("a protected bridge is hidden unless the role allows its tag; a protected target field is masked in a golden's run", async () => {
    const { root } = await shop();
    writeYaml(join(root, "access.yaml"), access([{ name: "trusted", description: "Sees protected data.", allow: { tags: ["pii", "sensitive"] } }]));
    writeLayer(root, models("main", [bridgeJoin()], { bridge: { tags: ["pii"] } }));
    const hidden = refused(compileRequest(root, BY_TAG));
    expect(hidden.refusals.map((x) => [x.code, x.ref, x.reasons])).toEqual([["not_visible", "tags.tag_name", undefined]]);
    expect(hidden.refusals[0]!.message).toContain("through the bridge order_tags, which this user may not see (protected_tag:pii)");
    expect(compileRequest(root, BY_TAG, { role: "trusted" }).ok).toBe(true);
    writeLayer(root, models("main", [bridgeJoin()], { bridge: { tags: ["pii"] }, tags: { dimensions: [dim("tag_id"), dim("tag_name", "tag_name", { tags: ["sensitive"] })] } }));
    const made = await semlayer(root, ["goldens", "new", "--name", "revenue_by_tag", "--question", "Revenue by tag?", "--request", JSON.stringify(BY_TAG), "--role", "trusted", "--json"]);
    expect(made.code).toBe(0);
    const run = await semlayer(root, ["goldens", "run", "--name", "revenue_by_tag", "--json"]);
    expect(run.code).toBe(0);
    const out = run.json<{ rows: Row[]; protected_columns: string[] }>();
    expect(out.protected_columns).toEqual(["tag_name"]);
    expect(out.rows.map((r) => r.tag_name).filter((v) => v !== null)).toEqual(["[protected]", "[protected]", "[protected]"]);
  });
});

describe("a bridge route with other features", () => {
  test("a two-model request groups one model through its bridge and the other by its own field", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.revenue", "tags.tag_count"], dimensions: ["tags.tag_name"] })));
    expect(c.sql).toContain(`with "orders measures" as (`);
    expect(c.joins.map((j) => [j.part, j.alias, j.through])).toEqual([
      ["orders", "orders.tag bridge", "bridge"],
      ["orders", "orders.tag", "target"],
    ]);
    // The unused tag has no order; order 4 has no tag, so its tag_count is null.
    expect(plain(await duck(file, c.sql))).toEqual([
      { tag_name: "gift", revenue: 3500, tag_count: 1 },
      { tag_name: "rush", revenue: 3000, tag_count: 1 },
      { tag_name: "unused", revenue: null, tag_count: 1 },
      { tag_name: "wholesale", revenue: 5000, tag_count: 1 },
      { tag_name: null, revenue: 4000, tag_count: null },
    ]);
  });

  test("a golden grouped through a bridge reads back the dedupe rule and that totals by tag can exceed the overall total", async () => {
    const { root } = await shop();
    const made = await semlayer(root, ["goldens", "new", "--name", "revenue_by_tag", "--question", "Revenue by tag?", "--request", JSON.stringify(BY_TAG)]);
    expect(made.err).toBe("");
    expect(made.code).toBe(0);
    const rb = await semlayer(root, ["readback", "--targets", "golden:revenue_by_tag"]);
    expect(rb.code).toBe(0);
    expect(rb.out).toContain("- Grouped through the bridge join orders.tag: Dedupe rule: distinct_pairs.");
    expect(rb.out).toContain("Totals by tag can add up to more than the overall total: an order with several tags counts in full under each of them, while the overall total counts it once.");
    expect((await semlayer(root, ["goldens", "new", "--name", "revenue_total", "--question", "Revenue?", "--request", JSON.stringify(req({ measures: ["orders.revenue"] }))])).code).toBe(0);
    const plainRb = await semlayer(root, ["readback", "--targets", "golden:revenue_total"]);
    expect(plainRb.out).not.toContain("bridge");
  });

  test("each hop of the bridge obeys the schema-pair rule: an undeclared crossing is refused, an approved pair allows it", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const col = (name: string, type: string) => ({ name, type, nullable: false, description: null });
    const tbl = (schema: string, name: string, cols: [string, string][]) => ({ schema, name, kind: "table", row_count: 5, description: null, primary_key: [], unique_keys: [], foreign_keys: [], columns: cols.map(([n, ty]) => col(n, ty)) });
    const tables = (bridgeSchema: string) => [
      tbl("sales", "orders", [["order_id", "integer"], ["customer_name", "text"], ["amount_cents", "integer"]]),
      tbl(bridgeSchema, "order_tags", [["order_id", "integer"], ["tag_id", "integer"], ["share", "integer"]]),
      tbl("crm", "tags", [["tag_id", "integer"], ["tag_name", "text"]]),
    ];
    const approvedPair = (p: { from: string; to: string; keys: { from: string; to: string }[] }) => {
      const pair = { ...p, status: "approved", approved_by: "Dana", approved_at: "2026-01-15" };
      return { ...pair, approved_hash: itemHash("schema-pair", pair) };
    };
    const write = (bridgeSchema: string, pair?: { keys: string }, status = "draft") => {
      mkdirSync(join(t.root, "snapshots"), { recursive: true });
      writeFileSync(join(t.root, "snapshots", "shop.json"), JSON.stringify({ snapshot_version: 1, source: "shop", dialect: "postgres", captured_at: "2026-01-15T12:00:00.000Z", method: "live", tables: tables(bridgeSchema) }));
      const [from, to] = pair?.keys.split("=") ?? [];
      writeYaml(join(t.root, "sources", "shop.yaml"), {
        source: "shop",
        dialect: "postgres",
        connection: { env: "SHOP_URL" },
        intake: { schemas: ["sales", "crm"], primary: "sales" },
        ...(pair ? { cross_schema: [approvedPair({ from: from!.startsWith("orders") ? "sales" : bridgeSchema, to: "crm", keys: [{ from: from!, to: to! }] })] } : {}),
      });
      const ms = models("sales", [bridgeJoin({}, { status })]);
      ms[1]!.table = "crm.tags";
      ms[2]!.table = `${bridgeSchema}.order_tags`;
      writeLayer(t.root, ms);
    };
    // The bridge in sales: the hop from the bridge to crm.tags crosses.
    write("sales");
    const r = refused(compileRequest(t.root, BY_TAG));
    expect(r.refusals.map((x) => x.code)).toEqual(["scope.cross_schema_undeclared"]);
    expect(r.refusals[0]!.message).toContain("joins sales.order_tags to crm.tags across schemas");
    write("sales", { keys: "order_tags.tag_id=tags.tag_id" });
    expect(compiled(compileRequest(t.root, BY_TAG)).warnings).toBeUndefined();
    // An approved join across an undeclared pair compiles with the warning of the hop that crosses.
    write("sales", undefined, "approved");
    const warned = compiled(compileRequest(t.root, BY_TAG)).warnings!;
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message.startsWith("join orders.tag joins sales.order_tags to crm.tags across schemas")).toBe(true);
    // The bridge in crm: the hop from sales.orders to the bridge crosses.
    write("crm");
    const first = refused(compileRequest(t.root, BY_TAG));
    expect(first.refusals[0]!.message).toContain("joins sales.orders to crm.order_tags across schemas");
    write("crm", { keys: "orders.order_id=order_tags.order_id" });
    expect(compileRequest(t.root, BY_TAG).ok).toBe(true);
  });
});

describe("bridge figures on postgres", () => {
  const schema = uniqueSchema("t_bridge");
  let db: SQL | undefined;
  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    db = new SQL({ url: PG_URL, max: 1 });
    await db.unsafe(`create schema ${schema}`);
    await db.unsafe(`set search_path to ${schema}`);
    for (const s of STATEMENTS) await db.unsafe(s);
    await db.unsafe("set search_path to default");
  });
  afterAll(async () => {
    if (!db) return;
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.close();
  });

  test.skipIf(!PG_URL)("each dedupe rule gives the hand-computed figures, equal to the hand-written query's, and the ungrouped total is unchanged", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "PG_URL" } });
    const run = async (sql: string, params: unknown[] = []) => plain(await db!.begin("read only", async (tx) => [...((await tx.unsafe(sql, params as never[])) as Row[])]));
    for (const [rule, expected] of RULES) {
      writeLayer(t.root, models(schema, [bridgeJoin(through(rule))]));
      const c = compiled(compileRequest(t.root, BY_TAG));
      const rows = await run(c.sql, c.params);
      expect({ rule, rows }).toEqual({ rule, rows: expected as unknown as Row[] });
      expect(await run(HAND[rule](schema))).toEqual(rows);
    }
    const ungrouped = compiled(compileRequest(t.root, req({ measures: ["orders.revenue", "orders.order_count"] })));
    writeLayer(t.root, models(schema, undefined));
    expect(compiled(compileRequest(t.root, req({ measures: ["orders.revenue", "orders.order_count"] }))).sql).toBe(ungrouped.sql);
    expect(await run(ungrouped.sql)).toEqual([{ revenue: 10500, order_count: 5 }]);
  });
});

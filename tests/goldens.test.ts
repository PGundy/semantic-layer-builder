import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { compareRows, currencyColumns, displayRows, goldenDraftFields, goldenPlan, twoDecimals } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import type { Golden, Metric, Model, QueryPlan } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const U = { ordered: false, tolerance: 0 };
const O = { ordered: true, tolerance: 0 };

describe("compareRows", () => {
  test("protected columns' values show as [protected] in every kind of difference", () => {
    const P = { tolerance: 0, protectedColumns: ["email"] };
    const e = [{ email: "a@x.com", n: 1 }];
    const ordered = compareRows(e, [{ email: "b@x.com", n: 2 }, { email: "c@x.com", n: 3 }], { ...P, ordered: true });
    expect(ordered.diffs).toEqual([
      "Expected 1 row, got 2 rows.",
      "Row 1, column email: expected [protected], got [protected].",
      "Row 1, column n: expected 1, got 2.",
      "Row 2: got {email: [protected], n: 3}, which is not expected.",
    ]);
    const unordered = compareRows(e, [{ email: "a@x.com", n: 2 }], { ...P, ordered: false });
    expect(unordered.diffs).toEqual(["Row 1 (email=[protected]), column n: expected 1, got 2."]);
    expect(compareRows([{ email: null, n: 1 }], [{ email: null, n: 2 }], { ...P, ordered: true }).diffs).toEqual(["Row 1, column n: expected 1, got 2."]);
  });

  test("identical rows pass", () => {
    expect(compareRows([{ a: 1, b: "x" }], [{ a: 1, b: "x" }], O)).toEqual({ ok: true, diffs: [] });
  });

  test("relative tolerance is inclusive at the edge and exact at zero", () => {
    expect(compareRows([{ v: 100 }], [{ v: 100.5 }], { ordered: true, tolerance: 0.005 }).ok).toBe(true);
    expect(compareRows([{ v: 100 }], [{ v: 100.51 }], { ordered: true, tolerance: 0.005 }).ok).toBe(false);
    expect(compareRows([{ v: -100 }], [{ v: -99.6 }], { ordered: true, tolerance: 0.005 }).ok).toBe(true);
    expect(compareRows([{ v: 0 }], [{ v: 0 }], { ordered: true, tolerance: 0.005 }).ok).toBe(true);
    expect(compareRows([{ v: 0 }], [{ v: 0.0001 }], { ordered: true, tolerance: 0.005 }).ok).toBe(false);
    expect(compareRows([{ v: 1 }], [{ v: 1.0000001 }], O).ok).toBe(false);
    const r = compareRows([{ v: 100 }], [{ v: 101 }], { ordered: true, tolerance: 0.005 });
    expect(r.diffs).toEqual(["Row 1, column v: expected 100, got 101."]);
  });

  test("numeric strings compare numerically with numbers; other strings exactly", () => {
    expect(compareRows([{ v: "104233.50" }], [{ v: 104233.5 }], O).ok).toBe(true);
    expect(compareRows([{ v: 12 }], [{ v: "12" }], O).ok).toBe(true);
    expect(compareRows([{ v: "1e3" }], [{ v: 1000 }], O).ok).toBe(true);
    expect(compareRows([{ v: "2025-01-01" }], [{ v: "2025-01-01" }], O).ok).toBe(true);
    expect(compareRows([{ v: "West" }], [{ v: "west" }], O).ok).toBe(false);
    expect(compareRows([{ v: "12a" }], [{ v: 12 }], O).ok).toBe(false);
    expect(compareRows([{ v: true }], [{ v: "true" }], O).ok).toBe(false);
  });

  test("two strings compare exactly unless both are canonical decimals", () => {
    expect(compareRows([{ zip: "02134", n: 1 }], [{ zip: "2134", n: 1 }], U).ok).toBe(false);
    expect(compareRows([{ v: " 12" }], [{ v: "12" }], O).ok).toBe(false);
    expect(compareRows([{ v: "1e3" }], [{ v: "1000" }], O).ok).toBe(false);
    expect(compareRows([{ v: "150.50" }], [{ v: "150.5" }], O).ok).toBe(true);
    expect(compareRows([{ v: "200.00" }], [{ v: "200.50" }], { ordered: true, tolerance: 0.005 }).ok).toBe(true);
    expect(compareRows([{ v: "200.00" }], [{ v: "200.50" }], O).ok).toBe(false);
  });

  test("big integers compare exactly at tolerance zero", () => {
    expect(compareRows([{ v: "9007199254740993" }], [{ v: 9007199254740992 }], O).ok).toBe(false);
    expect(compareRows([{ v: "9007199254740993" }], [{ v: "9007199254740992" }], O).ok).toBe(false);
    expect(compareRows([{ v: "9007199254740993" }], [{ v: 9007199254740993n }], O).ok).toBe(true);
    expect(compareRows([{ v: "123456789012345678901234567890" }], [{ v: "123456789012345678901234567890" }], O).ok).toBe(true);
  });

  test("objects compare regardless of key order", () => {
    expect(compareRows([{ v: { a: 1, b: 2 } }], [{ v: { b: 2, a: 1 } }], O).ok).toBe(true);
    expect(compareRows([{ v: { a: 1 } }], [{ v: { a: 2 } }], O).ok).toBe(false);
  });

  test("null equals only null", () => {
    expect(compareRows([{ v: null }], [{ v: null }], O).ok).toBe(true);
    expect(compareRows([{ v: null }], [{ v: 0 }], O).diffs).toEqual(["Row 1, column v: expected null, got 0."]);
    expect(compareRows([{ v: "" }], [{ v: null }], O).ok).toBe(false);
    expect(compareRows([{ v: "null" }], [{ v: null }], O).ok).toBe(false);
  });

  test("unordered ignores order; ordered does not", () => {
    const e = [
      { region: "east", n: 1 },
      { region: "west", n: 2 },
    ];
    const a = [
      { region: "west", n: 2 },
      { region: "east", n: 1 },
    ];
    expect(compareRows(e, a, U).ok).toBe(true);
    const ordered = compareRows(e, a, O);
    expect(ordered.ok).toBe(false);
    expect(ordered.diffs).toContain('Row 1, column region: expected "east", got "west".');
  });

  test("unordered pairs rows by their labels so a changed figure is one diff", () => {
    const e = [
      { region: "east", revenue: 10 },
      { region: "north", revenue: 5 },
      { region: "west", revenue: 20 },
    ];
    const a = [
      { region: "west", revenue: 21 },
      { region: "north", revenue: 5 },
      { region: "east", revenue: 10 },
    ];
    const r = compareRows(e, a, U);
    expect(r.diffs).toEqual(['Row 3 (region="west"), column revenue: expected 20, got 21.']);
  });

  test("unordered row numbers are positions in the inputs, not in a sorted copy", () => {
    const r = compareRows(
      [
        { region: "west", revenue: 20 },
        { region: "east", revenue: 10 },
      ],
      [
        { region: "east", revenue: 10 },
        { region: "west", revenue: 21 },
      ],
      U,
    );
    expect(r.diffs).toEqual(['Row 1 (region="west"), column revenue: expected 20, got 21.']);
    const m = compareRows([{ k: "z", n: 1 }, { k: "a", n: 1 }], [{ k: "y", n: 2 }, { k: "a", n: 1 }], U);
    expect(m.diffs).toEqual([
      'Row 1: expected {k: "z", n: 1}, but no result row matches it.',
      'Result row 1: got {k: "y", n: 2}, which is not expected.',
    ]);
  });

  test("with only numeric columns a changed figure is still one cell diff", () => {
    const r = compareRows(
      [
        { year: 2024, revenue: 20 },
        { year: 2025, revenue: 10 },
      ],
      [
        { year: 2025, revenue: 11 },
        { year: 2024, revenue: 20 },
      ],
      U,
    );
    expect(r.diffs).toEqual(["Row 2 (year=2025), column revenue: expected 10, got 11."]);
  });

  test("an unexpected row is described by its own columns", () => {
    expect(compareRows([], [{ a: 1 }], U).diffs).toContain("Result row 1: got {a: 1}, which is not expected.");
  });

  test("unordered reports missing and unexpected rows", () => {
    const r = compareRows([{ k: "a", n: 1 }, { k: "b", n: 2 }], [{ k: "a", n: 1 }, { k: "c", n: 3 }], U);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([
      'Row 2: expected {k: "b", n: 2}, but no result row matches it.',
      'Result row 2: got {k: "c", n: 3}, which is not expected.',
    ]);
  });

  test("row count differences are reported", () => {
    const r = compareRows([{ n: 1 }, { n: 2 }], [{ n: 1 }], O);
    expect(r.diffs).toEqual(["Expected 2 rows, got 1 row.", "Row 2: expected {n: 2}, but the results end before it."]);
    const extra = compareRows([{ n: 1 }], [{ n: 1 }, { n: 3 }], O);
    expect(extra.diffs).toEqual(["Expected 1 row, got 2 rows.", "Row 2: got {n: 3}, which is not expected."]);
  });

  test("column mismatches name missing and extra columns", () => {
    const r = compareRows([{ month: "2025-01", revenue: 1 }], [{ month: "2025-01", total: 1 }], O);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual(["Expected column revenue missing from the results.", "Result column total not in the expected rows."]);
  });

  test("reports at most ten diffs", () => {
    const e = Array.from({ length: 30 }, (_, i) => ({ i, v: i }));
    const a = Array.from({ length: 30 }, (_, i) => ({ i, v: i + 1000 }));
    const r = compareRows(e, a, O);
    expect(r.ok).toBe(false);
    expect(r.diffs.length).toBe(10);
    expect(r.diffs[9]).toBe("21 more differences not shown.");
  });

  test("empty on both sides passes", () => {
    expect(compareRows([], [], U).ok).toBe(true);
  });
});

describe("goldenPlan", () => {
  const golden: Golden = {
    name: "total",
    question: "What is the total?",
    request: { source: "wh" },
    sql: "select 1 as n\n",
    status: "draft",
  };

  test("builds a one-query plan with the golden id", () => {
    const plan = goldenPlan(golden, { source: "wh", dialect: "snowflake" });
    expect(plan).toEqual({
      command: "goldens",
      source: "wh",
      dialect: "snowflake",
      queries: [{ id: "golden:total", purpose: "What is the total?", sql: "select 1 as n" }],
    });
  });

  test("refuses write SQL", () => {
    expect(() => goldenPlan({ ...golden, sql: "delete from orders" }, { source: "wh", dialect: "duckdb" })).toThrow(/read-only/);
  });
});

const APPROVED = { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" };

function ordersModel(revenue: "draft" | "approved", region: "draft" | "approved" = "approved"): Model {
  return {
    model: "orders",
    source: "wh",
    table: "main.orders",
    status: "draft",
    dimensions: [
      { name: "region", expr: "region", type: "string", ...(region === "approved" ? APPROVED : { status: "draft" as const }) },
      { name: "created", expr: "created_at", type: "time", ...APPROVED },
    ],
    measures: [
      { name: "revenue", expr: "amount", agg: "sum", description: "Revenue.", ...(revenue === "approved" ? APPROVED : { status: "draft" as const }) },
      { name: "order_count", agg: "count", description: "Orders.", ...APPROVED },
    ],
    joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "id" }], relationship: "many_to_one", status: "draft" }],
  };
}

describe("goldenDraftFields", () => {
  const golden = (request: Golden["request"]): Golden => ({ name: "g", question: "?", request, sql: "select 1", status: "draft" });

  test("lists draft measures and dimensions from measures, dimensions, filters and order_by, once each", () => {
    const g = golden({
      source: "wh",
      measures: ["orders.revenue", "orders.order_count"],
      dimensions: ["orders.region", "orders.created:month"],
      filters: [{ field: "orders.region", op: "eq", value: "east" }],
      order_by: [{ field: "orders.revenue", direction: "desc" }],
    });
    expect(goldenDraftFields(g, [ordersModel("draft", "draft")], [])).toEqual(["wh.orders.revenue", "wh.orders.region"]);
    expect(goldenDraftFields(g, [ordersModel("approved")], [])).toEqual([]);
  });

  test("a metric lists itself when draft and the draft measures it combines", () => {
    const metrics: Metric[] = [
      { name: "aov", source: "wh", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", status: "draft" },
      { name: "net", source: "wh", type: "derived", expr: "{orders.revenue} - {orders.order_count}", ...APPROVED },
      { name: "aov", source: "lake", type: "ratio", numerator: "x.y", denominator: "x.z", ...APPROVED },
    ];
    expect(goldenDraftFields(golden({ source: "wh", measures: ["aov"] }), [ordersModel("draft")], metrics)).toEqual(["metric:aov", "wh.orders.revenue"]);
    expect(goldenDraftFields(golden({ source: "wh", measures: ["net"] }), [ordersModel("draft")], metrics)).toEqual(["wh.orders.revenue"]);
    expect(goldenDraftFields(golden({ source: "wh", measures: ["net"] }), [ordersModel("approved")], metrics)).toEqual([]);
  });

  test("a metric reference sl approve rejects (spaces in a placeholder or a ratio side) resolves to nothing", () => {
    const metrics: Metric[] = [
      { name: "spaced", source: "wh", type: "derived", expr: "{ orders.revenue } - {orders.order_count}", ...APPROVED },
      { name: "odd_ratio", source: "wh", type: "ratio", numerator: " orders.revenue", denominator: "orders.order_count", ...APPROVED },
    ];
    expect(goldenDraftFields(golden({ source: "wh", measures: ["spaced"] }), [ordersModel("draft")], metrics)).toEqual([]);
    expect(goldenDraftFields(golden({ source: "wh", measures: ["odd_ratio"] }), [ordersModel("draft")], metrics)).toEqual([]);
  });

  test("malformed models and metrics are skipped, not thrown on", () => {
    const g = golden({ source: "wh", measures: ["orders.revenue", "aov"], dimensions: ["orders.region"] });
    const badDims = { ...ordersModel("draft", "draft"), dimensions: {} } as unknown as Model;
    const nullItem = { ...ordersModel("draft", "draft"), measures: [null] } as unknown as Model;
    expect(goldenDraftFields(g, [badDims], [])).toEqual([]);
    expect(goldenDraftFields(g, [nullItem], [])).toEqual([]);
    expect(goldenDraftFields(g, [null as unknown as Model, ordersModel("draft")], "x" as unknown as Metric[])).toEqual(["wh.orders.revenue"]);
    expect(goldenDraftFields(g, "x" as unknown as Model[], [null as unknown as Metric])).toEqual([]);
    const noDims = { ...ordersModel("draft"), dimensions: null } as unknown as Model;
    expect(goldenDraftFields(g, [noDims], [])).toEqual(["wh.orders.revenue"]);
  });

  test("unknown references, other sources, joins and malformed requests are left to validate", () => {
    const other: Model = { ...ordersModel("draft"), source: "lake" };
    expect(goldenDraftFields(golden({ source: "wh", measures: ["orders.revenue"] }), [other], [])).toEqual([]);
    expect(goldenDraftFields(golden({ source: "wh", measures: ["orders.nope", "nope", "orders.customer", "Bad Ref"] }), [ordersModel("draft")], [])).toEqual([]);
    expect(goldenDraftFields({ ...golden({ source: "wh" }), request: undefined as unknown as Golden["request"] }, [], [])).toEqual([]);
    expect(goldenDraftFields(golden({ source: "wh", measures: "orders.revenue" as unknown as string[], filters: [null as never] }), [ordersModel("draft")], [])).toEqual([]);
  });
});

const GOLDEN_YAML = `# Revenue by region, as Finance reports it in the Q1 pack.
name: revenue_by_region
question: What was revenue by region?
role: analyst
request:
  source: wh
  measures: [orders.revenue]
  dimensions: [orders.region]
sql: |
  select region, sum(amount) as revenue, count(*) as orders
  from orders
  group by region
reference: Finance Q1 pack. # keep this note
status: draft
`;

const ORDERS = [
  "create table orders (id integer, region varchar, amount decimal(10,2))",
  "insert into orders values (1, 'east', 100.00), (2, 'east', 50.50), (3, 'west', 200.00), (4, 'north', 10.25)",
];

async function setup(goldenYaml = GOLDEN_YAML, statements = ORDERS) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", statements);
  const goldenPath = join(t.root, "goldens", "revenue_by_region.yaml");
  writeFileSync(goldenPath, goldenYaml);
  return { ...t, goldenPath };
}

async function mutate(dbPath: string, sql: string): Promise<void> {
  const instance = await DuckDBInstance.create(dbPath);
  const c = await instance.connect();
  await c.run(sql);
  c.closeSync();
  instance.closeSync();
}

describe("goldens CLI on duckdb", () => {
  test("run, confirm, check, then a data change fails the check", async () => {
    const t = await setup();

    const run = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region", "--json"]);
    expect(run.code).toBe(0);
    const ran = run.json<{ name: string; columns: string[]; rows: Record<string, unknown>[] }>();
    expect(ran.name).toBe("revenue_by_region");
    expect(ran.columns).toEqual(["region", "revenue", "orders"]);
    expect(ran.rows).toHaveLength(3);
    expect(ran.rows).toContainEqual({ region: "east", revenue: 150.5, orders: 2 });

    const human = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("west");
    expect(human.out).toContain("(3 rows)");
    expect(human.out).toContain(
      "Confirm only once its measures are approved and the owner says these rows match a figure they trust: " +
        'sl goldens confirm --name revenue_by_region --by "<owner>" --tolerance <agreed tolerance>.',
    );
    expect(human.out).not.toContain("Already confirmed");

    const confirm = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana Ruiz", "--json"]);
    expect(confirm.code).toBe(0);
    const confirmed = confirm.json<{ name: string; rows: unknown[]; written: boolean }>();
    expect(confirmed.written).toBe(true);
    expect(confirmed.rows).toHaveLength(3);

    const text = readFileSync(t.goldenPath, "utf8");
    expect(text).toContain("# Revenue by region, as Finance reports it in the Q1 pack.");
    expect(text).toContain("# keep this note");
    const saved = readYaml<Golden>(t.goldenPath);
    expect(saved.status).toBe("approved");
    expect(saved.confirmed_by).toBe("Dana Ruiz");
    expect(saved.confirmed_at).toBe("2026-01-15");
    expect(saved.expected?.tolerance).toBe(0.005);
    expect(saved.expected?.rows).toContainEqual({ region: "west", revenue: 200, orders: 1 });

    const rerun = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region"]);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain("Already confirmed; sl goldens check --name revenue_by_region compares these rows with the recorded ones.");
    expect(rerun.out).not.toContain("sl goldens confirm");

    const validate = await sl(t.root, ["validate", "--json"]);
    // The fixture has no models or access file; only the fields confirm writes are checked here.
    const written = validate
      .json<{ issues: { file: string; path: string }[] }>()
      .issues.filter((i) => i.file.startsWith("goldens/") && /^(expected|status|confirmed|$)/.test(i.path));
    expect(written).toEqual([]);

    const pass = await sl(t.root, ["goldens", "check", "--json"]);
    expect(pass.code).toBe(0);
    expect(pass.json()).toEqual({ passed: 1, failed: 0, results: [{ name: "revenue_by_region", ok: true, diffs: [] }] });

    const passHuman = await sl(t.root, ["goldens", "check"]);
    expect(passHuman.out).toContain("pass  revenue_by_region");

    // A change inside the tolerance still passes; a larger one fails with the cell named.
    await mutate(join(t.dir, "wh.duckdb"), "update orders set amount = 200.50 where id = 3");
    expect((await sl(t.root, ["goldens", "check"])).code).toBe(0);
    await mutate(join(t.dir, "wh.duckdb"), "update orders set amount = 250.00 where id = 3");
    const fail = await sl(t.root, ["goldens", "check", "--json"]);
    expect(fail.code).toBe(1);
    const failed = fail.json<{ passed: number; failed: number; results: { name: string; ok: boolean; diffs: string[] }[] }>();
    expect(failed.failed).toBe(1);
    const westRow = saved.expected!.rows.findIndex((r) => r.region === "west") + 1;
    expect(failed.results[0]!.diffs).toEqual([`Row ${westRow} (region="west"), column revenue: expected 200, got 250.`]);

    const failHuman = await sl(t.root, ["goldens", "check", "--name", "revenue_by_region"]);
    expect(failHuman.code).toBe(1);
    expect(failHuman.out).toContain("FAIL  revenue_by_region");
    expect(failHuman.out).toContain("expected 200, got 250");
  });

  test("an ordered golden compares row by row", async () => {
    const ordered = GOLDEN_YAML.replace("  dimensions: [orders.region]\n", "  dimensions: [orders.region]\n  order_by: [{ field: orders.region }]\n").replace(
      "group by region",
      "group by region order by region",
    );
    const t = await setup(ordered);
    expect((await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"])).code).toBe(0);
    expect((await sl(t.root, ["goldens", "check"])).code).toBe(0);
    const reversed = readFileSync(t.goldenPath, "utf8").replace("order by region", "order by region desc");
    writeFileSync(t.goldenPath, reversed);
    const r = await sl(t.root, ["goldens", "check", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json<{ results: { diffs: string[] }[] }>().results[0]!.diffs[0]).toBe('Row 1, column region: expected "east", got "west".');
  });

  test("confirm refuses more than 200 rows without --force", async () => {
    const big = GOLDEN_YAML.replace(
      "select region, sum(amount) as revenue, count(*) as orders\n  from orders\n  group by region",
      "select range as id from range(201)",
    );
    const t = await setup(big);
    const refused = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("201 rows, more than 200");
    expect(readYaml<Golden>(t.goldenPath).status).toBe("draft");
    const forced = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--force", "--json"]);
    expect(forced.code).toBe(0);
    expect(forced.json<{ rows: unknown[] }>().rows).toHaveLength(201);
  });

  test("write SQL is refused", async () => {
    const t = await setup(GOLDEN_YAML.replace(/sql: \|\n(  .*\n)+/, "sql: delete from orders\n"));
    const r = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("read-only");
    const emit = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region", "--emit-sql"]);
    expect(emit.code).toBe(1);
  });

  test("confirm lists the draft fields the request uses before recording, and JSON carries them", async () => {
    const t = await setup();
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), ordersModel("draft"));
    const human = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(human.code).toBe(0);
    const notice = human.out.indexOf("This golden's request uses draft field(s): wh.orders.revenue.");
    expect(notice).toBe(0);
    expect(human.out).toContain(
      "Approve each field after its readback, then run sl goldens check --name revenue_by_region; if it passes the recorded rows stand, " +
        "and only changed rows need a new confirm. sl validate warns until then.",
    );
    expect(human.out).not.toContain("rests on draft definitions");
    expect(human.out.indexOf("Recorded 3 expected rows")).toBeGreaterThan(notice);
    expect(human.out).toContain("(tolerance 0)");

    const json = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--json"]);
    expect(json.code).toBe(0);
    expect(json.json<{ draft_fields: string[]; tolerance: number }>()).toMatchObject({ draft_fields: ["wh.orders.revenue"], tolerance: 0 });

    // The approved golden on a draft field: validate says how to keep its recorded rows.
    const validate = await sl(t.root, ["validate", "--json"]);
    const warning = validate.json<{ issues: { path: string; message: string }[] }>().issues.find((i) => i.path === "request.measures[0]");
    expect(warning?.message).toContain(
      "approve it after its readback, then run sl goldens check --name revenue_by_region; if it passes the recorded rows stand, and only changed rows need a new confirm",
    );

    writeYaml(join(t.root, "models", "wh", "orders.yaml"), ordersModel("approved"));
    // Once the field is approved, the recorded rows stand when the check passes.
    const check = await sl(t.root, ["goldens", "check", "--name", "revenue_by_region"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain("1 passed, 0 failed.");
    const clean = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(clean.out).not.toContain("draft field");
    expect(clean.out).toContain("(tolerance 0)");
    const cleanJson = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(cleanJson.json<{ draft_fields: string[] }>().draft_fields).toEqual([]);
  });

  test("confirm records the rows when models or metrics.yaml are malformed, noting the files it could not read", async () => {
    const t = await setup();
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), ordersModel("draft"));
    writeFileSync(join(t.root, "metrics.yaml"), 'metrics: "x"\n');
    const nonArray = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(nonArray.code).toBe(0);
    expect(nonArray.out).toContain("draft field(s): wh.orders.revenue.");
    expect(nonArray.out).toContain("Recorded 3 expected rows");
    expect(nonArray.err).not.toContain("TypeError");

    writeYaml(join(t.root, "models", "wh", "orders.yaml"), { ...ordersModel("draft"), dimensions: {} });
    const badDims = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(badDims.code).toBe(0);
    expect(badDims.out).not.toContain("draft field");
    expect(badDims.err).not.toContain("TypeError");

    writeYaml(join(t.root, "models", "wh", "orders.yaml"), ordersModel("draft"));
    writeFileSync(join(t.root, "models", "wh", "broken.yaml"), "model: [unclosed\n");
    writeFileSync(join(t.root, "metrics.yaml"), "metrics: [\n");
    const broken = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(broken.code).toBe(0);
    expect(broken.json<{ written: boolean; draft_fields: string[] }>()).toMatchObject({ written: true, draft_fields: ["wh.orders.revenue"] });
    expect(broken.err).toContain("Could not read models/wh/broken.yaml, metrics.yaml to list draft fields (");
    expect(broken.err).toContain("run sl validate.");
    expect(readYaml<Golden>(join(t.root, "goldens", "revenue_by_region.yaml")).status).toBe("approved");
  });

  test("confirm notes request fields the layer does not have yet before recording", async () => {
    const t = await setup();
    const r = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain('Golden "revenue_by_region" names fields the layer does not have yet');
    expect(r.err).toContain("request.measures[0]");
  });

  test("confirming again with a new --tolerance re-records the rows; without it the file's tolerance is kept", async () => {
    const t = await setup();
    const first = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana"]);
    expect(first.out).toContain("(tolerance 0.005, the default; agree one with the owner and pass --tolerance)");
    await mutate(join(t.dir, "wh.duckdb"), "update orders set amount = 300.00 where id = 3");
    const again = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Lee", "--tolerance", "0"]);
    expect(again.code).toBe(0);
    const saved = readYaml<Golden>(t.goldenPath);
    expect(saved.expected?.tolerance).toBe(0);
    expect(saved.expected?.rows).toContainEqual({ region: "west", revenue: 300, orders: 1 });
    expect(saved.confirmed_by).toBe("Lee");
    const kept = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Lee"]);
    expect(kept.out).toContain("(tolerance 0, kept from the file)");
    expect(readYaml<Golden>(t.goldenPath).expected?.tolerance).toBe(0);
  });

  test("a SQL error from the database is a plain user error in run, confirm and check", async () => {
    const t = await setup(GOLDEN_YAML.replace("from orders\n", "from no_such_table\n"));
    for (const sub of ["run", "confirm"]) {
      const r = await sl(t.root, ["goldens", sub, "--name", "revenue_by_region", "--by", "Dana"]);
      expect(r.code).toBe(1);
      expect(r.err).toStartWith(`sl goldens: Query failed: `);
      expect(r.err).toContain("no_such_table");
      expect(r.err).not.toContain("unexpected error");
      expect(r.err).not.toMatch(/\n\s+at /);
    }
    expect(readYaml<Golden>(t.goldenPath).status).toBe("draft");

    const g = readYaml<Golden>(t.goldenPath);
    writeYaml(t.goldenPath, { ...g, status: "approved", confirmed_by: "Dana", confirmed_at: "2026-01-15", expected: { tolerance: 0, rows: [{ n: 1 }] } });
    const check = await sl(t.root, ["goldens", "check", "--json"]);
    expect(check.code).toBe(1);
    const diff = check.json<{ results: { diffs: string[] }[] }>().results[0]!.diffs[0]!;
    expect(diff).toStartWith("The query did not run: ");
    expect(diff).not.toContain("Query failed");
    expect(diff).toContain("no_such_table");
  });

  test("usage errors are user errors", async () => {
    const t = await setup();
    expect((await sl(t.root, ["goldens"])).code).toBe(1);
    expect((await sl(t.root, ["goldens", "nope"])).code).toBe(1);
    expect((await sl(t.root, ["goldens", "run"])).err).toContain("--name");
    expect((await sl(t.root, ["goldens", "run", "--name", "missing"])).err).toContain('No golden "missing"');
    expect((await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region"])).err).toContain("--by");
    const tol = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "D", "--tolerance", "abc"]);
    expect(tol.code).toBe(1);
    expect(tol.err).toContain("--tolerance");
    const draftCheck = await sl(t.root, ["goldens", "check", "--name", "revenue_by_region"]);
    expect(draftCheck.code).toBe(1);
    expect(draftCheck.err).toContain("no expected rows");
    const none = await sl(t.root, ["goldens", "check", "--json"]);
    expect(none.code).toBe(0);
    expect(none.json()).toEqual({ passed: 0, failed: 0, results: [] });
  });
});

describe("currency display", () => {
  test("twoDecimals shows figures to two decimals and leaves other values alone", () => {
    expect(twoDecimals(55448.3)).toBe("55448.30");
    expect(twoDecimals(134.4577)).toBe("134.46");
    expect(twoDecimals(12n)).toBe("12.00");
    expect(twoDecimals("150.5")).toBe("150.50");
    expect(twoDecimals("-7")).toBe("-7.00");
    expect(twoDecimals("98765432109876543.21")).toBe("98765432109876543.21");
    expect(twoDecimals("1.239")).toBe("1.24");
    expect(twoDecimals(null)).toBeNull();
    expect(twoDecimals("east")).toBe("east");
    expect(twoDecimals(Number.NaN)).toBeNaN();
  });

  test("twoDecimals rounds on the decimal digits, half away from zero, without a float", () => {
    expect(twoDecimals(2.675)).toBe("2.68");
    expect(twoDecimals("2.675")).toBe("2.68");
    expect(twoDecimals("1.005")).toBe("1.01");
    expect(twoDecimals(1.005)).toBe("1.01");
    expect(twoDecimals(-0.001)).toBe("0.00");
    expect(twoDecimals("-0.001")).toBe("0.00");
    expect(twoDecimals(-0.005)).toBe("-0.01");
    expect(twoDecimals("98765432109876543.219")).toBe("98765432109876543.22");
    expect(twoDecimals("99.995")).toBe("100.00");
    expect(twoDecimals("-9.999")).toBe("-10.00");
    expect(twoDecimals(1e21)).toBe("1000000000000000000000.00");
    expect(twoDecimals(1.5e-7)).toBe("0.00");
    expect(twoDecimals(5e-3)).toBe("0.01");
    expect(twoDecimals(" +1.5e2 ")).toBe("150.00");
    expect(twoDecimals(".125")).toBe("0.13");
    expect(twoDecimals("007.1")).toBe("7.10");
    expect(twoDecimals(-0)).toBe("0.00");
  });

  test("currencyColumns names the result columns of currency measures and metrics; displayRows copies the rows", () => {
    const model = ordersModel("approved");
    model.measures[0]!.format = "currency";
    const metrics: Metric[] = [
      { name: "aov", source: "wh", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", format: "currency", status: "draft" },
      { name: "share", source: "wh", type: "derived", expr: "{orders.revenue}", format: "percent", status: "draft" },
    ];
    const g: Golden = {
      name: "g",
      question: "?",
      request: { source: "wh", measures: ["orders.revenue", "orders.order_count", "aov", "share"], dimensions: ["orders.region"] },
      sql: "select 1",
      status: "draft",
    };
    const columns = ["region", "REVENUE", "order_count", "aov", "share"];
    expect(currencyColumns(g, [model], metrics, columns)).toEqual(["REVENUE", "aov"]);
    expect(currencyColumns({ ...g, request: { ...g.request, source: "lake" } }, [model], metrics, columns)).toEqual([]);
    const rows = [{ region: "east", REVENUE: 150.5, order_count: 2, aov: 75.25, share: 0.5 }];
    expect(displayRows(rows, ["REVENUE", "aov"])).toEqual([{ region: "east", REVENUE: "150.50", order_count: 2, aov: "75.25", share: 0.5 }]);
    expect(rows[0]!.REVENUE).toBe(150.5);
  });

  test("goldens run and confirm print currency measures to two decimals; JSON and the recorded rows keep the figures", async () => {
    const t = await setup();
    const model = ordersModel("approved");
    model.measures[0]!.format = "currency";
    model.measures[0]!.currency = "USD";
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), model);
    const run = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/east\s+150\.50\s+2\n/);
    expect(run.out).toMatch(/west\s+200\.00\s+1\n/);
    const json = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region", "--json"]);
    expect(json.json<{ rows: unknown[] }>().rows).toContainEqual({ region: "east", revenue: 150.5, orders: 2 });
    const confirm = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(confirm.code).toBe(0);
    expect(confirm.out).toMatch(/north\s+10\.25\s+1\n/);
    expect(confirm.out).toMatch(/east\s+150\.50\s+2\n/);
    expect(readYaml<Golden>(t.goldenPath).expected?.rows).toContainEqual({ region: "east", revenue: 150.5, orders: 2 });
  });
});

describe("goldens confirm: who it ran as", () => {
  test("confirm records confirmed_as with the golden's role and user, and rewrites it on a new confirm", async () => {
    const t = await setup(GOLDEN_YAML.replace("role: analyst\n", "role: analyst\nuser:\n  region: east\n"));
    const r = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ confirmed_as: unknown }>().confirmed_as).toEqual({ role: "analyst", user: { region: "east" } });
    expect(readYaml<Golden>(t.goldenPath).confirmed_as).toEqual({ role: "analyst", user: { region: "east" } });

    writeFileSync(t.goldenPath, readFileSync(t.goldenPath, "utf8").replace("role: analyst\nuser:\n  region: east\n", ""));
    expect((await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana"])).code).toBe(0);
    const saved = readYaml<Golden>(t.goldenPath);
    expect(saved.role).toBeUndefined();
    expect(saved.confirmed_as).toEqual({});
    // The written fields pass the schema.
    const validate = await sl(t.root, ["validate", "--json"]);
    const issues = validate.json<{ issues: { file: string; path: string }[] }>().issues.filter((i) => i.file.startsWith("goldens/") && i.path.startsWith("confirmed"));
    expect(issues).toEqual([]);
  });

  test("confirm warns when the golden's role is defined only in a draft access.yaml", async () => {
    const t = await setup();
    const access = { status: "draft", roles: [{ name: "analyst", allow: { models: ["wh.*"] } }] };
    writeYaml(join(t.root, "access.yaml"), access);
    const human = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0"]);
    expect(human.code).toBe(0);
    const warning =
      'Golden "revenue_by_region" runs as role analyst, which is defined only in a draft access.yaml: its rules may still change before ' +
      "access is approved. Confirm a golden that runs as a role after access.yaml is approved; confirmed now, rerun sl goldens check " +
      "--name revenue_by_region and read it back to the owner after every change to role analyst.";
    expect(human.err).toContain(warning);
    expect(human.out).toContain("Recorded 3 expected rows");
    const json = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(json.json<{ warnings: string[] }>().warnings).toEqual([warning]);

    // Approved access.yaml: no warning.
    writeYaml(join(t.root, "access.yaml"), { ...access, status: "approved", approved_by: "Dana", approved_at: "2026-01-15" });
    const approved = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(approved.json<{ warnings: string[] }>().warnings).toEqual([]);

    // A golden without a role runs as the draft file's default_role.
    writeYaml(join(t.root, "access.yaml"), { ...access, default_role: "analyst" });
    writeFileSync(t.goldenPath, readFileSync(t.goldenPath, "utf8").replace("role: analyst\n", ""));
    const byDefault = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(byDefault.json<{ warnings: string[] }>().warnings[0]).toContain("runs as role analyst (access.yaml's default_role), which is defined only in a draft access.yaml");

    // No role at all, or one the draft file does not define: no warning.
    writeYaml(join(t.root, "access.yaml"), access);
    const none = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--tolerance", "0", "--json"]);
    expect(none.json<{ warnings: string[] }>().warnings).toEqual([]);
  });
});

describe("goldens CLI on a snowflake source", () => {
  test("emit-sql prints the plan and --results finishes run, confirm and check", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "snowflake", connection: { env: "WH_URL" } });
    const goldenPath = join(t.root, "goldens", "revenue_by_region.yaml");
    writeFileSync(goldenPath, GOLDEN_YAML);

    const live = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region"]);
    expect(live.code).toBe(1);
    expect(live.err).toContain("--emit-sql");

    const emit = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region", "--emit-sql"]);
    expect(emit.code).toBe(0);
    const plan = emit.json<QueryPlan>();
    expect(plan.dialect).toBe("snowflake");
    expect(plan.queries.map((q) => q.id)).toEqual(["golden:revenue_by_region"]);
    expect(plan.queries[0]!.sql).toContain("group by region");

    const resultsFile = join(t.dir, "results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        "golden:revenue_by_region": [
          { REGION: "east", REVENUE: "150.50", ORDERS: 2 },
          { REGION: "west", REVENUE: "200.00", ORDERS: 1 },
        ],
      }),
    );
    const run = await sl(t.root, ["goldens", "run", "--name", "revenue_by_region", "--results", resultsFile, "--json"]);
    expect(run.code).toBe(0);
    expect(run.json<{ columns: string[] }>().columns).toEqual(["region", "revenue", "orders"]);

    const confirm = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana", "--results", resultsFile]);
    expect(confirm.code).toBe(0);
    expect(readFileSync(goldenPath, "utf8")).toContain("# keep this note");

    const checkEmit = await sl(t.root, ["goldens", "check", "--emit-sql"]);
    expect(checkEmit.code).toBe(0);
    expect(checkEmit.json<QueryPlan>().queries.map((q) => q.id)).toEqual(["golden:revenue_by_region"]);

    const noResults = await sl(t.root, ["goldens", "check"]);
    expect(noResults.code).toBe(1);
    expect(noResults.err).toContain("--results");

    // Numbers come back as numbers from another tool; they still match the confirmed numeric strings.
    writeFileSync(
      resultsFile,
      JSON.stringify({
        "golden:revenue_by_region": [
          { region: "west", revenue: 200, orders: 1 },
          { region: "east", revenue: 150.5, orders: 2 },
        ],
      }),
    );
    const check = await sl(t.root, ["goldens", "check", "--results", resultsFile, "--json"]);
    expect(check.code).toBe(0);
    expect(check.json<{ passed: number }>().passed).toBe(1);
  });
});

describe("goldens CLI safety and resilience", () => {
  test("a --name that is not a golden name is refused and nothing is written", async () => {
    const t = await setup();
    const outside = join(t.root, "..", "evil.yaml");
    writeFileSync(outside, GOLDEN_YAML.replace("name: revenue_by_region", "name: evil"));
    const before = readFileSync(outside, "utf8");
    for (const name of ["../evil", "../../evil", "Revenue", "a/b"]) {
      const r = await sl(t.root, ["goldens", "confirm", "--name", name, "--by", "X", "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("not a golden name");
      expect((await sl(t.root, ["goldens", "run", "--name", name])).code).toBe(1);
      expect((await sl(t.root, ["goldens", "check", "--name", name])).code).toBe(1);
    }
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  test("a golden whose name differs from its file name is refused", async () => {
    const t = await setup(GOLDEN_YAML.replace("name: revenue_by_region", "name: other"));
    const r = await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "X"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('must match the file name, "revenue_by_region"');
    expect(readYaml<Golden>(t.goldenPath).status).toBe("draft");
  });

  test("check reports a golden whose source cannot load and still checks the rest", async () => {
    const t = await setup();
    expect((await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana"])).code).toBe(0);
    const broken = GOLDEN_YAML.replace("name: revenue_by_region", "name: broken").replace("source: wh", "source: gone");
    writeFileSync(join(t.root, "goldens", "broken.yaml"), broken.replace("status: draft", "status: approved"));
    const r = await sl(t.root, ["goldens", "check", "--json"]);
    expect(r.code).toBe(1);
    const doc = r.json<{ passed: number; failed: number; results: { name: string; ok: boolean; diffs: string[] }[] }>();
    expect(doc.passed).toBe(1);
    expect(doc.failed).toBe(1);
    expect(doc.results.map((x) => [x.name, x.ok])).toEqual([
      ["broken", false],
      ["revenue_by_region", true],
    ]);
    expect(doc.results[0]!.diffs[0]).toContain("Cannot load its source");
    expect(doc.results[0]!.diffs[0]).toContain("gone");
  });

  test("check refuses --source together with --name", async () => {
    const t = await setup();
    expect((await sl(t.root, ["goldens", "confirm", "--name", "revenue_by_region", "--by", "Dana"])).code).toBe(0);
    const r = await sl(t.root, ["goldens", "check", "--name", "revenue_by_region", "--source", "zzz"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not both");
  });

  test("a hand-written expected block with no tolerance is checked at half a percent", async () => {
    const t = await setup();
    const handWritten = GOLDEN_YAML.replace("status: draft", "status: approved").concat(
      "expected:\n  rows:\n    - { region: east, revenue: 150.0, orders: 2 }\n    - { region: west, revenue: 200, orders: 1 }\n    - { region: north, revenue: 10.25, orders: 1 }\n",
    );
    writeFileSync(t.goldenPath, handWritten);
    const r = await sl(t.root, ["goldens", "check", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ passed: number }>().passed).toBe(1);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { compareRows, goldenPlan } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import type { Golden, QueryPlan } from "../skills/semantic-layer/scripts/lib/types.ts";
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

// How a golden's rows compare (docs/PRD-hardening.md HR-2): the request's grouping columns and any
// two whole numbers compare exactly, whatever the tolerance; the tolerance applies to the other
// figures; an unordered comparison pairs rows by the grouping columns. All data is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { SQL } from "bun";
import { compareRows, compileGolden, groupingColumns, valuesEqual } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import type { Golden, Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, confirmWithYes, duckdbSource, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const HALF_PERCENT = 0.005;
const YEAR = ["year"];
const unordered = (tolerance: number, groupingColumns?: string[]) => ({ ordered: false, tolerance, ...(groupingColumns ? { groupingColumns } : {}) });
const ordered = (tolerance: number, groupingColumns?: string[]) => ({ ordered: true, tolerance, ...(groupingColumns ? { groupingColumns } : {}) });

describe("grouping columns compare exactly", () => {
  // 2024 and 2025 are 0.05% apart, inside any usual tolerance.
  const expected = [
    { year: 2024, revenue: 1500.5 },
    { year: 2025, revenue: 3000.75 },
  ];
  const swapped = [
    { year: 2025, revenue: 1500.5 },
    { year: 2024, revenue: 3000.75 },
  ];

  test("swapped years fail, and each difference is reported against its own year", () => {
    const r = compareRows(expected, swapped, unordered(HALF_PERCENT, YEAR));
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual(["Row 1 (year=2024), column revenue: expected 1500.5, got 3000.75.", "Row 2 (year=2025), column revenue: expected 3000.75, got 1500.5."]);
    expect(compareRows(expected, [swapped[1]!, swapped[0]!], unordered(HALF_PERCENT, YEAR)).ok).toBe(false);
    expect(compareRows(expected, [expected[1]!, expected[0]!], unordered(HALF_PERCENT, YEAR))).toEqual({ ok: true, diffs: [] });
  });

  test("an ordered comparison says the grouping column compared exactly", () => {
    const r = compareRows(expected, swapped, ordered(HALF_PERCENT, YEAR));
    expect(r.diffs).toEqual([
      "Row 1, column year: expected 2024, got 2025 (grouping columns compare exactly).",
      "Row 2, column year: expected 2025, got 2024 (grouping columns compare exactly).",
    ]);
    // At tolerance 0 every cell compares exactly, so no difference explains itself.
    expect(compareRows(expected, swapped, ordered(0, YEAR)).diffs).toEqual(["Row 1, column year: expected 2024, got 2025.", "Row 2, column year: expected 2025, got 2024."]);
  });

  test("a grouping value that is not a whole number compares exactly too, whatever the tolerance", () => {
    const e = [{ price_band: 9.99, orders: 12.5 }];
    const a = [{ price_band: 10.01, orders: 12.5 }];
    expect(compareRows(e, a, unordered(HALF_PERCENT)).ok).toBe(true);
    const r = compareRows(e, a, unordered(HALF_PERCENT, ["price_band"]));
    expect(r.diffs).toEqual([
      "Row 1: expected {price_band: 9.99, orders: 12.5}, but no result row matches it (grouping columns compare exactly).",
      "Result row 1: got {price_band: 10.01, orders: 12.5}, which is not expected.",
    ]);
    expect(compareRows(e, a, ordered(0.9, ["price_band"])).diffs).toEqual(["Row 1, column price_band: expected 9.99, got 10.01 (grouping columns compare exactly)."]);
    // The same value written another way is still the same value.
    expect(compareRows([{ price_band: "9.990", orders: 1 }], [{ price_band: 9.99, orders: 1 }], unordered(HALF_PERCENT, ["price_band"])).ok).toBe(true);
    expect(compareRows([{ year: "2024", n: 1 }], [{ year: 2024n, n: 1 }], unordered(HALF_PERCENT, YEAR)).ok).toBe(true);
  });

  test("grouping columns are matched ignoring case, and a name the rows lack is ignored", () => {
    expect(compareRows(expected, swapped, unordered(HALF_PERCENT, ["YEAR"])).diffs).toHaveLength(2);
    expect(compareRows([{ v: 100.5 }], [{ v: 100.6 }], unordered(HALF_PERCENT, ["region"]))).toEqual({ ok: true, diffs: [] });
  });

  test("rows pair by the grouping columns before any other likeness", () => {
    // Every column is a figure, and each expected row shares two of its three cells with the other
    // year's result row: only the grouping column says which row is which.
    const e = [
      { year: 2024, revenue: 10.5, units: 3 },
      { year: 2025, revenue: 20.5, units: 4 },
    ];
    const a = [
      { year: 2024, revenue: 20.5, units: 4 },
      { year: 2025, revenue: 10.5, units: 3 },
    ];
    expect(compareRows(e, a, unordered(0)).diffs).toEqual([
      "Row 1 (revenue=10.5, units=3), column year: expected 2024, got 2025.",
      "Row 2 (revenue=20.5, units=4), column year: expected 2025, got 2024.",
    ]);
    expect(compareRows(e, a, unordered(0, YEAR)).diffs).toEqual([
      "Row 1 (year=2024), column revenue: expected 10.5, got 20.5.",
      "Row 1 (year=2024), column units: expected 3, got 4.",
      "Row 2 (year=2025), column revenue: expected 20.5, got 10.5.",
      "Row 2 (year=2025), column units: expected 4, got 3.",
    ]);
    // A text column that is a measure (a latest status) is not what the rows are paired by.
    const labelled = compareRows(
      [
        { year: 2024, latest: "open", revenue: 10.5 },
        { year: 2025, latest: "closed", revenue: 20.5 },
      ],
      [
        { year: 2024, latest: "closed", revenue: 10.5 },
        { year: 2025, latest: "open", revenue: 20.5 },
      ],
      unordered(0, YEAR),
    );
    expect(labelled.diffs).toEqual(['Row 2 (year=2025), column latest: expected "closed", got "open".', 'Row 1 (year=2024), column latest: expected "open", got "closed".']);
  });

  test("a protected grouping column stays masked in the differences (docs/PRD.md section 7, invariant 3)", () => {
    const opts = { ...unordered(HALF_PERCENT, ["email"]), protectedColumns: ["email"] };
    const paired = compareRows([{ email: "a@example.com", n: 1 }], [{ email: "a@example.com", n: 2 }], opts);
    expect(paired.diffs).toEqual(["Row 1 (email=[protected]), column n: expected 1, got 2 (whole numbers compare exactly)."]);
    const missing = compareRows([{ email: "a@example.com", n: 1 }], [{ email: "b@example.com", n: 1 }], opts);
    expect(missing.diffs).toEqual([
      "Row 1: expected {email: [protected], n: 1}, but no result row matches it (grouping columns compare exactly).",
      "Result row 1: got {email: [protected], n: 1}, which is not expected.",
    ]);
    const inOrder = compareRows([{ email: "a@example.com", n: 1 }], [{ email: "b@example.com", n: 1 }], { ...opts, ordered: true });
    expect(inOrder.diffs).toEqual(["Row 1, column email: expected [protected], got [protected] (grouping columns compare exactly)."]);
    expect(JSON.stringify([paired, missing, inOrder])).not.toContain("example.com");
  });

  test("a protected column's difference does not say its values are whole numbers (invariant 3)", () => {
    const opts = { ...ordered(HALF_PERCENT), protectedColumns: ["SSN"] };
    // The same line whether the masked values are whole numbers or not.
    const line = ["Row 1, column ssn: expected [protected], got [protected]."];
    expect(compareRows([{ ssn: 1000, n: 1 }], [{ ssn: 1001, n: 1 }], opts).diffs).toEqual(line);
    expect(compareRows([{ ssn: 1000.5, n: 1 }], [{ ssn: 1100.5, n: 1 }], opts).diffs).toEqual(line);
    expect(compareRows([{ ssn: "1000", n: 1 }], [{ ssn: "1001", n: 1 }], opts).diffs).toEqual(line);
    // The rule itself still holds for it, and an unprotected column on the same row still explains.
    expect(compareRows([{ ssn: 1000, n: 1 }], [{ ssn: 1001, n: 2 }], opts).diffs).toEqual([...line, "Row 1, column n: expected 1, got 2 (whole numbers compare exactly)."]);
    expect(compareRows([{ region: "east", ssn: 1000 }], [{ region: "east", ssn: 1001 }], { ...unordered(HALF_PERCENT), protectedColumns: ["ssn"] }).diffs).toEqual([
      'Row 1 (region="east"), column ssn: expected [protected], got [protected].',
    ]);
  });

  test("swapped years fail in either order and any spelling, at any tolerance, named as grouping columns or not", () => {
    const spellings: [unknown, unknown][] = [
      [2024, 2025],
      [2024n, 2025n],
      ["2024", "2025"],
    ];
    for (const tolerance of [0, HALF_PERCENT, 0.5, 0.99]) {
      for (const [y1, y2] of spellings) {
        // Figures more than 99% apart, so no tolerance below 1 pairs one year's figure with the other's.
        const e = [
          { year: y1, revenue: 1.5 },
          { year: y2, revenue: 30000.75 },
        ];
        const a = [
          { year: y2, revenue: 1.5 },
          { year: y1, revenue: 30000.75 },
        ];
        for (const opts of [ordered(tolerance), ordered(tolerance, YEAR), unordered(tolerance), unordered(tolerance, YEAR)]) {
          expect({ ...opts, y: String(y1), ok: compareRows(e, a, opts).ok }).toEqual({ ...opts, y: String(y1), ok: false });
        }
      }
    }
  });

  test("a year that moves with every figure unchanged fails", () => {
    const e = [{ year: 2024, revenue: 1500.5 }];
    const a = [{ year: 2025, revenue: 1500.5 }];
    expect(compareRows(e, a, unordered(HALF_PERCENT)).ok).toBe(false);
    expect(compareRows(e, a, unordered(HALF_PERCENT, YEAR)).diffs).toEqual([
      "Row 1: expected {year: 2024, revenue: 1500.5}, but no result row matches it (grouping columns compare exactly).",
      "Result row 1: got {year: 2025, revenue: 1500.5}, which is not expected.",
    ]);
  });

  test("a changed figure is reported against its own row among several, whatever the order of the results", () => {
    const e = [
      { region: "east", year: 2024, revenue: 10.5, orders: 7 },
      { region: "east", year: 2025, revenue: 20.5, orders: 8 },
      { region: "west", year: 2024, revenue: 30.5, orders: 9 },
      { region: "west", year: 2025, revenue: 40.5, orders: 10 },
    ];
    const a = [
      { region: "west", year: 2025, revenue: 40.5, orders: 11 },
      { region: "west", year: 2024, revenue: 30.5, orders: 9 },
      { region: "east", year: 2025, revenue: 99.5, orders: 8 },
      { region: "east", year: 2024, revenue: 10.5, orders: 7 },
    ];
    const opts = unordered(HALF_PERCENT, ["region", "year"]);
    const r = compareRows(e, a, opts);
    expect(r.diffs).toEqual([
      'Row 2 (region="east", year=2025), column revenue: expected 20.5, got 99.5.',
      'Row 4 (region="west", year=2025), column orders: expected 10, got 11 (whole numbers compare exactly).',
    ]);
    for (let i = 0; i < a.length; i++) {
      const rotated = [...a.slice(i), ...a.slice(0, i)];
      expect(compareRows(e, rotated, opts).diffs).toEqual(r.diffs);
      expect(compareRows(e, rotated.reverse(), unordered(HALF_PERCENT, ["YEAR", "Region"])).diffs).toEqual(r.diffs);
    }
  });

  test("a row never pairs with the result row of another grouping value, however alike their figures", () => {
    const e = [
      { year: 2024, revenue: 10.5 },
      { year: 2025, revenue: 10.5 },
    ];
    const a = [
      { year: 2025, revenue: 10.5 },
      { year: 2026, revenue: 10.5 },
    ];
    expect(compareRows(e, a, unordered(HALF_PERCENT, YEAR)).diffs).toEqual([
      "Row 1: expected {year: 2024, revenue: 10.5}, but no result row matches it (grouping columns compare exactly).",
      "Result row 2: got {year: 2026, revenue: 10.5}, which is not expected.",
    ]);
  });
});

describe("whole numbers compare exactly", () => {
  test("a count off by one fails at any tolerance, however the two sides spell it", () => {
    const spellings: [unknown, unknown][] = [
      [1000, 1001],
      [1000n, 1001n],
      ["1000", "1001"],
      [1000, "1001"],
      ["1000", 1001n],
      [1000n, 1001],
      [-1000, -1001],
    ];
    for (const tolerance of [0, 0.001, HALF_PERCENT, 0.5, 0.99]) {
      for (const [e, a] of spellings) {
        expect({ e: String(e), a: String(a), tolerance, equal: valuesEqual(e, a, tolerance) }).toEqual({ e: String(e), a: String(a), tolerance, equal: false });
        expect(compareRows([{ orders: e }], [{ orders: a }], unordered(tolerance)).ok).toBe(false);
        expect(compareRows([{ orders: e }], [{ orders: a }], ordered(tolerance)).ok).toBe(false);
      }
    }
    expect(valuesEqual(1000, "1000", 0.5)).toBe(true);
    expect(valuesEqual("1000", 1000n, 0.5)).toBe(true);
    // Either way round, and across zero.
    expect(valuesEqual(1001, 1000, 0.5)).toBe(false);
    expect(valuesEqual(0, 1, 0.9999)).toBe(false);
    expect(valuesEqual(-1, 1, 0.9999)).toBe(false);
    // Beyond the integers a float holds exactly, the digits still decide.
    expect(valuesEqual("9007199254740993", "9007199254740992", 0.5)).toBe(false);
    expect(valuesEqual("9007199254740993", 9007199254740993n, 0.5)).toBe(true);
  });

  test("the difference says whole numbers compare exactly, when the golden has a tolerance", () => {
    expect(compareRows([{ orders: 1000 }], [{ orders: 1001 }], ordered(HALF_PERCENT)).diffs).toEqual(["Row 1, column orders: expected 1000, got 1001 (whole numbers compare exactly)."]);
    expect(compareRows([{ orders: "1000" }], [{ orders: "1001" }], ordered(HALF_PERCENT)).diffs).toEqual([
      'Row 1, column orders: expected "1000", got "1001" (whole numbers compare exactly).',
    ]);
    expect(compareRows([{ region: "east", orders: 1000 }], [{ region: "east", orders: 1001 }], unordered(HALF_PERCENT)).diffs).toEqual([
      'Row 1 (region="east"), column orders: expected 1000, got 1001 (whole numbers compare exactly).',
    ]);
    expect(compareRows([{ orders: 1000 }], [{ orders: 1001 }], ordered(0)).diffs).toEqual(["Row 1, column orders: expected 1000, got 1001."]);
    // A figure with decimals outside the tolerance, and text, explain nothing: no rule made them exact.
    expect(compareRows([{ total: 1000.5 }], [{ total: 1100.5 }], ordered(HALF_PERCENT)).diffs).toEqual(["Row 1, column total: expected 1000.5, got 1100.5."]);
    expect(compareRows([{ region: "east" }], [{ region: "west" }], ordered(HALF_PERCENT)).diffs).toEqual(['Row 1, column region: expected "east", got "west".']);
  });

  test("a decimal total inside the tolerance passes and outside fails", () => {
    const within: [unknown, unknown][] = [
      [104233.5, 104240.25],
      ["104233.50", "104240.25"],
      ["104233.50", 104240.25],
      [104233.5, 104240],
      ["104233.50", "104240.00"],
    ];
    for (const [e, a] of within) {
      expect({ e, a, ok: compareRows([{ revenue: e }], [{ revenue: a }], unordered(HALF_PERCENT)).ok }).toEqual({ e, a, ok: true });
      expect({ e, a, ok: compareRows([{ revenue: e }], [{ revenue: a }], unordered(0)).ok }).toEqual({ e, a, ok: false });
    }
    const outside: [unknown, unknown][] = [
      [104233.5, 105000.25],
      ["104233.50", "105000.25"],
      [104233.5, 105000],
    ];
    for (const [e, a] of outside) expect({ e, a, ok: compareRows([{ revenue: e }], [{ revenue: a }], unordered(HALF_PERCENT)).ok }).toEqual({ e, a, ok: false });
  });

  test("100 against 100.0000001 follows the tolerance", () => {
    expect(compareRows([{ v: 100 }], [{ v: 100.0000001 }], ordered(HALF_PERCENT)).ok).toBe(true);
    expect(compareRows([{ v: 100 }], [{ v: 100.0000001 }], ordered(0)).ok).toBe(false);
    expect(compareRows([{ v: "100" }], [{ v: "100.0000001" }], ordered(HALF_PERCENT)).ok).toBe(true);
    expect(compareRows([{ v: 100n }], [{ v: 100.0000001 }], ordered(1e-12)).ok).toBe(false);
    expect(compareRows([{ v: 100.0000001 }], [{ v: 100 }], ordered(HALF_PERCENT)).ok).toBe(true);
    expect(valuesEqual(100n, "100.0000001", HALF_PERCENT)).toBe(true);
    expect(valuesEqual("100", "100.0000001", 0)).toBe(false);
  });

  test("a money total follows the tolerance only when a side has cents", () => {
    // The adapters return decimals as numbers, so a total with no cents on both sides is two whole numbers.
    expect(compareRows([{ revenue: 1200000 }], [{ revenue: 1200500 }], ordered(HALF_PERCENT)).diffs).toEqual([
      "Row 1, column revenue: expected 1200000, got 1200500 (whole numbers compare exactly).",
    ]);
    expect(compareRows([{ revenue: 1200000.4 }], [{ revenue: 1200500 }], ordered(HALF_PERCENT)).ok).toBe(true);
    expect(compareRows([{ revenue: 1200000.4 }], [{ revenue: 1206500 }], ordered(HALF_PERCENT)).ok).toBe(false);
  });

  test("a tolerance below zero reads as zero: nothing passes that differs, and nothing explains itself", () => {
    expect(compareRows([{ v: 1000 }], [{ v: 1001 }], ordered(-1)).diffs).toEqual(["Row 1, column v: expected 1000, got 1001."]);
    expect(compareRows([{ v: 1.5 }], [{ v: 1.5000001 }], ordered(-1)).ok).toBe(false);
  });

  test("a golden with no grouping columns named (a cross-check only) still fails on swapped years and on a count off by one", () => {
    const e = [
      { year: 2024, revenue: 1500.5, orders: 1000 },
      { year: 2025, revenue: 3000.75, orders: 1000 },
    ];
    const swapped = [
      { year: 2025, revenue: 1500.5, orders: 1000 },
      { year: 2024, revenue: 3000.75, orders: 1000 },
    ];
    expect(compareRows(e, swapped, unordered(HALF_PERCENT)).ok).toBe(false);
    expect(compareRows(e, swapped, ordered(HALF_PERCENT)).diffs).toEqual([
      "Row 1, column year: expected 2024, got 2025 (whole numbers compare exactly).",
      "Row 2, column year: expected 2025, got 2024 (whole numbers compare exactly).",
    ]);
    const offByOne = [e[0]!, { ...e[1]!, orders: 1001 }];
    expect(compareRows(e, offByOne, unordered(HALF_PERCENT)).diffs).toEqual(["Row 2 (year=2025, revenue=3000.75), column orders: expected 1000, got 1001 (whole numbers compare exactly)."]);
  });
});

describe("the grouping columns come from the compiled request", () => {
  const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

  test("every Acme golden's dimensions and time grains name columns of its recorded rows", () => {
    const grouped: Record<string, string[]> = {};
    for (const f of readdirSync(join(ACME, "goldens")).sort()) {
      const g = readYaml<Golden>(join(ACME, "goldens", f));
      if (g.status !== "approved") continue;
      const compiled = compileGolden(ACME, g);
      expect({ f, ok: compiled.ok }).toEqual({ f, ok: true });
      const columns = groupingColumns(compiled);
      expect({ f, n: columns.length }).toEqual({ f, n: (g.request.dimensions ?? []).length });
      for (const row of g.expected!.rows) for (const c of columns) expect({ f, c, has: c in row }).toEqual({ f, c, has: true });
      if (columns.length) grouped[g.name] = columns;
    }
    expect(grouped).toMatchObject({ revenue_by_region_2025: ["ship_region", "ship_region_name"], net_revenue_2025: ["order_date_year"] });
    expect(Object.keys(grouped).length).toBeGreaterThanOrEqual(6);
  });

  test("a request that does not compile names none", () => {
    expect(groupingColumns(undefined)).toEqual([]);
    expect(groupingColumns({ ok: false, source: "wh", reason: "x", refusals: [] })).toEqual([]);
  });
});

// Sales with a whole-number year, a decimal price band and a date to group by, a decimal total and a
// whole-number total. The same statements run on duckdb and postgres.
const SALES_COLUMNS = "(id integer, fiscal_year integer, price_band float8, sold_on date, amount numeric(12,2), units integer)";
const SALES_ROWS =
  "(1, 2024, 9.99, date '2024-03-01', 1000.25, 600), (2, 2024, 9.99, date '2024-06-01', 500.25, 400), " +
  "(3, 2025, 20.5, date '2025-03-01', 2000.50, 700), (4, 2025, 20.5, date '2025-06-01', 1000.25, 300)";
// Grouped by the year, confirmed at half a percent and then checked as the data changes under it.
const GOLDEN = {
  name: "sales_by_year",
  question: "What were revenue and units by fiscal year?",
  request: { source: "wh", measures: ["sales.revenue", "sales.units"], dimensions: ["sales.fiscal_year"] },
  status: "draft",
};
const APPROVED = { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" };
const salesModel = (table: string): Model => ({
  model: "sales",
  source: "wh",
  table,
  ...APPROVED,
  dimensions: [
    { name: "fiscal_year", expr: "fiscal_year", type: "number", ...APPROVED },
    { name: "price_band", expr: "price_band", type: "number", ...APPROVED },
    { name: "sold_on", expr: "sold_on", type: "time", ...APPROVED },
  ],
  measures: [
    { name: "revenue", expr: "amount", agg: "sum", description: "Revenue.", ...APPROVED },
    { name: "units", expr: "units", agg: "sum", description: "Units sold.", ...APPROVED },
  ],
});

interface Warehouse {
  root: string;
  env: Record<string, string>;
  // Runs one statement that changes the sales table; {sales} is the table's name.
  change(sql: string): Promise<void>;
}

async function project(table: string, golden: Record<string, unknown> = GOLDEN): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  await initProject(t.root);
  writeYaml(join(t.root, "models", "wh", "sales.yaml"), salesModel(table));
  writeYaml(join(t.root, "access.yaml"), { ...APPROVED, mode: "open", roles: [{ name: "analyst", description: "Analysts." }] });
  writeYaml(join(t.root, "goldens", `${String(golden.name)}.yaml`), golden);
  return t;
}

async function onDuckdb(golden?: Record<string, unknown>): Promise<Warehouse> {
  const t = await project("main.sales", golden);
  await duckdbSource(t.root, t.dir, "wh", [`create table sales ${SALES_COLUMNS}`, `insert into sales values ${SALES_ROWS}`]);
  return {
    root: t.root,
    env: {},
    async change(sql) {
      const instance = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
      const c = await instance.connect();
      await c.run(sql.replace("{sales}", "sales"));
      c.closeSync();
      instance.closeSync();
    },
  };
}

async function onPostgres(): Promise<Warehouse> {
  assertLocalPg(PG_URL);
  const schema = uniqueSchema("sl_compare");
  const db = new SQL({ url: PG_URL!, max: 1 });
  cleanups.push(async () => {
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.close();
  });
  await db.unsafe(`create schema ${schema}`);
  await db.unsafe(`create table ${schema}.sales ${SALES_COLUMNS}`);
  await db.unsafe(`insert into ${schema}.sales values ${SALES_ROWS}`);
  const t = await project(`${schema}.sales`);
  writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres", connection: { env: "PG_URL" } });
  return {
    root: t.root,
    env: { PG_URL: PG_URL! },
    async change(sql) {
      await db.unsafe(sql.replace("{sales}", `${schema}.sales`));
    },
  };
}

interface CheckJson {
  passed: number;
  failed: number;
  results: { name: string; ok: boolean; diffs: string[]; compiled?: string }[];
}

async function drift(w: Warehouse): Promise<void> {
  const check = async () => {
    const r = await sl(w.root, ["goldens", "check", "--name", "sales_by_year", "--json"], w.env);
    const doc = r.json<CheckJson>();
    return { code: r.code, diffs: doc.results[0]!.diffs };
  };
  const confirm = await confirmWithYes(w.root, ["--name", "sales_by_year", "--by", "Dana", "--tolerance", "0.005"], {}, w.env);
  if (confirm.code !== 0) throw new Error(confirm.err);
  expect(readYaml<Golden>(join(w.root, "goldens", "sales_by_year.yaml")).expected).toMatchObject({ tolerance: 0.005, rows: [{}, {}] });
  expect(await check()).toEqual({ code: 0, diffs: [] });

  // A decimal total that drifts inside the tolerance still passes; outside it fails, with nothing to explain.
  await w.change("update {sales} set amount = 1000.75 where id = 1");
  expect(await check()).toEqual({ code: 0, diffs: [] });
  await w.change("update {sales} set amount = 1100.25 where id = 1");
  const outside = await check();
  expect(outside.code).toBe(1);
  expect(outside.diffs).toHaveLength(1);
  expect(outside.diffs[0]).toMatch(/^Row [12] \(fiscal_year=2024\), column revenue: expected "?1500\.50?"?, got "?1600\.50?"?\.$/);
  await w.change("update {sales} set amount = 1000.25 where id = 1");
  expect(await check()).toEqual({ code: 0, diffs: [] });

  // A whole-number total off by one in a thousand, a fifth of the tolerance, fails.
  await w.change("update {sales} set units = units + 1 where id = 1");
  const offByOne = await check();
  expect(offByOne.code).toBe(1);
  expect(offByOne.diffs).toHaveLength(1);
  expect(offByOne.diffs[0]).toMatch(/^Row [12] \(fiscal_year=2024\), column units: expected "?1000"?, got "?1001"? \(whole numbers compare exactly\)\.$/);
  await w.change("update {sales} set units = units - 1 where id = 1");
  expect(await check()).toEqual({ code: 0, diffs: [] });

  // The two years' figures swap: every figure is still one of the confirmed ones, under the wrong year.
  await w.change("update {sales} set fiscal_year = 4049 - fiscal_year");
  const swapped = await check();
  expect(swapped.code).toBe(1);
  expect(swapped.diffs).toHaveLength(2);
  expect(swapped.diffs.find((d) => d.includes("fiscal_year=2024"))).toMatch(/^Row [12] \(fiscal_year=2024\), column revenue: expected "?1500\.50?"?, got "?3000\.75"?\.$/);
  expect(swapped.diffs.find((d) => d.includes("fiscal_year=2025"))).toMatch(/^Row [12] \(fiscal_year=2025\), column revenue: expected "?3000\.75"?, got "?1500\.50?"?\.$/);
  const human = await sl(w.root, ["goldens", "check", "--name", "sales_by_year"], w.env);
  expect(human.code).toBe(1);
  expect(human.out).toContain("FAIL  sales_by_year");
  expect(human.out).toContain("(fiscal_year=2024), column revenue: expected");
  expect(human.out).toContain("Next: sl goldens run --name sales_by_year shows its rows");
}

describe("goldens check on a golden grouped by year, confirmed at half a percent", () => {
  test("duckdb: drift inside the tolerance passes; a count off by one and swapped years fail", async () => {
    await drift(await onDuckdb());
  });

  test.skipIf(!PG_URL)("postgres: drift inside the tolerance passes; a count off by one and swapped years fail", async () => {
    await drift(await onPostgres());
  });
});

// The cross-check comparison of goldens run, sl readback and goldens confirm reads the grouping
// columns from the compiled request too. A decimal price band is not a whole number, so only that
// rule can make it exact.
describe("cross_check_sql against the compiled rows", () => {
  test("run, readback and confirm refuse a cross_check_sql whose grouping value is inside the tolerance but not the same", async () => {
    const golden = {
      name: "by_band",
      question: "What was revenue by price band?",
      request: { source: "wh", measures: ["sales.revenue"], dimensions: ["sales.price_band"] },
      // 9.99 reads 10.01 and 20.5 reads 20.52: 0.2% and 0.1% away.
      cross_check_sql: "select price_band + 0.02 as price_band, sum(amount) as revenue from sales group by 1",
      status: "draft",
    };
    const w = await onDuckdb(golden);
    const file = join(w.root, "goldens", "by_band.yaml");
    expect(groupingColumns(compileGolden(w.root, readYaml<Golden>(file)))).toEqual(["price_band"]);

    const run = await sl(w.root, ["goldens", "run", "--name", "by_band", "--tolerance", "0.005", "--json"]);
    const doc = run.json<{ cross_check?: { ok: boolean; diffs: string[] } }>();
    expect(doc.cross_check?.ok).toBe(false);
    expect(doc.cross_check?.diffs.join("\n")).toContain("but no result row matches it (grouping columns compare exactly).");

    const readback = await sl(w.root, ["readback", "--targets", "golden:by_band", "--tolerance", "0.005"]);
    expect(readback.code).toBe(1);
    expect(readback.err).toContain("cross_check_sql gives other rows");
    expect(readback.err).toContain("sl goldens run --name by_band");
    const confirm = await confirmWithYes(w.root, ["--name", "by_band", "--by", "Dana", "--tolerance", "0.005"]);
    expect(confirm.code).toBe(1);
    expect(readYaml<Golden>(file).status).toBe("draft");

    // With the same price bands, a decimal total half a dollar off still follows the tolerance.
    writeYaml(file, { ...golden, cross_check_sql: "select price_band, sum(amount) + 0.5 as revenue from sales group by 1" });
    const within = await sl(w.root, ["goldens", "run", "--name", "by_band", "--tolerance", "0.005", "--json"]);
    expect(within.json<{ cross_check?: { ok: boolean } }>().cross_check?.ok).toBe(true);
    const strict = await sl(w.root, ["goldens", "run", "--name", "by_band", "--tolerance", "0", "--json"]);
    expect(strict.json<{ cross_check?: { ok: boolean } }>().cross_check?.ok).toBe(false);
  });

  test("a time grain's column is a grouping column, and goldens check --json keeps its shape", async () => {
    const w = await onDuckdb({
      name: "by_sold_year",
      question: "What were revenue and units by year sold?",
      request: { source: "wh", measures: ["sales.revenue", "sales.units"], dimensions: ["sales.sold_on:year"] },
      status: "draft",
    });
    expect(groupingColumns(compileGolden(w.root, readYaml<Golden>(join(w.root, "goldens", "by_sold_year.yaml"))))).toEqual(["sold_on_year"]);
    const confirm = await confirmWithYes(w.root, ["--name", "by_sold_year", "--by", "Dana", "--tolerance", "0.005"]);
    expect(confirm.err).toBe("");
    expect(confirm.code).toBe(0);
    const check = await sl(w.root, ["goldens", "check", "--json"]);
    expect(check.code).toBe(0);
    expect(check.json<CheckJson>()).toEqual({ passed: 1, failed: 0, results: [{ name: "by_sold_year", ok: true, diffs: [], compiled: "pass" }] });
  });
});

// A warehouse dialect's request does not compile, so the golden is checked by its cross_check_sql
// alone, from a results file, and no grouping column is known.
describe("a golden checked by its cross_check_sql alone", () => {
  test("whole numbers compare exactly and figures with decimals follow the tolerance", async () => {
    const t = await project("analytics.sales", {
      ...GOLDEN,
      cross_check_sql: "select fiscal_year, sum(amount) as revenue, sum(units) as units from analytics.sales group by 1",
    });
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "snowflake", connection: { env: "WH_URL" } });
    const file = join(t.dir, "results.json");
    const results = (rows: unknown[]) => writeFileSync(file, JSON.stringify({ "golden:sales_by_year:cross_check": rows }));
    const check = async () => {
      const r = await sl(t.root, ["goldens", "check", "--results", file, "--json"]);
      return { code: r.code, diffs: r.json<CheckJson>().results[0]!.diffs };
    };
    results([
      { FISCAL_YEAR: 2024, REVENUE: "1500.50", UNITS: 1000 },
      { FISCAL_YEAR: 2025, REVENUE: "3000.75", UNITS: 1000 },
    ]);
    const confirm = await confirmWithYes(t.root, ["--name", "sales_by_year", "--by", "Dana", "--tolerance", "0.005", "--results", file]);
    expect(confirm.code).toBe(0);
    expect(await check()).toEqual({ code: 0, diffs: [] });

    // Decimal drift inside the tolerance passes, as a number or as text, in any row order.
    results([
      { fiscal_year: 2025, revenue: 3001.25, units: "1000" },
      { fiscal_year: "2024", revenue: "1501.00", units: 1000 },
    ]);
    expect(await check()).toEqual({ code: 0, diffs: [] });

    // A count off by one fails.
    results([
      { fiscal_year: 2024, revenue: "1500.50", units: 1001 },
      { fiscal_year: 2025, revenue: "3000.75", units: 1000 },
    ]);
    const offByOne = await check();
    expect(offByOne.code).toBe(1);
    expect(offByOne.diffs).toHaveLength(1);
    expect(offByOne.diffs[0]).toContain("column units: expected 1000, got 1001 (whole numbers compare exactly).");

    // Each year moved on by one, every figure unchanged, fails.
    results([
      { fiscal_year: 2025, revenue: "1500.50", units: 1000 },
      { fiscal_year: 2026, revenue: "3000.75", units: 1000 },
    ]);
    const moved = await check();
    expect(moved.code).toBe(1);
    expect(moved.diffs.join("\n")).toContain("(whole numbers compare exactly)");
    const human = await sl(t.root, ["goldens", "check", "--results", file]);
    expect(human.code).toBe(1);
    expect(human.out).toContain("Next:");
  });
});

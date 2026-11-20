// Comparison with the prior period and a year earlier (spec: Metric semantics, Running totals and
// comparisons): the SQL a request with `compare` compiles to on a postgres source, its refusals, a
// ratio metric compared after the division, a balance's empty period, the user's row filters and
// visibility applying to the inner request, the readback, the golden hash and a rename. On a live
// server (PG_URL), a 29 February read against 28 February at day grain, a Sunday-week source compared
// on its own weeks and a balance with an empty month, each beside a hand-written query. The figures
// on the Chinook sample are in tests/compat/period-compare.test.ts; every value here is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { compareColumns } from "../skills/semantic-layer/scripts/lib/compiler/period-compare.ts";
import { timeShapeWords } from "../skills/semantic-layer/scripts/lib/time-request-words.ts";
import type { Golden, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

type Obj = Record<string, unknown>;
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

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };

function invoiceModel(table: string): Obj {
  return {
    model: "invoice",
    source: "shop",
    table,
    grain: "One row per invoice.",
    primary_key: ["invoice_id"],
    ...ok,
    dimensions: [
      { name: "invoice_id", expr: "invoice_id", type: "number", ...ok },
      { name: "invoice_date", expr: "invoice_date", type: "time", time_zone: "UTC", description: "When the invoice was issued.", ...ok },
      { name: "billing_country", expr: "billing_country", type: "string", ...ok },
    ],
    measures: [
      { name: "revenue", expr: "total", agg: "sum", description: "Invoice totals.", ...ok },
      { name: "invoice_count", agg: "count", description: "Invoices.", ...ok },
      { name: "avg_total", expr: "total", agg: "avg", description: "The average invoice.", ...ok },
      { name: "pending_revenue", expr: "total", agg: "sum", description: "Not approved yet.", status: "draft" },
    ],
  };
}
function balanceModel(table: string): Obj {
  return {
    model: "account",
    source: "shop",
    table,
    grain: "One row per account and day read.",
    primary_key: ["account_id", "snapshot_date"],
    ...ok,
    dimensions: [
      { name: "account_id", expr: "account_id", type: "number", ...ok },
      { name: "snapshot_date", expr: "snapshot_date", type: "time", description: "The day the balance was read.", ...ok },
    ],
    measures: [{ name: "closing_balance", expr: "balance", agg: "sum", non_additive_dimension: { name: "snapshot_date", window: "last" }, description: "Closing balance.", ...ok }],
  };
}
const METRICS = {
  metrics: [{ name: "avg_invoice_value", source: "shop", type: "ratio", numerator: "invoice.revenue", denominator: "invoice.invoice_count", description: "Revenue per invoice.", ...ok }],
};

async function project(opts: { dialect?: "postgres" | "duckdb"; table?: string; balances?: string; calendar?: Obj; access?: Obj } = {}): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const connection = opts.dialect === "duckdb" ? { database: join(t.dir, "shop.duckdb") } : { env: "PG_URL" };
  writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: opts.dialect ?? "postgres", connection, ...(opts.calendar ? { calendar: opts.calendar } : {}) });
  writeYaml(join(t.root, "models", "shop", "invoice.yaml"), invoiceModel(opts.table ?? "public.invoice"));
  writeYaml(join(t.root, "models", "shop", "account.yaml"), balanceModel(opts.balances ?? "public.balances"));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  if (opts.access) writeYaml(join(t.root, "access.yaml"), opts.access);
  return t.root;
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const MONTH = "invoice.invoice_date:month";
const compare = (extra: Partial<QueryRequest> = {}, over = MONTH) =>
  req({ measures: ["invoice.revenue"], dimensions: [MONTH], compare: { over, with: ["prior", "year_ago"] }, order_by: [{ field: MONTH }], ...extra });

describe("a comparison on postgres", () => {
  test("compiles the grouped request inside periods, lag over filled for prior and the year ago self-join, then change and pct", async () => {
    const root = await project();
    const c = compiled(
      compileRequest(
        root,
        compare({
          dimensions: [MONTH, "invoice.billing_country"],
          filters: [
            { field: "invoice.billing_country", op: "neq", value: "Nowhere" },
            { field: MONTH, op: "gte", value: "2025-01-01" },
          ],
          limit: 10,
        }),
      ),
    );
    const at = c.sql.indexOf(`"compared" as (`);
    expect(c.sql.slice(0, at)).toContain(`"filled" as (\nselect\n  "series"."invoice_date_month",\n  "groups"."billing_country",\n  coalesce("periods"."revenue", 0) as "revenue"\nfrom "series"\ncross join "groups"`);
    expect(c.sql.slice(at)).toBe(
      [
        `"compared" as (`,
        "select",
        `  "filled"."invoice_date_month",`,
        `  "filled"."billing_country",`,
        `  "filled"."revenue",`,
        `  lag("filled"."revenue") over (partition by "filled"."billing_country" order by "filled"."invoice_date_month") as "revenue_prior",`,
        `  "year ago"."revenue" as "revenue_year_ago"`,
        `from "filled"`,
        `left join "filled" as "year ago" on "year ago"."invoice_date_month" = cast("filled"."invoice_date_month" - interval '1 year' as date) and "year ago"."billing_country" is not distinct from "filled"."billing_country"`,
        ")",
        "select",
        `  "invoice_date_month",`,
        `  "billing_country",`,
        `  "revenue",`,
        `  "revenue_prior",`,
        `  "revenue" - "revenue_prior" as "revenue_prior_change",`,
        `  cast("revenue" - "revenue_prior" as numeric) / nullif("revenue_prior", 0) as "revenue_prior_pct",`,
        `  "revenue_year_ago",`,
        `  "revenue" - "revenue_year_ago" as "revenue_year_ago_change",`,
        `  cast("revenue" - "revenue_year_ago" as numeric) / nullif("revenue_year_ago", 0) as "revenue_year_ago_pct"`,
        `from "compared"`,
        `where ("invoice_date_month") >= $2`,
        "order by 1 asc nulls last",
        "limit 10",
      ].join("\n"),
    );
    expect(c.sql).toContain("lag(");
    expect(c.params).toEqual(["Nowhere", "2025-01-01"]);
    expect(c.columns.map((x) => [x.name, x.ref, x.kind])).toEqual([
      ["invoice_date_month", MONTH, "dimension"],
      ["billing_country", "invoice.billing_country", "dimension"],
      ["revenue", "invoice.revenue", "measure"],
      ...["prior", "prior_change", "prior_pct", "year_ago", "year_ago_change", "year_ago_pct"].map((s) => [`revenue_${s}`, "invoice.revenue", "measure"]),
    ]);
  });

  test("with prior alone there is no year ago join; compareColumns writes three columns per comparison in the order given", async () => {
    const root = await project();
    const c = compiled(compileRequest(root, compare({ compare: { over: MONTH, with: ["prior"] } })));
    expect(c.sql).not.toContain(`"year ago"`);
    expect(c.columns.map((x) => x.name)).toEqual(["invoice_date_month", "revenue", "revenue_prior", "revenue_prior_change", "revenue_prior_pct"]);
    expect(compareColumns("m", ["year_ago", "prior"]).map((x) => x.name)).toEqual(["m_year_ago", "m_year_ago_change", "m_year_ago_pct", "m_prior", "m_prior_change", "m_prior_pct"]);
    expect(compareColumns("m", ["prior"])[2]!.sql).toBe(`cast("m" - "m_prior" as numeric) / nullif("m_prior", 0)`);
  });

  test("a ratio metric compiles per period inside periods, so it is compared after the division", async () => {
    const root = await project();
    const c = compiled(compileRequest(root, compare({ measures: ["avg_invoice_value"] })));
    expect(c.sql.startsWith(`with "periods" as (\nwith "invoice measures" as (`)).toBe(true);
    const periods = c.sql.slice(0, c.sql.indexOf(`"series" as (`));
    expect(periods).toContain(`"invoice measures"."revenue"`);
    expect(periods).toContain("nullif(");
    // A metric is not a total: its empty period stays null, as does every comparison with it.
    expect(c.sql).toContain(`  "periods"."avg_invoice_value"\nfrom "series"`);
    expect(c.sql).toContain(`lag("filled"."avg_invoice_value") over (order by "filled"."invoice_date_month") as "avg_invoice_value_prior"`);
    expect(c.columns.map((x) => x.name)).toContain("avg_invoice_value_year_ago_pct");
  });

  test("a balance is compared, and its empty period is null, not 0", async () => {
    const root = await project();
    const m = "account.snapshot_date:month";
    const c = compiled(compileRequest(root, req({ measures: ["account.closing_balance"], dimensions: [m], compare: { over: m, with: ["prior"] } })));
    expect(c.sql).toContain(`  "periods"."closing_balance"\nfrom "series"`);
    expect(c.sql).not.toContain(`coalesce("periods"."closing_balance"`);
    expect(c.sql).toContain("distinct on");
  });

  test("each of these refuses with invalid_request, naming what to change", async () => {
    const root = await project();
    const cases: [Partial<QueryRequest>, string][] = [
      [{ dimensions: ["invoice.invoice_date:week"], order_by: [], compare: { over: "invoice.invoice_date:week", with: ["prior", "year_ago"] } }, "compare.with names year_ago by week"],
      [{ dimensions: ["invoice.invoice_date:hour"], order_by: [], compare: { over: "invoice.invoice_date:hour", with: ["year_ago"] } }, "compare by hour with prior only, or ask for year_ago with compare.over at the month grain, invoice.invoice_date:month"],
      [{ running: { over: MONTH } }, "the request names running and compare; a request takes one of running, compare, window"],
      [{ compare: { with: ["prior"] } }, "compare names no over; compare.over names the time dimension of the request it compares by, as model.field:grain: write invoice.invoice_date:month"],
      [{ compare: { over: ":month", with: ["prior"] } }, "compare.over names its time dimension in full, as model.field:month: write invoice.invoice_date:month"],
      [{ dimensions: ["invoice.billing_country"], order_by: [] }, "compare.over is invoice.invoice_date:month, which is not one of the request's dimensions"],
      [{ dimensions: [MONTH, "invoice.invoice_date:year"] }, "the same field as compare.over at another grain; the periods of a comparison would mix the two grains"],
      [{ filters: [{ field: "invoice.revenue", op: "gt", value: 10 }] }, "a measure; a filter on a figure would hide the earlier period a row is compared with: ask without compare"],
      [{ filters: [{ field: "avg_invoice_value", op: "gt", value: 1 }] }, "a filter on a figure would hide the earlier period"],
      [{ filters: [{ field: "invoice.invoice_date", op: "gte", value: "2025-01-01" }] }, "with no grain; a comparison by month filters invoice.invoice_date at its grain"],
      [{ filters: [{ field: "invoice.invoice_date:year", op: "gte", value: "2025-01-01" }] }, "at grain year"],
      [{ measures: [] }, "the request names no measure"],
      [{ order_by: [{ field: "invoice.billing_country" }] }, "order_by[0] names invoice.billing_country, which the request does not select"],
    ];
    for (const [extra, says] of cases) {
      const r = refused(compileRequest(root, compare(extra)));
      expect({ extra, codes: r.refusals.map((x) => x.code) }).toEqual({ extra, codes: r.refusals.map(() => "invalid_request") });
      expect(r.reason).toContain(says);
    }
    // The schema refuses an empty or repeated with, an unknown comparison and an unknown key.
    for (const bad of [{ over: MONTH, with: [] }, { over: MONTH, with: ["prior", "prior"] }, { over: MONTH, with: ["last_week"] }, { over: MONTH }, { over: MONTH, with: ["prior"], lag: 2 }])
      expect(refused(compileRequest(root, compare({ compare: bad as never }))).refusals[0]!.code).toBe("invalid_request");
    // A year earlier is a period of the same grain by day, quarter and year.
    for (const g of ["day", "quarter", "year"]) compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [`invoice.invoice_date:${g}`], compare: { over: `invoice.invoice_date:${g}`, with: ["year_ago"] } })));
  });

  test("a duckdb source refuses with unsupported_dialect, naming PostgreSQL", async () => {
    const root = await project({ dialect: "duckdb" });
    const r = refused(compileRequest(root, compare()));
    expect(r.refusals.map((x) => x.code)).toEqual(["unsupported_dialect"]);
    expect(r.reason).toContain("a request with compare compiles for PostgreSQL sources only");
  });

  test("the user's row filters narrow the inner request, and a measure the user may not see refuses the whole request", async () => {
    const access = { ...ok, mode: "open", roles: [{ name: "finland", row_filters: [{ model: "shop.invoice", expr: "billing_country = 'Finland'" }] }] };
    const root = await project({ access });
    const c = compiled(compileRequest(root, compare(), { role: "finland" }));
    expect(c.sql).toContain(`from "public"."invoice"\nwhere (billing_country = 'Finland')\ngroup by 1\n),`);
    expect(c.row_filters.map((r) => [r.model, r.in])).toEqual([["invoice", "where"]]);
    const hidden = refused(compileRequest(root, compare({ measures: ["invoice.revenue", "invoice.pending_revenue"] })));
    expect(hidden.refusals.map((x) => x.code)).toEqual(["not_visible"]);
    expect(hidden.refusals[0]!.ref).toBe("invoice.pending_revenue");
  });
});

// A live server, each figure beside a hand-written query that reads the table directly.
async function live(build: (db: SQL, schema: string) => Promise<void>, check: (db: SQL, schema: string) => Promise<void>) {
  assertLocalPg(PG_URL);
  const schema = uniqueSchema("t_compare");
  const db = new SQL({ url: PG_URL!, max: 1 });
  try {
    await db.unsafe(`create schema "${schema}"`);
    await build(db, schema);
    await check(db, schema);
  } finally {
    await db.unsafe(`drop schema if exists "${schema}" cascade`);
    await db.close();
  }
}
const num = (v: unknown) => (v === null ? null : Number(v));
async function run(db: SQL, c: Compiled): Promise<Row[]> {
  const select = c.columns.map((x) => `cast("${x.name}" as text) as "${x.name}"`).join(", ");
  const rows = (await db.unsafe(`select ${select} from (${c.sql}) q`, c.params as never[])) as Row[];
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /_(day|week|month)$/.test(k) ? v : num(v)])));
}

describe("a comparison on a live server", () => {
  const invoices = (rows: string) => async (db: SQL, schema: string) => {
    await db.unsafe(`create table "${schema}".invoice (invoice_id integer, customer_id integer, invoice_date timestamp, billing_country text, total numeric(10,2))`);
    await db.unsafe(`insert into "${schema}".invoice values ${rows}`);
  };

  test.skipIf(!PG_URL)("by day, 29 February 2024 is compared with 28 February 2023, and 28 February 2025 with 28 February 2024", async () => {
    await live(
      invoices(`(1, 1, '2023-02-28 09:00', 'A', 5.00), (2, 1, '2023-03-01 09:00', 'A', 2.00), (3, 1, '2024-02-28 09:00', 'A', 7.00), (4, 1, '2024-02-29 09:00', 'A', 11.00), (5, 1, '2024-03-01 09:00', 'A', 3.00), (6, 1, '2025-02-28 09:00', 'A', 13.00)`),
      async (db, schema) => {
        const root = await project({ table: `${schema}.invoice` });
        const day = "invoice.invoice_date:day";
        const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [day], compare: { over: day, with: ["prior", "year_ago"] }, order_by: [{ field: day }] })));
        const r = await run(db, c);
        const at = (d: string) => r.find((x) => x.invoice_date_day === d)!;
        expect(r.length).toBe(732); // 2023-02-28 through 2025-02-28, 2024 a leap year
        expect([at("2024-02-29").revenue, at("2024-02-29").revenue_year_ago, at("2024-02-29").revenue_year_ago_change]).toEqual([11, 5, 6]);
        expect([at("2024-02-28").revenue_year_ago, at("2024-03-01").revenue_year_ago, at("2025-02-28").revenue_year_ago]).toEqual([5, 2, 7]);
        expect([at("2024-02-29").revenue_prior, at("2024-03-01").revenue_prior, at("2024-03-01").revenue_prior_change]).toEqual([7, 11, -8]);
        expect(Math.abs((at("2024-03-01").revenue_prior_pct as number) - -8 / 11)).toBeLessThan(1e-12);
        // Before the series starts: null; an empty day a year earlier inside it: 0, so pct is null.
        expect([at("2023-02-28").revenue_prior, at("2023-02-28").revenue_year_ago, at("2024-02-27").revenue_year_ago]).toEqual([null, null, null]);
        expect([at("2024-03-02").revenue_year_ago, at("2024-03-02").revenue_year_ago_pct]).toEqual([0, null]);
        // By hand, each day against the same date a year back, 29 February read as 28 February.
        const [h] = (await db.unsafe(
          `select cast(sum(total) filter (where invoice_date >= '2023-02-28' and invoice_date < '2023-03-01') as text) as feb28_2023,
                  cast(sum(total) filter (where invoice_date >= '2024-02-28' and invoice_date < '2024-02-29') as text) as feb28_2024
           from "${schema}".invoice`,
        )) as Row[];
        expect([num(h!.feb28_2023), num(h!.feb28_2024)]).toEqual([at("2024-02-29").revenue_year_ago as number, at("2025-02-28").revenue_year_ago as number]);
      },
    );
  });

  test.skipIf(!PG_URL)("a Sunday-week source compares each week with the week before on its own weeks", async () => {
    await live(invoices(`(1, 1, '2023-12-30 10:00', 'A', 1.50), (2, 2, '2024-01-10 23:00', 'B', 2.25), (3, 1, '2024-01-24 00:00', 'A', 4.00), (4, 1, null, 'A', 100.00)`), async (db, schema) => {
      const root = await project({ calendar: { week_start: "sunday" }, table: `${schema}.invoice` });
      const week = "invoice.invoice_date:week";
      const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [week], compare: { over: week, with: ["prior"] }, order_by: [{ field: week }] })));
      const r = await run(db, c);
      expect(r.map((x) => [x.invoice_date_week, x.revenue, x.revenue_prior, x.revenue_prior_change, x.revenue_prior_pct])).toEqual([
        ["2023-12-24", 1.5, null, null, null],
        ["2023-12-31", 0, 1.5, -1.5, -1],
        ["2024-01-07", 2.25, 0, 2.25, null],
        ["2024-01-14", 0, 2.25, -2.25, -1],
        ["2024-01-21", 4, 0, 4, null],
      ]);
      // By hand: each week's prior is the sum of the seven days before its Sunday.
      for (const x of r.slice(1)) {
        const [h] = (await db.unsafe(`select cast(coalesce(sum(total), 0) as text) as v from "${schema}".invoice where invoice_date >= cast($1 as date) - 7 and invoice_date < cast($1 as date)`, [x.invoice_date_week])) as Row[];
        expect({ w: x.invoice_date_week, p: x.revenue_prior }).toEqual({ w: x.invoice_date_week, p: num(h!.v) });
      }
    });
  });

  test.skipIf(!PG_URL)("a balance with an empty month: that month is null, and so is what is compared with it", async () => {
    await live(
      async (db, schema) => {
        await db.unsafe(`create table "${schema}".balances (account_id integer, snapshot_date date, balance integer, primary key (account_id, snapshot_date))`);
        // January closes at 100 + 50; February has no reading; March closes at 120 + 80.
        await db.unsafe(`insert into "${schema}".balances values (1, '2024-01-05', 90), (1, '2024-01-30', 100), (2, '2024-01-10', 50), (1, '2024-03-02', 120), (2, '2024-03-20', 70), (2, '2024-03-31', 80)`);
      },
      async (db, schema) => {
        const root = await project({ balances: `${schema}.balances` });
        const m = "account.snapshot_date:month";
        const c = compiled(compileRequest(root, req({ measures: ["account.closing_balance"], dimensions: [m], compare: { over: m, with: ["prior"] }, order_by: [{ field: m }] })));
        const r = await run(db, c);
        expect(r.map((x) => [x.snapshot_date_month, x.closing_balance, x.closing_balance_prior, x.closing_balance_prior_change, x.closing_balance_prior_pct])).toEqual([
          ["2024-01-01", 150, null, null, null],
          ["2024-02-01", null, 150, null, null],
          ["2024-03-01", 200, null, null, null],
        ]);
        const [h] = (await db.unsafe(
          `select cast(sum(balance) as text) as v from "${schema}".balances b where snapshot_date = (select max(snapshot_date) from "${schema}".balances x where x.account_id = b.account_id and x.snapshot_date < '2024-02-01')`,
        )) as Row[];
        expect(num(h!.v)).toBe(150);
      },
    );
  });
});

describe("the comparison in words, in the golden hash and through a rename", () => {
  const golden = (cmp: Obj, extra: Obj = {}): Golden =>
    ({
      name: "revenue_mom",
      question: "How did revenue compare with the month before and a year earlier?",
      request: { source: "shop", measures: ["invoice.revenue"], dimensions: [MONTH], compare: cmp, filters: [{ field: MONTH, op: "gte", value: "2025-01-01" }], ...extra },
      status: "draft",
    }) as unknown as Golden;

  test("timeShapeWords states the comparison, its columns and what a filter on the period does", () => {
    const words = timeShapeWords(golden({ over: MONTH, with: ["prior", "year_ago"] }).request);
    expect(words[0]).toStartWith("Each figure beside the month before and the same month a year earlier, with the change and the change as a fraction of the earlier figure");
    expect(words[0]).toContain("(revenue_prior, revenue_prior_change, revenue_prior_pct, revenue_year_ago, revenue_year_ago_change, revenue_year_ago_pct)");
    expect(words[0]).toContain("blank where the earlier month is before the data");
    expect(words[0]).toContain("counts as 0 for a sum or a count (any other figure, a balance or a metric there is blank)");
    expect(words[0]).toContain("rows with no invoice.invoice_date are left out");
    expect(words[1]).toStartWith("A filter on invoice.invoice_date:month only picks the months shown.".slice(0, -1));
    expect(timeShapeWords(golden({ over: "invoice.invoice_date:day", with: ["year_ago"] }, { filters: [] }).request)).toEqual([
      expect.stringContaining("Each figure beside the same day a year earlier"),
      "A year before 29 February is 28 February.",
    ]);
  });

  test("the golden hash covers compare: a changed with or over is another request", () => {
    const h = (cmp: Obj) => goldenHash(golden(cmp) as unknown as Obj, [{ revenue: 1 }], 0);
    expect(h({ over: MONTH, with: ["prior"] })).not.toBe(h({ over: MONTH, with: ["prior", "year_ago"] }));
    expect(h({ over: MONTH, with: ["prior"] })).not.toBe(h({ over: "invoice.invoice_date:quarter", with: ["prior"] }));
  });

  test("goldens new and semlayer sql print the sentence; a rename of the field or its model rewrites compare.over", async () => {
    const root = await project();
    const request = JSON.stringify(compare());
    const g = await semlayer(root, ["goldens", "new", "--name", "mom", "--question", "Revenue against the month before?", "--request", request]);
    expect({ code: g.code, err: g.err }).toEqual({ code: 0, err: "" });
    expect(g.out).toContain("Each figure beside the month before and the same month a year earlier");
    const s = await semlayer(root, ["sql", "--request", request]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("blank where the earlier month is before the data");
    const read = () => (readYaml(join(root, "goldens", "mom.yaml")) as { request: { compare: { over: string; with: string[] }; dimensions: string[] } }).request;
    expect(read().compare).toEqual({ over: MONTH, with: ["prior", "year_ago"] });
    const rn = await semlayer(root, ["rename", "shop.invoice.invoice_date", "issued_at"]);
    expect({ code: rn.code, err: rn.err }).toEqual({ code: 0, err: "" });
    expect(read()).toMatchObject({ compare: { over: "invoice.issued_at:month", with: ["prior", "year_ago"] }, dimensions: ["invoice.issued_at:month"] });
    expect((await semlayer(root, ["rename", "shop.invoice", "bill"])).code).toBe(0);
    expect(read()).toMatchObject({ compare: { over: "bill.issued_at:month" }, dimensions: ["bill.issued_at:month"] });
  });
});

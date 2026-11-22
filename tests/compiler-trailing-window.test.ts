// A trailing window of days (spec: Metric semantics, Running totals and comparisons): windowBounds'
// date arithmetic, the SQL a request with `window` compiles to on a postgres source, its parameters
// in reading order, every refusal, the as-of date semlayer sql fills from the clock and goldens new
// writes, the golden checks that never read it, the readback, the golden hash and a rename. On a
// live server (PG_URL), a small table whose New York days differ from its UTC days, each figure
// beside a hand-written query. The figures on the Chinook sample are in
// tests/compat/trailing-window.test.ts; every value here is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { dayCount, windowBounds } from "../skills/semantic-layer/scripts/lib/compiler/trailing-window.ts";
import { compileGolden, goldenReads } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { timeShapeWords } from "../skills/semantic-layer/scripts/lib/time-request-words.ts";
import type { Golden, Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
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
    primary_key: ["invoice_id", "invoice_date"],
    ...ok,
    dimensions: [
      { name: "invoice_id", expr: "invoice_id", type: "number", ...ok },
      { name: "invoice_date", expr: "invoice_date", type: "time", time_zone: "UTC", description: "When the invoice was issued.", ...ok },
      { name: "invoice_date_ny", expr: "(invoice_date at time zone 'UTC') at time zone 'America/New_York'", type: "time", description: "New York wall-clock time.", ...ok },
      { name: "snapshot_date", expr: "invoice_date", type: "time", description: "The day a balance is read.", ...ok },
      { name: "invoice_month", expr: "invoice_date", type: "time", time_grains: ["month", "year"], description: "Months only.", ...ok },
      { name: "billing_country", expr: "billing_country", type: "string", ...ok },
    ],
    measures: [
      { name: "revenue", expr: "total", agg: "sum", description: "Invoice totals.", ...ok },
      { name: "invoice_count", agg: "count", description: "Invoices.", ...ok },
      { name: "avg_total", expr: "total", agg: "avg", description: "The average invoice.", ...ok },
      { name: "balance", expr: "total", agg: "sum", non_additive_dimension: { name: "snapshot_date", window: "last" }, description: "A balance.", ...ok },
      { name: "pending_revenue", expr: "total", agg: "sum", description: "Not approved yet.", status: "draft" },
    ],
  };
}
const METRICS = {
  metrics: [{ name: "avg_invoice_value", source: "shop", type: "ratio", numerator: "invoice.revenue", denominator: "invoice.invoice_count", description: "Revenue per invoice.", ...ok }],
};

async function project(opts: { dialect?: "postgres" | "duckdb"; table?: string; access?: Obj } = {}): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const connection = opts.dialect === "duckdb" ? { database: join(t.dir, "shop.duckdb") } : { env: "PG_URL" };
  writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: opts.dialect ?? "postgres", connection });
  writeYaml(join(t.root, "models", "shop", "invoice.yaml"), invoiceModel(opts.table ?? "public.invoice"));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  if (opts.access) writeYaml(join(t.root, "access.yaml"), opts.access);
  return t.root;
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const DAY = "invoice.invoice_date";
const W = { dimension: DAY, days: 30, as_of: "2025-12-22" };
const win = (extra: Partial<QueryRequest> = {}) => req({ measures: ["invoice.revenue"], window: W, compare: { with: ["prior", "year_ago"] }, ...extra });

describe("windowBounds", () => {
  test("30 days as of 2025-12-22: the current window, the 30 days before, and the same dates a year earlier", () => {
    expect(windowBounds({ days: 30, as_of: "2025-12-22" }, ["prior", "year_ago"])).toEqual({
      current: { start: "2025-11-23", end: "2025-12-22" },
      prior: { start: "2025-10-24", end: "2025-11-22" },
      year_ago: { start: "2024-11-23", end: "2024-12-22" },
    });
    expect(windowBounds({ days: 30, as_of: "2025-12-22" })).toEqual({ current: { start: "2025-11-23", end: "2025-12-22" } });
    expect(windowBounds({ days: 1, as_of: "2025-01-01" }, ["prior"])).toEqual({ current: { start: "2025-01-01", end: "2025-01-01" }, prior: { start: "2024-12-31", end: "2024-12-31" } });
  });

  test("the year-ago window moves each end to the same date a year earlier, so it can be a day longer or shorter", () => {
    const march = windowBounds({ days: 30, as_of: "2025-03-10" }, ["year_ago"]);
    expect(march.current).toEqual({ start: "2025-02-09", end: "2025-03-10" });
    expect(march.year_ago).toEqual({ start: "2024-02-09", end: "2024-03-10" });
    expect(dayCount(march.year_ago!)).toBe(31);
    const leap = windowBounds({ days: 30, as_of: "2024-02-29" }, ["prior", "year_ago"]);
    expect(leap.current).toEqual({ start: "2024-01-31", end: "2024-02-29" });
    expect(leap.year_ago).toEqual({ start: "2023-01-31", end: "2023-02-28" });
    expect(dayCount(leap.year_ago!)).toBe(29);
    expect(leap.prior).toEqual({ start: "2024-01-01", end: "2024-01-30" });
    // A window that starts on 29 February starts a year earlier on 28 February.
    expect(windowBounds({ days: 30, as_of: "2024-03-29" }, ["year_ago"]).year_ago).toEqual({ start: "2023-02-28", end: "2023-03-29" });
  });

  test("366 days across a leap year", () => {
    const b = windowBounds({ days: 366, as_of: "2024-12-31" }, ["prior", "year_ago"]);
    expect(b.current).toEqual({ start: "2024-01-01", end: "2024-12-31" });
    expect(b.prior).toEqual({ start: "2022-12-31", end: "2023-12-31" });
    expect(b.year_ago).toEqual({ start: "2023-01-01", end: "2023-12-31" });
  });
});

describe("a window on postgres", () => {
  test("compiles one CTE per window with two date filters, the first day of data, and the windows side by side", async () => {
    const root = await project();
    const c = compiled(compileRequest(root, win({ filters: [{ field: "invoice.billing_country", op: "neq", value: "Nowhere" }] })));
    const window = (name: string, a: number) =>
      [
        `"${name}" as (`,
        "select",
        `  sum(total) as "revenue"`,
        `from "public"."invoice"`,
        `where (billing_country) <> $${a}`,
        `  and (invoice_date) >= $${a + 1}`,
        `  and (invoice_date) < $${a + 2}`,
        ")",
      ].join("\n");
    expect(c.sql).toBe(
      [
        `with ${window("current window", 1)},`,
        `${window("prior window", 4)},`,
        `${window("year ago window", 7)},`,
        `"data start" as (`,
        "select",
        `  cast(date_trunc('day', invoice_date) as date) as "invoice_date_day"`,
        `from "public"."invoice"`,
        "where (billing_country) <> $10",
        "group by 1",
        "order by 1 asc nulls last",
        "limit 1",
        "),",
        `"window figures" as (`,
        "select",
        `  case when "data start"."invoice_date_day" <= $11 then coalesce("current window"."revenue", 0) end as "revenue",`,
        `  case when "data start"."invoice_date_day" <= $12 then coalesce("prior window"."revenue", 0) end as "revenue_prior",`,
        `  case when "data start"."invoice_date_day" <= $13 then coalesce("year ago window"."revenue", 0) end as "revenue_year_ago"`,
        `from "current window"`,
        `cross join "prior window"`,
        `cross join "year ago window"`,
        `left join "data start" on true`,
        ")",
        "select",
        `  "revenue",`,
        `  "revenue_prior",`,
        `  "revenue" - "revenue_prior" as "revenue_prior_change",`,
        `  cast("revenue" - "revenue_prior" as numeric) / nullif("revenue_prior", 0) as "revenue_prior_pct",`,
        `  "revenue_year_ago",`,
        `  "revenue" - "revenue_year_ago" as "revenue_year_ago_change",`,
        `  cast("revenue" - "revenue_year_ago" as numeric) / nullif("revenue_year_ago", 0) as "revenue_year_ago_pct"`,
        `from "window figures"`,
      ].join("\n"),
    );
    // In reading order: each window's filters, ending the day after its last day; the first day's
    // filters; each window's first day.
    expect(c.params).toEqual([
      "Nowhere", "2025-11-23", "2025-12-23",
      "Nowhere", "2025-10-24", "2025-11-23",
      "Nowhere", "2024-11-23", "2024-12-23",
      "Nowhere",
      "2025-11-23", "2025-10-24", "2024-11-23",
    ]);
    expect(c.columns.map((x) => [x.name, x.ref, x.kind])).toEqual([
      ["revenue", "invoice.revenue", "measure"],
      ...["prior", "prior_change", "prior_pct", "year_ago", "year_ago_change", "year_ago_pct"].map((s) => [`revenue_${s}`, "invoice.revenue", "measure"]),
    ]);
  });

  test("by a dimension: the union of the windows' groups, each window left joined on is not distinct from, then order_by on the current figure and limit", async () => {
    const root = await project();
    const c = compiled(
      compileRequest(root, win({ dimensions: ["invoice.billing_country"], order_by: [{ field: "invoice.revenue", direction: "desc" }, { field: "invoice.billing_country" }], limit: 5 })),
    );
    const groups = c.sql.slice(c.sql.indexOf(`"window groups" as (`));
    expect(groups).toBe(
      [
        `"window groups" as (`,
        `select "billing_country" from "current window"`,
        "union",
        `select "billing_country" from "prior window"`,
        "union",
        `select "billing_country" from "year ago window"`,
        "),",
        `"window figures" as (`,
        "select",
        `  "window groups"."billing_country",`,
        `  case when "data start"."invoice_date_day" <= $7 then coalesce("current window"."revenue", 0) end as "revenue",`,
        `  case when "data start"."invoice_date_day" <= $8 then coalesce("prior window"."revenue", 0) end as "revenue_prior",`,
        `  case when "data start"."invoice_date_day" <= $9 then coalesce("year ago window"."revenue", 0) end as "revenue_year_ago"`,
        `from "window groups"`,
        `left join "current window" on "current window"."billing_country" is not distinct from "window groups"."billing_country"`,
        `left join "prior window" on "prior window"."billing_country" is not distinct from "window groups"."billing_country"`,
        `left join "year ago window" on "year ago window"."billing_country" is not distinct from "window groups"."billing_country"`,
        `left join "data start" on true`,
        ")",
        "select",
        `  "billing_country",`,
        `  "revenue",`,
        `  "revenue_prior",`,
        `  "revenue" - "revenue_prior" as "revenue_prior_change",`,
        `  cast("revenue" - "revenue_prior" as numeric) / nullif("revenue_prior", 0) as "revenue_prior_pct",`,
        `  "revenue_year_ago",`,
        `  "revenue" - "revenue_year_ago" as "revenue_year_ago_change",`,
        `  cast("revenue" - "revenue_year_ago" as numeric) / nullif("revenue_year_ago", 0) as "revenue_year_ago_pct"`,
        `from "window figures"`,
        "order by 2 desc nulls last, 1 asc nulls last",
        "limit 5",
      ].join("\n"),
    );
    // Each window groups by the dimension and keeps no order_by or limit of its own.
    expect(c.sql).toContain(`  and (invoice_date) < $2\ngroup by 1\n),`);
    expect(c.params).toEqual(["2025-11-23", "2025-12-23", "2025-10-24", "2025-11-23", "2024-11-23", "2024-12-23", "2025-11-23", "2025-10-24", "2024-11-23"]);
  });

  test("without compare there is the current window alone; a ratio metric compiles per window in a nested WITH; an avg is not 0 in an empty window", async () => {
    const root = await project();
    const alone = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], window: W })));
    expect(alone.sql).not.toContain(`"prior window"`);
    expect(alone.columns.map((x) => x.name)).toEqual(["revenue"]);
    expect(alone.params).toEqual(["2025-11-23", "2025-12-23", "2025-11-23"]);
    // By the window's own dimension when nothing is compared: the days of the window.
    compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [`${DAY}:day`], window: W })));
    const ratio = compiled(compileRequest(root, win({ measures: ["avg_invoice_value", "invoice.avg_total"], compare: { with: ["prior"] } })));
    expect(ratio.sql.startsWith(`with "current window" as (\nwith "invoice measures" as (`)).toBe(true);
    expect(ratio.sql).toContain(`"prior window" as (\nwith "invoice measures" as (`);
    expect(ratio.sql).toContain(`then "current window"."avg_invoice_value" end as "avg_invoice_value"`);
    expect(ratio.sql).toContain(`then "prior window"."avg_total" end as "avg_total_prior"`);
    // A metric's parts number their parameters after the windows before them.
    expect(ratio.params).toEqual(["2025-11-23", "2025-12-23", "2025-10-24", "2025-11-23", "2025-11-23", "2025-10-24"]);
    expect(ratio.sql.slice(ratio.sql.indexOf(`"prior window" as (`), ratio.sql.indexOf(`"data start" as (`))).toContain("(invoice_date) >= $3\n  and (invoice_date) < $4");
    expect(ratio.columns.map((x) => x.name)).toEqual(["avg_invoice_value", "avg_total", "avg_invoice_value_prior", "avg_invoice_value_prior_change", "avg_invoice_value_prior_pct", "avg_total_prior", "avg_total_prior_change", "avg_total_prior_pct"]);
  });

  test("each of these refuses with invalid_request, naming what to change", async () => {
    const root = await project();
    const cases: [Partial<QueryRequest>, string][] = [
      [{ window: { dimension: DAY, days: 30 } }, "window names no as_of; semlayer sql fills it from the clock, and a golden states it"],
      [{ window: { ...W, as_of: "2025-02-30" } }, "window.as_of is 2025-02-30, which is not a day of the calendar"],
      [{ window: { ...W, dimension: "invoice.billing_country" } }, "window.dimension is invoice.billing_country, a string dimension; a window counts days, so name a time dimension"],
      [{ window: { ...W, dimension: "invoice.nothing" } }, "window.dimension is invoice.nothing, which is not a dimension of a model of source shop"],
      [{ window: { ...W, dimension: "invoice.invoice_month" } }, "whose grains are month, year; a window counts days, so name a time dimension that allows the day grain"],
      [{ filters: [{ field: DAY, op: "gte", value: "2025-01-01" }] }, "filters[0] is on invoice.invoice_date; the window picks the days of invoice.invoice_date: drop the filter"],
      [{ filters: [{ field: `${DAY}:month`, op: "gte", value: "2025-01-01" }] }, "filters[0] is on invoice.invoice_date:month; the window picks the days"],
      [{ dimensions: [`${DAY}:month`] }, "dimensions[0] is invoice.invoice_date:month, the window's dimension; each window holds other days"],
      [{ compare: { over: `${DAY}:month`, with: ["prior"] } }, "compare.over is invoice.invoice_date:month; beside a window, compare names only with"],
      [{ running: { over: `${DAY}:month` } }, "the request names running and window; a window takes no running total"],
      [{ measures: ["invoice.balance"] }, `a balance is not added up over days, so it has no window: ask for it by day with compare: {"over": "invoice.snapshot_date:day"`],
      [{ filters: [{ field: "invoice.revenue", op: "gt", value: 1 }] }, "filters[0] is on invoice.revenue, a measure; a filter on a figure would keep different rows in each window"],
      [{ filters: [{ field: "avg_invoice_value", op: "gt", value: 1 }] }, "filters[0] is on avg_invoice_value, a measure"],
      [{ measures: [] }, "the request names no measure"],
      [{ order_by: [{ field: "invoice.billing_country" }] }, "order_by[0] names invoice.billing_country, which the request does not select"],
    ];
    for (const [extra, says] of cases) {
      const r = refused(compileRequest(root, win(extra)));
      expect({ extra, codes: r.refusals.map((x) => x.code) }).toEqual({ extra, codes: r.refusals.map(() => "invalid_request") });
      expect(r.reason).toContain(says);
    }
    // The missing as_of carries its next step.
    expect(refused(compileRequest(root, win({ window: { dimension: DAY, days: 30 } }))).refusals[0]!.next).toContain("request.window in the golden file goldens");
    // The schema refuses a grain on the dimension, days out of range, a bad date and an unknown key.
    for (const bad of [{ ...W, dimension: `${DAY}:day` }, { ...W, days: 0 }, { ...W, days: 367 }, { ...W, as_of: "22/12/2025" }, { ...W, weeks: 1 }, { days: 30, as_of: "2025-12-22" }])
      expect(refused(compileRequest(root, win({ window: bad as never }))).refusals[0]!.code).toBe("invalid_request");
    // compare without over and without window is still C5's refusal; running with compare still the one-view rule.
    expect(refused(compileRequest(root, req({ measures: ["invoice.revenue"], compare: { with: ["prior"] } }))).reason).toContain("compare names no over");
    const both = refused(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [`${DAY}:month`], running: { over: `${DAY}:month` }, compare: { over: `${DAY}:month`, with: ["prior"] } })));
    expect(both.reason).toContain("the request names running and compare; a request takes one of running, compare, window");
  });

  test("a duckdb source refuses with unsupported_dialect, naming PostgreSQL", async () => {
    const root = await project({ dialect: "duckdb" });
    const r = refused(compileRequest(root, win()));
    expect(r.refusals.map((x) => x.code)).toEqual(["unsupported_dialect"]);
    expect(r.reason).toContain("a request with compare or window compiles for PostgreSQL sources only");
  });

  test("the user's row filters narrow every window and the first day of data, and a measure the user may not see refuses the whole request", async () => {
    const access = { ...ok, mode: "open", roles: [{ name: "finland", row_filters: [{ model: "shop.invoice", expr: "billing_country = 'Finland'" }] }] };
    const root = await project({ access });
    const c = compiled(compileRequest(root, win(), { role: "finland" }));
    expect(c.sql.split("where (billing_country = 'Finland')").length - 1).toBe(4);
    expect(c.row_filters.map((r) => [r.model, r.in])).toEqual([["invoice", "where"]]);
    const hidden = refused(compileRequest(root, win({ measures: ["invoice.revenue", "invoice.pending_revenue"] })));
    expect(hidden.refusals.map((x) => x.code)).toEqual(["not_visible"]);
    expect(hidden.refusals[0]!.ref).toBe("invoice.pending_revenue");
  });
});

describe("the as-of date and the clock", () => {
  test("with no as_of, semlayer sql under SEMLAYER_NOW prints the same SQL and parameters as that date, and says it came from the clock", async () => {
    const root = await project();
    const { as_of: _, ...open } = W;
    const env = { SEMLAYER_NOW: "2025-12-22T12:00:00Z" };
    const filled = await semlayer(root, ["sql", "--request", JSON.stringify(win({ window: open as never })), "--json"], env);
    const stated = await semlayer(root, ["sql", "--request", JSON.stringify(win()), "--json"], env);
    expect(filled.code).toBe(0);
    const [a, b] = [filled.json<Obj>(), stated.json<Obj>()];
    expect([a.sql, a.params]).toEqual([b.sql, b.params]);
    expect([a.as_of, a.as_of_from, b.as_of, b.as_of_from]).toEqual(["2025-12-22", "clock", "2025-12-22", "request"]);
    const text = await semlayer(root, ["sql", "--request", JSON.stringify(win({ window: open as never }))], env);
    expect(text.out).toContain("The window runs as of 2025-12-22, from the clock (the date in UTC)");
    expect(text.out).toContain("Over the 30 days 2025-11-23 to 2025-12-22 (as of 2025-12-22)");
    // The date is the clock's in UTC: late in the evening in New York it is already the next day.
    const late = await semlayer(root, ["sql", "--request", JSON.stringify(win({ window: open as never })), "--json"], { SEMLAYER_NOW: "2025-12-23T03:00:00Z" });
    expect(late.json<Obj>().as_of).toBe("2025-12-23");
    expect((await semlayer(root, ["sql", "--request", JSON.stringify(win()), "--json"], { SEMLAYER_NOW: "2030-01-01T00:00:00Z" })).json<Obj>().params).toEqual(b.params);
  });

  test("goldens new writes the clock's date into the golden; a golden without as_of fails validate and is refused, never run for today", async () => {
    const root = await project();
    const { as_of: _, ...open } = W;
    const made = await semlayer(root, ["goldens", "new", "--name", "last30", "--question", "Revenue over the last 30 days?", "--request", JSON.stringify(win({ window: open as never }))], {
      SEMLAYER_NOW: "2025-12-22T08:00:00Z",
    });
    expect({ code: made.code, err: made.err }).toEqual({ code: 0, err: "" });
    expect(made.out).toContain("Its window is as of 2025-12-22, from the clock (the date in UTC), and the golden now states it as window.as_of.");
    const file = join(root, "goldens", "last30.yaml");
    const g = readYaml<Golden>(file);
    expect(g.request.window).toEqual(W);
    expect(JSON.stringify((await semlayer(root, ["validate", "--json"])).json())).not.toContain("metric.window_as_of_missing");

    const { as_of: _a, ...noDate } = g.request.window!;
    writeYaml(file, { ...g, request: { ...g.request, window: noDate } });
    const v = await semlayer(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    expect(JSON.stringify(v.json())).toContain("metric.window_as_of_missing");
    const r = refused(compileGolden(root, readYaml<Golden>(file)));
    expect(r.reason).toContain("window names no as_of");
    // The step it names works: the golden file is edited by hand, and it is not the refused semlayer set.
    expect(r.refusals[0]!.next).toContain("goldens/<name>.yaml");
    expect(r.refusals[0]!.next).not.toContain("semlayer set");
    const set = await semlayer(root, ["set", "golden:last30", "request", "{}"]);
    expect(set.code).not.toBe(0);
    writeYaml(file, { ...g, request: { ...g.request, window: { ...noDate, as_of: "2025-02-30" } } });
    expect(timeShapeWords(readYaml<Golden>(file).request)[0]).toContain("is not a day of the calendar");
    writeYaml(file, { ...g, request: { ...g.request, window: noDate } });
    const filled = await semlayer(root, ["sql", "--request", file], { SEMLAYER_NOW: "2025-12-22T08:00:00Z" });
    expect(filled.out).toContain("add window.as_of to that golden file");
    expect(filled.out).not.toContain("goldens new writes this one");
    const run = await semlayer(root, ["goldens", "run", "--name", "last30"], { SEMLAYER_NOW: "2025-12-22T08:00:00Z" });
    expect(run.out + run.err).not.toContain("2025-11-23");
    const check = await semlayer(root, ["goldens", "check", "--name", "last30"], { SEMLAYER_NOW: "2025-12-22T08:00:00Z" });
    expect(check.code).not.toBe(0);
  });
});

describe("the window in words, in the golden hash and through a rename", () => {
  const golden = (window: Obj, extra: Obj = {}): Golden =>
    ({
      name: "last30",
      question: "Revenue over the last 30 days?",
      request: { source: "shop", measures: ["invoice.revenue"], window, compare: { with: ["prior", "year_ago"] }, ...extra },
      status: "draft",
    }) as unknown as Golden;

  test("timeShapeWords prints the three date ranges, the columns and what an empty or early window shows", () => {
    const words = timeShapeWords(golden(W).request);
    expect(words[0]).toBe(
      "Over the 30 days 2025-11-23 to 2025-12-22 (as of 2025-12-22), against 2025-10-24 to 2025-11-22 and against 2024-11-23 to 2024-12-22; days of invoice.invoice_date as its expr gives them; a window that starts before the first day of data is blank.",
    );
    expect(words[1]).toContain("Columns revenue, revenue_prior, revenue_prior_change, revenue_prior_pct, revenue_year_ago, revenue_year_ago_change, revenue_year_ago_pct");
    expect(words[1]).toContain("_prior the 30 days before, _year_ago the same dates a year earlier");
    expect(words[1]).toContain("a window with no rows counts as 0 for a sum or a count (a metric or any other figure there is blank), and the fraction is blank when the earlier figure is 0 or blank");
    expect(words.length).toBe(2);
    const march = timeShapeWords(golden({ ...W, as_of: "2025-03-10" }).request);
    expect(march[0]).toContain("Over the 30 days 2025-02-09 to 2025-03-10 (as of 2025-03-10), against 2025-01-10 to 2025-02-08 and against 2024-02-09 to 2024-03-10");
    expect(march[2]).toBe("The year-ago window is 31 days, not 30: one of the two ranges holds 29 February, and a year before 29 February is 28 February.");
    expect(timeShapeWords(golden({ dimension: DAY, days: 30 }).request)[0]).toContain("states no as-of date (window.as_of), so it does not compile: semlayer validate reports it as metric.window_as_of_missing");
  });

  test("the golden hash covers the window: a changed days or as_of is another request, and the golden reads its dimension", () => {
    const h = (w: Obj) => goldenHash(golden(w) as unknown as Obj, [{ revenue: 1 }], 0);
    expect(h(W)).not.toBe(h({ ...W, days: 31 }));
    expect(h(W)).not.toBe(h({ ...W, as_of: "2025-12-21" }));
    expect(h(W)).not.toBe(h({ ...W, dimension: "invoice.invoice_date_ny" }));
    const model = invoiceModel("public.invoice") as unknown as Model;
    expect(goldenReads(golden(W), [model], []).map((r) => r.ref)).toEqual(["shop.invoice.revenue", "shop.invoice.invoice_date"]);
  });

  test("goldens new and semlayer sql print the sentence; a rename of the field or its model rewrites window.dimension", async () => {
    const root = await project();
    const request = JSON.stringify(win());
    const g = await semlayer(root, ["goldens", "new", "--name", "last30", "--question", "Revenue over the last 30 days?", "--request", request]);
    expect({ code: g.code, err: g.err }).toEqual({ code: 0, err: "" });
    expect(g.out).toContain("Over the 30 days 2025-11-23 to 2025-12-22 (as of 2025-12-22)");
    expect(g.out).not.toContain("from the clock");
    const s = await semlayer(root, ["sql", "--request", request]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("days of invoice.invoice_date as its expr gives them");
    expect(s.out).not.toContain("from the clock");
    const help = await semlayer(root, ["goldens", "--help"]);
    expect(help.out + help.err).toContain('window (PostgreSQL only): {"dimension": "orders.order_date", "days": 30, "as_of": "2025-12-22"}');
    const read = () => (readYaml(join(root, "goldens", "last30.yaml")) as { request: { window: Obj } }).request;
    const rn = await semlayer(root, ["rename", "shop.invoice.invoice_date", "issued_at"]);
    expect({ code: rn.code, err: rn.err }).toEqual({ code: 0, err: "" });
    expect(read().window).toEqual({ ...W, dimension: "invoice.issued_at" });
    expect((await semlayer(root, ["rename", "shop.invoice", "bill"])).code).toBe(0);
    expect(read().window).toEqual({ ...W, dimension: "bill.issued_at" });
  });
});

// A live server: a small table with an invoice late in the evening in New York, which is the next
// day in UTC, so the UTC and New York windows hold different rows; each figure beside a plain sum
// over its two date bounds.
describe("a window on a live server", () => {
  test.skipIf(!PG_URL)("a day is a day of the dimension's expr: the New York window differs from the UTC one, and a window before the data is null", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("t_window");
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      await db.unsafe(`create schema "${schema}"`);
      await db.unsafe(`create table "${schema}".invoice (invoice_id integer, invoice_date timestamp, billing_country text, total numeric(10,2))`);
      // 2025-03-01 02:00 UTC is 2025-02-28 21:00 in New York.
      await db.unsafe(
        `insert into "${schema}".invoice values (1, '2025-02-20 10:00', 'A', 5.00), (2, '2025-03-01 02:00', 'A', 7.00), (3, '2025-03-05 12:00', 'B', 11.00), (4, '2025-03-08 23:30', 'B', 13.00), (5, null, 'A', 100.00)`,
      );
      const root = await project({ table: `${schema}.invoice` });
      const sum = async (where: string) =>
        Number(((await db.unsafe(`select cast(coalesce(sum(total), 0) as text) as v from "${schema}".invoice where ${where}`)) as Row[])[0]!.v);
      const ny = "((invoice_date at time zone 'UTC') at time zone 'America/New_York')";
      const figures = async (dimension: string, as_of: string, days: number) => {
        const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], window: { dimension, days, as_of }, compare: { with: ["prior", "year_ago"] } })));
        const [r] = (await db.unsafe(`select cast(revenue as text) as revenue, cast(revenue_prior as text) as prior, cast(revenue_year_ago as text) as year_ago from (${c.sql}) q`, c.params as never[])) as Row[];
        return [r!.revenue, r!.prior, r!.year_ago].map((v) => (v === null ? null : Number(v)));
      };
      // As of 2025-02-28 for 1 day: UTC holds nothing (invoice 2 is on 1 March); New York holds invoice 2.
      // The day before is inside the data, so 0; the year-ago day is before it, so null.
      expect(await figures(DAY, "2025-02-28", 1)).toEqual([
        await sum(`invoice_date >= '2025-02-28' and invoice_date < '2025-03-01'`),
        await sum(`invoice_date >= '2025-02-27' and invoice_date < '2025-02-28'`),
        null,
      ]);
      expect(await figures(DAY, "2025-02-28", 1)).toEqual([0, 0, null]);
      const nyDay = await figures("invoice.invoice_date_ny", "2025-02-28", 1);
      expect(nyDay).toEqual([await sum(`${ny} >= '2025-02-28' and ${ny} < '2025-03-01'`), 0, null]);
      expect(nyDay[0]).toBe(7);
      // Seven days as of 2025-03-07: prior from 2025-02-22, inside the data (first day 2025-02-20), so 0 by UTC.
      expect(await figures(DAY, "2025-03-07", 7)).toEqual([
        await sum(`invoice_date >= '2025-03-01' and invoice_date < '2025-03-08'`),
        await sum(`invoice_date >= '2025-02-22' and invoice_date < '2025-03-01'`),
        null,
      ]);
      expect(await figures(DAY, "2025-03-07", 7)).toEqual([18, 0, null]);
      expect(await figures("invoice.invoice_date_ny", "2025-03-07", 7)).toEqual([11, 7, null]);
      // A window that starts before the first day of data (2025-02-20) is null, every figure.
      expect(await figures(DAY, "2025-02-25", 7)).toEqual([null, null, null]);
    } finally {
      await db.unsafe(`drop schema if exists "${schema}" cascade`);
      await db.close();
    }
  });
});

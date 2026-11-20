// Running and trailing totals (spec: Metric semantics, Running totals and comparisons): the SQL a
// request with `running` compiles to on a postgres source, its refusals, the request without it
// compiling as before, a Sunday-week source stepping its series by its own weeks (run on a live
// server when PG_URL is set), the user's row filters and visibility applying to the inner request,
// the readback and the golden hash covering the option. The figures on the Chinook sample are in
// tests/compat/running-total.test.ts; every value here is synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { goldenDraftFields, goldenReads } from "../skills/semantic-layer/scripts/lib/goldens.ts";
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

function invoiceModel(table: string, edit: (m: Obj) => void = () => {}): Obj {
  const m: Obj = {
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
      { name: "customers", expr: "customer_id", agg: "count_distinct", description: "Customers.", ...ok },
      { name: "balance", expr: "total", agg: "sum", non_additive_dimension: { name: "invoice_date", window: "last" }, description: "A balance.", ...ok },
      { name: "pending_revenue", expr: "total", agg: "sum", description: "Not approved yet.", status: "draft" },
    ],
  };
  edit(m);
  return m;
}
const METRICS = {
  metrics: [{ name: "avg_invoice_value", source: "shop", type: "ratio", numerator: "invoice.revenue", denominator: "invoice.invoice_count", description: "Revenue per invoice.", ...ok }],
};

async function project(opts: { dialect?: "postgres" | "duckdb"; table?: string; calendar?: Obj; access?: Obj } = {}): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const connection = opts.dialect === "duckdb" ? { database: join(t.dir, "shop.duckdb") } : { env: "PG_URL" };
  writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: opts.dialect ?? "postgres", connection, ...(opts.calendar ? { calendar: opts.calendar } : {}) });
  writeYaml(join(t.root, "models", "shop", "invoice.yaml"), invoiceModel(opts.table ?? "public.invoice"));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  if (opts.access) writeYaml(join(t.root, "access.yaml"), opts.access);
  return t.root;
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const MONTH = "invoice.invoice_date:month";
const running = (extra: Partial<QueryRequest> = {}, over = MONTH) =>
  req({ measures: ["invoice.revenue"], dimensions: [MONTH], running: { over }, order_by: [{ field: MONTH }], ...extra });

describe("a running total on postgres", () => {
  test("compiles the grouped request inside periods, a series over generate_series with timestamp casts, and the window", async () => {
    const root = await project();
    const c = compiled(
      compileRequest(
        root,
        running({
          dimensions: [MONTH, "invoice.billing_country"],
          filters: [
            { field: "invoice.billing_country", op: "neq", value: "Nowhere" },
            { field: MONTH, op: "gte", value: "2025-01-01" },
          ],
          limit: 10,
        }),
      ),
    );
    expect(c.sql).toBe(
      [
        `with "periods" as (`,
        "select",
        `  cast(date_trunc('month', invoice_date) as date) as "invoice_date_month",`,
        `  billing_country as "billing_country",`,
        `  sum(total) as "revenue"`,
        `from "public"."invoice"`,
        "where (billing_country) <> $1",
        "group by 1, 2",
        "),",
        `"series" as (`,
        `select cast(generate_series(cast(min("invoice_date_month") as timestamp), cast(max("invoice_date_month") as timestamp), interval '1 month') as date) as "invoice_date_month"`,
        `from "periods"`,
        "),",
        `"groups" as (`,
        `select distinct "billing_country"`,
        `from "periods"`,
        "),",
        `"filled" as (`,
        "select",
        `  "series"."invoice_date_month",`,
        `  "groups"."billing_country",`,
        `  coalesce("periods"."revenue", 0) as "revenue"`,
        `from "series"`,
        `cross join "groups"`,
        `left join "periods" on "periods"."invoice_date_month" is not distinct from "series"."invoice_date_month" and "periods"."billing_country" is not distinct from "groups"."billing_country"`,
        "),",
        `"running totals" as (`,
        "select",
        `  "invoice_date_month",`,
        `  "billing_country",`,
        `  "revenue",`,
        `  sum("revenue") over (partition by "billing_country" order by "invoice_date_month" rows between unbounded preceding and current row) as "revenue_running"`,
        `from "filled"`,
        ")",
        "select",
        `  "invoice_date_month",`,
        `  "billing_country",`,
        `  "revenue",`,
        `  "revenue_running"`,
        `from "running totals"`,
        `where ("invoice_date_month") >= $2`,
        "order by 1 asc nulls last",
        "limit 10",
      ].join("\n"),
    );
    // Parameters in reading order: the inner request's filters, then the periods shown.
    expect(c.params).toEqual(["Nowhere", "2025-01-01"]);
    expect(c.columns).toEqual([
      { name: "invoice_date_month", ref: MONTH, kind: "dimension" },
      { name: "billing_country", ref: "invoice.billing_country", kind: "dimension" },
      { name: "revenue", ref: "invoice.revenue", kind: "measure" },
      { name: "revenue_running", ref: "invoice.revenue", kind: "measure" },
    ]);
  });

  test("periods: n adds the trailing total, blank until n periods exist; a quarter steps by 3 months and an hour stays a timestamp", async () => {
    const root = await project();
    const c = compiled(compileRequest(root, running({ measures: ["invoice.revenue", "invoice.invoice_count"], running: { over: MONTH, periods: 3 } })));
    expect(c.sql).toContain(
      `  case when row_number() over (order by "invoice_date_month") >= 3 then sum("revenue") over (order by "invoice_date_month" rows between 2 preceding and current row) end as "revenue_trailing_3",`,
    );
    expect(c.columns.map((x) => x.name)).toEqual(["invoice_date_month", "revenue", "invoice_count", "revenue_trailing_3", "invoice_count_trailing_3"]);
    expect(c.sql).toContain(`coalesce("periods"."invoice_count", 0) as "invoice_count"`);
    const q = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: ["invoice.invoice_date:quarter"], running: { over: "invoice.invoice_date:quarter" } })));
    expect(q.sql).toContain(`interval '3 months') as date) as "invoice_date_quarter"`);
    const h = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: ["invoice.invoice_date:hour"], running: { over: "invoice.invoice_date:hour" } })));
    expect(h.sql).toContain(`select generate_series(cast(min("invoice_date_hour") as timestamp), cast(max("invoice_date_hour") as timestamp), interval '1 hour') as "invoice_date_hour"`);
  });

  test("each of these refuses with invalid_request, naming what to change", async () => {
    const root = await project();
    const cases: [Partial<QueryRequest>, string][] = [
      [{ dimensions: ["invoice.billing_country"], order_by: [] }, "is not one of the request's dimensions; add invoice.invoice_date:month to dimensions"],
      [{ running: { over: ":month" } }, "running.over names its time dimension in full, as model.field:month: write invoice.invoice_date:month"],
      [{ measures: ["invoice.avg_total"] }, "a measure with agg avg, which does not add up across periods; a running total takes sum and count measures"],
      [{ measures: ["invoice.customers"] }, "a measure with agg count_distinct"],
      [{ measures: ["invoice.balance"] }, "a balance is not added up across time, so it has no running total"],
      [{ measures: ["avg_invoice_value"] }, "a running total adds up measures, not metrics"],
      [{ filters: [{ field: "invoice.invoice_date", op: "gte", value: "2025-01-01" }] }, "filters[0] is on invoice.invoice_date, with no grain; a running total by month filters invoice.invoice_date at its grain"],
      [{ filters: [{ field: "invoice.invoice_date:year", op: "gte", value: "2025-01-01" }] }, "at grain year"],
      [{ measures: [] }, "the request names no measure"],
      [{ dimensions: [MONTH, "invoice.invoice_date:year"] }, "the same field as running.over at another grain"],
      [{ filters: [{ field: "invoice.revenue", op: "lt", value: 100 }] }, "a measure; a filter on a total would leave a period out of the running total"],
      [{ filters: [{ field: "avg_invoice_value", op: "gt", value: 1 }] }, "a measure; a filter on a total"],
    ];
    for (const [extra, says] of cases) {
      const r = refused(compileRequest(root, running(extra)));
      expect({ extra, codes: r.refusals.map((x) => x.code) }).toEqual({ extra, codes: r.refusals.map(() => "invalid_request") });
      expect(r.reason).toContain(says);
    }
    // The schema refuses a periods outside 2 to 120 and an unknown key.
    for (const bad of [{ over: MONTH, periods: 1 }, { over: MONTH, periods: 121 }, { over: MONTH, start: "x" }, { periods: 3 }])
      expect(refused(compileRequest(root, running({ running: bad as never }))).refusals[0]!.code).toBe("invalid_request");
  });

  test("a duckdb source refuses with unsupported_dialect, naming PostgreSQL", async () => {
    const root = await project({ dialect: "duckdb" });
    const r = refused(compileRequest(root, running()));
    expect(r.refusals.map((x) => x.code)).toEqual(["unsupported_dialect"]);
    expect(r.reason).toContain("a request with running compiles for PostgreSQL sources only");
    expect(r.refusals[0]!.next).toContain("without running");
  });

  test("a request without running compiles byte for byte as before", async () => {
    const root = await project();
    const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [MONTH], filters: [{ field: MONTH, op: "gte", value: "2025-01-01" }], order_by: [{ field: MONTH }] })));
    expect(c.sql).toBe(
      [
        "select",
        `  cast(date_trunc('month', invoice_date) as date) as "invoice_date_month",`,
        `  sum(total) as "revenue"`,
        `from "public"."invoice"`,
        "where (cast(date_trunc('month', invoice_date) as date)) >= $1",
        "group by 1",
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(c.params).toEqual(["2025-01-01"]);
  });

  test("the user's row filters narrow the inner request, and a measure the user may not see refuses the whole request", async () => {
    const access = { ...ok, mode: "open", roles: [{ name: "finland", row_filters: [{ model: "shop.invoice", expr: "billing_country = 'Finland'" }] }] };
    const root = await project({ access });
    const c = compiled(compileRequest(root, running(), { role: "finland" }));
    expect(c.sql).toContain(`from "public"."invoice"\nwhere (billing_country = 'Finland')\ngroup by 1\n),`);
    expect(c.row_filters.map((r) => [r.model, r.in])).toEqual([["invoice", "where"]]);
    const hidden = refused(compileRequest(root, running({ measures: ["invoice.revenue", "invoice.pending_revenue"] })));
    expect(hidden.refusals.map((x) => x.code)).toEqual(["not_visible"]);
    expect(hidden.refusals[0]!.ref).toBe("invoice.pending_revenue");
  });

  test("on a Sunday-week source the series steps by the source's weeks, so an empty week lines up and carries the total", async () => {
    const root = await project({ calendar: { week_start: "sunday" } });
    const week = "invoice.invoice_date:week";
    const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [week], running: { over: week }, order_by: [{ field: week }] })));
    expect(c.sql).toContain(`  cast(date_trunc('week', (invoice_date) + interval '1 day') - interval '1 day' as date) as "invoice_date_week",`);
    expect(c.sql).toContain(`interval '1 week') as date) as "invoice_date_week"`);
  });

  test.skipIf(!PG_URL)("on a live server a Sunday-week running total carries empty weeks, equal to a hand sum per week", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("t_cumulative");
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      await db.unsafe(`create schema "${schema}"`);
      await db.unsafe(`create table "${schema}".invoice (invoice_id integer, customer_id integer, invoice_date timestamp, billing_country text, total numeric(10,2))`);
      // Saturday 30 Dec 2023, Wednesday 10 Jan 2024 and Wednesday 24 Jan 2024: Sunday weeks 24 Dec, 7 Jan
      // and 21 Jan hold rows; the weeks of 31 Dec and 14 Jan are empty.
      await db.unsafe(
        `insert into "${schema}".invoice values (1, 1, '2023-12-30 10:00', 'A', 1.50), (2, 2, '2024-01-10 23:00', 'B', 2.25), (3, 1, '2024-01-24 00:00', 'A', 4.00), (4, 1, null, 'A', 100.00)`,
      );
      const root = await project({ calendar: { week_start: "sunday" }, table: `${schema}.invoice` });
      const week = "invoice.invoice_date:week";
      const c = compiled(compileRequest(root, req({ measures: ["invoice.revenue"], dimensions: [week], running: { over: week }, order_by: [{ field: week }] })));
      const rows = (await db.unsafe(`select cast(invoice_date_week as text) as w, cast(revenue as float8) as v, cast(revenue_running as float8) as r from (${c.sql}) q order by 1`)) as Row[];
      expect(rows.map((x) => ({ ...x }))).toEqual([
        { w: "2023-12-24", v: 1.5, r: 1.5 },
        { w: "2023-12-31", v: 0, r: 1.5 },
        { w: "2024-01-07", v: 2.25, r: 3.75 },
        { w: "2024-01-14", v: 0, r: 3.75 },
        { w: "2024-01-21", v: 4, r: 7.75 },
      ]);
      // Each week's running total is the sum of every invoice before the week's next Sunday; the
      // invoice with no date has no week and is in none.
      for (const x of rows) {
        const hand = (await db.unsafe(`select cast(sum(total) as float8) as s from "${schema}".invoice where invoice_date < cast($1 as date) + 7`, [x.w])) as Row[];
        expect({ w: x.w, r: x.r }).toEqual({ w: x.w, r: hand[0]!.s });
      }
    } finally {
      await db.unsafe(`drop schema if exists "${schema}" cascade`);
      await db.close();
    }
  });
});

describe("the running option in words and in the golden hash", () => {
  const golden = (running: Obj): Golden =>
    ({
      name: "running_revenue",
      question: "What is revenue to date each month?",
      request: { source: "shop", measures: ["invoice.revenue"], dimensions: [MONTH], running, filters: [{ field: MONTH, op: "gte", value: "2025-01-01" }] },
      status: "draft",
    }) as unknown as Golden;

  test("timeShapeWords states the running and the trailing total and what a filter on the period does", () => {
    expect(timeShapeWords(golden({ over: MONTH }).request)).toEqual([
      "Running total of each figure (revenue_running) over invoice.invoice_date by month, from the first month of data; a month with no rows adds 0; rows with no invoice.invoice_date are left out.",
      "A filter on invoice.invoice_date:month only picks the months shown; the totals still start at the first month of data.",
    ]);
    expect(timeShapeWords(golden({ over: MONTH, periods: 3 }).request)[0]).toBe(
      "Total of the last 3 months of each figure (revenue_trailing_3) over invoice.invoice_date by month, each month included; blank until 3 months of data; a month with no rows adds 0; rows with no invoice.invoice_date are left out.",
    );
    expect(timeShapeWords({ source: "shop", measures: ["invoice.revenue"] })).toEqual([]);
  });

  test("the golden hash covers running, periods included, and the golden reads still see its measures", () => {
    const h = (r: Obj) => goldenHash(golden(r) as unknown as Obj, [{ revenue: 1 }], 0);
    expect(h({ over: MONTH, periods: 3 })).not.toBe(h({ over: MONTH, periods: 4 }));
    expect(h({ over: MONTH })).not.toBe(h({ over: MONTH, periods: 3 }));
    const model = invoiceModel("public.invoice") as unknown as Model;
    const g = golden({ over: MONTH });
    expect(goldenReads(g, [model], []).map((r) => r.ref)).toEqual(["shop.invoice.revenue", "shop.invoice.invoice_date"]);
    const draft = { ...g, request: { ...g.request, measures: ["invoice.pending_revenue"] } } as Golden;
    expect(goldenDraftFields(draft, [model], [])).toEqual(["shop.invoice.pending_revenue"]);
  });

  test("goldens new prints the sentence, and semlayer sql prints it beside the SQL", async () => {
    const root = await project();
    const request = JSON.stringify(running({ running: { over: MONTH, periods: 3 } }));
    const g = await semlayer(root, ["goldens", "new", "--name", "trailing", "--question", "Revenue over the last three months?", "--request", request]);
    expect(g.code).toBe(0);
    expect(g.out).toContain("Total of the last 3 months of each figure (revenue_trailing_3) over invoice.invoice_date by month");
    const s = await semlayer(root, ["sql", "--request", request]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("blank until 3 months of data");
    const refusedSql = await semlayer(root, ["sql", "--request", JSON.stringify(running({ measures: ["invoice.avg_total"] }))]);
    expect(refusedSql.code).toBe(1);
    expect(refusedSql.err).toContain("a running total takes sum and count measures");
  });
});

describe("a running golden follows a rename", () => {
  test("renaming the over field or its model rewrites running.over beside the dimensions, so the golden still compiles", async () => {
    const root = await project();
    // A balance measure names invoice_date, which a rename does not follow; leave it out here.
    writeYaml(join(root, "models", "shop", "invoice.yaml"), invoiceModel("public.invoice", (m) => void ((m.measures as Obj[]) = (m.measures as Obj[]).filter((x) => x.name !== "balance"))));
    const request = JSON.stringify(running());
    expect((await semlayer(root, ["goldens", "new", "--name", "rt", "--question", "Revenue to date?", "--request", request])).code).toBe(0);
    const read = () => (readYaml(join(root, "goldens", "rt.yaml")) as { request: { running: { over: string }; dimensions: string[] } }).request;
    const rn = await semlayer(root, ["rename", "shop.invoice.invoice_date", "issued_at"]);
    expect(rn.err).toBe("");
    expect(rn.code).toBe(0);
    expect(read()).toMatchObject({ running: { over: "invoice.issued_at:month" }, dimensions: ["invoice.issued_at:month"] });
    expect((await semlayer(root, ["rename", "shop.invoice", "bill"])).code).toBe(0);
    expect(read()).toMatchObject({ running: { over: "bill.issued_at:month" }, dimensions: ["bill.issued_at:month"] });
  });
});

// The last n days against the n days before and the same dates a year earlier on a live server
// (spec: Metric semantics, Running totals and comparisons), on whatever server PG_URL names; the CI
// `compat` job runs it once per supported major version. The Chinook layer (chinook-layer.ts)
// answers each figure of the plan's C6 block, each asserted beside a hand-written query over the
// invoice table: a plain sum, count or both between two date bounds written out here, never the
// compiler's dates, so a wrong window cannot pass by agreeing with itself. The total and the
// by-country goldens are confirmed with semlayer goldens confirm.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, confirmWithYes, PG_URL, semlayer } from "../helpers.ts";
import { type ChinookLayer, chinookLayer } from "./chinook-layer.ts";

type Row = Record<string, unknown>;
let layer: ChinookLayer | undefined;
let pg: SQL | undefined;

beforeAll(async () => {
  if (!PG_URL) return;
  layer = await chinookLayer(PG_URL);
  pg = new SQL({ url: PG_URL, max: 1 });
}, 60_000);

afterAll(async () => {
  await pg?.close();
  await layer?.cleanup();
});

const DATE = "invoice.invoice_date";
const window = (as_of: string, dimension = DATE) => ({ dimension, days: 30, as_of });
const base = { source: "chinook", measures: ["invoice.revenue"], window: window("2025-12-22"), compare: { with: ["prior", "year_ago"] } };
const COLS = ["revenue", "revenue_prior", "revenue_prior_change", "revenue_prior_pct", "revenue_year_ago", "revenue_year_ago_change", "revenue_year_ago_pct"];
const num = (k: string, v: unknown) => (v === null ? null : k === "billing_country" ? String(v) : Number(v));
const ten = (v: unknown) => (v === null ? null : Number((v as number).toFixed(10)));

// The compiled request (semlayer sql --json, as the role given), each figure a number, null kept.
async function rows(request: Record<string, unknown>, args: string[] = []): Promise<Row[]> {
  const c = (await layer!.run(["sql", "--request", JSON.stringify(request), "--json", ...args])).json<{ sql: string; params: unknown[]; columns: { name: string }[] }>();
  const select = c.columns.map((x) => `cast("${x.name}" as text) as "${x.name}"`).join(", ");
  const out = (await pg!.begin("read only", (tx) => tx.unsafe(`select ${select} from (${c.sql}) q`, c.params as never[]))) as Row[];
  return [...out].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(k, v)])));
}

// By hand: revenue, invoices and revenue per invoice between two dates (from included, to not), on
// the column expression given, grouped by country when asked.
async function hand(from: string, to: string, opts: { on?: string; byCountry?: boolean; where?: string } = {}): Promise<Row[]> {
  const on = opts.on ?? "invoice_date";
  const sql = `select ${opts.byCountry ? "billing_country, " : ""}cast(coalesce(sum(total), 0) as text) as revenue, cast(count(*) as text) as n, cast(sum(total) / nullif(count(*), 0) as text) as avg
    from "${layer!.schema}".invoice where ${on} >= '${from}' and ${on} < '${to}' and (${opts.where ?? "true"})${opts.byCountry ? " group by billing_country" : ""}`;
  return [...((await pg!.unsafe(sql)) as Row[])].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(k, v)])));
}
const revenue = async (from: string, to: string, on?: string) => (await hand(from, to, { on }))[0]!.revenue as number;

describe("revenue over the last 30 days against the 30 days before and a year earlier on the Chinook invoices", () => {
  test.skipIf(!PG_URL)("as of 2025-12-22: 38.62 against 49.62 prior and 37.62 a year earlier, each a plain sum over its dates", async () => {
    const [r] = await rows(base);
    const cur = await revenue("2025-11-23", "2025-12-23");
    const prior = await revenue("2025-10-24", "2025-11-23");
    const ya = await revenue("2024-11-23", "2024-12-23");
    expect([cur, prior, ya]).toEqual([38.62, 49.62, 37.62]);
    expect([r!.revenue, r!.revenue_prior, r!.revenue_year_ago]).toEqual([cur, prior, ya]);
    expect([r!.revenue_prior_change, ten(r!.revenue_prior_pct)]).toEqual([-11, -0.2216848045]);
    expect([r!.revenue_year_ago_change, ten(r!.revenue_year_ago_pct)]).toEqual([1, 0.0265816055]);
    expect([ten(r!.revenue_prior_pct), ten(r!.revenue_year_ago_pct)]).toEqual([ten((cur - prior) / prior), ten((cur - ya) / ya)]);
  });

  test.skipIf(!PG_URL)("by billing country, revenue descending, top 5; without the limit 14 countries, Czech Republic 0 against 25.86", async () => {
    const order = [{ field: "invoice.revenue", direction: "desc" }, { field: "invoice.billing_country" }];
    const r = await rows({ ...base, dimensions: ["invoice.billing_country"], order_by: order, limit: 5 });
    expect(r.map((x) => [x.billing_country, x.revenue, x.revenue_prior, x.revenue_year_ago])).toEqual([
      ["Finland", 13.86, 1.98, 0],
      ["Portugal", 8.91, 0, 0],
      ["USA", 7.92, 0.99, 0],
      ["Canada", 5.94, 0, 0.99],
      ["India", 1.99, 0, 0],
    ]);
    const portugal = r[1]!;
    expect([portugal.revenue_prior_change, portugal.revenue_prior_pct, portugal.revenue_year_ago_pct]).toEqual([8.91, null, null]);
    expect([r[0]!.revenue_prior_pct, r[3]!.revenue_year_ago_pct]).toEqual([6, 5]);

    // By hand: every country with an invoice in any of the three windows, 0 where a window has none.
    const [cur, prior, ya] = await Promise.all([
      hand("2025-11-23", "2025-12-23", { byCountry: true }),
      hand("2025-10-24", "2025-11-23", { byCountry: true }),
      hand("2024-11-23", "2024-12-23", { byCountry: true }),
    ]);
    const of = (list: Row[], c: string) => (list.find((x) => x.billing_country === c)?.revenue as number | undefined) ?? 0;
    const countries = [...new Set([...cur, ...prior, ...ya].map((x) => x.billing_country as string))];
    const expected = countries
      .map((c) => [c, of(cur, c), of(prior, c), of(ya, c)] as [string, number, number, number])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const all = await rows({ ...base, dimensions: ["invoice.billing_country"], order_by: order });
    expect(all.length).toBe(14);
    expect(all.map((x) => [x.billing_country, x.revenue, x.revenue_prior, x.revenue_year_ago])).toEqual(expected);
    expect(r.map((x) => x.billing_country)).toEqual(expected.slice(0, 5).map((x) => x[0]));
    const czech = all.find((x) => x.billing_country === "Czech Republic")!;
    expect([czech.revenue, czech.revenue_prior, czech.revenue_prior_change, ten(czech.revenue_prior_pct)]).toEqual([0, 25.86, -25.86, -1]);
  });

  test.skipIf(!PG_URL)("avg_invoice_value is each window's revenue over its own 7 invoices, compared after the division", async () => {
    const [r] = await rows({ ...base, measures: ["avg_invoice_value"] });
    const [cur, prior, ya] = (await Promise.all([hand("2025-11-23", "2025-12-23"), hand("2025-10-24", "2025-11-23"), hand("2024-11-23", "2024-12-23")])).map((x) => x[0]!);
    expect([cur!.n, prior!.n, ya!.n]).toEqual([7, 7, 7]);
    expect([ten(r!.avg_invoice_value), ten(r!.avg_invoice_value_prior), ten(r!.avg_invoice_value_year_ago)]).toEqual([5.5171428571, 7.0885714286, 5.3742857143]);
    expect([ten(r!.avg_invoice_value), ten(r!.avg_invoice_value_prior), ten(r!.avg_invoice_value_year_ago)]).toEqual([ten(cur!.avg), ten(prior!.avg), ten(ya!.avg)]);
    const [c, p, y] = [cur!.avg as number, prior!.avg as number, ya!.avg as number];
    expect([ten(r!.avg_invoice_value_prior_change), ten(r!.avg_invoice_value_prior_pct)]).toEqual([ten(c - p), ten((c - p) / p)]);
    expect([ten(r!.avg_invoice_value_year_ago_change), ten(r!.avg_invoice_value_year_ago_pct)]).toEqual([ten(c - y), ten((c - y) / y)]);
  });

  test.skipIf(!PG_URL)("as of 2022-01-15 the year-ago window starts on 2020-12-17, before the data begins on 2021-01-01, so it is blank", async () => {
    const [r] = await rows({ ...base, window: window("2022-01-15") });
    const [first] = (await pg!.unsafe(`select cast(cast(min(invoice_date) as date) as text) as d from "${layer!.schema}".invoice`)) as Row[];
    expect(first!.d).toBe("2021-01-01");
    expect([r!.revenue, r!.revenue_prior]).toEqual([await revenue("2021-12-17", "2022-01-16"), await revenue("2021-11-17", "2021-12-17")]);
    expect([r!.revenue, r!.revenue_prior, r!.revenue_prior_change]).toEqual([47.62, 37.62, 10]);
    expect([r!.revenue_year_ago, r!.revenue_year_ago_change, r!.revenue_year_ago_pct]).toEqual([null, null, null]);
    // The current window before the data is blank too.
    const [early] = await rows({ ...base, window: window("2021-01-15") });
    expect(COLS.map((c) => early![c])).toEqual(COLS.map(() => null));
  });

  test.skipIf(!PG_URL)("as of 2025-03-10 the year-ago window is 31 days and holds the 0.99 invoice of 2024-02-09 a 30-day window would leave out", async () => {
    const [r] = await rows({ ...base, window: window("2025-03-10") });
    const ya = await revenue("2024-02-09", "2024-03-11");
    expect([r!.revenue_year_ago, ya]).toEqual([37.62, 37.62]);
    expect(await revenue("2024-02-10", "2024-03-11")).toBe(36.63);
    expect(await revenue("2024-02-09", "2024-02-10")).toBe(0.99);
    expect([r!.revenue, r!.revenue_prior]).toEqual([await revenue("2025-02-09", "2025-03-11"), await revenue("2025-01-10", "2025-02-09")]);
    const words = (await layer!.run(["sql", "--request", JSON.stringify({ ...base, window: window("2025-03-10") })])).out;
    expect(words).toContain("against 2024-02-09 to 2024-03-10; days of invoice.invoice_date");
    expect(words).toContain("The year-ago window is 31 days, not 30");
  });

  test.skipIf(!PG_URL)("as of 2025-12-21 a day is a day of the dimension's expr: 36.63 on invoice_date, 38.62 on New York days", async () => {
    const ny = "((invoice_date at time zone 'UTC') at time zone 'America/New_York')";
    const [utc] = await rows({ ...base, window: window("2025-12-21"), compare: { with: ["prior"] } });
    const [nyc] = await rows({ ...base, window: window("2025-12-21", "invoice.invoice_date_ny"), compare: { with: ["prior"] } });
    expect([utc!.revenue, await revenue("2025-11-22", "2025-12-22")]).toEqual([36.63, 36.63]);
    expect([nyc!.revenue, await revenue("2025-11-22", "2025-12-22", ny)]).toEqual([38.62, 38.62]);
    expect(await revenue("2025-12-22", "2025-12-23")).toBe(1.99);
    expect([utc!.revenue_prior, nyc!.revenue_prior]).toEqual([await revenue("2025-10-23", "2025-11-22"), await revenue("2025-10-23", "2025-11-22", ny)]);
  });

  test.skipIf(!PG_URL)("a role's row filter puts every window over the rows it may see; a draft measure refuses the whole request", async () => {
    const { run, root } = layer!;
    await run(["set", "access", "mode", "open"]);
    await run(["add-role", "--name", "finland_window", "--description", "Sees Finnish invoices only."]);
    await run(["add-row-filter", "--role", "finland_window", "--model", "chinook.invoice", "--expr", "billing_country = 'Finland'"]);
    const a = await approveWithYes(root, ["--target", "access", "--by", "Test Owner"]);
    expect({ code: a.code, err: a.err }).toEqual({ code: 0, err: "" });
    const [r] = await rows(base, ["--role", "finland_window"]);
    const where = "billing_country = 'Finland'";
    const [c, p, y] = (await Promise.all([hand("2025-11-23", "2025-12-23", { where }), hand("2025-10-24", "2025-11-23", { where }), hand("2024-11-23", "2024-12-23", { where })])).map((x) => x[0]!.revenue);
    expect([r!.revenue, r!.revenue_prior, r!.revenue_year_ago]).toEqual([c, p, y]);
    expect([r!.revenue, r!.revenue_prior, r!.revenue_year_ago]).toEqual([13.86, 1.98, 0]);
    await run(["add-field", "chinook.invoice", "--kind", "measure", "--name", "draft_revenue", "--expr", "total", "--agg", "sum", "--description", "Not approved."]);
    const refused = await semlayer(root, ["sql", "--request", JSON.stringify({ ...base, measures: ["invoice.revenue", "invoice.draft_revenue"] }), "--json"], layer!.env);
    expect(refused.code).toBe(1);
    expect(refused.json<{ refusals: { code: string }[] }>().refusals.map((x) => x.code)).toEqual(["not_visible"]);
    await run(["remove-field", "chinook.invoice.draft_revenue"]);
  });

  test.skipIf(!PG_URL)("the total and by-country goldens are confirmed and read back in words; a changed as_of needs a new yes, and no as_of fails validate", async () => {
    const { run, root, env } = layer!;
    const goldens: [string, string, Record<string, unknown>, number][] = [
      ["revenue_last_30", "What was revenue over the 30 days to 2025-12-22, against the 30 days before and a year earlier?", base, 1],
      [
        "revenue_last_30_by_country",
        "Which five billing countries had the most revenue over the 30 days to 2025-12-22, against the 30 days before and a year earlier?",
        { ...base, dimensions: ["invoice.billing_country"], order_by: [{ field: "invoice.revenue", direction: "desc" }, { field: "invoice.billing_country" }], limit: 5 },
        5,
      ],
    ];
    const words = "Over the 30 days 2025-11-23 to 2025-12-22 (as of 2025-12-22), against 2025-10-24 to 2025-11-22 and against 2024-11-23 to 2024-12-22";
    for (const [name, question, request, n] of goldens) {
      const made = await run(["goldens", "new", "--name", name, "--question", question, "--request", JSON.stringify(request)]);
      expect(made.out).toContain(words);
      const rb = await run(["readback", "--targets", `golden:${name}`, "--json"]);
      expect(rb.json<{ items: { text: string }[] }>().items[0]!.text).toContain(`  - ${words}`);
      const ran = await run(["goldens", "run", "--name", name]);
      expect(ran.out).toContain(words);
      const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Test Owner", "--tolerance", "0"], {}, env);
      expect({ code: confirmed.code }).toEqual({ code: 0 });
      const g = readYaml<Golden>(join(root, "goldens", `${name}.yaml`));
      expect([g.status, g.request.window, g.expected!.rows.length]).toEqual(["approved", window("2025-12-22"), n]);
      expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
    }
    const file = join(root, "goldens", "revenue_last_30.yaml");
    const g = readYaml<Golden>(file);
    expect(Number(g.expected!.rows[0]!.revenue)).toBe(38.62);
    const byCountry = readYaml<Golden>(join(root, "goldens", "revenue_last_30_by_country.yaml"));
    expect(byCountry.expected!.rows.map((x) => [x.billing_country, Number(x.revenue)])).toEqual([["Finland", 13.86], ["Portugal", 8.91], ["USA", 7.92], ["Canada", 5.94], ["India", 1.99]]);

    // The owner's yes is to these dates: a changed as_of after the confirm needs a new one.
    writeYaml(file, { ...g, request: { ...g.request, window: window("2025-12-21") } });
    expect((await run(["status", "--json"])).json<{ approved_without_yes: string[] }>().approved_without_yes).toContain("golden:revenue_last_30");
    const moved = await semlayer(root, ["goldens", "check", "--name", "revenue_last_30"], env);
    expect(moved.code).toBe(1);
    // The recorded rows are the owner's yes to 2025-11-23 to 2025-12-22; 2025-11-22 to 2025-12-21 gives others.
    expect(moved.out).toContain("expected {revenue: 38.62");
    expect(moved.out).toContain("got {revenue: 36.63");
    // A golden with no as_of fails validate, and the check refuses it rather than run it for today.
    const { as_of: _, ...open } = g.request.window!;
    writeYaml(file, { ...g, request: { ...g.request, window: open } });
    const v = await semlayer(root, ["validate", "--json"], env);
    expect(v.code).toBe(1);
    expect(JSON.stringify(v.json())).toContain("metric.window_as_of_missing");
    const check = await semlayer(root, ["goldens", "check", "--name", "revenue_last_30", "--json"], env);
    expect(check.code).toBe(1);
    expect(check.out).not.toContain("2025-11-23");
    writeYaml(file, g);
    expect((await semlayer(root, ["goldens", "check", "--name", "revenue_last_30"], env)).code).toBe(0);
  });
});

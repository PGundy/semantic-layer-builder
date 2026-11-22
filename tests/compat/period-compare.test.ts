// Comparison with the prior period and a year earlier on a live server (spec: Metric semantics,
// Running totals and comparisons), on whatever server PG_URL names; the CI `compat` job runs it once
// per supported major version. The Chinook layer (chinook-layer.ts) answers each figure of the plan's
// C5 block, each asserted beside a hand-written query over the invoice table: every month from the
// first to the last, its sum left joined to the invoices, and the earlier figures read by a self-join
// of those months one month and one year back (not with lag), so a wrong lag or a wrong year-ago join
// cannot pass by agreeing with itself. The comparison golden is confirmed with semlayer goldens confirm.
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

const MONTH = "invoice.invoice_date:month";
const FROM_2025 = { field: MONTH, op: "gte", value: "2025-01-01" };
const FINLAND = { field: "invoice.billing_country", op: "eq", value: "Finland" };
const base = { source: "chinook", measures: ["invoice.revenue"], dimensions: [MONTH], compare: { over: MONTH, with: ["prior", "year_ago"] }, order_by: [{ field: MONTH }] };
const toNum = (k: string, v: unknown) => (v === null ? null : /_month$/.test(k) ? String(v) : Number(v));

// The compiled request (semlayer sql --json, as the role given), each period as text and each figure
// a number, null kept.
async function rows(request: Record<string, unknown>, args: string[] = []): Promise<Row[]> {
  const c = (await layer!.run(["sql", "--request", JSON.stringify(request), "--json", ...args])).json<{ sql: string; params: unknown[]; columns: { name: string }[] }>();
  const select = c.columns.map((x) => `cast("${x.name}" as text) as "${x.name}"`).join(", ");
  const out = (await pg!.begin("read only", (tx) => tx.unsafe(`select ${select} from (${c.sql}) q`, c.params as never[]))) as Row[];
  return [...out].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toNum(k, v)])));
}

// By hand, from the invoice table: every month from the first invoice's to the last (of the rows
// `where` keeps), with its revenue (0 when it has none) and its invoices, and each month's revenue
// a month and a year back by a self-join on the month; the ratio is per month, then compared.
async function hand(where = "true"): Promise<Map<string, Row>> {
  const t = `"${layer!.schema}".invoice`;
  const sql = `
    with months as (
      select cast(g as date) as m from generate_series(
        (select date_trunc('month', min(invoice_date)) from ${t} where ${where}),
        (select date_trunc('month', max(invoice_date)) from ${t} where ${where}), interval '1 month') g),
    sums as (
      select months.m, coalesce(sum(i.total), 0) as v, count(i.invoice_id) as n, sum(i.total) / nullif(count(i.invoice_id), 0) as avg
      from months left join ${t} i on cast(date_trunc('month', i.invoice_date) as date) = months.m and (${where.replaceAll("billing_country", "i.billing_country")})
      group by months.m)
    select cast(cur.m as text) as invoice_date_month,
      cast(cur.v as text) as revenue,
      cast(prev.v as text) as revenue_prior, cast(cur.v - prev.v as text) as revenue_prior_change, cast((cur.v - prev.v) / nullif(prev.v, 0) as text) as revenue_prior_pct,
      cast(ya.v as text) as revenue_year_ago, cast(cur.v - ya.v as text) as revenue_year_ago_change, cast((cur.v - ya.v) / nullif(ya.v, 0) as text) as revenue_year_ago_pct,
      cast(cur.avg as text) as avg_invoice_value, cast(prev.avg as text) as avg_invoice_value_prior, cast(cur.avg - prev.avg as text) as avg_invoice_value_prior_change,
      cast((cur.avg - prev.avg) / nullif(prev.avg, 0) as text) as avg_invoice_value_prior_pct
    from sums cur
    left join sums prev on prev.m = cast(cur.m - interval '1 month' as date)
    left join sums ya on ya.m = cast(cur.m - interval '1 year' as date)
    order by cur.m`;
  const out = (await pg!.unsafe(sql)) as Row[];
  return new Map([...out].map((r) => [String(r.invoice_date_month), Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toNum(k, v)]))]));
}
const at = (list: Row[], month: string) => list.find((r) => r.invoice_date_month === month)!;
const COLS = ["revenue", "revenue_prior", "revenue_prior_change", "revenue_prior_pct", "revenue_year_ago", "revenue_year_ago_change", "revenue_year_ago_pct"];
const pick = (r: Row, cols = COLS) => Object.fromEntries([["invoice_date_month", r.invoice_date_month], ...cols.map((c) => [c, r[c]])]);
const pct = (v: unknown) => (v === null ? null : Number((v as number).toFixed(10)));

describe("revenue against the month before and a year earlier on the Chinook invoices", () => {
  test.skipIf(!PG_URL)("2025 by month: 12 rows, January's prior from December 2024 outside the filter, each equal to the hand query", async () => {
    const r = await rows({ ...base, filters: [FROM_2025] });
    expect(r.length).toBe(12);
    const h = await hand();
    for (const x of r) expect(pick(x)).toEqual(pick(h.get(x.invoice_date_month as string)!));
    expect([at(r, "2025-01-01").revenue_prior, h.get("2024-12-01")!.revenue]).toEqual([37.62, 37.62]);
    const feb = at(r, "2025-02-01");
    expect([feb.revenue, feb.revenue_prior, feb.revenue_prior_change, pct(feb.revenue_prior_pct), feb.revenue_year_ago]).toEqual([27.72, 37.62, -9.9, -0.2631578947, 37.62]);
    const dec = at(r, "2025-12-01");
    expect([dec.revenue, dec.revenue_prior, dec.revenue_prior_change, pct(dec.revenue_prior_pct)]).toEqual([38.62, 49.62, -11, -0.2216848045]);
    expect([dec.revenue_year_ago, dec.revenue_year_ago_change, pct(dec.revenue_year_ago_pct), h.get("2024-12-01")!.revenue]).toEqual([37.62, 1, 0.0265816055, 37.62]);
  });

  test.skipIf(!PG_URL)("unfiltered: blank where the earlier month is before the data, and 2022-01 against 2021-01", async () => {
    const r = await rows(base);
    expect(r.length).toBe(60);
    const h = await hand();
    expect(r.map((x) => pick(x))).toEqual([...h.values()].map((x) => pick(x)));
    const jan21 = at(r, "2021-01-01");
    expect([jan21.revenue_prior, jan21.revenue_prior_change, jan21.revenue_year_ago, jan21.revenue_year_ago_pct]).toEqual([null, null, null, null]);
    expect([at(r, "2021-12-01").revenue_year_ago, at(r, "2021-12-01").revenue_year_ago_change]).toEqual([null, null]);
    expect(at(r, "2021-12-01").revenue_prior).not.toBeNull();
    const jan22 = at(r, "2022-01-01");
    expect([jan22.revenue, jan22.revenue_year_ago, jan22.revenue_year_ago_change, pct(jan22.revenue_year_ago_pct)]).toEqual([52.62, 35.64, 16.98, 0.4764309764]);
  });

  test.skipIf(!PG_URL)("Finland: an empty month counts as 0, so the next is against 0 with pct blank", async () => {
    const r = await rows({ ...base, filters: [FINLAND] });
    expect(r.length).toBe(53);
    const h = await hand("billing_country = 'Finland'");
    expect(r.map((x) => pick(x))).toEqual([...h.values()].map((x) => pick(x)));
    const nov = at(r, "2025-11-01");
    expect([at(r, "2025-10-01").revenue, nov.revenue, nov.revenue_prior, nov.revenue_prior_change, nov.revenue_prior_pct, nov.revenue_year_ago]).toEqual([0, 1.98, 0, 1.98, null, 0]);
    const dec = at(r, "2025-12-01");
    expect([dec.revenue, dec.revenue_prior, dec.revenue_prior_change, dec.revenue_prior_pct]).toEqual([13.86, 1.98, 11.88, 6]);
  });

  test.skipIf(!PG_URL)("avg_invoice_value by month is revenue over invoice_count in each month, compared after the division", async () => {
    const r = await rows({ ...base, measures: ["avg_invoice_value"], compare: { over: MONTH, with: ["prior"] } });
    const h = await hand();
    expect(r.length).toBe(60);
    const cols = ["avg_invoice_value", "avg_invoice_value_prior", "avg_invoice_value_prior_change", "avg_invoice_value_prior_pct"];
    const round = (x: Row) => Object.fromEntries(Object.entries(pick(x, cols)).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(10)) : v]));
    expect(r.map(round)).toEqual([...h.values()].map(round));
    // The change is between the two months' ratios, not a ratio of the changes.
    const feb = at(r, "2025-02-01");
    const [x] = (await pg!.unsafe(
      `select cast(sum(total) filter (where invoice_date >= '2025-02-01') / count(*) filter (where invoice_date >= '2025-02-01') - sum(total) filter (where invoice_date < '2025-02-01') / count(*) filter (where invoice_date < '2025-02-01') as text) as v
       from "${layer!.schema}".invoice where invoice_date >= '2025-01-01' and invoice_date < '2025-03-01'`,
    )) as Row[];
    expect(Number((feb.avg_invoice_value_prior_change as number).toFixed(10))).toBe(Number(Number(x!.v).toFixed(10)));
  });

  test.skipIf(!PG_URL)("a role's row filter compares the rows it may see", async () => {
    const { run, root } = layer!;
    await run(["set", "access", "mode", "open"]);
    await run(["add-role", "--name", "finland_compare", "--description", "Sees Finnish invoices only."]);
    await run(["add-row-filter", "--role", "finland_compare", "--model", "chinook.invoice", "--expr", "billing_country = 'Finland'"]);
    const a = await approveWithYes(root, ["--target", "access", "--by", "Test Owner"]);
    expect({ code: a.code, err: a.err }).toEqual({ code: 0, err: "" });
    const r = await rows(base, ["--role", "finland_compare"]);
    expect(r).toEqual(await rows({ ...base, filters: [FINLAND] }));
    expect(at(r, "2025-12-01").revenue_prior_pct).toBe(6);
  });

  test.skipIf(!PG_URL)("the comparison golden is confirmed, reads back in words, shows its columns, and a changed with needs a new yes", async () => {
    const { run, root, env } = layer!;
    const name = "revenue_mom_yoy_2025";
    const request = { ...base, filters: [FROM_2025] };
    const made = await run(["goldens", "new", "--name", name, "--question", "How did each month of 2025 compare with the month before and a year earlier?", "--request", JSON.stringify(request)]);
    const words = "Each figure beside the month before and the same month a year earlier, with the change and the change as a fraction of the earlier figure";
    expect(made.out).toContain(words);
    const rb = await run(["readback", "--targets", `golden:${name}`, "--json"]);
    const text = rb.json<{ items: { text: string }[] }>().items[0]!.text;
    expect(text).toContain(`  - ${words}`);
    expect(text).toContain("A filter on invoice.invoice_date:month only picks the months shown");
    const ran = await run(["goldens", "run", "--name", name]);
    expect(ran.out).toContain(words);
    const header = ran.out.split("\n").find((l) => l.startsWith("invoice_date_month") && l.includes("revenue_year_ago_pct"));
    expect(header).toBeDefined();
    for (const c of COLS) expect(header!.split(/\s+/)).toContain(c);
    const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Test Owner", "--tolerance", "0"], {}, env);
    expect({ code: confirmed.code }).toEqual({ code: 0 });
    expect(confirmed.out).toContain(words);
    const file = join(root, "goldens", `${name}.yaml`);
    const g = readYaml<Golden>(file);
    expect(g.status).toBe("approved");
    expect(g.request.compare).toEqual({ over: MONTH, with: ["prior", "year_ago"] });
    const recorded = g.expected!.rows;
    expect(recorded.length).toBe(12);
    const feb = recorded.find((x) => String(x.invoice_date_month).startsWith("2025-02"))!;
    expect([Number(feb.revenue), Number(feb.revenue_prior), Number(feb.revenue_prior_change), Number(feb.revenue_year_ago)]).toEqual([27.72, 37.62, -9.9, 37.62]);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
    expect((await run(["status", "--json"])).json<{ approved_without_yes: string[] }>().approved_without_yes).not.toContain(`golden:${name}`);

    // The owner's yes is to this request: a with changed after the confirm needs a new one.
    writeYaml(file, { ...g, request: { ...g.request, compare: { over: MONTH, with: ["prior"] } } });
    expect((await run(["status", "--json"])).json<{ approved_without_yes: string[] }>().approved_without_yes).toContain(`golden:${name}`);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(1);
    writeYaml(file, g);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
  });
});

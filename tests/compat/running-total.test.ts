// Running and trailing totals on a live server (spec: Metric semantics, Running totals and
// comparisons), on whatever server PG_URL names; the CI `compat` job runs it once per supported
// major version. The Chinook layer (chinook-layer.ts) answers each figure of the plan's C4 block,
// each asserted beside a hand-written query over the invoice table that computes it directly; the
// running-total golden is confirmed with semlayer goldens confirm. A running total over the Acme
// warehouse's orders and refunds, two models, is checked month by month against hand sums.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgres } from "../../fixtures/acme/load-postgres.ts";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, confirmWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";
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
const base = { source: "chinook", measures: ["invoice.revenue", "invoice.invoice_count"], dimensions: [MONTH], running: { over: MONTH }, order_by: [{ field: MONTH }] };

// The compiled request (semlayer sql --json, as the user role and attributes given) run in a read-only
// transaction in the session time zone given, each period as text and each figure a number (null kept).
async function rows(request: Record<string, unknown>, zone = "UTC", args: string[] = []): Promise<Row[]> {
  const c = (await layer!.run(["sql", "--request", JSON.stringify(request), "--json", ...args])).json<{ sql: string; params: unknown[]; columns: { name: string; kind: string }[] }>();
  const select = c.columns.map((x) => `cast("${x.name}" as text) as "${x.name}"`).join(", ");
  const out = await pg!.begin("read only", async (tx) => {
    await tx.unsafe(`set local time zone '${zone}'`);
    return [...((await tx.unsafe(`select ${select} from (${c.sql}) q`, c.params as never[])) as Row[])];
  });
  return out.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : /_month$|_week$|_country$/.test(k) ? String(v) : Number(v)])));
}
// One figure computed directly from the invoice table.
async function hand(sql: string, params: unknown[] = []): Promise<number> {
  const r = (await pg!.unsafe(sql.replaceAll("from invoice", `from "${layer!.schema}".invoice`), params as never[])) as { v: string }[];
  return Number(r[0]!.v);
}
const at = (list: Row[], month: string) => list.find((r) => r.invoice_date_month === month)!;

describe("running totals on the Chinook invoices", () => {
  test.skipIf(!PG_URL)("revenue's running total by month: 60 rows, from 35.64 to the whole table", async () => {
    const r = await rows(base);
    expect(r.length).toBe(60);
    expect(r.length).toBe(await hand("select count(distinct date_trunc('month', invoice_date)) as v from invoice"));
    expect(at(r, "2021-01-01").revenue_running).toBe(35.64);
    expect(at(r, "2021-12-01").revenue_running).toBe(449.46);
    expect(await hand("select sum(total) as v from invoice where invoice_date < '2022-01-01'")).toBe(449.46);
    expect(at(r, "2025-12-01").revenue_running).toBe(2328.6);
    expect(await hand("select sum(total) as v from invoice")).toBe(2328.6);
    expect(at(r, "2025-12-01").invoice_count_running).toBe(412);
    // Every month's running total is every invoice before the next month.
    for (const x of r) expect({ m: x.invoice_date_month, v: x.revenue_running }).toEqual({ m: x.invoice_date_month, v: await hand("select sum(total) as v from invoice where invoice_date < cast($1 as date) + interval '1 month'", [x.invoice_date_month]) });
  });

  test.skipIf(!PG_URL)("Finland: the series runs 2021-08 to 2025-12, 53 rows, and an empty month carries the total", async () => {
    const r = await rows({ ...base, filters: [{ field: "invoice.billing_country", op: "eq", value: "Finland" }] });
    expect(r.length).toBe(53);
    expect([r[0]!.invoice_date_month, r.at(-1)!.invoice_date_month]).toEqual(["2021-08-01", "2025-12-01"]);
    expect(r.filter((x) => (x.invoice_count as number) > 0).length).toBe(7);
    expect(await hand("select count(distinct date_trunc('month', invoice_date)) as v from invoice where billing_country = 'Finland'")).toBe(7);
    const upTo = r.slice(0, r.findIndex((x) => x.invoice_date_month === "2023-03-01"));
    expect(upTo.length).toBe(19);
    expect(upTo.filter((x) => x.revenue === 0).length).toBe(18);
    expect(new Set(upTo.map((x) => x.revenue_running))).toEqual(new Set([8.91]));
    expect(await hand("select sum(total) as v from invoice where billing_country = 'Finland' and invoice_date < '2023-03-01'")).toBe(8.91);
    expect(at(r, "2023-03-01").revenue_running).toBe(10.89);
    expect(await hand("select sum(total) as v from invoice where billing_country = 'Finland' and invoice_date < '2023-04-01'")).toBe(10.89);
    expect(at(r, "2025-12-01").revenue_running).toBe(41.62);
    expect(await hand("select sum(total) as v from invoice where billing_country = 'Finland'")).toBe(41.62);
  });

  test.skipIf(!PG_URL)("periods: 3 is blank for the first two months, then each equals a hand sum over its three months", async () => {
    const r = await rows({ ...base, measures: ["invoice.revenue"], running: { over: MONTH, periods: 3 } });
    expect(r.length).toBe(60);
    expect([at(r, "2021-01-01").revenue_trailing_3, at(r, "2021-02-01").revenue_trailing_3]).toEqual([null, null]);
    const three = (m: string) => hand("select sum(total) as v from invoice where invoice_date >= cast($1 as date) - interval '2 months' and invoice_date < cast($1 as date) + interval '1 month'", [m]);
    for (const [m, v] of [["2021-03-01", 110.88], ["2025-06-01", 108.9], ["2025-12-01", 125.86]] as const) {
      expect(at(r, m).revenue_trailing_3).toBe(v);
      expect(await three(m)).toBe(v);
    }
    for (const x of r.slice(2)) expect({ m: x.invoice_date_month, v: x.revenue_trailing_3 }).toEqual({ m: x.invoice_date_month, v: await three(x.invoice_date_month as string) });
  });

  test.skipIf(!PG_URL)("a filter on the month picks the months shown and does not move where the total starts", async () => {
    const r = await rows({ ...base, filters: [{ field: MONTH, op: "gte", value: "2025-01-01" }] });
    expect(r.length).toBe(12);
    expect(r[0]!.invoice_date_month).toBe("2025-01-01");
    expect(r[0]!.revenue_running).toBe(1915.64);
    expect(await hand("select sum(total) as v from invoice where invoice_date < '2025-02-01'")).toBe(1915.64);
  });

  test.skipIf(!PG_URL)("the same rows under a New York session as under UTC, by the UTC and the New York date", async () => {
    for (const request of [base, { ...base, dimensions: ["invoice.invoice_date_ny:month"], running: { over: "invoice.invoice_date_ny:month" }, order_by: [{ field: "invoice.invoice_date_ny:month" }] }]) {
      const utc = await rows(request);
      expect(utc.length).toBeGreaterThan(59);
      expect(await rows(request, "America/New_York")).toEqual(utc);
    }
    // Every invoice is at midnight UTC, so the New York date of an invoice on the 1st is the day before.
    const ny = await rows({ ...base, dimensions: ["invoice.invoice_date_ny:month"], running: { over: "invoice.invoice_date_ny:month" }, order_by: [{ field: "invoice.invoice_date_ny:month" }] });
    expect(ny[0]!.invoice_date_ny_month).toBe("2020-12-01");
    expect(ny.at(-1)!.revenue_running).toBe(2328.6);
  });

  test.skipIf(!PG_URL)("a role's row filter gives the running total of the rows it may see", async () => {
    const { run, root } = layer!;
    await run(["set", "access", "mode", "open"]);
    await run(["add-role", "--name", "finland", "--description", "Sees Finnish invoices only."]);
    await run(["add-row-filter", "--role", "finland", "--model", "chinook.invoice", "--expr", "billing_country = 'Finland'"]);
    const a = await approveWithYes(root, ["--target", "access", "--by", "Test Owner"]);
    expect({ code: a.code, err: a.err }).toEqual({ code: 0, err: "" });
    const r = await rows(base, "UTC", ["--role", "finland"]);
    expect(r.length).toBe(53);
    expect(r.at(-1)!.revenue_running).toBe(41.62);
    expect((await rows(base)).at(-1)!.revenue_running).toBe(2328.6);
  });

  test.skipIf(!PG_URL)("the running-total golden is confirmed, reads back the option in words, and a changed periods needs a new yes", async () => {
    const { run, root, env } = layer!;
    const name = "revenue_to_date";
    const request = { ...base, measures: ["invoice.revenue"], filters: [{ field: MONTH, op: "gte", value: "2025-01-01" }] };
    const made = await run(["goldens", "new", "--name", name, "--question", "What is revenue to date at each month of 2025?", "--request", JSON.stringify(request)]);
    const words = "Running total of each figure (revenue_running) over invoice.invoice_date by month, from the first month of data; a month with no rows adds 0; rows with no invoice.invoice_date are left out.";
    expect(made.out).toContain(words);
    const rb = await run(["readback", "--targets", `golden:${name}`, "--json"]);
    const text = rb.json<{ items: { text: string }[] }>().items[0]!.text;
    expect(text).toContain(`  - ${words}`);
    expect(text).toContain("A filter on invoice.invoice_date:month only picks the months shown");
    expect((await run(["goldens", "run", "--name", name])).out).toContain(words);
    const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Test Owner", "--tolerance", "0"], {}, env);
    expect({ code: confirmed.code, out: confirmed.out }).toMatchObject({ code: 0 });
    expect(confirmed.out).toContain(words);
    const file = join(root, "goldens", `${name}.yaml`);
    const g = readYaml<Golden>(file);
    expect(g.status).toBe("approved");
    expect(g.request.running).toEqual({ over: MONTH });
    const recorded = g.expected!.rows;
    expect(recorded.length).toBe(12);
    expect([String(recorded[0]!.invoice_date_month).slice(0, 10), Number(recorded[0]!.revenue_running)]).toEqual(["2025-01-01", 1915.64]);
    expect([String(recorded[11]!.invoice_date_month).slice(0, 10), Number(recorded[11]!.revenue_running)]).toEqual(["2025-12-01", 2328.6]);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
    const status = (await run(["status", "--json"])).json<{ approved_without_yes: string[] }>();
    expect(status.approved_without_yes).not.toContain(`golden:${name}`);

    // The owner's yes is to this request: periods added after the confirm needs a new one.
    writeYaml(file, { ...g, request: { ...g.request, running: { over: MONTH, periods: 3 } } });
    expect((await run(["status", "--json"])).json<{ approved_without_yes: string[] }>().approved_without_yes).toContain(`golden:${name}`);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(1);
    writeYaml(file, g);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
  });
});

describe("a running total over measures of two models", () => {
  test.skipIf(!PG_URL)("orders and refunds by month on the Acme warehouse each equal a hand sum to that month", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("t_running_acme");
    await loadPostgres(PG_URL!, join(import.meta.dir, "..", "..", "fixtures", "acme", "data"), schema);
    const t = tempRoot();
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    const run = async (args: string[]) => {
      const r = await semlayer(t.root, args, env);
      if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${r.out}\n${r.err}`);
      return r;
    };
    try {
      await initProject(t.root);
      await run(["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", schema, "--primary", schema]);
      await run(["draft", "--source", "warehouse", "--tables", `${schema}.fct_orders,${schema}.fct_refunds`, "--strip-prefix", "fct_"]);
      await run(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "dim_customer"]);
      await run(["set", "warehouse.refunds", "grain", "One row per refund."]);
      for (const [ref, text] of [
        ["warehouse.orders.amount", "The order value in US dollars, every order."],
        ["warehouse.orders.created_at", "When the order was placed, UTC."],
        ["warehouse.refunds.refunded", "The refunded value in US dollars, every refund."],
        ["warehouse.refunds.order", "The order each refund was issued against."],
      ] as const)
        await run(["set", ref, "description", text]);
      for (const ref of ["warehouse.orders.amount", "warehouse.refunds.refunded"]) await run(["set", ref, "currency", "USD"]);
      for (const target of ["warehouse.orders", "warehouse.orders.created_at", "warehouse.orders.amount", "warehouse.refunds", "warehouse.refunds.refunded", "warehouse.refunds.order"]) {
        const r = await approveWithYes(t.root, ["--target", target, "--by", "Test Owner"]);
        expect({ target, code: r.code, err: r.err }).toEqual({ target, code: 0, err: "" });
      }
      const month = "orders.created_at:month";
      const request = { source: "warehouse", measures: ["orders.amount", "refunds.refunded"], dimensions: [month], running: { over: month }, order_by: [{ field: month }] };
      const c = (await run(["sql", "--request", JSON.stringify(request), "--json"])).json<{ sql: string; params: unknown[] }>();
      expect(c.sql).toContain('"orders measures"');
      expect(c.sql).toContain('"refunds measures"');
      const got = (await pg!.unsafe(
        `select cast(created_at_month as text) as m, cast(amount as text) as a, cast(refunded as text) as r, cast(amount_running as text) as ar, cast(refunded_running as text) as rr from (${c.sql}) q`,
        c.params as never[],
      )) as Record<string, string | null>[];
      // Hand-written: every month from the first order's to the last, and the sums up to each.
      const months = (await pg!.unsafe(
        `select cast(m as date)::text as m from generate_series((select date_trunc('month', min(created_at)) from ${schema}.fct_orders), (select date_trunc('month', max(created_at)) from ${schema}.fct_orders), interval '1 month') m order by 1`,
      )) as { m: string }[];
      expect(got.map((x) => x.m)).toEqual(months.map((x) => x.m));
      for (const x of got) {
        const [h] = (await pg!.unsafe(
          `select (select coalesce(sum(amount_cents / 100.0), 0) from ${schema}.fct_orders where created_at < cast($1 as date) + interval '1 month') as a,
                  (select coalesce(sum(r.refunded_cents / 100.0), 0) from ${schema}.fct_refunds r join ${schema}.fct_orders o on r.order_id = o.order_id where o.created_at < cast($1 as date) + interval '1 month') as r`,
          [x.m],
        )) as { a: string; r: string }[];
        expect({ m: x.m, ar: Number(x.ar), rr: Number(x.rr) }).toEqual({ m: x.m, ar: Number(h!.a), rr: Number(h!.r) });
      }
      expect(Number(got.at(-1)!.ar)).toBe(Number(((await pg!.unsafe(`select sum(amount_cents / 100.0) as v from ${schema}.fct_orders`)) as { v: string }[])[0]!.v));
    } finally {
      t.cleanup();
      await pg!.unsafe(`drop schema if exists ${schema} cascade`);
    }
  }, 30_000);
});

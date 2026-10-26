import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { generate } from "../fixtures/acme/generate.ts";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { computeReferenceFigures, serializeFigures, type ReferenceFigures } from "../fixtures/acme/reference-figures.ts";
import { WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { PG_URL } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "fixtures", "acme");
const DATA = join(ACME, "data");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

async function counts(queries: Record<string, string>): Promise<Record<string, number>> {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  const out: Record<string, number> = {};
  try {
    await c.run("SET TimeZone = 'UTC'");
    for (const [k, q] of Object.entries(queries)) {
      const r = (await c.runAndReadAll(q)).getRowsJson();
      out[k] = Number(r[0]?.[0] ?? -1);
    }
  } finally {
    c.closeSync();
    instance.closeSync();
  }
  return out;
}

let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "sl-acme-"));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("acme fixture", () => {
  test("the generator is deterministic and matches the committed files", async () => {
    const out = join(tmp, "data");
    await generate(out);
    const committed = listFiles(DATA);
    expect(listFiles(out)).toEqual(committed);
    for (const f of committed) {
      const same = Buffer.compare(readFileSync(join(out, f)), readFileSync(join(DATA, f))) === 0;
      expect({ file: f, same }).toEqual({ file: f, same: true });
    }
  }, 60000);

  test("the dataset has the documented shape and stays small", async () => {
    const files = listFiles(DATA);
    const warehouse = files.filter((f) => f.startsWith("warehouse/"));
    expect(warehouse.length).toBe(WAREHOUSE_TABLES.length);
    expect(warehouse.length).toBeGreaterThanOrEqual(20);
    const bytes = files.reduce((s, f) => s + statSync(join(DATA, f)).size, 0);
    expect(bytes).toBeLessThan(3 * 1024 * 1024);

    const w = (t: string) => `'${join(DATA, "warehouse", `${t}.csv`)}'`;
    const l = (p: string) => `'${join(DATA, "lake", p)}'`;
    const n = await counts({
      dim_customers: `select count(*) from ${w("dim_customers")}`,
      dim_products: `select count(*) from ${w("dim_products")}`,
      dim_regions: `select count(*) from ${w("dim_regions")}`,
      fct_orders: `select count(*) from ${w("fct_orders")}`,
      fct_order_items: `select count(*) from ${w("fct_order_items")}`,
      fct_refunds: `select count(*) from ${w("fct_refunds")}`,
      web_events: `select count(*) from read_parquet(${l("web_events/*.parquet")})`,
      sessions: `select count(*) from read_parquet(${l("sessions.parquet")})`,
      anonymous_sessions: `select count(*) from read_parquet(${l("sessions.parquet")}) where customer_id is null`,
      marketing_spend: `select count(*) from read_parquet(${l("marketing_spend.parquet")})`,
      orphan_orders: `select count(*) from ${w("fct_orders")} o where not exists (select 1 from ${w("dim_customers")} c where c.customer_id = o.customer_id)`,
      orphan_items: `select count(*) from ${w("fct_order_items")} i where not exists (select 1 from ${w("fct_orders")} o where o.order_id = i.order_id)`,
      partial_refunds: `select count(*) from ${w("fct_refunds")} r join ${w("fct_orders")} o using (order_id) where r.refunded_cents < o.amount_cents`,
      test_email_unflagged: `select count(*) from ${w("dim_customers")} where email like '%@example-test.com' and not is_test_account`,
      unmatched_channels: `select count(*) from (select distinct channel from read_parquet(${l("marketing_spend.parquet")})) m where channel not in (select utm_channel from read_parquet(${l("sessions.parquet")}) where utm_channel is not null)`,
      orders_outside_range: `select count(*) from ${w("fct_orders")} where created_at < timestamptz '2024-01-01 00:00:00+00' or created_at >= timestamptz '2026-01-01 00:00:00+00'`,
      items_not_summing: `select count(*) from ${w("fct_orders")} o join (select order_id, sum(quantity * unit_price_cents) s from ${w("fct_order_items")} group by 1) i using (order_id) where i.s <> o.amount_cents`,
    });
    expect(n).toEqual({
      dim_customers: 500,
      dim_products: 60,
      dim_regions: 6,
      fct_orders: 5000,
      fct_order_items: 12343,
      fct_refunds: 344,
      web_events: 30551,
      sessions: 8000,
      anonymous_sessions: 4800,
      marketing_spend: 3655,
      orphan_orders: 59,
      orphan_items: 0,
      partial_refunds: 219,
      test_email_unflagged: 8,
      unmatched_channels: 0,
      orders_outside_range: 0,
      items_not_summing: 0,
    });
  }, 60000);

  test("reference-figures.ts recomputes the committed json", async () => {
    const figures = await computeReferenceFigures(DATA);
    expect(serializeFigures(figures)).toBe(readFileSync(join(ACME, "reference-figures.json"), "utf8"));
    const byName = new Map(figures.figures.map((f) => [f.name, f]));
    const value = (name: string) => byName.get(name)?.value ?? NaN;
    expect(value("net_revenue_2025")).toBeCloseTo(value("revenue_2025") - value("refunds_on_2025_orders"), 2);
    expect(value("average_order_value_2025")).toBeCloseTo(value("revenue_2025") / value("order_count_2025"), 2);
    const regions = byName.get("revenue_by_region_2025")?.rows ?? [];
    expect(regions.reduce((s, r) => s + Number(r.revenue), 0)).toBeCloseTo(value("revenue_2025"), 2);
    const mistakes = figures.common_mistakes.map((f) => f.value ?? 0);
    for (const m of mistakes) expect(m).not.toBeCloseTo(value("revenue_2025"), 0);
  }, 60000);

  test.skipIf(!PG_URL)("load-postgres loads schema acme with keys and matching row counts", async () => {
    const result = await loadPostgres(PG_URL as string, DATA, "acme");
    expect(Object.keys(result.rows).length).toBe(WAREHOUSE_TABLES.length);
    const sql = new SQL({ url: PG_URL as string, max: 1 });
    try {
      for (const t of WAREHOUSE_TABLES) {
        const lines = readFileSync(join(DATA, "warehouse", `${t.name}.csv`), "utf8").trimEnd().split("\n").length - 1;
        const [row] = await sql.unsafe(`select count(*)::int as n from acme."${t.name}"`);
        expect({ table: t.name, n: (row as { n: number }).n }).toEqual({ table: t.name, n: lines });
        expect(result.rows[t.name]).toBe(lines);
      }
      const fks = (await sql`
        select conrelid::regclass::text as t, pg_get_constraintdef(oid) as d
        from pg_constraint where connamespace = 'acme'::regnamespace and contype = 'f' order by 1, 2`) as { t: string; d: string }[];
      expect(fks.map((f) => `${f.t} ${f.d}`)).toEqual([
        "acme.dim_customers FOREIGN KEY (region_code) REFERENCES acme.dim_regions(region_code)",
        "acme.fct_order_items FOREIGN KEY (order_id) REFERENCES acme.fct_orders(order_id)",
        "acme.fct_order_items FOREIGN KEY (product_id) REFERENCES acme.dim_products(product_id)",
        "acme.fct_refunds FOREIGN KEY (order_id) REFERENCES acme.fct_orders(order_id)",
      ]);
      const pks = (await sql`
        select conrelid::regclass::text as t from pg_constraint
        where connamespace = 'acme'::regnamespace and contype = 'p' order by 1`) as { t: string }[];
      expect(pks.map((p) => p.t).sort()).toEqual([
        "acme.dim_currency",
        "acme.dim_customers",
        "acme.dim_customers_archive",
        "acme.dim_products",
        "acme.dim_regions",
        "acme.fct_order_items",
        "acme.fct_orders",
        "acme.fct_orders_v2_test",
        "acme.fct_refunds",
      ]);
      const comments = (await sql`
        select c.relname as t, obj_description(c.oid, 'pg_class') as c
        from pg_class c where c.relnamespace = 'acme'::regnamespace and c.relkind = 'r'
          and obj_description(c.oid, 'pg_class') is not null order by 1`) as { t: string; c: string }[];
      expect(comments.map((r) => r.t).sort()).toEqual(["dim_customers", "dim_regions", "fct_orders", "fct_refunds", "raw_shopify_orders"]);
      expect(comments.find((r) => r.t === "fct_orders")?.c).toContain("integer cents");
      // Only ANALYZE fills pg_stats, so every table having statistics shows it ran.
      const analyzed = (await sql`
        select distinct tablename as t from pg_stats where schemaname = 'acme' order by 1`) as { t: string }[];
      expect(analyzed.map((r) => r.t).sort()).toEqual(WAREHOUSE_TABLES.map((t) => t.name).sort());
      const [rev] = await sql`
        select sum(o.amount_cents)::bigint as cents
        from acme.fct_orders o left join acme.dim_customers c on c.customer_id = o.customer_id
        where o.status in ('completed', 'shipped') and not coalesce(c.is_test_account, false)
          and coalesce(c.email, '') not ilike '%@example-test.com'
          and o.created_at >= '2025-01-01T00:00:00Z' and o.created_at < '2026-01-01T00:00:00Z'`;
      const figures = JSON.parse(readFileSync(join(ACME, "reference-figures.json"), "utf8")) as ReferenceFigures;
      const revenue = figures.figures.find((f) => f.name === "revenue_2025")?.value;
      expect(Number((rev as { cents: string | number }).cents) / 100).toBe(revenue as number);
    } finally {
      await sql.close();
    }
  }, 60000);
});

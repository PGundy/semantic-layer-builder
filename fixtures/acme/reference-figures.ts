// Computes the figures the Acme data owner knows from their own reports, directly from the
// generated files with DuckDB, and writes them to reference-figures.json.
//
//   bun fixtures/acme/reference-figures.ts [dataDir] [outFile]
//
// Defaults: fixtures/acme/data and fixtures/acme/reference-figures.json.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { readCsvSql, warehouseTable } from "./schema.ts";

export interface Figure {
  name: string;
  definition: string;
  unit: string;
  value?: number;
  rows?: Record<string, string | number>[];
}

export interface ReferenceFigures {
  dataset: string;
  period: string;
  note: string;
  figures: Figure[];
  common_mistakes: Figure[];
}

// The orders that count toward revenue: completed or shipped, not placed by a test account.
// Orders whose customer is missing from dim_customers still count.
const COUNTED_ORDERS = `
  select o.*
  from fct_orders o
  left join dim_customers c on c.customer_id = o.customer_id
  where o.status in ('completed', 'shipped')
    and not coalesce(c.is_test_account, false)
    and coalesce(c.email, '') not ilike '%@example-test.com'
`;
const IN_2025 = (col: string) => `${col} >= timestamptz '2025-01-01 00:00:00+00' and ${col} < timestamptz '2026-01-01 00:00:00+00'`;

async function rows(c: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  const reader = await c.runAndReadAll(sql);
  return reader.getRowObjectsJson() as Record<string, unknown>[];
}

async function scalar(c: DuckDBConnection, sql: string): Promise<number> {
  const r = await rows(c, sql);
  const v = r[0] ? Object.values(r[0])[0] : undefined;
  return Number(v ?? 0);
}

const dollars = (cents: number): number => Math.round(cents) / 100;
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

export async function computeReferenceFigures(dataDir: string): Promise<ReferenceFigures> {
  const instance = await DuckDBInstance.create(":memory:", { threads: "1" });
  const c = await instance.connect();
  try {
    await c.run("SET TimeZone = 'UTC'");
    for (const name of ["dim_customers", "dim_regions", "fct_orders", "fct_refunds"]) {
      const file = join(dataDir, "warehouse", `${name}.csv`);
      await c.run(`CREATE VIEW ${name} AS SELECT * FROM ${readCsvSql(file, warehouseTable(name))}`);
    }
    const lake = (p: string) => `'${join(dataDir, "lake", p).replace(/'/g, "''")}'`;
    await c.run(`CREATE VIEW sessions AS SELECT * FROM read_parquet(${lake("sessions.parquet")})`);
    await c.run(`CREATE VIEW marketing_spend AS SELECT * FROM read_parquet(${lake("marketing_spend.parquet")})`);
    await c.run(`CREATE VIEW counted_orders AS ${COUNTED_ORDERS}`);

    const revenueCents = await scalar(c, `select sum(amount_cents) from counted_orders where ${IN_2025("created_at")}`);
    const orderCount = await scalar(c, `select count(*) from counted_orders where ${IN_2025("created_at")}`);
    const refundCents = await scalar(
      c,
      `select coalesce(sum(r.refunded_cents), 0) from fct_refunds r join counted_orders o on o.order_id = r.order_id where ${IN_2025("o.created_at")}`,
    );
    const byRegion = await rows(
      c,
      `select r.region_code, r.region_name, coalesce(sum(o.amount_cents), 0)::bigint as cents, count(o.order_id)::bigint as orders
       from dim_regions r left join counted_orders o on o.ship_region = r.region_code and ${IN_2025("o.created_at")}
       group by 1, 2 order by 1`,
    );
    const sessions2025 = await scalar(c, `select count(*) from sessions where ${IN_2025("started_at")}`);
    const converted2025 = await scalar(
      c,
      `select count(*) from sessions s
       where ${IN_2025("s.started_at")} and s.customer_id is not null
         and exists (select 1 from counted_orders o where o.customer_id = s.customer_id and o.created_at::date = s.started_at::date)`,
    );
    const spend = await rows(
      c,
      `select channel, sum(spend_cents)::bigint as cents from marketing_spend where spend_date >= date '2025-01-01' and spend_date < date '2026-01-01' group by 1 order by 1`,
    );
    const totalSpendCents = spend.reduce((s, r) => s + Number(r.cents), 0);
    const newCustomers = await scalar(
      c,
      `select count(*) from (select customer_id, min(created_at) as first_at from counted_orders where customer_id in (select customer_id from dim_customers) group by 1) where ${IN_2025("first_at")}`,
    );

    // Figures a model gets when it misses one of the rules.
    const allStatuses = await scalar(
      c,
      `select sum(o.amount_cents) from fct_orders o left join dim_customers c on c.customer_id = o.customer_id
       where ${IN_2025("o.created_at")} and not coalesce(c.is_test_account, false) and coalesce(c.email, '') not ilike '%@example-test.com'`,
    );
    const withTest = await scalar(c, `select sum(amount_cents) from fct_orders where status in ('completed', 'shipped') and ${IN_2025("created_at")}`);
    const flagOnly = await scalar(
      c,
      `select sum(o.amount_cents) from fct_orders o left join dim_customers c on c.customer_id = o.customer_id
       where o.status in ('completed', 'shipped') and ${IN_2025("o.created_at")} and not coalesce(c.is_test_account, false)`,
    );
    const innerJoin = await scalar(
      c,
      `select sum(o.amount_cents) from fct_orders o join dim_customers c on c.customer_id = o.customer_id
       where o.status in ('completed', 'shipped') and ${IN_2025("o.created_at")} and not c.is_test_account and c.email not ilike '%@example-test.com'`,
    );
    const withShipping = await scalar(c, `select sum(amount_cents + shipping_cents) from counted_orders where ${IN_2025("created_at")}`);
    const allRefunds2025 = await scalar(c, `select sum(refunded_cents) from fct_refunds where ${IN_2025("refunded_at")}`);

    const revenueRule =
      "Sum of fct_orders.amount_cents / 100 for orders created in 2025 (UTC) with status completed or shipped, excluding orders by test accounts (dim_customers.is_test_account is true, or the email ends in @example-test.com). Orders whose customer_id has no row in dim_customers count. Shipping is not revenue.";

    return {
      dataset: "acme",
      period: "Calendar year 2025, UTC.",
      note: "Synthetic figures computed from fixtures/acme/data by fixtures/acme/reference-figures.ts. Money is in US dollars.",
      figures: [
        { name: "revenue_2025", unit: "USD", value: dollars(revenueCents), definition: revenueRule },
        { name: "order_count_2025", unit: "orders", value: orderCount, definition: "Number of orders that count toward revenue_2025, by the same rule." },
        {
          name: "average_order_value_2025",
          unit: "USD",
          value: round(revenueCents / orderCount / 100, 2),
          definition: "revenue_2025 divided by order_count_2025, rounded to the cent.",
        },
        {
          name: "revenue_by_region_2025",
          unit: "USD",
          definition: "revenue_2025 split by fct_orders.ship_region (the region the order shipped to, which is the sales region), joined to dim_regions for the name.",
          rows: byRegion.map((r) => ({ region_code: String(r.region_code), region_name: String(r.region_name), revenue: dollars(Number(r.cents)), orders: Number(r.orders) })),
        },
        {
          name: "refunds_on_2025_orders",
          unit: "USD",
          value: dollars(refundCents),
          definition: "Sum of fct_refunds.refunded_cents / 100 over refunds of the orders counted in revenue_2025, whenever the refund was issued.",
        },
        {
          name: "net_revenue_2025",
          unit: "USD",
          value: dollars(revenueCents - refundCents),
          definition: "revenue_2025 minus refunds_on_2025_orders. Refunds of orders with status refunded are not subtracted, because those orders are already outside revenue.",
        },
        { name: "sessions_2025", unit: "sessions", value: sessions2025, definition: "Number of rows in lake sessions with started_at in 2025 (UTC), anonymous sessions included." },
        {
          name: "converted_sessions_2025",
          unit: "sessions",
          value: converted2025,
          definition: "Sessions in 2025 with a non-null customer_id whose customer placed an order counted in revenue on the same UTC date as the session started.",
        },
        {
          name: "conversion_rate_2025",
          unit: "ratio",
          value: round(converted2025 / sessions2025, 4),
          definition: "converted_sessions_2025 divided by sessions_2025, rounded to four decimals.",
        },
        {
          name: "marketing_spend_by_channel_2025",
          unit: "USD",
          definition: "Sum of marketing_spend.spend_cents / 100 for spend_date in 2025, by channel.",
          rows: spend.map((r) => ({ channel: String(r.channel), spend: dollars(Number(r.cents)) })),
        },
        { name: "marketing_spend_2025", unit: "USD", value: dollars(totalSpendCents), definition: "Total of marketing_spend_by_channel_2025." },
        {
          name: "new_customers_2025",
          unit: "customers",
          value: newCustomers,
          definition: "Customers in dim_customers whose first order counted in revenue (any year) was created in 2025.",
        },
        {
          name: "blended_cac_2025",
          unit: "USD",
          value: round(totalSpendCents / newCustomers / 100, 2),
          definition: "marketing_spend_2025 divided by new_customers_2025, rounded to the cent.",
        },
      ],
      common_mistakes: [
        { name: "revenue_2025_all_statuses", unit: "USD", value: dollars(allStatuses), definition: "Revenue with cancelled and refunded orders left in." },
        { name: "revenue_2025_with_test_accounts", unit: "USD", value: dollars(withTest), definition: "Revenue without excluding test accounts." },
        { name: "revenue_2025_flag_only", unit: "USD", value: dollars(flagOnly), definition: "Revenue excluding is_test_account but not the example-test.com emails." },
        { name: "revenue_2025_inner_join", unit: "USD", value: dollars(innerJoin), definition: "Revenue with an inner join to dim_customers, which drops orders whose customer is missing." },
        { name: "revenue_2025_with_shipping", unit: "USD", value: dollars(withShipping), definition: "Revenue with shipping_cents added." },
        { name: "refunds_issued_in_2025", unit: "USD", value: dollars(allRefunds2025), definition: "All refunds issued in 2025, including refunds of refunded orders, which double-count against revenue." },
      ],
    };
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

export function serializeFigures(f: ReferenceFigures): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}

if (import.meta.main) {
  const dataDir = resolve(process.argv[2] ?? join(import.meta.dir, "data"));
  const outFile = resolve(process.argv[3] ?? join(import.meta.dir, "reference-figures.json"));
  writeFileSync(outFile, serializeFigures(await computeReferenceFigures(dataDir)));
  console.log(`Wrote ${outFile}`);
}

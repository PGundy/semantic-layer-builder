// The two-schema and change-round walkthrough fixtures: fixtures/acme/billing.sql, load-two-schema.ts
// and the briefs owner-brief-two-schema.md and owner-brief-change.md. Without PG_URL the files, the
// ids in billing.sql and every figure in the briefs are checked against the CSVs and
// reference-figures.json; with it both schemas are loaded under unique names and the key, the schema
// question and the tables the briefs name are checked on the server.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadTwoSchema, placeSchemas } from "../fixtures/acme/load-two-schema.ts";
import type { ReferenceFigures } from "../fixtures/acme/reference-figures.ts";
import type { Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "fixtures", "acme");
const WAREHOUSE = join(ACME, "data", "warehouse");
const text = (f: string) => readFileSync(join(ACME, f), "utf8");
const BRIEFS = ["owner-brief-two-schema.md", "owner-brief-change.md"];
const FIGURES = JSON.parse(text("reference-figures.json")) as ReferenceFigures;

// The orders that count toward revenue before the change: the owner brief's rule, 2025, UTC.
const counted = (orders: string, customers: string, statuses: string) =>
  `from ${orders} o left join ${customers} c on c.customer_id = o.customer_id
   where o.created_at >= timestamptz '2025-01-01 00:00:00+00' and o.created_at < timestamptz '2026-01-01 00:00:00+00'
     and o.status in (${statuses}) and not coalesce(c.is_test_account, false) and coalesce(c.email, '') not ilike '%@example-test.com'`;

interface Cents {
  revenue_before: [number, number];
  revenue_after: [number, number];
  shipping: [number, number];
}

async function figuresOn(run: (q: string) => Promise<Record<string, unknown>[]>, orders: string, customers: string): Promise<Cents> {
  const one = async (col: string, statuses: string): Promise<[number, number]> => {
    const [r] = await run(`select sum(o.${col})::bigint as cents, count(*)::int as n ${counted(orders, customers, statuses)}`);
    return [Number(r!.cents), Number(r!.n)];
  };
  return {
    revenue_before: await one("amount_cents", "'completed', 'shipped'"),
    revenue_after: await one("amount_cents", "'completed'"),
    shipping: await one("shipping_cents", "'completed', 'shipped'"),
  };
}

async function figuresFromCsv(): Promise<Cents> {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  try {
    for (const t of ["fct_orders", "dim_customers"]) await c.run(`create table ${t} as select * from read_csv('${join(WAREHOUSE, `${t}.csv`)}')`);
    return await figuresOn(async (q) => (await c.runAndReadAll(q)).getRowObjectsJson() as Record<string, unknown>[], "fct_orders", "dim_customers");
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The invoices as billing.sql inserts them: [invoice_id, customer_id, amount_cents, status].
function invoices(): [number, number, number, string][] {
  const rows = [...text("billing.sql").matchAll(/^\s*\((\d+), (\d+), '[\d-]+', (\d+), '(\w+)'\)[,;]$/gm)];
  return rows.map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), m[4]!]);
}

function billingCents(): { total: number; paid: number; customers: number; count: number } {
  const rows = invoices();
  return {
    total: rows.reduce((s, r) => s + r[2], 0),
    paid: rows.filter((r) => r[3] === "paid").reduce((s, r) => s + r[2], 0),
    customers: new Set(rows.map((r) => r[1])).size,
    count: rows.length,
  };
}

// Every dollar figure and "N orders" a brief states, as the strings it writes them.
const dollarsIn = (s: string) => [...s.matchAll(/\$[\d,]+\.\d\d/g)].map((m) => m[0]);
const ordersIn = (s: string) => [...s.matchAll(/(\d[\d,]*) orders/g)].map((m) => m[1]!);
const ticked = (s: string) => [...s.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!);

const refValue = (name: string) => FIGURES.figures.find((f) => f.name === name)!.value as number;

describe("the two-schema fixture files", () => {
  test("billing.sql is plain DDL that creates only billing, names its key and holds real, non-test customer ids", () => {
    const sql = text("billing.sql");
    const code = sql.replace(/--.*$/gm, "");
    expect([...code.matchAll(/create schema (\w+)/gi)].map((m) => m[1])).toEqual(["billing"]);
    expect([...code.matchAll(/drop schema (?:if exists )?(\w+)/gi)].map((m) => m[1])).toEqual(["billing"]);
    expect(code).toMatch(/constraint invoices_customer_fk foreign key \(customer_id\) references acme\.dim_customers \(customer_id\)/);
    expect(code).not.toMatch(/\b(alter|truncate|delete|update|grant|create (extension|role|function|type))\b/i);
    const emails = sql.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails).toEqual([]);

    const customers = readFileSync(join(WAREHOUSE, "dim_customers.csv"), "utf8").trimEnd().split("\n").slice(1).map((l) => l.split(","));
    const usable = new Set(customers.filter((c) => c[7] === "false" && !c[1]!.endsWith("@example-test.com")).map((c) => Number(c[0])));
    const rows = invoices();
    expect(rows.length).toBe(12);
    expect(new Set(rows.map((r) => r[0])).size).toBe(rows.length);
    for (const r of rows) expect({ invoice: r[0], known: usable.has(r[1]) }).toEqual({ invoice: r[0], known: true });
  });

  test("the loader checks its schema names before it connects", async () => {
    await expect(loadTwoSchema("postgres://nobody@127.0.0.1:1/none", "acme; drop", "billing")).rejects.toThrow("invalid schema name");
    await expect(loadTwoSchema("postgres://nobody@127.0.0.1:1/none", "acme", "Billing")).rejects.toThrow("invalid schema name");
    await expect(loadTwoSchema("postgres://nobody@127.0.0.1:1/none", "acme", "acme")).rejects.toThrow("different names");
  });

  test("swapped schema names are placed in one pass", () => {
    const out = placeSchemas(readFileSync(join(ACME, "billing.sql"), "utf8"), "billing", "acme");
    expect(out).toContain("create schema acme;");
    expect(out).toMatch(/references billing\.dim_customers/i);
    expect(out).not.toMatch(/create schema billing/i);
  });

  test("every figure in the briefs is in reference-figures.json or computed from the data, and the change is pinned", async () => {
    const f = await figuresFromCsv();
    const b = billingCents();
    expect(f.revenue_before[0] / 100).toBe(refValue("revenue_2025"));
    expect(f.revenue_before[1]).toBe(refValue("order_count_2025"));
    const allowedMoney = new Set([
      money(f.revenue_before[0]),
      money(f.revenue_after[0]),
      money(f.shipping[0]),
      money(b.total),
      money(b.paid),
    ]);
    const allowedOrders = new Set([f.revenue_before[1], f.revenue_after[1], f.shipping[1]].map((n) => n.toLocaleString("en-US")));

    const two = text("owner-brief-two-schema.md");
    const change = text("owner-brief-change.md");
    for (const brief of [two, change]) {
      for (const d of dollarsIn(brief)) expect({ figure: d, known: allowedMoney.has(d) }).toEqual({ figure: d, known: true });
      for (const n of ordersIn(brief)) expect({ orders: n, known: allowedOrders.has(n) }).toEqual({ orders: n, known: true });
    }
    // The change brief pins the added metric, and the revenue figure before and after.
    expect(change).toContain(`${money(f.shipping[0])}, over the same ${f.shipping[1].toLocaleString("en-US")} orders`);
    expect(change).toContain(`Revenue before: ${money(f.revenue_before[0])} from ${f.revenue_before[1].toLocaleString("en-US")} orders`);
    expect(change).toContain(`Revenue after: ${money(f.revenue_after[0])} from ${f.revenue_after[1].toLocaleString("en-US")} orders`);
    expect(f.revenue_after[0]).toBeLessThan(f.revenue_before[0]);
    // The two-schema brief pins the billing totals.
    expect(two).toContain(`${b.count} invoices from ${b.customers} customers`);
    expect(two).toContain(`${money(b.total)} invoiced`);
    expect(two).toContain(`${money(b.paid)}`);
    expect(two).toContain(money(Math.round(refValue("revenue_2025") * 100)));
  }, 60000);

  test("the briefs name only the tables the fixture holds", () => {
    const acme = new Set((readFileSync(join(ACME, "schema.ts"), "utf8").match(/name: "(\w+)"/g) ?? []).map((s) => s.slice(7, -1)));
    for (const f of BRIEFS) {
      for (const t of ticked(text(f)).filter((x) => /^(fct|dim|stg|raw)_\w+$/.test(x))) expect({ brief: f, table: t, known: acme.has(t) }).toEqual({ brief: f, table: t, known: true });
      for (const t of ticked(text(f)).filter((x) => /^billing\.\w+$/.test(x))) expect({ brief: f, table: t }).toEqual({ brief: f, table: "billing.invoices" });
    }
  });
});

const acmeSchema = uniqueSchema("t_two_acme");
const billingSchema = uniqueSchema("t_two_bill");
let cleanup: (() => void) | undefined;

afterAll(async () => {
  cleanup?.();
  if (!PG_URL) return;
  const pg = new SQL({ url: PG_URL, max: 1 });
  try {
    await pg.unsafe(`drop schema if exists ${billingSchema}, ${acmeSchema} cascade`);
  } finally {
    await pg.close();
  }
});

describe("the two schemas on a server", () => {
  test.skipIf(!PG_URL)("the key is found by name, next asks the schema question, and the briefs' tables and figures exist", async () => {
    assertLocalPg(PG_URL);
    const loaded = await loadTwoSchema(PG_URL!, acmeSchema, billingSchema);
    expect(loaded.billing.rows.invoices).toBe(billingCents().count);

    const pg = new SQL({ url: PG_URL!, max: 1 });
    try {
      const run = async (q: string) => (await pg.unsafe(q)) as Record<string, unknown>[];
      // Only the two schemas exist; the loader created nothing else.
      const created = await run(`select nspname from pg_namespace where nspname in ('${acmeSchema}', '${billingSchema}') order by 1`);
      expect(created.map((r) => r.nspname)).toEqual([acmeSchema, billingSchema].sort());

      // The tables the briefs name exist in the loaded schemas.
      const have = new Set((await run(`select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('${acmeSchema}', '${billingSchema}')`)).map((r) => String(r.t)));
      for (const f of BRIEFS) {
        for (const t of ticked(text(f)).filter((x) => /^(fct|dim|stg|raw)_\w+$/.test(x))) expect({ brief: f, table: t, has: have.has(`${acmeSchema}.${t}`) }).toEqual({ brief: f, table: t, has: true });
        for (const t of ticked(text(f)).filter((x) => /^billing\.\w+$/.test(x))) expect(have.has(`${billingSchema}.${t.slice(8)}`)).toBe(true);
      }
      expect(have.has(`${billingSchema}.invoices`)).toBe(true);

      // The figures the briefs pin are what the loaded schemas hold.
      const f = await figuresOn(run, `${acmeSchema}.fct_orders`, `${acmeSchema}.dim_customers`);
      expect(f).toEqual(await figuresFromCsv());
      const [inv] = await run(`select sum(amount_cents)::bigint as total, sum(amount_cents) filter (where status = 'paid')::bigint as paid, count(distinct customer_id)::int as customers from ${billingSchema}.invoices`);
      const b = billingCents();
      expect({ total: Number(inv!.total), paid: Number(inv!.paid), customers: Number(inv!.customers) }).toEqual({ total: b.total, paid: b.paid, customers: b.customers });
    } finally {
      await pg.close();
    }

    const t = tempRoot();
    cleanup = t.cleanup;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    await initProject(t.root);
    const setup = ["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", `${acmeSchema},${billingSchema}`];
    expect((await semlayer(t.root, setup, env)).code).toBe(0);

    // The key, by its constraint name, as `semlayer introspect` records it.
    const intro = await semlayer(t.root, ["introspect", "--source", "pg", "--json"], env);
    expect(intro.code).toBe(0);
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "pg.json"), "utf8")) as Snapshot;
    const invoiceTable = snap.tables.find((x) => x.schema === billingSchema && x.name === "invoices");
    expect(invoiceTable?.foreign_keys).toEqual([
      { columns: ["customer_id"], references: { schema: acmeSchema, table: "dim_customers", columns: ["customer_id"] }, constraint: "invoices_customer_fk" },
    ]);

    // The schema question: asked before any cross-schema join exists.
    const next = (await semlayer(t.root, ["next", "--json"], env)).json<{
      kind: string;
      phase: string;
      ask_owner?: { text: string; options?: { answer: string }[] };
    }>();
    expect(next).toMatchObject({ kind: "ask_owner", phase: "scope" });
    expect(next.ask_owner!.text).toStartWith(`Your data sits in more than one schema (`);
    expect(next.ask_owner!.text).toContain(acmeSchema);
    expect(next.ask_owner!.text).toContain(billingSchema);
    expect(next.ask_owner!.options!.map((o) => o.answer)).toContain(`Yes, I also need ${billingSchema}`);
  }, 120000);
});

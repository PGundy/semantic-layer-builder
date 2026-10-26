// Generates the synthetic Acme dataset deterministically: warehouse tables as CSV under
// <outDir>/warehouse and lake tables as Parquet under <outDir>/lake.
//
//   bun fixtures/acme/generate.ts [outDir]     (default fixtures/acme/data)
//
// Every value comes from seeded PRNGs; nothing reads the clock. DuckDB writes the files.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { DUCKDB_TYPES, LAKE_TABLES, WAREHOUSE_TABLES, type ColumnDef } from "./schema.ts";

type Value = string | number | boolean | null;
type Row = Value[];

// ---------- deterministic helpers ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    const v = items[Math.floor(this.next() * items.length)];
    if (v === undefined) throw new Error("pick from empty list");
    return v;
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error("weighted pick from empty list");
    return last[0];
  }
}

const DAY = 86400;
const START_2022_06 = Date.UTC(2022, 5, 1) / 1000;
const START_2024 = Date.UTC(2024, 0, 1) / 1000;
const START_2025 = Date.UTC(2025, 0, 1) / 1000;
const END_2025 = Date.UTC(2026, 0, 1) / 1000;
const DAYS = (END_2025 - START_2024) / DAY; // 731

// Epoch seconds to "YYYY-MM-DD HH:MM:SS+00".
function ts(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ") + "+00";
}

function dateOf(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function dayStart(sec: number): number {
  return Math.floor(sec / DAY) * DAY;
}

// A unique, stable 8-hex-digit token for an index (odd multiplier is a bijection mod 2^32).
function token(i: number, salt: number): string {
  return (Math.imul(i + salt, 2654435761) >>> 0).toString(16).padStart(8, "0");
}

// ---------- reference data ----------

const REGIONS: Row[] = [
  ["NE", "Northeast", "US", "America/New_York"],
  ["SE", "Southeast", "US", "America/New_York"],
  ["MW", "Midwest", "US", "America/Chicago"],
  ["SW", "Southwest", "US", "America/Phoenix"],
  ["WC", "West Coast", "US", "America/Los_Angeles"],
  ["INT", "International", "ZZ", "UTC"],
];
const REGION_WEIGHTS: (readonly [string, number])[] = [
  ["NE", 24],
  ["SE", 20],
  ["MW", 16],
  ["SW", 12],
  ["WC", 22],
  ["INT", 6],
];

const FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Ethan", "Ivy", "Lucas", "Nora", "Owen", "Ruby", "Mason", "Lena", "Caleb", "Iris", "Felix", "Maya", "Hugo", "Clara", "Theo", "Ada", "Jonah", "Elise", "Miles", "Hazel", "Ezra", "Leah", "Silas", "Wren", "Arlo", "June", "Omar", "Priya", "Kenji", "Sofia", "Mateo", "Amara", "Diego", "Freya", "Ravi"];
const LAST = ["Smith", "Patel", "Garcia", "Nguyen", "Kim", "Okafor", "Rossi", "Muller", "Silva", "Cohen", "Brown", "Lopez", "Tanaka", "Novak", "Haddad", "Walsh", "Reyes", "Larsen", "Mensah", "Ivanova", "Fischer", "Moreau", "Singh", "Byrne", "Costa", "Dubois", "Ortiz", "Yilmaz", "Kowalski", "Adeyemi"];
// Reserved example domains (RFC 2606), so no address belongs to a real mailbox.
const DOMAINS = ["mail.example.com", "example.org", "example.net", "inbox.example.com", "post.example.org", "webmail.example.net"];
const ACQ_CHANNELS: (readonly [string, number])[] = [
  ["organic", 30],
  ["paid_search", 22],
  ["paid_social", 16],
  ["email", 8],
  ["referral", 10],
  ["affiliate", 8],
  ["display", 6],
];
const SPEND_CHANNELS = ["paid_search", "paid_social", "email", "affiliate", "display"] as const;
const SESSION_CHANNELS: (readonly [string | null, number])[] = [
  [null, 22],
  ["organic", 26],
  ["paid_search", 18],
  ["paid_social", 12],
  ["email", 7],
  ["referral", 6],
  ["affiliate", 5],
  ["display", 4],
];
const CATEGORIES = ["apparel", "footwear", "accessories", "home", "outdoor"] as const;
const ADJ = ["Classic", "Trail", "Everyday", "Coastal", "Alpine", "Urban", "Heritage", "Summit", "Lightweight", "Woven", "Merino", "Canvas"];
const NOUNS: Record<(typeof CATEGORIES)[number], string[]> = {
  apparel: ["Tee", "Hoodie", "Jacket", "Chinos", "Flannel Shirt"],
  footwear: ["Sneaker", "Hiking Boot", "Slip-On", "Sandal"],
  accessories: ["Beanie", "Backpack", "Wallet", "Sunglasses"],
  home: ["Throw Blanket", "Mug Set", "Candle", "Cushion"],
  outdoor: ["Tent", "Water Bottle", "Headlamp", "Camp Chair"],
};

export interface Dataset {
  warehouse: Record<string, Row[]>;
  lake: Record<string, Row[]>;
}

interface Customer {
  id: number;
  email: string;
  first: string;
  last: string;
  signup: number;
  region: string;
  isTest: boolean;
}

interface Order {
  id: number;
  customerId: number;
  created: number;
  status: string;
  amount: number;
  shipping: number;
  shipRegion: string;
}

// ---------- generation ----------

export function buildDataset(): Dataset {
  const w: Record<string, Row[]> = {};
  const l: Record<string, Row[]> = {};

  w.dim_regions = REGIONS;

  // Customers: 500, ids 1..500. 12 flagged test accounts, plus 8 unflagged accounts at example-test.com.
  const cr = new Rng(101);
  const customers: Customer[] = [];
  const flagged = new Set<number>();
  while (flagged.size < 12) flagged.add(cr.int(1, 500));
  const unflaggedTestEmail = new Set<number>();
  while (unflaggedTestEmail.size < 8) {
    const id = cr.int(1, 500);
    if (!flagged.has(id)) unflaggedTestEmail.add(id);
  }
  for (let id = 1; id <= 500; id++) {
    const first = cr.pick(FIRST);
    const last = cr.pick(LAST);
    const isTest = flagged.has(id);
    let email: string;
    if (unflaggedTestEmail.has(id) || (isTest && id % 2 === 0)) email = `qa.${first.toLowerCase()}${id}@example-test.com`;
    else if (isTest) email = `test+${id}@acme.example`;
    else email = `${first.toLowerCase()}.${last.toLowerCase()}${id}@${cr.pick(DOMAINS)}`;
    const signup = START_2022_06 + cr.int(0, Math.floor((Date.UTC(2025, 8, 30) / 1000 - START_2022_06) / 60)) * 60;
    customers.push({ id, email, first, last, signup, region: cr.weighted(REGION_WEIGHTS), isTest });
  }
  const phoneRng = new Rng(102);
  const acqRng = new Rng(103);
  w.dim_customers = customers.map((c) => [
    c.id,
    c.email,
    // 555-0100..0199 is the block reserved for fictional use in every area code.
    phoneRng.chance(0.1) ? null : `+1-${String(phoneRng.int(201, 989))}-555-01${String(phoneRng.int(0, 99)).padStart(2, "0")}`,
    c.first,
    c.last,
    ts(c.signup),
    c.region,
    c.isTest,
    acqRng.weighted(ACQ_CHANNELS),
  ]);

  // Products: 60.
  const pr = new Rng(201);
  const products: { id: number; price: number }[] = [];
  w.dim_products = [];
  for (let id = 1; id <= 60; id++) {
    const category = CATEGORIES[(id - 1) % CATEGORIES.length] ?? "apparel";
    const name = `${pr.pick(ADJ)} ${pr.pick(NOUNS[category])}`;
    const price = pr.int(10, 160) * 50 - 1; // 499 .. 7999
    products.push({ id, price });
    const launched = Date.UTC(2021, 0, 1) / 1000 + pr.int(0, 1300) * DAY;
    w.dim_products.push([id, `SKU-${category.slice(0, 3).toUpperCase()}-${String(id).padStart(4, "0")}`, name, category, price, !pr.chance(0.12), dateOf(launched)]);
  }

  // Order days: growth across the two years plus a November-December peak.
  const dayWeights: number[] = [];
  for (let d = 0; d < DAYS; d++) {
    const month = new Date((START_2024 + d * DAY) * 1000).getUTCMonth();
    const season = month === 10 ? 1.5 : month === 11 ? 1.7 : 1;
    dayWeights.push((1 + 0.45 * (d / DAYS)) * season);
  }
  const cumulative: number[] = [];
  dayWeights.reduce((s, x) => {
    cumulative.push(s + x);
    return s + x;
  }, 0);
  const totalWeight = cumulative[cumulative.length - 1] ?? 1;
  const sampleDay = (r: Rng): number => {
    const x = r.float() * totalWeight;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] ?? 0) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // Orders: 5000, ids 100001.. sorted by time. About 1% reference customers that no longer exist (501..560).
  const or = new Rng(301);
  const times: number[] = [];
  for (let i = 0; i < 5000; i++) times.push(START_2024 + sampleDay(or) * DAY + or.int(0, DAY - 1));
  times.sort((a, b) => a - b);
  const testCustomers = customers.filter((c) => c.isTest || c.email.endsWith("@example-test.com"));
  const bySignup = [...customers].sort((a, b) => a.signup - b.signup || a.id - b.id);
  const orders: Order[] = [];
  const items: Row[] = [];
  let itemId = 1;
  times.forEach((created, i) => {
    let customerId: number;
    if (or.chance(0.01)) customerId = or.int(501, 560);
    else if (or.chance(0.035)) {
      // A test order goes to a test account that already existed when it was placed.
      const open = testCustomers.filter((c) => c.signup <= created);
      customerId = or.pick(open).id;
    } else {
      let eligible = 0;
      while (eligible < bySignup.length && (bySignup[eligible]?.signup ?? Infinity) <= created) eligible++;
      customerId = bySignup[or.int(0, Math.max(0, eligible - 1))]?.id ?? 1;
    }
    const recent = created >= END_2025 - 14 * DAY;
    const status = recent
      ? or.weighted([["shipped", 60], ["completed", 30], ["cancelled", 10]] as const)
      : or.weighted([["completed", 81], ["shipped", 5], ["cancelled", 10], ["refunded", 4]] as const);
    const nItems = or.weighted([[1, 25], [2, 30], [3, 25], [4, 12], [5, 8]] as const);
    let amount = 0;
    const id = 100001 + i;
    for (let k = 0; k < nItems; k++) {
      const p = or.pick(products);
      const qty = or.weighted([[1, 75], [2, 18], [3, 7]] as const);
      const unit = or.chance(0.15) ? Math.round((p.price * 0.8) / 10) * 10 - 1 : p.price;
      amount += qty * unit;
      items.push([itemId++, id, p.id, qty, unit]);
    }
    const customer = customers[customerId - 1];
    const home = customerId <= 500 && customer ? customer.region : or.weighted(REGION_WEIGHTS);
    const shipRegion = or.chance(0.06) ? or.weighted(REGION_WEIGHTS) : home;
    const shipping = amount >= 7500 ? 0 : shipRegion === "INT" ? 1999 : 599;
    orders.push({ id, customerId, created, status, amount, shipping, shipRegion });
  });
  w.fct_orders = orders.map((o) => [o.id, o.customerId, ts(o.created), o.status, o.amount, o.shipping, o.shipRegion, "USD"]);
  w.fct_order_items = items;

  // Refunds: full (sometimes split in two) for refunded orders, partial for some completed or shipped orders.
  const rr = new Rng(401);
  const REASONS = ["damaged", "wrong_item", "late_delivery", "customer_request", "price_adjustment"];
  const refunds: { orderId: number; cents: number; at: number; reason: string }[] = [];
  for (const o of orders) {
    if (o.status === "refunded") {
      const at = o.created + rr.int(2, 30) * DAY + rr.int(0, DAY - 1);
      if (rr.chance(0.2)) {
        const first = Math.round((o.amount * rr.int(30, 70)) / 100);
        refunds.push({ orderId: o.id, cents: first, at, reason: rr.pick(REASONS) });
        refunds.push({ orderId: o.id, cents: o.amount - first, at: at + rr.int(1, 10) * DAY, reason: rr.pick(REASONS) });
      } else refunds.push({ orderId: o.id, cents: o.amount, at, reason: rr.pick(REASONS) });
    } else if ((o.status === "completed" || o.status === "shipped") && rr.chance(0.03)) {
      const at = o.created + rr.int(3, 45) * DAY + rr.int(0, DAY - 1);
      refunds.push({ orderId: o.id, cents: Math.round((o.amount * rr.int(10, 60)) / 100), at, reason: rr.pick(REASONS) });
      if (rr.chance(0.1)) refunds.push({ orderId: o.id, cents: Math.round((o.amount * rr.int(5, 20)) / 100), at: at + rr.int(1, 20) * DAY, reason: "price_adjustment" });
    }
  }
  refunds.sort((a, b) => a.at - b.at || a.orderId - b.orderId);
  w.fct_refunds = refunds.map((r, i) => [i + 1, r.orderId, r.cents, ts(r.at), r.reason]);

  // ---------- lake: sessions and web events ----------
  const sr = new Rng(501);
  type Session = { id: string; customerId: number | null; start: number; channel: string | null; device: string; converts: boolean };
  const sessions: Session[] = [];
  const DEVICES: (readonly [string, number])[] = [
    ["mobile", 55],
    ["desktop", 38],
    ["tablet", 7],
  ];
  // Sessions that lead to an order: same customer, same UTC day, shortly before the order.
  for (const o of orders) {
    if (o.customerId > 500 || !sr.chance(0.36)) continue;
    const start = Math.max(dayStart(o.created), o.created - sr.int(2, 90) * 60);
    sessions.push({ id: "", customerId: o.customerId, start, channel: sr.weighted(SESSION_CHANNELS), device: sr.weighted(DEVICES), converts: true });
  }
  const knownBrowse = 3200 - sessions.length;
  for (let i = 0; i < knownBrowse; i++) {
    const cust = sr.pick(customers);
    const start = Math.max(cust.signup, START_2024) + sr.int(0, Math.max(0, END_2025 - 1 - Math.max(cust.signup, START_2024)));
    sessions.push({ id: "", customerId: cust.id, start, channel: sr.weighted(SESSION_CHANNELS), device: sr.weighted(DEVICES), converts: false });
  }
  for (let i = 0; i < 4800; i++) {
    const start = START_2024 + sampleDay(sr) * DAY + sr.int(0, DAY - 1);
    sessions.push({ id: "", customerId: null, start, channel: sr.weighted(SESSION_CHANNELS), device: sr.weighted(DEVICES), converts: false });
  }
  sessions.sort((a, b) => a.start - b.start || (a.customerId ?? 0) - (b.customerId ?? 0));
  sessions.forEach((s, i) => (s.id = `ses_${token(i, 7)}`));
  l.sessions = sessions.map((s) => [s.id, s.customerId, ts(s.start), s.channel, s.device]);

  const er = new Rng(601);
  const events: { sessionId: string; at: number; type: string; path: string }[] = [];
  const productPaths = products.map((p) => `/products/${p.id}`);
  for (const s of sessions) {
    let t = s.start;
    const landing = er.chance(0.5) ? "/" : er.pick(productPaths);
    events.push({ sessionId: s.id, at: t, type: "page_view", path: landing });
    const browse = s.converts ? er.int(1, 4) : er.int(0, 4);
    for (let k = 0; k < browse; k++) {
      t += er.int(10, 240);
      if (er.chance(0.15)) events.push({ sessionId: s.id, at: t, type: "search", path: "/search" });
      else events.push({ sessionId: s.id, at: t, type: "page_view", path: er.pick(productPaths) });
    }
    if (s.converts || er.chance(0.08)) {
      t += er.int(10, 120);
      events.push({ sessionId: s.id, at: t, type: "add_to_cart", path: "/cart" });
    }
    if (s.converts) {
      t += er.int(20, 300);
      events.push({ sessionId: s.id, at: t, type: "checkout_start", path: "/checkout" });
      t += er.int(20, 300);
      events.push({ sessionId: s.id, at: t, type: "purchase", path: "/checkout/complete" });
    }
  }
  events.sort((a, b) => a.at - b.at || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  l.web_events = events.map((e, i) => [`evt_${token(i, 13)}`, e.sessionId, ts(e.at), e.type, e.path]);

  // Marketing spend: one row per day per paid channel for 2024 and 2025.
  const mr = new Rng(701);
  const BASE: Record<(typeof SPEND_CHANNELS)[number], number> = { paid_search: 1300, paid_social: 975, email: 125, affiliate: 275, display: 375 };
  const CPM: Record<(typeof SPEND_CHANNELS)[number], number> = { paid_search: 900, paid_social: 650, email: 40, affiliate: 500, display: 300 };
  l.marketing_spend = [];
  for (let d = 0; d < DAYS; d++) {
    const growth = dayWeights[d] ?? 1;
    for (const ch of SPEND_CHANNELS) {
      const spend = Math.round(BASE[ch] * growth * (0.75 + mr.float() * 0.5));
      const impressions = Math.round((spend / CPM[ch]) * 1000 * (0.85 + mr.float() * 0.3));
      const clicks = Math.round(impressions * (ch === "email" ? 0.03 : 0.012) * (0.7 + mr.float() * 0.6));
      l.marketing_spend.push([dateOf(START_2024 + d * DAY), ch, spend, impressions, clicks]);
    }
  }

  // ---------- noise ----------
  const nr = new Rng(801);
  const sample = <T,>(xs: T[], n: number, r: Rng): T[] => {
    const step = xs.length / n;
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const x = xs[Math.min(xs.length - 1, Math.floor(i * step + r.float() * step))];
      if (x !== undefined) out.push(x);
    }
    return out;
  };
  const shopStatus: Record<string, string> = { completed: "paid", shipped: "paid", cancelled: "voided", refunded: "refunded" };
  w.raw_shopify_orders = sample(orders, 300, nr).map((o) => [
    `gid://shopify/Order/${5100000000 + o.id}`,
    `#${o.id - 99000}`,
    new Date(o.created * 1000).toISOString(),
    ((o.amount + o.shipping) / 100).toFixed(2),
    shopStatus[o.status] ?? "pending",
    nr.chance(0.1) ? null : customers[o.customerId - 1]?.email ?? null,
  ]);
  w.raw_stripe_charges = sample(orders, 300, nr).map((o, i) => [
    `ch_${token(i, 31)}${token(i, 37)}`,
    o.amount + o.shipping,
    "usd",
    o.status === "cancelled" ? "failed" : "succeeded",
    o.created + nr.int(1, 50),
    nr.chance(0.05) ? null : String(o.id),
  ]);
  w.stg_orders = sample(orders, 300, nr).map((o) => [o.id, o.customerId > 500 ? null : o.customerId, ts(o.created), o.status.toUpperCase(), (o.amount / 100).toFixed(2)]);
  w.stg_customers = sample(customers, 200, nr).map((c) => [c.id, c.email.toUpperCase(), `${c.first} ${c.last}`, ts(c.signup)]);
  w.orders_backup_2024 = sample(orders.filter((o) => o.created < START_2025), 400, nr).map((o) => [o.id, o.customerId, ts(o.created), o.status, o.amount]);
  w.customers_tmp = sample(customers, 50, nr).map((c) => [c.id, c.email, nr.chance(0.2) ? null : c.region]);
  w.dim_customers_archive = sample(customers, 100, nr).map((c) => [c.id, c.email, c.first, c.last, c.region, ts(Date.UTC(2024, 6, 1) / 1000)]);
  w.fct_orders_v2_test = sample(orders, 200, nr).map((o) => [o.id, o.customerId, ts(o.created), o.status, o.amount, nr.chance(0.3) ? nr.int(1, 20) * 100 : 0, o.shipRegion]);
  const day0 = Date.UTC(2025, 0, 1) / 1000;
  w.report_daily_sales_20250101 = REGIONS.map((r) => {
    const region = String(r[0]);
    const os = orders.filter((o) => o.created >= day0 && o.created < day0 + DAY && o.shipRegion === region);
    return [dateOf(day0), region, os.length, (os.reduce((s, o) => s + o.amount + o.shipping, 0) / 100).toFixed(2)];
  });
  const ACTORS = ["dana.ruiz", "etl_bot", "sam.okafor", "admin", "support_bot"];
  const ACTIONS = ["update", "insert", "delete", "login", "export"];
  const ENTITIES = ["order", "customer", "product", "refund"];
  w.audit_log = [];
  for (let i = 1; i <= 500; i++) {
    w.audit_log.push([i, nr.pick(ACTORS), nr.pick(ACTIONS), nr.pick(ENTITIES), String(nr.int(1, 105000)), ts(START_2024 + Math.floor(((i - 1) / 500) * (END_2025 - START_2024)) + nr.int(0, 3600))]);
  }
  w.schema_migrations = [];
  for (let i = 1; i <= 25; i++) w.schema_migrations.push([`2023${String(i).padStart(4, "0")}120000`, ts(Date.UTC(2023, 0, 1) / 1000 + i * 9 * DAY)]);
  const JOBS = ["load_shopify", "load_stripe", "build_marts", "export_lake"];
  w.etl_job_runs = [];
  for (let i = 1; i <= 120; i++) {
    const start = START_2025 + (i - 1) * 3 * DAY + nr.int(0, 3600);
    const failed = nr.chance(0.08);
    w.etl_job_runs.push([i, nr.pick(JOBS), ts(start), failed ? null : ts(start + nr.int(60, 3000)), failed ? "failed" : "succeeded", failed ? null : nr.int(100, 20000)]);
  }
  w.dim_currency = [
    ["CAD", "Canadian dollar", 2],
    ["EUR", "Euro", 2],
    ["USD", "US dollar", 2],
  ];
  w.tmp_import_errors = [];
  for (let i = 1; i <= 20; i++) w.tmp_import_errors.push([i, `shopify_export_2025_${String(nr.int(1, 12)).padStart(2, "0")}.csv`, nr.int(2, 4000), nr.pick(["invalid date", "missing email", "duplicate id", "bad currency"])]);

  const events2024 = l.web_events.filter((e) => String(e[2]) < "2025");
  l.web_events_2024_archive = sample(events2024, 2000, nr).map((e) => [...e, ts(Date.UTC(2025, 1, 1) / 1000)]);
  l.tmp_session_dedupe = sample(l.sessions, 300, nr).map((s) => [s[0] ?? null, nr.int(2, 4), nr.chance(0.5)]);

  return { warehouse: w, lake: l };
}

// ---------- writing ----------

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function asText(v: Value): string | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// Loads rows into a typed DuckDB table through a text staging table.
async function loadTable(c: DuckDBConnection, name: string, columns: ColumnDef[], rows: Row[]): Promise<void> {
  const stage = `stage_${name}`;
  await c.run(`CREATE TABLE ${quoteIdent(stage)} (${columns.map((col) => `${quoteIdent(col.name)} VARCHAR`).join(", ")})`);
  const app = await c.createAppender(stage);
  for (const row of rows) {
    if (row.length !== columns.length) throw new Error(`${name}: row has ${row.length} values, expected ${columns.length}`);
    for (const v of row) {
      const t = asText(v);
      if (t === null) app.appendNull();
      else app.appendVarchar(t);
    }
    app.endRow();
  }
  app.closeSync();
  const casts = columns.map((col) => `CAST(${quoteIdent(col.name)} AS ${DUCKDB_TYPES[col.type]}) AS ${quoteIdent(col.name)}`).join(", ");
  await c.run(`CREATE TABLE ${quoteIdent(name)} AS SELECT ${casts} FROM ${quoteIdent(stage)}`);
  await c.run(`DROP TABLE ${quoteIdent(stage)}`);
}

export async function generate(outDir: string): Promise<void> {
  const data = buildDataset();
  rmSync(join(outDir, "warehouse"), { recursive: true, force: true });
  rmSync(join(outDir, "lake"), { recursive: true, force: true });
  mkdirSync(join(outDir, "warehouse"), { recursive: true });
  mkdirSync(join(outDir, "lake"), { recursive: true });

  const instance = await DuckDBInstance.create(":memory:", { threads: "1" });
  const c = await instance.connect();
  try {
    await c.run("SET TimeZone = 'UTC'");
    await c.run("SET preserve_insertion_order = true");
    for (const t of WAREHOUSE_TABLES) {
      const rows = data.warehouse[t.name];
      if (!rows) throw new Error(`no rows generated for ${t.name}`);
      await loadTable(c, t.name, t.columns, rows);
      const file = join(outDir, "warehouse", `${t.name}.csv`);
      await c.run(`COPY (SELECT * FROM ${quoteIdent(t.name)}) TO ${quoteLiteral(file)} (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"', NULLSTR '')`);
    }
    for (const t of LAKE_TABLES) {
      const rows = data.lake[t.name];
      if (!rows) throw new Error(`no rows generated for ${t.name}`);
      await loadTable(c, t.name, t.columns, rows);
      const opts = "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)";
      if (t.splitByYear) {
        mkdirSync(join(outDir, "lake", t.path), { recursive: true });
        for (const year of [2024, 2025]) {
          const file = join(outDir, "lake", t.path, `${t.name}_${year}.parquet`);
          await c.run(`COPY (SELECT * FROM ${quoteIdent(t.name)} WHERE year(${quoteIdent(t.splitByYear)}) = ${year}) TO ${quoteLiteral(file)} ${opts}`);
        }
      } else {
        const file = join(outDir, "lake", t.path);
        mkdirSync(dirname(file), { recursive: true });
        await c.run(`COPY (SELECT * FROM ${quoteIdent(t.name)}) TO ${quoteLiteral(file)} ${opts}`);
      }
    }
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

if (import.meta.main) {
  const outDir = resolve(process.argv[2] ?? join(import.meta.dir, "data"));
  await generate(outDir);
  console.log(`Wrote the Acme dataset to ${outDir}`);
}

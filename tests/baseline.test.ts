import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, INCOMING_READ_MAX, QUESTION_TOPICS, renderBaseline, type BaselineReport, type TableBaseline } from "../skills/semantic-layer/scripts/lib/baseline.ts";
import { draftModels } from "../skills/semantic-layer/scripts/lib/draft.ts";
import type { ColumnProfile, Model, Snapshot, SnapshotColumn, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { updateYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, PG_URL, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function col(name: string, type: string, profile?: ColumnProfile): SnapshotColumn {
  return profile ? { name, type, profile } : { name, type };
}

const ref = (table: string, columns: string[]) => ({ schema: "shop", table, columns });

// A hand-written star schema: orders with lines, customers and products, a bridge, an event table,
// a history table, a staging table and a backup. No profiles.
function starTables(): SnapshotTable[] {
  return [
    {
      schema: "shop",
      name: "orders",
      kind: "table",
      row_count: 10000,
      description: "Orders from the web shop, one row per order.",
      primary_key: ["order_id"],
      foreign_keys: [{ columns: ["customer_id"], references: ref("customers", ["customer_id"]) }],
      columns: [
        col("order_id", "bigint"),
        col("customer_id", "bigint"),
        col("created_at", "timestamp"),
        col("shipped_at", "timestamp"),
        col("status", "varchar"),
        col("total_cents", "bigint"),
        col("discount_cents", "bigint"),
        col("currency", "varchar"),
        col("is_test", "boolean"),
        col("is_gift", "boolean"),
        col("deleted_at", "timestamp"),
        col("notes", "text"),
      ],
    },
    {
      schema: "shop",
      name: "order_items",
      kind: "table",
      row_count: 30000,
      primary_key: ["order_item_id"],
      foreign_keys: [{ columns: ["order_id"], references: ref("orders", ["order_id"]) }],
      columns: [col("order_item_id", "bigint"), col("order_id", "bigint"), col("product_id", "bigint"), col("quantity", "integer"), col("unit_price_cents", "integer")],
    },
    {
      schema: "shop",
      name: "customers",
      kind: "table",
      row_count: 2000,
      primary_key: ["customer_id"],
      columns: [
        col("customer_id", "bigint"),
        col("email", "varchar"),
        col("first_name", "varchar"),
        col("signup_at", "timestamp"),
        col("acquisition_channel", "varchar"),
        col("segment", "varchar"),
        col("country", "varchar"),
      ],
    },
    {
      schema: "shop",
      name: "products",
      kind: "table",
      row_count: 300,
      primary_key: ["product_id"],
      columns: [col("product_id", "bigint"), col("sku", "varchar"), col("product_name", "varchar"), col("category", "varchar"), col("is_active", "boolean")],
    },
    {
      schema: "shop",
      name: "product_tags",
      kind: "table",
      row_count: 900,
      columns: [col("product_id", "bigint"), col("tag_id", "bigint")],
    },
    {
      schema: "shop",
      name: "web_events",
      kind: "table",
      row_count: 500000,
      columns: [col("event_id", "bigint"), col("customer_id", "bigint"), col("event_name", "varchar"), col("occurred_at", "timestamp"), col("device", "varchar"), col("page_url", "varchar")],
    },
    {
      schema: "shop",
      name: "customer_history",
      kind: "table",
      row_count: 5000,
      primary_key: ["customer_id", "valid_from"],
      columns: [col("customer_id", "bigint"), col("valid_from", "timestamp"), col("valid_to", "timestamp"), col("plan", "varchar"), col("tier", "varchar")],
    },
    {
      schema: "shop",
      name: "stg_orders",
      kind: "table",
      row_count: 10000,
      columns: [col("order_id", "bigint"), col("total_cents", "bigint"), col("created_at", "timestamp")],
    },
    {
      schema: "shop",
      name: "orders_backup_2023",
      kind: "table",
      row_count: 8000,
      columns: [col("order_id", "bigint"), col("customer_id", "bigint"), col("total_cents", "bigint")],
    },
  ];
}

function snapshot(tables: SnapshotTable[]): Snapshot {
  return { snapshot_version: 1, source: "shop", dialect: "postgres", captured_at: "2026-01-15T12:00:00.000Z", method: "information_schema", tables };
}

const p = (distinct: number, extra: Partial<ColumnProfile> = {}): ColumnProfile => ({ distinct_count: distinct, null_fraction: 0, ...extra });

// The same schema with profiles on every column.
function profiledTables(): SnapshotTable[] {
  const profiles: Record<string, Record<string, ColumnProfile>> = {
    orders: {
      order_id: p(10000),
      customer_id: p(1800),
      created_at: p(9990),
      shipped_at: p(9000, { null_fraction: 0.1 }),
      status: p(4, { top_values: [{ value: "completed", count: 8000 }, { value: "cancelled", count: 1000 }, { value: "test", count: 600 }, { value: "pending", count: 400 }] }),
      total_cents: p(5000),
      discount_cents: p(300),
      currency: p(1, { top_values: [{ value: "EUR", count: 10000 }] }),
      is_test: p(2),
      is_gift: p(2),
      deleted_at: p(50, { null_fraction: 0.99 }),
      notes: p(9500),
    },
    order_items: { order_item_id: p(30000), order_id: p(10000), product_id: p(300), quantity: p(10), unit_price_cents: p(250) },
    customers: {
      customer_id: p(2000),
      email: p(2000),
      first_name: p(700),
      signup_at: p(1990),
      acquisition_channel: p(6, { top_values: [{ value: "organic", count: 900 }, { value: "paid_search", count: 600 }] }),
      segment: p(40),
      country: p(12),
    },
    products: { product_id: p(300), sku: p(300), product_name: p(290), category: p(8), is_active: p(2) },
    product_tags: { product_id: p(300), tag_id: p(40) },
    web_events: { event_id: p(500000), customer_id: p(1900), event_name: p(15), occurred_at: p(499000), device: p(3), page_url: p(480000) },
    customer_history: { customer_id: p(2000), valid_from: p(5000), valid_to: p(3000, { null_fraction: 0.4 }), plan: p(3), tier: p(4) },
    stg_orders: { order_id: p(10000), total_cents: p(5000), created_at: p(9990) },
    orders_backup_2023: { order_id: p(8000), customer_id: p(1500), total_cents: p(4000) },
  };
  return starTables().map((t) => ({
    ...t,
    profiled_at: "2026-01-15T12:00:00.000Z",
    columns: t.columns.map((c) => ({ ...c, profile: profiles[t.name]![c.name]! })),
  }));
}

const OPTS = { source: "shop", focusThreshold: 12 };

function table(report: BaselineReport, name: string): TableBaseline {
  const t = report.tables.find((x) => x.table === `shop.${name}`);
  if (!t) throw new Error(`no table ${name} in the report: ${report.tables.map((x) => x.table).join(", ")}`);
  return t;
}

describe("baseline without profiles", () => {
  const report = buildBaseline(snapshot(starTables()), OPTS);

  test("reports every table when no scope is set and the count is within the focus threshold", () => {
    expect(report.selection).toBe("all");
    expect(report.tables).toHaveLength(9);
    expect(report.left_out).toEqual([]);
    expect(report.profiled).toBe(false);
  });

  test("roles, each with reasons", () => {
    const roles = Object.fromEntries(report.tables.map((t) => [t.table.replace("shop.", ""), t.role]));
    expect(roles).toEqual({
      orders: "fact",
      order_items: "fact",
      web_events: "event",
      customer_history: "snapshot",
      product_tags: "bridge",
      customers: "dimension",
      products: "dimension",
      stg_orders: "staging",
      orders_backup_2023: "noise",
    });
    for (const t of report.tables) expect(t.role_reasons.length).toBeGreaterThan(0);
    expect(table(report, "customer_history").role_reasons.join(" ")).toContain("valid_from and valid_to");
    expect(table(report, "orders_backup_2023").role_reasons.join(" ")).toContain("backup");
    // Facts come first, noise last.
    expect(report.tables[0]!.role).toBe("fact");
    expect(report.tables.at(-1)!.role).toBe("noise");
  });

  test("grains are guesses from comments, keys and names", () => {
    expect(table(report, "orders").grain).toEqual({ guess: "one row per order", basis: "the table comment and the declared primary key order_id" });
    expect(table(report, "order_items").grain.guess).toBe("one row per order item (several per order)");
    expect(table(report, "product_tags").grain.guess).toBe("one row per pair of product and tag");
    expect(table(report, "customer_history").grain.guess).toBe("one row per version of a customer (from valid_from and valid_to)");
    expect(table(report, "customers").grain.guess).toBe("one row per customer");
    expect(table(report, "stg_orders").grain.basis).toContain("the column name order_id");
  });

  test("keys: declared, every column of an id-only table, or likely from the name", () => {
    expect(table(report, "orders").primary_key).toMatchObject({ columns: ["order_id"], how: "declared", confirmed: true });
    expect(table(report, "product_tags").primary_key).toMatchObject({ columns: ["product_id", "tag_id"], how: "ids", confirmed: false });
    expect(table(report, "web_events").primary_key).toMatchObject({ columns: ["event_id"], how: "name", confirmed: false });
  });

  test("relationships, declared and inferred, with the fan-out warning on order lines", () => {
    const items = table(report, "order_items");
    const toOrders = items.relationships.find((r) => r.direction === "outgoing" && r.table === "shop.orders")!;
    expect(toOrders).toMatchObject({ columns: ["order_id"], relationship: "many_to_one", origin: "declared", join: "order" });
    expect(toOrders.fan_out).toContain("many side of shop.orders");
    expect(toOrders.fan_out).toContain("several order items per order");
    const toProducts = items.relationships.find((r) => r.table === "shop.products")!;
    expect(toProducts).toMatchObject({ origin: "inferred", relationship: "many_to_one", join: "product" });
    expect(toProducts.fan_out).toBeUndefined();

    const orders = table(report, "orders");
    const lines = orders.relationships.find((r) => r.direction === "incoming" && r.table === "shop.order_items")!;
    expect(lines.relationship).toBe("one_to_many");
    expect(lines.fan_out).toContain("several rows in shop.order_items");
    // A backup and a staging copy that reuse the key are not references.
    expect(orders.relationships.some((r) => r.table === "shop.orders_backup_2023" || r.table === "shop.stg_orders")).toBe(false);
    // A dimension's lines carry no fan-out warning.
    expect(orders.relationships.find((r) => r.table === "shop.customers")!.fan_out).toBeUndefined();
  });

  test("candidate measures: row count, money sums with a cents note, distinct keys, flag shares and an AOV-style ratio", () => {
    const m = table(report, "orders").measures;
    const byName = Object.fromEntries(m.map((x) => [x.name, x]));
    expect(byName.order_count).toMatchObject({ kind: "row_count", agg: "count" });
    expect(byName.total).toMatchObject({ kind: "sum", agg: "sum", columns: ["total_cents"], format: "currency", expr: "total_cents / 100.0" });
    expect(byName.total!.unit_note).toContain("cents");
    expect(byName.discount!.unit_note).toContain("cents");
    expect(byName.customer_count).toMatchObject({ kind: "distinct_count", columns: ["customer_id"] });
    expect(byName.gift_share).toMatchObject({ kind: "share", format: "percent", columns: ["is_gift"] });
    // A test flag is a filter, not a share.
    expect(m.some((x) => x.columns.includes("is_test"))).toBe(false);
    const ratio = m.find((x) => x.kind === "ratio")!;
    expect(ratio).toMatchObject({ name: "avg_total_per_order", numerator: "total", denominator: "order_count", format: "currency" });
    expect(ratio.description).toContain("average order value");

    const items = Object.fromEntries(table(report, "order_items").measures.map((x) => [x.name, x]));
    expect(items.quantity).toMatchObject({ kind: "sum", format: "integer" });
    expect(items.avg_unit_price).toMatchObject({ kind: "average" });
    expect(items.line_total).toMatchObject({ kind: "sum", columns: ["quantity", "unit_price_cents"], format: "currency" });
    expect(table(report, "order_items").measures.find((x) => x.kind === "ratio")!.numerator).toBe("line_total");
  });

  test("candidate splits: time with grains, categories by name, and joined dimension attributes", () => {
    const s = table(report, "orders").splits;
    const fields = s.map((x) => x.field);
    expect(s.find((x) => x.field === "created_at")).toMatchObject({ kind: "time", time_grains: ["hour", "day", "week", "month", "quarter", "year"] });
    expect(s.find((x) => x.field === "status")).toMatchObject({ kind: "category" });
    expect(s.find((x) => x.field === "status")!.basis).toContain("name");
    expect(fields).toContain("currency");
    expect(fields).toContain("is_gift");
    const joined = s.find((x) => x.field === "customer.acquisition_channel")!;
    expect(joined).toMatchObject({ via: "customer", table: "shop.customers", column: "acquisition_channel", kind: "category" });
    expect(fields).toContain("customer.segment");
    expect(fields).toContain("customer.country");
    // Filters and sensitive columns are not splits; neither is a joined time column.
    for (const f of ["is_test", "deleted_at", "notes", "customer.email", "customer.signup_at"]) expect(fields).not.toContain(f);

    const itemFields = table(report, "order_items").splits.map((x) => x.field);
    expect(itemFields).toContain("product.category");
    expect(itemFields).toContain("order.status");
    expect(itemFields).toContain("order.customer.acquisition_channel");
  });

  test("columns that should not be splits: ids, sensitive, free text and measures", () => {
    const orders = Object.fromEntries(table(report, "orders").not_splits.map((x) => [x.column, x]));
    expect(orders.order_id!.reason).toBe("id");
    expect(orders.customer_id).toMatchObject({ reason: "id" });
    expect(orders.customer_id!.detail).toContain("customer.acquisition_channel");
    expect(orders.notes!.reason).toBe("sensitive");
    expect(orders.total_cents!.reason).toBe("measure");
    const customers = Object.fromEntries(table(report, "customers").not_splits.map((x) => [x.column, x]));
    expect(customers.email).toMatchObject({ reason: "sensitive" });
    expect(customers.email!.detail).toContain("pii");
    const events = Object.fromEntries(table(report, "web_events").not_splits.map((x) => [x.column, x]));
    expect(events.page_url!.reason).toBe("free_text");
    // Without a profile, a text column of unknown cardinality is unclear rather than a split.
    expect(table(report, "products").unclear.map((u) => u.column)).toEqual(["sku", "product_name"]);
  });

  test("questions are ordered by importance", () => {
    const qs = table(report, "orders").questions;
    expect(qs.map((q) => q.topic)).toEqual(["grain", "status_values", "date", "units", "exclusions", "sensitive"]);
    expect(qs[0]!.question).toContain("one row per order");
    expect(qs[2]!.question).toContain("created_at or shipped_at");
    expect(qs[2]!.question).toContain("Our guess is created_at");
    expect(qs[3]!.question).toContain("total_cents and discount_cents look like money stored in cents");
    expect(qs[3]!.question).toContain("currency");
    expect(qs[4]!.question).toContain("is_test");
    expect(qs[4]!.question).toContain("deleted_at");
    expect(qs[5]!.columns).toEqual(["notes"]);
    const history = table(report, "customer_history").questions;
    expect(history.map((q) => q.topic)).toContain("history");
    expect(history.find((q) => q.topic === "history")!.question).toContain("current version");
    for (const t of report.tables) {
      const order = t.questions.map((q) => QUESTION_TOPICS.indexOf(q.topic));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(t.questions[0]!.topic).toBe("grain");
    }
    expect(table(report, "orders_backup_2023").questions[0]!.question).toContain("looks like noise");
  });

  test("the star sketch names which dimensions each fact joins", () => {
    const facts = Object.fromEntries(report.star.facts.map((f) => [f.table, f]));
    expect(facts["shop.orders"]!.dimensions.map((d) => d.table)).toEqual(["shop.customers"]);
    expect(facts["shop.order_items"]!.dimensions.map((d) => d.table)).toEqual(["shop.products"]);
    expect(facts["shop.order_items"]!.parents).toEqual([{ table: "shop.orders", columns: ["order_id"] }]);
    expect(facts["shop.web_events"]!.dimensions.map((d) => d.via)).toEqual(["customer"]);
    expect(report.star.dimensions.sort()).toEqual(["shop.customers", "shop.products"]);
    expect(report.star.unattached_dimensions).toEqual([]);
    expect(report.star.other).toContainEqual({ table: "shop.stg_orders", role: "staging" });
  });

  test("says what sl profile would measure", () => {
    expect(report.profile_command).toStartWith("sl profile --source shop --tables ");
    expect(report.profile_command).toContain("shop.orders");
    expect(report.profile_command).not.toContain("orders_backup_2023");
    const orders = table(report, "orders").profile_would_measure.join(" ");
    expect(orders).toContain("status");
    expect(table(report, "web_events").profile_would_measure.join(" ")).toContain("whether event_id is unique");
    expect(report.notes.join(" ")).toContain("No table in this brief has a profile");
  });

  test("the markdown words everything as a guess and nests order lines under orders", () => {
    const md = renderBaseline(report);
    expect(md).toStartWith("# Baseline brief: shop\n");
    expect(md).toContain("## Star-schema sketch (a guess)");
    expect(md).toMatch(/- \*\*shop\.orders\*\* \(fact, one row per order\) joins shop\.customers via customer\n  - \*\*shop\.order_items\*\*/);
    expect(md).toContain("### shop.orders: probably a fact");
    expect(md).toContain("Grain (guess): one row per order");
    expect(md).toContain("Fan-out warning:");
    expect(md).toContain("`customer.acquisition_channel`");
    expect(md).toContain("## What a profile would measure");
    expect(md).toContain("for the owner to confirm or correct");
    // Meaning is never stated as fact.
    expect(md).not.toMatch(/\bis definitely\b|\bcertainly\b/);
  });
});

describe("the brief hedges its guesses", () => {
  const report = buildBaseline(snapshot(starTables()), OPTS);

  test("a key guessed from its name is probably the key; an inferred join is probably a key", () => {
    const events = Object.fromEntries(table(report, "web_events").not_splits.map((x) => [x.column, x]));
    expect(events.event_id!.detail).toBe("probably the table's key: one value per row");
    const orders = Object.fromEntries(table(report, "orders").not_splits.map((x) => [x.column, x]));
    expect(orders.order_id!.detail).toBe("the table's key: one value per row");
    expect(orders.customer_id!.detail).toStartWith("a key to shop.customers");
    const items = Object.fromEntries(table(report, "order_items").not_splits.map((x) => [x.column, x]));
    expect(items.product_id!.detail).toStartWith("probably a key to shop.products");
    expect(items.order_id!.detail).toStartWith("a key to shop.orders");
  });

  test("no distinct count of a table's own key, which repeats the row count", () => {
    for (const t of report.tables) {
      const own = t.primary_key?.columns.length === 1 ? t.primary_key.columns[0] : undefined;
      if (!own) continue;
      expect(t.measures.filter((m) => m.kind === "distinct_count" && m.columns.includes(own))).toEqual([]);
    }
    expect(table(report, "orders").measures.some((m) => m.kind === "distinct_count" && m.columns[0] === "customer_id")).toBe(true);
  });

  test("noise carries no fan-out and no 'several per'", () => {
    const backup = table(report, "orders_backup_2023");
    expect(backup.grain.guess).not.toContain("several per");
    expect(backup.relationships.some((r) => r.fan_out)).toBe(false);
  });

  test("the intro reads well with and without profiles", () => {
    expect(renderBaseline(report)).toContain("Everything below is a guess from names and keys, for the owner to confirm");
    expect(renderBaseline(report)).toContain("from an information schema import");
    expect(renderBaseline(buildBaseline(snapshot(profiledTables()), OPTS))).toContain("Everything below is a guess from names, keys and profiles, for the owner");
  });

  test("sums on a dimension, epoch numbers and partial keys are worded as doubtful", () => {
    const extra: SnapshotTable[] = [
      { schema: "shop", name: "dim_currency", kind: "table", row_count: 30, primary_key: ["currency_code"], columns: [col("currency_code", "varchar"), col("minor_units", "integer")] },
      { schema: "shop", name: "charges", kind: "table", row_count: 300, columns: [col("charge_id", "varchar"), col("customer_id", "bigint"), col("amount", "bigint"), col("created", "bigint")] },
      { schema: "shop", name: "audit_log", kind: "table", row_count: 300, columns: [col("audit_id", "bigint"), col("action", "varchar"), col("logged_at", "timestamp")] },
    ];
    const r = buildBaseline(snapshot([...starTables(), ...extra]), OPTS);
    const currency = table(r, "dim_currency");
    expect(currency.role).toBe("dimension");
    expect(currency.measures.find((m) => m.name === "minor_units")!.description).toContain("probably not something to add up: confirm");
    // A fact's sums are not hedged that way.
    expect(table(r, "orders").measures.find((m) => m.name === "total")!.description).not.toContain("probably not something to add up");
    const created = table(r, "charges").measures.find((m) => m.columns.includes("created"))!;
    expect(created.kind).toBe("average");
    expect(created.description).toContain("timestamp stored as a number");
    expect(table(r, "audit_log").grain.guess).toBe("one row per audit log");
  });
});

describe("baseline on a large snapshot", () => {
  // Many tables share customer_id; one customers table is keyed by it.
  function wide(n: number): Snapshot {
    const tables: SnapshotTable[] = [];
    for (let i = 0; i < n; i++) {
      tables.push({
        schema: "s",
        name: `t${i}_orders`,
        kind: "table",
        row_count: 1000 + i,
        primary_key: [`t${i}_order_id`],
        columns: [col(`t${i}_order_id`, "bigint"), col("customer_id", "bigint"), col("status", "varchar"), col("amount_cents", "bigint"), col("created_at", "timestamp")],
      });
    }
    tables.push({ schema: "s", name: "customers", kind: "table", row_count: 10, primary_key: ["customer_id"], columns: [col("customer_id", "bigint"), col("segment", "varchar")] });
    return { snapshot_version: 1, source: "x", dialect: "postgres", captured_at: "2026-01-01T00:00:00Z", method: "information_schema", tables };
  }

  test("a focus brief over 2000 tables sharing customer_id builds quickly", () => {
    const snap = wide(2000);
    const t0 = performance.now();
    const r = buildBaseline(snap, { source: "x", focusThreshold: 12 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.selection).toBe("focus");
    expect(r.tables).toHaveLength(12);
    // Above the focus threshold the next step is to agree a scope, not to profile or draft.
    expect(r.next).toContain("agree which tables to focus on first");
    expect(r.next).not.toContain("sl draft");
    for (const t of r.tables) {
      expect(t.relationships.find((x) => x.direction === "outgoing" && x.table === "s.customers")).toMatchObject({ origin: "inferred", relationship: "many_to_one" });
      expect(t.splits.map((s) => s.field)).toContain("customer.segment");
    }
  });

  test("a table referenced by many reads the top ones and counts the rest", () => {
    const snap = wide(2000);
    const t0 = performance.now();
    const r = buildBaseline(snap, { source: "x", focusThreshold: 12, tables: ["customers"] });
    expect(performance.now() - t0).toBeLessThan(2000);
    const customers = r.tables[0]!;
    expect(customers.role).toBe("dimension");
    expect(customers.relationships.filter((x) => x.direction === "incoming")).toHaveLength(INCOMING_READ_MAX);
    expect(customers.references_not_read).toEqual({ count: 2000 - INCOMING_READ_MAX, columns: ["customer_id"] });
    expect(customers.role_reasons.join(" ")).toContain(`${2000 - INCOMING_READ_MAX} more tables carry customer_id and were not read`);
    expect(renderBaseline(r)).toContain(`${2000 - INCOMING_READ_MAX} more tables carry customer_id and were not read`);
    // The star schema's own tables are read in full.
    expect(buildBaseline(snapshot(starTables()), OPTS).tables.every((t) => t.references_not_read === null)).toBe(true);
  });
});

describe("baseline with profiles", () => {
  const report = buildBaseline(snapshot(profiledTables()), OPTS);

  test("profiles sharpen keys, splits and questions", () => {
    expect(report.profiled).toBe(true);
    expect(report.profile_command).toBeNull();
    expect(report.notes.join(" ")).not.toContain("No table in this brief has a profile");
    for (const t of report.tables) expect(t.profile_would_measure).toEqual([]);
    expect(table(report, "web_events").primary_key).toMatchObject({ columns: ["event_id"], how: "profile" });

    const status = table(report, "orders").splits.find((x) => x.field === "status")!;
    expect(status).toMatchObject({ distinct_count: 4, values: ["completed", "cancelled", "test", "pending"] });
    expect(status.basis).toBe("4 distinct values in the profile");
    const statusQ = table(report, "orders").questions.find((q) => q.topic === "status_values")!;
    expect(statusQ.question).toContain('"completed" (8,000)');
    const exclusions = table(report, "orders").questions.find((q) => q.topic === "exclusions")!;
    expect(exclusions.question).toContain('status = "test"');
    // One currency in the profile: the money measures carry it.
    const total = table(report, "orders").measures.find((m) => m.name === "total")!;
    expect(total.currency).toBe("EUR");
    expect(table(report, "orders").questions.find((q) => q.topic === "units")!.question).toContain("holds only EUR");
  });

  test("high-cardinality and near-unique columns are not splits", () => {
    const customers = table(report, "customers");
    expect(customers.splits.map((s) => s.field)).toContain("acquisition_channel");
    expect(customers.splits.map((s) => s.field)).toContain("country");
    expect(customers.splits.map((s) => s.field)).not.toContain("segment");
    const ns = Object.fromEntries(customers.not_splits.map((x) => [x.column, x]));
    expect(ns.segment).toMatchObject({ reason: "high_cardinality" });
    const products = Object.fromEntries(table(report, "products").not_splits.map((x) => [x.column, x]));
    expect(products.sku!.reason).toBe("near_unique");
    expect(products.product_name!.reason).toBe("near_unique");
    expect(table(report, "products").unclear).toEqual([]);
    // Joined attributes follow the profile too.
    const orderFields = table(report, "orders").splits.map((s) => s.field);
    expect(orderFields).toContain("customer.country");
    expect(orderFields).not.toContain("customer.segment");
  });

  test("roles and the fan-out warning do not depend on profiles", () => {
    const plain = buildBaseline(snapshot(starTables()), OPTS);
    expect(report.tables.map((t) => [t.table, t.role]).sort()).toEqual(plain.tables.map((t) => [t.table, t.role]).sort());
    expect(table(report, "order_items").relationships.find((r) => r.table === "shop.orders")!.fan_out).toBeDefined();
  });
});

describe("baseline reuses sl draft's column rules", () => {
  test("money, count and time columns agree with draftModels", () => {
    for (const tables of [starTables(), profiledTables()]) {
      const snap = snapshot(tables);
      const report = buildBaseline(snap, OPTS);
      const { models } = draftModels(snap, snap.tables, [], { source: "shop", stripPrefixes: ["fct_", "fact_", "dim_"], knownTables: snap.tables });
      for (const t of report.tables) {
        if (t.role === "noise") continue;
        const draft = models.find((m) => m.table === t.table)!;
        const sums = (ms: { agg?: string; name: string; format?: string }[]) => ms.filter((m) => m.agg === "sum").map((m) => `${m.name}:${m.format}`).sort();
        expect(sums(t.measures)).toEqual(sums(draft.measures));
        // Deletion and history columns are time columns in both; the brief treats them as filters.
        const filters = ["deleted_at", "valid_from", "valid_to"];
        const time = draft.dimensions.filter((d) => d.type === "time" && !filters.includes(d.expr)).map((d) => d.expr).sort();
        expect(t.splits.filter((s) => s.kind === "time" && !s.via).map((s) => s.column).sort()).toEqual(time);
      }
    }
  });
});

describe("existing models sharpen the brief", () => {
  test("a model's grain, key and joins take precedence", () => {
    const model: Model = {
      model: "orders",
      source: "shop",
      table: "shop.orders",
      status: "approved",
      grain: "One row per order placed online.",
      primary_key: ["order_id"],
      dimensions: [],
      measures: [],
      joins: [
        {
          name: "buyer",
          to: "customers",
          keys: [{ from: "customer_id", to: "customer_id" }],
          relationship: "many_to_one",
          status: "approved",
          evidence: {
            checked_at: "2026-01-15T12:00:00.000Z",
            left_rows: 10000,
            left_null_keys: 0,
            matched_rows: 9990,
            match_rate: 0.999,
            right_rows: 2000,
            right_key_unique: true,
            left_key_unique: false,
            max_fanout: 1,
            suggested_relationship: "many_to_one",
          },
        },
      ],
    };
    const customers: Model = { model: "customers", source: "shop", table: "shop.customers", status: "draft", dimensions: [], measures: [] };
    const report = buildBaseline(snapshot(starTables()), { ...OPTS, models: [model, customers] });
    const orders = table(report, "orders");
    expect(orders.model).toEqual({ name: "orders", status: "approved" });
    expect(orders.grain).toEqual({ guess: "one row per order placed online", basis: "the approved model orders" });
    expect(orders.primary_key).toMatchObject({ how: "model", confirmed: true });
    const rel = orders.relationships.find((r) => r.direction === "outgoing" && r.table === "shop.customers")!;
    expect(rel).toMatchObject({ join: "buyer", origin: "model" });
    expect(rel.basis).toContain("99.9% match");
    expect(orders.splits.map((s) => s.field)).toContain("buyer.acquisition_channel");
  });
});

describe("sl baseline", () => {
  async function project(tables: SnapshotTable[], settings?: Record<string, number>): Promise<{ root: string; dir: string }> {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root, "shop");
    writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "SHOP_URL" } });
    writeJson(join(t.root, "snapshots", "shop.json"), snapshot(tables));
    if (settings) updateYaml(join(t.root, "semantic.yaml"), (doc) => doc.set("settings", settings));
    return { root: t.root, dir: t.dir };
  }

  test("prints markdown on stdout and the next step on stderr, reading no database", async () => {
    const { root } = await project(starTables());
    const r = await sl(root, ["baseline", "--source", "shop"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("# Baseline brief: shop");
    expect(r.out).toContain("### shop.order_items: probably a fact");
    expect(r.err).toStartWith("Next: ");
    expect(r.err).toContain("sl profile --source shop --tables");
  });

  test("--json carries the same structure", async () => {
    const { root } = await project(starTables());
    const r = await sl(root, ["baseline", "--source", "shop", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<BaselineReport>();
    expect(j.source).toBe("shop");
    expect(j.tables.map((t) => t.table)).toEqual(buildBaseline(snapshot(starTables()), OPTS).tables.map((t) => t.table));
    expect(Object.keys(j.tables[0]!)).toEqual(
      expect.arrayContaining(["role", "role_reasons", "grain", "primary_key", "relationships", "measures", "splits", "not_splits", "questions", "profile_would_measure"]),
    );
    expect(j.star.facts.length).toBe(3);
    expect(typeof j.next).toBe("string");
  });

  test("--tables limits the brief to the named tables, globs included", async () => {
    const { root } = await project(starTables());
    const r = await sl(root, ["baseline", "--source", "shop", "--tables", "orders,order_*", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<BaselineReport>();
    expect(j.selection).toBe("tables");
    expect(j.tables.map((t) => t.table).sort()).toEqual(["shop.order_items", "shop.orders"]);
    // Joined attributes still read the dimensions outside the brief.
    expect(j.tables.find((t) => t.table === "shop.orders")!.splits.map((s) => s.field)).toContain("customer.acquisition_channel");
    expect(j.star.facts.find((f) => f.table === "shop.orders")!.dimensions[0]).toMatchObject({ table: "shop.customers", in_brief: false });
    const bad = await sl(root, ["baseline", "--source", "shop", "--tables", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('No table matches "nope"');
  });

  test("more tables than focus_threshold: the top ones by rank, with a note pointing at sl scope", async () => {
    const { root } = await project(starTables(), { focus_threshold: 3 });
    const r = await sl(root, ["baseline", "--source", "shop", "--json"]);
    const j = r.json<BaselineReport>();
    expect(j.selection).toBe("focus");
    expect(j.tables).toHaveLength(3);
    expect(j.left_out).toHaveLength(6);
    const note = j.notes.find((n) => n.includes("focus threshold"))!;
    expect(note).toContain("leaves out 6 tables");
    expect(note).toContain("sl scope --source shop");
    // Noise ranks last, so it is left out first.
    expect(j.left_out).toContain("shop.orders_backup_2023");
    const md = await sl(root, ["baseline", "--source", "shop"]);
    expect(md.out).toContain("## Left out (6)");
  });

  test("a source scope limits the brief to in-scope tables", async () => {
    const { root } = await project(starTables());
    updateYaml(join(root, "sources", "shop.yaml"), (doc) => doc.set("scope", { exclude: ["stg_*", "*_backup_*"] }));
    const j = (await sl(root, ["baseline", "--source", "shop", "--json"])).json<BaselineReport>();
    expect(j.in_scope).toBe(7);
    expect(j.tables.map((t) => t.table)).not.toContain("shop.stg_orders");
  });

  test("--out writes the markdown inside the semantic root and never outside it", async () => {
    const { root, dir } = await project(starTables());
    const r = await sl(root, ["baseline", "--source", "shop", "--out", "briefs/baseline.md"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Wrote the baseline brief for shop (9 tables)");
    const written = readFileSync(join(root, "briefs", "baseline.md"), "utf8");
    expect(written).toStartWith("# Baseline brief: shop");

    const j = await sl(root, ["baseline", "--source", "shop", "--out", "b.md", "--json"]);
    expect(j.json<{ written_to: string }>().written_to).toBe(join(root, "b.md"));

    const dirOut = await sl(root, ["baseline", "--source", "shop", "--out", "briefs"]);
    expect(dirOut.code).toBe(1);
    expect(dirOut.err).toContain("is a directory");
    for (const out of ["../outside.md", join(dir, "outside.md"), "/tmp/sl-baseline-outside.md", "."]) {
      const bad = await sl(root, ["baseline", "--source", "shop", "--out", out]);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("outside the semantic root");
    }
    expect(existsSync(join(dir, "outside.md"))).toBe(false);

    // An existing brief is overwritten; anything else is not.
    expect((await sl(root, ["baseline", "--source", "shop", "--out", "briefs/baseline.md"])).code).toBe(0);
    writeFileSync(join(root, "notes.md"), "my notes\n");
    const notBrief = await sl(root, ["baseline", "--source", "shop", "--out", "notes.md"]);
    expect(notBrief.code).toBe(1);
    expect(notBrief.err).toContain("not a baseline brief");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("my notes\n");

    const empty = await sl(root, ["baseline", "--source", "shop", "--out", ""]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("--out needs a file path");
    const underFile = await sl(root, ["baseline", "--source", "shop", "--out", "notes.md/x.md"]);
    expect(underFile.code).toBe(1);
    expect(underFile.err).toContain("is a file, not a directory");

    const elsewhere = mkdtempSync(join(tmpdir(), "sl-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(root, "linked"));
      const viaLink = await sl(root, ["baseline", "--source", "shop", "--out", "linked/brief.md"]);
      expect(viaLink.code).toBe(1);
      expect(viaLink.err).toContain("through a link");
      expect(existsSync(join(elsewhere, "brief.md"))).toBe(false);
      mkdirSync(join(root, "deep"), { recursive: true });
      symlinkSync(join(elsewhere, "target.md"), join(root, "deep", "file.md"));
      const fileLink = await sl(root, ["baseline", "--source", "shop", "--out", "deep/file.md"]);
      expect(fileLink.code).toBe(1);
      expect(fileLink.err).toContain("symbolic link");
      expect(existsSync(join(elsewhere, "target.md"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("--out never overwrites the project's own files", async () => {
    const { root } = await project(starTables());
    const snapPath = join(root, "snapshots", "shop.json");
    const before = readFileSync(snapPath, "utf8");
    const projectBefore = readFileSync(join(root, "semantic.yaml"), "utf8");
    const bad = await sl(root, ["baseline", "--source", "shop", "--out", "snapshots/shop.json"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("snapshots/ directory");
    expect(readFileSync(snapPath, "utf8")).toBe(before);
    for (const out of ["semantic.yaml", "access.yaml", "metrics.yaml", "sources/shop.yaml", "sources/brief.md", "models/shop/brief.md", "goldens/brief.md", "snapshots/new.md", "./Semantic.yaml"]) {
      const r = await sl(root, ["baseline", "--source", "shop", "--out", out]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/project's own files|directory, which sl manages/);
    }
    const underProject = await sl(root, ["baseline", "--source", "shop", "--out", "semantic.yaml/x.md"]);
    expect(underProject.code).toBe(1);
    expect(underProject.err).not.toContain("unexpected error");
    expect(readFileSync(join(root, "semantic.yaml"), "utf8")).toBe(projectBefore);
    // The project still loads.
    expect((await sl(root, ["baseline", "--source", "shop", "--json"])).code).toBe(0);
  });

  test("works from the snapshot alone, without a source file", async () => {
    const { root } = await project(starTables());
    rmSync(join(root, "sources", "shop.yaml"));
    const r = await sl(root, ["baseline", "--source", "shop", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<BaselineReport>().tables).toHaveLength(9);
  });

  test("an empty scope reports no tables", async () => {
    const { root } = await project(starTables());
    updateYaml(join(root, "sources", "shop.yaml"), (doc) => doc.set("scope", { include: ["nothing_*"] }));
    const r = await sl(root, ["baseline", "--source", "shop", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<BaselineReport>();
    expect(j.tables).toEqual([]);
    expect(j.profile_command).toBeNull();
  });

  test("needs a snapshot", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root, "shop");
    const r = await sl(t.root, ["baseline", "--source", "shop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No snapshot");
  });
});

// The synthetic Acme warehouse, introspected live: the database is the PG_URL server's acme database.
const ACME_URL = process.env.ACME_URL ?? (PG_URL ? PG_URL.replace(/\/postgres(\?|$)/, "/acme$1") : undefined);

describe("sl baseline on the live Acme warehouse", () => {
  test.skipIf(!ACME_URL)("reads sensibly from an introspected snapshot", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root, "acme");
    const env = { ACME_URL };
    expect((await sl(t.root, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", "ACME_URL"], env)).code).toBe(0);
    const intro = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "acme"], env);
    expect(intro.code).toBe(0);
    const r = await sl(t.root, ["baseline", "--source", "wh", "--tables", "fct_*,dim_*,audit_log,sales_team_closure", "--json"], env);
    expect(r.code).toBe(0);
    const j = r.json<BaselineReport>();
    const get = (name: string) => j.tables.find((x) => x.table === `acme.${name}`)!;
    expect(get("fct_orders").role).toBe("fact");
    expect(get("fct_orders").grain.guess).toBe("one row per order");
    expect(get("fct_orders_v2_test").role).toBe("noise");
    expect(get("dim_customers_archive").role).toBe("noise");
    expect(get("sales_team_closure").role).toBe("bridge");
    expect(get("audit_log").role).toBe("event");
    expect(get("dim_customers").role).toBe("dimension");
    expect(get("fct_order_items").relationships.find((x) => x.table === "acme.fct_orders")!.fan_out).toContain("many side of acme.fct_orders");
    expect(get("fct_refunds").relationships.find((x) => x.table === "acme.fct_orders")!.fan_out).toBeDefined();
    expect(get("fct_orders").splits.map((s) => s.field)).toContain("customer.acquisition_channel");
    expect(get("fct_orders").measures.find((m) => m.kind === "ratio")!.description).toContain("average order value");
    expect(get("fct_orders").not_splits.find((n) => n.column === "gift_message")!.reason).toBe("sensitive");
    expect(get("dim_customers").questions.map((q) => q.topic)).toContain("exclusions");
    const md = await sl(t.root, ["baseline", "--source", "wh", "--tables", "fct_*,dim_*"], env);
    expect(md.out).toContain("- **acme.fct_orders** (fact, one row per order) joins");
  });
});

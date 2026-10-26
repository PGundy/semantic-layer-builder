import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftModels, inferPrimaryKey, singular } from "../skills/semantic-layer/scripts/lib/draft.ts";
import type { ColumnProfile, Snapshot, SnapshotColumn, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { SQL } from "bun";
import { initProject, PG_URL, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function col(name: string, type: string, profile?: ColumnProfile, description?: string): SnapshotColumn {
  const c: SnapshotColumn = { name, type };
  if (profile) c.profile = profile;
  if (description) c.description = description;
  return c;
}
const p = (distinct: number, null_fraction = 0): ColumnProfile => ({ distinct_count: distinct, null_fraction });

const FCT_ORDERS: SnapshotTable = {
  schema: "analytics",
  name: "fct_orders",
  kind: "table",
  row_count: 1000,
  description: "Customer orders.",
  primary_key: ["order_id"],
  foreign_keys: [{ columns: ["customer_id"], references: { schema: "analytics", table: "dim_customers", columns: ["customer_id"] } }],
  profiled_at: "2026-01-15T12:00:00.000Z",
  columns: [
    col("order_id", "integer", p(1000)),
    col("customer_id", "integer", p(200)),
    col("product_id", "integer", p(50)),
    col("store_id", "integer", p(10)),
    col("status", "varchar", p(4), "Order lifecycle state."),
    col("ordered_at", "timestamp", p(1000)),
    col("ship_date", "date", p(300, 0.1)),
    col("is_gift", "boolean", p(2)),
    col("amount_cents", "bigint", p(900), "Order value in cents."),
    col("discount", "decimal(10,2)", p(40)),
    col("item_qty", "integer", p(12)),
    col("weight_kg", "double", p(800)),
    col("priority", "integer", p(3)),
    col("tracking_code", "varchar", p(990)),
    col("shipping_zip", "varchar", p(80)),
    col("payload", "json"),
  ],
};

const DIM_CUSTOMERS: SnapshotTable = {
  schema: "analytics",
  name: "dim_customers",
  kind: "table",
  row_count: 200,
  columns: [
    col("customer_id", "integer", p(200)),
    col("email", "varchar", p(200)),
    col("first_name", "varchar", p(150)),
    col("zip_code", "varchar", p(80)),
    col("created_at", "timestamp", p(200)),
  ],
};

const DIM_PRODUCTS: SnapshotTable = {
  schema: "analytics",
  name: "dim_products",
  kind: "table",
  row_count: 50,
  primary_key: ["id"],
  columns: [col("id", "integer", p(50)), col("name", "varchar", p(50)), col("category", "varchar", p(6))],
};

const SALES_ORDERS: SnapshotTable = {
  schema: "sales",
  name: "orders",
  kind: "table",
  row_count: 10,
  columns: [col("id", "integer", p(10)), col("total", "decimal(12,2)", p(10))],
};

const WEB_EVENTS: SnapshotTable = {
  schema: "analytics",
  name: "web_events",
  kind: "table",
  row_count: 100,
  columns: [col("session_id", "varchar", p(30, 0.2)), col("event_name", "varchar", p(5))],
};

const OPS_STORES: SnapshotTable = {
  schema: "ops",
  name: "stores",
  kind: "table",
  row_count: 10,
  primary_key: ["store_id"],
  columns: [col("store_id", "integer"), col("city", "varchar")],
};

const FCT_PAYMENTS: SnapshotTable = {
  schema: "analytics",
  name: "fct_payments",
  kind: "table",
  row_count: 500,
  unique_keys: [["payment_ref"]],
  foreign_keys: [{ columns: ["warehouse_id"], references: { schema: "ops", table: "warehouses", columns: ["warehouse_id"] } }],
  columns: [
    col("payment_ref", "varchar", p(500)),
    col("order_id", "integer", p(480)),
    col("customer_id", "integer", p(190)),
    col("warehouse_id", "integer", p(3)),
    col("fee_pennies", "integer", p(30)),
    col("tax_rate", "double", p(40)),
  ],
};

const OPS_WAREHOUSES: SnapshotTable = {
  schema: "ops",
  name: "warehouses",
  kind: "table",
  row_count: 3,
  primary_key: ["warehouse_id"],
  columns: [col("warehouse_id", "integer"), col("name", "varchar")],
};

const TABLES = [FCT_ORDERS, FCT_PAYMENTS, DIM_CUSTOMERS, DIM_PRODUCTS, SALES_ORDERS, WEB_EVENTS, OPS_STORES, OPS_WAREHOUSES];

function snapshotOf(tables: SnapshotTable[]): Snapshot {
  return { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "manual", tables };
}

async function setup(tables = TABLES, scope: SourceConfig["scope"] = { include: ["analytics.*"] }) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const source: SourceConfig = { source: "wh", dialect: "duckdb", connection: { database: ":memory:" }, scope };
  writeYaml(join(t.root, "sources", "wh.yaml"), source);
  writeJson(join(t.root, "snapshots", "wh.json"), snapshotOf(tables));
  return t.root;
}


function modelPath(root: string, name: string): string {
  return join(root, "models", "wh", `${name}.yaml`);
}
function readModel(root: string, name: string): string {
  return readFileSync(modelPath(root, name), "utf8");
}

interface DraftJson {
  source: string;
  drafted: { model: string; table: string; path: string; dimensions: number; measures: number; joins: number; open_questions: number }[];
  skipped: { table: string; reason: string }[];
}

const ORDERS_YAML = `model: orders
source: wh
table: analytics.fct_orders
status: draft
description: Customer orders.
primary_key:
  - order_id
open_questions:
  - What does one row of analytics.fct_orders represent?
  - store_id looks like a key to ops.stores, which is out of scope and has no model. Bring it into scope to draft this join?
  - tracking_code has a different value on nearly every row and was left out as a dimension. Should it be one?
  - "Is amount_cents stored in cents? The draft sums it as stored; divide by 100 (expr: amount_cents / 100.0) to report whole currency units?"
  - Which currency are amount_cents and discount in?
  - shipping_zip looks like personal data and is tagged pii. Who may see it?
dimensions:
  - name: status
    expr: status
    type: string
    description: Order lifecycle state.
    status: draft
  - name: ordered_at
    expr: ordered_at
    type: time
    time_grains:
      - hour
      - day
      - week
      - month
      - quarter
      - year
    status: draft
  - name: ship_date
    expr: ship_date
    type: time
    time_grains:
      - day
      - week
      - month
      - quarter
      - year
    status: draft
  - name: is_gift
    expr: is_gift
    type: boolean
    status: draft
  - name: priority
    expr: priority
    type: number
    status: draft
  - name: shipping_zip
    expr: shipping_zip
    type: string
    tags:
      - pii
    status: draft
measures:
  - name: order_count
    agg: count
    format: integer
    status: draft
  - name: customer_count
    expr: customer_id
    agg: count_distinct
    format: integer
    status: draft
  - name: product_count
    expr: product_id
    agg: count_distinct
    format: integer
    status: draft
  - name: store_count
    expr: store_id
    agg: count_distinct
    format: integer
    status: draft
  - name: amount_cents
    expr: amount_cents
    agg: sum
    format: currency
    description: Order value in cents.
    status: draft
  - name: discount
    expr: discount
    agg: sum
    format: currency
    status: draft
  - name: item_qty
    expr: item_qty
    agg: sum
    format: integer
    status: draft
  - name: avg_weight_kg
    expr: weight_kg
    agg: avg
    format: number
    status: draft
joins:
  - name: customer
    to: customers
    keys:
      - from: customer_id
        to: customer_id
    relationship: many_to_one
    type: left
    origin: declared
    status: draft
  - name: product
    to: products
    keys:
      - from: product_id
        to: id
    relationship: many_to_one
    type: left
    origin: inferred
    status: draft
`;

describe("draft command", () => {
  test("writes the exact model for a rich table, with strip prefixes", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<DraftJson>();
    expect(out.source).toBe("wh");
    expect(out.skipped).toEqual([]);
    expect(out.drafted.map((d) => d.model).sort()).toEqual(["customers", "orders", "payments", "products", "web_events"]);
    const orders = out.drafted.find((d) => d.model === "orders")!;
    expect(orders).toEqual({
      model: "orders",
      table: "analytics.fct_orders",
      path: modelPath(root, "orders"),
      dimensions: 6,
      measures: 8,
      joins: 2,
      open_questions: 6,
    });
    expect(readModel(root, "orders")).toBe(ORDERS_YAML);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ errors: number }>().errors).toBe(0);
  });

  test("without strip prefixes, names follow the table names and joins follow them", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--json"]);
    expect(r.json<DraftJson>().drafted.map((d) => d.model).sort()).toEqual([
      "dim_customers",
      "dim_products",
      "fct_orders",
      "fct_payments",
      "web_events",
    ]);
    const yaml = readModel(root, "fct_orders");
    expect(yaml).toContain("  - name: dim_customer\n    to: dim_customers\n");
    expect(yaml).toContain("  - name: dim_product\n    to: dim_products\n");
    expect(yaml).toContain("  - name: fct_order_count\n    agg: count\n");
  });

  test("keys: unique key, inferred by naming, inferred joins, cents and out-of-scope declared target", async () => {
    const root = await setup();
    await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_"]);
    const payments = readModel(root, "payments");
    expect(payments).toContain("primary_key:\n  - payment_ref\n");
    expect(payments).toContain("primary_key [payment_ref] is the table's only unique key");
    // order_id and customer_id have no declared key; both joins come from naming.
    expect(payments).toContain(
      "  - name: order\n    to: orders\n    keys:\n      - from: order_id\n        to: order_id\n    relationship: many_to_one\n    type: left\n    origin: inferred\n",
    );
    expect(payments).toContain("  - name: customer\n    to: customers\n    keys:\n      - from: customer_id\n        to: customer_id\n");
    expect(payments).toContain("warehouse_id references ops.warehouses, which is out of scope and has no model.");
    expect(payments).not.toContain("to: warehouses");
    expect(payments).toContain("Is fee_pennies stored in cents?");
    // A rate is averaged, never summed, even though its name holds "tax".
    expect(payments).toContain("  - name: avg_tax_rate\n    expr: tax_rate\n    agg: avg\n    format: number\n");

    const customers = readModel(root, "customers");
    expect(customers).toContain("primary_key:\n  - customer_id\n");
    expect(customers).toContain("primary_key [customer_id] was inferred from the column name and the profile");

    const events = readModel(root, "web_events");
    expect(events).not.toContain("primary_key:");
    expect(events).toContain("Which column or columns identify one row of analytics.web_events?");
    expect(events).toContain("open_questions:\n  - What does one row of analytics.web_events represent?\n");
  });

  test("pii columns are tagged and near-unique strings are left out", async () => {
    const root = await setup();
    await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_"]);
    const customers = readModel(root, "customers");
    expect(customers).toContain("  - name: first_name\n    expr: first_name\n    type: string\n    tags:\n      - pii\n");
    expect(customers).toContain("  - name: zip_code\n    expr: zip_code\n    type: string\n    tags:\n      - pii\n");
    expect(customers).not.toContain("name: email");
    // email is left out, so it is not reported as tagged; the near-unique question says it is personal data.
    expect(customers).toContain(
      "email has a different value on nearly every row and was left out as a dimension. Should it be one? email looks like personal data; tag it pii if it is added.",
    );
    expect(customers).toContain("  - first_name and zip_code look like personal data and are tagged pii. Who may see them?\n");
    const products = readModel(root, "products");
    expect(products).not.toContain("name: name\n");
    expect(products).toContain("  - name: category\n");
  });

  test("name collisions use the schema, with other drafted and existing models", async () => {
    const root = await setup(TABLES, { include: ["analytics.*", "sales.*"] });
    writeYaml(modelPath(root, "customers"), {
      model: "customers",
      source: "wh",
      table: "analytics.web_events",
      status: "draft",
      dimensions: [],
      measures: [],
    });
    const r = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--json"]);
    const out = r.json<DraftJson>();
    const names = out.drafted.map((d) => `${d.model}=${d.table}`).sort();
    expect(names).toEqual([
      "analytics_customers=analytics.dim_customers",
      "analytics_orders=analytics.fct_orders",
      "payments=analytics.fct_payments",
      "products=analytics.dim_products",
      "sales_orders=sales.orders",
    ]);
    expect(out.skipped).toEqual([{ table: "analytics.web_events", reason: "already modeled as customers" }]);
    const orders = readModel(root, "analytics_orders");
    expect(orders).toContain("  - name: analytics_customer\n    to: analytics_customers\n");
    // fct_orders.order_id is its own key; it never joins the other orders table.
    expect(orders).not.toContain("sales_orders");
    expect(readModel(root, "payments")).toContain("  - name: analytics_order\n    to: analytics_orders\n");
  });

  test("joins name targets that are not drafted in this run but are in scope", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "analytics.fct_orders", "--json"]);
    expect(r.json<DraftJson>().drafted.map((d) => d.model)).toEqual(["orders"]);
    expect(readModel(root, "orders")).toBe(ORDERS_YAML);
    expect(existsSync(modelPath(root, "customers"))).toBe(false);
  });

  test("never overwrites a model and leaves the owner's edits alone", async () => {
    const root = await setup();
    await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "fct_orders"]);
    const edited = `# Owner notes stay.\n${readModel(root, "orders")}`;
    writeFileSync(modelPath(root, "orders"), edited);
    const again = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "fct_orders", "--json"]);
    expect(again.code).toBe(0);
    expect(again.json<DraftJson>()).toEqual({
      source: "wh",
      drafted: [],
      skipped: [{ table: "analytics.fct_orders", reason: "already modeled as orders" }],
    });
    expect(readModel(root, "orders")).toBe(edited);

    // A file whose name a draft would take, holding a model for another table, is never replaced.
    mkdirSync(join(root, "models", "wh"), { recursive: true });
    writeFileSync(modelPath(root, "products"), "model: legacy_products\nsource: wh\ntable: analytics.nowhere\nstatus: draft\ndimensions: []\nmeasures: []\n");
    const third = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "dim_products", "--json"]);
    const out = third.json<DraftJson>();
    expect(out.drafted).toEqual([]);
    expect(out.skipped).toEqual([{ table: "analytics.dim_products", reason: `model file ${modelPath(root, "products")} already exists` }]);
    expect(readModel(root, "products")).toStartWith("model: legacy_products\n");
  });

  test("--tables takes globs, rejects unknown names and skips out-of-scope tables", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--tables", "fct_*,ops.stores", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<DraftJson>();
    expect(out.drafted.map((d) => d.table).sort()).toEqual(["analytics.fct_orders", "analytics.fct_payments"]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.table).toBe("ops.stores");
    expect(out.skipped[0]!.reason).toContain("out of scope");
    const bad = await sl(root, ["draft", "--source", "wh", "--tables", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('No table matches "nope"');
  });

  test("refuses to draft more than the focus threshold without --tables or --force", async () => {
    const many: SnapshotTable[] = Array.from({ length: 15 }, (_, i) => ({
      schema: "lake",
      name: `events_${String.fromCharCode(97 + i)}`,
      kind: "table",
      row_count: 100 + i,
      columns: [col("id", "integer", p(100 + i)), col("kind", "varchar", p(3))],
    }));
    const root = await setup(many, {});
    const refused = await sl(root, ["draft", "--source", "wh"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("15 in-scope tables");
    expect(refused.err).toContain("focus threshold of 12");
    expect(refused.err).toContain("sl tables --source wh --groups");
    expect(refused.err).toContain("sl scope --source wh");
    expect(existsSync(join(root, "models", "wh"))).toBe(false);

    const picked = await sl(root, ["draft", "--source", "wh", "--tables", "events_a,events_b", "--json"]);
    expect(picked.json<DraftJson>().drafted.map((d) => d.model)).toEqual(["events_b", "events_a"]);

    const forced = await sl(root, ["draft", "--source", "wh", "--force", "--json"]);
    expect(forced.code).toBe(0);
    const out = forced.json<DraftJson>();
    expect(out.drafted).toHaveLength(13);
    expect(out.skipped.map((s) => s.reason)).toEqual(["already modeled as events_b", "already modeled as events_a"]);
  });

  test("a later batch without the strip prefixes takes the name an existing join expects", async () => {
    const root = await setup();
    const first = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "analytics.fct_orders"]);
    expect(first.out).toContain(
      "analytics.fct_orders: join customer assumes analytics.dim_customers will be drafted as customers; draft it with the same --strip-prefix fct_,dim_.",
    );
    const second = await sl(root, ["draft", "--source", "wh", "--tables", "analytics.dim_customers,analytics.dim_products"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("analytics.dim_customers is named customers, the model orders.customer already joins to.");
    expect(existsSync(modelPath(root, "customers"))).toBe(true);
    expect(existsSync(modelPath(root, "products"))).toBe(true);
    expect(existsSync(modelPath(root, "dim_customers"))).toBe(false);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ errors: number }>().errors).toBe(0);
  });

  test("a bare --tables name in several schemas asks for the qualified name", async () => {
    const root = await setup(TABLES, { include: ["analytics.*", "sales.*"] });
    const both: SnapshotTable = { ...SALES_ORDERS, schema: "analytics" };
    writeJson(join(root, "snapshots", "wh.json"), snapshotOf([...TABLES, both]));
    const r = await sl(root, ["draft", "--source", "wh", "--tables", "orders"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"orders" is in several schemas (analytics.orders, sales.orders); pass the qualified name.');
  });

  test("when every named table is skipped, the output says nothing was drafted and why", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--tables", "sales.orders"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("Nothing drafted in wh.\n");
    expect(r.out).toContain("sales.orders: out of scope");
    expect(r.out).not.toContain("already has a model");
  });

  test("human output lists each drafted model with its counts", async () => {
    const root = await setup();
    const r = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "fct_orders"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Drafted 1 model in wh:");
    expect(r.out).toMatch(/orders\s+analytics\.fct_orders\s+6\s+8\s+2\s+6/);
    expect(r.out).toContain("left out payload (type json)");
  });
});

describe("draftModels", () => {
  const known = [EMPLOYEES()];
  function EMPLOYEES(): SnapshotTable {
    return {
      schema: null,
      name: "Employees",
      kind: "table",
      row_count: 60,
      primary_key: ["EMP_ID"],
      foreign_keys: [{ columns: ["MANAGER_ID"], references: { table: "Employees", columns: ["EMP_ID"] } }],
      columns: [
        col("EMP_ID", "NUMBER(38,0)", p(60)),
        col("MANAGER_ID", "NUMBER(38,0)", p(8)),
        col("Order", "VARCHAR", p(5)),
        col("SalaryAmount", "NUMBER(12,2)", p(55)),
        col("bonus", "NUMBER(12,2)", p(5)),
        col("CURRENT_DATE", "DATE", p(40)),
      ],
    };
  }

  test("self joins, quoted identifiers and the shared namespace", () => {
    const snap: Snapshot = { ...snapshotOf(known), dialect: "snowflake" };
    const { models } = draftModels(snap, known, [], { source: "hr", stripPrefixes: [], knownTables: known });
    const m = models[0]!;
    expect(m.model).toBe("employees");
    expect(m.table).toBe("Employees");
    expect(m.primary_key).toEqual(["EMP_ID"]);
    expect(m.joins).toEqual([
      {
        name: "manager",
        to: "employees",
        keys: [{ from: "MANAGER_ID", to: "EMP_ID" }],
        relationship: "many_to_one",
        type: "left",
        origin: "declared",
        status: "draft",
      },
    ]);
    // Snowflake folds bare names to uppercase: uppercase names stay bare, others and keywords are quoted.
    expect(m.dimensions.map((d) => [d.name, d.expr])).toEqual([
      ["order", '"Order"'],
      ["bonus", '"bonus"'],
      ["current_date", '"CURRENT_DATE"'],
    ]);
    expect(m.measures.map((x) => [x.name, x.expr, x.agg])).toEqual([
      ["employee_count", undefined, "count"],
      ["manager_count", "MANAGER_ID", "count_distinct"],
      ["salary_amount", '"SalaryAmount"', "sum"],
    ]);
  });

  test("inferPrimaryKey and singular", () => {
    const t: SnapshotTable = {
      schema: "s",
      name: "dim_categories",
      kind: "table",
      row_count: 5,
      columns: [col("category_id", "integer", p(5)), col("label", "varchar", p(5))],
    };
    expect(inferPrimaryKey(t, [])).toEqual({ columns: ["category_id"], how: "naming" });
    expect(inferPrimaryKey({ ...t, columns: [col("category_id", "integer", p(5, 0.2))] }, [])).toBeNull();
    expect(inferPrimaryKey({ ...t, columns: [col("category_id", "integer", p(4))] }, [])).toBeNull();
    expect(inferPrimaryKey({ ...t, unique_keys: [["label"]] }, [])).toEqual({ columns: ["label"], how: "unique" });
    expect(singular("order_items")).toBe("order_item");
    expect(singular("categories")).toBe("category");
    expect(singular("addresses")).toBe("address");
    expect(singular("status")).toBe("status");
    expect(singular("order_statuses")).toBe("order_status");
    expect(singular("warehouses")).toBe("warehouse");
    expect(singular("series")).toBe("series");
    expect(singular("species")).toBe("species");
    expect(singular("buses")).toBe("bus");
    expect(singular("tv_series")).toBe("tv_series");
    expect(singular("purchases")).toBe("purchase");
  });

  function draftOneTable(dialect: Snapshot["dialect"], table: SnapshotTable) {
    const snap: Snapshot = { ...snapshotOf([table]), dialect };
    return draftModels(snap, [table], [], { source: "wh", stripPrefixes: [], knownTables: [table] });
  }

  test("numeric name rules match whole words", () => {
    const t: SnapshotTable = {
      schema: "s",
      name: "sessions",
      kind: "table",
      row_count: 1000,
      columns: [
        col("duration", "integer", p(500)),
        col("duration_seconds", "integer", p(500)),
        col("total_minutes", "integer", p(500)),
        col("generated_value", "decimal(10,2)", p(500)),
        col("migrated_amount", "decimal(10,2)", p(500)),
        col("subtotal", "decimal(10,2)", p(500)),
        col("conversion_rate", "double", p(500)),
        col("ratio_pct", "double", p(500)),
        col("country_code", "integer", p(150)),
        col("account_number", "bigint", p(900)),
        col("page_count", "integer", p(90)),
      ],
    };
    const m = draftOneTable("duckdb", t).models[0]!;
    expect(m.measures.map((x) => `${x.name}:${x.agg}:${x.format}`)).toEqual([
      "session_count:count:integer",
      "duration:sum:number",
      "duration_seconds:sum:number",
      "total_minutes:sum:number",
      "generated_value:sum:currency",
      "migrated_amount:sum:currency",
      "subtotal:sum:currency",
      "avg_conversion_rate:avg:number",
      "avg_ratio_pct:avg:number",
      "avg_country_code:avg:number",
      "avg_account_number:avg:number",
      "page_count:sum:integer",
    ]);
    expect(m.open_questions).toContain("Which currency are generated_value, migrated_amount and subtotal in?");
  });

  test("a sampled or approximate profile still infers an id key", () => {
    const snowflakeTable: SnapshotTable = {
      schema: "PUBLIC",
      name: "ACCOUNTS",
      kind: "table",
      row_count: 100000,
      columns: [col("ID", "NUMBER(38,0)", p(99870)), col("PLAN", "VARCHAR", p(4))],
    };
    const { models, notes } = draftOneTable("snowflake", snowflakeTable);
    expect(models[0]!.primary_key).toEqual(["ID"]);
    expect(models[0]!.open_questions!.some((q) => q.startsWith("primary_key [ID] was inferred"))).toBe(true);
    expect(notes.join("\n")).not.toContain("left out ID");

    const sampled: SnapshotTable = {
      schema: "s",
      name: "accounts",
      kind: "table",
      row_count: 100000,
      columns: [col("account_id", "integer", { distinct_count: 99500, null_fraction: 0, sampled: true }), col("plan", "varchar", p(4))],
    };
    expect(inferPrimaryKey(sampled, [], "duckdb")).toEqual({ columns: ["account_id"], how: "naming" });
    // An exact duckdb count must match the row count.
    expect(inferPrimaryKey({ ...sampled, columns: [col("account_id", "integer", p(99500))] }, [], "duckdb")).toBeNull();
  });

  // Column names that are keywords or built-in values in Postgres or DuckDB.
  const KEYWORD_COLUMNS = ["returning", "similar", "binary", "verbose", "analyse", "localtime", "current_schema", "current_date", "qualify", "pivot", "user", "plain"];

  function keywordTable(schema: string): SnapshotTable {
    return {
      schema,
      name: "kw",
      kind: "table",
      row_count: 2,
      columns: KEYWORD_COLUMNS.map((c) => col(c, "integer", p(2))),
    };
  }

  // Every column expression the draft wrote, with the column it must read.
  function columnExprs(m: ReturnType<typeof draftOneTable>["models"][number]): [string, string][] {
    const out: [string, string][] = [];
    for (const d of m.dimensions) out.push([d.name, d.expr!]);
    for (const x of m.measures) if (x.expr) out.push([x.name, x.expr]);
    return out;
  }

  test("drafted expressions read keyword-named columns on DuckDB", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    await c.run(`create schema kwtest`);
    await c.run(`create table kwtest.kw (${KEYWORD_COLUMNS.map((k) => `"${k}" integer`).join(", ")})`);
    await c.run(`insert into kwtest.kw values (${KEYWORD_COLUMNS.map((_, i) => i + 1).join(", ")})`);
    const m = draftOneTable("duckdb", keywordTable("kwtest")).models[0]!;
    const exprs = columnExprs(m);
    expect(exprs).toHaveLength(KEYWORD_COLUMNS.length);
    expect(exprs.find(([n]) => n === "plain")![1]).toBe("plain");
    for (const [name, expr] of exprs) {
      const rows = (await (await c.runAndReadAll(`select ${expr} as v from kwtest.kw`)).getRowObjects()) as { v: unknown }[];
      expect([name, Number(rows[0]!.v)]).toEqual([name, KEYWORD_COLUMNS.indexOf(name) + 1]);
    }
    c.closeSync();
    db.closeSync();
  });

  test.skipIf(!PG_URL)("drafted expressions read keyword-named columns on Postgres", async () => {
    const sql = new SQL(PG_URL!);
    try {
      await sql.unsafe(`drop schema if exists t_draft cascade; create schema t_draft`);
      await sql.unsafe(`create table t_draft.kw (${KEYWORD_COLUMNS.map((k) => `"${k}" integer`).join(", ")})`);
      await sql.unsafe(`insert into t_draft.kw values (${KEYWORD_COLUMNS.map((_, i) => i + 1).join(", ")})`);
      const m = draftOneTable("postgres", keywordTable("t_draft")).models[0]!;
      for (const [name, expr] of columnExprs(m)) {
        const rows = (await sql.unsafe(`select ${expr} as v from t_draft.kw`)) as { v: unknown }[];
        expect([name, Number(rows[0]!.v)]).toEqual([name, KEYWORD_COLUMNS.indexOf(name) + 1]);
      }
    } finally {
      await sql.unsafe(`drop schema if exists t_draft cascade`);
      await sql.close();
    }
  });

});

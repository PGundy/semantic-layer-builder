import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { centsExpr, draftModels, inferPrimaryKey, numericRule, singular } from "../skills/semantic-layer/scripts/lib/draft.ts";
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
  - "Is amount_cents stored in cents? The draft divides it by 100 (expr: amount_cents * 0.01) to report whole currency units; confirm the division."
  - The name weight_kg does not say how it adds up, so the draft averages it (avg_weight_kg). Do people total weight_kg or average it?
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
  - name: amount
    expr: amount_cents * 0.01
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
      open_questions: 7,
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
    expect(payments).toContain("Is fee_pennies stored in cents? The draft divides it by 100 (expr: fee_pennies * 0.01)");
    expect(payments).toContain("  - name: fee\n    expr: fee_pennies * 0.01\n    agg: sum\n    format: currency\n");
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

  test("--strip-prefix is saved in the source and reused by later drafts", async () => {
    const root = await setup();
    await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--tables", "analytics.fct_orders"]);
    expect(readFileSync(join(root, "sources", "wh.yaml"), "utf8")).toContain("draft:\n  strip_prefixes:\n    - fct_\n    - dim_\n");
    const later = await sl(root, ["draft", "--source", "wh", "--tables", "analytics.dim_customers", "--json"]);
    expect(later.json<DraftJson>().drafted.map((d) => d.model)).toEqual(["customers"]);
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
    expect(r.out).toMatch(/orders\s+analytics\.fct_orders\s+6\s+8\s+2\s+7/);
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

  test("additive count nouns are summed as integers", () => {
    const rule = (n: string) => {
      const r = numericRule(n);
      return r ? `${r.agg}:${r.format}` : null;
    };
    for (const n of [
      "impressions",
      "clicks",
      "views",
      "visits",
      "sessions",
      "signups",
      "conversions",
      "installs",
      "opens",
      "events",
      "pageviews",
      "sends",
      "page_views",
      "email_opens",
      "ad_clicks",
      "clicks_total",
      "impressions_served",
    ]) {
      expect(rule(n)).toBe("sum:integer");
    }
    // A ratio, a rate or a name with the noun inside is not an additive count.
    expect(rule("clicks_per_session")).toBeNull();
    expect(rule("conversions_pct")).toBeNull();
    // A name ending _rate stays a per-unit rate.
    expect(rule("conversions_rate")).toBe("avg:number");
    expect(rule("unique_page_views_ratio")).toBeNull();
    expect(rule("session")).toBeNull();
    expect(rule("previews_shown")).toBeNull();
    // A statistic or share of a count does not add up across rows, so no rule picks it.
    for (const n of ["avg_clicks", "average_sessions", "mean_views", "median_pageviews", "max_views", "min_clicks", "p50_views", "views_avg", "impressions_share"]) {
      expect(rule(n)).toBeNull();
    }
    // A name starting with a count noun that names money or a duration keeps its unit.
    expect(rule("conversions_value_cents")).toBe("sum:currency");
    expect(rule("conversions_revenue_cents")).toBe("sum:currency");
    expect(rule("impressions_spend_cents")).toBe("sum:currency");
    expect(rule("installs_revenue")).toBe("sum:currency");
    expect(rule("clicks_cost")).toBe("sum:currency");
    expect(rule("sessions_duration_seconds")).toBe("sum:number");
    expect(rule("events_minutes")).toBe("sum:number");

    const t: SnapshotTable = {
      schema: "s",
      name: "ad_stats",
      kind: "table",
      row_count: 1000,
      columns: [
        col("id", "integer", p(1000)),
        col("impressions", "bigint", p(900)),
        col("clicks", "integer", p(12)),
        col("page_views", "integer", p(500)),
        col("bounce_score", "double", p(700)),
        col("dwell", "double", p(800)),
      ],
    };
    const m = draftOneTable("duckdb", t).models[0]!;
    expect(m.measures.map((x) => `${x.name}:${x.expr ?? ""}:${x.agg}:${x.format}`)).toEqual([
      "ad_stat_count::count:integer",
      "impressions:impressions:sum:integer",
      "clicks:clicks:sum:integer",
      "page_views:page_views:sum:integer",
      "avg_bounce_score:bounce_score:avg:number",
      "avg_dwell:dwell:avg:number",
    ]);
    // Only the averages no name rule chose ask whether people total or average the column.
    expect(m.open_questions).toContain(
      "The name bounce_score does not say how it adds up, so the draft averages it (avg_bounce_score). Do people total bounce_score or average it?",
    );
    expect(m.open_questions).toContain("The name dwell does not say how it adds up, so the draft averages it (avg_dwell). Do people total dwell or average it?");
    expect(m.open_questions!.filter((q) => q.includes("Do people total"))).toHaveLength(2);
    expect(m.dimensions.map((d) => d.name)).toEqual([]);
  });

  test("a count-noun prefix with a money or duration name drafts by its unit", () => {
    const t: SnapshotTable = {
      schema: "s",
      name: "ad_stats",
      kind: "table",
      row_count: 1000,
      columns: [
        col("conversions_value_cents", "bigint", p(900)),
        col("sessions_duration_seconds", "bigint", p(900)),
        col("avg_clicks", "double", p(900)),
      ],
    };
    const m = draftOneTable("duckdb", t).models[0]!;
    expect(m.measures.map((x) => `${x.name}:${x.expr ?? ""}:${x.agg}:${x.format}`)).toEqual([
      "ad_stat_count::count:integer",
      "conversions_value:conversions_value_cents * 0.01:sum:currency",
      "sessions_duration_seconds:sessions_duration_seconds:sum:number",
      "avg_avg_clicks:avg_clicks:avg:number",
    ]);
    expect(m.open_questions!.some((q) => q.startsWith("Is conversions_value_cents stored in cents?"))).toBe(true);
    expect(m.open_questions).toContain(
      "The name avg_clicks does not say how it adds up, so the draft averages it (avg_avg_clicks). Do people total avg_clicks or average it?",
    );
  });

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

describe("draft heuristics on Acme-like tables", () => {
  const usd = (count: number): ColumnProfile => ({ distinct_count: 1, null_fraction: 0, top_values: [{ value: "USD", count }] });
  const ORDERS: SnapshotTable = {
    schema: "acme",
    name: "fct_orders",
    kind: "table",
    row_count: 2500,
    description: "Orders from the storefront, one row per order. Amounts in integer cents.",
    primary_key: ["order_id"],
    foreign_keys: [{ columns: ["customer_id"], references: { schema: "acme", table: "dim_customers", columns: ["customer_id"] } }],
    columns: [
      col("order_id", "integer", p(2500)),
      col("customer_id", "integer", p(400)),
      col("status", "varchar", p(4)),
      col("created_at", "timestamp with time zone", p(2500)),
      col("amount_cents", "bigint", p(2000)),
      col("shipping_cents", "bigint", p(30)),
      col("currency", "varchar", usd(2500)),
    ],
  };
  const ITEMS: SnapshotTable = {
    schema: "acme",
    name: "fct_order_items",
    kind: "table",
    row_count: 6000,
    primary_key: ["order_item_id"],
    columns: [
      col("order_item_id", "integer", p(6000)),
      col("order_id", "integer", p(2500)),
      col("product_id", "integer", p(40)),
      col("quantity", "integer", p(5)),
      col("unit_price_cents", "integer", p(300)),
    ],
  };
  const PRODUCTS: SnapshotTable = {
    schema: "acme",
    name: "dim_products",
    kind: "table",
    row_count: 40,
    primary_key: ["product_id"],
    columns: [col("product_id", "integer", p(40)), col("category", "varchar", p(5)), col("list_price_cents", "integer", p(35))],
  };
  const CUSTOMERS: SnapshotTable = {
    schema: "acme",
    name: "dim_customers",
    kind: "table",
    row_count: 400,
    primary_key: ["customer_id"],
    foreign_keys: [{ columns: ["region_code"], references: { schema: "acme", table: "dim_regions", columns: ["region_code"] } }],
    columns: [col("customer_id", "integer", p(400)), col("region_code", "varchar", p(6)), col("is_test_account", "boolean", p(2))],
  };
  const REGIONS: SnapshotTable = {
    schema: "acme",
    name: "dim_regions",
    kind: "table",
    row_count: 6,
    primary_key: ["region_code"],
    columns: [col("region_code", "varchar", p(6)), col("region_name", "varchar", p(6))],
  };
  const ACME = [ORDERS, ITEMS, PRODUCTS, CUSTOMERS, REGIONS];

  function draftAcme(tables = ACME, dialect: Snapshot["dialect"] = "postgres") {
    const snap: Snapshot = { ...snapshotOf(tables), dialect };
    const { models, notes } = draftModels(snap, tables, [], { source: "warehouse", stripPrefixes: ["fct_", "dim_"], knownTables: tables });
    return { model: (name: string) => models.find((m) => m.model === name)!, notes };
  }

  test("a grain in the table comment is drafted and the first question confirms it", () => {
    const orders = draftAcme().model("orders");
    expect(orders.description).toBe(ORDERS.description!);
    expect(orders.grain).toBe("One row per order.");
    expect(orders.open_questions![0]).toBe("Is one row of acme.fct_orders one order?");
    // Without such a comment the question stays open.
    expect(draftAcme().model("order_items").grain).toBeUndefined();
    expect(draftAcme().model("order_items").open_questions![0]).toBe("What does one row of acme.fct_order_items represent?");
    const items = draftAcme([{ ...ITEMS, description: "One row per line item; prices per unit." }, PRODUCTS]).model("order_items");
    expect(items.grain).toBe("One row per line item.");
    expect(items.open_questions![0]).toBe("Is one row of acme.fct_order_items one line item?");
  });

  test("cents are divided by 100 and a single-valued currency column sets currency", () => {
    const orders = draftAcme().model("orders");
    expect(orders.measures).toEqual([
      { name: "order_count", agg: "count", format: "integer", status: "draft" },
      { name: "customer_count", expr: "customer_id", agg: "count_distinct", format: "integer", status: "draft" },
      { name: "amount", expr: "amount_cents / 100.0", agg: "sum", format: "currency", currency: "USD", status: "draft" },
      { name: "shipping", expr: "shipping_cents / 100.0", agg: "sum", format: "currency", currency: "USD", status: "draft" },
    ]);
    expect(orders.dimensions.map((d) => d.name)).toEqual(["status", "created_at", "currency"]);
    expect(orders.open_questions).toEqual([
      "Is one row of acme.fct_orders one order?",
      "Is amount_cents stored in cents? The draft divides it by 100 (expr: amount_cents / 100.0) to report whole currency units; confirm the division.",
      "Is shipping_cents stored in cents? The draft divides it by 100 (expr: shipping_cents / 100.0) to report whole currency units; confirm the division.",
      "The currency column of acme.fct_orders holds only USD, so amount_cents and shipping_cents are drafted with currency USD. Is every row in USD?",
    ]);
  });

  test("a currency column with several values sets none, and a description saying cents divides an unsuffixed column", () => {
    const mixed: SnapshotTable = {
      ...ORDERS,
      columns: ORDERS.columns.map((c) =>
        c.name === "currency" ? col("currency", "varchar", { distinct_count: 2, top_values: [{ value: "USD", count: 2000 }, { value: "EUR", count: 500 }] }) : c,
      ),
    };
    const orders = draftAcme([mixed, CUSTOMERS, REGIONS]).model("orders");
    expect(orders.measures.every((m) => m.currency === undefined)).toBe(true);
    expect(orders.open_questions).toContain("Which currency are amount_cents and shipping_cents in?");

    const ledger: SnapshotTable = {
      schema: "acme",
      name: "ledger",
      kind: "table",
      row_count: 100,
      description: "Ledger entries.",
      columns: [col("amount", "bigint", p(90), "Entry value in cents."), col("fee", "bigint", p(60))],
    };
    const m = draftAcme([ledger]).model("ledger");
    expect(m.measures.map((x) => [x.name, x.expr, x.format])).toEqual([
      ["ledger_count", undefined, "integer"],
      ["amount", "amount / 100.0", "currency"],
      ["fee", "fee", "currency"],
    ]);
    const centsTable = draftAcme([{ ...ledger, description: "Ledger entries. Amounts in integer cents." }]).model("ledger");
    expect(centsTable.measures.map((x) => x.expr)).toEqual([undefined, "amount / 100.0", "fee / 100.0"]);
  });

  test("a per-unit price is averaged and a quantity column adds a line total", () => {
    const items = draftAcme().model("order_items");
    expect(items.measures).toEqual([
      { name: "order_item_count", agg: "count", format: "integer", status: "draft" },
      { name: "order_count", expr: "order_id", agg: "count_distinct", format: "integer", status: "draft" },
      { name: "product_count", expr: "product_id", agg: "count_distinct", format: "integer", status: "draft" },
      { name: "quantity", expr: "quantity", agg: "sum", format: "integer", status: "draft" },
      { name: "avg_unit_price", expr: "unit_price_cents / 100.0", agg: "avg", format: "currency", status: "draft" },
      { name: "line_total", expr: "quantity * (unit_price_cents / 100.0)", agg: "sum", format: "currency", status: "draft" },
    ]);
    expect(items.open_questions).toContain(
      "unit_price_cents is a per-unit figure, so the draft averages it rather than summing it. Is a line's total quantity times unit_price_cents? The draft adds the measure line_total, the sum of quantity * (unit_price_cents / 100.0).",
    );
    expect(items.open_questions).toContain("Which currency is unit_price_cents in?");

    const products = draftAcme().model("products");
    expect(products.measures).toEqual([
      { name: "product_count", agg: "count", format: "integer", status: "draft" },
      { name: "avg_list_price", expr: "list_price_cents / 100.0", agg: "avg", format: "currency", status: "draft" },
    ]);
    expect(products.open_questions).toContain(
      "list_price_cents is a per-unit figure, so the draft averages it rather than summing. Is an average what people report?",
    );
    expect(products.open_questions!.some((x) => x.includes("line_total"))).toBe(false);
  });

  test("a foreign key count is named after its join and skipped for a small target", () => {
    const { model, notes } = draftAcme();
    const customers = model("customers");
    expect(customers.joins!.map((j) => [j.name, j.to])).toEqual([["region", "regions"]]);
    expect(customers.measures.map((m) => m.name)).toEqual(["customer_count"]);
    expect(notes).toContain("acme.dim_customers: no count of region_code drafted; its join reaches acme.dim_regions, which has 6 rows.");

    const bigRegions = draftAcme([CUSTOMERS, { ...REGIONS, row_count: 21 }]).model("customers");
    expect(bigRegions.measures.map((m) => [m.name, m.expr])).toEqual([
      ["customer_count", undefined],
      ["region_count", "region_code"],
    ]);
  });

  test("numericRule tests money before counts and averages per-unit names", () => {
    const rule = (n: string) => {
      const r = numericRule(n);
      return r ? `${r.agg}:${r.format}${r.perUnit ? ":per_unit" : ""}` : null;
    };
    expect(rule("unit_price_cents")).toBe("avg:currency:per_unit");
    expect(rule("unit_price")).toBe("avg:currency:per_unit");
    expect(rule("price")).toBe("avg:currency:per_unit");
    expect(rule("unit_cost")).toBe("avg:currency:per_unit");
    expect(rule("list_price_cents")).toBe("avg:currency:per_unit");
    expect(rule("hourly_rate")).toBe("avg:number:per_unit");
    expect(rule("tax_rate")).toBe("avg:number:per_unit");
    expect(rule("total_price")).toBe("sum:currency");
    expect(rule("extended_price_cents")).toBe("sum:currency");
    expect(rule("amount_cents")).toBe("sum:currency");
    expect(rule("unit_amount")).toBe("sum:currency");
    expect(rule("payment_count")).toBe("sum:integer");
    expect(rule("total_qty")).toBe("sum:integer");
    expect(rule("units_sold")).toBe("sum:integer");
    expect(rule("quantity")).toBe("sum:integer");
    expect(rule("total_minutes")).toBe("sum:number");
    expect(rule("ratio_pct")).toBeNull();
    expect(rule("weight_kg")).toBeNull();
    // A per-unit money name ending _per_unit is averaged; a singular unit is not a count word.
    expect(rule("price_per_unit")).toBe("avg:currency:per_unit");
    expect(rule("cost_per_unit")).toBe("avg:currency:per_unit");
    expect(rule("revenue_per_unit")).toBe("avg:currency:per_unit");
    expect(rule("cost_per_unit_cents")).toBe("avg:currency:per_unit");
    // A name starting with a count word counts things even when it names money.
    expect(rule("units_refunded")).toBe("sum:integer");
    expect(rule("count_of_refunds")).toBe("sum:integer");
    expect(rule("qty_shipped")).toBe("sum:integer");
    expect(rule("units")).toBe("sum:integer");
  });

  test("a multi-line table comment drafts a grain from its first line only", () => {
    const items = draftAcme([{ ...ITEMS, description: "One row per order line\nBuilt by dbt from raw.order_items." }]).model("order_items");
    expect(items.grain).toBe("One row per order line.");
    expect(items.open_questions![0]).toBe("Is one row of acme.fct_order_items one order line?");
    const bracket = draftAcme([{ ...ITEMS, description: "One row per line item (refunds excluded)." }]).model("order_items");
    expect(bracket.grain).toBe("One row per line item.");
  });

  test("the line total's quantity is an integer count, an exact quantity name first", () => {
    const refunds: SnapshotTable = {
      schema: "acme",
      name: "refund_lines",
      kind: "table",
      row_count: 100,
      columns: [col("id", "integer", p(100)), col("units_refunded", "integer", p(5)), col("quantity", "integer", p(5)), col("unit_price", "decimal(10,2)", p(50))],
    };
    const m = draftAcme([refunds]).model("refund_lines");
    expect(m.measures.map((x) => `${x.name}:${x.expr}:${x.agg}:${x.format}`)).toEqual([
      "refund_line_count:undefined:count:integer",
      "units_refunded:units_refunded:sum:integer",
      "quantity:quantity:sum:integer",
      "avg_unit_price:unit_price:avg:currency",
      "line_total:quantity * unit_price:sum:currency",
    ]);
    expect(m.open_questions).toContain(
      "unit_price is a per-unit figure, so the draft averages it rather than summing it. Is a line's total quantity times unit_price? The draft adds the measure line_total, the sum of quantity * unit_price.",
    );
    // Without an exact quantity name, a count column still serves, and a money column never does.
    const only = draftAcme([{ ...refunds, columns: refunds.columns.filter((c) => c.name !== "quantity") }]).model("refund_lines");
    expect(only.measures.find((x) => x.name === "line_total")?.expr).toBe("units_refunded * unit_price");
    const moneyOnly: SnapshotTable = { ...refunds, columns: [col("id", "integer", p(100)), col("refund_amount", "decimal(10,2)", p(50)), col("unit_price", "decimal(10,2)", p(50))] };
    expect(draftAcme([moneyOnly]).model("refund_lines").measures.some((x) => x.name === "line_total")).toBe(false);
  });

  test("a non-money rate beside a quantity drafts no line total", () => {
    const t: SnapshotTable = {
      schema: "acme",
      name: "tax_lines",
      kind: "table",
      row_count: 100,
      columns: [col("id", "integer", p(100)), col("quantity", "integer", p(5)), col("tax_rate", "double", p(8))],
    };
    const m = draftAcme([t]).model("tax_lines");
    expect(m.measures.map((x) => `${x.name}:${x.agg}:${x.format}`)).toEqual(["tax_line_count:count:integer", "quantity:sum:integer", "avg_tax_rate:avg:number"]);
    expect(m.open_questions!.some((x) => x.includes("line_total") || x.includes("line-total"))).toBe(false);
    expect(m.open_questions).toContain("tax_rate is a per-unit figure, so the draft averages it rather than summing. Is an average what people report?");

    // A second per-unit money column is offered as a line total; a rate beside it is not.
    const both: SnapshotTable = { ...t, columns: [...t.columns, col("unit_price", "decimal(10,2)", p(50)), col("unit_cost", "decimal(10,2)", p(50))] };
    const b = draftAcme([both]).model("tax_lines");
    expect(b.measures.find((x) => x.name === "line_total")?.expr).toBe("quantity * unit_price");
    expect(b.open_questions).toContain("unit_cost is a per-unit figure, so the draft averages it rather than summing. Should quantity times it be a line-total measure too?");
    expect(b.open_questions).toContain("tax_rate is a per-unit figure, so the draft averages it rather than summing. Is an average what people report?");
  });

  test("the column's description decides cents before the table's, and a negation does not divide", () => {
    const ledger = (tableDesc: string, colDesc?: string): SnapshotTable => ({
      schema: "acme",
      name: "ledger",
      kind: "table",
      row_count: 100,
      description: tableDesc,
      columns: [col("amount", "bigint", p(90), colDesc), col("fee", "bigint", p(60))],
    });
    const exprs = (t: SnapshotTable) => draftAcme([t]).model("ledger").measures.map((x) => x.expr);
    expect(exprs(ledger("All amounts are in dollars, not cents."))).toEqual([undefined, "amount", "fee"]);
    expect(exprs(ledger("Amounts in integer cents.", "Entry value in dollars."))).toEqual([undefined, "amount", "fee / 100.0"]);
    expect(exprs(ledger("Amounts in integer cents.", "The entry's posted value."))).toEqual([undefined, "amount / 100.0", "fee / 100.0"]);
    expect(exprs(ledger("Ledger entries.", "Not in cents."))).toEqual([undefined, "amount", "fee"]);
  });

  test("a single currency is trimmed and needs a distinct count of one", () => {
    const withCurrency = (profile: ColumnProfile) => ({
      ...ORDERS,
      columns: ORDERS.columns.map((c) => (c.name === "currency" ? col("currency", "varchar", profile) : c)),
    });
    const trimmed = draftAcme([withCurrency({ distinct_count: 1, top_values: [{ value: " USD ", count: 2500 }] }), CUSTOMERS, REGIONS]).model("orders");
    expect(trimmed.measures.find((m) => m.name === "amount")?.currency).toBe("USD");
    const noDistinct = draftAcme([withCurrency({ top_values: [{ value: "USD", count: 2500 }] }), CUSTOMERS, REGIONS]).model("orders");
    expect(noDistinct.measures.find((m) => m.name === "amount")?.currency).toBe("USD");
    const many = draftAcme([withCurrency({ distinct_count: 3, top_values: [{ value: "USD", count: 2400 }] }), CUSTOMERS, REGIONS]).model("orders");
    expect(many.measures.every((m) => m.currency === undefined)).toBe(true);
  });

  test("the drafted Acme models validate and their expressions run on DuckDB", async () => {
    const root = await setup(ACME, { include: ["acme.*"] });
    const r = await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<DraftJson>().drafted.map((d) => d.model).sort()).toEqual(["customers", "order_items", "orders", "products", "regions"]);
    expect(readModel(root, "orders")).toContain(
      "description: Orders from the storefront, one row per order. Amounts in integer cents.\ngrain: One row per order.\nprimary_key:\n",
    );
    expect(readModel(root, "orders")).toContain("    format: currency\n    currency: USD\n    status: draft\n");
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ errors: number }>().errors).toBe(0);

    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    await c.run("create table items (quantity integer, unit_price_cents integer)");
    await c.run("insert into items values (2, 1999), (1, 500)");
    const items = draftAcme(ACME, "duckdb").model("order_items");
    const line = items.measures.find((m) => m.name === "line_total")!;
    expect(line.expr).toBe("quantity * (unit_price_cents * 0.01)");
    const avg = items.measures.find((m) => m.name === "avg_unit_price")!;
    const rows = (await (await c.runAndReadAll(`select sum(${line.expr}) as line, avg(${avg.expr}) as avg from items`)).getRowObjects()) as {
      line: unknown;
      avg: unknown;
    }[];
    expect(Number(rows[0]!.line)).toBeCloseTo(44.98, 6);
    expect(Number(rows[0]!.avg)).toBeCloseTo(12.495, 6);
    // The divided price is taken in numeric arithmetic, so a large integer line does not overflow.
    await c.run("insert into items values (100, 25000000)");
    const big = (await (await c.runAndReadAll(`select sum(${line.expr}) as line from items`)).getRowObjects()) as { line: unknown }[];
    expect(Number(big[0]!.line)).toBeCloseTo(25000044.98, 4);
    // The DuckDB cents expression is an exact DECIMAL; dividing by 100.0 is a DOUBLE there.
    const cents = centsExpr("duckdb", "unit_price_cents");
    const types = (await (
      await c.runAndReadAll(
        `select typeof(any_value(${cents})) as cents, typeof(any_value(unit_price_cents / 100.0)) as divided, sum(${cents}) = 250024.99 as exact from items`,
      )
    ).getRowObjects()) as { cents: string; divided: string; exact: boolean }[];
    expect(types[0]!.cents).toStartWith("DECIMAL");
    expect(types[0]!.divided).toBe("DOUBLE");
    expect(types[0]!.exact).toBe(true);
    c.closeSync();
    db.closeSync();
  });

  test("the cents expression and its open question follow the dialect", () => {
    expect(centsExpr("duckdb", "amount_cents")).toBe("amount_cents * 0.01");
    expect(centsExpr("bigquery", "amount_cents")).toBe("cast(amount_cents as numeric) / 100");
    expect(centsExpr("postgres", "amount_cents")).toBe("amount_cents / 100.0");
    expect(centsExpr("snowflake", "AMOUNT_CENTS")).toBe("AMOUNT_CENTS / 100.0");
    expect(centsExpr("databricks", "amount_cents")).toBe("amount_cents / 100.0");
    const cases: [Snapshot["dialect"], string, string][] = [
      ["duckdb", "amount_cents * 0.01", "quantity * (unit_price_cents * 0.01)"],
      ["bigquery", "cast(amount_cents as numeric) / 100", "quantity * (cast(unit_price_cents as numeric) / 100)"],
      ["postgres", "amount_cents / 100.0", "quantity * (unit_price_cents / 100.0)"],
      // Snowflake quotes a lowercase name.
      ["snowflake", '"amount_cents" / 100.0', '"quantity" * ("unit_price_cents" / 100.0)'],
      ["databricks", "amount_cents / 100.0", "quantity * (unit_price_cents / 100.0)"],
    ];
    for (const [dialect, amount, line] of cases) {
      const d = draftAcme(ACME, dialect);
      const orders = d.model("orders");
      expect(orders.measures.find((m) => m.name === "amount")!.expr).toBe(amount);
      expect(orders.open_questions).toContain(
        `Is amount_cents stored in cents? The draft divides it by 100 (expr: ${amount}) to report whole currency units; confirm the division.`,
      );
      const items = d.model("order_items");
      expect(items.measures.find((m) => m.name === "line_total")!.expr).toBe(line);
      expect(items.open_questions!.some((q) => q.endsWith(`the sum of ${line}.`))).toBe(true);
    }
    // A quoted column keeps its quoting inside the dialect's expression.
    const ledger: SnapshotTable = {
      schema: "acme",
      name: "ledger",
      kind: "table",
      row_count: 100,
      columns: [col("id", "integer", p(100)), col("Fee_Cents", "bigint", p(60))],
    };
    expect(draftAcme([ledger], "bigquery").model("ledger").measures[1]!.expr).toBe("cast(`Fee_Cents` as numeric) / 100");
    expect(draftAcme([ledger], "duckdb").model("ledger").measures[1]!.expr).toBe('"Fee_Cents" * 0.01');
  });

  test.skipIf(!PG_URL)("the drafted line total runs on Postgres without integer overflow", async () => {
    const sql = new SQL(PG_URL!);
    try {
      await sql.unsafe(`drop schema if exists t_draft_line cascade; create schema t_draft_line`);
      await sql.unsafe(`create table t_draft_line.items (quantity integer, unit_price_cents integer)`);
      await sql.unsafe(`insert into t_draft_line.items values (2, 1999), (1, 500), (100, 25000000)`);
      const line = draftAcme().model("order_items").measures.find((m) => m.name === "line_total")!;
      const rows = (await sql.unsafe(`select sum(${line.expr}) as line from t_draft_line.items`)) as { line: unknown }[];
      expect(Number(rows[0]!.line)).toBeCloseTo(25000044.98, 4);
    } finally {
      await sql.unsafe(`drop schema if exists t_draft_line cascade`);
      await sql.close();
    }
  });
});

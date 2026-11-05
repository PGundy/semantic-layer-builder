import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  centsExpr,
  columnCurrency,
  draftModels,
  draftNewColumns,
  inferPrimaryKey,
  newColumns,
  numericRule,
  singular,
  timestampHasZone,
} from "../skills/semantic-layer/scripts/lib/draft.ts";
import { unreferencedColumns } from "../skills/semantic-layer/scripts/lib/snapshot-diff.ts";
import type { ColumnProfile, Model, Snapshot, SnapshotColumn, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { parseYamlText, updateYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { SQL } from "bun";
import { assertLocalPg, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

// A live test creates and drops only a schema of its own, and only on a local server unless
// SL_TEST_ALLOW_REMOTE=1 allows another (assertLocalPg).
function liveSchema(prefix: string): string {
  assertLocalPg(PG_URL);
  return uniqueSchema(prefix);
}

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
  - ordered_at is a timestamp without a time zone. In which time zone is its value stored? The answer is recorded as time_zone (an IANA zone such as UTC or America/New_York) on its time dimension.
  - Which currency are amount_cents and discount in?
  - shipping_zip looks like personal data and is tagged pii. Who may see it?
ignored_columns:
  - tracking_code
  - payload
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
      open_questions: 8,
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
    expect(r.out).toMatch(/orders\s+analytics\.fct_orders\s+6\s+8\s+2\s+8/);
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
    const schema = liveSchema("t_draft");
    const sql = new SQL(PG_URL!);
    try {
      await sql.unsafe(`create schema ${schema}`);
      await sql.unsafe(`create table ${schema}.kw (${KEYWORD_COLUMNS.map((k) => `"${k}" integer`).join(", ")})`);
      await sql.unsafe(`insert into ${schema}.kw values (${KEYWORD_COLUMNS.map((_, i) => i + 1).join(", ")})`);
      const m = draftOneTable("postgres", keywordTable(schema)).models[0]!;
      for (const [name, expr] of columnExprs(m)) {
        const rows = (await sql.unsafe(`select ${expr} as v from ${schema}.kw`)) as { v: unknown }[];
        expect([name, Number(rows[0]!.v)]).toEqual([name, KEYWORD_COLUMNS.indexOf(name) + 1]);
      }
    } finally {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
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

  test("a redacted currency column never becomes a currency code", () => {
    const redacted: SnapshotTable = {
      ...ORDERS,
      columns: ORDERS.columns.map((c) =>
        c.name === "currency" ? { ...c, profile: { distinct_count: 1, null_fraction: 0, top_values: [{ value: "sha256:0123456789abcdef", count: 2500 }], redacted: true } } : c,
      ),
    };
    const orders = draftAcme([redacted, ITEMS, PRODUCTS, CUSTOMERS, REGIONS]).model("orders");
    for (const m of orders.measures) expect(m.currency).toBeUndefined();
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
    const schema = liveSchema("t_draft_line");
    const sql = new SQL(PG_URL!);
    try {
      await sql.unsafe(`create schema ${schema}`);
      await sql.unsafe(`create table ${schema}.items (quantity integer, unit_price_cents integer)`);
      await sql.unsafe(`insert into ${schema}.items values (2, 1999), (1, 500), (100, 25000000)`);
      const line = draftAcme().model("order_items").measures.find((m) => m.name === "line_total")!;
      const rows = (await sql.unsafe(`select sum(${line.expr}) as line from ${schema}.items`)) as { line: unknown }[];
      expect(Number(rows[0]!.line)).toBeCloseTo(25000044.98, 4);
    } finally {
      await sql.unsafe(`drop schema if exists ${schema} cascade`);
      await sql.close();
    }
  });
});

describe("ignored_columns and sensitivity tags", () => {
  test("every column a drafted model leaves out is listed in ignored_columns", async () => {
    const root = await setup();
    await sl(root, ["draft", "--source", "wh", "--strip-prefix", "fct_,dim_"]);
    const customers = parseYamlText(readModel(root, "customers")) as Model;
    expect(customers.ignored_columns).toEqual(["email"]);
    const products = parseYamlText(readModel(root, "products")) as Model;
    expect(products.ignored_columns).toEqual(["name"]);
    // A model that reads every column has no ignored_columns key.
    expect(readModel(root, "web_events")).not.toContain("ignored_columns");
    // Right after a draft, no column of a drafted table is new.
    const snap = snapshotOf(TABLES);
    for (const [name, table] of [
      ["orders", FCT_ORDERS],
      ["payments", FCT_PAYMENTS],
      ["customers", DIM_CUSTOMERS],
      ["products", DIM_PRODUCTS],
      ["web_events", WEB_EVENTS],
    ] as const) {
      const model = parseYamlText(readModel(root, name)) as Model;
      expect(unreferencedColumns(model, table, snap.dialect).map((c) => c.name)).toEqual([]);
    }
    const again = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    expect(again.json()).toEqual({ source: "wh", updated: [] });
  });

  test("ignored_columns lists id columns that are not keys, unsupported types and composite keys with no join", () => {
    const table: SnapshotTable = {
      schema: "s",
      name: "shipments",
      kind: "table",
      row_count: 100,
      primary_key: ["shipment_id"],
      foreign_keys: [{ columns: ["order_id", "line_no"], references: { schema: "s", table: "lines", columns: ["order_id", "line_no"] } }],
      columns: [
        col("shipment_id", "integer", p(100)),
        col("id", "integer", p(100)),
        col("order_id", "integer", p(40)),
        col("line_no", "integer", p(5)),
        col("geom", "geometry"),
        col("carrier", "varchar", p(3)),
      ],
    };
    const { models } = draftModels(snapshotOf([table]), [table], [], { source: "wh", stripPrefixes: [], knownTables: [table] });
    // The composite key's columns drafts no field while its target is unknown, nor does the stray id column.
    expect(models[0]!.ignored_columns).toEqual(["id", "order_id", "line_no", "geom"]);
    const keys = Object.keys(models[0]!);
    expect(keys.indexOf("ignored_columns")).toBe(keys.indexOf("open_questions") + 1);
  });

  test("sensitive names and pii names are tagged with an open question, whatever the column's type", () => {
    const table: SnapshotTable = {
      schema: "hr",
      name: "employees",
      kind: "table",
      row_count: 500,
      primary_key: ["employee_id"],
      columns: [
        col("employee_id", "integer", p(500)),
        col("salary", "decimal(12,2)", p(400)),
        col("comp_band", "varchar", p(6)),
        col("manager_notes", "text", p(300)),
        col("home_address", "varchar", p(300)),
        col("comment_count", "integer", p(15)),
        col("department", "varchar", p(12)),
      ],
    };
    const { models } = draftModels(snapshotOf([table]), [table], [], { source: "wh", stripPrefixes: [], knownTables: [table] });
    const m = models[0]!;
    const tagsOf = (name: string) => [...m.dimensions, ...m.measures].find((f) => f.name === name)?.tags;
    expect(tagsOf("salary")).toEqual(["sensitive"]);
    expect(m.measures.find((f) => f.name === "salary")).toMatchObject({ expr: "salary", agg: "sum", format: "currency", status: "draft" });
    expect(tagsOf("comp_band")).toEqual(["sensitive"]);
    expect(tagsOf("manager_notes")).toEqual(["sensitive"]);
    expect(tagsOf("home_address")).toEqual(["pii"]);
    // The name list has no type condition: a count named for comments is tagged too.
    expect(tagsOf("comment_count")).toEqual(["sensitive"]);
    expect(tagsOf("department")).toBeUndefined();
    expect(m.open_questions).toContain("home_address looks like personal data and is tagged pii. Who may see it?");
    expect(m.open_questions).toContain(
      "salary, comp_band, manager_notes and comment_count look sensitive (the name salary looks like pay, banking or health data; " +
        "the name comp_band looks like pay, banking or health data; the name manager_notes looks like a credential or free text; " +
        "the name comment_count looks like a credential or free text) " +
        "and are tagged sensitive. Who may see them? If everyone may, replace the tag with public.",
    );
  });
});

describe("draft --new-columns", () => {
  const ORDERS: SnapshotTable = {
    schema: "analytics",
    name: "orders",
    kind: "table",
    row_count: 1000,
    primary_key: ["order_id"],
    columns: [col("order_id", "integer", p(1000)), col("status", "varchar", p(4)), col("amount_cents", "bigint", p(900)), col("legacy_score", "double", p(700))],
  };
  const CUSTOMERS: SnapshotTable = {
    schema: "analytics",
    name: "customers",
    kind: "table",
    row_count: 200,
    primary_key: ["customer_id"],
    columns: [col("customer_id", "integer", p(200)), col("region", "varchar", p(5))],
  };
  // The owner's file: comments, an approved model and approved fields, and a column ignored on purpose.
  const OWNER_YAML = `# Orders, as the finance team reads them.
model: orders
source: wh
table: analytics.orders
status: approved
approved_by: dana
approved_at: "2026-01-10"
description: One row per order.
grain: One row per order.
primary_key: [order_id]
open_questions:
  - Is amount in cents? # answered: yes
ignored_columns:
  - legacy_score   # retired in 2024
dimensions:
  # The lifecycle state.
  - name: status
    expr: status
    type: string
    description: Order lifecycle state.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"

measures:
  - name: order_count
    agg: count
    description: Orders placed.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"
  - name: revenue   # owner-named
    expr: amount_cents * 0.01
    agg: sum
    format: currency
    description: Order value.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"
`;

  async function evolved(extraOrders: SnapshotColumn[], extraCustomers: SnapshotColumn[] = []) {
    const root = await setup([ORDERS, CUSTOMERS], { include: ["analytics.*"] });
    mkdirSync(join(root, "models", "wh"), { recursive: true });
    writeFileSync(modelPath(root, "orders"), OWNER_YAML);
    writeYaml(modelPath(root, "customers"), {
      model: "customers",
      source: "wh",
      table: "analytics.customers",
      status: "draft",
      primary_key: ["customer_id"],
      dimensions: [{ name: "region", expr: "region", type: "string", status: "draft" }],
      measures: [],
    });
    const before = { orders: readModel(root, "orders"), customers: readModel(root, "customers") };
    writeJson(
      join(root, "snapshots", "wh.json"),
      snapshotOf([
        { ...ORDERS, columns: [...ORDERS.columns, ...extraOrders] },
        { ...CUSTOMERS, columns: [...CUSTOMERS.columns, ...extraCustomers] },
      ]),
    );
    return { root, before };
  }

  interface NewColumnsJson {
    source: string;
    updated: { model: string; added: string[]; joins: string[]; skipped: { column: string; reason: string }[] }[];
  }

  test("appends only unreferenced, non-ignored columns and keeps every existing line byte-identical", async () => {
    const { root, before } = await evolved([
      col("notes", "varchar", p(40)),
      col("refund_cents", "bigint", p(60)),
      col("coupon_code", "varchar", p(995)),
      col("extra", "json"),
      col("Legacy_Score", "double", p(5)),
    ]);
    const r = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<NewColumnsJson>()).toEqual({
      source: "wh",
      updated: [
        {
          model: "orders",
          added: ["notes", "refund"],
          joins: [],
          skipped: [
            { column: "coupon_code", reason: "a different value on nearly every row" },
            { column: "extra", reason: "type json drafts as neither a dimension nor a measure" },
          ],
        },
      ],
    });
    const after = readModel(root, "orders");
    expect(after).toBe(`# Orders, as the finance team reads them.
model: orders
source: wh
table: analytics.orders
status: approved
approved_by: dana
approved_at: "2026-01-10"
description: One row per order.
grain: One row per order.
primary_key: [order_id]
open_questions:
  - Is amount in cents? # answered: yes
  - New column notes (varchar) appeared in analytics.orders; the draft adds the dimension notes, tagged sensitive (the name notes looks like a credential or free text). What does it hold, and should it stay?
  - New column refund_cents (bigint) appeared in analytics.orders; the draft adds the measure refund. What does it hold, and should it stay?
  - New column coupon_code (varchar) appeared in analytics.orders; the draft leaves it out (a different value on nearly every row) and lists it in ignored_columns. Should it be a field?
  - New column extra (json) appeared in analytics.orders; the draft leaves it out (type json drafts as neither a dimension nor a measure) and lists it in ignored_columns. Should it be a field?
  - "Is refund_cents stored in cents? The draft divides it by 100 (expr: refund_cents * 0.01) to report whole currency units; confirm the division."
  - Which currency is refund_cents in?
ignored_columns:
  - legacy_score   # retired in 2024
  - coupon_code
  - extra
dimensions:
  # The lifecycle state.
  - name: status
    expr: status
    type: string
    description: Order lifecycle state.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"
  - name: notes
    expr: notes
    type: string
    tags:
      - sensitive
    status: draft

measures:
  - name: order_count
    agg: count
    description: Orders placed.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"
  - name: revenue   # owner-named
    expr: amount_cents * 0.01
    agg: sum
    format: currency
    description: Order value.
    status: approved
    approved_by: dana
    approved_at: "2026-01-10"
  - name: refund
    expr: refund_cents * 0.01
    agg: sum
    format: currency
    status: draft
`);
    // Every original line is still there, in order.
    const lines = after.split("\n");
    let at = 0;
    for (const line of before.orders.split("\n")) {
      at = lines.indexOf(line, at);
      expect(at).toBeGreaterThanOrEqual(0);
      at++;
    }
    expect(readModel(root, "customers")).toBe(before.customers);

    // Nothing changed since: nothing is reported and the file stays as it is.
    const again = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    expect(again.json<NewColumnsJson>()).toEqual({ source: "wh", updated: [] });
    expect(readModel(root, "orders")).toBe(after);
    const human = await sl(root, ["draft", "--source", "wh", "--new-columns"]);
    expect(human.out).toBe("No new columns in wh: every column of a modeled in-scope table is read by a field or listed in ignored_columns.");
  });

  test("names avoid the model's own fields, a key column drafts a join, and a model without the lists gains them", async () => {
    const { root } = await evolved([col("status_code", "varchar", p(3)), col("customer_id", "integer", p(150))], [col("Revenue", "decimal(10,2)", p(150)), col("region_notes", "text", p(10))]);
    // The customers model gains a revenue measure; the orders model already has one named revenue.
    const r = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    const out = r.json<NewColumnsJson>();
    expect(out.updated.map((u) => [u.model, u.added])).toEqual([
      ["customers", ["region_notes", "revenue"]],
      ["orders", ["status_code", "customer_count"]],
    ]);
    const orders = parseYamlText(readModel(root, "orders")) as Model;
    expect(orders.measures.find((m) => m.name === "customer_count")).toEqual({
      name: "customer_count",
      expr: "customer_id",
      agg: "count_distinct",
      format: "integer",
      status: "draft",
    });
    expect(orders.open_questions).toContain(
      "New column customer_id (integer) appeared in analytics.orders; the draft adds the measure customer_count and the join customer to customers (inferred from the column name). What does it hold, and should it stay? Run `sl check-join --source wh --model orders --join customer` before the join is approved.",
    );
    // A draft join is added, and the model's own status stays approved.
    expect(out.updated.find((u) => u.model === "orders")!.joins).toEqual(["customer"]);
    expect(orders.joins).toEqual([
      { name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", type: "left", origin: "inferred", status: "draft" },
    ]);
    expect(orders.status).toBe("approved");
    const customers = parseYamlText(readModel(root, "customers")) as Model;
    expect(customers.status).toBe("draft");
    expect(customers.ignored_columns).toBeUndefined();
    expect(customers.measures.map((m) => m.name)).toEqual(["revenue"]);
    expect(customers.dimensions.find((d) => d.name === "region_notes")!.tags).toEqual(["sensitive"]);
    expect(customers.open_questions).toContain(
      "New column region_notes (text) appeared in analytics.customers; the draft adds the dimension region_notes, tagged sensitive (the name region_notes looks like a credential or free text). What does it hold, and should it stay?",
    );
    const keys = Object.keys(customers);
    expect(keys.indexOf("open_questions")).toBe(keys.indexOf("dimensions") - 1);
  });

  test("--tables limits the models, the focus threshold does not apply and out-of-scope models are skipped", async () => {
    const { root, before } = await evolved([col("channel", "varchar", p(4))], [col("tier", "varchar", p(3))]);
    updateYaml(join(root, "semantic.yaml"), (doc) => doc.setIn(["settings", "focus_threshold"], 1));
    const one = await sl(root, ["draft", "--source", "wh", "--new-columns", "--tables", "analytics.customers", "--json"]);
    expect(one.json<NewColumnsJson>().updated.map((u) => u.model)).toEqual(["customers"]);
    expect(readModel(root, "orders")).toBe(before.orders);
    const bad = await sl(root, ["draft", "--source", "wh", "--new-columns", "--tables", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('No table matches "nope"');

    updateYaml(join(root, "sources", "wh.yaml"), (doc) => doc.set("scope", doc.createNode({ include: ["analytics.customers"] })));
    const scoped = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    expect(scoped.json<NewColumnsJson>().updated).toEqual([]);
    expect(readModel(root, "orders")).toBe(before.orders);

    updateYaml(join(root, "sources", "wh.yaml"), (doc) => doc.delete("scope"));
    const all = await sl(root, ["draft", "--source", "wh", "--new-columns"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("Drafted new columns into 1 model in wh:");
    expect(all.out).toContain(`  orders (analytics.orders, ${join("models", "wh", "orders.yaml")}): added channel`);
    expect(all.out).toContain("the model's own status is unchanged");
  });

  test("an empty list's line comment moves to its key, and --force or --strip-prefix is refused", async () => {
    const { root } = await evolved([], [col("tier", "varchar", p(3))]);
    writeFileSync(
      modelPath(root, "customers"),
      `model: customers
source: wh
table: analytics.customers
status: draft
primary_key: [customer_id]
dimensions: []   # none yet
measures:
  - name: customer_count
    agg: count
    status: draft
`,
    );
    for (const flag of [["--force"], ["--strip-prefix", "dim_"]]) {
      const r = await sl(root, ["draft", "--source", "wh", "--new-columns", ...flag]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${flag[0]} applies only when drafting new models`);
    }
    const r = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    expect(r.json<NewColumnsJson>().updated.map((u) => [u.model, u.added])).toEqual([["customers", ["region", "tier"]]]);
    expect(readModel(root, "customers")).toBe(`model: customers
source: wh
table: analytics.customers
status: draft
primary_key: [customer_id]
open_questions:
  - New column region (varchar) appeared in analytics.customers; the draft adds the dimension region. What does it hold, and should it stay?
  - New column tier (varchar) appeared in analytics.customers; the draft adds the dimension tier. What does it hold, and should it stay?
dimensions: # none yet
  - name: region
    expr: region
    type: string
    status: draft
  - name: tier
    expr: tier
    type: string
    status: draft
measures:
  - name: customer_count
    agg: count
    status: draft
`);
  });

  test("a new column named like a unit next to an extract or cast expr is drafted", async () => {
    const { root } = await evolved([col("year", "integer", p(5)), col("channel", "varchar", p(4))]);
    updateYaml(modelPath(root, "orders"), (doc) => {
      const dims = doc.get("dimensions", true) as { items: unknown[] };
      dims.items.push(doc.createNode({ name: "order_year", expr: "cast(extract(year from now()) as integer)", type: "number", status: "draft" }));
    });
    const r = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
    const orders = r.json<NewColumnsJson>().updated.find((u) => u.model === "orders")!;
    expect([...orders.added, ...orders.skipped.map((x) => x.column)].sort()).toEqual(["channel", "year"].sort());
    const model = parseYamlText(readModel(root, "orders")) as Model;
    expect(model.open_questions!.some((q) => q.startsWith("New column year (integer) appeared in analytics.orders;"))).toBe(true);
  });

  test("draftNewColumns reads incoming join keys, filters and the model's primary key as used", () => {
    const table: SnapshotTable = {
      schema: null,
      name: "accounts",
      kind: "table",
      row_count: 100,
      columns: [col("acct_key", "integer", p(100)), col("is_test", "boolean", p(2)), col("plan", "varchar", p(3)), col("opened_on", "date", p(90))],
    };
    const model: Model = {
      model: "accounts",
      source: "wh",
      table: "accounts",
      status: "draft",
      primary_key: ["acct_key"],
      dimensions: [],
      measures: [{ name: "live_accounts", agg: "count", filter: "not is_test", status: "draft" }],
    };
    const other = {
      model: "orders",
      source: "wh",
      table: "orders",
      status: "draft",
      dimensions: [],
      measures: [],
      joins: [{ name: "account", to: "accounts", keys: [{ from: "acct", to: "plan" }], relationship: "many_to_one", status: "draft" }],
    } as Model;
    const r = draftNewColumns(snapshotOf([table]), table, model, [model, other], { source: "wh", stripPrefixes: [], knownTables: [table] });
    expect(r.columns.map((c) => c.name)).toEqual(["opened_on"]);
    expect(r.dimensions.map((d) => d.name)).toEqual(["opened_on"]);
    expect(r.measures).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.open_questions).toEqual([
      "New column opened_on (date) appeared in accounts; the draft adds the dimension opened_on. What does it hold, and should it stay?",
    ]);
  });
  describe("joins, currency and models sharing a table", () => {
    const REPS: SnapshotTable = {
      schema: "acme",
      name: "dim_sales_reps",
      kind: "table",
      row_count: 16,
      primary_key: ["rep_id"],
      columns: [col("rep_id", "integer", p(16)), col("team", "varchar", p(4))],
    };
    const REGIONS: SnapshotTable = {
      schema: "acme",
      name: "dim_regions",
      kind: "table",
      row_count: 6,
      primary_key: ["region_code"],
      columns: [col("region_code", "varchar", p(6)), col("region_name", "varchar", p(6))],
    };
    const ORDERS2: SnapshotTable = {
      schema: "acme",
      name: "fct_orders",
      kind: "table",
      row_count: 2500,
      primary_key: ["order_id"],
      foreign_keys: [
        { columns: ["sales_rep_id"], references: { schema: "acme", table: "dim_sales_reps", columns: ["rep_id"] } },
        { columns: ["region_code"], references: { schema: "acme", table: "dim_regions", columns: ["region_code"] } },
      ],
      columns: [
        col("order_id", "integer", p(2500)),
        col("amount_cents", "bigint", p(2000)),
        col("shipping_cents", "bigint", p(30)),
        col("sales_rep_id", "integer", p(16)),
        col("region_code", "varchar", p(6)),
        col("tax_cents", "bigint", p(400)),
      ],
    };
    const ordersModel = (currency?: string): Model => ({
      model: "orders",
      source: "warehouse",
      table: "acme.fct_orders",
      status: "approved",
      primary_key: ["order_id"],
      ignored_columns: ["shipping_cents"],
      dimensions: [],
      measures: [
        { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", format: "currency", ...(currency ? { currency } : {}), status: "approved" },
      ],
    });
    const repsModel: Model = {
      model: "sales_reps",
      source: "warehouse",
      table: "acme.dim_sales_reps",
      status: "approved",
      primary_key: ["rep_id"],
      dimensions: [{ name: "team", expr: "team", type: "string", status: "approved" }],
      measures: [],
    };
    const opts = { source: "warehouse", stripPrefixes: ["fct_", "dim_"], knownTables: [ORDERS2, REPS, REGIONS] };

    test("a new foreign-key column drafts a join, to a small modeled target or an in-scope table with no model", () => {
      const model = ordersModel("USD");
      const r = draftNewColumns(snapshotOf([ORDERS2, REPS, REGIONS]), ORDERS2, model, [model, repsModel], opts);
      expect(r.columns.map((c) => c.name)).toEqual(["sales_rep_id", "region_code", "tax_cents"]);
      expect(r.joins).toEqual([
        { name: "sales_rep", to: "sales_reps", keys: [{ from: "sales_rep_id", to: "rep_id" }], relationship: "many_to_one", type: "left", origin: "declared", status: "draft" },
        { name: "region", to: "regions", keys: [{ from: "region_code", to: "region_code" }], relationship: "many_to_one", type: "left", origin: "declared", status: "draft" },
      ]);
      // A key to a small target is joined, not skipped into ignored_columns.
      expect(r.skipped).toEqual([]);
      expect(r.open_questions.slice(0, 2)).toEqual([
        "New column sales_rep_id (integer) appeared in acme.fct_orders; the draft adds the join sales_rep to sales_reps (from the declared foreign key). What does it hold, and should it stay? Run `sl check-join --source warehouse --model orders --join sales_rep` before the join is approved.",
        "New column region_code (varchar) appeared in acme.fct_orders; the draft adds the join region to regions (from the declared foreign key; acme.dim_regions has no model yet, so draft it as regions). What does it hold, and should it stay? Run `sl check-join --source warehouse --model orders --join region` before the join is approved.",
      ]);
    });

    test("new money measures take the model's currency, and the currency question is asked only when no measure has one", () => {
      const withUsd = ordersModel("USD");
      const r = draftNewColumns(snapshotOf([ORDERS2, REPS, REGIONS]), ORDERS2, withUsd, [withUsd, repsModel], opts);
      expect(r.measures).toEqual([{ name: "tax", expr: "tax_cents * 0.01", agg: "sum", format: "currency", currency: "USD", status: "draft" }]);
      expect(Object.keys(r.measures[0]!)).toEqual(["name", "expr", "agg", "format", "currency", "status"]);
      expect(r.open_questions).toContain(
        "New column tax_cents (bigint) appeared in acme.fct_orders; the draft adds the measure tax in USD, the currency of the model's other measures. What does it hold, and should it stay?",
      );
      expect(r.open_questions.some((q) => /currency (is|are)|holds only/.test(q))).toBe(false);
      // No question names the ignored shipping_cents.
      expect(r.open_questions.some((q) => q.includes("shipping_cents"))).toBe(false);

      const without = ordersModel();
      const asked = draftNewColumns(snapshotOf([ORDERS2, REPS, REGIONS]), ORDERS2, without, [without, repsModel], opts);
      expect(asked.measures[0]!.currency).toBeUndefined();
      expect(asked.open_questions).toContain("Which currency is tax_cents in?");
      expect(asked.open_questions.some((q) => q.includes("shipping_cents") || q.includes("amount_cents"))).toBe(false);
    });

    test("a column is new only when no model over the table reads or ignores it, and only the main model gets it", () => {
      const table: SnapshotTable = {
        schema: "acme",
        name: "dim_customers",
        kind: "table",
        row_count: 400,
        primary_key: ["customer_id"],
        columns: [
          col("customer_id", "integer", p(400)),
          col("region", "varchar", p(6)),
          col("segment", "varchar", p(4)),
          col("email", "varchar", p(400)),
          col("legacy_flag", "boolean", p(2)),
          col("tier", "varchar", p(3)),
        ],
      };
      const main: Model = {
        model: "customers",
        source: "warehouse",
        table: "acme.dim_customers",
        status: "approved",
        primary_key: ["customer_id"],
        dimensions: [
          { name: "region", expr: "region", type: "string", status: "approved" },
          { name: "segment", expr: "segment", type: "string", status: "approved" },
        ],
        measures: [],
      };
      const helper: Model = {
        model: "test_accounts",
        source: "warehouse",
        table: "acme.dim_customers",
        status: "approved",
        primary_key: ["customer_id"],
        ignored_columns: ["legacy_flag"],
        dimensions: [],
        measures: [{ name: "test_account_count", agg: "count", filter: "email like '%@test.example'", status: "approved" }],
      };
      const snap = snapshotOf([table]);
      const models = [main, helper];
      // email is read by the helper and legacy_flag is ignored by it, so neither is new for the main model.
      expect(newColumns(snap, table, main, models).map((c) => c.name)).toEqual(["tier"]);
      expect(newColumns(snap, table, helper, models)).toEqual([]);
      const r = draftNewColumns(snap, table, helper, models, { source: "warehouse", stripPrefixes: [], knownTables: [table] });
      expect(r.columns).toEqual([]);
      // With equal reads, the first model by name takes the new columns.
      const twin: Model = { ...main, model: "accounts" };
      expect(newColumns(snap, table, main, [main, twin])).toEqual([]);
      expect(newColumns(snap, table, twin, [main, twin]).map((c) => c.name)).toEqual(["email", "legacy_flag", "tier"]);
    });

    test("the command appends the join at the end of the file and drafts a shared table's columns into its main model", async () => {
      const root = await setup([ORDERS2, REPS, REGIONS], { include: ["acme.*"] });
      mkdirSync(join(root, "models", "wh"), { recursive: true });
      writeYaml(modelPath(root, "orders"), { ...ordersModel("USD"), source: "wh", ignored_columns: ["shipping_cents", "region_code", "tax_cents"] });
      writeYaml(modelPath(root, "sales_reps"), { ...repsModel, source: "wh" });
      writeYaml(modelPath(root, "big_orders"), {
        model: "big_orders",
        source: "wh",
        table: "acme.fct_orders",
        status: "draft",
        dimensions: [],
        measures: [{ name: "big_order_count", agg: "count", filter: "amount_cents > 100000", status: "draft" }],
      });
      updateYaml(join(root, "sources", "wh.yaml"), (doc) => doc.setIn(["draft", "strip_prefixes"], ["fct_", "dim_"]));
      const before = readModel(root, "orders");
      const r = await sl(root, ["draft", "--source", "wh", "--new-columns", "--json"]);
      expect(r.code).toBe(0);
      expect(r.json<NewColumnsJson>().updated).toEqual([{ model: "orders", added: [], joins: ["sales_rep"], skipped: [] }]);
      const after = readModel(root, "orders");
      // Every original line is still there, in order, and the join's question is appended.
      const lines = after.split("\n");
      let at = 0;
      for (const line of before.split("\n")) {
        at = lines.indexOf(line, at);
        expect(at).toBeGreaterThanOrEqual(0);
        at++;
      }
      expect((parseYamlText(after) as Model).open_questions).toEqual([
        "New column sales_rep_id (integer) appeared in acme.fct_orders; the draft adds the join sales_rep to sales_reps (from the declared foreign key). What does it hold, and should it stay? Run `sl check-join --source wh --model orders --join sales_rep` before the join is approved.",
      ]);
      expect(after.endsWith(`joins:
  - name: sales_rep
    to: sales_reps
    keys:
      - from: sales_rep_id
        to: rep_id
    relationship: many_to_one
    type: left
    origin: declared
    status: draft
`)).toBe(true);
      expect(readModel(root, "big_orders")).not.toContain("sales_rep");
      const human = await sl(root, ["draft", "--source", "wh", "--new-columns"]);
      expect(human.out).toContain("No new columns in wh");
    });

    test("a question is forwarded only when a new column it is about is drafted, never by a word in its text", () => {
      // currency and shipping_cents are new; amount_cents is read by the approved revenue measure.
      const table: SnapshotTable = {
        ...ORDERS2,
        foreign_keys: [],
        columns: [
          col("order_id", "integer", p(2500)),
          col("amount_cents", "bigint", p(2000)),
          col("currency", "varchar", { ...p(1), top_values: [{ value: "USD", count: 2500 }] }),
          col("shipping_cents", "bigint", p(30)),
        ],
      };
      const model: Model = { ...ordersModel("USD"), ignored_columns: [] };
      const r = draftNewColumns(snapshotOf([table]), table, model, [model], { ...opts, knownTables: [table] });
      expect(r.columns.map((c) => c.name)).toEqual(["currency", "shipping_cents"]);
      expect(r.open_questions.some((q) => q.includes("amount_cents"))).toBe(false);
      expect(r.open_questions).toContain(
        "Is shipping_cents stored in cents? The draft divides it by 100 (expr: shipping_cents * 0.01) to report whole currency units; confirm the division.",
      );
      expect(r.unmodeled).toEqual([]);
    });

    test("new money measures on a model with several currencies take none and say so", () => {
      const model: Model = {
        ...ordersModel(),
        ignored_columns: ["shipping_cents", "sales_rep_id", "region_code"],
        measures: [
          { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", format: "currency", currency: "USD", status: "approved" },
          { name: "revenue_eur", expr: "amount_cents * 0.01", agg: "sum", format: "currency", currency: "EUR", status: "approved" },
        ],
      };
      const r = draftNewColumns(snapshotOf([ORDERS2, REPS, REGIONS]), ORDERS2, model, [model], opts);
      expect(r.measures).toEqual([{ name: "tax", expr: "tax_cents * 0.01", agg: "sum", format: "currency", status: "draft" }]);
      expect(r.open_questions).toEqual([
        "New column tax_cents (bigint) appeared in acme.fct_orders; the draft adds the measure tax with no currency, since the model's other measures are in USD and EUR. What does it hold, and should it stay?",
        "Is tax_cents stored in cents? The draft divides it by 100 (expr: tax_cents * 0.01) to report whole currency units; confirm the division.",
      ]);
    });

    test("a new join to an in-scope table with no model says to draft that table first", async () => {
      const root = await setup([ORDERS2, REPS, REGIONS], { include: ["acme.*"] });
      mkdirSync(join(root, "models", "wh"), { recursive: true });
      writeYaml(modelPath(root, "orders"), { ...ordersModel("USD"), source: "wh", ignored_columns: ["shipping_cents", "region_code", "tax_cents"] });
      updateYaml(join(root, "sources", "wh.yaml"), (doc) => doc.setIn(["draft", "strip_prefixes"], ["fct_", "dim_"]));
      const model = ordersModel("USD");
      const lib = draftNewColumns(snapshotOf([ORDERS2, REPS, REGIONS]), ORDERS2, model, [model], opts);
      expect(lib.unmodeled).toEqual([
        { join: "sales_rep", to: "sales_reps", table: "acme.dim_sales_reps" },
        { join: "region", to: "regions", table: "acme.dim_regions" },
      ]);
      const r = await sl(root, ["draft", "--source", "wh", "--new-columns"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        "Next: read each new item back to the owner, draft acme.dim_sales_reps first (`sl draft --source wh --tables acme.dim_sales_reps`), run `sl check-join` on each new join, then run `sl validate`.",
      );
      // The table drafts under the name the new join expects.
      const drafted = await sl(root, ["draft", "--source", "wh", "--tables", "acme.dim_sales_reps", "--json"]);
      expect(drafted.code).toBe(0);
      expect(drafted.json<{ drafted: { model: string }[] }>().drafted.map((d) => d.model)).toEqual(["sales_reps"]);
    });
  });

  describe("tables of id columns only", () => {
    const CLOSURE: SnapshotTable = {
      schema: "acme",
      name: "sales_team_closure",
      kind: "view",
      row_count: 27,
      columns: [col("manager_id", "integer", p(4)), col("member_id", "integer", p(15))],
    };

    test("a pair of id columns drafts two dimensions keyed by both, a question about the pair and no count_distinct", () => {
      const { models } = draftModels(snapshotOf([CLOSURE]), [CLOSURE], [], { source: "wh", stripPrefixes: [], knownTables: [CLOSURE] });
      expect(models[0]).toEqual({
        model: "sales_team_closure",
        source: "wh",
        table: "acme.sales_team_closure",
        status: "draft",
        primary_key: ["manager_id", "member_id"],
        open_questions: [
          "What does one row of acme.sales_team_closure represent?",
          "primary_key [manager_id, member_id] is every column of acme.sales_team_closure, which holds only id columns. Does each pair of manager_id and member_id appear only once?",
        ],
        dimensions: [
          { name: "manager_id", expr: "manager_id", type: "number", status: "draft" },
          { name: "member_id", expr: "member_id", type: "number", status: "draft" },
        ],
        measures: [{ name: "sales_team_closure_count", agg: "count", format: "integer", status: "draft" }],
      });
    });

    test("a link table still joins its keys, three columns ask about each combination, and a declared key is named in the question", () => {
      const orders: SnapshotTable = { schema: "s", name: "orders", kind: "table", row_count: 500, primary_key: ["order_id"], columns: [col("order_id", "integer", p(500))] };
      const tags: SnapshotTable = { schema: "s", name: "tags", kind: "table", row_count: 30, primary_key: ["tag_id"], columns: [col("tag_id", "varchar", p(30))] };
      const link: SnapshotTable = {
        schema: "s",
        name: "order_tags",
        kind: "table",
        row_count: 900,
        columns: [col("order_id", "integer", p(500)), col("tag_id", "varchar", p(30)), col("source_id", "integer", p(3))],
      };
      const tables = [orders, tags, link];
      const draft = (t: SnapshotTable) =>
        draftModels(snapshotOf(tables.map((x) => (x.name === t.name ? t : x))), [t], [], { source: "wh", stripPrefixes: [], knownTables: tables }).models[0]!;
      const m = draft(link);
      expect(m.primary_key).toEqual(["order_id", "tag_id", "source_id"]);
      expect(m.dimensions.map((d) => [d.name, d.type])).toEqual([
        ["order_id", "number"],
        ["tag_id", "string"],
        ["source_id", "number"],
      ]);
      expect(m.measures.map((x) => x.agg)).toEqual(["count"]);
      expect(m.joins!.map((j) => [j.name, j.to, j.relationship])).toEqual([
        ["order", "orders", "many_to_one"],
        ["tag", "tags", "many_to_one"],
      ]);
      expect(m.open_questions).toContain(
        "primary_key [order_id, tag_id, source_id] is every column of s.order_tags, which holds only id columns. Does each combination of order_id, tag_id and source_id appear only once?",
      );
      expect(m.ignored_columns).toBeUndefined();

      // A declared or single unique key still drafts the all-columns key and the combination question.
      const declared = draft({ ...link, primary_key: ["order_id", "tag_id"] });
      expect(declared.primary_key).toEqual(["order_id", "tag_id", "source_id"]);
      expect(declared.open_questions).toContain(
        "primary_key [order_id, tag_id, source_id] is every column of s.order_tags, which holds only id columns. Does each combination of order_id, tag_id and source_id appear only once? The table declares the primary key [order_id, tag_id].",
      );
      expect(declared.open_questions!.some((q) => q.includes("not a declared primary key"))).toBe(false);
      expect(declared.dimensions.map((d) => d.name)).toEqual(["order_id", "tag_id", "source_id"]);
      expect(declared.measures.map((x) => x.agg)).toEqual(["count"]);
      const pairs: SnapshotTable = {
        schema: "s",
        name: "pairs",
        kind: "table",
        row_count: 40,
        unique_keys: [["a_id"]],
        columns: [col("a_id", "integer", p(40)), col("b_id", "integer", p(16))],
      };
      const unique = draftModels(snapshotOf([pairs]), [pairs], [], { source: "wh", stripPrefixes: [], knownTables: [pairs] }).models[0]!;
      expect(unique.primary_key).toEqual(["a_id", "b_id"]);
      expect(unique.open_questions).toEqual([
        "What does one row of s.pairs represent?",
        "primary_key [a_id, b_id] is every column of s.pairs, which holds only id columns. Does each pair of a_id and b_id appear only once? The table has the unique key [a_id].",
      ]);
      expect(unique.measures.map((x) => x.agg)).toEqual(["count"]);

      // Four id columns, or one column that is not an id, draft by the usual rules.
      const four = draft({ ...link, columns: [...link.columns, col("batch_id", "integer", p(800))] });
      expect(four.measures.some((x) => x.agg === "count_distinct")).toBe(true);
      const mixed = draft({ ...link, columns: [col("order_id", "integer", p(500)), col("label", "varchar", p(5))] });
      expect(mixed.dimensions.map((d) => d.name)).toEqual(["label"]);
    });
  });
});

describe("composite keys, text keys, currencies and time zones", () => {
  function draftShop(tables: SnapshotTable[], dialect: Snapshot["dialect"] = "postgres", drafting = tables) {
    const snap: Snapshot = { ...snapshotOf(tables), source: "shop", dialect };
    const { models, notes } = draftModels(snap, drafting, [], { source: "shop", stripPrefixes: [], knownTables: tables });
    return { model: (name: string) => models.find((m) => m.model === name)!, models, notes };
  }

  // ops.sales_targets(store_id int, month date, target_eur numeric(12,2), primary key (store_id, month)).
  const SALES_TARGETS: SnapshotTable = {
    schema: "ops",
    name: "sales_targets",
    kind: "table",
    row_count: 240,
    primary_key: ["store_id", "month"],
    columns: [col("store_id", "integer", p(20)), col("month", "date", p(12)), col("target_eur", "numeric(12,2)", p(12))],
  };

  test("a date inside a composite primary key is a time dimension, and target_eur is money in EUR", () => {
    const m = draftShop([SALES_TARGETS]).model("sales_targets");
    expect(m.primary_key).toEqual(["store_id", "month"]);
    expect(m.dimensions).toEqual([{ name: "month", expr: "month", type: "time", time_grains: ["day", "week", "month", "quarter", "year"], status: "draft" }]);
    expect(m.measures).toEqual([
      { name: "sales_target_count", agg: "count", format: "integer", status: "draft" },
      { name: "store_count", expr: "store_id", agg: "count_distinct", format: "integer", status: "draft" },
      { name: "target_eur", expr: "target_eur", agg: "sum", format: "currency", currency: "EUR", status: "draft" },
    ]);
    expect(m.ignored_columns).toBeUndefined();
    expect(m.open_questions).toContain("target_eur is drafted with currency EUR, from its name. Is it in EUR?");
    expect(m.open_questions!.some((q) => q.startsWith("Which currency"))).toBe(false);
    // A date has no time zone to ask about.
    expect(m.open_questions!.some((q) => q.includes("time zone"))).toBe(false);
  });

  test("a timestamp in a composite key is a time dimension; an id column in one is not", () => {
    const snapshots: SnapshotTable = {
      schema: "ops",
      name: "balances",
      kind: "table",
      row_count: 100,
      primary_key: ["account_id", "as_of"],
      columns: [col("account_id", "integer", p(10)), col("as_of", "timestamptz", p(10)), col("balance", "numeric(14,2)", p(90))],
    };
    const m = draftShop([snapshots]).model("balances");
    expect(m.dimensions.map((d) => [d.name, d.type])).toEqual([["as_of", "time"]]);
    expect(m.dimensions[0]!.time_grains).toEqual(["hour", "day", "week", "month", "quarter", "year"]);
    // A date that is the whole key (a daily aggregate) is a time dimension too, and stays the key.
    const days: SnapshotTable = { schema: "ops", name: "days", kind: "table", row_count: 10, primary_key: ["day"], columns: [col("day", "date", p(10)), col("note_count", "integer", p(4))] };
    const daily = draftShop([days]).model("days");
    expect(daily.primary_key).toEqual(["day"]);
    expect(daily.dimensions.map((d) => [d.name, d.type])).toEqual([["day", "time"]]);
    // ops.daily_revenue(day date primary key, revenue): the reviewer's daily aggregate table.
    const revenue: SnapshotTable = {
      schema: "ops",
      name: "daily_revenue",
      kind: "table",
      primary_key: ["day"],
      columns: [col("day", "date"), col("revenue", "numeric(12,2)")],
    };
    expect(draftShop([revenue]).model("daily_revenue").dimensions.map((d) => d.name)).toEqual(["day"]);
  });

  test("currency-code suffixes name money: summed with the code as currency", () => {
    const rule = (n: string) => {
      const r = numericRule(n);
      return r ? `${r.agg}:${r.format}` : null;
    };
    expect(rule("target_eur")).toBe("sum:currency");
    expect(rule("revenue_usd")).toBe("sum:currency");
    expect(rule("budget_gbp")).toBe("sum:currency");
    expect(rule("fee_jpy_cents")).toBe("sum:currency");
    expect(rule("price_eur")).toBe("avg:currency");
    // A count stays a count, and a word that is not a code names nothing.
    expect(rule("orders_usd_count")).toBe("sum:integer");
    expect(rule("score_try")).toBeNull();
    expect(rule("europe")).toBeNull();
    expect(rule("mrr_usd")).toBe("sum:currency");
  });

  test("a currency suffix after a code, a statistic or a word that names no amount is not money", () => {
    // The reviewer's probe: these were null before currency suffixes and must stay null.
    for (const n of [
      "eur_usd",
      "usd_eur",
      "fx_eur_usd",
      "fx_eur",
      "median_basket_usd",
      "min_bid_eur",
      "rank_usd",
      "score_eur",
      "percentile_usd",
      "share_eur",
      "weight_php",
      "latitude_aud",
    ]) {
      expect([n, numericRule(n)]).toEqual([n, null]);
    }
    // ops.balances.eur_usd numeric(18,6) in a table commented "amounts in cents": no money, no division.
    const balances: SnapshotTable = {
      schema: "ops",
      name: "balances",
      kind: "table",
      row_count: 100,
      primary_key: ["balance_id"],
      description: "Daily balances; amounts in cents.",
      columns: [col("balance_id", "integer", p(100)), col("eur_usd", "numeric(18,6)", p(100)), col("amount", "numeric(18,6)", p(90))],
    };
    const m = draftShop([balances], "postgres").model("balances");
    const fx = m.measures.find((x) => x.expr?.includes("eur_usd"));
    expect(fx).toEqual({ name: "avg_eur_usd", expr: "eur_usd", agg: "avg", format: "number", status: "draft" });
    // A numeric with decimal places is not divided by a table comment that says cents.
    expect(m.measures.find((x) => x.name === "amount")).toEqual({ name: "amount", expr: "amount", agg: "sum", format: "currency", status: "draft" });
    expect(m.open_questions!.some((q) => q.startsWith("Is amount stored in cents"))).toBe(false);
    // An integer amount is still divided by it.
    const ints = draftShop([{ ...balances, columns: [balances.columns[0]!, col("amount", "bigint", p(90))] }], "postgres").model("balances");
    expect(ints.measures.find((x) => x.expr === "amount / 100.0")?.name).toBe("amount");
  });

  test("a comment naming a currency by word or symbol confirms it; dollars and $ do not", () => {
    const table: SnapshotTable = { schema: "s", name: "t", kind: "table", columns: [col("price", "numeric(10,2)")] };
    const with_ = (description: string) => columnCurrency(table, { ...table.columns[0]!, description });
    expect(with_("Price per unit in euros")?.currency).toBe("EUR");
    expect(with_("price in eur")?.currency).toBe("EUR");
    expect(with_("Unit price (€)")?.currency).toBe("EUR");
    expect(with_("Price in pounds sterling")?.currency).toBe("GBP");
    expect(with_("Price in £")?.currency).toBe("GBP");
    expect(with_("Price in yen")?.currency).toBe("JPY");
    expect(with_("¥ per unit")?.currency).toBe("JPY");
    expect(with_("Price in dollars")).toBeUndefined();
    expect(with_("Price in $")).toBeUndefined();
    expect(with_("Price in pounds")).toBeUndefined();
    expect(with_("euros or USD")).toBeUndefined();
    // The reviewer's case: 'Price per unit in euros' turns the open currency question into a confirmation.
    const m = draftShop([{ ...SALES, columns: SALES.columns.map((c) => (c.name === "unit_price" ? { ...c, description: "Price per unit in euros" } : c)) }]).model("sales");
    expect(m.open_questions).toContain("unit_price is drafted with currency EUR, from its comment. Is it in EUR? Which currency is discount in?");
  });

  const SALES: SnapshotTable = {
    schema: "shop",
    name: "sales",
    kind: "table",
    row_count: 3000,
    primary_key: ["sale_id"],
    description: "One row per sale line. Discounts are stored in cents.",
    columns: [
      col("sale_id", "integer", p(3000)),
      col("sku", "text", p(42)),
      col("store_id", "integer", p(20)),
      col("sold_at", "timestamp without time zone", p(2900)),
      col("quantity", "integer", p(10)),
      col("unit_price", "numeric(10,2)", p(300), "Price per unit in EUR, before discount"),
      col("discount", "numeric(10,2)", p(40)),
    ],
  };
  const PRODUCTS: SnapshotTable = {
    schema: "shop",
    name: "products",
    kind: "table",
    row_count: 42,
    primary_key: ["sku"],
    columns: [col("sku", "text", p(42)), col("category", "text", p(6)), col("cost", "numeric(10,2)", p(40))],
  };
  const STORES: SnapshotTable = {
    schema: "shop",
    name: "stores",
    kind: "table",
    row_count: 20,
    primary_key: ["store_id"],
    columns: [col("store_id", "integer", p(20)), col("city", "text", p(20))],
  };

  test("a column named like another table's text primary key joins to it: sales.sku -> products.sku", () => {
    const sales = draftShop([SALES, PRODUCTS, STORES], "postgres", [SALES]).model("sales");
    expect(sales.joins).toEqual([
      { name: "store", to: "stores", keys: [{ from: "store_id", to: "store_id" }], relationship: "many_to_one", type: "left", origin: "inferred", status: "draft" },
      { name: "product", to: "products", keys: [{ from: "sku", to: "sku" }], relationship: "many_to_one", type: "left", origin: "inferred", status: "draft" },
    ]);
    // A column joined by its name keeps its own dimension: the join adds the product's fields.
    expect(sales.dimensions.find((d) => d.name === "sku")).toEqual({ name: "sku", expr: "sku", type: "string", status: "draft" });
    expect(sales.measures.some((m) => m.expr === "sku")).toBe(false);
  });

  test("a name-matched key needs a compatible type, a single-column key and a known target", () => {
    const intKeyed: SnapshotTable = { ...PRODUCTS, columns: [col("sku", "integer", p(42)), col("category", "text", p(6))] };
    expect(draftShop([SALES, intKeyed], "postgres", [SALES]).model("sales").joins).toBeUndefined();
    const composite: SnapshotTable = { ...PRODUCTS, primary_key: ["sku", "category"] };
    expect(draftShop([SALES, composite], "postgres", [SALES]).model("sales").joins).toBeUndefined();
    // A table out of scope and unmodeled is no target.
    const snap: Snapshot = { ...snapshotOf([SALES, PRODUCTS]), dialect: "postgres" };
    const out = draftModels(snap, [SALES], [], { source: "shop", stripPrefixes: [], knownTables: [SALES] });
    expect(out.models[0]!.joins).toBeUndefined();
    // A date named like a date table's key keeps its time dimension and joins nowhere.
    const days: SnapshotTable = { schema: "shop", name: "calendar", kind: "table", row_count: 365, primary_key: ["sale_date"], columns: [col("sale_date", "date", p(365)), col("is_holiday", "boolean", p(2))] };
    const dated: SnapshotTable = { ...SALES, columns: [...SALES.columns, col("sale_date", "date", p(365))] };
    const withDate = draftShop([dated, days], "postgres", [dated]).model("sales");
    expect(withDate.joins).toBeUndefined();
    expect(withDate.dimensions.map((d) => d.name)).toContain("sale_date");
    // A table's own sole key is never a reference: products.sku joins nowhere, even with a copy keyed by sku.
    const copy: SnapshotTable = { ...PRODUCTS, name: "products_v2" };
    expect(draftShop([PRODUCTS, copy], "postgres", [PRODUCTS]).model("products").joins).toBeUndefined();
  });

  test("two tables keyed by the same name: the draft joins one and asks which; noise is never a target", () => {
    const bak: SnapshotTable = { ...PRODUCTS, name: "products_bak" };
    const catalog: SnapshotTable = { ...PRODUCTS, schema: "catalog", name: "items" };
    const sales = draftShop([SALES, bak, PRODUCTS, catalog], "postgres", [SALES]).model("sales");
    expect(sales.joins!.find((j) => j.keys[0]!.from === "sku")!.to).toBe("products");
    expect(sales.open_questions).toContain(
      "sku is joined to shop.products because its name matches that table's key; it could also mean catalog.items. Which is it?",
    );
    // A noise table that is the only match is no target.
    const onlyBak = draftShop([SALES, bak, STORES], "postgres", [SALES]).model("sales");
    expect(onlyBak.joins!.map((j) => j.keys[0]!.from)).toEqual(["store_id"]);
    expect(onlyBak.open_questions!.join(" ")).not.toContain("products_bak");
  });

  test("a raw or staging table is a name-match target only when no other table matches", () => {
    const raw: SnapshotTable = { ...PRODUCTS, name: "raw_products" };
    const both = draftShop([SALES, raw, PRODUCTS], "postgres", [SALES]).model("sales");
    expect(both.joins!.find((j) => j.keys[0]!.from === "sku")!.to).toBe("products");
    expect(both.open_questions!.join(" ")).not.toContain("raw_products");
    const alone = draftShop([SALES, raw], "postgres", [SALES]).model("sales");
    expect(alone.joins!.find((j) => j.keys[0]!.from === "sku")!.to).toBe("raw_products");
  });

  test("generic attribute names never join by name: products(name, code, version) next to tables keyed by them", () => {
    // The reviewer's probe: feature_flags keyed by name, currencies by code, Rails' schema_migrations by version.
    const products: SnapshotTable = {
      schema: "shop",
      name: "products",
      kind: "table",
      primary_key: ["product_id"],
      columns: [col("product_id", "integer"), col("name", "text"), col("code", "text"), col("version", "text")],
    };
    const flags: SnapshotTable = { schema: "shop", name: "feature_flags", kind: "table", primary_key: ["name"], columns: [col("name", "text"), col("enabled", "boolean")] };
    const currencies: SnapshotTable = { schema: "shop", name: "currencies", kind: "table", primary_key: ["code"], columns: [col("code", "text")] };
    const migrations: SnapshotTable = { schema: "public", name: "schema_migrations", kind: "table", primary_key: ["version"], columns: [col("version", "varchar")] };
    const m = draftShop([products, flags, currencies, migrations], "postgres", [products]).model("products");
    expect(m.joins).toBeUndefined();
    expect(m.dimensions.map((d) => [d.name, d.type])).toEqual([
      ["name", "string"],
      ["code", "string"],
      ["version", "string"],
    ]);
    expect(m.measures.map((x) => x.name)).toEqual(["product_count"]);
    // schema_migrations is noise: even a column name that is not generic never joins to it.
    const rails: SnapshotTable = { ...migrations, primary_key: ["release"], columns: [col("release", "varchar")] };
    const deploys: SnapshotTable = { schema: "ops", name: "deploys", kind: "table", primary_key: ["deploy_id"], columns: [col("deploy_id", "integer"), col("release", "varchar")] };
    const d = draftShop([deploys, rails], "postgres", [deploys]).model("deploys");
    expect(d.joins).toBeUndefined();
    expect(d.dimensions.map((x) => x.name)).toEqual(["release"]);
  });

  test("a status column joined to a status table keeps its dimension; an email is never joined by name", () => {
    // The reviewer's probe: orders.status next to statuses(status), orders.email next to mkt.newsletter_signups(email).
    const orders: SnapshotTable = {
      schema: "shop",
      name: "orders",
      kind: "table",
      primary_key: ["order_id"],
      columns: [col("order_id", "integer"), col("status", "text"), col("email", "text"), col("amount", "numeric(12,2)")],
    };
    const statuses: SnapshotTable = { schema: "shop", name: "statuses", kind: "table", primary_key: ["status"], columns: [col("status", "text"), col("label", "text")] };
    const signups: SnapshotTable = {
      schema: "mkt",
      name: "newsletter_signups",
      kind: "table",
      primary_key: ["email"],
      columns: [col("email", "text"), col("signed_up_at", "timestamptz")],
    };
    const m = draftShop([orders, statuses, signups], "postgres", [orders]).model("orders");
    expect(m.dimensions.map((d) => d.name)).toEqual(["status", "email"]);
    expect(m.measures.map((x) => x.name)).toEqual(["order_count", "amount"]);
    expect(m.joins).toEqual([
      { name: "statuses", to: "statuses", keys: [{ from: "status", to: "status" }], relationship: "many_to_one", type: "left", origin: "inferred", status: "draft" },
    ]);
  });

  test("a number joined by its name is a dimension, never a measure", () => {
    const visits: SnapshotTable = {
      schema: "shop",
      name: "visits",
      kind: "table",
      row_count: 1000,
      primary_key: ["visit_id"],
      columns: [col("visit_id", "integer", p(1000)), col("store_number", "integer", p(400))],
    };
    const branches: SnapshotTable = { schema: "shop", name: "branches", kind: "table", row_count: 400, primary_key: ["store_number"], columns: [col("store_number", "integer", p(400))] };
    const m = draftShop([visits, branches], "postgres", [visits]).model("visits");
    expect(m.joins!.map((j) => j.to)).toEqual(["branches"]);
    expect(m.dimensions).toEqual([{ name: "store_number", expr: "store_number", type: "number", status: "draft" }]);
    expect(m.measures.map((x) => x.name)).toEqual(["visit_count"]);
  });

  test("a currency code in a column comment makes the currency question a confirmation", () => {
    const sales = draftShop([SALES, PRODUCTS, STORES], "postgres", [SALES]).model("sales");
    const price = sales.measures.find((m) => m.name === "avg_unit_price")!;
    expect(price).toMatchObject({ expr: "unit_price", agg: "avg", format: "currency", currency: "EUR", description: "Price per unit in EUR, before discount" });
    // numeric(10,2) is whole currency units, whatever the table comment says about cents.
    const discount = sales.measures.find((m) => m.name === "discount")!;
    expect(discount).toEqual({ name: "discount", expr: "discount", agg: "sum", format: "currency", status: "draft" });
    expect(sales.measures.find((m) => m.name === "line_total")!.currency).toBe("EUR");
    expect(sales.open_questions).toContain("unit_price is drafted with currency EUR, from its comment. Is it in EUR? Which currency is discount in?");
    expect(sales.open_questions!.some((q) => q.startsWith("Is discount stored in cents"))).toBe(false);
  });

  test("a currency code in the table comment confirms every money column; several codes confirm none", () => {
    const ledger: SnapshotTable = {
      schema: "fin",
      name: "ledger",
      kind: "table",
      row_count: 100,
      primary_key: ["entry_id"],
      description: "Ledger entries, amounts in GBP.",
      columns: [col("entry_id", "integer", p(100)), col("amount", "numeric(12,2)", p(90)), col("fee", "numeric(12,2)", p(30))],
    };
    const m = draftShop([ledger]).model("ledger");
    expect(m.measures.filter((x) => x.format === "currency").map((x) => x.currency)).toEqual(["GBP", "GBP"]);
    expect(m.open_questions).toContain("amount and fee are drafted with currency GBP, from the table comment of fin.ledger. Is each in GBP?");
    const mixed = draftShop([{ ...ledger, description: "Converted from GBP to USD nightly." }]).model("ledger");
    expect(mixed.measures.some((x) => x.currency !== undefined)).toBe(false);
    expect(mixed.open_questions).toContain("Which currency are amount and fee in?");
    // A lowercase word is not a code.
    expect(columnCurrency({ ...ledger, description: "eur stuff" }, ledger.columns[1]!)).toBeUndefined();
  });

  test("timestamps without a time zone get a question naming time_zone, per dialect", () => {
    expect(timestampHasZone("postgres", "timestamp without time zone")).toBe(false);
    expect(timestampHasZone("postgres", "timestamp(6) without time zone")).toBe(false);
    expect(timestampHasZone("postgres", "timestamp")).toBe(false);
    expect(timestampHasZone("postgres", "timestamp with time zone")).toBe(true);
    expect(timestampHasZone("postgres", "timestamptz")).toBe(true);
    expect(timestampHasZone("duckdb", "TIMESTAMP")).toBe(false);
    expect(timestampHasZone("duckdb", "TIMESTAMP WITH TIME ZONE")).toBe(true);
    expect(timestampHasZone("snowflake", "TIMESTAMP_NTZ(9)")).toBe(false);
    expect(timestampHasZone("snowflake", "TIMESTAMP_LTZ(9)")).toBe(true);
    expect(timestampHasZone("snowflake", "TIMESTAMP_TZ")).toBe(true);
    expect(timestampHasZone("snowflake", "TIMESTAMPLTZ")).toBe(true);
    expect(timestampHasZone("snowflake", "TIMESTAMPTZ")).toBe(true);
    expect(timestampHasZone("snowflake", "TIMESTAMPNTZ")).toBe(false);
    expect(timestampHasZone("bigquery", "TIMESTAMP")).toBe(true);
    expect(timestampHasZone("bigquery", "DATETIME")).toBe(false);
    expect(timestampHasZone("databricks", "timestamp")).toBe(true);
    expect(timestampHasZone("databricks", "timestamp_ntz")).toBe(false);
    expect(timestampHasZone("postgres", "date")).toBeNull();

    const sales = draftShop([SALES, PRODUCTS, STORES], "postgres", [SALES]).model("sales");
    expect(sales.open_questions).toContain(
      "sold_at is a timestamp without a time zone. In which time zone is its value stored? The answer is recorded as time_zone (an IANA zone such as UTC or America/New_York) on its time dimension.",
    );
    const aware = draftShop([{ ...SALES, columns: SALES.columns.map((c) => (c.name === "sold_at" ? { ...c, type: "timestamptz" } : c)) }], "postgres").model("sales");
    expect(aware.open_questions!.some((q) => q.includes("without a time zone"))).toBe(false);
    const bq = draftShop([{ ...SALES, columns: SALES.columns.map((c) => (c.name === "sold_at" ? { ...c, type: "TIMESTAMP" } : c)) }], "bigquery").model("sales");
    expect(bq.open_questions!.some((q) => q.includes("without a time zone"))).toBe(false);
  });

  test("--new-columns asks the time-zone and currency questions about the new columns only", () => {
    const existing: Model = {
      model: "sales",
      source: "shop",
      table: "shop.sales",
      status: "approved",
      primary_key: ["sale_id"],
      open_questions: [],
      dimensions: [{ name: "sold_at", expr: "sold_at", type: "time", time_grains: ["day"], status: "approved" }],
      measures: [{ name: "sale_count", agg: "count", status: "approved" }],
    };
    const table: SnapshotTable = {
      ...SALES,
      description: null,
      columns: [...SALES.columns.filter((c) => ["sale_id", "sold_at"].includes(c.name)), col("refunded_at", "timestamp", p(40)), col("refund_chf", "numeric(10,2)", p(40))],
    };
    const snap: Snapshot = { ...snapshotOf([table]), source: "shop", dialect: "postgres" };
    const r = draftNewColumns(snap, table, existing, [existing], { source: "shop", stripPrefixes: [], knownTables: [table] });
    expect(r.dimensions.map((d) => d.name)).toEqual(["refunded_at"]);
    expect(r.measures).toEqual([{ name: "refund_chf", expr: "refund_chf", agg: "sum", format: "currency", currency: "CHF", status: "draft" }]);
    expect(r.open_questions).toContain(
      "refunded_at is a timestamp without a time zone. In which time zone is its value stored? The answer is recorded as time_zone (an IANA zone such as UTC or America/New_York) on its time dimension.",
    );
    expect(r.open_questions).toContain("refund_chf is drafted with currency CHF, from its name. Is it in CHF?");
    expect(r.open_questions.join(" ")).not.toContain("sold_at");
    // With a currency on the model's measures, a new column's own code is still confirmed; one without a code takes the model's.
    const priced: Model = { ...existing, measures: [...existing.measures, { name: "revenue", expr: "revenue", agg: "sum", format: "currency", currency: "USD", status: "approved" }] };
    const t2: SnapshotTable = { ...table, columns: [...table.columns, col("revenue", "numeric(10,2)", p(90)), col("fee", "numeric(10,2)", p(30))] };
    const r2 = draftNewColumns({ ...snap, tables: [t2] }, t2, priced, [priced], { source: "shop", stripPrefixes: [], knownTables: [t2] });
    expect(r2.measures.map((m) => [m.name, m.currency])).toEqual([
      ["refund_chf", "CHF"],
      ["fee", "USD"],
    ]);
    expect(r2.open_questions).toContain("refund_chf is drafted with currency CHF, from its name. Is it in CHF?");
    expect(r2.open_questions.join(" ")).not.toContain("Which currency");
  });
});

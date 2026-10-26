// Table definitions for the synthetic Acme dataset: the warehouse tables written as CSV
// and loaded into Postgres, and the lake tables written as Parquet.

export type ColumnType = "int" | "text" | "bool" | "tstz" | "date" | "money";

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable?: boolean;
}

export interface ForeignKeyDef {
  columns: string[];
  table: string;
  refColumns: string[];
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey?: string[];
  foreignKeys?: ForeignKeyDef[];
  comment?: string;
}

export interface LakeTableDef {
  name: string;
  columns: ColumnDef[];
  // Path relative to data/lake. A table split by year writes <path>/<name>_<year>.parquet.
  path: string;
  splitByYear?: string;
}

export const DUCKDB_TYPES: Record<ColumnType, string> = {
  int: "INTEGER",
  text: "VARCHAR",
  bool: "BOOLEAN",
  tstz: "TIMESTAMPTZ",
  date: "DATE",
  money: "DECIMAL(12,2)",
};

export const POSTGRES_TYPES: Record<ColumnType, string> = {
  int: "integer",
  text: "text",
  bool: "boolean",
  tstz: "timestamptz",
  date: "date",
  money: "numeric(12,2)",
};

const c = (name: string, type: ColumnType, nullable = false): ColumnDef => ({ name, type, nullable });

export const WAREHOUSE_TABLES: TableDef[] = [
  {
    name: "dim_regions",
    columns: [c("region_code", "text"), c("region_name", "text"), c("country_code", "text"), c("timezone", "text")],
    primaryKey: ["region_code"],
    comment: "Sales regions. One row per region.",
  },
  {
    name: "dim_customers",
    columns: [
      c("customer_id", "int"),
      c("email", "text"),
      c("phone", "text", true),
      c("first_name", "text"),
      c("last_name", "text"),
      c("signup_at", "tstz"),
      c("region_code", "text"),
      c("is_test_account", "bool"),
      c("acquisition_channel", "text"),
    ],
    primaryKey: ["customer_id"],
    foreignKeys: [{ columns: ["region_code"], table: "dim_regions", refColumns: ["region_code"] }],
    comment: "Customer accounts, one row per customer. Includes internal test accounts.",
  },
  {
    name: "dim_products",
    columns: [
      c("product_id", "int"),
      c("sku", "text"),
      c("product_name", "text"),
      c("category", "text"),
      c("list_price_cents", "int"),
      c("is_active", "bool"),
      c("launched_on", "date"),
    ],
    primaryKey: ["product_id"],
  },
  {
    name: "fct_orders",
    columns: [
      c("order_id", "int"),
      c("customer_id", "int"),
      c("created_at", "tstz"),
      c("status", "text"),
      c("amount_cents", "int"),
      c("shipping_cents", "int"),
      c("ship_region", "text"),
      c("currency", "text"),
    ],
    primaryKey: ["order_id"],
    comment: "Orders from the storefront, one row per order. Amounts in integer cents.",
  },
  {
    name: "fct_order_items",
    columns: [c("order_item_id", "int"), c("order_id", "int"), c("product_id", "int"), c("quantity", "int"), c("unit_price_cents", "int")],
    primaryKey: ["order_item_id"],
    foreignKeys: [
      { columns: ["order_id"], table: "fct_orders", refColumns: ["order_id"] },
      { columns: ["product_id"], table: "dim_products", refColumns: ["product_id"] },
    ],
  },
  {
    name: "fct_refunds",
    columns: [c("refund_id", "int"), c("order_id", "int"), c("refunded_cents", "int"), c("refunded_at", "tstz"), c("reason", "text")],
    primaryKey: ["refund_id"],
    foreignKeys: [{ columns: ["order_id"], table: "fct_orders", refColumns: ["order_id"] }],
    comment: "Refunds issued against orders. An order can have several partial refunds.",
  },
  {
    name: "raw_shopify_orders",
    columns: [c("id", "text"), c("name", "text"), c("created_at", "text"), c("total_price", "text"), c("financial_status", "text"), c("email", "text", true)],
    comment: "Raw Shopify order export, loaded by the ingestion job. Not cleaned.",
  },
  {
    name: "raw_stripe_charges",
    columns: [c("charge_id", "text"), c("amount", "int"), c("currency", "text"), c("status", "text"), c("created", "int"), c("order_ref", "text", true)],
  },
  {
    name: "stg_orders",
    columns: [c("order_id", "int"), c("customer_id", "int", true), c("order_ts", "tstz"), c("status", "text"), c("amount_usd", "money")],
  },
  {
    name: "stg_customers",
    columns: [c("customer_id", "int"), c("email", "text"), c("full_name", "text"), c("created_ts", "tstz")],
  },
  {
    name: "orders_backup_2024",
    columns: [c("order_id", "int"), c("customer_id", "int"), c("created_at", "tstz"), c("status", "text"), c("amount_cents", "int")],
  },
  {
    name: "customers_tmp",
    columns: [c("customer_id", "int"), c("email", "text"), c("region_code", "text", true)],
  },
  {
    name: "dim_customers_archive",
    columns: [c("customer_id", "int"), c("email", "text"), c("first_name", "text"), c("last_name", "text"), c("region_code", "text"), c("archived_at", "tstz")],
    primaryKey: ["customer_id"],
  },
  {
    name: "fct_orders_v2_test",
    columns: [
      c("order_id", "int"),
      c("customer_id", "int"),
      c("created_at", "tstz"),
      c("status", "text"),
      c("amount_cents", "int"),
      c("discount_cents", "int"),
      c("ship_region", "text"),
    ],
    primaryKey: ["order_id"],
  },
  {
    name: "report_daily_sales_20250101",
    columns: [c("report_date", "date"), c("region_code", "text"), c("orders", "int"), c("revenue_usd", "money")],
  },
  {
    name: "audit_log",
    columns: [c("audit_id", "int"), c("actor", "text"), c("action", "text"), c("entity", "text"), c("entity_id", "text"), c("logged_at", "tstz")],
  },
  {
    name: "schema_migrations",
    columns: [c("version", "text"), c("applied_at", "tstz")],
  },
  {
    name: "etl_job_runs",
    columns: [c("run_id", "int"), c("job_name", "text"), c("started_at", "tstz"), c("finished_at", "tstz", true), c("state", "text"), c("rows_loaded", "int", true)],
  },
  {
    name: "dim_currency",
    columns: [c("currency_code", "text"), c("currency_name", "text"), c("minor_units", "int")],
    primaryKey: ["currency_code"],
  },
  {
    name: "tmp_import_errors",
    columns: [c("error_id", "int"), c("source_file", "text"), c("line_no", "int"), c("message", "text")],
  },
];

export const LAKE_TABLES: LakeTableDef[] = [
  {
    name: "web_events",
    path: "web_events",
    splitByYear: "event_at",
    columns: [c("event_id", "text"), c("session_id", "text"), c("event_at", "tstz"), c("event_type", "text"), c("page_path", "text")],
  },
  {
    name: "sessions",
    path: "sessions.parquet",
    columns: [c("session_id", "text"), c("customer_id", "int", true), c("started_at", "tstz"), c("utm_channel", "text", true), c("device", "text")],
  },
  {
    name: "marketing_spend",
    path: "marketing_spend.parquet",
    columns: [c("spend_date", "date"), c("channel", "text"), c("spend_cents", "int"), c("impressions", "int"), c("clicks", "int")],
  },
  {
    name: "web_events_2024_archive",
    path: "web_events_2024_archive.parquet",
    columns: [c("event_id", "text"), c("session_id", "text"), c("event_at", "tstz"), c("event_type", "text"), c("page_path", "text"), c("archived_at", "tstz")],
  },
  {
    name: "tmp_session_dedupe",
    path: "tmp_session_dedupe.parquet",
    columns: [c("session_id", "text"), c("duplicate_count", "int"), c("kept", "bool")],
  },
];

// The lake tables the owner cares about; the rest are noise.
export const LAKE_CORE = ["web_events", "sessions", "marketing_spend"];
export const WAREHOUSE_CORE = ["dim_regions", "dim_customers", "dim_products", "fct_orders", "fct_order_items", "fct_refunds"];

export function warehouseTable(name: string): TableDef {
  const t = WAREHOUSE_TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`unknown warehouse table ${name}`);
  return t;
}

// A DuckDB read_csv call over a warehouse CSV with the declared column types.
export function readCsvSql(path: string, table: TableDef, allText = false): string {
  const cols = table.columns.map((col) => `'${col.name}': '${allText ? "VARCHAR" : DUCKDB_TYPES[col.type]}'`).join(", ");
  return `read_csv('${path.replace(/'/g, "''")}', header = true, delim = ',', quote = '"', escape = '"', nullstr = '', columns = {${cols}})`;
}

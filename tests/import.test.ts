import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { importDbt, parseRefExpr, splitRelationName } from "../skills/semantic-layer/scripts/lib/importers/dbt.ts";
import { parseCsv, parseCsvRecords } from "../skills/semantic-layer/scripts/lib/importers/csv.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { IMPORTER_CONFIG, importDdl } from "../skills/semantic-layer/scripts/lib/importers/ddl.ts";
import { importInformationSchema } from "../skills/semantic-layer/scripts/lib/importers/information-schema.ts";
import { detectFormat } from "../skills/semantic-layer/scripts/lib/importers/index.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { FIXED_NOW, initProject, sl, tempRoot } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures", "imports");
const fixture = (name: string) => join(FIX, name);
const read = (name: string) => readFileSync(fixture(name), "utf8");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function table(tables: SnapshotTable[], qualified: string): SnapshotTable {
  const t = tables.find((x) => `${x.schema}.${x.name}` === qualified);
  if (!t) throw new Error(`no table ${qualified} in ${tables.map((x) => `${x.schema}.${x.name}`).join(", ")}`);
  return t;
}

function source(root: string, name: string, dialect: SourceConfig["dialect"], extra: Partial<SourceConfig> = {}): void {
  writeYaml(join(root, "sources", `${name}.yaml`), { source: name, dialect, ...extra });
}

interface ImportJson {
  source: string;
  method: string;
  format: string;
  format_detected: boolean;
  tables: number;
  columns: number;
  primary_keys: number;
  foreign_keys: number;
  warnings: string[];
  next: string;
}

describe("csv", () => {
  test("reads quoted fields with commas, doubled quotes and line breaks, and CRLF records", () => {
    const text = 'Name,"Note, long",N\r\nalpha,"say ""hi"", then\r\nleave",1\r\nbeta,,2\r\n\r\n';
    expect(parseCsvRecords(text)).toEqual([
      ["Name", "Note, long", "N"],
      ["alpha", 'say "hi", then\r\nleave', "1"],
      ["beta", "", "2"],
    ]);
    expect(parseCsv(text)).toEqual([
      { name: "alpha", "note, long": 'say "hi", then\r\nleave', n: "1" },
      { name: "beta", "note, long": "", n: "2" },
    ]);
  });

  test("handles a BOM, a missing final newline, short rows and tab delimiters", () => {
    expect(parseCsv("﻿a,b\n1")).toEqual([{ a: "1", b: "" }]);
    expect(parseCsv("a\tb\nx\ty")).toEqual([{ a: "x", b: "y" }]);
  });

  test("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('a,b\n1,"open\n')).toThrow(/never closed/);
  });
});

describe("information_schema importer", () => {
  test("reads a Postgres CSV export", () => {
    const { tables, warnings } = importInformationSchema(read("info_schema_postgres.csv"));
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual(["public.customers", "public.orders", "reporting.daily_revenue"]);
    const orders = table(tables, "public.orders");
    expect(orders.kind).toBe("table");
    expect(orders.row_count).toBe(10000);
    expect(orders.primary_key).toBeUndefined();
    expect(orders.columns.map((c) => c.name)).toEqual(["order_id", "customer_id", "status", "amount_cents"]);
    const status = orders.columns.find((c) => c.name === "status")!;
    expect(status.nullable).toBe(false);
    expect(status.description).toContain("One of: placed, shipped");
    const customers = table(tables, "public.customers");
    expect(customers.columns[1]).toEqual({
      name: "email",
      type: "character varying",
      nullable: true,
      description: 'The customer\'s email, as entered: may be "unknown"',
    });
    expect(customers.columns[2]!.description).toBeNull();
    expect(table(tables, "reporting.daily_revenue").kind).toBe("view");
    expect(warnings.some((w) => w.includes("system table"))).toBe(true);
  });

  test("reads a Snowflake JSON export with uppercase headers and NUMBER precision", () => {
    const { tables, warnings } = importInformationSchema(read("info_schema_snowflake.json"));
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "MARTS.DIM_CUSTOMERS",
      "MARTS.FCT_ORDERS",
      "MARTS.V_ORDERS_DAILY",
      "RAW.EVENTS_EXT",
    ]);
    const orders = table(tables, "MARTS.FCT_ORDERS");
    expect(orders.columns.map((c) => [c.name, c.type])).toEqual([
      ["ORDER_ID", "NUMBER(38,0)"],
      ["ORDERED_AT", "TIMESTAMP_NTZ"],
      ["ORDER_TOTAL", "NUMBER(12,2)"],
    ]);
    expect(orders.description).toBeNull();
    expect(orders.columns[0]!.description).toBe("One row per order");
    expect(orders.row_count).toBe(125000);
    expect(table(tables, "RAW.EVENTS_EXT").kind).toBe("external");
    expect(table(tables, "MARTS.V_ORDERS_DAILY").kind).toBe("view");
    expect(warnings.some((w) => w.includes("system table"))).toBe(true);
  });

  test("prefixes the catalog when an export spans several catalogs", () => {
    const rows = [
      { table_catalog: "a", table_schema: "s", table_name: "t", column_name: "x", data_type: "int" },
      { table_catalog: "b", table_schema: "s", table_name: "t", column_name: "x", data_type: "int" },
    ];
    const { tables } = importInformationSchema(JSON.stringify({ rows }));
    expect(tables.map((t) => t.schema).sort()).toEqual(["a.s", "b.s"]);
  });

  test("uses udt_name for Postgres USER-DEFINED and ARRAY columns", () => {
    const csv = "table_schema,table_name,column_name,data_type,udt_name\npublic,t,st,USER-DEFINED,order_status\npublic,t,tags,ARRAY,_text\npublic,t,n,integer,int4\n";
    const { tables } = importInformationSchema(csv);
    expect(table(tables, "public.t").columns.map((c) => [c.name, c.type])).toEqual([
      ["st", "order_status"],
      ["tags", "text[]"],
      ["n", "integer"],
    ]);
  });

  test("names the missing required columns", () => {
    expect(() => importInformationSchema("schema,tbl,col\npublic,t,c\n")).toThrow(/missing required columns table_name, column_name, data_type/);
  });
});

describe("information_schema importer: canonical exports", () => {
  const exported = (name: string) => importInformationSchema(read(`exports/${name}`), name);
  const fk = (columns: string[], schema: string | null, tableName: string, refColumns: string[]) => ({ columns, references: { schema, table: tableName, columns: refColumns } });

  test("postgres (psql --csv): keys in key order, a column in two foreign keys, comments, row counts", () => {
    const { tables, warnings } = exported("postgres.csv");
    expect(warnings).toEqual([]);
    expect(tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "public.customers", "public.events", "public.order_lines", "public.orders", "public.shipments", "reporting.daily_revenue", "reporting.v_open_orders",
    ]);
    const customers = table(tables, "public.customers");
    expect(customers).toMatchObject({ kind: "table", row_count: 2000, description: "Customer accounts, one row per customer.", primary_key: ["customer_id"] });
    expect(customers.columns.map((c) => c.name)).toEqual(["customer_id", "email", "region_code"]);
    expect(customers.columns[1]).toEqual({ name: "email", type: "character varying(255)", nullable: true, description: 'Login email; may be "unknown"' });
    expect(customers.foreign_keys).toEqual([fk(["region_code"], "ref", "regions", ["region_code"])]);
    expect(table(tables, "public.events")).toMatchObject({ row_count: null, primary_key: ["event_id"], foreign_keys: [] });
    const lines = table(tables, "public.order_lines");
    expect(lines.primary_key).toEqual(["line_no", "order_id"]);
    expect(lines.columns.find((c) => c.name === "quantity")).toEqual({ name: "quantity", type: "numeric(10,2)", nullable: false, description: "Units ordered.\nNever negative." });
    const orders = table(tables, "public.orders");
    expect(orders.columns.map((c) => c.type)).toEqual(["integer", "integer", "order_status", "bigint", "text[]"]);
    expect(orders.foreign_keys).toEqual([fk(["customer_id"], "public", "customers", ["customer_id"])]);
    const shipments = table(tables, "public.shipments");
    expect(shipments.columns.map((c) => c.name)).toEqual(["shipment_id", "order_id", "line_no", "shipped_at"]);
    expect(shipments.foreign_keys).toEqual([
      fk(["order_id"], "public", "orders", ["order_id"]),
      fk(["order_id", "line_no"], "public", "order_lines", ["order_id", "line_no"]),
    ]);
    expect(table(tables, "reporting.daily_revenue")).toMatchObject({ kind: "view", row_count: 365, primary_key: [] });
    expect(table(tables, "reporting.v_open_orders")).toMatchObject({ kind: "view", row_count: null, description: "Orders not yet shipped." });
  });

  test("redshift (psql --csv): composite primary key and foreign keys to dimensions", () => {
    const { tables, warnings } = exported("redshift.csv");
    expect(warnings).toEqual([]);
    const sales = table(tables, "analytics.fct_sales");
    expect(sales).toMatchObject({ row_count: 88000000, description: "Sales lines, one per invoice line", primary_key: ["invoice_id", "line_number"] });
    expect(sales.foreign_keys).toEqual([
      fk(["customer_key"], "analytics", "dim_customer", ["customer_key"]),
      fk(["date_key"], "analytics", "dim_date", ["date_key"]),
    ]);
    expect(sales.columns.find((c) => c.name === "net_amount")).toMatchObject({ type: "numeric(18,2)", description: "Net of discounts in USD" });
    expect(table(tables, "analytics.v_sales_daily")).toMatchObject({ kind: "view", row_count: null, primary_key: [], foreign_keys: [] });
  });

  test("mysql (--batch --raw): tab-delimited, NULL markers, quoted text with quotes, tabs and line breaks", () => {
    const { tables, warnings } = exported("mysql.tsv");
    expect(warnings).toEqual([]);
    const customers = table(tables, "shop.customers");
    expect(customers).toMatchObject({ row_count: 1980, description: "Customers, one per account", primary_key: ["id"], foreign_keys: [] });
    expect(customers.columns).toEqual([
      { name: "id", type: "int unsigned", nullable: false, description: null },
      { name: "email", type: "varchar(255)", nullable: false, description: '"Primary" contact, lowercased' },
      { name: "tier", type: "enum('free','pro','enterprise')", nullable: true, description: null },
    ]);
    const items = table(tables, "shop.order_items");
    expect(items.description).toBeNull();
    expect(items.primary_key).toEqual(["order_id", "product_id"]);
    expect(items.foreign_keys).toEqual([fk(["order_id"], "shop", "orders", ["id"]), fk(["product_id"], "shop", "products", ["id"])]);
    expect(items.columns[2]).toMatchObject({ type: "decimal(12,2)", description: "Price per unit\tat order time" });
    const orders = table(tables, "shop.orders");
    expect(orders.description).toBe("Orders.\nAmounts in cents.");
    expect(orders.foreign_keys).toEqual([fk(["customer_id"], "shop", "customers", ["id"])]);
    expect(table(tables, "shop.v_revenue")).toMatchObject({ kind: "view", row_count: null });
  });

  test("sqlserver (sqlcmd -s, -W): skips the dashed rule, reads NULL as empty, quoted names, orders a composite foreign key", () => {
    const { tables, warnings } = exported("sqlserver.csv");
    expect(warnings).toEqual([]);
    expect(tables.map((t) => t.name)).toEqual(["Customer", "SalesOrderDetail", "SalesOrderHeader", "vSalesPerson"]);
    const customer = table(tables, "Sales.Customer");
    expect(customer).toMatchObject({ row_count: 19820, description: "Customers, including resellers", primary_key: ["CustomerID"] });
    expect(customer.columns[1]).toEqual({ name: "AccountNumber", type: "varchar(10)", nullable: false, description: "Unique number, as printed" });
    expect(customer.columns[0]!.description).toBeNull();
    const detail = table(tables, "Sales.SalesOrderDetail");
    expect(detail.description).toBeNull();
    expect(detail.primary_key).toEqual(["SalesOrderID", "SalesOrderDetailID"]);
    expect(detail.foreign_keys).toEqual([
      fk(["SalesOrderID"], "Sales", "SalesOrderHeader", ["SalesOrderID"]),
      fk(["SpecialOfferID", "ProductID"], "Sales", "SpecialOfferProduct", ["SpecialOfferID", "ProductID"]),
    ]);
    expect(detail.columns.find((c) => c.name === "LineTotal")!.type).toBe("numeric(38,6)");
    const person = table(tables, "Sales.vSalesPerson");
    expect(person).toMatchObject({ kind: "view", row_count: null });
    expect(person.columns.map((c) => c.name)).toEqual(["BusinessEntityID", "SalesYTD", "Territory, Group"]);
  });

  test("snowflake (snowsql csv): uppercase names, NUMBER precision, external tables", () => {
    const { tables, warnings } = exported("snowflake.csv");
    expect(warnings).toEqual([]);
    const orders = table(tables, "MARTS.FCT_ORDERS");
    expect(orders).toMatchObject({ row_count: 1250000, primary_key: ["ORDER_ID"] });
    expect(orders.foreign_keys).toEqual([fk(["CUSTOMER_ID"], "MARTS", "DIM_CUSTOMERS", ["CUSTOMER_ID"])]);
    expect(orders.columns.map((c) => c.type)).toEqual(["NUMBER(38,0)", "NUMBER(38,0)", "TIMESTAMP_NTZ", "NUMBER(12,2)"]);
    expect(orders.columns[3]!.description).toBe("Gross, in USD");
    expect(table(tables, "MARTS.DIM_CUSTOMERS").description).toBe("One row per customer, current state");
    expect(table(tables, "MARTS.V_ORDERS_DAILY")).toMatchObject({ kind: "view", row_count: null });
    expect(table(tables, "RAW.EVENTS_EXT").kind).toBe("external");
  });

  test("bigquery (bq --format=csv): STRUCT and ARRAY types whole, external tables", () => {
    const { tables, warnings } = exported("bigquery.csv");
    expect(warnings).toEqual([]);
    const customers = table(tables, "analytics.customers");
    expect(customers.columns[1]).toEqual({ name: "address", type: "STRUCT<city STRING, country STRING>", nullable: true, description: "Billing address, as entered" });
    const orders = table(tables, "analytics.orders");
    expect(orders).toMatchObject({ row_count: 880000, primary_key: ["order_id"] });
    expect(orders.foreign_keys).toEqual([fk(["customer_id"], "analytics", "customers", ["customer_id"])]);
    expect(orders.columns.map((c) => c.type)).toEqual(["STRING", "STRING", "NUMERIC(12, 2)", "ARRAY<STRING>", "TIMESTAMP"]);
    expect(table(tables, "analytics.orders_daily").kind).toBe("view");
    expect(table(tables, "raw.clicks").kind).toBe("external");
  });

  test("databricks (SQL editor download): zero-based ordinals, full types, no row counts", () => {
    const { tables, warnings } = exported("databricks.csv");
    expect(warnings).toEqual([]);
    const sales = table(tables, "gold.fct_sales");
    expect(sales).toMatchObject({ kind: "table", row_count: null, primary_key: ["sale_id"] });
    expect(sales.columns.map((c) => [c.name, c.type])).toEqual([
      ["sale_id", "bigint"], ["store_id", "int"], ["amount", "decimal(10,2)"], ["tags", "array<string>"], ["sold_at", "timestamp"],
    ]);
    expect(sales.foreign_keys).toEqual([fk(["store_id"], "gold", "dim_store", ["store_id"])]);
    expect(table(tables, "gold.dim_store").description).toBe("Stores and their region");
    expect(table(tables, "gold.v_sales_by_day").kind).toBe("view");
    expect(table(tables, "bronze.raw_events").kind).toBe("external");
  });

  test("foreign keys without fk_name group by referenced table, split where fk_ordinal restarts or a referenced column repeats", () => {
    const header = "table_schema,table_name,column_name,data_type,ordinal_position,references_table,references_column,fk_ordinal";
    const ordered = [
      header,
      "s,shipments,order_id,int,1,order_lines,order_id,1",
      "s,shipments,line_no,int,2,order_lines,line_no,2",
      "s,shipments,return_order_id,int,3,order_lines,order_id,1",
      "s,shipments,return_line_no,int,4,order_lines,line_no,2",
    ].join("\n");
    expect(table(importInformationSchema(ordered).tables, "s.shipments").foreign_keys).toEqual([
      fk(["order_id", "line_no"], "s", "order_lines", ["order_id", "line_no"]),
      fk(["return_order_id", "return_line_no"], "s", "order_lines", ["order_id", "line_no"]),
    ]);
    const unordered = [
      "table_schema,table_name,column_name,data_type,references_schema,references_table,references_column",
      "s,orders,bill_to,int,s,addresses,address_id",
      "s,orders,ship_to,int,s,addresses,address_id",
      "s,orders,customer_id,int,crm,customers,id",
    ].join("\n");
    const orders = table(importInformationSchema(unordered).tables, "s.orders");
    expect(orders.foreign_keys).toEqual([
      fk(["bill_to"], "s", "addresses", ["address_id"]),
      fk(["ship_to"], "s", "addresses", ["address_id"]),
      fk(["customer_id"], "crm", "customers", ["id"]),
    ]);
    expect(orders.primary_key).toBeUndefined();
  });

  test("primary key falls back to column order without pk_ordinal; t/f and yes/no flags read as booleans", () => {
    const csv = ["table_name,column_name,data_type,ordinal_position,is_primary_key", "t,b,int,2,t", "t,a,int,1,YES", "t,c,int,3,f"].join("\n");
    const t = importInformationSchema(csv).tables[0]!;
    expect(t.primary_key).toEqual(["a", "b"]);
    expect(t.foreign_keys).toBeUndefined();
  });

  test("a repeated column row with no foreign key is still reported", () => {
    const csv = ["table_name,column_name,data_type,references_table,references_column", "t,a,int,u,id", "t,a,int,v,id", "t,b,int,,", "t,b,int,,"].join("\n");
    const { tables, warnings } = importInformationSchema(csv);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(tables[0]!.foreign_keys!.map((k) => k.references.table)).toEqual(["u", "v"]);
    expect(warnings).toContain("Ignored 1 repeated column row.");
  });

  test("a JSON array export with keys imports the same way", () => {
    const rows = [
      { TABLE_SCHEMA: "s", TABLE_NAME: "a", COLUMN_NAME: "id", DATA_TYPE: "int", IS_PRIMARY_KEY: true, PK_ORDINAL: 1, ROW_COUNT: 7, TABLE_COMMENT: "A things" },
      { TABLE_SCHEMA: "s", TABLE_NAME: "b", COLUMN_NAME: "a_id", DATA_TYPE: "int", IS_PRIMARY_KEY: false, FK_NAME: "b_a", FK_ORDINAL: 1, REFERENCES_SCHEMA: "s", REFERENCES_TABLE: "a", REFERENCES_COLUMN: "id" },
    ];
    const { tables } = importInformationSchema(JSON.stringify(rows));
    expect(table(tables, "s.a")).toMatchObject({ primary_key: ["id"], row_count: 7, description: "A things", foreign_keys: [] });
    expect(table(tables, "s.b").foreign_keys).toEqual([fk(["a_id"], "s", "a", ["id"])]);
  });
});

describe("import format detection", () => {
  test("reads the format from the file name and content", () => {
    expect(detectFormat("x.sql", "anything")).toBe("ddl");
    expect(detectFormat("x.DDL", "")).toBe("ddl");
    expect(detectFormat("manifest.json", JSON.stringify({ metadata: {}, nodes: {} }))).toBe("dbt_manifest");
    expect(detectFormat("cols.json", "[]")).toBe("information_schema");
    expect(detectFormat("cols.json", JSON.stringify({ rows: [{ table_name: "t" }] }))).toBe("information_schema");
    expect(detectFormat("schema.csv", "anything")).toBe("information_schema");
    expect(detectFormat("schema.tsv", "a\tb")).toBe("information_schema");
    expect(detectFormat("export", "TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME\ns,t,c")).toBe("information_schema");
    expect(detectFormat("export", '"table_name";"column_name"\nt;c')).toBe("information_schema");
    expect(detectFormat("dump.txt", "-- dumped\n/* header */\nCREATE TABLE t (a int);")).toBe("ddl");
    expect(detectFormat("notes.txt", "hello world")).toBeNull();
    expect(detectFormat("x.json", JSON.stringify({ a: 1 }))).toBeNull();
    expect(() => detectFormat("x.json", "{ nope")).toThrow(/looks like JSON but does not parse/);
    expect(() => detectFormat("catalog.json", read("dbt/catalog.json"))).toThrow(
      "catalog.json is a dbt catalog.json: pass target/manifest.json with --file and this file with --catalog.",
    );
    expect(detectFormat("manifest.json", read("dbt/manifest.json"))).toBe("dbt_manifest");
  });
});

describe("dbt importer", () => {
  test("parses relation names and ref/source expressions", () => {
    expect(splitRelationName('"jaffle"."analytics"."fct_orders"')).toEqual(["jaffle", "analytics", "fct_orders"]);
    expect(splitRelationName("`proj`.`ds`.`t`")).toEqual(["proj", "ds", "t"]);
    expect(splitRelationName("ANALYTICS.MARTS.ORDERS")).toEqual(["ANALYTICS", "MARTS", "ORDERS"]);
    expect(parseRefExpr("ref('customers')")).toEqual({ kind: "ref", pkg: null, name: "customers", version: null });
    expect(parseRefExpr('{{ ref("pkg", "orders", v=2) }}')).toEqual({ kind: "ref", pkg: "pkg", name: "orders", version: "2" });
    expect(parseRefExpr("source('raw','payments')")).toEqual({ kind: "source", source: "raw", table: "payments" });
    expect(parseRefExpr("{{ get_where_subquery(ref('orders')) }}")).toMatchObject({ name: "orders" });
  });

  test("reads models, seeds and sources with tests as keys, and the catalog for types and row counts", () => {
    const { tables, warnings } = importDbt(read("dbt/manifest.json"), read("dbt/catalog.json"));
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "analytics.customers",
      "analytics.fct_orders",
      "analytics.order_items",
      "raw.payments_v2",
      "reporting.order_summary",
      "seeds.country_codes",
    ]);
    const customers = table(tables, "analytics.customers");
    expect(customers.description).toBe("One row per customer, with lifetime order stats.");
    expect(customers.row_count).toBe(2000);
    expect(customers.primary_key).toEqual(["customer_id"]);
    expect(customers.unique_keys).toEqual([["email"]]);
    expect(customers.columns.map((c) => [c.name, c.type])).toEqual([
      ["customer_id", "integer"],
      ["email", "text"],
      ["first_order_at", "timestamp with time zone"],
      ["lifetime_value", "numeric(12,2)"],
    ]);
    expect(customers.columns[0]).toMatchObject({ nullable: false, description: "Primary key of the customer." });
    expect(customers.columns[2]!.description).toBe("Set by the loader");

    const orders = table(tables, "analytics.fct_orders");
    expect(orders.primary_key).toEqual(["order_id"]);
    expect(orders.foreign_keys).toEqual([{ columns: ["customer_id"], references: { schema: "analytics", table: "customers", columns: ["customer_id"] } }]);
    expect(orders.columns.find((c) => c.name === "status")!.type).toBe("character varying(20)");
    expect(orders.columns.some((c) => c.name === "country")).toBe(false);

    const items = table(tables, "analytics.order_items");
    expect(items.primary_key).toEqual([]);
    expect(items.unique_keys).toEqual([["order_id", "line_number"]]);
    expect(items.foreign_keys).toEqual([{ columns: ["order_id"], references: { schema: "analytics", table: "fct_orders", columns: ["order_id"] } }]);

    const payments = table(tables, "raw.payments_v2");
    expect(payments.description).toBe("Payments as loaded by the ingestion tool.");
    expect(payments.row_count).toBe(11000);
    expect(payments.foreign_keys).toEqual([{ columns: ["order_id"], references: { schema: "analytics", table: "fct_orders", columns: ["order_id"] } }]);

    expect(table(tables, "reporting.order_summary").kind).toBe("view");
    expect(warnings.some((w) => w.includes("ephemeral"))).toBe(true);
    expect(warnings.some((w) => w.includes("could not be resolved"))).toBe(true);
  });

  test("without a catalog, keeps documented types and asks for catalog.json", () => {
    const { tables, warnings } = importDbt(read("dbt/manifest.json"));
    const orders = table(tables, "analytics.fct_orders");
    expect(orders.columns.map((c) => [c.name, c.type])).toEqual([
      ["order_id", "integer"],
      ["customer_id", "integer"],
      ["status", "text"],
      ["country", "unknown"],
    ]);
    expect(table(tables, "analytics.order_items").columns.map((c) => c.name)).toEqual(["order_id", "line_number"]);
    expect(warnings.some((w) => w.includes("--catalog"))).toBe(true);
  });

  test("reads tests on quoted column names, and warns about tests on columns the table lacks", () => {
    const manifest = {
      metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
      nodes: {
        "model.p.orders": {
          resource_type: "model", name: "orders", package_name: "p", schema: "s", alias: "orders", database: "d", config: { materialized: "table" },
          columns: { "Order Id": { name: "Order Id", data_type: "int" }, total: { name: "total", data_type: "int" } },
        },
        "test.p.unique_orders_order_id": {
          resource_type: "test", name: "unique_orders_order_id", package_name: "p", attached_node: "model.p.orders", column_name: '"Order Id"',
          test_metadata: { name: "unique", kwargs: { column_name: '"Order Id"', model: "{{ get_where_subquery(ref('orders')) }}" } },
        },
        "test.p.not_null_orders_order_id": {
          resource_type: "test", name: "not_null_orders_order_id", package_name: "p", attached_node: "model.p.orders", column_name: '"Order Id"',
          test_metadata: { name: "not_null", kwargs: { column_name: '"Order Id"', model: "{{ get_where_subquery(ref('orders')) }}" } },
        },
        "test.p.unique_orders_gone": {
          resource_type: "test", name: "unique_orders_gone", package_name: "p", attached_node: "model.p.orders", column_name: "gone column",
          test_metadata: { name: "unique", kwargs: { column_name: "gone column", model: "{{ get_where_subquery(ref('orders')) }}" } },
        },
      },
      sources: {},
    };
    const { tables, warnings } = importDbt(JSON.stringify(manifest));
    expect(table(tables, "s.orders").primary_key).toEqual(["Order Id"]);
    expect(warnings.some((w) => w.startsWith("1 unique, not_null or unique_combination_of_columns test names a column not found"))).toBe(true);
  });

  test("reads contract constraints", () => {
    const manifest = {
      metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v11.json" },
      nodes: {
        "model.p.a": {
          resource_type: "model", name: "a", package_name: "p", schema: "s", alias: "a", database: "d", config: { materialized: "table" },
          columns: { id: { name: "id", data_type: "int", constraints: [{ type: "not_null" }, { type: "primary_key" }] } },
        },
        "model.p.b": {
          resource_type: "model", name: "b", package_name: "p", schema: "s", alias: "b", database: "d", config: { materialized: "table" },
          columns: { a_id: { name: "a_id", data_type: "int", constraints: [{ type: "foreign_key", to: "ref('a')", to_columns: ["id"] }] } },
          constraints: [{ type: "primary_key", columns: ["a_id"] }],
        },
      },
      sources: {},
    };
    const { tables } = importDbt(JSON.stringify(manifest));
    expect(table(tables, "s.a").primary_key).toEqual(["id"]);
    expect(table(tables, "s.b").primary_key).toEqual(["a_id"]);
    expect(table(tables, "s.b").foreign_keys).toEqual([{ columns: ["a_id"], references: { schema: "s", table: "a", columns: ["id"] } }]);
  });
});

describe("ddl importer", () => {
  test("reads pg_dump output: ALTER TABLE keys, unique indexes, comments, enum types, views", async () => {
    const { tables, warnings } = await importDdl(read("ddl_postgres.sql"), "postgres");
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "public.audit_log",
      "sales.customer_orders",
      "sales.customers",
      "sales.order_lines",
      "sales.orders",
    ]);
    const customers = table(tables, "sales.customers");
    expect(customers.description).toBe("One row per customer; test accounts excluded.");
    expect(customers.primary_key).toEqual(["customer_id"]);
    expect(customers.unique_keys).toEqual([["email"]]);
    expect(customers.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["customer_id", "integer", false],
      ["email", "character varying(255)", false],
      ["Region", "text", true],
      ["created_at", "timestamp with time zone", false],
      ["tags", "text[]", true],
      ["profile", "jsonb", true],
    ]);
    expect(customers.columns[1]!.description).toBe("Login email, lowercased");

    const orders = table(tables, "sales.orders");
    expect(orders.primary_key).toEqual(["order_id"]);
    expect(orders.columns[0]).toMatchObject({ name: "order_id", type: "bigint", nullable: false });
    expect(orders.columns.find((c) => c.name === "status")!.type).toBe("sales.order_status");
    expect(orders.foreign_keys).toEqual([{ columns: ["customer_id"], references: { schema: "sales", table: "customers", columns: ["customer_id"] } }]);

    const lines = table(tables, "sales.order_lines");
    expect(lines.primary_key).toEqual(["order_id", "line_number"]);
    expect(lines.foreign_keys).toEqual([{ columns: ["order_id"], references: { schema: "sales", table: "orders", columns: ["order_id"] } }]);

    const view = table(tables, "sales.customer_orders");
    expect(view.kind).toBe("view");
    expect(view.description).toBe("Orders per customer");
    expect(view.columns.map((c) => c.name)).toEqual(["customer_id", "orders", "amount_cents"]);

    expect(table(tables, "public.audit_log").primary_key).toEqual(["id"]);
    expect(warnings.some((w) => w.startsWith("Skipped CREATE VIEW sales.monthly_labels:") && w.includes("to_char"))).toBe(true);
    expect(warnings.some((w) => w.includes("order_lines_2025") && w.includes("partition"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("Ignored") && w.includes("CREATE SEQUENCE (1)"))).toBe(true);
  });

  test("reads mysqldump output: backticks, inline comments, KEY lines, table options, versioned comments", async () => {
    const { tables, warnings } = await importDdl(read("ddl_mysql.sql"), "duckdb");
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual(["shop.order_items", "shop.orders", "shop.paid_orders", "shop.products"]);
    const items = table(tables, "shop.order_items");
    expect(items.description).toBe("Order lines");
    expect(items.primary_key).toEqual(["id"]);
    expect(items.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "int(11) unsigned"],
      ["order_id", "int(11)"],
      ["product_id", "int(11)"],
      ["qty", "smallint(6)"],
      ["unit_price", "decimal(10,2)"],
    ]);
    expect(items.columns[1]!.description).toBe("The order this line belongs to");
    expect(items.columns[4]!.description).toBe("Price per unit, in EUR; it's VAT inclusive");
    expect(items.foreign_keys).toEqual([
      { columns: ["order_id"], references: { schema: "shop", table: "orders", columns: ["id"] } },
      { columns: ["product_id"], references: { schema: "shop", table: "products", columns: ["id"] } },
    ]);
    const orders = table(tables, "shop.orders");
    expect(orders.unique_keys).toEqual([["customer_email", "created_at"]]);
    expect(orders.columns.find((c) => c.name === "status")!.type).toBe("enum('new','paid','shipped','refunded')");
    expect(orders.columns.find((c) => c.name === "updated_at")!.nullable).toBe(true);
    const products = table(tables, "shop.products");
    expect(products.columns.map((c) => c.name)).toEqual(["id", "sku", "name", "key"]);
    expect(products.columns[3]!.description).toBe("Legacy lookup key");
    expect(products.unique_keys).toEqual([["sku"]]);
    expect(table(tables, "shop.paid_orders").kind).toBe("view");
    expect(warnings.some((w) => w.startsWith("Skipped CREATE VIEW shop.legacy_returns:") && w.includes("returns"))).toBe(true);
  });

  test("reads Snowflake get_ddl output: three-part names, NUMBER and VARIANT, external tables, secure views", async () => {
    const { tables, warnings } = await importDdl(read("ddl_snowflake.sql"), "snowflake");
    expect(tables.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "MARTS.CUSTOMER_REVENUE",
      "MARTS.DIM_CUSTOMERS",
      "MARTS.DIM_DATES",
      "MARTS.FCT_ORDERS",
      "RAW.WEB_EVENTS",
    ]);
    const dates = table(tables, "MARTS.DIM_DATES");
    expect(dates.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["DATE_DAY", "DATE", false],
      ["PERIOD", "VARCHAR(7)", true],
    ]);
    expect(dates.columns[1]!.description).toBe("Year and month, as YYYY-MM");
    const customers = table(tables, "MARTS.DIM_CUSTOMERS");
    expect(customers.description).toBe("One row per customer");
    expect(customers.primary_key).toEqual(["CUSTOMER_ID"]);
    expect(customers.columns.map((c) => [c.name, c.type])).toEqual([
      ["CUSTOMER_ID", "NUMBER(38,0)"],
      ["EMAIL", "VARCHAR(16777216)"],
      ["SIGNUP_AT", "TIMESTAMP_NTZ(9)"],
      ["ATTRIBUTES", "VARIANT"],
    ]);
    expect(customers.columns[0]!.description).toBe("Surrogate key");
    const orders = table(tables, "MARTS.FCT_ORDERS");
    expect(orders.description).toBe("One row per order");
    expect(orders.primary_key).toEqual(["ORDER_ID"]);
    expect(orders.columns.map((c) => c.name)).toContain("lineItems");
    expect(orders.columns.find((c) => c.name === "ORDER_TOTAL")!.description).toBe("Order total in USD");
    expect(orders.foreign_keys).toEqual([{ columns: ["CUSTOMER_ID"], references: { schema: "MARTS", table: "DIM_CUSTOMERS", columns: ["CUSTOMER_ID"] } }]);
    const events = table(tables, "RAW.WEB_EVENTS");
    expect(events.kind).toBe("external");
    expect(events.columns.map((c) => [c.name, c.type])).toEqual([
      ["EVENT_ID", "VARCHAR"],
      ["EVENT_DATE", "DATE"],
      ["USER_ID", "NUMBER(38,0)"],
    ]);
    const view = table(tables, "MARTS.CUSTOMER_REVENUE");
    expect(view.kind).toBe("view");
    expect(view.description).toBe("Revenue per customer, completed orders only");
    expect(view.columns.map((c) => c.name)).toEqual(["CUSTOMER_ID", "REVENUE"]);
    expect(view.columns[0]!.description).toBe("The customer");
    expect(warnings.some((w) => w.startsWith("Skipped CREATE VIEW ANALYTICS.MARTS.ORDER_ITEMS_FLAT:"))).toBe(true);
    expect(warnings.some((w) => w.includes("CREATE STAGE"))).toBe(true);
  });

  test("keeps the catalog in the schema when tables span databases, and reads Hive partition columns", async () => {
    const ddl = `
      CREATE TABLE lake.web.events (id BIGINT, payload STRING) PARTITIONED BY (dt STRING) STORED AS PARQUET LOCATION 's3://b/events';
      CREATE TABLE crm.public.accounts (id BIGINT PRIMARY KEY);
      CREATE TABLE lake.web.sessions (account_id BIGINT REFERENCES crm.public.accounts);
    `;
    const { tables } = await importDdl(ddl, "databricks");
    const events = table(tables, "lake.web.events");
    expect(events.kind).toBe("external");
    expect(events.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "BIGINT"],
      ["payload", "STRING"],
      ["dt", "STRING"],
    ]);
    expect(table(tables, "lake.web.sessions").foreign_keys).toEqual([
      { columns: ["account_id"], references: { schema: "crm.public", table: "accounts", columns: ["id"] } },
    ]);
  });

  test("backticks and MySQL words inside Postgres strings and comments keep double-quoted identifiers", async () => {
    const ddl = `
      -- Unlike MySQL there is no AUTO_INCREMENT or ENGINE = here.
      CREATE TABLE "public"."Orders" ("Id" integer PRIMARY KEY, "Amount Cents" bigint);
      COMMENT ON TABLE "public"."Orders" IS 'Use \`amount\`, not the AUTO_INCREMENT id';
      COMMENT ON COLUMN "public"."Orders"."Amount Cents" IS 'In cents';
    `;
    for (const dialect of ["postgres", "duckdb"] as const) {
      const { tables, warnings } = await importDdl(ddl, dialect);
      const orders = table(tables, "public.Orders");
      expect(orders.description).toBe("Use `amount`, not the AUTO_INCREMENT id");
      expect(orders.primary_key).toEqual(["Id"]);
      expect(orders.columns.map((c) => [c.name, c.description])).toEqual([
        ["Id", null],
        ["Amount Cents", "In cents"],
      ]);
      expect(warnings).toEqual([]);
    }
  });

  test("columns named period, exclude, check, fulltext or spatial are columns, not constraints", async () => {
    const { tables, warnings } = await importDdl(
      "create table s.t (id int primary key, period varchar(7), exclude boolean, check int, fulltext varchar(10), spatial text, constraint c check (id > 0));",
      "postgres",
    );
    expect(table(tables, "s.t").columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "int"],
      ["period", "varchar(7)"],
      ["exclude", "boolean"],
      ["check", "int"],
      ["fulltext", "varchar(10)"],
      ["spatial", "text"],
    ]);
    expect(warnings).toEqual([]);
    const mysql = await importDdl(
      "CREATE TABLE `t` (`id` int, `body` text, `g` text, FULLTEXT KEY `ft` (`body`), FULLTEXT `ft2` (`body`), SPATIAL INDEX (`g`)) ENGINE=InnoDB;",
      "duckdb",
    );
    expect(mysql.tables[0]!.columns.map((c) => c.name)).toEqual(["id", "body", "g"]);
  });

  test("keeps STRUCT, MAP and ARRAY<...> types whole for BigQuery and Databricks", async () => {
    const bq = await importDdl(
      'CREATE TABLE `proj.ds.t` (id INT64, s STRUCT<a INT64, b STRING>, arr ARRAY<STRING>, n ARRAY<STRUCT<x INT64, y ARRAY<STRING>>> OPTIONS(description="Nested lines"), r RANGE<DATE>)',
      "bigquery",
    );
    const t = table(bq.tables, "ds.t");
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "INT64"],
      ["s", "STRUCT<a INT64, b STRING>"],
      ["arr", "ARRAY<STRING>"],
      ["n", "ARRAY<STRUCT<x INT64, y ARRAY<STRING>>>"],
      ["r", "RANGE<DATE>"],
    ]);
    expect(t.columns[3]!.description).toBe("Nested lines");
    const dbx = await importDdl(
      "CREATE TABLE spark_catalog.default.t (id BIGINT, s STRUCT<a: INT, b: STRING>, m MAP<STRING, INT>, period STRING COMMENT 'YYYY-MM') USING delta",
      "databricks",
    );
    expect(table(dbx.tables, "default.t").columns.map((c) => [c.name, c.type, c.description])).toEqual([
      ["id", "BIGINT", null],
      ["s", "STRUCT<a: INT, b: STRING>", null],
      ["m", "MAP<STRING, INT>", null],
      ["period", "STRING", "YYYY-MM"],
    ]);
  });

  test("COMMENT ON finds a table whether or not either statement names the default schema", async () => {
    const a = await importDdl(
      "create table orders (id int); comment on table public.orders is 'x'; comment on column public.orders.id is 'y'; create view v as select * from public.orders;",
      "postgres",
    );
    expect(a.warnings).toEqual([]);
    expect(table(a.tables, "public.orders")).toMatchObject({ description: "x", columns: [{ name: "id", description: "y" }] });
    expect(table(a.tables, "public.v").columns.map((c) => c.name)).toEqual(["id"]);
    const b = await importDdl("create table public.orders (id int); comment on table orders is 'x'; comment on column orders.id is 'y';", "postgres");
    expect(b.warnings).toEqual([]);
    expect(table(b.tables, "public.orders")).toMatchObject({ description: "x", columns: [{ name: "id", description: "y" }] });
    const c = await importDdl("create table orders (id int); create table public.orders (id int, extra int);", "postgres");
    expect(c.tables.length).toBe(1);
  });

  test("a CREATE TABLE or VIEW whose name cannot be read is reported as skipped", async () => {
    const { tables, warnings } = await importDdl("create table (id int); create table ok (id int);", "postgres");
    expect(tables.map((t) => t.name)).toEqual(["ok"]);
    expect(warnings).toEqual(['Skipped CREATE TABLE: could not read the name at "(id int)".']);
  });

  test("unqualified names take the dialect's default schema", async () => {
    const { tables } = await importDdl("create table t (a int not null, b text);", "postgres");
    expect(tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.t"]);
    const none = await importDdl("create table t (a int);", "bigquery");
    expect(none.tables[0]!.schema).toBeNull();
  });
});

describe("ddl importer: untrusted input", () => {
  // A local HTTP server that counts every request, standing in for an attacker's beacon.
  function beacon(): { url: string; hits: () => number; stop: () => void } {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        hits++;
        return new Response("a,b\n1,2\n");
      },
    });
    return { url: `http://127.0.0.1:${server.port}/beacon.csv`, hits: () => hits, stop: () => server.stop(true) };
  }

  test("evil.sql: a CTAS over read_text and a view over an HTTP CSV import neither the file nor any network access", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const b = beacon();
    try {
      const secretPath = join(t.dir, "secret.txt");
      writeFileSync(secretPath, "TOP-SECRET-CONTENT\n");
      const localCsv = join(t.dir, "local.csv");
      writeFileSync(localCsv, "private_col\nPRIVATE-VALUE\n");
      const evil = join(t.dir, "evil.sql");
      writeFileSync(
        evil,
        [
          `CREATE TABLE leak AS SELECT * FROM read_text('${secretPath}');`,
          `CREATE VIEW beacon AS SELECT * FROM read_csv('${b.url}');`,
          `CREATE VIEW local_file AS SELECT * FROM read_csv('${localCsv}');`,
          `INSTALL httpfs; LOAD httpfs; SET enable_external_access = true; ATTACH '${join(t.dir, "x.duckdb")}' AS x;`,
          `CREATE TABLE leak2 AS SELECT * FROM read_text('${secretPath}');`,
          "CREATE TABLE ok (id integer primary key, label text);",
        ].join("\n"),
      );
      await initProject(t.root);
      source(t.root, "s", "duckdb");
      const r = await sl(t.root, ["import", "--source", "s", "--format", "ddl", "--file", evil]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Imported 1 table");
      expect(r.out).toContain("Skipped CREATE TABLE main.leak: it reads a file, a URL or an extension, which the importer does not open.");
      expect(r.out).toContain("Skipped CREATE VIEW main.beacon: it reads a file, a URL or an extension");
      expect(r.out).toContain("Skipped CREATE VIEW main.local_file: it reads a file, a URL or an extension");
      expect(r.out).toContain("Skipped CREATE TABLE main.leak2:");
      expect(r.out + r.err).not.toContain("Autoloading");
      const snapText = readFileSync(join(t.root, "snapshots", "s.json"), "utf8");
      const snap = JSON.parse(snapText) as Snapshot;
      expect(snap.tables.map((x) => x.name)).toEqual(["ok"]);
      for (const leaked of ["TOP-SECRET", "PRIVATE-VALUE", "private_col", "filename", "content"]) {
        expect(snapText).not.toContain(leaked);
        expect(r.out).not.toContain(leaked);
      }
      expect(b.hits()).toBe(0);
      expect(existsSync(join(t.dir, "x.duckdb"))).toBe(false);
    } finally {
      b.stop();
    }
  });

  test("the importer's DuckDB has external access and extension loading off, no readable directory, and its configuration locked", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const instance = await DuckDBInstance.create(":memory:", IMPORTER_CONFIG);
    const c = await instance.connect();
    try {
      const rows = (await c.runAndReadAll(
        `select name, value from duckdb_settings() where name in ('enable_external_access', 'autoinstall_known_extensions', 'autoload_known_extensions',
          'allow_community_extensions', 'allowed_directories', 'temp_directory', 'secret_directory', 'threads', 'lock_configuration') order by name`,
      )).getRowObjectsJson();
      expect(rows).toEqual([
        { name: "allow_community_extensions", value: "false" },
        { name: "allowed_directories", value: "[]" },
        { name: "autoinstall_known_extensions", value: "false" },
        { name: "autoload_known_extensions", value: "false" },
        { name: "enable_external_access", value: "false" },
        { name: "lock_configuration", value: "true" },
        { name: "secret_directory", value: "/nonexistent" },
        { name: "temp_directory", value: "" },
        { name: "threads", value: "1" },
      ]);
      await expect(c.run("SET enable_external_access = true")).rejects.toThrow(/locked/);
      await expect(c.run("SET temp_directory = '/tmp'")).rejects.toThrow();
      // Sent to DuckDB directly, not through the importer's statement filter.
      await expect(c.run("LOAD httpfs")).rejects.toThrow(/Permission Error/);
      await expect(c.run("INSTALL httpfs")).rejects.toThrow(/Permission Error/);
      await expect(c.run(`ATTACH '${join(t.dir, "x.duckdb")}' AS x`)).rejects.toThrow(/Permission Error/);
      await expect(c.run(`COPY (SELECT 1) TO '${join(t.dir, "out.csv")}'`)).rejects.toThrow(/Permission Error/);
      await c.run("ATTACH ':memory:' AS scratch");
      expect(existsSync(join(t.dir, "x.duckdb"))).toBe(false);
      expect(existsSync(join(t.dir, "out.csv"))).toBe(false);
    } finally {
      c.closeSync();
      instance.closeSync();
    }
  });

  test("files under the working directory's .tmp/ stay unreadable: a CSV header or JSON key never becomes a column name", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const work = join(t.dir, "work");
    mkdirSync(join(work, ".tmp"), { recursive: true });
    writeFileSync(join(work, ".tmp", "creds.txt"), "host=db.internal\nPGPASSWORD=hunter2-SECRET\n");
    writeFileSync(join(work, ".tmp", "y.json"), '{"JSON-KEY-SECRET": 1}\n');
    writeFileSync(join(work, ".tmp", "x.csv"), "CSV-HEADER-SECRET\n1\n");
    const evil = join(work, "evil.sql");
    writeFileSync(
      evil,
      [
        "create view leak as select * from read_csv('.tmp/creds.txt', header=true, skip=1, delim='|');",
        "create view leak_json as select * from read_json_auto('.tmp/y.json');",
        "create view leak_csv as select * from '.tmp/x.csv';",
        "create table leak_ctas as select * from read_csv('.tmp/creds.txt', header=true, skip=1, delim='|');",
        "create table ok (id integer);",
      ].join("\n"),
    );
    await initProject(t.root);
    source(t.root, "s", "duckdb");
    const before = process.cwd();
    process.chdir(work);
    let r: Awaited<ReturnType<typeof sl>>;
    try {
      r = await sl(t.root, ["import", "--source", "s", "--format", "ddl", "--file", evil]);
    } finally {
      process.chdir(before);
    }
    expect(r.code).toBe(0);
    expect(r.out).toContain("Imported 1 table");
    expect(r.out).toContain("Skipped CREATE VIEW main.leak: it reads a file, a URL or an extension");
    expect(r.out).toContain("Skipped CREATE VIEW main.leak_json: it reads a file, a URL or an extension");
    expect(r.out).toContain("Skipped CREATE VIEW main.leak_csv:");
    expect(r.out).toContain("Skipped CREATE TABLE main.leak_ctas: it reads a file, a URL or an extension");
    const snapText = readFileSync(join(t.root, "snapshots", "s.json"), "utf8");
    for (const leaked of ["hunter2", "PGPASSWORD", "db.internal", "JSON-KEY-SECRET", "CSV-HEADER-SECRET"]) {
      expect(snapText).not.toContain(leaked);
      expect(r.out + r.err).not.toContain(leaked);
    }
  });

  test("no setting names a home-directory path through a column type", async () => {
    const { tables } = await importDdl(
      `create view v4 as select json_transform('{}', '{"' || current_setting('secret_directory') || '":"INT"}') as x;`,
      "duckdb",
    );
    const text = JSON.stringify(tables);
    expect(text).not.toContain("stored_secrets");
    expect(text).not.toContain(homedir());
  });

  test("a statement nested deeper than the importer reads is skipped instead of crashing DuckDB", async () => {
    const deep = "[".repeat(20_000) + '"INT"' + "]".repeat(20_000);
    const parens = "(".repeat(300) + "1" + ")".repeat(300);
    const { tables, warnings } = await importDdl(
      [
        `create view deep as select json_transform('[]', '${deep}') as x;`,
        `create table deep2 as select ${parens} as y;`,
        `create view shallow as select json_transform('[]', '${"[".repeat(20)}"INT"${"]".repeat(20)}') as x;`,
      ].join("\n"),
      "duckdb",
    );
    expect(tables.map((x) => x.name)).toEqual(["shallow"]);
    expect(warnings).toContain('Skipped a statement starting "create view deep": nested deeper than 256 levels, which the importer does not read.');
    expect(warnings).toContain('Skipped a statement starting "create table deep2": nested deeper than 256 levels, which the importer does not read.');
  });

  test("a CTAS or view whose query has a CTE named data imports; trailing WITH [NO] DATA and CHECK OPTION are dropped", async () => {
    const { tables, warnings } = await importDdl(
      [
        "create table t as with data as (select 1 as a) select * from data;",
        "create view v as with data as (select 1 as a, 'x' as b) select * from data;",
        "create table t2 as with data as (select 2 as c) select * from data with no data;",
        "create table t3 as select 3 as d with data and no statistics;",
        "create view v2 as with local as (select 4 as e) select * from local with cascaded check option;",
        "create view v3 as select 5 as f with check option;",
      ].join("\n"),
      "postgres",
    );
    expect(warnings).toEqual([]);
    expect(table(tables, "public.t").columns.map((c) => [c.name, c.type])).toEqual([["a", "INTEGER"]]);
    expect(table(tables, "public.t").kind).toBe("table");
    expect(table(tables, "public.v").columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(table(tables, "public.t2").columns.map((c) => c.name)).toEqual(["c"]);
    expect(table(tables, "public.t3").columns.map((c) => c.name)).toEqual(["d"]);
    expect(table(tables, "public.v2").columns.map((c) => c.name)).toEqual(["e"]);
    expect(table(tables, "public.v3").columns.map((c) => c.name)).toEqual(["f"]);
  });

  test("a CTAS keeps its comments and can be replaced by a table with a column list", async () => {
    const { tables, warnings } = await importDdl(
      [
        "create table a as select 1 as x;",
        "comment on table a is 'from a query';",
        "comment on column a.x is 'the x';",
        "create or replace table b as select 1 as y;",
        "create or replace table b (z int not null);",
        "create or replace view c as select 1 as p;",
        "create or replace table c as select 2 as q;",
      ].join("\n"),
      "postgres",
    );
    expect(warnings).toEqual([]);
    const a = table(tables, "public.a");
    expect(a.description).toBe("from a query");
    expect(a.columns[0]!.description).toBe("the x");
    expect(table(tables, "public.b").columns.map((c) => [c.name, c.nullable])).toEqual([["z", false]]);
    expect(table(tables, "public.c").columns.map((c) => c.name)).toEqual(["q"]);
    expect(table(tables, "public.c").kind).toBe("table");
  });

  test("CREATE TABLE ... AS reads its columns without running the query", async () => {
    const started = Date.now();
    const { tables, warnings } = await importDdl(
      [
        "create table huge as select range as n, 'x' as label, range::double as amount from range(1000000000000);",
        "create table wide as select repeat('x', 1500000000) as a;",
        "create table wrapped as (select 1 as a, 'b'::varchar as b);",
        "create table nodata as select 2 as c with no data;",
        "create table limited as select * from huge order by n limit 5;",
      ].join("\n"),
      "duckdb",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(warnings).toEqual([]);
    expect(table(tables, "main.wide").columns.map((c) => [c.name, c.type])).toEqual([["a", "VARCHAR"]]);
    expect(table(tables, "main.huge").columns.map((c) => [c.name, c.type])).toEqual([
      ["n", "BIGINT"],
      ["label", "VARCHAR"],
      ["amount", "DOUBLE"],
    ]);
    expect(table(tables, "main.wrapped").columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(table(tables, "main.nodata").columns.map((c) => c.name)).toEqual(["c"]);
    expect(table(tables, "main.limited").columns.map((c) => c.name)).toEqual(["n", "label", "amount"]);
  });

  test("a CTAS whose columns come from data (a dynamic PIVOT) is skipped, so no setting value becomes a column name", async () => {
    const { tables, warnings } = await importDdl(
      [
        "create table p as pivot (select name, value from duckdb_settings() where name = 'secret_directory') on value using count(*);",
        "create table p2 as select * from (pivot (select name, value from duckdb_settings() where name = 'home_directory') on name using first(value)) s;",
        "create table fixed as select * from (values ('a', 1), ('b', 2)) v(k, n) pivot (sum(n) for k in ('a', 'b'));",
      ].join("\n"),
      "duckdb",
    );
    expect(tables.map((t) => t.name)).toEqual(["fixed"]);
    expect(table(tables, "main.fixed").columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(warnings.some((w) => w.startsWith("Skipped CREATE TABLE main.p:"))).toBe(true);
    expect(warnings).toContain("Skipped CREATE TABLE main.p2: a PIVOT that reads data to name its columns, which the importer does not run.");
    expect(JSON.stringify(tables)).not.toContain("stored_secrets");
  });

  test("an ENUM built from a query is skipped; a list of literals is created", async () => {
    const { tables, warnings } = await importDdl(
      [
        "create type leak as enum (select value from duckdb_settings() where name = 'secret_directory');",
        "create type mood as enum ('happy', 'sad');",
        "create table t (id int, m mood);",
      ].join("\n"),
      "duckdb",
    );
    expect(warnings).toContain("Skipped CREATE TYPE main.leak: an ENUM that is not a list of string literals.");
    expect(table(tables, "main.t").columns.map((c) => [c.name, c.type])).toEqual([
      ["id", "int"],
      ["m", "mood"],
    ]);
  });

  test("each statement runs alone: a MySQL-escaped quote in a column type cannot smuggle a second statement", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const out = join(t.dir, "smuggled.csv");
    // MySQL reads \' as a quote inside the string, so the COPY is part of the enum value. Read as DuckDB SQL, the
    // string ends at \', the column list closes, and a COPY and a comment follow.
    const ddl = `CREATE TABLE \`t\` (\`id\` int(11) NOT NULL, \`s\` enum('x\\')); COPY (SELECT 42) TO $$${out}$$; SELECT 1 --') DEFAULT NULL) ENGINE=InnoDB;`;
    const { tables } = await importDdl(ddl, "duckdb");
    expect(existsSync(out)).toBe(false);
    const cols = table(tables, "main.t").columns;
    expect(cols.map((c) => c.name)).toEqual(["id", "s"]);
    expect(cols[1]!.type).toStartWith("enum(");
  });
});

describe("sl import", () => {
  test("imports an information_schema CSV for a non-runnable source and suggests draft", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "wh", "snowflake");
    const r = await sl(t.root, ["import", "--source", "wh", "--format", "information_schema", "--file", fixture("info_schema_snowflake.json"), "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ImportJson>();
    expect(out).toMatchObject({ source: "wh", method: "information_schema", tables: 4, columns: 6, primary_keys: 0, foreign_keys: 0 });
    expect(out.next).toBe("sl draft --source wh");
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")) as Snapshot;
    expect(snap).toMatchObject({ snapshot_version: 1, source: "wh", dialect: "snowflake", method: "information_schema", captured_at: FIXED_NOW });
    expect(snap.tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["MARTS.DIM_CUSTOMERS", "MARTS.FCT_ORDERS", "MARTS.V_ORDERS_DAILY", "RAW.EVENTS_EXT"]);
  });

  test("imports a dbt manifest with a catalog, resolving paths from the working directory", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "wh", "postgres", { connection: { env: "WH_URL" } });
    const r = await sl(t.root, [
      "import", "--source", "wh", "--format", "dbt_manifest",
      "--file", fixture("dbt/manifest.json"), "--catalog", fixture("dbt/catalog.json"), "--json",
    ]);
    expect(r.code).toBe(0);
    const out = r.json<ImportJson>();
    expect(out).toMatchObject({ method: "dbt_manifest", tables: 6, primary_keys: 2, foreign_keys: 3 });
    expect(out.next).toBe("sl profile --source wh");
  });

  test("imports DDL, prints a plain summary and keeps profiles of unchanged columns", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "shop", "duckdb");
    const previous: Snapshot = {
      snapshot_version: 1,
      source: "shop",
      dialect: "duckdb",
      captured_at: "2026-01-01T00:00:00.000Z",
      method: "live",
      tables: [
        {
          schema: "shop",
          name: "orders",
          kind: "table",
          row_count: 500,
          profiled_at: "2026-01-01T00:05:00.000Z",
          columns: [
            { name: "id", type: "int(11) unsigned", nullable: false, profile: { null_fraction: 0, distinct_count: 500 } },
            { name: "status", type: "varchar(20)", nullable: false, profile: { null_fraction: 0, distinct_count: 4 } },
          ],
        },
        { schema: "shop", name: "old_table", kind: "table", columns: [] },
      ],
    };
    writeJson(join(t.root, "snapshots", "shop.json"), previous);
    const r = await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Imported 4 tables");
    expect(r.out).toContain("Skipped CREATE VIEW shop.legacy_returns");
    expect(r.out).toContain("old_table");
    expect(r.out).toContain("Next: `sl profile --source shop`");
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "shop.json"), "utf8")) as Snapshot;
    expect(snap.method).toBe("ddl");
    const orders = table(snap.tables, "shop.orders");
    expect(orders.row_count).toBe(500);
    expect(orders.profiled_at).toBe("2026-01-01T00:05:00.000Z");
    expect(orders.columns.find((c) => c.name === "id")!.profile).toEqual({ null_fraction: 0, distinct_count: 500 });
    expect(orders.columns.find((c) => c.name === "status")!.profile).toBeUndefined();
  });

  test("reports added, removed and retyped columns and tables against the previous snapshot", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "shop", "duckdb");
    const first = await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql"), "--json"]);
    expect(first.json<{ changes: unknown }>().changes).toBeNull();
    expect((await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql")])).out).toContain(
      "No tables or columns changed since the previous snapshot.",
    );

    const path = join(t.root, "snapshots", "shop.json");
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    const orders = table(snap.tables, "shop.orders");
    // The previous snapshot had a column the DDL no longer has, lacked notes, and typed status differently.
    orders.columns = orders.columns.filter((c) => c.name !== "notes");
    orders.columns.push({ name: "legacy_code", type: "varchar(8)" });
    const status = orders.columns.find((c) => c.name === "status")!;
    const statusType = status.type;
    status.type = "varchar(20)";
    snap.tables = snap.tables.filter((x) => x.name !== "products");
    snap.tables.push({ schema: "shop", name: "old_table", kind: "table", columns: [] });
    writeJson(path, snap);

    const r = await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql"), "--json"]);
    expect(r.code).toBe(0);
    const notesType = table((JSON.parse(readFileSync(path, "utf8")) as Snapshot).tables, "shop.orders").columns.find((c) => c.name === "notes")!.type;
    expect(r.json<{ changes: unknown }>().changes).toEqual({
      tables_added: ["shop.products"],
      tables_removed: ["shop.old_table"],
      columns: [
        {
          table: "shop.orders",
          added: [{ name: "notes", type: notesType }],
          removed: ["legacy_code"],
          retyped: [{ name: "status", from: "varchar(20)", to: statusType }],
        },
      ],
    });

    writeJson(path, snap);
    const human = await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql")]);
    expect(human.out).toContain(
      [
        "Changes since the previous snapshot:",
        "  1 table added: shop.products.",
        "  1 table removed: shop.old_table.",
        `  shop.orders: added notes (${notesType}); removed legacy_code; retyped status from varchar(20) to ${statusType}.`,
        "Removed or retyped columns and tables: `sl validate` reports the fields that read a removed column; read the affected fields back to the owner.",
      ].join("\n"),
    );
    expect(human.out).not.toContain("--new-columns");

    // With a model on shop.orders, the hint names the modeled table that gained a column.
    writeYaml(join(t.root, "models", "shop", "orders.yaml"), {
      model: "orders",
      source: "shop",
      table: "shop.orders",
      status: "draft",
      primary_key: ["id"],
      dimensions: [],
      measures: [],
    });
    writeJson(path, snap);
    const modeled = await sl(t.root, ["import", "--source", "shop", "--format", "ddl", "--file", fixture("ddl_mysql.sql")]);
    expect(modeled.out).toContain("Modeled tables gained columns (shop.orders): `sl draft --source shop --new-columns` drafts them.");
  });

  test("suggests focusing when more tables are in scope than the threshold", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "semantic.yaml"), { version: 1, name: "test", settings: { focus_threshold: 2 } });
    source(t.root, "pg", "postgres", { scope: { exclude: ["audit_*"] } });
    const r = await sl(t.root, ["import", "--source", "pg", "--format", "ddl", "--file", fixture("ddl_postgres.sql")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4 tables are in scope, more than the focus threshold of 2");
    expect(r.out).toContain("sl tables --source pg --groups");
  });

  test("resolves a relative --file against the working directory", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "wh", "bigquery");
    writeFileSync(join(t.dir, "cols.csv"), "table_schema,table_name,column_name,data_type\nds,t,a,INT64\nds,t,b,STRING\n");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["import", "--source", "wh", "--format", "information_schema", "--file", "cols.csv", "--json", "--root", t.root], {
      cwd: t.dir,
      env: { SL_NOW: FIXED_NOW },
      out: (x) => out.push(x),
      err: (x) => err.push(x),
    });
    expect(err.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n")) as ImportJson).toMatchObject({ tables: 1, columns: 2 });
  });

  test("reads the format from the file when --format is left out, and an explicit --format overrides it", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "pg", "postgres");
    const csv = await sl(t.root, ["import", "--source", "pg", "--file", fixture("exports/postgres.csv"), "--json"]);
    expect(csv.code).toBe(0);
    expect(csv.json<ImportJson>()).toMatchObject({ method: "information_schema", format: "information_schema", format_detected: true, tables: 7, primary_keys: 5, foreign_keys: 5 });
    const human = await sl(t.root, ["import", "--source", "pg", "--file", fixture("exports/postgres.csv")]);
    expect(human.out).toContain("from information_schema (read from the file) into snapshots/pg.json");
    const ddl = await sl(t.root, ["import", "--source", "pg", "--file", fixture("ddl_postgres.sql"), "--json"]);
    expect(ddl.json<ImportJson>()).toMatchObject({ method: "ddl", format_detected: true });
    const dbt = await sl(t.root, ["import", "--source", "pg", "--file", fixture("dbt/manifest.json"), "--catalog", fixture("dbt/catalog.json"), "--json"]);
    expect(dbt.json<ImportJson>()).toMatchObject({ method: "dbt_manifest", format_detected: true, tables: 6 });
    const json = await sl(t.root, ["import", "--source", "pg", "--file", fixture("info_schema_snowflake.json"), "--json"]);
    expect(json.json<ImportJson>()).toMatchObject({ method: "information_schema", tables: 4 });
    writeFileSync(join(t.root, "cols.sql"), "table_schema,table_name,column_name,data_type\ns,t,a,int\n");
    const forced = await sl(t.root, ["import", "--source", "pg", "--format", "information_schema", "--file", "cols.sql", "--json"]);
    expect(forced.code).toBe(0);
    expect(forced.json<ImportJson>()).toMatchObject({ method: "information_schema", format_detected: false, tables: 1 });
    const mysql = await sl(t.root, ["import", "--source", "pg", "--file", fixture("exports/mysql.tsv"), "--json"]);
    expect(mysql.json<ImportJson>()).toMatchObject({ tables: 5, primary_keys: 4, foreign_keys: 3 });
  });

  test("rejects bad arguments with a clear message", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    source(t.root, "wh", "postgres");
    const badFormat = await sl(t.root, ["import", "--source", "wh", "--format", "xlsx", "--file", "x"]);
    expect(badFormat.code).toBe(1);
    expect(badFormat.err).toContain("--format must be one of information_schema, dbt_manifest, ddl");
    writeFileSync(join(t.root, "notes.txt"), "hello\n");
    const undetectable = await sl(t.root, ["import", "--source", "wh", "--file", "notes.txt"]);
    expect(undetectable.code).toBe(1);
    expect(undetectable.err).toContain("Cannot tell the format of notes.txt. Pass --format: one of information_schema, dbt_manifest, ddl");
    const noFile = await sl(t.root, ["import", "--source", "wh"]);
    expect(noFile.code).toBe(1);
    expect(noFile.err).toContain("--file is required");
    const missing = await sl(t.root, ["import", "--source", "wh", "--format", "ddl", "--file", "nope.sql"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("No such file");
    const catalogOnDdl = await sl(t.root, ["import", "--source", "wh", "--format", "ddl", "--file", fixture("ddl_postgres.sql"), "--catalog", fixture("dbt/catalog.json")]);
    expect(catalogOnDdl.code).toBe(1);
    expect(catalogOnDdl.err).toContain("--catalog applies only");
    writeFileSync(join(t.root, "empty.sql"), "SET x = 1;\n");
    const empty = await sl(t.root, ["import", "--source", "wh", "--format", "ddl", "--file", "empty.sql"]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("No tables found");
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { rowCountNote } from "../skills/semantic-layer/scripts/commands/introspect.ts";
import { type CredentialSlot, hasCredential } from "../skills/semantic-layer/scripts/lib/credentials.ts";
import { buildSnapshot, nullable } from "../skills/semantic-layer/scripts/lib/introspect.ts";
import { introspectionPlan, schemaMatcher } from "../skills/semantic-layer/scripts/lib/sql/introspection.ts";
import type { QueryPlan, Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, FIXED_NOW, initProject, PG_URL, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function setup(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  return t;
}

function snapshotOf(root: string, source: string): Snapshot {
  return JSON.parse(readFileSync(join(root, "snapshots", `${source}.json`), "utf8")) as Snapshot;
}

function table(s: Snapshot, schema: string | null, name: string): SnapshotTable {
  const t = s.tables.find((x) => x.schema === schema && x.name === name);
  if (!t) throw new Error(`no table ${schema}.${name} in ${s.tables.map((x) => `${x.schema}.${x.name}`).join(", ")}`);
  return t;
}

const WAREHOUSE = [
  "create schema sales",
  "create table sales.customers (customer_id integer primary key, email varchar not null, region varchar)",
  "create table sales.orders (order_id integer primary key, customer_id integer references sales.customers (customer_id), amount_cents bigint, created_at timestamp)",
  "create table sales.order_lines (order_id integer, line_no integer, sku varchar, qty integer, primary key (order_id, line_no), foreign key (order_id) references sales.orders (order_id))",
  "create table sales.shipments (shipment_id integer primary key, order_id integer, line_no integer, foreign key (order_id, line_no) references sales.order_lines (order_id, line_no))",
  "create view sales.big_orders as select * from sales.orders where amount_cents > 10000",
  "comment on table sales.orders is 'One row per order.'",
  "comment on column sales.orders.amount_cents is 'Order value in cents.'",
  "insert into sales.customers select range, 'c' || range || '@example.com', 'west' from range(3)",
  "insert into sales.orders select range, range % 3, range * 1000, timestamp '2026-01-01' from range(20)",
];

describe("introspect: duckdb", () => {
  test("captures tables, views, comments, composite and foreign keys", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<{ source: string; tables: number; columns: number; primary_keys: number; foreign_keys: number; snapshot: string }>();
    expect(out).toMatchObject({ source: "wh", tables: 5, columns: 4 + 3 + 4 + 4 + 3, primary_keys: 4, foreign_keys: 3 });
    expect(out.snapshot).toBe(join(t.root, "snapshots", "wh.json"));
    expect(r.json<{ no_row_count: number; row_count_note: string }>()).toMatchObject({
      no_row_count: 1,
      row_count_note: "1 view has no row count yet; sl profile measures it.",
    });
    const human = await sl(t.root, ["introspect", "--source", "wh"]);
    expect(human.out).toContain("1 view has no row count yet; sl profile measures it.");

    const s = snapshotOf(t.root, "wh");
    expect(s).toMatchObject({ snapshot_version: 1, source: "wh", dialect: "duckdb", method: "live", captured_at: FIXED_NOW });
    expect(s.tables.map((x) => `${x.schema}.${x.name}`)).toEqual([
      "sales.big_orders",
      "sales.customers",
      "sales.order_lines",
      "sales.orders",
      "sales.shipments",
    ]);
    const orders = table(s, "sales", "orders");
    expect(orders.kind).toBe("table");
    expect(orders.row_count).toBe(20);
    expect(orders.description).toBe("One row per order.");
    expect(orders.primary_key).toEqual(["order_id"]);
    expect(orders.columns.map((c) => c.name)).toEqual(["order_id", "customer_id", "amount_cents", "created_at"]);
    expect(orders.columns[2]).toEqual({ name: "amount_cents", type: "BIGINT", nullable: true, description: "Order value in cents." });
    expect(orders.columns[0]!.nullable).toBe(false);
    expect(orders.foreign_keys).toEqual([
      { columns: ["customer_id"], references: { schema: "sales", table: "customers", columns: ["customer_id"] } },
    ]);
    const lines = table(s, "sales", "order_lines");
    expect(lines.primary_key).toEqual(["order_id", "line_no"]);
    const ship = table(s, "sales", "shipments");
    expect(ship.foreign_keys).toEqual([
      { columns: ["order_id", "line_no"], references: { schema: "sales", table: "order_lines", columns: ["order_id", "line_no"] } },
    ]);
    const view = table(s, "sales", "big_orders");
    expect(view.kind).toBe("view");
    expect(view.row_count).toBeNull();
    expect(view.primary_key).toEqual([]);
    expect(view.columns).toHaveLength(4);
    expect(table(s, "sales", "customers").columns[1]).toMatchObject({ name: "email", type: "VARCHAR", nullable: false });
  });

  test("a second run keeps profiles and descriptions, drops a profile whose type changed, and keeps profiled_at only when nothing needs profiling", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const path = join(t.root, "snapshots", "wh.json");
    const s = snapshotOf(t.root, "wh");
    const orders = table(s, "sales", "orders");
    orders.profiled_at = "2026-01-10T00:00:00.000Z";
    orders.columns[0]!.profile = { null_fraction: 0, distinct_count: 20, sampled: false };
    orders.columns[1]!.profile = { null_fraction: 0, distinct_count: 3, sampled: false };
    orders.columns[1]!.type = "VARCHAR";
    const customers = table(s, "sales", "customers");
    customers.profiled_at = "2026-01-11T00:00:00.000Z";
    customers.columns[0]!.profile = { null_fraction: 0, distinct_count: 3, sampled: false };
    customers.description = "Owner-written description.";
    customers.columns[2]!.description = "Sales region.";
    customers.unique_keys = [["email"], ["gone_column"]];
    writeFileSync(path, JSON.stringify(s));

    const r = await sl(t.root, ["introspect", "--source", "wh"], { SL_NOW: "2026-02-01T00:00:00.000Z" });
    expect(r.code).toBe(0);
    const again = snapshotOf(t.root, "wh");
    expect(again.captured_at).toBe("2026-02-01T00:00:00.000Z");
    const o2 = table(again, "sales", "orders");
    expect(o2.profiled_at).toBeUndefined();
    expect(o2.columns[0]!.profile).toEqual({ null_fraction: 0, distinct_count: 20, sampled: false });
    expect(o2.columns[1]!.type).toBe("INTEGER");
    expect(o2.columns[1]!.profile).toBeUndefined();
    const c2 = table(again, "sales", "customers");
    expect(c2.description).toBe("Owner-written description.");
    expect(c2.columns[2]!.description).toBe("Sales region.");
    expect(c2.unique_keys).toEqual([["email"]]);
    expect(c2.profiled_at).toBe("2026-01-11T00:00:00.000Z");
    expect(c2.columns[0]!.profile).toEqual({ null_fraction: 0, distinct_count: 3, sampled: false });
    expect(table(again, "sales", "shipments").profiled_at).toBeUndefined();
  });

  test("a table that gains a column after profiling is no longer marked profiled", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", ["create table t (id integer, s varchar)", "insert into t values (1, 'a')"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const path = join(t.root, "snapshots", "wh.json");
    const s = snapshotOf(t.root, "wh");
    const tt = table(s, "main", "t");
    tt.profiled_at = "2026-01-10T00:00:00.000Z";
    for (const col of tt.columns) col.profile = { null_fraction: 0, distinct_count: 1, sampled: false };
    writeFileSync(path, JSON.stringify(s));
    await duckdbSource(t.root, t.dir, "wh", ["alter table t add column amount integer"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const again = table(snapshotOf(t.root, "wh"), "main", "t");
    expect(again.profiled_at).toBeUndefined();
    expect(again.columns.map((c) => [c.name, c.profile !== undefined])).toEqual([
      ["id", true],
      ["s", true],
      ["amount", false],
    ]);
  });

  test("a source view that shadows a database table is captured as the view alone", async () => {
    const t = await setup();
    const src = await duckdbSource(t.root, t.dir, "wh", [
      "create table orders (id integer primary key, amount integer)",
      "create table keep (k integer primary key)",
    ]);
    writeYaml(join(t.root, "sources", "wh.yaml"), { ...src, connection: { ...src.connection, views: { Orders: "(select 'v' as shadow, 1 as zz)" } } });
    const r = await sl(t.root, ["introspect", "--source", "wh"]);
    expect(r.err).toBe("");
    const s = snapshotOf(t.root, "wh");
    expect(s.tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["main.keep", "main.Orders"]);
    const orders = table(s, "main", "Orders");
    expect(orders).toMatchObject({ kind: "view", primary_key: [], foreign_keys: [] });
    expect(orders.columns.map((c) => c.name)).toEqual(["shadow", "zz"]);
    expect(table(s, "main", "keep").primary_key).toEqual(["k"]);
  });

  test("a :memory: lake source sees its temporary views over Parquet as schema main", async () => {
    const t = await setup();
    mkdirSync(join(t.dir, "data"), { recursive: true });
    const parquet = join(t.dir, "data", "events.parquet");
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    await c.run(
      `copy (select range as event_id, 'click' as event_type, timestamp '2026-01-01' + to_minutes(range) as ts from range(7)) to '${parquet}' (format parquet)`,
    );
    c.closeSync();
    db.closeSync();

    const add = await sl(t.root, [
      "add-source",
      "--name",
      "lake",
      "--dialect",
      "duckdb",
      "--view",
      "events=read_parquet('../data/events.parquet')",
      "--view",
      "event_counts=(select event_type, count(*) as n from read_parquet('../data/events.parquet') group by 1)",
    ]);
    expect(add.err).toBe("");
    expect(add.code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "lake", "--json"]);
    expect(r.err).toBe("");
    expect(r.json<{ tables: number }>().tables).toBe(2);
    expect(r.json<{ no_row_count: number }>().no_row_count).toBe(2);
    const human = await sl(t.root, ["introspect", "--source", "lake"]);
    expect(human.out).toContain("2 views have no row count yet; sl profile measures them.");
    const s = snapshotOf(t.root, "lake");
    const events = table(s, "main", "events");
    expect(events.kind).toBe("view");
    expect(events.row_count).toBeNull();
    expect(events.columns.map((col) => [col.name, col.type])).toEqual([
      ["event_id", "BIGINT"],
      ["event_type", "VARCHAR"],
      ["ts", "TIMESTAMP"],
    ]);
    expect(table(s, "main", "event_counts").columns.map((col) => col.name)).toEqual(["event_type", "n"]);
  });

  test("--schemas restricts the plan and keeps other schemas' tables from the previous snapshot", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", [...WAREHOUSE, "create schema ops", "create table ops.jobs (id integer)"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect(snapshotOf(t.root, "wh").tables).toHaveLength(6);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "ops", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ tables: number }>().tables).toBe(6);
    const plan = introspectionPlan({ source: "wh", dialect: "duckdb" }, { schemas: ["ops"] });
    for (const q of plan.queries) expect(q.sql).toContain("where table_schema in ('ops')");
  });

  test("hints at sl tables --groups above the focus threshold, else sl profile", async () => {
    const t = await setup();
    const many = Array.from({ length: 14 }, (_, i) => `create table fct_t${i} (id integer)`);
    await duckdbSource(t.root, t.dir, "big", many);
    const r = await sl(t.root, ["introspect", "--source", "big"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("14 tables, 14 columns, 0 primary keys, 0 foreign keys");
    expect(r.out).toContain("sl tables --source big --groups");
    await duckdbSource(t.root, t.dir, "small", ["create table a (id integer)"]);
    const s = await sl(t.root, ["introspect", "--source", "small"]);
    expect(s.out).toContain("sl profile --source small");
    expect(s.out).not.toContain("no row count");
    const j = await sl(t.root, ["introspect", "--source", "small", "--json"]);
    expect(j.json<{ no_row_count: number; row_count_note?: string }>()).toMatchObject({ no_row_count: 0 });
    expect(j.json<{ row_count_note?: string }>().row_count_note).toBeUndefined();
  });

  test("names the tables without a row count by kind", () => {
    const mk = (name: string, kind: SnapshotTable["kind"], row_count?: number | null): SnapshotTable => ({ schema: "s", name, kind, row_count, columns: [] });
    const snap = (tables: SnapshotTable[]): Snapshot => ({ snapshot_version: 1, source: "wh", dialect: "postgres", captured_at: FIXED_NOW, method: "live", tables });
    expect(rowCountNote(snap([mk("a", "table", 10), mk("b", "view", 0)]))).toBeNull();
    expect(rowCountNote(snap([mk("a", "table", null), mk("b", "view", null), mk("c", "view"), mk("d", "external", null), mk("e", "table", 3)]))).toEqual({
      count: 4,
      note: "1 table, 2 views and 1 external table have no row count yet; sl profile measures them.",
    });
    expect(rowCountNote(snap([mk("a", "table", null), mk("b", "table", null)]))?.note).toBe(
      "2 tables have no row count yet; sl profile measures them.",
    );
  });

  test("the row count note leaves out out-of-scope tables and sends profiled ones to --refresh", () => {
    const mk = (name: string, kind: SnapshotTable["kind"], profiled_at?: string): SnapshotTable => ({
      schema: "s",
      name,
      kind,
      row_count: null,
      columns: [],
      ...(profiled_at ? { profiled_at } : {}),
    });
    const snap = (tables: SnapshotTable[]): Snapshot => ({ snapshot_version: 1, source: "wh", dialect: "postgres", captured_at: FIXED_NOW, method: "live", tables });
    expect(rowCountNote(snap([mk("a", "view"), mk("b", "view")]), { exclude: ["s.a", "s.b"] })).toBeNull();
    expect(rowCountNote(snap([mk("a", "view"), mk("b", "table")]), { include: ["s.b"] })).toEqual({
      count: 1,
      note: "1 table has no row count yet; sl profile measures it.",
    });
    expect(rowCountNote(snap([mk("v", "view", FIXED_NOW)]))).toEqual({
      count: 1,
      note: "1 view profiled earlier has no row count; sl profile --refresh --tables s.v measures it.",
    });
    expect(rowCountNote(snap([mk("a", "table"), mk("v", "view", FIXED_NOW), mk("w", "view", FIXED_NOW)]))).toEqual({
      count: 3,
      note:
        "1 table has no row count yet; sl profile measures it. " +
        "2 views profiled earlier have no row count; sl profile --refresh --tables s.v,s.w measures them.",
    });
    const many = Array.from({ length: 9 }, (_, i) => mk(`v${i}`, "view", FIXED_NOW));
    expect(rowCountNote(snap(many))?.note).toBe("9 views profiled earlier have no row count; sl profile --refresh measures them.");
    expect(rowCountNote(snap([mk("my view", "view", FIXED_NOW)]))?.note).toBe(
      "1 view profiled earlier has no row count; sl profile --refresh measures it.",
    );
  });

  test("re-introspecting after a profile, or after excluding a view, does not send the agent to a no-op profile", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", ["create table a (id integer)", "insert into a values (1), (2)", "create view v as select * from a"]);
    expect((await sl(t.root, ["introspect", "--source", "wh"])).out).toContain("1 view has no row count yet; sl profile measures it.");
    const p = await sl(t.root, ["profile", "--source", "wh"]);
    expect(p.code).toBe(0);
    const again = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(again.code).toBe(0);
    const out = again.json<{ no_row_count: number; row_count_note?: string }>();
    if (out.no_row_count) {
      expect(out.row_count_note).toBe("1 view profiled earlier has no row count; sl profile --refresh --tables main.v measures it.");
      const refresh = await sl(t.root, ["profile", "--source", "wh", "--refresh", "--tables", "main.v"]);
      expect(refresh.err).toBe("");
      expect(refresh.code).toBe(0);
      expect(typeof table(snapshotOf(t.root, "wh"), "main", "v").row_count).toBe("number");
    } else {
      expect(out.row_count_note).toBeUndefined();
    }

    expect((await sl(t.root, ["scope", "--source", "wh", "--exclude", "v", "--write"])).code).toBe(0);
    const excluded = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(excluded.json<{ no_row_count: number; row_count_note?: string }>()).toMatchObject({ no_row_count: 0 });
    expect(excluded.json<{ row_count_note?: string }>().row_count_note).toBeUndefined();
  });

  test("--emit-sql prints the plan and writes nothing", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", WAREHOUSE);
    const r = await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out) as QueryPlan;
    expect(plan.command).toBe("introspect");
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns", "primary_keys", "foreign_keys"]);
    expect(existsSync(join(t.root, "snapshots", "wh.json"))).toBe(false);
  });
});

describe("introspect: postgres", () => {
  const schema = "t_introspect";
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!PG_URL) return;
    pg = new SQL(PG_URL);
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.unsafe(`create schema ${schema}`);
    await pg.unsafe(`create table ${schema}.customers (customer_id integer primary key, email text not null)`);
    await pg.unsafe(
      `create table ${schema}.order_lines (order_id integer, line_no integer, customer_id integer references ${schema}.customers, qty numeric(10,2), primary key (line_no, order_id))`,
    );
    await pg.unsafe(`create unique index on ${schema}.order_lines (order_id, line_no)`);
    await pg.unsafe(
      `create table ${schema}.returns (return_id serial primary key, order_id integer, line_no integer, foreign key (order_id, line_no) references ${schema}.order_lines (order_id, line_no))`,
    );
    await pg.unsafe(`create view ${schema}.v_lines as select order_id, qty from ${schema}.order_lines`);
    await pg.unsafe(`comment on table ${schema}.customers is 'People who buy.'`);
    await pg.unsafe(`comment on column ${schema}.customers.email is 'Login email.'`);
    await pg.unsafe(`insert into ${schema}.customers select g, 'c' || g || '@example.com' from generate_series(1, 25) g`);
    await pg.unsafe(`analyze ${schema}.customers`);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.close();
  });

  test.skipIf(!PG_URL)("captures composite keys in key order, foreign keys, comments and estimates", async () => {
    const t = await setup();
    const add = await sl(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SL_TEST_PG"]);
    expect(add.code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "pg", "--schemas", schema, "--json"], { SL_TEST_PG: PG_URL });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 4, primary_keys: 3, foreign_keys: 2 });
    const s = snapshotOf(t.root, "pg");
    const customers = table(s, schema, "customers");
    expect(customers.description).toBe("People who buy.");
    expect(customers.row_count).toBe(25);
    expect(customers.columns).toEqual([
      { name: "customer_id", type: "integer", nullable: false, description: null },
      { name: "email", type: "text", nullable: false, description: "Login email." },
    ]);
    const lines = table(s, schema, "order_lines");
    expect(lines.primary_key).toEqual(["line_no", "order_id"]);
    expect(lines.row_count).toBeNull();
    expect(lines.columns.find((c) => c.name === "qty")!.type).toBe("numeric(10,2)");
    expect(lines.foreign_keys).toEqual([
      { columns: ["customer_id"], references: { schema, table: "customers", columns: ["customer_id"] } },
    ]);
    expect(table(s, schema, "returns").foreign_keys).toEqual([
      { columns: ["order_id", "line_no"], references: { schema, table: "order_lines", columns: ["order_id", "line_no"] } },
    ]);
    const view = table(s, schema, "v_lines");
    expect(view.kind).toBe("view");
    expect(view.row_count).toBeNull();
    expect(s.tables.every((x) => x.schema === schema)).toBe(true);
  });
});

describe("introspect: plan-only dialects", () => {
  test("snowflake: information_schema tables and columns, no key queries, case-insensitive schema filter", () => {
    const plan = introspectionPlan({ source: "sf", dialect: "snowflake" }, { schemas: ["analytics", "o'brien"] });
    expect(plan).toMatchObject({ command: "introspect", source: "sf", dialect: "snowflake" });
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns"]);
    expect(plan.queries[0]!.sql).toContain("information_schema.tables");
    expect(plan.queries[0]!.sql).toContain("upper(table_schema) in ('ANALYTICS', 'O''BRIEN')");
    expect(plan.queries[1]!.sql).toContain("comment as description");
    const mixed = introspectionPlan({ source: "sf", dialect: "snowflake" }, { schemas: ["MySchema", "raw"] });
    expect(mixed.queries[0]!.sql).toContain("(upper(table_schema) in ('RAW') or table_schema in ('MySchema'))");
  });

  test("bigquery: needs datasets, unions each one with backtick-quoted paths", () => {
    expect(() => introspectionPlan({ source: "bq", dialect: "bigquery" })).toThrow(/--schemas/);
    const plan = introspectionPlan({ source: "bq", dialect: "bigquery" }, { schemas: ["my-proj.sales", "ops"] });
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns", "primary_keys", "foreign_keys"]);
    const tables = plan.queries[0]!.sql;
    expect(tables).toContain("`my-proj`.`sales`.INFORMATION_SCHEMA.TABLES");
    expect(tables).toContain("`ops`.INFORMATION_SCHEMA.TABLES");
    expect(tables).toContain("`my-proj`.`sales`.__TABLES__");
    expect(tables).toContain("union all");
    expect(tables).toContain("select 'my-proj.sales' as table_schema, table_name, table_type from `my-proj`.`sales`.INFORMATION_SCHEMA.TABLES");
    expect(plan.queries[3]!.sql).toContain("case table_schema when 'sales' then 'my-proj.sales' when 'ops' then 'ops' else table_schema end");
    const fks = plan.queries[3]!.sql;
    for (const view of ["TABLE_CONSTRAINTS", "KEY_COLUMN_USAGE", "CONSTRAINT_COLUMN_USAGE"]) expect(fks).toContain(`\`ops\`.INFORMATION_SCHEMA.${view}`);
  });

  test("databricks: current catalog information_schema with key views", () => {
    const plan = introspectionPlan({ source: "dbx", dialect: "databricks" }, { schemas: ["Gold"] });
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns", "primary_keys", "foreign_keys"]);
    expect(plan.queries[0]!.sql).toContain("lower(table_schema) in ('gold')");
    for (const view of ["table_constraints", "key_column_usage", "referential_constraints", "constraint_column_usage"]) {
      expect(plan.queries[3]!.sql).toContain(`information_schema.${view}`);
    }
  });

  test("schemaMatcher follows each dialect's case rules", () => {
    const pg = schemaMatcher("postgres", ["Sales"]);
    expect([pg("Sales"), pg("sales")]).toEqual([true, false]);
    const sf = schemaMatcher("snowflake", ["analytics", "MySchema"]);
    expect([sf("ANALYTICS"), sf("MySchema"), sf("MYSCHEMA")]).toEqual([true, true, false]);
    expect(schemaMatcher("databricks", ["Gold"])("gold")).toBe(true);
    const bq = schemaMatcher("bigquery", ["other-proj.sales"]);
    expect([bq("other-proj.sales"), bq("sales"), bq("ops")]).toEqual([true, true, false]);
  });

  test("postgres and duckdb plans exclude system schemas", () => {
    const pg = introspectionPlan({ source: "pg", dialect: "postgres" });
    for (const q of pg.queries) {
      expect(q.sql).toContain("not in ('pg_catalog', 'information_schema')");
      expect(q.sql).toContain("'^pg_toast'");
      expect(q.sql).toContain("'^pg_temp'");
    }
    expect(pg.queries[3]!.sql).toContain("unnest(con.conkey, con.confkey) with ordinality");
    const duck = introspectionPlan({ source: "d", dialect: "duckdb" });
    expect(duck.queries[0]!.sql).toContain("duckdb_views()");
  });

  test("snowflake through the CLI: --emit-sql, then --results with uppercase keys", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "sf", "--dialect", "snowflake", "--env", "SF_URL"])).code).toBe(0);
    const live = await sl(t.root, ["introspect", "--source", "sf"]);
    expect(live.code).toBe(1);
    expect(live.err).toContain("--emit-sql");
    const emitted = await sl(t.root, ["introspect", "--source", "sf", "--emit-sql"]);
    const plan = JSON.parse(emitted.out) as QueryPlan;
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns"]);
    const results = {
      tables: [
        { TABLE_SCHEMA: "ANALYTICS", TABLE_NAME: "FCT_ORDERS", TABLE_KIND: "table", ROW_COUNT: 1200, DESCRIPTION: "Orders." },
        { TABLE_SCHEMA: "ANALYTICS", TABLE_NAME: "V_ORDERS", TABLE_KIND: "view", ROW_COUNT: null, DESCRIPTION: null },
      ],
      columns: [
        { TABLE_SCHEMA: "ANALYTICS", TABLE_NAME: "FCT_ORDERS", COLUMN_NAME: "AMOUNT", DATA_TYPE: "NUMBER(12,2)", IS_NULLABLE: "YES", ORDINAL_POSITION: 2, DESCRIPTION: "Order value." },
        { TABLE_SCHEMA: "ANALYTICS", TABLE_NAME: "FCT_ORDERS", COLUMN_NAME: "ORDER_ID", DATA_TYPE: "NUMBER(38,0)", IS_NULLABLE: "NO", ORDINAL_POSITION: 1, DESCRIPTION: null },
        { TABLE_SCHEMA: "ANALYTICS", TABLE_NAME: "V_ORDERS", COLUMN_NAME: "ORDER_ID", DATA_TYPE: "NUMBER(38,0)", IS_NULLABLE: "YES", ORDINAL_POSITION: 1, DESCRIPTION: null },
      ],
    };
    const file = join(t.dir, "sf-results.json");
    writeFileSync(file, JSON.stringify(results));
    const r = await sl(t.root, ["introspect", "--source", "sf", "--results", file, "--json"]);
    expect(r.err).toBe("");
    expect(r.json()).toMatchObject({ source: "sf", tables: 2, columns: 3, primary_keys: 0, foreign_keys: 0 });
    const s = snapshotOf(t.root, "sf");
    expect(s.dialect).toBe("snowflake");
    const orders = table(s, "ANALYTICS", "FCT_ORDERS");
    expect(orders).toMatchObject({ kind: "table", row_count: 1200, description: "Orders.", primary_key: [], foreign_keys: [] });
    expect(orders.columns).toEqual([
      { name: "ORDER_ID", type: "NUMBER(38,0)", nullable: false, description: null },
      { name: "AMOUNT", type: "NUMBER(12,2)", nullable: true, description: "Order value." },
    ]);
  });

  test("bigquery through the CLI: datasets from scope, composite keys from results", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "bq", "--dialect", "bigquery"])).code).toBe(0);
    const noDatasets = await sl(t.root, ["introspect", "--source", "bq", "--emit-sql"]);
    expect(noDatasets.code).toBe(1);
    expect(noDatasets.err).toContain("--schemas");
    const srcPath = join(t.root, "sources", "bq.yaml");
    writeYaml(srcPath, { ...readYaml<SourceConfig>(srcPath), scope: { include: ["sales.*", "fct_*"] } });
    const emitted = await sl(t.root, ["introspect", "--source", "bq", "--emit-sql"]);
    expect(emitted.code).toBe(0);
    const plan = JSON.parse(emitted.out) as QueryPlan;
    expect(plan.queries[0]!.sql).toContain("`sales`.INFORMATION_SCHEMA.TABLES");

    const results = {
      tables: [
        { TABLE_SCHEMA: "sales", TABLE_NAME: "lines", TABLE_KIND: "table", ROW_COUNT: "500", DESCRIPTION: null },
        { TABLE_SCHEMA: "sales", TABLE_NAME: "returns", TABLE_KIND: "table", ROW_COUNT: 3, DESCRIPTION: "Returned lines." },
      ],
      columns: [
        { TABLE_SCHEMA: "sales", TABLE_NAME: "lines", COLUMN_NAME: "order_id", DATA_TYPE: "INT64", IS_NULLABLE: "NO", ORDINAL_POSITION: 1, DESCRIPTION: null },
        { TABLE_SCHEMA: "sales", TABLE_NAME: "lines", COLUMN_NAME: "line_no", DATA_TYPE: "INT64", IS_NULLABLE: "NO", ORDINAL_POSITION: 2, DESCRIPTION: null },
        { TABLE_SCHEMA: "sales", TABLE_NAME: "returns", COLUMN_NAME: "line_no", DATA_TYPE: "INT64", IS_NULLABLE: "YES", ORDINAL_POSITION: 2, DESCRIPTION: null },
        { TABLE_SCHEMA: "sales", TABLE_NAME: "returns", COLUMN_NAME: "order_id", DATA_TYPE: "INT64", IS_NULLABLE: "YES", ORDINAL_POSITION: 1, DESCRIPTION: null },
      ],
      primary_keys: [
        { TABLE_SCHEMA: "sales", TABLE_NAME: "lines", COLUMN_NAME: "line_no", ORDINAL_POSITION: 2 },
        { TABLE_SCHEMA: "sales", TABLE_NAME: "lines", COLUMN_NAME: "order_id", ORDINAL_POSITION: 1 },
      ],
      foreign_keys: [
        { CONSTRAINT_NAME: "fk_lines", TABLE_SCHEMA: "sales", TABLE_NAME: "returns", COLUMN_NAME: "line_no", REF_SCHEMA: "sales", REF_TABLE: "lines", REF_COLUMN: "line_no", ORDINAL_POSITION: 2 },
        { CONSTRAINT_NAME: "fk_lines", TABLE_SCHEMA: "sales", TABLE_NAME: "returns", COLUMN_NAME: "order_id", REF_SCHEMA: "sales", REF_TABLE: "lines", REF_COLUMN: "order_id", ORDINAL_POSITION: 1 },
      ],
    };
    const file = join(t.dir, "bq-results.json");
    writeFileSync(file, JSON.stringify(results));
    const r = await sl(t.root, ["introspect", "--source", "bq", "--results", file]);
    expect(r.err).toBe("");
    expect(r.out).toContain("2 tables, 4 columns, 1 primary keys, 1 foreign keys");
    const s = snapshotOf(t.root, "bq");
    expect(table(s, "sales", "lines")).toMatchObject({ row_count: 500, primary_key: ["order_id", "line_no"] });
    const returns = table(s, "sales", "returns");
    expect(returns.columns.map((c) => c.name)).toEqual(["order_id", "line_no"]);
    expect(returns.foreign_keys).toEqual([
      { columns: ["order_id", "line_no"], references: { schema: "sales", table: "lines", columns: ["order_id", "line_no"] } },
    ]);
  });

  test("bigquery: a project-qualified dataset keeps its project, and a rerun drops removed tables", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "bq", "--dialect", "bigquery"])).code).toBe(0);
    const emitted = await sl(t.root, ["introspect", "--source", "bq", "--schemas", "other-proj.sales", "--emit-sql"]);
    expect((JSON.parse(emitted.out) as QueryPlan).queries[0]!.sql).toContain("'other-proj.sales' as table_schema");
    const file = join(t.dir, "bq.json");
    const write = (names: string[]) =>
      writeFileSync(
        file,
        JSON.stringify({
          tables: names.map((n) => ({ TABLE_SCHEMA: "other-proj.sales", TABLE_NAME: n, TABLE_KIND: "table" })),
          columns: [],
          primary_keys: [],
          foreign_keys: [],
        }),
      );
    write(["a", "b"]);
    expect((await sl(t.root, ["introspect", "--source", "bq", "--schemas", "other-proj.sales", "--results", file])).code).toBe(0);
    write(["a"]);
    expect((await sl(t.root, ["introspect", "--source", "bq", "--schemas", "other-proj.sales", "--results", file])).code).toBe(0);
    expect(snapshotOf(t.root, "bq").tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["other-proj.sales.a"]);
  });

  test("databricks through the CLI: --emit-sql, then --results with uppercase keys, composite keys and foreign keys", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "dbx", "--dialect", "databricks"])).code).toBe(0);
    const emitted = await sl(t.root, ["introspect", "--source", "dbx", "--schemas", "gold", "--emit-sql"]);
    expect(emitted.code).toBe(0);
    const plan = JSON.parse(emitted.out) as QueryPlan;
    expect(plan.queries.map((q) => q.id)).toEqual(["tables", "columns", "primary_keys", "foreign_keys"]);
    expect(existsSync(join(t.root, "snapshots", "dbx.json"))).toBe(false);

    const file = join(t.dir, "dbx-results.json");
    writeFileSync(file, JSON.stringify({ tables: [], columns: [] }));
    const missing = await sl(t.root, ["introspect", "--source", "dbx", "--results", file]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("primary_keys");

    const col = (table: string, name: string, pos: number) => ({
      TABLE_SCHEMA: "gold", TABLE_NAME: table, COLUMN_NAME: name, DATA_TYPE: "bigint", IS_NULLABLE: "NO", ORDINAL_POSITION: pos, DESCRIPTION: null,
    });
    writeFileSync(
      file,
      JSON.stringify({
        tables: [
          { TABLE_SCHEMA: "gold", TABLE_NAME: "orders", TABLE_KIND: "external", ROW_COUNT: null, DESCRIPTION: "Orders." },
          { TABLE_SCHEMA: "gold", TABLE_NAME: "lines", TABLE_KIND: "table", ROW_COUNT: null, DESCRIPTION: null },
          { TABLE_SCHEMA: "gold", TABLE_NAME: "returns", TABLE_KIND: "table", ROW_COUNT: null, DESCRIPTION: null },
        ],
        columns: [col("orders", "order_id", 1), col("lines", "line_no", 2), col("lines", "order_id", 1), col("returns", "order_id", 1), col("returns", "line_no", 2)],
        primary_keys: [
          { TABLE_SCHEMA: "gold", TABLE_NAME: "orders", COLUMN_NAME: "order_id", ORDINAL_POSITION: 1 },
          { TABLE_SCHEMA: "gold", TABLE_NAME: "lines", COLUMN_NAME: "line_no", ORDINAL_POSITION: 2 },
          { TABLE_SCHEMA: "gold", TABLE_NAME: "lines", COLUMN_NAME: "order_id", ORDINAL_POSITION: 1 },
        ],
        foreign_keys: [
          { CONSTRAINT_NAME: "fk_ret_lines", TABLE_SCHEMA: "gold", TABLE_NAME: "returns", COLUMN_NAME: "line_no", REF_SCHEMA: "gold", REF_TABLE: "lines", REF_COLUMN: "line_no", ORDINAL_POSITION: 2 },
          { CONSTRAINT_NAME: "fk_ret_lines", TABLE_SCHEMA: "gold", TABLE_NAME: "returns", COLUMN_NAME: "order_id", REF_SCHEMA: "gold", REF_TABLE: "lines", REF_COLUMN: "order_id", ORDINAL_POSITION: 1 },
          { CONSTRAINT_NAME: "fk_lines_orders", TABLE_SCHEMA: "gold", TABLE_NAME: "lines", COLUMN_NAME: "order_id", REF_SCHEMA: "gold", REF_TABLE: "orders", REF_COLUMN: "order_id", ORDINAL_POSITION: 1 },
        ],
      }),
    );
    const ok = await sl(t.root, ["introspect", "--source", "dbx", "--results", file, "--json"]);
    expect(ok.err).toBe("");
    expect(ok.json()).toMatchObject({ tables: 3, columns: 5, primary_keys: 2, foreign_keys: 2 });
    const s = snapshotOf(t.root, "dbx");
    expect(table(s, "gold", "orders")).toMatchObject({ kind: "external", description: "Orders.", primary_key: ["order_id"] });
    expect(table(s, "gold", "lines").primary_key).toEqual(["order_id", "line_no"]);
    expect(table(s, "gold", "lines").foreign_keys).toEqual([
      { columns: ["order_id"], references: { schema: "gold", table: "orders", columns: ["order_id"] } },
    ]);
    expect(table(s, "gold", "returns").foreign_keys).toEqual([
      { columns: ["order_id", "line_no"], references: { schema: "gold", table: "lines", columns: ["order_id", "line_no"] } },
    ]);
  });
});

describe("buildSnapshot", () => {
  const src: SourceConfig = { source: "x", dialect: "snowflake" };

  test("normalizes nullability spellings", () => {
    expect([true, "YES", "no", "Y", "N", "true", null, "maybe"].map(nullable)).toEqual([true, true, false, true, false, true, null, null]);
  });

  test("negative or missing row counts become null; keys from a previous snapshot survive a plan without key queries", () => {
    const previous: Snapshot = {
      snapshot_version: 1,
      source: "x",
      dialect: "snowflake",
      captured_at: "2026-01-01T00:00:00.000Z",
      method: "ddl",
      tables: [
        {
          schema: "S",
          name: "T",
          kind: "table",
          row_count: 9,
          primary_key: ["ID"],
          foreign_keys: [{ columns: ["U"], references: { schema: "S", table: "U", columns: ["ID"] } }],
          columns: [{ name: "ID", type: "NUMBER", nullable: false }],
        },
      ],
    };
    const snap = buildSnapshot(
      src,
      {
        tables: [{ table_schema: "S", table_name: "T", table_kind: "TABLE", row_count: -1, description: "" }],
        columns: [
          { table_schema: "S", table_name: "T", column_name: "ID", data_type: "NUMBER", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "S", table_name: "T", column_name: "U", data_type: "NUMBER", is_nullable: "YES", ordinal_position: 2 },
        ],
      },
      FIXED_NOW,
      previous,
    );
    const t = snap.tables[0]!;
    expect(t.description).toBeNull();
    expect(t.row_count).toBe(9);
    expect(t.primary_key).toEqual(["ID"]);
    expect(t.foreign_keys).toHaveLength(1);
    expect(snap.method).toBe("live");

    const fresh = buildSnapshot(src, { tables: [{ table_schema: "S", table_name: "T", table_kind: "table", row_count: -1 }], primary_keys: [] }, FIXED_NOW, null);
    expect(fresh.tables[0]!.row_count).toBeNull();
  });

  test("deduplicates key rows and splits unnamed foreign keys to the same table", () => {
    const t = { table_schema: "S", table_name: "T" };
    const fk = (column: string, ref: string, pos: number) => ({ ...t, constraint_name: null, column_name: column, ref_schema: "S", ref_table: "ADDR", ref_column: ref, ordinal_position: pos });
    const snap = buildSnapshot(
      src,
      {
        tables: [{ ...t, table_kind: "table" }],
        columns: [],
        primary_keys: [
          { ...t, column_name: "ID", ordinal_position: 1 },
          { ...t, column_name: "ID", ordinal_position: 1 },
        ],
        foreign_keys: [fk("BILL_ADDR", "ID", 1), fk("SHIP_ADDR", "ID", 1), fk("SHIP_ADDR", "ID", 1)],
      },
      FIXED_NOW,
      null,
    );
    const out = snap.tables[0]!;
    expect(out.primary_key).toEqual(["ID"]);
    expect(out.foreign_keys).toEqual([
      { columns: ["BILL_ADDR"], references: { schema: "S", table: "ADDR", columns: ["ID"] } },
      { columns: ["SHIP_ADDR"], references: { schema: "S", table: "ADDR", columns: ["ID"] } },
    ]);
  });
});

describe("add-source", () => {
  test("writes a duckdb source with views split on the first '='", async () => {
    const t = await setup();
    const r = await sl(t.root, [
      "add-source",
      "--name",
      "lake",
      "--dialect",
      "duckdb",
      "--description",
      "Event lake.",
      "--setup",
      "SET threads=2",
      "--view",
      "hits=read_csv('../data/a=b/hits.csv', header=true)",
      "--json",
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const saved = readYaml<SourceConfig>(join(t.root, "sources", "lake.yaml"));
    expect(saved).toEqual({
      source: "lake",
      dialect: "duckdb",
      description: "Event lake.",
      connection: { database: ":memory:", setup: ["SET threads=2"], views: { hits: "read_csv('../data/a=b/hits.csv', header=true)" } },
    });
    expect(r.json<{ path: string }>().path).toBe(join(t.root, "sources", "lake.yaml"));
  });

  test("writes a postgres source naming its env var, and plan-only dialects without one", async () => {
    const t = await setup();
    const r = await sl(t.root, ["add-source", "--name", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WAREHOUSE_URL is not set");
    expect(readYaml<SourceConfig>(join(t.root, "sources", "warehouse.yaml"))).toEqual({
      source: "warehouse",
      dialect: "postgres",
      connection: { env: "WAREHOUSE_URL" },
    });
    const sf = await sl(t.root, ["add-source", "--name", "sf", "--dialect", "snowflake"]);
    expect(sf.code).toBe(0);
    expect(sf.out).toContain("--emit-sql");
    expect(readYaml<SourceConfig>(join(t.root, "sources", "sf.yaml"))).toEqual({ source: "sf", dialect: "snowflake" });
  });

  test("refuses bad names, dialects, duplicates and a missing postgres env", async () => {
    const t = await setup();
    const cases: [string[], string][] = [
      [["--name", "Bad-Name", "--dialect", "duckdb"], "--name"],
      [["--dialect", "duckdb"], "--name"],
      [["--name", "x", "--dialect", "oracle"], "--dialect"],
      [["--name", "x"], "--dialect"],
      [["--name", "x", "--dialect", "postgres"], "--env"],
      [["--name", "x", "--dialect", "snowflake", "--view", "a=b"], "only to duckdb"],
      [["--name", "x", "--dialect", "duckdb", "--env", "X_URL"], "do not use --env"],
      [["--name", "x", "--dialect", "duckdb", "--view", "novalue"], "name=relation"],
      [["--name", "x", "--dialect", "duckdb", "--view", "a=b", "--view", "a=c"], "twice"],
      [["--name", "x", "--dialect", "duckdb", "--database", "postgres://u:p@h/db"], "contains a credential"],
    ];
    for (const [args, message] of cases) {
      const r = await sl(t.root, ["add-source", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
    }
    expect(existsSync(join(t.root, "sources", "x.yaml"))).toBe(false);
    expect((await sl(t.root, ["add-source", "--name", "x", "--dialect", "duckdb"])).code).toBe(0);
    const dup = await sl(t.root, ["add-source", "--name", "x", "--dialect", "duckdb"]);
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("already exists");
  });

  test("refuses credentials in --setup, --database and --view without storing or echoing them", async () => {
    const t = await setup();
    const cases: [string, string][] = [
      ["--setup", "CREATE SECRET (TYPE s3, KEY_ID 'AKIA123', SECRET 'abcSECRET')"],
      ["--setup", "SET s3_secret_access_key='wJalrXUtnFEMI'"],
      ["--setup", "SET s3_access_key_id='AKIAEXAMPLE'"],
      ["--setup", "SET s3_session_token='FwoGZXIvYXdzEXAMPLE'"],
      ["--setup", "ATTACH 'dbname=prod user=u password=hunter2 host=db' AS pg (TYPE postgres)"],
      ["--setup", "SET azure_storage_connection_string='DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc'"],
      ["--setup", "ATTACH 'md:mydb?motherduck_token=eyJsecret'"],
      ["--database", "md:mydb?motherduck_token=eyJsecret"],
      ["--database", "postgres://admin:hunter2@db/prod"],
      ["--view", "t=read_parquet('https://acct.blob.core.windows.net/c/x.parquet?sv=2024&sig=abcSECRET')"],
    ];
    for (const [flag, value] of cases) {
      const r = await sl(t.root, ["add-source", "--name", "x", "--dialect", "duckdb", flag, value, "--json"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${flag} contains a credential`);
      for (const secret of ["wJalrXUtnFEMI", "AKIA", "hunter2", "abcSECRET", "eyJsecret", "FwoGZ", "AccountKey"]) {
        expect(r.err).not.toContain(secret);
        expect(r.out).not.toContain(secret);
      }
    }
    expect(existsSync(join(t.root, "sources", "x.yaml"))).toBe(false);

    const ok = await sl(t.root, [
      "add-source", "--name", "lake", "--dialect", "duckdb", "--database", "md:analytics",
      "--setup", "SET secret_directory='/tmp/s'", "--setup", "CREATE SECRET (TYPE s3, PROVIDER credential_chain)",
      "--view", "ev=read_parquet('s3://bucket/token_files/*.parquet')", "--json",
    ]);
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    const out = ok.json<Record<string, unknown>>();
    expect(out).toMatchObject({ source: "lake", dialect: "duckdb", views: ["ev"], setup_statements: 2, notes: [] });
    expect(ok.out).not.toContain("credential_chain");
    expect(ok.out).not.toContain("md:analytics");
    const human = await sl(t.root, ["add-source", "--name", "local", "--dialect", "duckdb", "--database", "data/missing.duckdb"]);
    expect(human.out).toContain("does not exist yet");
    expect(human.out).not.toContain("missing.duckdb");
  });

  test("add-source and sl validate share one credential check", async () => {
    const flagged: [CredentialSlot, string][] = [
      ["setup", "SET s3_secret_access_key='wJalrXUtnFEMI'"],
      ["setup", "ATTACH 'dbname=prod user=u password=hunter2 host=db' AS pg (TYPE postgres)"],
      ["database", "md:mydb?motherduck_token=eyJsecret"],
      ["database", "postgres://admin:hunter2@db/prod"],
      ["view", "read_parquet('https://acct.blob.core.windows.net/c/x.parquet?sv=2024&sig=abcSECRET')"],
    ];
    for (const [slot, value] of flagged) expect(hasCredential(slot, value)).toBe(true);
    const clean: [CredentialSlot, string][] = [
      ["setup", "SET secret_directory='/tmp/s'"],
      ["setup", "CREATE SECRET (TYPE s3, PROVIDER credential_chain)"],
      ["database", "md:analytics"],
      ["database", "SET s3_secret_access_key='not-read-as-a-statement'"],
      ["view", "read_parquet('s3://bucket/token_files/*.parquet')"],
    ];
    for (const [slot, value] of clean) expect(hasCredential(slot, value)).toBe(false);

    // A hand-edited source gets the same check from sl validate, which names the key, never the value.
    const t = await setup();
    writeYaml(join(t.root, "sources", "lake.yaml"), {
      source: "lake",
      dialect: "duckdb",
      connection: { database: ":memory:", setup: ["SET threads=2", "SET s3_secret_access_key='wJalrXUtnFEMI'"], views: { ev: "read_parquet('x?sig=abcSECRET')" } },
    });
    const r = await sl(t.root, ["validate", "--json"]);
    expect(r.code).toBe(1);
    const issues = r.json<{ issues: { path: string; message: string }[] }>().issues.filter((i) => i.message.includes("contains a credential"));
    expect(issues.map((i) => i.path).sort()).toEqual(["connection.setup[1]", "connection.views.ev"]);
    for (const out of [r.out, (await sl(t.root, ["validate"])).out]) {
      expect(out).not.toContain("wJalrXUtnFEMI");
      expect(out).not.toContain("abcSECRET");
    }
  });

  test("refuses a name that already has a .yml source file", async () => {
    const t = await setup();
    writeFileSync(join(t.root, "sources", "x.yml"), "source: x\ndialect: duckdb\n");
    const r = await sl(t.root, ["add-source", "--name", "x", "--dialect", "duckdb"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already exists");
    expect(existsSync(join(t.root, "sources", "x.yaml"))).toBe(false);
  });

  test("refuses a connection URL passed as --env without echoing it", async () => {
    const t = await setup();
    for (const value of ["postgres://admin:hunter2@db.example.com/prod", "admin@db.example.com", "hunter2-not-a-name"]) {
      const r = await sl(t.root, ["add-source", "--name", "wh", "--dialect", "postgres", "--env", value]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("environment variable");
      expect(r.err).not.toContain("hunter2");
      expect(r.err).not.toContain("db.example.com");
    }
    expect(existsSync(join(t.root, "sources", "wh.yaml"))).toBe(false);
  });

  test("needs an initialized project", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["add-source", "--name", "x", "--dialect", "duckdb"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl init");
  });
});

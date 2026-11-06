import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { applySchemas, EXPORT_DIALECTS, EXPORTS_DIR, exportSql } from "../skills/semantic-layer/scripts/commands/export-sql.ts";
import type { Snapshot, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { initProject, PG_URL, sl, tempRoot } from "./helpers.ts";

const COLUMNS = [
  "table_schema", "table_name", "table_type", "table_comment", "row_count", "column_name", "ordinal_position", "data_type",
  "is_nullable", "column_comment", "is_primary_key", "pk_ordinal", "fk_name", "fk_ordinal", "references_schema", "references_table",
  "references_column",
];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const raw = (dialect: string) => readFileSync(join(EXPORTS_DIR, `${dialect}.sql`), "utf8");

// The output aliases of the final SELECT, in order.
function outputColumns(sql: string): string[] {
  const body = sql.slice(sql.lastIndexOf("select\n"));
  return [...body.matchAll(/\bas "?([a-z_]+)"?,?$/gm)].map((m) => m[1]!).filter((c) => COLUMNS.includes(c));
}

function table(s: Snapshot, qualified: string): SnapshotTable {
  const t = s.tables.find((x) => `${x.schema}.${x.name}` === qualified);
  if (!t) throw new Error(`no table ${qualified}`);
  return t;
}

const snapshotOf = (root: string, source: string) => JSON.parse(readFileSync(join(root, "snapshots", `${source}.json`), "utf8")) as Snapshot;

describe("export queries", () => {
  test.each([...EXPORT_DIALECTS])("%s: a commented, read-only catalog query returning the canonical columns in order", (dialect) => {
    const sql = raw(dialect);
    expect(sql.startsWith(`-- Schema export for `)).toBe(true);
    expect(outputColumns(sql)).toEqual(COLUMNS);
    // The header says how to save CSV and how to import it.
    const header = sql.split("\n").filter((l) => l.startsWith("--")).join("\n");
    expect(header).toContain("sl import --source <source> --file schema.");
    expect(header).toMatch(/csv|CSV/);
    // No statement writes.
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(insert|update|delete|merge|create|drop|alter|truncate|grant|copy)\s/i);
    if (dialect === "bigquery") expect(sql).toMatch(/^\s*-- sl:per-dataset$/m);
    else expect(sql).toMatch(/^\s*-- and .+ in \(.*\)\s+-- sl:schema-filter/m);
  });

  test("system schemas are left out", () => {
    expect(raw("postgres")).toContain("not in ('pg_catalog', 'information_schema')");
    expect(raw("redshift")).toContain("left(n.nspname, 3) <> 'pg_'");
    expect(raw("mysql")).toContain("not in ('mysql', 'information_schema', 'performance_schema', 'sys')");
    expect(raw("sqlserver")).toContain("o.is_ms_shipped = 0");
    expect(raw("snowflake")).toContain("<> 'INFORMATION_SCHEMA'");
    expect(raw("databricks")).toContain("<> 'information_schema'");
    expect(raw("duckdb")).toContain("not in ('information_schema', 'pg_catalog')");
  });

  test("applies --schemas as an active filter line, quoting names as literals", () => {
    const pg = applySchemas("postgres", raw("postgres"), ["acme", "o'brien"]);
    expect(pg).toContain("    and n.nspname in ('acme', 'o''brien')  -- sl:schema-filter\n");
    expect(pg).not.toContain("-- and n.nspname");
    expect(applySchemas("sqlserver", raw("sqlserver"), ["dbo"])).toContain("and s.name in (N'dbo')  -- sl:schema-filter");
    expect(applySchemas("mysql", raw("mysql"), ["shop"])).toContain("and c.table_schema in ('shop')  -- sl:schema-filter");
    // A mixed-case name matches its uppercase (unquoted) form as well as itself (quoted).
    expect(applySchemas("snowflake", raw("snowflake"), ["raw", "Marts", "x1"])).toContain(
      "and (upper(c.table_schema) in ('RAW', 'MARTS', 'X1') or c.table_schema in ('Marts'))  -- sl:schema-filter",
    );
    expect(applySchemas("snowflake", raw("snowflake"), ["raw"])).toContain("and upper(c.table_schema) in ('RAW')  -- sl:schema-filter");
    expect(applySchemas("databricks", raw("databricks"), ["Gold", "it's"])).toContain("and lower(c.table_schema) in ('gold', 'it\\'s')  -- sl:schema-filter");
    expect(applySchemas("duckdb", raw("duckdb"), ["main"])).toContain("and schema_name in ('main')  -- sl:schema-filter");
    expect(applySchemas("redshift", raw("redshift"), ["$x"])).toContain("and n.nspname in ('$x')  -- sl:schema-filter");
    expect(applySchemas("postgres", raw("postgres"), [])).toBe(raw("postgres"));
    expect(() => applySchemas("mysql", raw("mysql"), ["a\\b"])).toThrow(/backslash or control character/);
    expect(() => applySchemas("postgres", raw("postgres"), ["a\nb"])).toThrow(/backslash or control character/);
  });

  test("bigquery repeats each per-dataset block for every dataset, joined by UNION ALL", () => {
    const sql = applySchemas("bigquery", raw("bigquery"), ["analytics", "my-proj.raw"]);
    expect(sql).not.toMatch(/^\s*-- sl:(end-)?per-dataset$/m);
    expect(sql.slice(sql.indexOf("\nwith\n"))).not.toContain("`my_dataset`");
    expect(sql).toContain(
      [
        "cols as (",
        "  select table_schema, table_name, column_name, ordinal_position, data_type, is_nullable",
        "  from `analytics`.INFORMATION_SCHEMA.COLUMNS",
        "  union all",
        "  select table_schema, table_name, column_name, ordinal_position, data_type, is_nullable",
        "  from `my-proj`.`raw`.INFORMATION_SCHEMA.COLUMNS",
        "),",
      ].join("\n"),
    );
    expect(sql.match(/`my-proj`\.`raw`\./g)!.length).toBe(8);
    expect(sql).toContain("from `my-proj`.`raw`.__TABLES__");
    expect(() => applySchemas("bigquery", raw("bigquery"), ["a`b"])).toThrow(/backtick/);
  });
});

describe("sl export-sql", () => {
  test("prints the query on stdout and how to run and import it on stderr, with no project", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["export-sql", "--dialect", "postgres", "--schemas", "acme"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(exportSql("postgres", ["acme"]).sql.trimEnd());
    expect(r.out).toContain("and n.nspname in ('acme')  -- sl:schema-filter");
    expect(r.err).toBe(
      'Save this as export.sql, run psql -X "$DATABASE_URL" --csv -f export.sql > schema.csv, then import it: sl import --source <source> --file schema.csv',
    );
    expect(r.err.split("\n")).toHaveLength(1);
    expect(existsSync(t.root)).toBe(false);
  });

  test("--json prints dialect, sql and run_hint", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    for (const dialect of EXPORT_DIALECTS) {
      const r = await sl(t.root, ["export-sql", "--dialect", dialect, "--json"]);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      const out = r.json<{ dialect: string; sql: string; run_hint: string }>();
      expect(Object.keys(out)).toEqual(["dialect", "sql", "run_hint"]);
      expect(out.dialect).toBe(dialect);
      expect(out.sql).toBe(raw(dialect));
      expect(out.run_hint).toContain("sl import --source <source> --file schema.");
    }
    const mysql = (await sl(t.root, ["export-sql", "--dialect", "mysql", "--json"])).json<{ run_hint: string }>();
    expect(mysql.run_hint).toContain("mysql --batch --raw");
    expect(mysql.run_hint).toContain("--file schema.tsv");
    const bq = (await sl(t.root, ["export-sql", "--dialect", "bigquery", "--json"])).json<{ run_hint: string }>();
    expect(bq.run_hint).toContain("replace `my_dataset` first, or pass --schemas");
    // bq reads the query from stdin: as an argument, its opening "--" comment parses as a flag.
    expect(bq.run_hint).toContain("bq --quiet query --use_legacy_sql=false --format=csv --max_rows=1000000 < export.sql > schema.csv");
    expect(bq.run_hint).not.toContain("$(cat");
    expect(raw("bigquery")).toContain("< bigquery.sql > schema.csv");
    expect(raw("bigquery")).not.toContain("$(cat");
    // psql skips ~/.psqlrc, whose \pset null would print a marker for every NULL.
    for (const d of ["postgres", "redshift"]) {
      expect((await sl(t.root, ["export-sql", "--dialect", d, "--json"])).json<{ run_hint: string }>().run_hint).toContain("psql -X ");
      expect(raw(d)).toContain(`--   psql -X "`);
    }
    const mssql = (await sl(t.root, ["export-sql", "--dialect", "sqlserver", "--json"])).json<{ run_hint: string }>();
    expect(mssql.run_hint).toContain("-f 65001");
    expect(raw("sqlserver")).toContain("-f 65001");
    const bqSchemas = (await sl(t.root, ["export-sql", "--dialect", "bigquery", "--schemas", "a", "--schemas", "b", "--json"])).json<{ sql: string; run_hint: string }>();
    expect(bqSchemas.run_hint).not.toContain("my_dataset");
    expect(bqSchemas.sql).toContain("from `a`.INFORMATION_SCHEMA.TABLES\n  union all\n");
  });

  test("rejects a missing or unknown dialect", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const missing = await sl(t.root, ["export-sql"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("--dialect is required: one of postgres, redshift, mysql, sqlserver, snowflake, bigquery, databricks, duckdb");
    const unknown = await sl(t.root, ["export-sql", "--dialect", "oracle"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Unknown dialect "oracle"');
  });
});

describe("export-sql: duckdb, live", () => {
  test("the export runs, reads keys, comments and sizes, and imports through sl import", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const instance = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await instance.connect();
    for (const s of [
      "create schema shop",
      "create schema other",
      "create table shop.customers (customer_id integer primary key, email varchar, region varchar)",
      "comment on table shop.customers is 'One row per customer, with commas'",
      "comment on column shop.customers.email is 'Contact \"email\"'",
      "create table shop.order_lines (order_id integer, line_no integer, customer_id integer references shop.customers(customer_id), amount_cents bigint not null, primary key (line_no, order_id))",
      "create table shop.returns (return_id integer primary key, order_id integer, line_no integer, foreign key (line_no, order_id) references shop.order_lines (line_no, order_id))",
      "create table other.notes (note varchar)",
      "insert into shop.customers values (1, 'a', null), (2, 'b', null), (3, 'c', 'eu')",
      "create view shop.v_lines as select order_id, amount_cents from shop.order_lines",
    ]) await c.run(s);
    const sql = exportSql("duckdb", ["shop"]).sql.trim().replace(/;$/, "");
    const csv = join(t.dir, "schema.csv");
    await c.run(`copy (${sql}) to '${csv}' (header, delimiter ',')`);
    c.closeSync();
    instance.closeSync();

    const header = readFileSync(csv, "utf8").split("\n", 1)[0];
    expect(header).toBe(COLUMNS.join(","));
    writeFileSync(join(t.root, "sources", "wh.yaml"), "source: wh\ndialect: duckdb\n");
    const r = await sl(t.root, ["import", "--source", "wh", "--file", csv, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ method: "information_schema", format_detected: true, tables: 4, primary_keys: 3, foreign_keys: 2, warnings: [] });
    const s = snapshotOf(t.root, "wh");
    expect(s.tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["shop.customers", "shop.order_lines", "shop.returns", "shop.v_lines"]);
    const customers = table(s, "shop.customers");
    expect(customers).toMatchObject({ kind: "table", row_count: 3, description: "One row per customer, with commas", primary_key: ["customer_id"], foreign_keys: [] });
    expect(customers.columns[1]).toEqual({ name: "email", type: "VARCHAR", nullable: true, description: 'Contact "email"' });
    const lines = table(s, "shop.order_lines");
    expect(lines.primary_key).toEqual(["line_no", "order_id"]);
    expect(lines.foreign_keys).toEqual([{ columns: ["customer_id"], references: { schema: "shop", table: "customers", columns: ["customer_id"] } }]);
    expect(lines.columns.find((x) => x.name === "amount_cents")).toMatchObject({ type: "BIGINT", nullable: false });
    expect(table(s, "shop.returns").foreign_keys).toEqual([
      { columns: ["line_no", "order_id"], references: { schema: "shop", table: "order_lines", columns: ["line_no", "order_id"] } },
    ]);
    expect(table(s, "shop.v_lines")).toMatchObject({ kind: "view", row_count: null, primary_key: [] });
  });
});

describe("export-sql: postgres, live", () => {
  const schema = "t_export_sql";
  const psql = Bun.which("psql");
  const live = Boolean(PG_URL && psql);
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!live) return;
    pg = new SQL(PG_URL!);
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    for (const s of [
      `create schema ${schema}`,
      `create type ${schema}.order_status as enum ('placed', 'shipped')`,
      `create table ${schema}.customers (customer_id integer primary key, email text not null, region_code text)`,
      `comment on table ${schema}.customers is 'People who buy, one row each.'`,
      `comment on column ${schema}.customers.email is 'Login "email", lowercased.'`,
      `create table ${schema}.orders (order_id integer primary key, customer_id integer references ${schema}.customers, status ${schema}.order_status not null, amount_cents bigint not null, tags text[])`,
      `create table ${schema}.order_lines (order_id integer references ${schema}.orders, line_no integer, qty numeric(10,2), primary key (line_no, order_id))`,
      `create unique index on ${schema}.order_lines (order_id, line_no)`,
      `create table ${schema}.shipments (shipment_id serial primary key, order_id integer not null, line_no integer not null,
        constraint shipments_order_fk foreign key (order_id) references ${schema}.orders,
        constraint shipments_line_fk foreign key (order_id, line_no) references ${schema}.order_lines (order_id, line_no))`,
      `alter table ${schema}.shipments drop column line_no`,
      `alter table ${schema}.shipments add column line_no integer`,
      `alter table ${schema}.shipments add constraint shipments_line_fk foreign key (order_id, line_no) references ${schema}.order_lines (order_id, line_no)`,
      `create table ${schema}.events (event_id bigint, happened_at date not null, primary key (event_id, happened_at)) partition by range (happened_at)`,
      `create table ${schema}.events_2025 partition of ${schema}.events for values from ('2025-01-01') to ('2026-01-01')`,
      `create table ${schema}.events_2026 partition of ${schema}.events for values from ('2026-01-01') to ('2027-01-01')`,
      `create table ${schema}.event_notes (event_id bigint, happened_at date, note text, foreign key (event_id, happened_at) references ${schema}.events)`,
      `create view ${schema}.v_orders as select order_id, amount_cents from ${schema}.orders`,
      `create materialized view ${schema}.mv_daily as select status, count(*) as n from ${schema}.orders group by status`,
      `insert into ${schema}.customers select g, 'c' || g || '@example.com', null from generate_series(1, 25) g`,
      `insert into ${schema}.events select g, date '2025-06-01' + (g % 400) from generate_series(1, 40) g`,
      `analyze ${schema}.customers`,
      `analyze ${schema}.events`,
    ]) await pg.unsafe(s);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.close();
  });

  test.skipIf(!live)("psql --csv output imports with keys, comments and row counts, matching live introspection", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const exp = await sl(t.root, ["export-sql", "--dialect", "postgres", "--schemas", schema]);
    expect(exp.code).toBe(0);
    const sqlFile = join(t.dir, "export.sql");
    const csv = join(t.dir, "schema.csv");
    writeFileSync(sqlFile, exp.out);
    // -X skips a psqlrc that would print a marker for every NULL.
    const psqlrc = join(t.dir, "psqlrc");
    writeFileSync(psqlrc, "\\set QUIET 1\n\\pset null '(null)'\n");
    const run = Bun.spawnSync([psql!, "-X", PG_URL!, "--csv", "-v", "ON_ERROR_STOP=1", "-f", sqlFile], { env: { ...process.env, PSQLRC: psqlrc } });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    writeFileSync(csv, run.stdout);
    expect(run.stdout.toString().split("\n", 1)[0]).toBe(COLUMNS.join(","));

    expect((await sl(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SL_TEST_PG"])).code).toBe(0);
    const r = await sl(t.root, ["import", "--source", "pg", "--file", csv, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ method: "information_schema", format_detected: true, tables: 8, primary_keys: 5, foreign_keys: 5, warnings: [] });
    const s = snapshotOf(t.root, "pg");
    expect(s.tables.map((x) => x.name)).toEqual(["customers", "event_notes", "events", "mv_daily", "order_lines", "orders", "shipments", "v_orders"]);
    const customers = table(s, `${schema}.customers`);
    expect(customers).toMatchObject({ kind: "table", row_count: 25, description: "People who buy, one row each.", primary_key: ["customer_id"] });
    expect(customers.columns[1]).toEqual({ name: "email", type: "text", nullable: false, description: 'Login "email", lowercased.' });
    const orders = table(s, `${schema}.orders`);
    expect(orders.columns.map((c) => c.type)).toEqual(["integer", "integer", `${schema}.order_status`, "bigint", "text[]"]);
    expect(orders.foreign_keys).toEqual([{ columns: ["customer_id"], references: { schema, table: "customers", columns: ["customer_id"] } }]);
    const lines = table(s, `${schema}.order_lines`);
    expect(lines.primary_key).toEqual(["line_no", "order_id"]);
    expect(lines.row_count).toBeNull();
    const shipments = table(s, `${schema}.shipments`);
    expect(shipments.columns.map((c) => c.name)).toEqual(["shipment_id", "order_id", "line_no"]);
    expect(shipments.foreign_keys).toEqual([
      { columns: ["order_id", "line_no"], references: { schema, table: "order_lines", columns: ["order_id", "line_no"] } },
      { columns: ["order_id"], references: { schema, table: "orders", columns: ["order_id"] } },
    ]);
    const events = table(s, `${schema}.events`);
    expect(events).toMatchObject({ kind: "table", row_count: 40, primary_key: ["event_id", "happened_at"] });
    expect(table(s, `${schema}.event_notes`).foreign_keys).toEqual([
      { columns: ["event_id", "happened_at"], references: { schema, table: "events", columns: ["event_id", "happened_at"] } },
    ]);
    expect(table(s, `${schema}.v_orders`)).toMatchObject({ kind: "view", row_count: null });
    expect(table(s, `${schema}.mv_daily`).kind).toBe("view");

    // Live introspection of the same schema reads the same tables, columns and keys. It also
    // lists the copies a foreign key to a partitioned table keeps for each partition; those
    // reference no snapshot table and are left out of the comparison.
    const shape = (snap: Snapshot) => {
      const names = new Set(snap.tables.map((x) => x.name));
      return snap.tables.map((x) => ({
        name: x.name,
        kind: x.kind,
        description: x.description,
        primary_key: x.primary_key,
        foreign_keys: x.foreign_keys?.filter((k) => names.has(k.references.table)),
        columns: x.columns.map(({ profile: _, ...c }) => c),
      }));
    };
    const imported = shape(s);
    const live = await sl(t.root, ["introspect", "--source", "pg", "--schemas", schema, "--json"], { SL_TEST_PG: PG_URL });
    expect(live.code).toBe(0);
    expect(live.json<{ changes: unknown }>().changes).toEqual({
      tables_added: [],
      tables_removed: [],
      columns: [],
      new_in_scope: [],
      left_scope: [],
      left_scope_with_models: [],
    });
    expect(shape(snapshotOf(t.root, "pg"))).toEqual(imported);
  });
});

// Redshift's leader-node catalog follows PostgreSQL's, so redshift.sql runs on PostgreSQL as
// written; this checks its key pairing and comments there.
describe("export-sql: redshift query on postgres, live", () => {
  const schema = "t_export_sql_rs";
  const psql = Bun.which("psql");
  const live = Boolean(PG_URL && psql);
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!live) return;
    pg = new SQL(PG_URL!);
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    for (const s of [
      `create schema ${schema}`,
      `create table ${schema}.dim_pair (x integer, y integer, label text, primary key (y, x))`,
      `comment on table ${schema}.dim_pair is 'Pairs, keyed y then x'`,
      `comment on column ${schema}.dim_pair.label is 'Shown, "as is"'`,
      `create table ${schema}.fct_hits (hit_id integer primary key, a integer, b integer, other_a integer, other_b integer,
        constraint hits_pair_fk foreign key (a, b) references ${schema}.dim_pair (x, y),
        constraint hits_other_fk foreign key (other_b, other_a) references ${schema}.dim_pair (y, x))`,
      `insert into ${schema}.dim_pair select g, g, null from generate_series(1, 12) g`,
      `analyze ${schema}.dim_pair`,
    ]) await pg.unsafe(s);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.close();
  });

  test.skipIf(!live)("pairs a composite foreign key's columns as declared, whatever the referenced key's order", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const sqlFile = join(t.dir, "export.sql");
    const csv = join(t.dir, "schema.csv");
    writeFileSync(sqlFile, exportSql("redshift", [schema]).sql);
    const run = Bun.spawnSync([psql!, "-X", PG_URL!, "--csv", "-v", "ON_ERROR_STOP=1", "-f", sqlFile]);
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    writeFileSync(csv, run.stdout);
    expect(run.stdout.toString().split("\n", 1)[0]).toBe(COLUMNS.join(","));
    writeFileSync(join(t.root, "sources", "rs.yaml"), "source: rs\ndialect: redshift\n");
    const r = await sl(t.root, ["import", "--source", "rs", "--file", csv, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, primary_keys: 2, foreign_keys: 2, warnings: [] });
    const s = snapshotOf(t.root, "rs");
    const pair = table(s, `${schema}.dim_pair`);
    expect(pair).toMatchObject({ row_count: 12, description: "Pairs, keyed y then x", primary_key: ["y", "x"] });
    expect(pair.columns[2]).toEqual({ name: "label", type: "text", nullable: true, description: 'Shown, "as is"' });
    expect(table(s, `${schema}.fct_hits`).foreign_keys).toEqual([
      { columns: ["other_b", "other_a"], references: { schema, table: "dim_pair", columns: ["y", "x"] } },
      { columns: ["a", "b"], references: { schema, table: "dim_pair", columns: ["x", "y"] } },
    ]);
  });
});

// Loads the Acme warehouse CSVs into Postgres. Drops and recreates the schema, creates every
// warehouse table with its types, loads rows in batches, then declares keys, comments and runs ANALYZE.
//
//   PG_URL=postgres://... bun fixtures/acme/load-postgres.ts [dataDir] [schema]
//
// Defaults: fixtures/acme/data and schema acme. fct_orders.customer_id has no foreign key:
// about 1% of orders reference customers that no longer exist.

import { join, resolve } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { POSTGRES_TYPES, WAREHOUSE_TABLES, readCsvSql, type TableDef } from "./schema.ts";

const BATCH_ROWS = 1000;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function createTableSql(schema: string, t: TableDef): string {
  const cols = t.columns.map((c) => `${ident(c.name)} ${POSTGRES_TYPES[c.type]}${c.nullable ? "" : " NOT NULL"}`);
  return `CREATE TABLE ${ident(schema)}.${ident(t.name)} (${cols.join(", ")})`;
}

// Reads a warehouse CSV with every column as text; Postgres casts on insert.
async function readCsv(path: string, t: TableDef): Promise<Record<string, string | null>[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  try {
    const reader = await c.runAndReadAll(`SELECT * FROM ${readCsvSql(path, t, true)}`);
    return reader.getRowObjectsJson() as Record<string, string | null>[];
  } finally {
    c.closeSync();
    instance.closeSync();
  }
}

export interface LoadResult {
  schema: string;
  rows: Record<string, number>;
}

export async function loadPostgres(url: string, dataDir: string, schema = "acme"): Promise<LoadResult> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const sql = new SQL({ url, max: 1 });
  const counts: Record<string, number> = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL TIME ZONE 'UTC'");
      await tx.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
      await tx.unsafe(`CREATE SCHEMA ${ident(schema)}`);
      for (const t of WAREHOUSE_TABLES) {
        await tx.unsafe(createTableSql(schema, t));
        const rows = await readCsv(join(dataDir, "warehouse", `${t.name}.csv`), t);
        const columns = t.columns.map((c) => c.name);
        for (let i = 0; i < rows.length; i += BATCH_ROWS) {
          const batch = rows.slice(i, i + BATCH_ROWS);
          await tx`INSERT INTO ${tx(`${schema}.${t.name}`)} ${tx(batch, ...columns)}`;
        }
        counts[t.name] = rows.length;
      }
      for (const t of WAREHOUSE_TABLES) {
        if (t.primaryKey) {
          await tx.unsafe(`ALTER TABLE ${ident(schema)}.${ident(t.name)} ADD PRIMARY KEY (${t.primaryKey.map(ident).join(", ")})`);
        }
      }
      for (const t of WAREHOUSE_TABLES) {
        for (const fk of t.foreignKeys ?? []) {
          await tx.unsafe(
            `ALTER TABLE ${ident(schema)}.${ident(t.name)} ADD FOREIGN KEY (${fk.columns.map(ident).join(", ")}) REFERENCES ${ident(schema)}.${ident(fk.table)} (${fk.refColumns.map(ident).join(", ")})`,
          );
        }
        if (t.comment) await tx.unsafe(`COMMENT ON TABLE ${ident(schema)}.${ident(t.name)} IS ${literal(t.comment)}`);
      }
    });
    await sql.unsafe(`ANALYZE ${WAREHOUSE_TABLES.map((t) => `${ident(schema)}.${ident(t.name)}`).join(", ")}`);
  } finally {
    await sql.close();
  }
  return { schema, rows: counts };
}

if (import.meta.main) {
  const url = process.env.PG_URL;
  if (!url) {
    console.error("Set PG_URL to the Postgres connection URL.");
    process.exit(1);
  }
  const dataDir = resolve(process.argv[2] ?? join(import.meta.dir, "data"));
  const schema = process.argv[3] ?? "acme";
  if (!SCHEMA_NAME.test(schema)) {
    console.error("Schema must match [a-z_][a-z0-9_]*");
    process.exit(1);
  }
  const result = await loadPostgres(url, dataDir, schema);
  const total = Object.values(result.rows).reduce((s, n) => s + n, 0);
  console.log(`Loaded ${Object.keys(result.rows).length} tables, ${total} rows, into schema ${result.schema}.`);
}

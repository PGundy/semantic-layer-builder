import { isAbsolute, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { UserError } from "../errors.ts";
import type { SourceConfig } from "../types.ts";
import { normalizeDecimal, normalizeInteger } from "./normalize.ts";
import type { Adapter, QueryResult } from "./types.ts";

const INTEGER_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function openDuckDB(root: string, source: SourceConfig): Promise<Adapter> {
  const conn = source.connection ?? {};
  const db = conn.database && conn.database !== ":memory:" ? conn.database : ":memory:";
  const dbPath = db === ":memory:" ? db : isAbsolute(db) ? db : resolve(root, db);
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(dbPath, db === ":memory:" ? {} : { access_mode: "READ_ONLY" });
  } catch (e) {
    throw new UserError(`Source "${source.source}": cannot open DuckDB database ${dbPath}: ${(e as Error).message}`);
  }
  const c: DuckDBConnection = await instance.connect();
  await c.run(`SET file_search_path=${quoteLiteral(root)}`);
  await c.run(`SET TimeZone='UTC'`);
  for (const stmt of conn.setup ?? []) {
    try {
      await c.run(stmt);
    } catch (e) {
      throw new UserError(`Source "${source.source}": setup statement failed: ${stmt}\n${(e as Error).message}`);
    }
  }
  for (const [name, relation] of Object.entries(conn.views ?? {})) {
    try {
      await c.run(`CREATE OR REPLACE TEMP VIEW ${quoteIdent(name)} AS SELECT * FROM ${relation}`);
    } catch (e) {
      throw new UserError(`Source "${source.source}": view "${name}" over ${relation} failed: ${(e as Error).message}`);
    }
  }
  return {
    dialect: "duckdb",
    async query(sql: string): Promise<QueryResult> {
      const reader = await c.runAndReadAll(sql);
      const columns = reader.columnNames();
      const types = reader.columnTypes().map((t) => t.toString());
      const rows = reader.getRowObjectsJson().map((row) => {
        const out: Record<string, unknown> = {};
        columns.forEach((col, i) => {
          const t = types[i] ?? "";
          const v = (row as Record<string, unknown>)[col];
          out[col] = INTEGER_TYPES.test(t) ? normalizeInteger(v) : t.startsWith("DECIMAL") ? normalizeDecimal(v) : (v ?? null);
        });
        return out;
      });
      return { columns, rows };
    },
    async close() {
      c.closeSync();
      instance.closeSync();
    },
  };
}

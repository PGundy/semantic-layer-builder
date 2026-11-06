import { isAbsolute, resolve } from "node:path";
import { DuckDBInstance, JsonDuckDBValueConverter, StatementType, type DuckDBConnection } from "@duckdb/node-api";
import { UserError } from "../errors.ts";
import { assertSourceSafe, resolvedRelation, viewFiles } from "../source-safety.ts";
import { isExplainAnalyze, statements, tokenize } from "../sql-guard.ts";
import type { SourceConfig } from "../types.ts";
import { normalizeDecimal, normalizeInteger } from "./normalize.ts";
import type { Adapter, AdapterOptions, QueryResult } from "./types.ts";

const INTEGER_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function listLiteral(items: string[]): string {
  return `[${items.map(quoteLiteral).join(", ")}]`;
}

// Why DuckDB will not run a statement, or undefined when it is one read-only statement: a SELECT
// (DuckDB plans DESCRIBE, SHOW, SUMMARIZE and table functions as SELECT) or an EXPLAIN without ANALYZE.
function refusal(type: StatementType, sql: string): string | undefined {
  if (type === StatementType.SELECT) return undefined;
  if (type === StatementType.EXPLAIN) {
    let analyze = true;
    try {
      analyze = statements(tokenize(sql)).some(isExplainAnalyze);
    } catch {
      analyze = true;
    }
    return analyze ? "EXPLAIN ANALYZE runs the statement it explains" : undefined;
  }
  return `it is a ${StatementType[type] ?? "non-SELECT"} statement`;
}

// Opens a DuckDB source read-only by construction. The source's setup statements and views are
// checked (lib/source-safety.ts) and run, each view with its relative paths resolved from the
// semantic root; then file access is limited to the files the views read
// (none when they read no files), extension autoinstall and autoload are turned off and the
// configuration is locked, so no later statement can change any of it. Each query is prepared and
// runs only when it is exactly one SELECT-type statement.
export async function openDuckDB(root: string, source: SourceConfig, _opts: AdapterOptions = {}): Promise<Adapter> {
  assertSourceSafe(source as unknown as Record<string, unknown>);
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
  const fail = (message: string): never => {
    c.closeSync();
    instance.closeSync();
    throw new UserError(message);
  };
  await c.run(`SET file_search_path=${quoteLiteral(root)}`);
  await c.run(`SET TimeZone='UTC'`);
  for (const [i, stmt] of (conn.setup ?? []).entries()) {
    try {
      await c.run(stmt);
    } catch (e) {
      fail(`Source "${source.source}": setup statement connection.setup[${i}] failed: ${(e as Error).message}`);
    }
  }
  for (const [name, relation] of Object.entries(conn.views ?? {})) {
    try {
      await c.run(`CREATE OR REPLACE TEMP VIEW ${quoteIdent(name)} AS SELECT * FROM ${resolvedRelation(root, relation)}`);
    } catch (e) {
      fail(`Source "${source.source}": view "${name}" failed: ${(e as Error).message}`);
    }
  }
  const files = viewFiles(root, source);
  try {
    if (files.directories.length) await c.run(`SET allowed_directories=${listLiteral(files.directories)}`);
    if (files.files.length) await c.run(`SET allowed_paths=${listLiteral(files.files)}`);
    await c.run("SET enable_external_access=false");
    await c.run("SET autoinstall_known_extensions=false");
    await c.run("SET autoload_known_extensions=false");
    await c.run("SET lock_configuration=true");
  } catch (e) {
    fail(`Source "${source.source}": cannot make the connection read-only: ${(e as Error).message}`);
  }
  return {
    dialect: "duckdb",
    async query(sql: string): Promise<QueryResult> {
      const extracted = await c.extractStatements(sql);
      if (extracted.count !== 1) {
        throw new UserError(extracted.count ? "Run one statement at a time." : "Empty query.");
      }
      const prepared = await extracted.prepare(0);
      try {
        const why = refusal(prepared.statementType, sql);
        if (why) throw new UserError(`Refusing the query: ${why}; only read-only queries run here.`);
        // The result is read a chunk at a time and each chunk turned into rows, so a large
        // result (a catalog of a million columns) is never held twice.
        const result = await prepared.stream();
        try {
          const columns = result.columnNames();
          // One conversion per column, chosen once from its type. Text is kept once per distinct
          // value, so a catalog's schema, table and type names repeated on every column row
          // share one copy.
          const seen = new Map<string, string>();
          const intern = (v: unknown): unknown => {
            if (typeof v !== "string") return v ?? null;
            const hit = seen.get(v);
            if (hit !== undefined) return hit;
            seen.set(v, v);
            return v;
          };
          const convert = result.columnTypes().map((type): ((v: unknown) => unknown) => {
            const t = type.toString();
            return INTEGER_TYPES.test(t) ? normalizeInteger : t.startsWith("DECIMAL") ? normalizeDecimal : t === "VARCHAR" ? intern : (v) => v ?? null;
          });
          const rows: Record<string, unknown>[] = [];
          for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
            for (const row of chunk.convertRows(JsonDuckDBValueConverter)) {
              const out: Record<string, unknown> = {};
              for (let i = 0; i < columns.length; i++) out[columns[i]!] = convert[i]!(row[i]);
              rows.push(out);
            }
          }
          return { columns, rows };
        } finally {
          result.closeSync();
        }
      } finally {
        prepared.destroySync();
      }
    },
    async close() {
      c.closeSync();
      instance.closeSync();
    },
  };
}

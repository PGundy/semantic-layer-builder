import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Adapter, QueryResult } from "../lib/adapters/index.ts";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { assertDistinctColumns, errorMessage, openQueryAdapter } from "../lib/plan.ts";
import { formatJson, formatTable, maskNote, maskRows, protectedNames, type SqlMask, sqlMask } from "../lib/output.ts";
import { loadSource } from "../lib/project.ts";
import { globInsideViews } from "../lib/source-safety.ts";
import { assertReadOnly } from "../lib/sql-guard.ts";

export const DEFAULT_LIMIT = 100;

// The --limit value: a positive integer, or DEFAULT_LIMIT when the flag is absent.
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new UserError(`--limit must be a positive integer; got "${raw}".`);
  return n;
}

// Whether a failed statement fails before it reads a row, so its error only says how the statement
// is written wrong (its syntax, or a name or a type it gets wrong) and quotes no value. DuckDB: its
// parser, binder and catalog errors. Postgres: an error of SQLSTATE class 42 that EXPLAIN of the
// statement, which reads no row, raises too; a function that looks a row's value up as a name
// raises class 42 as well, but only when the statement runs.
async function failsUnread(adapter: Adapter, dialect: string, sql: string, e: unknown): Promise<boolean> {
  if (dialect === "duckdb") return e instanceof Error && /^(Parser|Binder|Catalog) Error:/.test(e.message);
  const state = (e as { errno?: unknown } | null)?.errno;
  if (typeof state !== "string" || !state.startsWith("42") || !(e instanceof Error)) return false;
  try {
    await adapter.query(`explain ${sql}`);
    return false;
  } catch (planned) {
    return planned instanceof Error && (planned as { errno?: unknown }).errno === state && planned.message === e.message;
  }
}

// Runs the query, turning a database error (a typo, an unknown column) into a plain UserError.
// An error raised while the statement runs can quote a value it read (a failed cast names the text
// it could not convert), so its message is not shown when `guarded` says the statement names
// protected values (invariant 3).
async function queryOrFail(adapter: Adapter, dialect: string, sql: string, guarded: () => string | undefined): Promise<QueryResult> {
  try {
    return await adapter.query(sql);
  } catch (e) {
    if (e instanceof UserError) throw e;
    const reason = guarded();
    if (reason === undefined || (await failsUnread(adapter, dialect, sql, e))) throw new UserError(`Query failed: ${errorMessage(e, sql)}`);
    throw new UserError(
      `Query failed. The database's message can quote a value, and ${reason}, so it is not shown.\n` +
        "Check the statement's casts and comparisons against each column's type, then run sl run again.",
    );
  }
}

const spec: CommandSpec = {
  summary: "Run one read-only query against a duckdb or postgres source.",
  usage:
    "run --source <source> (--sql <query> | --file <path>) [--limit <n>] [--show-protected]   (--limit defaults to 100; all rows are counted, at most n are shown; " +
    "values of protected columns show as [protected] unless --show-protected)",
  options: {
    source: { type: "string" },
    sql: { type: "string" },
    file: { type: "string" },
    limit: { type: "string" },
    "show-protected": { type: "boolean" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const inline = str(values, "sql");
    const file = str(values, "file");
    if (!inline === !file) throw new UserError("Pass exactly one of --sql or --file.");
    const sql = inline ?? readFileSync(resolve(ctx.cwd, file!), "utf8");
    const limit = parseLimit(str(values, "limit"));
    const source = loadSource(ctx.root, sourceName);
    assertReadOnly(sql, { globAllowed: (pattern) => globInsideViews(ctx.root, source, pattern) });
    const adapter = await openQueryAdapter(ctx.root, source, ctx.env, { warn: ctx.err });
    try {
      // The statement is not the compiler's, so its columns are masked by what it reads (sqlMask).
      const show = bool(values, "show-protected");
      const prot = protectedNames(ctx.root, source);
      const { columns, rows } = await queryOrFail(adapter, source.dialect, sql, () => (show ? undefined : sqlMask(sql, [], prot, { ordered: true }).guard));
      assertDistinctColumns(columns);
      const mask: SqlMask = show ? { columns: [], reads: [], extra: false } : sqlMask(sql, columns, prot, { ordered: true });
      const shown = maskRows(rows.slice(0, limit), mask.columns);
      if (ctx.json) {
        ctx.out(
          formatJson({
            columns,
            rows: shown,
            row_count: rows.length,
            truncated: rows.length > shown.length,
            protected_columns: mask.columns,
            protected_reads: mask.reads,
            ...(mask.extra ? { protected_note: maskNote(mask) } : {}),
          }),
        );
      } else {
        ctx.out(formatTable(shown, columns));
        ctx.out(`(${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, showing ${shown.length}` : ""})`);
        if (mask.columns.length) ctx.out(maskNote(mask));
      }
    } finally {
      await adapter.close();
    }
    return 0;
  },
};
export default spec;

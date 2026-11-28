import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Adapter, QueryResult } from "../lib/adapters/index.ts";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { compileRequest } from "../lib/compiler/index.ts";
import { UserError } from "../lib/errors.ts";
import { inlineParams } from "../lib/goldens.ts";
import { assertDistinctColumns, errorMessage, openQueryAdapter } from "../lib/plan.ts";
import { formatJson, formatTable, maskNote, maskRows, plainText, protectedNames, protectedResultColumns, type SqlMask, sqlMask } from "../lib/output.ts";
import { loadSource } from "../lib/project.ts";
import { globInsideViews } from "../lib/source-safety.ts";
import { assertReadOnly } from "../lib/sql-guard.ts";
import { withAsOf } from "../lib/time-request.ts";
import { timeShapeWords } from "../lib/time-request-words.ts";
import { nextStep, parseUser, readRequest } from "./sql.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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
        "Check the statement's casts and comparisons against each column's type, then run semlayer run again.",
    );
  }
}

const spec: CommandSpec = {
  summary: "Run one read-only query against a duckdb or postgres source: a statement, or a request compiled from the layer.",
  usage:
    "run --source <source> (--sql <query> | --file <path> | --request <file|json> [--role <role>] [--user <json object of attributes>]) [--limit <n>] [--show-protected]   " +
    "(--request compiles the request as semlayer sql does and runs it with its parameters bound; --limit defaults to 100; all rows are counted, at most n are shown; " +
    "values of protected columns show as [protected] unless --show-protected)",
  options: {
    source: { type: "string" },
    sql: { type: "string" },
    file: { type: "string" },
    request: { type: "string" },
    role: { type: "string" },
    user: { type: "string" },
    limit: { type: "string" },
    "show-protected": { type: "boolean" },
  },
  writes: false,
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const inline = str(values, "sql");
    const file = str(values, "file");
    const requestText = str(values, "request");
    if ([inline, file, requestText].filter((v) => v !== undefined).length !== 1) throw new UserError("Pass exactly one of --sql, --file or --request.");
    for (const flag of ["role", "user"] as const)
      if (requestText === undefined && str(values, flag) !== undefined) throw new UserError(`--${flag} goes with --request: a statement of your own runs as written.`);
    const limit = parseLimit(str(values, "limit"));
    const source = loadSource(ctx.root, sourceName);
    // A request is compiled from the approved layer for the role and user given, as semlayer sql compiles it,
    // and what runs is that SQL with its parameters written in. Its lines are printed after the rows.
    const notes: string[] = [];
    let asOf: { as_of?: string; as_of_from?: string } = {};
    let compiledSql: string | undefined;
    if (requestText !== undefined) {
      const read = readRequest(requestText, ctx.cwd);
      const userFlag = str(values, "user");
      const user = userFlag !== undefined ? parseUser(userFlag) : (read.user ?? {});
      const role = str(values, "role") ?? read.role;
      const { request, filled } = withAsOf(read.request, ctx.now());
      const w = isObj(request) && isObj(request.window) ? request.window : undefined;
      if (w && typeof w.as_of === "string") asOf = { as_of: w.as_of, as_of_from: filled ? "clock" : "request" };
      const result = compileRequest(ctx.root, request, { source: sourceName, role, user });
      if (!result.ok) {
        const next = nextStep(result.refusals, result.source, user, role, read.golden).replaceAll("run semlayer sql again", "run semlayer run again");
        if (ctx.json) ctx.out(formatJson({ ...result, ...asOf, next }));
        else {
          ctx.err(plainText(`semlayer run refused the request: ${result.refusals.length === 1 ? result.reason : ""}`).trimEnd());
          if (result.refusals.length > 1) for (const r of result.refusals) ctx.err(plainText(`  - ${r.message}`));
          ctx.err(plainText(next));
        }
        return 1;
      }
      compiledSql = inlineParams(result.sql, result.params, source.dialect);
      if (filled) notes.push(`The window runs as of ${filled}, from the clock (the date in UTC); pass window.as_of to choose the date.`);
      notes.push(...timeShapeWords(request));
      for (const warning of result.warnings ?? []) notes.push(`Warning: ${warning.message}.`);
    }
    const sql = compiledSql ?? inline ?? readFileSync(resolve(ctx.cwd, file!), "utf8");
    assertReadOnly(sql, { globAllowed: (pattern) => globInsideViews(ctx.root, source, pattern) });
    const adapter = await openQueryAdapter(ctx.root, source, ctx.env, { warn: ctx.err });
    try {
      // A statement that is not the compiler's is masked by what it reads (sqlMask); the compiler's columns
      // carry the names of the fields they read, so they are masked by name, as semlayer goldens run masks them.
      const show = bool(values, "show-protected");
      const prot = protectedNames(ctx.root, source);
      const { columns, rows } = await queryOrFail(adapter, source.dialect, sql, () => (show ? undefined : sqlMask(sql, [], prot, { ordered: true }).guard));
      assertDistinctColumns(columns);
      const none: SqlMask = { columns: [], reads: [], extra: false };
      const mask: SqlMask = show ? none : compiledSql !== undefined ? { ...none, columns: protectedResultColumns(columns, prot) } : sqlMask(sql, columns, prot, { ordered: true });
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
            ...asOf,
            ...(notes.length ? { notes } : {}),
          }),
        );
      } else {
        ctx.out(formatTable(shown, columns));
        ctx.out(`(${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, showing ${shown.length}` : ""})`);
        if (mask.columns.length) ctx.out(maskNote(mask));
        for (const line of notes) ctx.out(plainText(line));
      }
    } finally {
      await adapter.close();
    }
    return 0;
  },
};
export default spec;

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bool, str, type CommandContext, type OptionValues } from "./command.ts";
import { UserError } from "./errors.ts";
import { canRun, openAdapter, type Adapter, type AdapterOptions, type RoleReport } from "./adapters/index.ts";
import { plainText, protectedNames, protectedResultColumns, sqlMask } from "./output.ts";
import { loadSource } from "./project.ts";
import type { PlannedQuery, PlanResults, QueryPlan, ResultRows, SourceConfig, StoredPlan } from "./types.ts";
import { schemaIssues } from "./validate.ts";
import { readJson, writeJson } from "./yaml.ts";

function lowerKeys(rows: ResultRows): ResultRows {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
}

// Characters of the query shown after an error position.
const EXCERPT_LENGTH = 20;

// The 1-based character position a driver attaches to an error, as Postgres errors carry
// in `position`, or undefined when there is none.
function errorPosition(e: unknown): number | undefined {
  if (!e || typeof e !== "object" || !("position" in e)) return undefined;
  const raw = (e as { position?: unknown }).position;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Where in the query an error points: "at character 31: \"month from\"", with up to
// EXCERPT_LENGTH characters of the query from that position and whitespace collapsed.
// Positions count characters (code points), as Postgres does, not UTF-16 code units.
function positionNote(position: number, sql: string | undefined): string {
  const chars = sql === undefined ? [] : Array.from(sql);
  if (sql === undefined || position > chars.length) return `at character ${position}`;
  const rest = chars.slice(position - 1);
  const excerpt = rest.slice(0, EXCERPT_LENGTH).join("").replace(/\s+/g, " ").trim();
  if (!excerpt) return `at character ${position}`;
  return `at character ${position}: "${excerpt}${rest.length > EXCERPT_LENGTH ? "…" : ""}"`;
}

// The message of an error thrown by a database driver, or its name when the message is empty.
// When the driver gives the error's position in the query, the message ends with that
// position and a short excerpt of `sql` from it.
export function errorMessage(e: unknown, sql?: string): string {
  const message = e instanceof Error ? e.message : String(e);
  const base = message.trim() || (e instanceof Error ? e.name : "unknown error");
  const position = errorPosition(e);
  return position === undefined ? base : `${base} (${positionNote(position, sql)})`;
}

// Opens a source's adapter for running queries. The DuckDB client renders TIMESTAMPTZ
// values with the offset of the process's local time zone; queries run with the session
// time zone UTC, so the offset is set to zero and values render in UTC ("+00"), as they do
// on postgres, whatever TZ the CLI runs under.
export async function openQueryAdapter(
  root: string,
  source: SourceConfig,
  env: Record<string, string | undefined>,
  opts: AdapterOptions = {},
): Promise<Adapter> {
  if (source.dialect === "duckdb") {
    const { DuckDBTimestampTZValue } = await import("@duckdb/node-api");
    DuckDBTimestampTZValue.timezoneOffsetInMinutes = 0;
  }
  return openAdapter(root, source, env, opts);
}

// Refuses a result with two columns of the same name, which would share one key in each row and
// lose a value: with `ignoreCase`, names that differ only in case count as the same.
export function assertDistinctColumns(columns: string[], ignoreCase = false): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const c of columns) {
    const k = ignoreCase ? c.toLowerCase() : c;
    if (seen.has(k)) dupes.add(c);
    seen.add(k);
  }
  if (!dupes.size) return;
  const names = [...dupes].map((d) => `"${d}"`).join(", ");
  throw new UserError(`The result has more than one column named ${names}; alias them so each column has its own name.`);
}

// Loads a results file written by the agent after it ran an emitted plan itself.
export function loadResults(path: string, plan: QueryPlan): PlanResults {
  const raw = readJson<Record<string, unknown>>(path);
  const out: PlanResults = {};
  const missing: string[] = [];
  for (const q of plan.queries) {
    const rows = raw[q.id];
    if (rows === undefined) {
      missing.push(q.id);
      continue;
    }
    if (!Array.isArray(rows)) throw new UserError(`${path}: "${q.id}" must be an array of row objects.`);
    out[q.id] = lowerKeys(rows as ResultRows);
  }
  if (missing.length) throw new UserError(`${path} is missing results for: ${missing.join(", ")}`);
  return out;
}

export interface ExecuteOptions {
  root: string;
  source: SourceConfig;
  env: Record<string, string | undefined>;
  resultsFile?: string;
  // A plan id from --plan: the results come from the plan's stored results (see planResults).
  planId?: string;
  // Called after each query; lets a long run report progress.
  onQuery?: (id: string, index: number, total: number) => void;
  // Where a warning about the connection goes; stderr by default.
  warn?: (message: string) => void;
  // Called with what the role can do, when the adapter measures it on connect (postgres).
  onRoleReport?: (report: RoleReport) => void;
}

// Runs a plan against a duckdb or postgres source, or reads its results from a file. A result
// with two columns whose names differ at most in case is refused, since rows are keyed by the
// lowercased name.
export async function executePlan(plan: QueryPlan, opts: ExecuteOptions): Promise<PlanResults> {
  if (opts.planId !== undefined) return planResults(opts.root, opts.planId, plan);
  if (opts.resultsFile) return loadResults(opts.resultsFile, plan);
  if (!canRun(opts.source)) {
    throw new UserError(
      `Source "${opts.source.source}" is ${opts.source.dialect}. Rerun with --emit-sql, run each query with your own ` +
        "tool, store each result with sl results add --plan <plan_id> --query <query id> --file <rows.json> and rerun with " +
        "--plan <plan_id>; or save {\"<query id>\": [rows...]} to a JSON file and rerun with --results <file>.",
    );
  }
  const adapter = await openQueryAdapter(opts.root, opts.source, opts.env, { warn: opts.warn });
  if (adapter.roleReport) opts.onRoleReport?.(adapter.roleReport);
  const out: PlanResults = {};
  try {
    for (const [i, q] of plan.queries.entries()) {
      try {
        const result = await adapter.query(q.sql);
        assertDistinctColumns(result.columns, true);
        // Adapter rows hold exactly the result's columns, so lowercase column names need no copy.
        out[q.id] = result.columns.every((c) => c === c.toLowerCase()) ? result.rows : lowerKeys(result.rows);
      } catch (e) {
        throw new UserError(`Query failed: ${errorMessage(e, q.sql)}\nQuery "${q.id}" (${q.purpose}):\n${q.sql}`);
      }
      opts.onQuery?.(q.id, i + 1, plan.queries.length);
    }
  } finally {
    await adapter.close();
  }
  return out;
}

// Stored query plans (spec: Query-plan protocol) ---------------------------------------------
//
// --emit-sql writes .sl/plans/<plan_id>.json under the semantic root; sl results add stores each
// query's rows under .sl/plans/<plan_id>/results/; the command finishes with --plan <plan_id>.

export const PLAN_ID_PATTERN = /^[0-9a-f]{12}$/;

// max_rows by query: one more than the rows a correct answer can have where that is known (a
// one-row aggregate gets 2), else a cap well above what the largest catalogs hold.
const MAX_ROWS_BY_ID: Record<string, number> = {
  tables: 200_000,
  columns: 5_000_000,
  primary_keys: 2_000_000,
  foreign_keys: 2_000_000,
};
const MAX_ROWS_BY_PREFIX: [string, number][] = [
  ["stats:", 2],
  ["join:", 2],
  ["top:", 10_001],
  ["golden:", 10_000],
];
const DEFAULT_MAX_ROWS = 100_000;

export function defaultMaxRows(id: string): number {
  return MAX_ROWS_BY_ID[id] ?? MAX_ROWS_BY_PREFIX.find(([p]) => id.startsWith(p))?.[1] ?? DEFAULT_MAX_ROWS;
}

export type CappedQuery = PlannedQuery & { max_rows: number };

// The plan with max_rows on every query: the query's own, else `maxRows[id]`, else the default.
export function withMaxRows(plan: QueryPlan, maxRows: Record<string, number> = {}): QueryPlan & { queries: CappedQuery[] } {
  return { ...plan, queries: plan.queries.map((q) => ({ ...q, max_rows: q.max_rows ?? maxRows[q.id] ?? defaultMaxRows(q.id) })) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The plan's id: a short hash of its content, so the same plan emitted again gets the same id.
export function planId(plan: QueryPlan): string {
  const { command, source, dialect } = plan;
  const queries = withMaxRows(plan).queries.map(({ id, purpose, sql, max_rows }) => ({ id, purpose, sql, max_rows }));
  return sha256(JSON.stringify({ command, source, dialect, queries })).slice(0, 12);
}

function plansDir(root: string): string {
  return join(root, ".sl", "plans");
}

function planPath(root: string, id: string): string {
  return join(plansDir(root), `${id}.json`);
}

// A query's result file: its id with unsafe characters replaced, plus a hash of the id, so two ids
// never share a file and no id names a path outside the plan's results directory.
function resultPath(root: string, id: string, query: string): string {
  const safe = query.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return join(plansDir(root), id, "results", `${safe}-${sha256(query).slice(0, 8)}.json`);
}

// Options never repeated in a plan's finish command.
const NOT_IN_FINISH = new Set(["emit-sql", "results", "plan", "json", "root", "help"]);

function shellWord(s: string): string {
  return /^[A-Za-z0-9_.,:/=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// The invocation as a command line, without --emit-sql, --results, --plan and the global flags.
export function commandLine(name: string, positionals: string[], values: OptionValues): string {
  const parts = ["sl", name, ...positionals.map(shellWord)];
  for (const [k, v] of Object.entries(values)) {
    if (NOT_IN_FINISH.has(k) || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === true) parts.push(`--${k}`);
      else if (x !== false) parts.push(`--${k}`, shellWord(String(x)));
    }
  }
  return parts.join(" ");
}

export interface Invocation {
  name: string;
  positionals?: string[];
  values: OptionValues;
}

export type EmittedPlan = QueryPlan & { queries: CappedQuery[]; plan_id: string; path: string };

// Writes the plan --emit-sql prints to .sl/plans/<plan_id>.json and returns what it prints: the
// plan, max_rows on each query, its plan_id and path. Results stored for the same plan stay.
export function emitPlan(ctx: CommandContext, plan: QueryPlan, how: Invocation): EmittedPlan {
  const full = withMaxRows(plan);
  const id = planId(full);
  const finish = `${commandLine(how.name, how.positionals ?? [], how.values)} --plan ${id}`;
  const stored: StoredPlan = { version: 1, plan_id: id, finish, ...full };
  const path = planPath(ctx.root, id);
  writeJson(path, stored);
  // Plans and results are working files: ignored even in a root sl init did not write.
  const ignore = join(plansDir(ctx.root), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  ctx.err(
    full.queries.length
      ? `Wrote plan ${id} to ${path}. Run each query with a row limit of its max_rows, store each result with ` +
          `sl results add --plan ${id} --query <query id> --file <rows.json>, then finish with ${finish}. ` +
          `sl results status --plan ${id} shows what remains.`
      : `Wrote plan ${id} to ${path}; it has no queries, so ${finish} finishes it.`,
  );
  return { ...full, plan_id: id, path };
}

// Where the command reads its results: --plan <id>, --results <file>, or neither (a live run).
export function resultsInput(ctx: CommandContext, values: OptionValues): { resultsFile?: string; planId?: string } {
  const file = str(values, "results");
  const id = str(values, "plan");
  if (id !== undefined && file !== undefined) throw new UserError("Pass --plan <id> or --results <file>, not both.");
  if (id !== undefined && bool(values, "emit-sql")) {
    throw new UserError("--emit-sql writes a new plan and --plan finishes one; pass one of them.");
  }
  return { resultsFile: file ? resolve(ctx.cwd, file) : undefined, planId: id };
}

// A finish command as emitPlan writes it: sl, the plan's command, words as shellWord quotes them,
// and --plan <id>. finish is outside the plan id, so an edited one is caught here.
const FINISH_WORD = "(?:[A-Za-z0-9_.,:/=@%+-]+|'(?:[^']|'\\\\'')*')";

function finishIsSafe(plan: StoredPlan, id: string): boolean {
  if (!/^[a-z][a-z-]*$/.test(plan.command)) return false;
  return new RegExp(`^sl ${plan.command}(?: ${FINISH_WORD})* --plan ${id}$`).test(plan.finish);
}

// Reads .sl/plans/<id>.json, refusing an id that is not a plan id, a missing plan, and a file that
// is not a valid plan or whose content no longer gives its id.
export function loadStoredPlan(root: string, id: string): StoredPlan {
  if (!PLAN_ID_PATTERN.test(id)) {
    throw new UserError(`"${id}" is not a plan id. A plan id is the 12-character plan_id --emit-sql prints.`);
  }
  const path = planPath(root, id);
  if (!existsSync(path)) {
    throw new UserError(
      `No query plan ${id} in ${plansDir(root)}. Emit one with the command's --emit-sql flag (for example ` +
        "sl introspect --source <s> --emit-sql) and use the plan_id it prints.",
    );
  }
  const raw = readJson<unknown>(path);
  const issue = schemaIssues("plan", raw, path)[0];
  if (issue) throw new UserError(`${path} is not a valid query plan (${issue.path || "plan"}: ${issue.message}). Emit it again with --emit-sql.`);
  const plan = raw as StoredPlan;
  if (plan.plan_id !== id || planId(plan) !== id || !finishIsSafe(plan, id)) {
    throw new UserError(`${path} changed after it was written: its content no longer gives plan id ${id}. Emit it again with --emit-sql.`);
  }
  return plan;
}

// A rows file for one query: a JSON array of objects, keys lowercased; two keys of one row that
// differ only in case are refused.
function readRows(path: string, id: string, query: string): ResultRows {
  if (!existsSync(path)) {
    throw new UserError(
      `No file ${path}. Save the rows of query "${query}" there as a JSON array of row objects, then rerun ` +
        `sl results add --plan ${id} --query ${shellWord(query)} --file <rows.json>.`,
    );
  }
  const raw = readJson<unknown>(path);
  if (!Array.isArray(raw)) throw new UserError(`${path} must hold a JSON array of row objects, the rows of query "${query}".`);
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new UserError(`${path}: row ${i + 1} is not an object; each row maps column names to values.`);
    }
    assertDistinctColumns(Object.keys(r), true);
  });
  return lowerKeys(raw as ResultRows);
}

// The stored rows of one query, or undefined when none are stored.
function storedRows(root: string, id: string, query: string): ResultRows | undefined {
  const path = resultPath(root, id, query);
  if (!existsSync(path)) return undefined;
  const raw = readJson<{ query?: unknown; rows?: unknown }>(path);
  if (!raw || raw.query !== query || !Array.isArray(raw.rows)) {
    throw new UserError(`${path} is not a stored result of query "${query}". Store it again with sl results add --plan ${id} --query ${query} --file <rows.json>.`);
  }
  return raw.rows as ResultRows;
}

// The protected columns of a golden's result: by name (see protectedResultColumns) for the compiled
// query, and by what the statement reads (see sqlMask) for its cross_check_sql, which can rename a
// column. A golden's sql can select any column, unlike the other plans, whose queries never select
// a protected column's values.
function protectedGoldenColumns(root: string, plan: StoredPlan, query: PlannedQuery, rows: ResultRows): string[] {
  if (!query.id.startsWith("golden:")) return [];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const prot = protectedNames(root, loadSource(root, plan.source));
  return query.id.endsWith(":cross_check") ? sqlMask(query.sql, columns, prot, { ordered: false }).columns : protectedResultColumns(columns, prot);
}

export interface AddedResult {
  plan_id: string;
  query: string;
  rows: number;
  path: string;
  // added: the first result for the query; replaced: different rows replaced the stored ones;
  // unchanged: the same rows were stored already.
  state: "added" | "replaced" | "unchanged";
}

// sl results add: stores the rows in `file` as the result of one query of a stored plan.
export function addResult(root: string, id: string, query: string, file: string): AddedResult {
  const plan = loadStoredPlan(root, id);
  const q = plan.queries.find((x) => x.id === query);
  if (!q) {
    throw new UserError(
      `Plan ${id} has no query "${query}". Its queries are ${plan.queries.map((x) => x.id).join(", ") || "none"}; ` +
        `sl results status --plan ${id} lists them.`,
    );
  }
  const rows = readRows(file, id, query);
  if (rows.length === q.max_rows) {
    throw new UserError(
      `The result of "${query}" has ${rows.length} rows, exactly its max_rows, so the tool that ran it may have cut it off. ` +
        `Run the query again so it returns every row (a row limit above ${q.max_rows}), then rerun sl results add.`,
    );
  }
  const masked = protectedGoldenColumns(root, plan, q, rows);
  if (masked.length) {
    throw new UserError(
      `The result of "${query}" has protected column${masked.length === 1 ? "" : "s"} ${masked.map(plainText).join(", ")}, and .sl/plans keeps no ` +
        `protected values, so it is not stored. Save the plan's rows as {"<query id>": [rows...]} to a scratch JSON file, finish with ` +
        `${plan.finish.replace(/ --plan [0-9a-f]{12}$/, " --results <file>")}, then delete the file.`,
    );
  }
  const path = resultPath(root, id, query);
  const text = `${JSON.stringify({ query, rows }, null, 2)}\n`;
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const state = before === undefined ? "added" : before === text ? "unchanged" : "replaced";
  if (state !== "unchanged") writeJson(path, { query, rows });
  return { plan_id: id, query, rows: rows.length, path, state };
}

export interface PlanStatus {
  plan_id: string;
  command: string;
  source: string;
  dialect: string;
  path: string;
  queries: { id: string; purpose: string; max_rows: number; stored: boolean; rows?: number }[];
  remaining: string[];
  complete: boolean;
  finish: string;
  next: string;
}

// sl results status: which queries of a stored plan have results and which remain.
export function planStatus(root: string, id: string): PlanStatus {
  const plan = loadStoredPlan(root, id);
  const queries = plan.queries.map((q) => {
    const rows = storedRows(root, id, q.id);
    return { id: q.id, purpose: q.purpose, max_rows: q.max_rows, stored: rows !== undefined, ...(rows ? { rows: rows.length } : {}) };
  });
  const remaining = queries.filter((q) => !q.stored).map((q) => q.id);
  const next = remaining.length
    ? `Next: run query "${remaining[0]}" and store its rows with sl results add --plan ${id} --query ${shellWord(remaining[0]!)} --file <rows.json>.`
    : `Next: ${plan.finish}`;
  return {
    plan_id: id,
    command: plan.command,
    source: plan.source,
    dialect: plan.dialect,
    path: planPath(root, id),
    queries,
    remaining,
    complete: !remaining.length,
    finish: plan.finish,
    next,
  };
}

// The results of a stored plan, for a command finishing with --plan <id>. Refused unless `plan`,
// the plan the command builds now, is the stored one and every query has a stored result.
export function planResults(root: string, id: string, plan: QueryPlan): PlanResults {
  const stored = loadStoredPlan(root, id);
  if (planId(plan) !== id) {
    throw new UserError(
      `Plan ${id} is not the plan this command builds now: the source, its snapshot, the models or the flags changed since ` +
        `it was emitted (for ${stored.finish}). Rerun the command with --emit-sql for a new plan and store its results.`,
    );
  }
  const out: PlanResults = {};
  const missing: string[] = [];
  for (const q of stored.queries) {
    const rows = storedRows(root, id, q.id);
    if (rows === undefined) missing.push(q.id);
    else out[q.id] = rows;
  }
  if (missing.length) {
    throw new UserError(
      `Plan ${id} still needs results for: ${missing.join(", ")}. Store each with sl results add --plan ${id} --query <query id> ` +
        `--file <rows.json>; sl results status --plan ${id} shows what remains.`,
    );
  }
  return out;
}

// Removes a stored plan and its results.
export function removePlan(root: string, id: string): void {
  if (!PLAN_ID_PATTERN.test(id)) return;
  rmSync(planPath(root, id), { force: true });
  rmSync(join(plansDir(root), id), { recursive: true, force: true });
}

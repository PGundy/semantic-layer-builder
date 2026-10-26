import { UserError } from "./errors.ts";
import { canRun, openAdapter, type Adapter } from "./adapters/index.ts";
import type { PlanResults, QueryPlan, ResultRows, SourceConfig } from "./types.ts";
import { readJson } from "./yaml.ts";

function lowerKeys(rows: ResultRows): ResultRows {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
}

// The message of an error thrown by a database driver, or its name when the message is empty.
export function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.trim() || (e instanceof Error ? e.name : "unknown error");
}

// Opens a source's adapter for running queries. The DuckDB client renders TIMESTAMPTZ
// values with the offset of the process's local time zone; queries run with the session
// time zone UTC, so the offset is set to zero and values render in UTC ("+00"), as they do
// on postgres, whatever TZ the CLI runs under.
export async function openQueryAdapter(root: string, source: SourceConfig, env: Record<string, string | undefined>): Promise<Adapter> {
  if (source.dialect === "duckdb") {
    const { DuckDBTimestampTZValue } = await import("@duckdb/node-api");
    DuckDBTimestampTZValue.timezoneOffsetInMinutes = 0;
  }
  return openAdapter(root, source, env);
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
  // Called after each query; lets a long run report progress.
  onQuery?: (id: string, index: number, total: number) => void;
}

// Runs a plan against a duckdb or postgres source, or reads its results from a file.
export async function executePlan(plan: QueryPlan, opts: ExecuteOptions): Promise<PlanResults> {
  if (opts.resultsFile) return loadResults(opts.resultsFile, plan);
  if (!canRun(opts.source)) {
    throw new UserError(
      `Source "${opts.source.source}" is ${opts.source.dialect}. Rerun with --emit-sql, run each query with your own ` +
        "tool, save {\"<query id>\": [rows...]} to a JSON file and rerun with --results <file>.",
    );
  }
  const adapter = await openQueryAdapter(opts.root, opts.source, opts.env);
  const out: PlanResults = {};
  try {
    for (const [i, q] of plan.queries.entries()) {
      try {
        out[q.id] = lowerKeys((await adapter.query(q.sql)).rows);
      } catch (e) {
        throw new UserError(`Query failed: ${errorMessage(e)}\nQuery "${q.id}" (${q.purpose}):\n${q.sql}`);
      }
      opts.onQuery?.(q.id, i + 1, plan.queries.length);
    }
  } finally {
    await adapter.close();
  }
  return out;
}

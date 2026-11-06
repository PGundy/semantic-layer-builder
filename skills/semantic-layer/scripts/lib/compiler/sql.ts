// SQL fragments the reference compiler writes, per dialect (references/spec.md, Reference compiler).
import type { Aggregation, Dialect, FilterOp, TimeGrain } from "../types.ts";

// The dialects the compiler writes SQL for.
export const COMPILER_DIALECTS: readonly Dialect[] = ["postgres", "duckdb"];

// Request filter values, bound as parameters in the order the SQL reads them: $1, $2, ... on both
// dialects. A value never enters the SQL text.
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

// A layer expr or filter as the compiler places it inside SQL. One that holds "--" ends with a
// newline inside parentheses, so a trailing line comment cannot swallow the SQL that follows.
export function embed(text: string): string {
  return text.includes("--") ? `(${text}\n)` : text;
}

// A time dimension at a grain. hour keeps the timestamp; day and coarser give a date. The
// expression is truncated as written, in the session time zone (UTC) for a value with a zone.
export function grained(_dialect: Dialect, expr: string, grain: TimeGrain): string {
  const truncated = `date_trunc('${grain}', ${expr})`;
  return grain === "hour" ? truncated : `cast(${truncated} as date)`;
}

// A measure's aggregate, with its filter applied inside the aggregate (FILTER, which postgres and
// duckdb both read), so it narrows only that measure.
export function aggregate(_dialect: Dialect, agg: Aggregation, expr: string | undefined, filter: string | undefined): string {
  const e = expr === undefined ? undefined : embed(expr);
  const inner = agg === "count_distinct" ? `count(distinct ${e})` : agg === "count" ? `count(${e ?? "*"})` : `${agg}(${e})`;
  return filter ? `${inner} filter (where ${embed(filter)})` : inner;
}

const COMPARE: Partial<Record<FilterOp, string>> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

// One request filter as a predicate over a field's SQL, each value a bound parameter.
export function predicate(sql: string, op: FilterOp, value: unknown, params: Params): string {
  const e = `(${sql})`;
  if (op === "is_null") return `${e} is null`;
  if (op === "not_null") return `${e} is not null`;
  if (op === "between") {
    const [lo, hi] = value as unknown[];
    return `${e} between ${params.add(lo)} and ${params.add(hi)}`;
  }
  if (op === "in" || op === "not_in") {
    const list = (value as unknown[]).map((v) => params.add(v)).join(", ");
    return `${e} ${op === "in" ? "in" : "not in"} (${list})`;
  }
  return `${e} ${COMPARE[op]} ${params.add(value)}`;
}

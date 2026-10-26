// SQL that measures how two tables connect over a join's keys.
import { quoteIdent, quoteTable } from "../dialect.ts";
import type { Dialect, JoinKey, PlannedQuery, QueryPlan, SourceConfig } from "../types.ts";

export interface TableRef {
  schema?: string | null;
  name: string;
}

export interface JoinCheck {
  // "<model>.<join>"; the query id is "join:<model>.<join>".
  id: string;
  left: TableRef;
  right: TableRef;
  keys: JoinKey[];
}

// The columns every join-check query returns, in order.
export const JOIN_CHECK_COLUMNS = [
  "left_rows",
  "left_null_keys",
  "matched_rows",
  "right_rows",
  "right_distinct_keys",
  "right_max_dup",
  "left_distinct_keys",
  "left_max_dup",
] as const;

export function joinQueryId(model: string, join: string): string {
  return `join:${model}.${join}`;
}

// One query returning a single row of JOIN_CHECK_COLUMNS. Null keys never match and
// are left out of the distinct-key and duplicate counts on both sides.
export function joinCheckSql(dialect: Dialect, check: Omit<JoinCheck, "id">): string {
  if (!check.keys.length) throw new Error("A join check needs at least one key.");
  const q = (name: string) => quoteIdent(dialect, name);
  const aliases = check.keys.map((_, i) => q(`k${i}`));
  const leftCols = check.keys.map((k, i) => `${q(k.from)} as ${aliases[i]}`).join(", ");
  const rightCols = check.keys.map((k, i) => `${q(k.to)} as ${aliases[i]}`).join(", ");
  const anyNull = aliases.map((a) => `${a} is null`).join(" or ");
  const noneNull = aliases.map((a) => `${a} is not null`).join(" and ");
  const keyList = aliases.join(", ");
  const on = aliases.map((a) => `lk.${a} = rk.${a}`).join(" and ");
  return [
    "with",
    `l as (select ${leftCols} from ${quoteTable(dialect, check.left)}),`,
    `r as (select ${rightCols} from ${quoteTable(dialect, check.right)}),`,
    `lk as (select ${keyList}, count(*) as n from l where ${noneNull} group by ${keyList}),`,
    `rk as (select ${keyList}, count(*) as n from r where ${noneNull} group by ${keyList})`,
    "select",
    "  (select count(*) from l) as left_rows,",
    `  (select count(*) from l where ${anyNull}) as left_null_keys,`,
    `  (select coalesce(sum(lk.n), 0) from lk join rk on ${on}) as matched_rows,`,
    "  (select count(*) from r) as right_rows,",
    "  (select count(*) from rk) as right_distinct_keys,",
    "  (select coalesce(max(n), 0) from rk) as right_max_dup,",
    "  (select count(*) from lk) as left_distinct_keys,",
    "  (select coalesce(max(n), 0) from lk) as left_max_dup",
  ].join("\n");
}

export function joinCheckPlan(source: SourceConfig, checks: JoinCheck[]): QueryPlan {
  const queries: PlannedQuery[] = checks.map((c) => ({
    id: `join:${c.id}`,
    purpose: `Match rate, key uniqueness and fan-out of join ${c.id}`,
    sql: joinCheckSql(source.dialect, c),
  }));
  return { command: "check-join", source: source.source, dialect: source.dialect, queries };
}

// SQL that measures the bridge of a bridge join (spec: Bridges and multi-fact requests): repeated pairs,
// bridge rows that name no fact or no target, facts with no bridge row, and how many target values
// each fact has. Every figure is a count: no value of any table leaves the database.
import { UserError } from "../errors.ts";
import { quoteIdent, quoteTable } from "../dialect.ts";
import type { Dialect, JoinKey, PlannedQuery } from "../types.ts";
import type { TableRef } from "./join-check.ts";

export interface ThroughCheck {
  // "<model>.<join>"; the query id is "through:<model>.<join>".
  id: string;
  fact: TableRef;
  bridge: TableRef;
  target: TableRef;
  // Fact column = bridge column (the join's keys), and bridge column = target column (through.keys).
  keys: JoinKey[];
  throughKeys: JoinKey[];
}

// What check-join records under evidence.through: counts only.
export interface ThroughEvidence {
  // The bridge model and the bridge-to-target keys the check measured.
  model: string;
  keys: JoinKey[];
  fact_rows: number;
  bridge_rows: number;
  // Bridge rows that repeat a (fact, target) pair an earlier row already holds; rows naming no fact or no target are not pairs.
  duplicate_rows: number;
  // Bridge rows whose fact key, or whose target key, matches no row (an empty key matches none).
  rows_without_fact: number;
  rows_without_target: number;
  // Fact rows with no bridge row that has both keys, and those with one or with several distinct target values.
  facts_unbridged: number;
  facts_one_value: number;
  facts_many_values: number;
  max_values_per_fact: number;
}

// The columns every bridge-check query returns, in order.
export const THROUGH_CHECK_COLUMNS = [
  "fact_rows",
  "bridge_rows",
  "duplicate_rows",
  "rows_without_fact",
  "rows_without_target",
  "facts_unbridged",
  "facts_one_value",
  "facts_many_values",
  "max_values_per_fact",
] as const;

export function throughQueryId(model: string, join: string): string {
  return `through:${model}.${join}`;
}

// One query returning a single row of THROUGH_CHECK_COLUMNS.
export function throughCheckSql(dialect: Dialect, c: Omit<ThroughCheck, "id">): string {
  if (!c.keys.length || !c.throughKeys.length) throw new Error("A bridge check needs keys on both hops.");
  const q = (name: string) => quoteIdent(dialect, name);
  const k = c.keys.map((_, i) => q(`k${i}`));
  const t = c.throughKeys.map((_, i) => q(`t${i}`));
  const notNull = (cols: string[], alias = "") => cols.map((x) => `${alias}${x} is not null`).join(" and ");
  const eq = (cols: string[], a: string, b: string) => cols.map((x) => `${a}.${x} = ${b}.${x}`).join(" and ");
  const fCols = c.keys.map((key, i) => `${q(key.from)} as ${k[i]}`).join(", ");
  const bCols = [...c.keys.map((key, i) => `${q(key.to)} as ${k[i]}`), ...c.throughKeys.map((key, i) => `${q(key.from)} as ${t[i]}`)].join(", ");
  const tCols = c.throughKeys.map((key, i) => `${q(key.to)} as ${t[i]}`).join(", ");
  const kl = k.join(", ");
  const both = [...k, ...t].join(", ");
  return [
    "with",
    `f as (select ${fCols} from ${quoteTable(dialect, c.fact)}),`,
    `b as (select ${bCols} from ${quoteTable(dialect, c.bridge)}),`,
    `t as (select ${tCols} from ${quoteTable(dialect, c.target)}),`,
    `fk as (select distinct ${kl} from f where ${notNull(k)}),`,
    `tk as (select distinct ${t.join(", ")} from t where ${notNull(t)}),`,
    `pairs as (select ${both}, count(*) as n from b where ${notNull([...k, ...t])} and exists (select 1 from fk where ${eq(k, "fk", "b")}) and exists (select 1 from tk where ${eq(t, "tk", "b")}) group by ${both}),`,
    `per as (select ${kl}, count(*) as v from pairs group by ${kl})`,
    "select",
    "  (select count(*) from f) as fact_rows,",
    "  (select count(*) from b) as bridge_rows,",
    "  (select coalesce(sum(n - 1), 0) from pairs) as duplicate_rows,",
    `  (select count(*) from b where not exists (select 1 from fk where ${eq(k, "fk", "b")})) as rows_without_fact,`,
    `  (select count(*) from b where not exists (select 1 from tk where ${eq(t, "tk", "b")})) as rows_without_target,`,
    `  (select count(*) from f where not exists (select 1 from per where ${eq(k, "per", "f")})) as facts_unbridged,`,
    `  (select count(*) from f join per on ${eq(k, "per", "f")} where per.v = 1) as facts_one_value,`,
    `  (select count(*) from f join per on ${eq(k, "per", "f")} where per.v > 1) as facts_many_values,`,
    `  (select coalesce(max(per.v), 0) from per join fk on ${eq(k, "fk", "per")}) as max_values_per_fact`,
  ].join("\n");
}

export function throughCheckQuery(dialect: Dialect, c: ThroughCheck): PlannedQuery {
  return { id: `through:${c.id}`, purpose: `Repeated pairs, unmatched rows and values per row of bridge join ${c.id}`, sql: throughCheckSql(dialect, c) };
}

function count(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new UserError(`Bridge check result has ${v === undefined || v === null ? "no" : "an invalid"} ${key}.`);
  return n;
}

// A bridge-check result row as evidence; refused when a count is missing or the counts disagree.
export function throughEvidence(row: Record<string, unknown>, model: string, keys: JoinKey[]): ThroughEvidence {
  const c = Object.fromEntries(THROUGH_CHECK_COLUMNS.map((k) => [k, count(row, k)])) as Record<(typeof THROUGH_CHECK_COLUMNS)[number], number>;
  const facts = c.facts_unbridged + c.facts_one_value + c.facts_many_values;
  if (facts > c.fact_rows || c.duplicate_rows > c.bridge_rows || c.rows_without_fact > c.bridge_rows || c.rows_without_target > c.bridge_rows)
    throw new UserError("Bridge check result is inconsistent: a count is larger than the rows it counts.");
  if ((c.facts_many_values > 0) !== (c.max_values_per_fact > 1)) throw new UserError("Bridge check result is inconsistent: facts_many_values and max_values_per_fact disagree.");
  return { model, keys: keys.map((k) => ({ from: k.from, to: k.to })), ...c };
}

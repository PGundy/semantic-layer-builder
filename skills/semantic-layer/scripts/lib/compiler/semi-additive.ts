// Semi-additive measures in the reference compiler (references/spec.md, Metric semantics,
// Semi-additive measures). A measure with non_additive_dimension is not added up across time: for
// each entity (its model's primary key without the non-additive column) and each group of the
// request, only the last (or first) row along that time dimension counts, and the measure's
// aggregate runs over those rows.
//
// semiAdditive takes the parts of a plain request the compiler has already built and returns the
// FROM clause that replaces the base table: a subquery that keeps one row per entity and group with
// DISTINCT ON, plus the outer names of its group and value columns.
// - keys: the SQL of the primary key columns other than the non-additive column;
// - groups: the SQL of each requested dimension, as it groups (a time dimension at its grain, through
//   grained() and the source's calendar), in the request's order;
// - values: the SQL of each measure's expr, undefined for a count of rows;
// - order: the SQL of the non-additive column itself, ungrained;
// - window: last (latest row first) or first (earliest row first);
// - from: the FROM and join lines of the plain query; where: its WHERE predicates (row filters,
//   request segments, dimension filters and the measures' shared filter), applied before DISTINCT ON.
// It returns from (the lines that take the place of the plain FROM and WHERE), group(i), the outer
// column for groups[i], and value(i), the outer column for values[i] (undefined for a count of rows).
// Runs on PostgreSQL 13 and later and on DuckDB.
import { quoteIdent } from "../dialect.ts";
import type { Dialect, Dimension, Measure, Model } from "../types.ts";
import type { RefusalCode } from "./index.ts";
import { measureFilter } from "./segments.ts";

export type SemiWindow = "last" | "first";
export const SEMI_WINDOWS: readonly SemiWindow[] = ["last", "first"];
// The aggregations a semi-additive measure may take: each reads one value per entity and group.
export const SEMI_AGGREGATIONS = ["sum", "avg", "min", "max"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// A measure's non_additive_dimension as {name, window}, or undefined when it sets none (or one
// without a name, which the schema reports).
export function nonAdditiveDimension(measure: unknown): { name: string; window: SemiWindow } | undefined {
  const nad = isObj(measure) ? measure.non_additive_dimension : undefined;
  if (!isObj(nad) || typeof nad.name !== "string") return undefined;
  return { name: nad.name, window: nad.window === "first" ? "first" : "last" };
}

// The columns that name one entity of a semi-additive measure's model: its primary key without the
// non-additive dimension's column. Undefined when the model has no primary key, or when the
// dimension is not a bare column of it, since then no row is known to be one entity's value on one day.
export function entityKeys(model: Pick<Model, "primary_key">, dim: Pick<Dimension, "expr">): string[] | undefined {
  const pk = Array.isArray(model.primary_key) ? model.primary_key.filter((c): c is string => typeof c === "string") : [];
  const bare = (c: string) => c.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
  const column = typeof dim.expr === "string" ? bare(dim.expr) : "";
  if (!pk.some((c) => bare(c) === column)) return undefined;
  return pk.filter((c) => bare(c) !== column);
}

// A measure field of a plain request, as the compiler resolved it.
interface MeasureField {
  ref: string;
  model: Model;
  item: Measure | Dimension;
}

export interface SemiAdditiveRequest<F extends MeasureField> {
  // The request's measures, each once, in the order the request first names them.
  measures: F[];
  keys: string[];
  dimension: Dimension;
  window: SemiWindow;
  // The measures' shared filter (their own filter and segments, measureFilter), or undefined.
  filter: string | undefined;
}

// Whether a plain request's measures (its selected ones and those its filters name) are
// semi-additive. Undefined when none is. When one is, every one must share its
// non_additive_dimension, window and filter, since one subquery keeps their rows; otherwise the
// request is refused as metric.semi_additive_mixed. A layer the validator would refuse (a dimension
// that is not a time dimension of the model, no primary key holding its column) is invalid_layer.
export function semiAdditiveRequest<F extends MeasureField>(
  base: Model,
  fields: F[],
  add: (code: RefusalCode, message: string, ref?: string, next?: string) => void,
): SemiAdditiveRequest<F> | undefined {
  const measures = fields.filter((f, i) => fields.findIndex((x) => x.ref === f.ref) === i);
  const first = measures.find((f) => nonAdditiveDimension(f.item));
  if (!first) return undefined;
  const nad = nonAdditiveDimension(first.item)!;
  const filter = measureFilter(first.item as Measure, first.model);
  const odd = measures.find((f) => {
    const other = nonAdditiveDimension(f.item);
    return !other || other.name !== nad.name || other.window !== nad.window || measureFilter(f.item as Measure, f.model) !== filter;
  });
  if (odd) {
    const why = nonAdditiveDimension(odd.item)
      ? `${odd.ref} keeps the ${nonAdditiveDimension(odd.item)!.window} value along another time dimension or has another filter`
      : `${odd.ref} adds up across time`;
    add(
      "metric.semi_additive_mixed",
      `${first.ref} is not added up across ${base.model}.${nad.name} (it keeps the ${nad.window} value in each period), and ${why}, so one query cannot compute both`,
      odd.ref,
      `Ask for ${first.ref} in a request of its own, apart from ${odd.ref}, and run semlayer sql again; a metric that combines them over one model cannot compile, so read it over measures that each compile alone.`,
    );
    return undefined;
  }
  const dimension = (base.dimensions ?? []).find((d) => d.name === nad.name);
  const keys = dimension && dimension.type === "time" ? entityKeys(base, dimension) : undefined;
  if (!dimension || !keys) {
    add(
      "invalid_layer",
      `${first.ref} has non_additive_dimension ${nad.name}, which needs a time dimension of ${base.model} over a column of its primary key; run semlayer validate`,
      first.ref,
      `Run semlayer validate, fix what it reports on ${first.ref}, and run semlayer sql again.`,
    );
    return undefined;
  }
  return { measures, keys, dimension, window: nad.window, filter };
}

export interface SemiAdditiveInput {
  dialect: Dialect;
  keys: string[];
  groups: string[];
  values: (string | undefined)[];
  order: string;
  window: SemiWindow;
  from: string[];
  where: string[];
}

export interface SemiAdditiveFrom {
  from: string[];
  group: (i: number) => string;
  value: (i: number) => string | undefined;
}

export function semiAdditive(p: SemiAdditiveInput): SemiAdditiveFrom {
  const q = (s: string) => quoteIdent(p.dialect, s);
  const alias = q("semi additive");
  const groupName = (i: number) => `group_${i + 1}`;
  const valueName = (i: number) => `value_${i + 1}`;
  const distinct = [...p.keys, ...p.groups];
  const picked = [
    ...p.groups.map((g, i) => `  ${g} as ${q(groupName(i))}`),
    ...p.values.flatMap((v, i) => (v === undefined ? [] : [`  ${v} as ${q(valueName(i))}`])),
  ];
  // A query with neither keys nor groups keeps the one row at the end of the time dimension.
  const select = distinct.length ? `select distinct on (${distinct.join(", ")})` : "select";
  const direction = p.window === "last" ? "desc" : "asc";
  const inner = [select, (picked.length ? picked : ["  1 as \"one\""]).join(",\n"), ...p.from];
  if (p.where.length) inner.push(`where ${p.where.join("\n  and ")}`);
  inner.push(`order by ${[...distinct, `${p.order} ${direction} nulls last`].join(", ")}`);
  if (!distinct.length) inner.push("limit 1");
  return {
    from: ["from (", ...inner.join("\n").split("\n").map((l) => `  ${l}`), `) as ${alias}`],
    group: (i) => `${alias}.${q(groupName(i))}`,
    value: (i) => (p.values[i] === undefined ? undefined : `${alias}.${q(valueName(i))}`),
  };
}

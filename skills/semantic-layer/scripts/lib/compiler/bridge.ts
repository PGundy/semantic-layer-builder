// Bridge joins in the reference compiler (references/spec.md, Bridges and multi-fact requests). A
// request grouped by a field of a bridge join's target reads the bridge as a subselect of one row per
// (row, target value) pair, so a pair the bridge lists twice counts once; under equal_split and weight
// each pair carries the share of its row's figure the owner's rule gives it, and a measure's sum or
// count is multiplied by that share, so the shares of one row add up to its figure once.
import { quoteIdent } from "../dialect.ts";
import type { Dedupe } from "../through.ts";
import type { Dialect, Measure } from "../types.ts";
import type { JoinPlan } from "./joins.ts";
import { aggregate, embed } from "./sql.ts";

// The column of the bridge subselect that holds a pair's share, under equal_split and weight.
export const SHARE = "semlayer_share";

// The bridge join a query groups through: the declared join, its bridge's alias and the rule.
export interface BridgeRoute {
  via: string; // model.join
  alias: string; // the bridge subselect's alias
  bridge: string;
  target: string;
  dedupe: Dedupe;
}

export interface BridgeSelect {
  dialect: Dialect;
  table: string; // the bridge table, quoted
  alias: string;
  // Bridge columns that pair it with the request's model, then with the target.
  factColumns: string[];
  targetColumns: string[];
  dedupe: Dedupe;
  weight?: string; // bridge column, under dedupe weight
  joins: string[]; // definition joins the user's row filter on the bridge reads through
  where?: string; // the user's row filter on the bridge
}

// The bridge as the query joins it: its rows the user sees, grouped to one row per pair, with the
// pair's share of its row's figure under equal_split (1/n of a row's n pairs) and weight (the pair's
// weight over the row's total weight; an equal share when that total is 0 or empty, so the row's
// shares still add up to its figure).
export function bridgeSelect(b: BridgeSelect): string {
  const q = (s: string) => quoteIdent(b.dialect, s);
  const col = (c: string) => `${q(b.alias)}.${q(c)}`;
  const keys = [...new Set([...b.factColumns, ...b.targetColumns])].map(col);
  const by = `partition by ${b.factColumns.map(col).join(", ")}`;
  const share =
    b.dedupe === "equal_split"
      ? [`1.0 / count(*) over (${by}) as ${q(SHARE)}`]
      : b.dedupe === "weight"
        ? [`coalesce(1.0 * sum(${col(b.weight!)}) / nullif(sum(sum(${col(b.weight!)})) over (${by}), 0), 1.0 / count(*) over (${by})) as ${q(SHARE)}`]
        : [];
  const lines = [`select ${[...keys, ...share].join(", ")}`, `from ${b.table} as ${q(b.alias)}`, ...b.joins];
  if (b.where) lines.push(`where ${b.where}`);
  lines.push(`group by ${keys.join(", ")}`);
  return `(\n${lines.map((l) => `  ${l}`).join("\n")}\n)`;
}

export interface ThroughMeasure {
  dialect: Dialect;
  plan: JoinPlan;
  ref: string;
  base: string;
  measure: Measure;
  expr: string | undefined;
  filter: string | undefined;
  // The request's grouped dimensions and its filters' fields, as compileLayerInner resolves them.
  dims: { model: { model: string }; item: unknown }[];
  filters: ({ ref: string; kind: string; model: { model: string }; item: unknown } | undefined)[];
  semiAdditive: boolean;
  add: (code: "join.through_filter_ungrouped" | "join.through_semi_additive" | "join.through_aggregate_unsupported" | "join.through_coarse_group", message: string, ref?: string, next?: string) => void;
}

// A measure's aggregate in a query that may group through a bridge join, or undefined when the query
// reads no bridge (the caller writes it as any aggregate). Refuses a filter on a field the base reaches
// only through a bridge unless the request groups by that field, a semi-additive measure grouped
// through a bridge, and, under equal_split and weight, an aggregate other than sum and count.
export function throughMeasure(t: ThroughMeasure): string | undefined {
  for (const f of t.filters) {
    if (f?.kind !== "dimension") continue;
    const via = t.plan.bridgeJoin(f.model.model);
    if (!via || t.dims.some((d) => d.model.model === f.model.model && d.item === f.item)) continue;
    t.add(
      "join.through_filter_ungrouped",
      `the request filters on ${f.ref}, a field of ${f.model.model}, which ${t.base} reaches only through the bridge join ${via}; without grouping by ${f.ref} the filter would count a row of ${t.base} once for each of its rows of ${f.model.model} that match`,
      f.ref,
      `Add ${f.ref} to the request's dimensions, or ask the owner for a dimension of ${t.base} that holds the answer in one value per row; then run semlayer sql again.`,
    );
  }
  const route = t.plan.through;
  if (!route) return undefined;
  if (t.semiAdditive) {
    t.add(
      "join.through_semi_additive",
      `${t.ref} keeps one value per period (a non_additive_dimension), and the request groups it by ${route.target} through the bridge join ${route.via}; a kept value is not shared among rows of ${route.target}`,
      t.ref,
      `Ask for ${t.ref} without the ${route.target} dimensions, or in a request of its own, and run semlayer sql again.`,
    );
    return "";
  }
  const agg = t.measure.agg;
  // Under distinct_pairs a pair counts once, so a grouping by a computed field of the target (several
  // targets can give it one value) would count a row once for each such target in one group.
  const coarse = t.dims.filter((d) => d.model.model === route.target && !/^\s*"?\w+"?\s*$/.test((d.item as { expr?: string }).expr ?? ""));
  if (route.dedupe === "distinct_pairs" && coarse.length) {
    const name = (coarse[0]!.item as { name?: string }).name ?? route.target;
    t.add(
      "join.through_coarse_group",
      `the request groups ${t.ref} by ${route.target}.${name}, a computed field, through the bridge join ${route.via} whose dedupe rule is distinct_pairs; two rows of ${route.target} can give it one value, and a row of ${t.base} listed with both would count twice in that group`,
      t.ref,
      `Group by a plain column of ${route.target} (its name or key), or ask the owner for the equal_split or weight rule, and run semlayer sql again.`,
    );
    return "";
  }
  if (route.dedupe === "distinct_pairs") return aggregate(t.dialect, agg, t.expr, t.filter);
  // A row with no bridge row (kept by a left join) has no share and counts in full.
  const share = `coalesce(${quoteIdent(t.dialect, route.alias)}.${quoteIdent(t.dialect, SHARE)}, 1)`;
  if (agg === "sum") return aggregate(t.dialect, "sum", `(${embed(t.expr!)}) * ${share}`, t.filter);
  if (agg === "count")
    return `coalesce(${aggregate(t.dialect, "sum", t.expr === undefined ? share : `case when (${embed(t.expr)}) is not null then ${share} end`, t.filter)}, 0)`;
  t.add(
    "join.through_aggregate_unsupported",
    `${t.ref} is ${agg}, and the request groups it by ${route.target} through the bridge join ${route.via}, whose dedupe rule ${route.dedupe} shares the figure of each row of ${t.base} among its rows of ${route.target}; only a sum or a count can be shared`,
    t.ref,
    `Ask for ${t.ref} without the ${route.target} dimensions, or for a sum or count measure by ${route.target}, and run semlayer sql again.`,
  );
  return "";
}

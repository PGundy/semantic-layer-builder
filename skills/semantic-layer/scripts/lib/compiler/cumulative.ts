// Running and trailing totals in the reference compiler (spec: Metric semantics, Running totals and
// comparisons). A request with `running: {over, periods?}` is compiled in two steps:
// - the inner request, the request without running, order_by, limit and its filters on the `over`
//   dimension, compiles through compileLayer as any request does, so joins, segments, the user's row
//   filters and measures of several models apply as they do without running;
// - spine() lays its rows over every period from the first to the last, each period with no rows
//   adding 0, and the outer query adds `<m>_running` (or `<m>_trailing_<n>`) per measure with a
//   window over the periods. A filter on the `over` dimension at its grain then picks the periods
//   shown, after the totals, so it never moves where a total starts.
// spine() is exported for the other time views, which build on the same filled periods.
import { quoteIdent } from "../dialect.ts";
import { grainShorthand, parseRequestField } from "../refs.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly } from "../sql-guard.ts";
import { grainStep, overField } from "../time-request.ts";
import type { Dialect, FilterOp, QueryRequest, RequestFilter } from "../types.ts";
import { NAME_PATTERN } from "../types.ts";
import type { Compiled, CompiledColumn, CompileInput, CompileResult, Refusal } from "./index.ts";
import { nonAdditiveDimension } from "./semi-additive.ts";
import { Params, predicate } from "./sql.ts";

type Compile = (input: CompileInput) => CompileResult;

// The aggregates a running total adds up: each totals to 0 over a period with no rows.
const RUNNING_AGGS = ["sum", "count"];
// The aggregates whose empty period counts as 0 in the filled periods.
const TOTALS = ["sum", "count", "count_distinct"];

export interface SpineInput {
  dialect: Dialect;
  // The grouped query whose rows are laid over the periods, and the names of its columns.
  inner: string;
  period: string;
  grain: string;
  others: string[];
  values: string[];
  // The value columns a period with no rows gives 0 for; every other value is null there.
  totals: string[];
}

// The CTEs "periods" (the inner query), "series" (every period from the first to the last, stepped
// by the grain in timestamps and cast back as grained() casts, so the session time zone never moves
// a period), "groups" (the distinct values of the other dimensions, when there are any) and "filled"
// (series cross groups, left joined to periods): one row per period and group: the period first, then the
// other dimensions, then the values.
export function spine(s: SpineInput): string[] {
  const q = (n: string) => quoteIdent(s.dialect, n);
  const p = q(s.period);
  const step = `generate_series(cast(min(${p}) as timestamp), cast(max(${p}) as timestamp), interval '${grainStep(s.grain)}')`;
  const ctes = [
    `${q("periods")} as (\n${s.inner}\n)`,
    `${q("series")} as (\nselect ${s.grain === "hour" ? step : `cast(${step} as date)`} as ${p}\nfrom ${q("periods")}\n)`,
  ];
  if (s.others.length) ctes.push(`${q("groups")} as (\nselect distinct ${s.others.map(q).join(", ")}\nfrom ${q("periods")}\n)`);
  const dims = [s.period, ...s.others];
  const cols = [
    ...dims.map((d) => `  ${d === s.period ? q("series") : q("groups")}.${q(d)}`),
    ...s.values.map((v) => (s.totals.includes(v) ? `  coalesce(${q("periods")}.${q(v)}, 0) as ${q(v)}` : `  ${q("periods")}.${q(v)}`)),
  ];
  const on = dims.map((d) => `${q("periods")}.${q(d)} is not distinct from ${d === s.period ? q("series") : q("groups")}.${q(d)}`).join(" and ");
  ctes.push(
    [`${q("filled")} as (`, "select", cols.join(",\n"), `from ${q("series")}`, ...(s.others.length ? [`cross join ${q("groups")}`] : []), `left join ${q("periods")} on ${on}`, ")"].join("\n"),
  );
  return ctes;
}

// The words a time view's refusals use: its request key, the view as a noun ("a running total"),
// and why a filter on a measure is refused under it.
export interface ViewWords {
  key: "running" | "compare";
  noun: string;
  measureFilter: string;
}

export interface ViewPlan {
  over: { field: string; model: string; name: string; grain: string };
  // The index of the over dimension in the request's dimensions.
  at: number;
  // The request's filters the inner request keeps, and those on the over dimension at its grain,
  // which pick the periods shown.
  inner: RequestFilter[];
  outer: RequestFilter[];
}

const isMetric = (input: CompileInput, ref: string) => NAME_PATTERN.test(ref) && input.layer.metrics.some((m) => m.name === ref && (m.source ?? input.source.source) === input.source.source);

// The checks every view over a time dimension shares: `over` names one of the request's dimensions
// in full, model.field:grain; no other dimension is that field at another grain; no filter is on a
// measure or metric; a filter on the over field is at its grain. undefined when `over` is not
// model.field:grain (the refusal is added).
export function viewPlan(input: CompileInput, request: QueryRequest, overRef: string, w: ViewWords, add: (message: string, ref?: string) => void): ViewPlan | undefined {
  const models = input.layer.models.filter((m) => m.source === input.source.source);
  const dimensions = request.dimensions ?? [];
  const over = overField(overRef);
  const short = grainShorthand(overRef);
  if (!over) {
    const like = dimensions.filter((d) => short !== undefined && parseRequestField(d)?.grain === short);
    add(
      short !== undefined
        ? `${w.key}.over is ${overRef}; ${w.key}.over names its time dimension in full, as model.field:${short}${like.length === 1 ? `: write ${like[0]}` : ""}`
        : `${w.key}.over is ${overRef}; it names a time dimension of the request at a grain, as model.field:grain`,
      overRef,
    );
    return undefined;
  }
  const at = dimensions.indexOf(overRef);
  if (at < 0) add(`${w.key}.over is ${overRef}, which is not one of the request's dimensions; add ${overRef} to dimensions, or name one of them in ${w.key}.over`, overRef);
  dimensions.forEach((d, i) => {
    const p = parseRequestField(d);
    if (i !== at && p && `${p.model}.${p.field}` === over.field)
      add(`dimensions[${i}] is ${d}, the same field as ${w.key}.over at another grain; the periods of ${w.noun} would mix the two grains: drop ${d}, or ask for it in its own request without ${w.key}`, d);
  });
  // A filter on the over dimension at its grain picks the periods shown; at no grain or another
  // grain it would change which rows each period holds.
  const inner: RequestFilter[] = [];
  const outer: RequestFilter[] = [];
  (request.filters ?? []).forEach((f, i) => {
    const p = parseRequestField(f.field);
    const isMeasure = isMetric(input, f.field) || (p && !p.grain && models.some((m) => m.model === p.model && m.measures.some((x) => x.name === p.field)));
    if (isMeasure)
      return void add(`filters[${i}] is on ${f.field}, a measure; ${w.measureFilter}: ask without ${w.key} to filter on ${f.field}, or filter the ${over.grain}s on ${overRef}`, f.field);
    if (!p || `${p.model}.${p.field}` !== over.field) return void inner.push(f);
    if (p.grain === over.grain) return void outer.push(f);
    add(
      `filters[${i}] is on ${f.field}, ${p.grain ? `at grain ${p.grain}` : "with no grain"}; ${w.noun} by ${over.grain} filters ${over.field} at its grain, which picks the ${over.grain}s shown: write the field as ${overRef}`,
      f.field,
    );
  });
  return { over, at, inner, outer };
}

// The request a view is built over: without its time view, order_by, limit and its filters on the
// over dimension.
export function innerRequest(request: QueryRequest, plan: ViewPlan): QueryRequest {
  const { running: _r, compare: _c, order_by: _o, limit: _l, filters: _f, ...rest } = request;
  return { ...rest, ...(plan.inner.length ? { filters: plan.inner } : {}) };
}

// The value columns a period with no rows gives 0 for in "filled": sum, count and count_distinct
// measures, a balance left out; a metric and any other measure are null there.
export function totalColumns(input: CompileInput, valueCols: CompiledColumn[]): string[] {
  const models = input.layer.models.filter((m) => m.source === input.source.source);
  return valueCols
    .filter((c) => {
      const p = parseRequestField(c.ref);
      const m = (models.find((x) => x.model === p?.model)?.measures ?? []).find((x) => x.name === p?.field);
      return !!m && TOTALS.includes(m.agg) && !nonAdditiveDimension(m);
    })
    .map((c) => c.name);
}

// The outer query of a view: the columns from the CTE `from`, the period filter in WHERE with its
// parameters after the inner request's, then order_by and limit by the rules of compileLayer, and the
// read-only check. A column selected twice, or an order_by the request does not select, is refused.
export function viewQuery(
  input: CompileInput,
  request: QueryRequest,
  r: Compiled,
  plan: ViewPlan,
  ctes: string[],
  from: string,
  columns: { column: CompiledColumn; sql?: string }[],
  w: ViewWords,
): CompileResult {
  const { source } = input;
  const q = (n: string) => quoteIdent(source.dialect, n);
  const refusals: Refusal[] = [];
  const add = (message: string, ref?: string) => {
    if (!refusals.some((x) => x.message === message)) refusals.push({ code: "invalid_request", message, ...(ref ? { ref } : {}) });
  };
  const cols = columns.map((c) => c.column);
  const seen = new Set<string>();
  for (const c of cols) {
    if (seen.has(c.name)) add(`the request selects the column ${c.name} twice: rename the measure or leave it out of ${w.noun.replace(/^a /, "the ")}`, c.ref);
    seen.add(c.name);
  }
  const dimCols = r.columns.slice(0, (request.dimensions ?? []).length);
  const orderBy = request.order_by ?? [];
  const position = orderBy.map((o, i) => {
    let k = cols.findIndex((c) => c.ref === o.field);
    if (k < 0) {
      const p = parseRequestField(o.field);
      const same = dimCols.filter((c) => p && !p.grain && c.ref.split(":")[0] === o.field);
      if (same.length === 1) k = cols.indexOf(same[0]!);
    }
    if (k < 0) add(`order_by[${i}] names ${o.field}, which the request does not select; add it to dimensions or measures`, o.field);
    return k;
  });
  if (refusals.length) return { ok: false, source: source.source, reason: refusals.map((x) => x.message).join("; "), refusals };
  const params = new Params((input.paramStart ?? 0) + r.params.length);
  const where = plan.outer.map((f) => predicate(q(dimCols[plan.at]!.name), f.op as FilterOp, f.value, params));
  const lines = [`with ${ctes.join(",\n")}`, "select", columns.map((c) => (c.sql && c.sql !== q(c.column.name) ? `  ${c.sql} as ${q(c.column.name)}` : `  ${q(c.column.name)}`)).join(",\n"), `from ${q(from)}`];
  if (where.length) lines.push(`where ${where.join("\n  and ")}`);
  if (orderBy.length) lines.push(`order by ${orderBy.map((o, i) => `${position[i]! + 1} ${o.direction ?? "asc"} nulls last`).join(", ")}`);
  if (request.limit !== undefined) lines.push(`limit ${request.limit}`);
  const sql = lines.join("\n");
  try {
    const root = input.root;
    assertReadOnly(sql, root ? { globAllowed: (p) => globInsideViews(root, source, p) } : {});
  } catch (e) {
    return { ok: false, source: source.source, reason: (e as Error).message, refusals: [{ code: "invalid_layer", message: `the compiled SQL is not read-only (${(e as Error).message}); run semlayer validate` }] };
  }
  return { ...r, sql, params: [...r.params, ...params.values], columns: cols };
}

const RUNNING_WORDS: ViewWords = { key: "running", noun: "a running total", measureFilter: "a filter on a total would leave a period out of the running total" };

export function compileRunning(input: CompileInput, request: QueryRequest, compile: Compile): CompileResult {
  const { layer, source } = input;
  const dialect = source.dialect;
  const running = request.running!;
  const refusals: Refusal[] = [];
  const add = (message: string, ref?: string) => {
    if (!refusals.some((r) => r.message === message)) refusals.push({ code: "invalid_request", message, ...(ref ? { ref } : {}) });
  };
  const refuse = (): CompileResult => ({ ok: false, source: source.source, reason: refusals.map((r) => r.message).join("; "), refusals });
  const models = layer.models.filter((m) => m.source === source.source);
  const measures = request.measures ?? [];

  const plan = viewPlan(input, request, running.over, RUNNING_WORDS, add);
  if (!plan) return refuse();
  const { over } = plan;
  if (!measures.length) add("the request names no measure; a running total adds up the request's measures, so name at least one");

  // Only sum and count measures add up across periods.
  measures.forEach((ref, i) => {
    if (isMetric(input, ref)) {
      add(`measures[${i}] names metric ${ref}; a running total adds up measures, not metrics: ask for the measures it combines, each with its own running total`, ref);
      return;
    }
    const p = parseRequestField(ref);
    const measure = p && (models.find((m) => m.model === p.model)?.measures ?? []).find((m) => m.name === p.field);
    if (!measure) return; // the inner request reports it
    const nad = nonAdditiveDimension(measure);
    if (nad)
      add(
        `measures[${i}] names ${ref}, a balance kept along ${p!.model}.${nad.name}; a balance is not added up across time, so it has no running total: ask for it by ${over.grain} without running`,
        ref,
      );
    else if (!RUNNING_AGGS.includes(measure.agg))
      add(`measures[${i}] names ${ref}, a measure with agg ${measure.agg}, which does not add up across periods; a running total takes sum and count measures: ask for one of those, or for ${ref} without running`, ref);
  });
  if (refusals.length) return refuse();

  const r = compile({ ...input, request: innerRequest(request, plan) });
  if (!r.ok) return r;

  const q = (n: string) => quoteIdent(dialect, n);
  const nDims = (request.dimensions ?? []).length;
  const dimCols = r.columns.slice(0, nDims);
  const valueCols = r.columns.slice(nDims);
  const period = dimCols[plan.at]!.name;
  const others = dimCols.filter((_, i) => i !== plan.at).map((c) => c.name);
  const ctes = spine({ dialect, inner: r.sql, period, grain: over.grain, others, values: valueCols.map((c) => c.name), totals: totalColumns(input, valueCols) });

  // <m>_running over every period so far, or <m>_trailing_<n> over the last n, null until n exist.
  const n = running.periods;
  const win = `${others.length ? `partition by ${others.map(q).join(", ")} ` : ""}order by ${q(period)}`;
  const added: CompiledColumn[] = valueCols.map((c) => ({ name: n === undefined ? `${c.name}_running` : `${c.name}_trailing_${n}`, ref: c.ref, kind: c.kind }));
  const windowed = valueCols.map((c, i) => {
    const m = q(c.name);
    const sum =
      n === undefined
        ? `sum(${m}) over (${win} rows between unbounded preceding and current row)`
        : `case when row_number() over (${win}) >= ${n} then sum(${m}) over (${win} rows between ${n - 1} preceding and current row) end`;
    return `  ${sum} as ${q(added[i]!.name)}`;
  });
  ctes.push([`${q("running totals")} as (`, "select", [...r.columns.map((c) => `  ${q(c.name)}`), ...windowed].join(",\n"), `from ${q("filled")}`, ")"].join("\n"));
  return viewQuery(input, request, r, plan, ctes, "running totals", [...r.columns, ...added].map((column) => ({ column })), RUNNING_WORDS);
}

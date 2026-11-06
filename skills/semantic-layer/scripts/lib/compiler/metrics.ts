// Metrics in the reference compiler (references/spec.md, Reference compiler): a request that names
// a ratio or derived metric. The measures it needs are aggregated per model, each model in a CTE
// compiled as a one-model request grouped by the request's dimensions; the CTEs combine on those
// dimensions, and each metric is computed over their columns. Filters on dimensions, and the user's
// row filters, apply inside every CTE; filters on measures and metrics in the outer WHERE.
import { quoteIdent } from "../dialect.ts";
import { parseRequestField } from "../refs.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly } from "../sql-guard.ts";
import type { Dialect, FilterOp, Measure, Metric, QueryRequest, RequestFilter } from "../types.ts";
import { NAME_PATTERN } from "../types.ts";
import type { AppliedRows, CompiledColumn, CompileInput, CompileResult, PlannedJoin, Refusal, RefusalCode } from "./index.ts";
import { JoinPlan } from "./joins.ts";
import { Params, predicate } from "./sql.ts";

type Compile = (input: CompileInput) => CompileResult;

// A metric formula: measure placeholders, numbers and + - * / with unary minus.
type Node =
  | { k: "ref"; model: string; measure: string }
  | { k: "num"; v: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node };

// Reads a derived metric's expr: {model.measure} placeholders combined with numbers, + - * / and
// parentheses. Undefined when it holds anything else or does not parse.
export function parseFormula(text: string): Node | undefined {
  const toks = text.match(/\{[^}]*\}|\d+(?:\.\d*)?|\.\d+|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const atom = (): Node | undefined => {
    const t = toks[i++];
    if (t === "(") {
      const a = sum();
      return toks[i++] === ")" ? a : undefined;
    }
    if (t === "-" || t === "+") {
      const a = atom();
      return a && (t === "-" ? { k: "neg", a } : a);
    }
    if (t && /^[\d.]/.test(t)) return { k: "num", v: t };
    const m = t?.match(/^\{\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*\}$/);
    return m ? { k: "ref", model: m[1]!, measure: m[2]! } : undefined;
  };
  const chain = (ops: string[], next: () => Node | undefined) => (): Node | undefined => {
    let a = next();
    while (a && ops.includes(toks[i] ?? "")) {
      const op = toks[i++] as "+" | "-" | "*" | "/";
      const b = next();
      a = b && { k: "bin", op, a, b };
    }
    return a;
  };
  const product = chain(["*", "/"], atom);
  const sum = chain(["+", "-"], product);
  const n = sum();
  return n && i === toks.length ? n : undefined;
}

const refs = (n: Node): { model: string; measure: string }[] =>
  n.k === "ref" ? [n] : n.k === "num" ? [] : n.k === "neg" ? refs(n.a) : [...refs(n.a), ...refs(n.b)];

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2 } as const;

type Column = (model: string, measure: string, divisor: boolean) => string;

// A formula as SQL over the CTE columns. A division divides by nullif(<divisor>, 0), so a zero
// divisor gives null, and on postgres casts its dividend to numeric, so two counts do not divide as
// integers.
function render(n: Node, dialect: Dialect, column: Column, parent = 0, right = false): string {
  if (n.k === "ref") return column(n.model, n.measure, false);
  if (n.k === "num") return n.v;
  if (n.k === "neg") return `-${n.a.k === "ref" || n.a.k === "num" ? render(n.a, dialect, column) : `(${render(n.a, dialect, column)})`}`;
  const p = PREC[n.op];
  let text: string;
  if (n.op === "/") {
    const top = render(n.a, dialect, column, dialect === "postgres" ? 0 : p);
    const below =
      n.b.k === "num" && Number(n.b.v) !== 0 ? n.b.v : `nullif(${n.b.k === "ref" ? column(n.b.model, n.b.measure, true) : render(n.b, dialect, column)}, 0)`;
    text = `${dialect === "postgres" ? `cast(${top} as numeric)` : top} / ${below}`;
  } else text = `${render(n.a, dialect, column, p)} ${n.op} ${render(n.b, dialect, column, p, true)}`;
  return p < parent || (right && p === parent) ? `(${text})` : text;
}

// The aggregates that total to zero over no rows: in a metric, one a group has no rows for (or
// whose filter leaves none) counts as 0.
const TOTALS = ["sum", "count", "count_distinct"];

// Compiles a request that names a metric anywhere, or returns undefined for one that names none.
// prior holds the refusals the request already has (visibility, dialect); compile is compileLayer,
// which compiles each model's part.
export function compileMetrics(input: CompileInput, request: QueryRequest, prior: Refusal[], compile: Compile): CompileResult | undefined {
  const { layer, source } = input;
  const dialect = source.dialect;
  const metricOf = (ref: string): Metric | undefined =>
    NAME_PATTERN.test(ref) ? layer.metrics.find((m) => m.name === ref && (m.source ?? source.source) === source.source) : undefined;
  const measures = request.measures ?? [];
  const dimensions = request.dimensions ?? [];
  const filters: RequestFilter[] = request.filters ?? [];
  const orderBy = request.order_by ?? [];
  if (![...measures, ...dimensions, ...filters.map((f) => f.field), ...orderBy.map((o) => o.field)].some((r) => metricOf(r))) return undefined;

  const refusals = [...prior];
  const add = (code: RefusalCode, message: string, ref?: string, next?: string) => {
    if (!refusals.some((r) => r.code === code && r.message === message)) refusals.push({ code, message, ...(ref ? { ref } : {}), ...(next ? { next } : {}) });
  };
  const refuse = (): CompileResult => ({ ok: false, source: source.source, reason: refusals.map((r) => r.message).join("; "), refusals });
  if (refusals.length) return refuse();

  const models = layer.models.filter((m) => m.source === source.source);
  const modelOf = (name: string) => models.find((m) => m.model === name);
  const measureOf = (model: string, name: string): Measure | undefined => (modelOf(model)?.measures ?? []).find((m) => m.name === name);

  // Each metric's formula, its measures checked against the layer.
  const formulas = new Map<string, Node | undefined>();
  const formula = (metric: Metric): Node | undefined => {
    if (formulas.has(metric.name)) return formulas.get(metric.name);
    const m = metric as unknown as Record<string, unknown>;
    let f: Node | undefined;
    if (m.type === "ratio") {
      const [n, d] = [m.numerator, m.denominator].map((x) => (typeof x === "string" ? parseRequestField(x.trim()) : undefined));
      if (n && d && !n.grain && !d.grain) f = { k: "bin", op: "/", a: { k: "ref", model: n.model, measure: n.field }, b: { k: "ref", model: d.model, measure: d.field } };
      else add("invalid_layer", `metric ${metric.name} needs a numerator and a denominator, each model.measure; run sl validate`, metric.name);
    } else if (m.type === "derived") {
      const node = typeof m.expr === "string" ? parseFormula(m.expr) : undefined;
      if (node && refs(node).length) f = node;
      else add("invalid_layer", `metric ${metric.name} has an expr sl sql cannot read: it combines {model.measure} placeholders with numbers and + - * / ( ) only; run sl validate`, metric.name);
    } else {
      add("unsupported_metric", `metric ${metric.name} is of type ${String(m.type)}, and sl sql compiles ratio and derived metrics only; run sl validate`, metric.name);
    }
    for (const r of f ? refs(f) : [])
      if (!measureOf(r.model, r.measure)) {
        add("invalid_layer", `metric ${metric.name} reads ${r.model}.${r.measure}, which is not a measure of source ${source.source}; run sl validate`, metric.name);
        f = undefined;
      }
    formulas.set(metric.name, f);
    return f;
  };

  // The measures each model's part aggregates, models in the order the request first needs them.
  const needs = new Map<string, string[]>();
  const need = (model: string, measure: string) => {
    const list = needs.get(model) ?? [];
    if (!list.includes(measure)) list.push(measure);
    needs.set(model, list);
  };
  const entryModels: string[][] = [];
  measures.forEach((ref, i) => {
    const metric = metricOf(ref);
    if (metric) {
      const f = formula(metric);
      const rs = f ? refs(f) : [];
      for (const r of rs) need(r.model, r.measure);
      entryModels.push([...new Set(rs.map((r) => r.model))]);
      return;
    }
    const p = parseRequestField(ref);
    if (!p) return; // reported by checkRequest
    if (!measureOf(p.model, p.field)) {
      if ((modelOf(p.model)?.dimensions ?? []).some((d) => d.name === p.field)) add("invalid_request", `measures[${i}] names ${ref}, which is a dimension; list it under dimensions`, ref);
      return;
    }
    if (p.grain !== undefined) add("invalid_request", `measures[${i}] names ${ref}, but ${p.model}.${p.field} is not a time dimension, so it takes no grain`, ref);
    need(p.model, p.field);
    entryModels.push([p.model]);
  });
  if (measures.length > 1 && new Set(entryModels.flat()).size > 1)
    add("invalid_request", "a request's measures must share one model, or be one metric: write a metric that combines them in metrics.yaml, or split the request");
  dimensions.forEach((ref, i) => {
    const p = parseRequestField(ref);
    if (metricOf(ref)) add("invalid_request", `dimensions[${i}] names ${ref}, which is a metric; list it under measures`, ref);
    else if (p && measureOf(p.model, p.field)) add("invalid_request", `dimensions[${i}] names ${ref}, which is a measure; list it under measures`, ref);
  });

  // Filters on measures and metrics go in the outer WHERE; those on dimensions into every part.
  const outer: { i: number; f: RequestFilter; metric?: Metric; model?: string; measure?: string }[] = [];
  const inner: RequestFilter[] = [];
  filters.forEach((f, i) => {
    const values = f.op === "in" || f.op === "not_in" || f.op === "between" ? (f.value as unknown[]) : f.op.endsWith("null") ? [] : [f.value];
    if (Array.isArray(values) && values.some((v) => v === null || typeof v === "object"))
      add("invalid_request", `filters[${i}] compares ${f.field} with null, a list or an object; use is_null or not_null for null`, f.field);
    const metric = metricOf(f.field);
    if (metric) {
      const fm = formula(metric);
      for (const r of fm ? refs(fm) : []) need(r.model, r.measure);
      outer.push({ i, f, metric });
      return;
    }
    const p = parseRequestField(f.field);
    if (p && measureOf(p.model, p.field)) {
      if (p.grain !== undefined) add("invalid_request", `filters[${i}] names a measure with a grain`, f.field);
      else if (!needs.has(p.model))
        add("invalid_request", `filters[${i}] names ${f.field}, a measure of model ${p.model}; a request filters only on measures of the models its measures and metrics use`, f.field);
      else need(p.model, p.field);
      outer.push({ i, f, model: p.model, measure: p.field });
    } else inner.push(f);
  });
  if (refusals.length || !needs.size) return refuse();

  // Each part groups by the request's dimensions as the request names them when its model is the
  // dimension's model or reaches it through one to-one path, so every part groups by the same
  // column. A part's model that reaches it by no path, or by several, groups by its own dimension of
  // the same name.
  const parts = [...needs.keys()];
  const base = parts[0]!;
  const across = parts.join(" and ");
  const reaches = (from: string, to: string): boolean => {
    const [a, b] = [modelOf(from), modelOf(to)];
    if (!a || !b) return false;
    let failed = false;
    const fail = () => {
      failed = true;
    };
    const plan = new JoinPlan({ source: source.source, dialect, models, snapshot: input.snapshot, base: a, qualified: true, add: fail });
    return plan.requestPath(b, to) !== undefined && !failed;
  };
  const mapped = (ref: string, model: string, what: string): string | undefined => {
    const p = parseRequestField(ref);
    if (!p || parts.length === 1 || model === p.model || reaches(model, p.model)) return ref;
    if ((modelOf(model)?.dimensions ?? []).some((d) => d.name === p.field)) return `${model}.${p.field}${p.grain ? `:${p.grain}` : ""}`;
    add(
      "no_shared_dimension",
      `${what} ${ref}, but its measures come from ${across}, each aggregated on its own model, so each of them needs to reach ${p.model} through one path of to-one joins or have a dimension named ${p.field}; ${model} has neither`,
      ref,
      `Add a many_to_one join from ${model} toward ${p.model} (sl check-join measures it), or a dimension ${p.field} to ${model} that gives the same value, approve it after its readback, and run sl sql again; or leave ${ref} out of the request.`,
    );
    return undefined;
  };

  const q = (s: string) => quoteIdent(dialect, s);
  const cte = (model: string) => q(`${model} measures`);
  const params = new Params();
  const joins: PlannedJoin[] = [];
  const rowFilters: AppliedRows[] = [];
  const bodies: string[] = [];
  let dimNames: string[] = [];
  for (const model of parts) {
    const dims = dimensions.map((d) => mapped(d, model, "the request groups by"));
    const where = inner.map((f) => ({ ...f, field: mapped(f.field, model, `a filter of the request is on`) }));
    if (dims.some((d) => d === undefined) || where.some((f) => f.field === undefined)) continue;
    const part: QueryRequest = {
      source: source.source,
      measures: needs.get(model)!.map((m) => `${model}.${m}`),
      ...(dims.length ? { dimensions: dims as string[] } : {}),
      ...(where.length ? { filters: where as RequestFilter[] } : {}),
    };
    // Each part is compiled for the request's user, so it applies their row filters as a plain
    // request does; its parameters follow those of the parts before it.
    const r = compile({ ...input, request: part, paramStart: params.values.length });
    if (!r.ok) {
      for (const x of r.refusals) add(x.code, model === base ? x.message : `for the measures of ${model}: ${x.message}`, x.ref, x.next);
      continue;
    }
    params.values.push(...r.params);
    joins.push(...r.joins.map((x) => ({ ...x, part: model })));
    rowFilters.push(...r.row_filters.map((x) => ({ ...x, part: model })));
    bodies.push(`${cte(model)} as (\n${r.sql}\n)`);
    if (model === base) dimNames = r.columns.slice(0, dimensions.length).map((c) => c.name);
  }
  if (refusals.length) return refuse();

  // The outer query: one row per group of any part, its measures and metrics.
  const grouped = parts.length > 1 && dimNames.length > 0;
  const groups = q("request groups");
  const column = (model: string, name: string) => `${cte(model)}.${q(name)}`;
  const measureColumn: Column = (model, name, divisor) =>
    !divisor && TOTALS.includes(measureOf(model, name)!.agg) ? `coalesce(${column(model, name)}, 0)` : column(model, name);
  const metricSql = (metric: Metric) => render(formulas.get(metric.name)!, dialect, measureColumn);
  const columns: (CompiledColumn & { sql: string })[] = [];
  dimensions.forEach((ref, i) =>
    columns.push({ name: dimNames[i]!, ref, kind: "dimension", sql: grouped ? `${groups}.${q(dimNames[i]!)}` : column(base, dimNames[i]!) }),
  );
  for (const ref of measures) {
    const metric = metricOf(ref);
    const p = parseRequestField(ref);
    if (metric) columns.push({ name: metric.name, ref, kind: "metric", sql: metricSql(metric) });
    else if (p) columns.push({ name: p.field, ref, kind: "measure", sql: column(p.model, p.field) });
  }
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.name)) add("invalid_request", `the request selects the column ${c.name} twice`, c.ref);
    seen.add(c.name);
  }
  const position = orderBy.map((o, i) => {
    let k = columns.findIndex((c) => c.ref === o.field);
    if (k < 0) {
      const p = parseRequestField(o.field);
      const same = columns.filter((c) => c.kind === "dimension" && p && !p.grain && c.ref.split(":")[0] === o.field);
      if (same.length === 1) k = columns.indexOf(same[0]!);
    }
    if (k < 0) add("invalid_request", `order_by[${i}] names ${o.field}, which the request does not select; add it to dimensions or measures`, o.field);
    return k;
  });
  if (refusals.length) return refuse();

  const lines = [`with ${bodies.join(",\n")}`];
  if (grouped) {
    const keys = dimNames.map(q).join(", ");
    lines[0] += `,\n${groups} as (\n${parts.map((m) => `select ${keys} from ${cte(m)}`).join("\nunion\n")}\n)`;
  }
  lines.push("select", columns.map((c) => `  ${c.sql} as ${q(c.name)}`).join(",\n"));
  if (grouped) {
    lines.push(`from ${groups}`);
    for (const m of parts) lines.push(`left join ${cte(m)} on ${dimNames.map((d) => `${column(m, d)} is not distinct from ${groups}.${q(d)}`).join(" and ")}`);
  } else {
    lines.push(`from ${cte(base)}`);
    for (const m of parts.slice(1)) lines.push(`cross join ${cte(m)}`);
  }
  const where = outer.map((o) => predicate(o.metric ? metricSql(o.metric) : column(o.model!, o.measure!), o.f.op as FilterOp, o.f.value, params));
  if (where.length) lines.push(`where ${where.join("\n  and ")}`);
  if (orderBy.length) lines.push(`order by ${orderBy.map((o, i) => `${position[i]! + 1} ${o.direction ?? "asc"} nulls last`).join(", ")}`);
  if (request.limit !== undefined) lines.push(`limit ${request.limit}`);
  const sql = lines.join("\n");
  try {
    const root = input.root;
    assertReadOnly(sql, root ? { globAllowed: (p) => globInsideViews(root, source, p) } : {});
  } catch (e) {
    refusals.push({ code: "invalid_layer", message: `the compiled SQL is not read-only (${(e as Error).message}); run sl validate` });
    return refuse();
  }
  return {
    ok: true,
    source: source.source,
    dialect,
    model: base,
    sql,
    params: params.values,
    columns: columns.map(({ name, ref, kind }) => ({ name, ref, kind })),
    joins,
    row_filters: rowFilters,
    session_time_zone: "UTC",
  };
}

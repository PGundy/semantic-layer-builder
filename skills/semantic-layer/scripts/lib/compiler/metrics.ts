// Metrics in the reference compiler (references/spec.md, Reference compiler): a request that names
// a ratio or derived metric. This file reads the metrics' formulas and works out the measures the
// request needs and how its filters split; parts.ts builds the per-model CTEs, combines them on the
// request's dimensions and computes each metric over their columns. Filters on dimensions, and the
// user's row filters, apply inside every CTE; filters on measures and metrics in the outer WHERE.
import { parseRequestField } from "../refs.ts";
import type { Dialect, Measure, Metric, QueryRequest, RequestFilter } from "../types.ts";
import { NAME_PATTERN } from "../types.ts";
import type { CompileInput, CompileResult, Refusal, RefusalCode } from "./index.ts";
import { type Column, compileParts, type OuterFilter } from "./parts.ts";

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
  const add = (code: RefusalCode, message: string, ref?: string, next?: string, extra?: Pick<Refusal, "reasons" | "awaits">) => {
    if (!refusals.some((r) => r.code === code && r.message === message)) refusals.push({ code, message, ...(ref ? { ref } : {}), ...(next ? { next } : {}), ...extra });
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
      else add("invalid_layer", `metric ${metric.name} needs a numerator and a denominator, each model.measure; run semlayer validate`, metric.name);
    } else if (m.type === "derived") {
      const node = typeof m.expr === "string" ? parseFormula(m.expr) : undefined;
      if (node && refs(node).length) f = node;
      else add("invalid_layer", `metric ${metric.name} has an expr semlayer sql cannot read: it combines {model.measure} placeholders with numbers and + - * / ( ) only; run semlayer validate`, metric.name);
    } else {
      add("unsupported_metric", `metric ${metric.name} is of type ${String(m.type)}, and semlayer sql compiles ratio and derived metrics only; run semlayer validate`, metric.name);
    }
    for (const r of f ? refs(f) : [])
      if (!measureOf(r.model, r.measure)) {
        add("invalid_layer", `metric ${metric.name} reads ${r.model}.${r.measure}, which is not a measure of source ${source.source}; run semlayer validate`, metric.name);
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
  const outer: OuterFilter[] = [];
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

  return compileParts({
    input,
    request,
    needs,
    inner,
    outer,
    metricOf,
    metricSql: (metric, column) => render(formulas.get(metric.name)!, dialect, column),
    compile,
    refusals,
    add,
    refuse,
  });
}

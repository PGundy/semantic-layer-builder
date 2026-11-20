// Reads the semantic models and metrics of a dbt manifest.json into typed data and a list of what
// could not be mapped. Pure: it takes the parsed manifest and touches no file, database or clock.
// Everything in a manifest is untrusted text, so names, descriptions, exprs and filters are carried
// as data and never run; nothing here writes a layer file. The manifest shape changed across dbt
// versions (a metric's filter is a string or {where_filters: [{where_sql_template}]}, a measure
// reference is a name or an object); every form is read, and a field this reader does not know is
// reported as a warning, never thrown.
import { type Obj, obj, s, splitRelationName, strings } from "./dbt.ts";

export interface DbtRelation {
  database: string | null;
  schema: string | null;
  table: string;
}

export interface DbtEntity {
  name: string;
  type: "primary" | "unique" | "foreign" | "natural";
  expr: string;
}

export interface DbtDimension {
  name: string;
  type: "categorical" | "time";
  expr: string;
  // The time granularity of a time dimension (day, month, ...), null for a categorical one.
  granularity: string | null;
  description: string | null;
}

export type DbtAgg = "sum" | "count" | "count_distinct" | "avg" | "min" | "max";

export interface DbtMeasure {
  name: string;
  agg: DbtAgg;
  expr: string;
  description: string | null;
  // The measure's own time dimension, when it names one.
  agg_time_dimension: string | null;
}

export interface DbtSemanticModel {
  name: string;
  relation: DbtRelation;
  description: string | null;
  entities: DbtEntity[];
  dimensions: DbtDimension[];
  measures: DbtMeasure[];
  // The model's default time dimension, when it names one.
  agg_time_dimension: string | null;
}

// A reference to a measure or a metric, with the filters written on that reference. Filter text is
// the raw dbt text (Jinja and all); translating it is another step.
export interface DbtMetricRef {
  name: string;
  alias: string | null;
  filters: string[];
}

export interface DbtMetric {
  name: string;
  kind: "simple" | "ratio" | "derived";
  description: string | null;
  // The raw text of the metric's own filter: one entry per where filter.
  filters: string[];
  // simple: the measure and the semantic model that holds it.
  measure?: DbtMetricRef & { model: string };
  // ratio
  numerator?: DbtMetricRef;
  denominator?: DbtMetricRef;
  // derived
  expr?: string;
  inputs?: DbtMetricRef[];
  // The semantic models whose measures the metric reads, sorted.
  models: string[];
}

export interface DbtJoinCandidate {
  from: string;
  to: string;
  entity: string;
  from_expr: string;
  to_expr: string;
  relationship: "many_to_one";
}

export interface DbtSkipped {
  kind: "semantic_model" | "dimension" | "measure" | "metric" | "join";
  name: string;
  reason: string;
}

export interface DbtSemantic {
  models: DbtSemanticModel[];
  metrics: DbtMetric[];
  joins: DbtJoinCandidate[];
  skipped: DbtSkipped[];
  warnings: string[];
}

const AGGS: Record<string, DbtAgg> = { sum: "sum", count: "count", count_distinct: "count_distinct", average: "avg", min: "min", max: "max" };
const ENTITY_TYPES = new Set(["primary", "unique", "foreign", "natural"]);

// Fields each manifest object is known to carry, used or not. Any other field is warned about once.
const KNOWN = {
  "semantic model": "name resource_type package_name path original_file_path unique_id fqn model node_relation description label defaults entities measures dimensions metadata depends_on refs created_at config unrendered_config primary_entity group",
  entity: "name type description label role expr config",
  dimension: "name type description label is_partition type_params expr metadata config datatype",
  measure: "name agg description label create_metric expr agg_params non_additive_dimension agg_time_dimension config",
  metric: "config created_at depends_on description filter fqn group label meta metadata metrics name original_file_path package_name path refs resource_type sources tags time_granularity type type_params unique_id unrendered_config",
  "metric type_params":
    "measure measures input_measures numerator denominator expr window grain_to_date metrics conversion_type_params cumulative_type_params metric_aggregation_params fill_nulls_with join_to_timespine is_private",
} as const;

const flat = (t: string) => t.replace(/\s+/g, " ").trim();
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 80);

// The raw filter texts of a metric or reference filter: a string (dbt 1.6), {where_filters: [...]}
// with each entry a string or {where_sql_template}, or a list of either.
function filterTexts(v: unknown): string[] {
  if (typeof v === "string") return v.trim() === "" ? [] : [v];
  if (Array.isArray(v)) return v.flatMap(filterTexts);
  const o = obj(v);
  if ("where_filters" in o) return filterTexts(o.where_filters);
  const t = s(o.where_sql_template);
  return t ? [t] : [];
}

// A measure or metric reference: a bare name or an object with a name, alias and filter.
function ref(v: unknown): DbtMetricRef | null {
  const name = s(v) ?? s(obj(v).name);
  if (!name) return null;
  const o = obj(v);
  return { name, alias: s(o.alias), filters: filterTexts(o.filter) };
}

// A dimension or entity expr: the column or SQL it names, else its own name (dbt's default).
// null when the text cannot be placed: not text, or Jinja.
function exprOf(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return name;
  const t = s(v);
  if (t === null || /\{\{|\{%|\{#/.test(t)) return null;
  return t.trim();
}

function relationOf(sm: Obj, nodes: Obj): DbtRelation | null {
  const nr = obj(sm.node_relation);
  const rel = s(nr.relation_name);
  const parts = rel ? splitRelationName(rel) : [];
  let table = parts[parts.length - 1] ?? s(nr.alias);
  let schema = parts.length >= 2 ? parts[parts.length - 2]! : s(nr.schema_name);
  let database = parts.length >= 3 ? parts[parts.length - 3]! : s(nr.database);
  if (!table) {
    // Older manifests: the model node the semantic model depends on.
    const id = strings(obj(sm.depends_on).nodes).find((n) => n.startsWith("model.") || n.startsWith("seed.") || n.startsWith("snapshot."));
    const node = id ? obj(nodes[id]) : {};
    table = s(node.alias) ?? s(node.name);
    schema = s(node.schema) ?? schema;
    database = s(node.database) ?? database;
  }
  return table ? { database, schema, table } : null;
}

export function readDbtSemantic(manifest: unknown): DbtSemantic {
  const m = obj(manifest);
  const nodes = obj(m.nodes);
  const out: DbtSemantic = { models: [], metrics: [], joins: [], skipped: [], warnings: [] };
  const warned = new Set<string>();
  const unknown = (kind: keyof typeof KNOWN, o: Obj, where: string) => {
    const known = new Set(KNOWN[kind].split(" "));
    for (const k of Object.keys(o)) {
      if (known.has(k) || warned.has(`${kind}.${k}`)) continue;
      warned.add(`${kind}.${k}`);
      out.warnings.push(`The dbt ${kind} field "${oneLine(k)}" is not recognised and was ignored (first seen on ${where}).`);
    }
  };
  const skip = (kind: DbtSkipped["kind"], name: string, reason: string) => out.skipped.push({ kind, name, reason });

  // Semantic models, in name order so the result does not depend on the manifest's key order.
  const rawModels = Object.values(obj(m.semantic_models))
    .map(obj)
    .filter((o) => s(o.name))
    .sort((a, b) => (s(a.name)! < s(b.name)! ? -1 : s(a.name)! > s(b.name)! ? 1 : 0));
  // measure name -> the model it belongs to; a skipped measure maps to its reason.
  const measureModel = new Map<string, string>();
  const skippedMeasure = new Map<string, string>();
  for (const sm of rawModels) {
    const name = s(sm.name)!;
    unknown("semantic model", sm, `semantic model ${oneLine(name)}`);
    if (obj(sm.config).enabled === false) {
      skip("semantic_model", name, "the semantic model is disabled in dbt");
      continue;
    }
    const relation = relationOf(sm, nodes);
    if (!relation) {
      skip("semantic_model", name, "no table behind it: the manifest gives neither a relation name nor a model node to read one from");
      continue;
    }
    const model: DbtSemanticModel = { name, relation, description: s(sm.description), entities: [], dimensions: [], measures: [], agg_time_dimension: s(obj(sm.defaults).agg_time_dimension) };
    const list = (v: unknown, what: string): Obj[] => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) {
        out.warnings.push(`Semantic model ${oneLine(name)}: "${what}" is not a list, so it was ignored.`);
        return [];
      }
      return v.map(obj);
    };
    for (const e of list(sm.entities, "entities")) {
      const en = s(e.name) ?? "";
      unknown("entity", e, `${oneLine(name)}.${oneLine(en)}`);
      const type = s(e.type) ?? "";
      const expr = exprOf(e.expr, en);
      if (!en || !ENTITY_TYPES.has(type) || expr === null) {
        out.warnings.push(`Semantic model ${oneLine(name)}: an entity${en ? ` ${oneLine(en)}` : ""} was ignored because its name, type or expr could not be read.`);
        continue;
      }
      model.entities.push({ name: en, type: type as DbtEntity["type"], expr });
    }
    for (const d of list(sm.dimensions, "dimensions")) {
      const dn = s(d.name) ?? "";
      unknown("dimension", d, `${oneLine(name)}.${oneLine(dn)}`);
      const full = `${name}.${dn}`;
      const type = s(d.type);
      if (!dn) continue;
      if (type !== "categorical" && type !== "time") {
        skip("dimension", full, `the dimension type ${JSON.stringify(oneLine(type ?? ""))} is neither categorical nor time`);
        continue;
      }
      const expr = exprOf(d.expr, dn);
      if (expr === null) {
        skip("dimension", full, "its expr is not plain SQL text (it is empty, not text, or uses Jinja), so no column can be named for it");
        continue;
      }
      const granularity = type === "time" ? (s(obj(d.type_params).time_granularity) ?? null) : null;
      model.dimensions.push({ name: dn, type, expr, granularity, description: s(d.description) });
    }
    for (const ms of list(sm.measures, "measures")) {
      const mn = s(ms.name) ?? "";
      unknown("measure", ms, `${oneLine(name)}.${oneLine(mn)}`);
      if (!mn) continue;
      const full = `${name}.${mn}`;
      const reason = (r: string) => {
        skip("measure", full, r);
        skippedMeasure.set(mn, r);
        measureModel.set(mn, name);
      };
      const rawAgg = s(ms.agg) ?? "";
      const agg = Object.hasOwn(AGGS, rawAgg) ? AGGS[rawAgg] : undefined;
      const expr = exprOf(ms.expr, mn);
      if (!agg) reason(`the aggregation ${JSON.stringify(oneLine(rawAgg))} has no equivalent here (supported: sum, count, count_distinct, average, min, max)`);
      else if (ms.non_additive_dimension !== null && ms.non_additive_dimension !== undefined) reason("it is semi-additive (non_additive_dimension), which is not imported");
      else if (expr === null) reason("its expr is not plain SQL text (it is empty, not text, or uses Jinja)");
      else {
        model.measures.push({ name: mn, agg, expr, description: s(ms.description), agg_time_dimension: s(ms.agg_time_dimension) });
        measureModel.set(mn, name);
      }
    }
    out.models.push(model);
  }

  // Join candidates: a foreign entity matched to a primary or unique entity of the same name in
  // another model. Direct pairs only; a name with more than one possible target is not guessed.
  for (const from of out.models) {
    for (const e of from.entities.filter((x) => x.type === "foreign")) {
      const targets = out.models
        .filter((t) => t !== from)
        .map((t) => ({ t, e: t.entities.find((x) => x.name === e.name && (x.type === "primary" || x.type === "unique")) }))
        .filter((x): x is { t: DbtSemanticModel; e: DbtEntity } => x.e !== undefined);
      if (targets.length === 1) {
        out.joins.push({ from: from.name, to: targets[0]!.t.name, entity: e.name, from_expr: e.expr, to_expr: targets[0]!.e.expr, relationship: "many_to_one" });
      } else if (targets.length > 1) {
        skip("join", `${from.name}.${e.name}`, `${targets.length} models (${targets.map((x) => x.t.name).join(", ")}) have a primary or unique entity ${e.name}, so the target is ambiguous`);
      }
    }
  }

  // Metrics. A ratio or derived metric reads other metrics, so resolve until nothing changes.
  const rawMetrics = Object.values(obj(m.metrics))
    .map(obj)
    .filter((o) => s(o.name))
    .sort((a, b) => (s(a.name)! < s(b.name)! ? -1 : s(a.name)! > s(b.name)! ? 1 : 0));
  const done = new Map<string, DbtMetric>();
  const failed = new Map<string, string>();
  const pending = new Map<string, Obj>();
  for (const mo of rawMetrics) {
    const name = s(mo.name)!;
    if (pending.has(name)) continue;
    pending.set(name, mo);
    unknown("metric", mo, `metric ${oneLine(name)}`);
    const tp = obj(mo.type_params);
    unknown("metric type_params", tp, `metric ${oneLine(name)}`);
  }
  const resolve = (name: string, mo: Obj): DbtMetric | string | null => {
    const kind = s(mo.type) ?? "";
    if (kind !== "simple" && kind !== "ratio" && kind !== "derived") return `the metric type ${JSON.stringify(oneLine(kind))} is not imported (only simple, ratio and derived are)`;
    const tp = obj(mo.type_params);
    // Null filling and the time spine change the numbers a metric gives, and are not imported.
    const reshapes = (v: unknown) => {
      const o = obj(v);
      return (o.fill_nulls_with ?? null) !== null || o.join_to_timespine === true;
    };
    const reads = kind === "ratio" ? [tp.numerator, tp.denominator] : kind === "derived" ? (Array.isArray(tp.metrics) ? tp.metrics : []) : [tp.measure];
    if (reshapes(tp) || reads.some(reshapes)) return "it fills nulls or joins to the time spine (fill_nulls_with, join_to_timespine), which is not imported";
    const metric: DbtMetric = { name, kind, description: s(mo.description), filters: filterTexts(mo.filter), models: [] };
    // Reads an input metric: null while it is unresolved, a string when it can never resolve.
    const input = (r: DbtMetricRef): string | null | "wait" => {
      if (failed.has(r.name)) return `it reads the metric ${r.name}, which was skipped: ${failed.get(r.name)}`;
      if (done.has(r.name)) return null;
      if (pending.has(r.name)) return "wait";
      return `it reads the metric ${r.name}, which the manifest does not define`;
    };
    const offset = (v: unknown) => {
      const o = obj(v);
      return (o.offset_window ?? null) !== null || (o.offset_to_grain ?? null) !== null;
    };
    const models = new Set<string>();
    if (kind === "simple") {
      const mr = ref(tp.measure);
      if (!mr) {
        return obj(tp.metric_aggregation_params).agg !== undefined
          ? "it is defined with metric_aggregation_params (the newer form without a measure), which is not imported"
          : "it names no measure";
      }
      const why = skippedMeasure.get(mr.name);
      if (why) return `its measure ${mr.name} was skipped: ${why}`;
      const model = measureModel.get(mr.name);
      if (!model) return `its measure ${mr.name} is not in any semantic model of the manifest`;
      metric.measure = { ...mr, model };
      models.add(model);
    } else {
      const refs =
        kind === "ratio"
          ? [ref(tp.numerator), ref(tp.denominator)]
          : (Array.isArray(tp.metrics) ? tp.metrics : []).map(ref);
      if (refs.some((r) => r === null) || (kind === "ratio" ? refs.length !== 2 : refs.length === 0)) return "the metrics it reads could not be read from the manifest";
      const rs = refs as DbtMetricRef[];
      const raw = kind === "ratio" ? [tp.numerator, tp.denominator] : (tp.metrics as unknown[]);
      if (raw.some(offset)) return "it reads an input over an offset window (offset_window or offset_to_grain), which is not imported";
      let wait = false;
      for (const r of rs) {
        const st = input(r);
        if (st === "wait") wait = true;
        else if (st) return st;
      }
      if (wait) return null;
      for (const r of rs) for (const mm of done.get(r.name)!.models) models.add(mm);
      if (kind === "ratio") {
        metric.numerator = rs[0]!;
        metric.denominator = rs[1]!;
      } else {
        const expr = s(tp.expr);
        if (!expr) return "it has no expr";
        metric.expr = expr;
        metric.inputs = rs;
      }
    }
    metric.models = [...models].sort();
    return metric;
  };
  for (let progress = true; progress && pending.size; ) {
    progress = false;
    for (const [name, mo] of [...pending]) {
      const r = resolve(name, mo);
      if (r === null) continue;
      pending.delete(name);
      progress = true;
      if (typeof r === "string") failed.set(name, r);
      else done.set(name, r);
    }
  }
  for (const name of pending.keys()) failed.set(name, "it is part of a loop of metrics that read each other");
  for (const mo of rawMetrics) {
    const name = s(mo.name)!;
    if (done.has(name)) out.metrics.push(done.get(name)!);
    else if (failed.has(name)) skip("metric", name, failed.get(name)!);
  }
  // Models skipped above are not in out.models; a metric over a measure in one of them was skipped by the lookup.
  return out;
}

// Where a semantic model's table stands against an imported snapshot.
export interface DbtOutside {
  kind: "semantic_model" | "metric" | "join";
  name: string;
  reason: string;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

// Lists the semantic models whose table is not among `kept` (the snapshot's tables), and the metrics
// that read them. `dropped` is the tables intake.schemas removed, so the reason can name that setting.
export function placeDbtSemantic(
  semantic: DbtSemantic,
  kept: readonly { schema: string | null; name: string }[],
  dropped: readonly { schema: string | null; name: string }[],
): DbtOutside[] {
  const at = (list: readonly { schema: string | null; name: string }[], r: DbtRelation) =>
    list.some((t) => same(t.name, r.table) && (same(t.schema, r.schema) || same(t.schema, r.database && r.schema ? `${r.database}.${r.schema}` : null)));
  const out: DbtOutside[] = [];
  const bad = new Set<string>();
  for (const sm of semantic.models) {
    if (at(kept, sm.relation)) continue;
    bad.add(sm.name);
    const table = [sm.relation.schema, sm.relation.table].filter(Boolean).join(".");
    out.push({
      kind: "semantic_model",
      name: sm.name,
      reason: at(dropped, sm.relation) ? `its table ${table} is outside intake.schemas` : `its table ${table} is not in the imported snapshot`,
    });
  }
  for (const mt of semantic.metrics) {
    const over = mt.models.filter((x) => bad.has(x));
    if (over.length) out.push({ kind: "metric", name: mt.name, reason: `it reads ${over.join(", ")}, whose table is not imported` });
  }
  for (const j of semantic.joins) {
    const over = [j.from, j.to].filter((x) => bad.has(x));
    if (over.length) out.push({ kind: "join", name: `${j.from} -> ${j.to}`, reason: `it touches ${over.join(", ")}, whose table is not imported` });
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The result as `import --semantic --json` reports it: the typed data, the counts and what was left out.
export function semanticJson(semantic: DbtSemantic, outside: DbtOutside[]) {
  const kinds = (k: DbtMetric["kind"]) => semantic.metrics.filter((m) => m.kind === k).length;
  return {
    counts: {
      semantic_models: semantic.models.length,
      dimensions: semantic.models.reduce((n, m) => n + m.dimensions.length, 0),
      measures: semantic.models.reduce((n, m) => n + m.measures.length, 0),
      metrics: semantic.metrics.length,
      simple: kinds("simple"),
      ratio: kinds("ratio"),
      derived: kinds("derived"),
      joins: semantic.joins.length,
      skipped: semantic.skipped.length,
      outside: outside.length,
    },
    models: semantic.models,
    metrics: semantic.metrics,
    joins: semantic.joins,
    skipped: semantic.skipped,
    outside,
    warnings: semantic.warnings,
  };
}

// The same, as plain lines for the terminal.
export function semanticLines(semantic: DbtSemantic, outside: DbtOutside[]): string[] {
  const c = semanticJson(semantic, outside).counts;
  const lines = [
    `Read ${plural(c.semantic_models, "semantic model")} (${plural(c.dimensions, "dimension")}, ${plural(c.measures, "measure")}) and ${plural(c.metrics, "metric")} ` +
      `(${c.simple} simple, ${c.ratio} ratio, ${c.derived} derived) from the manifest; ${plural(c.joins, "join candidate")}, ${c.skipped} skipped. Nothing was written to the layer.`,
  ];
  if (semantic.joins.length) {
    lines.push("Join candidates:");
    for (const j of semantic.joins) lines.push(`  - ${flat(j.from)} -> ${flat(j.to)} on ${flat(j.entity)} (${flat(j.from_expr)} = ${flat(j.to_expr)}), many to one`);
  }
  if (semantic.skipped.length) {
    lines.push("Skipped, with the reason:");
    for (const x of semantic.skipped) lines.push(`  - ${x.kind.replace("_", " ")} ${flat(x.name)}: ${flat(x.reason)}`);
  }
  if (outside.length) {
    lines.push("Reported, not imported:");
    for (const x of outside) lines.push(`  - ${x.kind.replace("_", " ")} ${flat(x.name)}: ${flat(x.reason)}`);
  }
  if (semantic.warnings.length) lines.push("Semantic warnings:", ...semantic.warnings.map((w) => `  - ${w}`));
  return lines;
}

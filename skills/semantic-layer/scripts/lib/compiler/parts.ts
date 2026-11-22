// The part builder of the reference compiler (references/spec.md, Reference compiler). A request whose
// measures come from one or more models is built as one part per model: each part is the request
// compiled for that model alone, grouped by the request's dimensions, in a CTE named "<model> measures".
// The parts combine on those dimensions (a union of their keys when there are several), and the outer
// query selects the request's dimensions, measures and metrics from them, with the filters on measures
// and metrics in its WHERE, then order and limit.
//
// compileParts takes the request, the measures each model contributes (needs), the filters already
// split into inner (dimension filters, applied inside every part) and outer (on measures and metrics),
// and the callbacks for what only the metrics code knows: metricOf finds a metric by its request name
// and metricSql renders its formula over the CTE columns it is given. It returns the compiled result,
// or the request's refusals when a part, a dimension or the order cannot be built.
import { evaluateLayer } from "../access.ts";
import { conformedPeers, conformedSchemas, zoneClash } from "../conformed.ts";
import { quoteIdent } from "../dialect.ts";
import { parseRequestField } from "../refs.ts";
import { backedPairs } from "../schema-scope.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly } from "../sql-guard.ts";
import type { FilterOp, Measure, Metric, QueryRequest, RequestFilter } from "../types.ts";
import type { AppliedRows, CompiledColumn, CompileInput, CompileResult, PlannedJoin, Refusal, RefusalCode } from "./index.ts";
import { JoinPlan } from "./joins.ts";
import { Params, predicate } from "./sql.ts";

// The SQL of a measure's column in the CTE of its model; divisor is true where a formula divides by it.
export type Column = (model: string, measure: string, divisor: boolean) => string;

// Records a refusal on the request, once per code and message.
export type AddRefusal = (code: RefusalCode, message: string, ref?: string, next?: string, extra?: Pick<Refusal, "reasons" | "awaits">) => void;

// A filter on a measure (model and measure) or on a metric, kept for the outer WHERE; i is its index
// in the request's filters.
export interface OuterFilter {
  i: number;
  f: RequestFilter;
  metric?: Metric;
  model?: string;
  measure?: string;
}

export interface PartsRequest {
  input: CompileInput;
  request: QueryRequest;
  // The measures each model's part aggregates, models in the order the request first needs them.
  needs: Map<string, string[]>;
  inner: RequestFilter[];
  outer: OuterFilter[];
  metricOf: (ref: string) => Metric | undefined;
  metricSql: (metric: Metric, column: Column) => string;
  // compileLayer, which compiles each model's part.
  compile: (input: CompileInput) => CompileResult;
  // The request's refusals so far (added to in place), how to add one, and the refused result they make.
  refusals: Refusal[];
  add: AddRefusal;
  refuse: () => CompileResult;
}

// The aggregates that total to zero over no rows: in a metric, one a group has no rows for (or
// whose filter leaves none) counts as 0.
const TOTALS = ["sum", "count", "count_distinct"];

export function compileParts(p: PartsRequest): CompileResult {
  const { input, request, needs, inner, outer, metricOf, metricSql: renderMetric, compile, refusals, add, refuse } = p;
  const { source } = input;
  const dialect = source.dialect;
  const measures = request.measures ?? [];
  const dimensions = request.dimensions ?? [];
  const orderBy = request.order_by ?? [];
  const models = input.layer.models.filter((m) => m.source === source.source);
  const modelOf = (name: string) => models.find((m) => m.model === name);
  const measureOf = (model: string, name: string): Measure | undefined => (modelOf(model)?.measures ?? []).find((m) => m.name === name);

  // Each part groups by the request's dimensions as the request names them when its model is the
  // dimension's model or reaches it through one to-one path, so every part groups by the same
  // column. A part's model with an approved dimension conformed with it (conforms_to, either way;
  // lib/conformed.ts) groups by that dimension instead, the owner's statement that it is the same; one
  // that reaches it by no path, or by several, groups by its own dimension of the same name. Every
  // part's column takes the name the request gives the dimension.
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
  // A conformed dimension applies once the dimension that carries it is approved and unchanged since.
  let vis: ReturnType<typeof evaluateLayer> | undefined;
  const approved = (model: string, name: string) => {
    vis ??= evaluateLayer(input.layer, input.user ?? {});
    const fields = vis.sources.find((s) => s.source === source.source)?.models.find((m) => m.model === model)?.fields ?? [];
    return fields.some((f) => f.kind === "dimension" && f.name === name && f.status === "approved");
  };
  const mapped = (ref: string, model: string, what: string): string | undefined => {
    const p = parseRequestField(ref);
    if (!p || parts.length === 1 || model === p.model) return ref;
    const grain = p.grain ? `:${p.grain}` : "";
    if (reaches(model, p.model)) return ref;
    const peers = conformedPeers(models, p.model, p.field, model);
    const live = peers.filter((x) => approved(x.carrier.model, x.carrier.name));
    if (live.length === 1) {
      const peer = live[0]!.dimension;
      const named = `${model}.${peer.name}`;
      const target = (modelOf(p.model)?.dimensions ?? []).find((d) => d.name === p.field);
      const zones = target && zoneClash(target, peer);
      if (zones) {
        add(
          "join.conformed_time_zone",
          `${what} ${ref}, which ${named} is declared the same as, but ${p.model}.${p.field} is stored in time zone ${zones[0]} and ${named} in ${zones[1]}, so a day of one is not a day of the other and their periods cannot be combined`,
          ref,
          `Ask for the measures of ${model} by ${named}${grain} in a request of their own, or make both dimensions count days in one zone and record it, and run semlayer sql again.`,
        );
        return undefined;
      }
      const schemas = conformedSchemas(input.snapshot, backedPairs(source, input.layer.compare_hashes === false ? undefined : input.layer.ledger), modelOf(p.model)!, modelOf(model)!);
      if (schemas) {
        add(
          "scope.cross_schema_undeclared",
          `${what} ${ref}, which ${named} is declared the same as, but ${p.model} and ${model} are in schemas ${schemas[0]} and ${schemas[1]}, and no approved schema pair joins them`,
          ref,
          `Record the pair with semlayer add-cross-schema --source ${source.source} --from ${schemas[0]} --to ${schemas[1]} --keys <table>.<column>=<table>.<column>, read it back and approve it on the owner's yes, and run semlayer sql again.`,
        );
        return undefined;
      }
      return `${named}${grain}`;
    }
    if (live.length > 1) {
      add("invalid_layer", `${what} ${ref}, and ${live.map((x) => `${model}.${x.dimension.name}`).join(" and ")} are each declared the same as it; run semlayer validate`, ref);
      return undefined;
    }
    if ((modelOf(model)?.dimensions ?? []).some((d) => d.name === p.field)) return `${model}.${p.field}${grain}`;
    const waiting = peers.map((x) => `${source.source}.${x.carrier.model}.${x.carrier.name}`);
    add(
      "no_shared_dimension",
      `${what} ${ref}, but its measures come from ${across}, each aggregated on its own model, so each of them needs to reach ${p.model} through one path of to-one joins or have a dimension named ${p.field}; ${model} has neither`,
      ref,
      waiting.length
        ? `${waiting.join(" and ")} declares conforms_to between ${model} and ${p.model} but awaits approval: read it back with semlayer readback --targets ${waiting.join(",")} and approve it on the owner's yes, then run semlayer sql again.`
        : `Add a many_to_one join from ${model} toward ${p.model} (semlayer check-join measures it), or a dimension ${p.field} to ${model} that gives the same value, approve it after its readback, and run semlayer sql again; ` +
            `or declare that a dimension of ${model} is the same as ${p.model}.${p.field} with semlayer conform; or leave ${ref} out of the request.`,
    );
    return undefined;
  };
  // Grouping by both dimensions of a conformed pair at one grain asks for one column twice: keep the first.
  // The request is refused here, before a part is built, only when this check found such a pair.
  const refusedBefore = refusals.length;
  if (parts.length > 1)
    dimensions.forEach((later, j) => {
      const b = parseRequestField(later);
      const i = dimensions.findIndex((first, k) => {
        const a = k < j ? parseRequestField(first) : undefined;
        if (!a || !b || a.model === b.model || (a.grain ?? "") !== (b.grain ?? "")) return false;
        return conformedPeers(models, a.model, a.field, b.model).some((x) => x.dimension.name === b.field && approved(x.carrier.model, x.carrier.name));
      });
      if (i < 0) return;
      // The corrected request is the user's own (window and comparison stay), when it lists both dimensions.
      const asked = input.original as QueryRequest | undefined;
      const from = asked?.dimensions?.includes(dimensions[i]!) && asked.dimensions.includes(later) ? asked : request;
      const keep = dimensions[i]!;
      const order = (from.order_by ?? []).map((o) => (o.field === later ? { ...o, field: keep } : o));
      const fixed = {
        ...from,
        dimensions: (from.dimensions ?? []).filter((d) => d !== later),
        ...(order.length ? { order_by: order.filter((o, k) => order.findIndex((x) => x.field === o.field) === k) } : {}),
      };
      add(
        "join.conformed_both_sides",
        `the request groups by ${dimensions[i]} and by ${later}, which are declared the same dimension, so grouping by one of them is enough and the two would be one column twice`,
        later,
        `Keep ${dimensions[i]} and drop ${later}; run semlayer sql --request '${JSON.stringify(fixed).replace(/'/g, "'\\''")}'`,
      );
    });
  if (refusals.length > refusedBefore) return refuse();
  // The name each grouping column has in the result: the name the request gives the dimension.
  const dimNames = dimensions.map((d) => {
    const p = parseRequestField(d);
    return p ? (p.grain ? `${p.field}_${p.grain}` : p.field) : d;
  });

  const q = (s: string) => quoteIdent(dialect, s);
  const cte = (model: string) => q(`${model} measures`);
  const params = new Params(input.paramStart);
  const joins: PlannedJoin[] = [];
  const rowFilters: AppliedRows[] = [];
  const bodies: string[] = [];
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
    const r = compile({ ...input, request: part, paramStart: (input.paramStart ?? 0) + params.values.length });
    if (!r.ok) {
      for (const x of r.refusals)
        add(x.code, model === base ? x.message : `for the measures of ${model}: ${x.message}`, x.ref, x.next, {
          ...(x.reasons ? { reasons: x.reasons } : {}),
          ...(x.awaits ? { awaits: x.awaits } : {}),
        });
      continue;
    }
    params.values.push(...r.params);
    joins.push(...r.joins.map((x) => ({ ...x, part: model })));
    rowFilters.push(...r.row_filters.map((x) => ({ ...x, part: model })));
    // A part grouped by a conformed dimension names its column as the request does.
    const names = r.columns.map((c, i) => (i < dimensions.length ? dimNames[i]! : c.name));
    const renamed = names.some((n, i) => n !== r.columns[i]!.name);
    bodies.push(`${cte(model)}${renamed ? ` (${names.map(q).join(", ")})` : ""} as (\n${r.sql}\n)`);
  }
  if (refusals.length) return refuse();

  // The outer query: one row per group of any part, its measures and metrics.
  const grouped = parts.length > 1 && dimNames.length > 0;
  const groups = q("request groups");
  const column = (model: string, name: string) => `${cte(model)}.${q(name)}`;
  const measureColumn: Column = (model, name, divisor) =>
    !divisor && TOTALS.includes(measureOf(model, name)!.agg) ? `coalesce(${column(model, name)}, 0)` : column(model, name);
  const metricSql = (metric: Metric) => renderMetric(metric, measureColumn);
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
    refusals.push({ code: "invalid_layer", message: `the compiled SQL is not read-only (${(e as Error).message}); run semlayer validate` });
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

// The reference compiler (references/spec.md, Reference compiler): turns a request into SQL for a
// postgres or duckdb source, with every request filter value a bound parameter. A request reaches
// other models' fields through to-one joins, and a field's definition joins come along with it; a
// request that names a metric compiles each model's measures on their own (metrics.ts). It never
// runs the SQL. The user's row filters limit the base model in WHERE and a model a request path
// reaches in its join's ON clause (rowfilters.ts), in every part of a metric as in a plain request.
import { type AccessLayer, type AccessUser, checkRequest, evaluateLayer, loadAccessLayer, type ModelRows } from "../access.ts";
import { quoteIdent } from "../dialect.ts";
import { loadSnapshot, loadSource } from "../project.ts";
import { parseRequestField } from "../refs.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly } from "../sql-guard.ts";
import { sqlNames } from "../sql-names.ts";
import { sqlTextProblem, type TextRole } from "../sql-text.ts";
import type { Dimension, FilterOp, Measure, Model, QueryRequest, Snapshot, SourceConfig, TimeGrain } from "../types.ts";
import { AGGREGATIONS, NAME_PATTERN, TIME_GRAINS } from "../types.ts";
import { schemaIssues } from "../validate.ts";
import { type Instance, JoinPlan, type PlannedJoin, readsJoin } from "./joins.ts";
import { compileMetrics } from "./metrics.ts";
import { type AppliedRows, rowsPredicate } from "./rowfilters.ts";
import { aggregate, COMPILER_DIALECTS, embed, grained, Params, predicate } from "./sql.ts";

export type { PlannedJoin } from "./joins.ts";
export type { AppliedRows } from "./rowfilters.ts";

export type RefusalCode =
  | "invalid_request"
  | "unknown_role"
  | "not_visible"
  | "unsupported_dialect"
  | "unsupported_metric"
  | "invalid_layer"
  | "no_join_path"
  | "ambiguous_join_path"
  | "join_fans_out"
  | "no_shared_dimension";

export interface Refusal {
  code: RefusalCode;
  ref?: string;
  message: string;
  // The command or step that resolves this refusal, when it is specific to it.
  next?: string;
}

export interface CompiledColumn {
  name: string;
  ref: string; // as the request names it, model.field or model.field:grain
  kind: "dimension" | "measure" | "metric";
}

export interface Compiled {
  ok: true;
  source: string;
  dialect: SourceConfig["dialect"];
  model: string;
  sql: string;
  params: unknown[];
  columns: CompiledColumn[];
  // The joins the SQL adds, in its order: request paths to other models' fields, and definition joins.
  joins: PlannedJoin[];
  // The user's row filters the SQL applies, in its order: in join ON clauses, then in WHERE.
  row_filters: AppliedRows[];
  // The session time zone the SQL assumes: a grain over a value with a time zone buckets in it.
  session_time_zone: "UTC";
}

export interface Refused {
  ok: false;
  source: string;
  reason: string;
  refusals: Refusal[];
}

export type CompileResult = Compiled | Refused;

export interface CompileInput {
  layer: AccessLayer;
  source: SourceConfig;
  snapshot?: Snapshot | null;
  request: unknown;
  user?: AccessUser;
  // The semantic root, which a duckdb source's view files resolve from for the read-only check.
  root?: string;
  // The parameters bound before this query's, when it is one part of a larger query (metrics.ts).
  paramStart?: number;
}

const LATER = "a later version of sl sql adds";

interface Field {
  ref: string;
  model: Model;
  kind: "dimension" | "measure";
  item: Dimension | Measure;
  grain?: TimeGrain;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function refuse(source: string, refusals: Refusal[]): Refused {
  return { ok: false, source, reason: refusals.map((r) => r.message).join("; "), refusals };
}

// Compiles a request against an already loaded layer.
export function compileLayer(input: CompileInput): CompileResult {
  const { layer, source } = input;
  const dialect = source.dialect;
  const refusals: Refusal[] = [];
  const add = (code: RefusalCode, message: string, ref?: string, next?: string) => {
    if (!refusals.some((r) => r.code === code && r.message === message)) refusals.push({ code, message, ...(ref ? { ref } : {}), ...(next ? { next } : {}) });
  };

  const shape = schemaIssues("golden", { name: "request", question: "request", sql: "-", status: "draft", request: input.request }, "request");
  for (const i of shape) if (i.path.startsWith("request")) add("invalid_request", `${i.path} ${i.message}`);
  if (refusals.length) return refuse(source.source, refusals);
  const request = input.request as QueryRequest;
  if (request.source !== source.source) return refuse(source.source, [{ code: "invalid_request", message: `request.source is ${request.source}, not ${source.source}` }]);
  if (!COMPILER_DIALECTS.includes(dialect))
    add("unsupported_dialect", `source ${source.source} is ${dialect}; sl sql compiles for ${COMPILER_DIALECTS.join(" and ")} sources, and ${LATER} other dialects`);

  // Visibility first: a request names only what its user may see (access.ts checkRequest).
  const vis = evaluateLayer(layer, input.user ?? {});
  for (const r of vis.unknown_roles) add("unknown_role", `role ${r} is not a role in access.yaml`);
  for (const p of checkRequest(vis, request).problems) add("not_visible", p.message, p.ref);

  const metric = compileMetrics(input, request, refusals, compileLayer);
  if (metric) return metric;
  const measures = request.measures ?? [];
  const dimensions = request.dimensions ?? [];
  const filters = request.filters ?? [];
  const orderBy = request.order_by ?? [];

  const models = layer.models.filter((m) => m.source === source.source);
  const fieldRefs = [...measures, ...dimensions].filter((r) => !NAME_PATTERN.test(r));
  const baseName = parseRequestField(fieldRefs[0] ?? "")?.model;
  const base = models.find((m) => m.model === baseName);
  if (!measures.length && !dimensions.length) add("invalid_request", "the request names no measure or dimension");

  // Measures come from the base model; dimensions and dimension filters may be on any model the
  // base reaches through to-one joins.
  const resolve = (ref: string, position: string): Field | undefined => {
    const p = parseRequestField(ref);
    const model = p && models.find((m) => m.model === p.model);
    if (!p || !model || !base) return undefined; // reported by checkRequest
    const dim = (model.dimensions ?? []).find((d) => d.name === p.field);
    const mea = (model.measures ?? []).find((m) => m.name === p.field);
    const item = dim ?? mea;
    if (!item) return undefined;
    const kind = dim ? "dimension" : "measure";
    if (model !== base && mea && !position.startsWith("dimensions")) {
      if (position.startsWith("measures")) add("invalid_request", "a request's measures must share one model, or be one metric");
      else add("invalid_request", `${position} names ${ref}, a measure of model ${model.model}; a request filters only on measures of ${base.model}, the model of its measures`, ref);
      return undefined;
    }
    if (p.grain !== undefined) {
      const grains = dim?.time_grains ?? TIME_GRAINS;
      if (!dim || dim.type !== "time") add("invalid_request", `${position} names ${ref}, but ${p.model}.${p.field} is not a time dimension, so it takes no grain`, ref);
      else if (!(grains as readonly string[]).includes(p.grain))
        add("invalid_request", `${position} names ${ref}, but ${p.model}.${p.field} has the grains ${grains.join(", ")}`, ref);
    }
    const at = dim ? `dimensions[${(model.dimensions ?? []).indexOf(dim)}]` : `measures[${(model.measures ?? []).indexOf(mea!)}]`;
    const texts: [TextRole, string, unknown][] = dim ? [["dimension expr", "expr", dim.expr]] : [["measure expr", "expr", mea!.expr], ["measure filter", "filter", mea!.filter]];
    for (const [role, key, t] of texts) {
      if (t === undefined && !dim) continue;
      const problem = typeof t === "string" ? sqlTextProblem(t, role) : undefined;
      if (problem) {
        add("invalid_layer", `model ${p.model} ${at}.${key} (${p.field}) ${problem}`, ref, `Fix the ${role} of ${p.model}.${p.field} in its model file, run sl validate, and run sl sql again.`);
        continue;
      }
      if (typeof t !== "string" || !t.trim() || sqlNames(t, dialect).subquery) {
        add("invalid_layer", `${p.model}.${p.field} has an expr or filter the compiler cannot use; run sl validate`, ref);
        continue;
      }
    }
    if (typeof mea?.expr === "string" && readsJoin(mea.expr, model))
      add("invalid_layer", `${p.model}.${p.field} has an expr that reads a join reference; a measure expr reads only its model's own columns; run sl validate`, ref);
    return { ref, model, kind, item, ...(p.grain ? { grain: p.grain as TimeGrain } : {}) };
  };

  const selected: Field[] = [];
  measures.forEach((ref, i) => {
    const f = resolve(ref, `measures[${i}]`);
    if (f?.kind === "dimension") add("invalid_request", `measures[${i}] names ${ref}, which is a dimension; list it under dimensions`, ref);
    else if (f) selected.push(f);
  });
  const dims: Field[] = [];
  dimensions.forEach((ref, i) => {
    const f = resolve(ref, `dimensions[${i}]`);
    if (f?.kind === "measure") add("invalid_request", `dimensions[${i}] names ${ref}, which is a measure; list it under measures`, ref);
    else if (f) dims.push(f);
  });
  const filterFields = filters.map((f, i) => {
    const field = resolve(f.field, `filters[${i}]`);
    if (field?.kind === "measure" && field.grain) add("invalid_request", `filters[${i}] names a measure with a grain`, f.field);
    const values = f.op === "in" || f.op === "not_in" || f.op === "between" ? (f.value as unknown[]) : f.op.endsWith("null") ? [] : [f.value];
    if (values.some((v) => v === null || typeof v === "object"))
      add("invalid_request", `filters[${i}] compares ${f.field} with null, a list or an object; use is_null or not_null for null`, f.field);
    return field;
  });

  const columns = [...dims, ...selected].map((f) => ({ field: f, name: f.grain ? `${f.item.name}_${f.grain}` : f.item.name }));
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.name)) add("invalid_request", `the request selects the column ${c.name} twice`, c.field.ref);
    seen.add(c.name);
  }
  const position = orderBy.map((o, i) => {
    let k = columns.findIndex((c) => c.field.ref === o.field);
    if (k < 0) {
      const p = parseRequestField(o.field);
      const same = columns.filter((c) => p && !p.grain && c.field.model.model === p.model && c.field.item.name === p.field);
      if (same.length === 1) k = columns.indexOf(same[0]!);
    }
    if (k < 0 && !refusals.some((r) => r.ref === o.field))
      add("invalid_request", `order_by[${i}] names ${o.field}, which the request does not select; add it to dimensions or measures`, o.field);
    return k;
  });

  if (refusals.length || !base) return refuse(source.source, refusals);

  for (const f of selected) {
    const m = f.item as Measure;
    if (!(AGGREGATIONS as readonly string[]).includes(m.agg) || (m.expr === undefined && m.agg !== "count"))
      add("invalid_layer", `${f.ref} needs an agg, and an expr unless it is a count; run sl validate`, f.ref);
  }
  if (refusals.length) return refuse(source.source, refusals);

  // A query that reads only the base table keeps its exprs as written; one with joins qualifies
  // every column with its table's alias. The fields are in reading order (the columns, then WHERE
  // filters, then HAVING ones), so the joins follow it.
  const kept = filterFields.filter((f): f is Field => !!f);
  const used = [...columns.map((c) => c.field), ...kept.filter((f) => f.kind === "dimension"), ...kept.filter((f) => f.kind === "measure")];
  const texts = (f: Field) => (f.kind === "dimension" ? [(f.item as Dimension).expr] : [(f.item as Measure).expr, (f.item as Measure).filter]);
  // The user's row filters, as lib/access.ts evaluates them: each limits its model where the query
  // reads it, the base in WHERE and a request path's model in its join's ON clause. Parameters are
  // numbered in reading order: those ON clauses, then WHERE, then HAVING.
  const rowsOf = (m: Model): ModelRows | undefined => vis.sources.find((s) => s.source === source.source)?.models.find((x) => x.model === m.model)?.row_filters;
  const baseRows = rowsOf(base);
  const params = new Params(input.paramStart);
  const applied: AppliedRows[] = [];
  const restrict = (inst: Instance, where: AppliedRows["in"]): string | undefined => {
    const rows = rowsOf(inst.model);
    if (!rows || rows.rows === "all") return undefined;
    applied.push({ model: inst.model.model, alias: inst.alias, in: where, roles: rows.branches.map((b) => b.role), rows: rows.rows });
    return rowsPredicate(rows, inst, { source: source.source, dialect, models, params, plan: () => plan, add });
  };
  const filterJoins = baseRows?.rows === "filtered" && baseRows.branches.some((b) => !b.no_rows && b.filters.some((f) => f.join_refs?.length));
  const qualified = filterJoins || used.some((f) => f.model !== base || texts(f).some((t) => t !== undefined && readsJoin(t, f.model)));
  const plan: JoinPlan = new JoinPlan({ source: source.source, dialect, models, snapshot: input.snapshot, base, qualified, add, restrict: (inst) => restrict(inst, "on") });
  const done = new Map<string, string>();
  const sqlOf = (f: Field): string => {
    const known = done.get(f.ref);
    if (known !== undefined) return known;
    const inst: Instance = plan.requestPath(f.model, f.ref) ?? plan.base;
    const own = (t: string) => plan.sql(t, inst, f.ref);
    let out: string;
    if (f.kind === "measure") {
      const m = f.item as Measure;
      out = aggregate(dialect, m.agg, m.expr === undefined ? undefined : own(m.expr), m.filter === undefined ? undefined : own(m.filter));
    } else {
      const d = f.item as Dimension;
      out = f.grain ? grained(dialect, embed(own(d.expr)), f.grain) : embed(own(d.expr));
    }
    done.set(f.ref, out);
    return out;
  };
  for (const f of used) sqlOf(f);
  const baseFilter = restrict(plan.base, "where");
  if (refusals.length) return refuse(source.source, refusals);

  // WHERE predicates are built before HAVING ones, so parameter numbers rise in reading order.
  const clause = (kind: Field["kind"]) =>
    filters.flatMap((f, i) => (filterFields[i]!.kind === kind ? [predicate(sqlOf(filterFields[i]!), f.op as FilterOp, f.value, params)] : []));
  const where = [...(baseFilter ? [baseFilter] : []), ...clause("dimension")];
  const having = clause("measure");
  const lines = ["select", columns.map((c) => `  ${sqlOf(c.field)} as ${quoteIdent(dialect, c.name)}`).join(",\n"), ...plan.from()];
  if (where.length) lines.push(`where ${where.join("\n  and ")}`);
  if (dims.length) lines.push(`group by ${dims.map((_, i) => i + 1).join(", ")}`);
  if (having.length) lines.push(`having ${having.join("\n  and ")}`);
  if (orderBy.length) lines.push(`order by ${orderBy.map((o, i) => `${position[i]! + 1} ${o.direction ?? "asc"} nulls last`).join(", ")}`);
  if (request.limit !== undefined) lines.push(`limit ${request.limit}`);
  const sql = lines.join("\n");
  try {
    const root = input.root;
    assertReadOnly(sql, root ? { globAllowed: (p) => globInsideViews(root, source, p) } : {});
  } catch (e) {
    return refuse(source.source, [{ code: "invalid_layer", message: `the compiled SQL is not read-only (${(e as Error).message}); run sl validate` }]);
  }
  return {
    ok: true,
    source: source.source,
    dialect,
    model: base.model,
    sql,
    params: params.values,
    columns: columns.map((c) => ({ name: c.name, ref: c.field.ref, kind: c.field.kind })),
    joins: plan.joins,
    row_filters: applied,
    session_time_zone: "UTC",
  };
}

export interface CompileOptions {
  source?: string;
  role?: string;
  user?: Record<string, unknown>;
}

// Compiles a request against the layer under root, as the user a role and attributes describe
// (the default audience when neither is given). The request's source, or opts.source when the
// request names none.
export function compileRequest(root: string, request: unknown, opts: CompileOptions = {}): CompileResult {
  const named = isObj(request) && typeof request.source === "string" ? request.source : undefined;
  if (named && opts.source && named !== opts.source)
    return refuse(opts.source, [{ code: "invalid_request", message: `the request is on source ${named}, not ${opts.source}` }]);
  const sourceName = named ?? opts.source;
  if (!sourceName) return refuse("", [{ code: "invalid_request", message: "request.source is required (or pass --source)" }]);
  const source = loadSource(root, sourceName);
  const full = isObj(request) && !named ? { ...request, source: sourceName } : request;
  const user: AccessUser = { attributes: opts.user ?? {}, roles: opts.role ? [opts.role] : [] };
  return compileLayer({ layer: loadAccessLayer(root), source, snapshot: loadSnapshot(root, sourceName), request: full, user, root });
}

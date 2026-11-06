// The reference compiler (references/spec.md, Reference compiler): turns a request on one model
// into SQL for a postgres or duckdb source, with every request filter value a bound parameter. It
// never runs the SQL. A request that needs what this version does not compile (a join, a metric, a
// row filter for the user) is refused with the reason.
import { type AccessLayer, type AccessUser, checkRequest, evaluateLayer, loadAccessLayer, type ModelVisibility } from "../access.ts";
import { quoteIdent, quoteTable } from "../dialect.ts";
import { findTable, splitQualified } from "../naming.ts";
import { loadSnapshot, loadSource } from "../project.ts";
import { parseRequestField } from "../refs.ts";
import { globInsideViews } from "../source-safety.ts";
import { assertReadOnly } from "../sql-guard.ts";
import { sqlNames } from "../sql-names.ts";
import type { Dimension, FilterOp, Measure, Model, QueryRequest, Snapshot, SourceConfig, TimeGrain } from "../types.ts";
import { AGGREGATIONS, NAME_PATTERN, TIME_GRAINS } from "../types.ts";
import { schemaIssues } from "../validate.ts";
import { aggregate, COMPILER_DIALECTS, embed, grained, Params, predicate } from "./sql.ts";

export type RefusalCode =
  | "invalid_request"
  | "unknown_role"
  | "not_visible"
  | "unsupported_dialect"
  | "unsupported_join"
  | "unsupported_metric"
  | "unsupported_row_filter"
  | "invalid_layer";

export interface Refusal {
  code: RefusalCode;
  ref?: string;
  message: string;
}

export interface CompiledColumn {
  name: string;
  ref: string; // as the request names it, model.field or model.field:grain
  kind: "dimension" | "measure";
}

export interface Compiled {
  ok: true;
  source: string;
  dialect: SourceConfig["dialect"];
  model: string;
  sql: string;
  params: unknown[];
  columns: CompiledColumn[];
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

// The join names a SQL expression reads through: <join>.<column> chains starting at one of the
// model's joins. Other dotted names read struct fields of the model's own columns.
function joinsRead(sql: string, model: Model, dialect: SourceConfig["dialect"]): string[] {
  const joins = (model.joins ?? []).map((j) => j.name);
  const out = new Set<string>();
  for (const c of sqlNames(sql, dialect).chains) {
    const first = c.parts[0]!;
    const hit = joins.find((j) => (c.quoted[0] ? j === first : j.toLowerCase() === first.toLowerCase()));
    if (hit) out.add(hit);
  }
  return [...out].sort();
}

function refuse(source: string, refusals: Refusal[]): Refused {
  return { ok: false, source, reason: refusals.map((r) => r.message).join("; "), refusals };
}

// Compiles a request against an already loaded layer.
export function compileLayer(input: CompileInput): CompileResult {
  const { layer, source } = input;
  const dialect = source.dialect;
  const refusals: Refusal[] = [];
  const add = (code: RefusalCode, message: string, ref?: string) => {
    if (!refusals.some((r) => r.code === code && r.message === message)) refusals.push({ code, message, ...(ref ? { ref } : {}) });
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

  const measures = request.measures ?? [];
  const dimensions = request.dimensions ?? [];
  const filters = request.filters ?? [];
  const orderBy = request.order_by ?? [];
  for (const ref of [...measures, ...dimensions, ...filters.map((f) => f.field), ...orderBy.map((o) => o.field)])
    if (NAME_PATTERN.test(ref) && layer.metrics.some((m) => m.name === ref && (m.source ?? source.source) === source.source))
      add("unsupported_metric", `${ref} is a metric; ${LATER} ratio and derived metrics`, ref);

  const models = layer.models.filter((m) => m.source === source.source);
  const fieldRefs = [...measures, ...dimensions].filter((r) => !NAME_PATTERN.test(r));
  const baseName = parseRequestField(fieldRefs[0] ?? "")?.model;
  const base = models.find((m) => m.model === baseName);
  if (!measures.length && !dimensions.length) add("invalid_request", "the request names no measure or dimension");

  const resolve = (ref: string, position: string): Field | undefined => {
    const p = parseRequestField(ref);
    const model = p && models.find((m) => m.model === p.model);
    if (!p || !model || !base) return undefined; // reported by checkRequest
    if (model !== base) {
      const measureModels = new Set(measures.filter((r) => !NAME_PATTERN.test(r)).map((r) => parseRequestField(r)?.model));
      if (measureModels.size > 1) add("invalid_request", "a request's measures must share one model, or be one metric");
      else add("unsupported_join", `${ref} is on model ${model.model}, which a request on ${base.model} reaches through a join; ${LATER} joins`, ref);
      return undefined;
    }
    const dim = (model.dimensions ?? []).find((d) => d.name === p.field);
    const mea = (model.measures ?? []).find((m) => m.name === p.field);
    const item = dim ?? mea;
    if (!item) return undefined;
    const kind = dim ? "dimension" : "measure";
    if (p.grain !== undefined) {
      const grains = dim?.time_grains ?? TIME_GRAINS;
      if (!dim || dim.type !== "time") add("invalid_request", `${position} names ${ref}, but ${p.model}.${p.field} is not a time dimension, so it takes no grain`, ref);
      else if (!(grains as readonly string[]).includes(p.grain))
        add("invalid_request", `${position} names ${ref}, but ${p.model}.${p.field} has the grains ${grains.join(", ")}`, ref);
    }
    const texts = dim ? [dim.expr] : [(item as Measure).expr, (item as Measure).filter];
    for (const t of texts) {
      if (t === undefined && !dim) continue;
      if (typeof t !== "string" || !t.trim() || sqlNames(t, dialect).subquery) {
        add("invalid_layer", `${p.model}.${p.field} has an expr or filter the compiler cannot use; run sl validate`, ref);
        continue;
      }
      for (const j of joinsRead(t, model, dialect))
        add("unsupported_join", `${p.model}.${p.field} reads through join ${j} as part of its definition; ${LATER} joins`, ref);
    }
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

  if (base) {
    const mv: ModelVisibility | undefined = vis.sources.find((s) => s.source === source.source)?.models.find((m) => m.model === base.model);
    if (mv?.row_filters && mv.row_filters.rows !== "all") {
      const roles = mv.row_filters.branches.map((b) => b.role).join(", ");
      const what = mv.row_filters.rows === "none" ? "this user sees no rows of" : "a row filter limits this user's rows of";
      add("unsupported_row_filter", `${what} ${base.model} (role ${roles}); ${LATER} row filters`, `${source.source}.${base.model}`);
    }
  }
  if (refusals.length || !base) return refuse(source.source, refusals);

  // Every field is on the base model, so its exprs read the one table unqualified.
  const sqlOf = (f: Field): string => {
    if (f.kind === "measure") {
      const m = f.item as Measure;
      return aggregate(dialect, m.agg, m.expr, m.filter);
    }
    const d = f.item as Dimension;
    return f.grain ? grained(dialect, embed(d.expr), f.grain) : embed(d.expr);
  };
  for (const f of selected) {
    const m = f.item as Measure;
    if (!(AGGREGATIONS as readonly string[]).includes(m.agg) || (m.expr === undefined && m.agg !== "count"))
      add("invalid_layer", `${f.ref} needs an agg, and an expr unless it is a count; run sl validate`, f.ref);
  }
  if (refusals.length) return refuse(source.source, refusals);

  // WHERE predicates are built before HAVING ones, so parameter numbers rise in reading order.
  const params = new Params();
  const clause = (kind: Field["kind"]) =>
    filters.flatMap((f, i) => (filterFields[i]!.kind === kind ? [predicate(sqlOf(filterFields[i]!), f.op as FilterOp, f.value, params)] : []));
  const where = clause("dimension");
  const having = clause("measure");
  const snapTable = input.snapshot ? findTable(input.snapshot.tables, base.table) : undefined;
  const table = snapTable ? { schema: snapTable.schema, name: snapTable.name } : splitQualified(base.table);
  const lines = [
    "select",
    columns.map((c) => `  ${sqlOf(c.field)} as ${quoteIdent(dialect, c.name)}`).join(",\n"),
    `from ${quoteTable(dialect, table)}`,
  ];
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

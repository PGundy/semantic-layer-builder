// The access evaluator: what one user may see of the semantic layer, and why the rest is hidden.
// It is the reference implementation a compiler reuses, and it never runs SQL.
//
// Layers, applied to every model, dimension, measure and metric:
//   - status: a draft item is hidden (reason "draft").
//   - roles: in open mode every item is visible unless each held role denies it; in closed mode an
//     item is visible when a held role's allow.models matches its model and that role does not deny
//     it. A user holding no role sees everything in open mode and nothing in closed mode. Reasons:
//     "denied:<role>", "not_allowed".
//   - protected tags: an item carrying pii or sensitive, in any letter case (a field also carries its
//     model's tags), is hidden unless a held role lists the tag in allow.tags ("protected_tag:<tag>").
//     public never overrides them.
//   - restrictions: an item a restriction targets is hidden unless the user holds one of its
//     allow.roles or satisfies its allow.when ("restricted:<name>").
// A field of a hidden model is hidden too ("model_hidden"). A metric is visible only when it passes
// the layers itself and every measure it combines is visible ("measure_hidden:<model.measure>",
// "unknown_measure:<ref>").
//
// access.yaml is read defensively: an entry that cannot be read is listed in `skipped`, and an entry
// that could limit access fails closed rather than being dropped:
//   - an unreadable mode means closed; an unreadable row filter expression means no rows.
//   - a restriction that cannot be read (not a mapping, or a target that cannot be read) has unknown
//     targets, so nothing in access.yaml applies and access is closed (access_file "invalid").
//   - a role whose deny, row_filters or assign_when cannot be read is broken: a user holding it sees
//     nothing ("broken_role:<name>"). A broken assign_when might hold for anyone, so it breaks every
//     user. A role entry that is skipped (no valid name, or a repeated name) breaks a user assigned
//     that name (compared without letter case) or matched by its assign_when, and an unreadable or
//     unknown default_role breaks a user holding no other role.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Condition, evaluateCondition, parseCondition } from "./conditions.ts";
import { matchesDotted, validatePattern } from "./patterns.ts";
import { listSourceNames, paths } from "./project.ts";
import { parseRequestField } from "./refs.ts";
import type { AccessMode, Metric, Model, QueryRequest } from "./types.ts";
import { PROTECTED_TAGS } from "./types.ts";
import { readYaml } from "./yaml.ts";

// Who is asking: user attribute values and the role names the identity system assigns.
export interface AccessUser {
  attributes?: Record<string, unknown>;
  roles?: string[];
}

export type RoleHow = "assigned" | "condition" | "default";

export interface HeldRole {
  name: string;
  how: RoleHow;
  // The assign_when condition that held, when how is "condition".
  condition?: string;
}

export interface SkippedEntry {
  path: string;
  message: string;
}

export interface FieldVisibility {
  name: string;
  kind: "dimension" | "measure";
  ref: string; // source.model.field
  status: "draft" | "approved";
  tags: string[];
  visible: boolean;
  reasons: string[];
}

// The values a row filter binds, shown to the person; a compiler binds them as query parameters.
export interface ExprFilterResult {
  kind: "expr";
  expr: string;
  params: Record<string, unknown>;
  missing: string[];
}

export interface HierarchyFilterResult {
  kind: "hierarchy";
  column: string;
  via: string;
  manager: string;
  member: string;
  user: string; // attribute name, without the user. prefix
  include_self: boolean;
  user_value: unknown;
  missing: string[];
}

export type AppliedRowFilter = ExprFilterResult | HierarchyFilterResult;

// One held role's row filters on a model, combined with AND. no_rows is true when a filter lacks a
// user attribute or cannot be read.
export interface RowFilterBranch {
  role: string;
  filters: AppliedRowFilter[];
  no_rows: boolean;
  problems: string[];
}

// The rows of a model a user sees: the OR of the branches. "all" means no filter applies, "none"
// that every branch returns no rows.
export interface ModelRows {
  rows: "all" | "filtered" | "none";
  branches: RowFilterBranch[];
}

export interface ModelVisibility {
  model: string;
  ref: string; // source.model
  status: "draft" | "approved";
  tags: string[];
  visible: boolean;
  reasons: string[];
  fields: FieldVisibility[];
  // Present on visible models.
  row_filters?: ModelRows;
}

export interface MetricVisibility {
  name: string;
  ref: string; // metric:<name>
  status: "draft" | "approved";
  tags: string[];
  measures: string[]; // model.measure
  visible: boolean;
  reasons: string[];
}

export interface SourceVisibility {
  source: string;
  models: ModelVisibility[];
  metrics: MetricVisibility[];
}

export interface Counts {
  visible: number;
  hidden: number;
}

export interface AccessSummary {
  models: Counts;
  fields: Counts;
  metrics: Counts;
  // Approved models, fields and metrics hidden with a protected_tag reason.
  hidden_by_protected_tags: number;
}

export interface AccessVisibility {
  mode: AccessMode;
  access_file: "missing" | "draft" | "approved" | "invalid";
  user: { attributes: Record<string, unknown>; roles: string[]; default_audience: boolean };
  roles: HeldRole[];
  unknown_roles: string[];
  // Roles that cannot be read and might apply to this user; while any is listed the user sees nothing.
  broken_roles: string[];
  undeclared_attributes: string[];
  skipped: SkippedEntry[];
  // Entries that were read but look mistaken, such as a restriction target that matches nothing.
  warnings: SkippedEntry[];
  sources: SourceVisibility[];
  summary: AccessSummary;
}

// The layer the evaluator reads: models, metrics, and access.yaml as parsed (null when missing).
export interface AccessLayer {
  models: Model[];
  metrics: Metric[];
  access: unknown;
  access_present: boolean;
  // Files that could not be read, reported with the result.
  skipped?: SkippedEntry[];
}

// --- normalizing access.yaml -------------------------------------------------------------

interface NRowFilter {
  model: string;
  raw: Record<string, unknown>;
  path: string;
}

interface NCondition {
  src: string;
  cond: Condition | null; // null when it cannot be read
}

interface NRole {
  name: string;
  assign_when?: NCondition;
  allowModels: string[] | null; // null when allow.models is absent
  allowTags: string[]; // lowercase
  denyModels: string[];
  denyFields: string[];
  denyTags: string[]; // lowercase
  rowFilters: NRowFilter[];
  // Paths of deny, row_filters or assign_when entries that cannot be read; non-empty means broken.
  broken: string[];
}

// A role entry that was skipped; it still breaks a user who might hold it.
interface NSkippedRole {
  name?: string;
  assign_when?: NCondition;
}

interface NTarget {
  pattern: string; // without the metric: prefix
  metric: boolean;
  path: string;
}

interface NRestriction {
  name: string;
  targets: NTarget[];
  roles: string[];
  when: Condition | null; // null when absent or unreadable
  broken: boolean; // hides its targets from everyone
}

interface NAccess {
  mode: AccessMode;
  state: AccessVisibility["access_file"];
  defaultRole?: string;
  defaultUnreadable: boolean;
  attributes: Set<string>;
  roles: NRole[];
  skippedRoles: NSkippedRole[];
  restrictions: NRestriction[];
}

const NAME = /^[a-z][a-z0-9_]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const given = (v: unknown) => v !== undefined && v !== null;
const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

const BROKEN = "; the role is broken and a user holding it sees nothing";
const BROKEN_ANYONE = "; the role is broken and, since the condition might hold for anyone, every user sees nothing";
const INVALID_RESTRICTION = "; the restriction cannot be read";

// Reads a list of text into out; problems go to sink with paths but no consequence.
function stringList(v: unknown, path: string, sink: SkippedEntry[]): string[] {
  if (!given(v)) return [];
  if (!Array.isArray(v)) {
    sink.push({ path, message: "is not a list" });
    return [];
  }
  const out: string[] = [];
  v.forEach((x, i) => {
    if (typeof x === "string") out.push(x);
    else sink.push({ path: `${path}[${i}]`, message: "is not text" });
  });
  return out;
}

function patternList(v: unknown, path: string, sink: SkippedEntry[]): string[] {
  if (!given(v)) return [];
  if (!Array.isArray(v)) {
    sink.push({ path, message: "is not a list" });
    return [];
  }
  const out: string[] = [];
  v.forEach((x, i) => {
    const problem = typeof x === "string" ? validatePattern(x) : "is not text";
    if (problem) sink.push({ path: `${path}[${i}]`, message: problem });
    else out.push(x as string);
  });
  return out;
}

function readCondition(src: unknown, path: string, sink: SkippedEntry[]): NCondition | undefined {
  if (!given(src)) return undefined;
  if (typeof src !== "string") {
    sink.push({ path, message: "is not text" });
    return { src: String(src), cond: null };
  }
  try {
    return { src, cond: parseCondition(src) };
  } catch (e) {
    sink.push({ path, message: (e as Error).message });
    return { src, cond: null };
  }
}

// Moves the entries of sink to skipped, each with the consequence appended.
function flush(sink: SkippedEntry[], skipped: SkippedEntry[], consequence: string): string[] {
  for (const s of sink) skipped.push({ path: s.path, message: `${s.message}${consequence}` });
  return sink.splice(0).map((s) => s.path);
}

function normalizeRole(r: Record<string, unknown>, name: string, p: string, mode: AccessMode, skipped: SkippedEntry[]): NRole {
  const sink: SkippedEntry[] = [];
  if (given(r.allow) && !isObj(r.allow)) sink.push({ path: `${p}.allow`, message: "is not a mapping" });
  const allow = isObj(r.allow) ? r.allow : {};
  const allowModels = given(allow.models) ? patternList(allow.models, `${p}.allow.models`, sink) : null;
  const allowTags = lower(stringList(allow.tags, `${p}.allow.tags`, sink));
  // An unreadable grant only gives less access.
  flush(sink, skipped, "; ignored");

  const broken: string[] = [];
  if (given(r.deny) && !isObj(r.deny)) sink.push({ path: `${p}.deny`, message: "is not a mapping" });
  const deny = isObj(r.deny) ? r.deny : {};
  const denyModels = patternList(deny.models, `${p}.deny.models`, sink);
  const denyFields = patternList(deny.fields, `${p}.deny.fields`, sink);
  const denyTags = lower(stringList(deny.tags, `${p}.deny.tags`, sink));
  const rowFilters: NRowFilter[] = [];
  if (Array.isArray(r.row_filters)) {
    r.row_filters.forEach((rf, ri) => {
      const rp = `${p}.row_filters[${ri}]`;
      if (!isObj(rf)) sink.push({ path: rp, message: "is not a mapping" });
      else if (typeof rf.model !== "string") sink.push({ path: rp, message: "has no model" });
      else rowFilters.push({ model: rf.model, raw: rf, path: rp });
    });
  } else if (given(r.row_filters)) sink.push({ path: `${p}.row_filters`, message: "is not a list" });
  broken.push(...flush(sink, skipped, BROKEN));

  const assign_when = readCondition(r.assign_when, `${p}.assign_when`, sink);
  broken.push(...flush(sink, skipped, BROKEN_ANYONE));

  if (mode === "closed" && allowModels === null) skipped.push({ path: `${p}.allow.models`, message: "is missing; in closed mode the role allows no model" });
  return { name, assign_when, allowModels, allowTags, denyModels, denyFields, denyTags, rowFilters, broken };
}

function normalizeAccess(raw: unknown, present: boolean, skipped: SkippedEntry[]): NAccess {
  const empty: NAccess = { mode: "open", state: "missing", defaultUnreadable: false, attributes: new Set(), roles: [], skippedRoles: [], restrictions: [] };
  if (!present) return empty;
  if (!isObj(raw)) {
    skipped.push({ path: "access.yaml", message: "is not a mapping; nothing in it applies and access is treated as closed" });
    return { ...empty, mode: "closed", state: "invalid" };
  }
  const a: NAccess = { ...empty, attributes: new Set(), roles: [], skippedRoles: [], restrictions: [], state: raw.status === "approved" ? "approved" : "draft" };
  if (!given(raw.mode) || raw.mode === "open") a.mode = "open";
  else if (raw.mode === "closed") a.mode = "closed";
  else {
    a.mode = "closed";
    skipped.push({ path: "mode", message: `"${String(raw.mode)}" is not open or closed; treated as closed` });
  }
  if (typeof raw.default_role === "string") a.defaultRole = raw.default_role;
  else if (given(raw.default_role)) {
    a.defaultUnreadable = true;
    skipped.push({ path: "default_role", message: "is not text; a user holding no other role sees nothing" });
  }

  if (Array.isArray(raw.user_attributes)) {
    raw.user_attributes.forEach((u, i) => {
      if (isObj(u) && typeof u.name === "string") a.attributes.add(u.name);
      else skipped.push({ path: `user_attributes[${i}]`, message: "has no name; ignored" });
    });
  } else if (given(raw.user_attributes)) skipped.push({ path: "user_attributes", message: "is not a list; ignored" });

  const seen = new Set<string>();
  if (Array.isArray(raw.roles)) {
    raw.roles.forEach((r, i) => {
      const p = `roles[${i}]`;
      if (!isObj(r)) {
        skipped.push({ path: p, message: "is not a mapping; the role is skipped" });
        return;
      }
      const name = typeof r.name === "string" ? r.name : undefined;
      const skip = (message: string) => {
        skipped.push({ path: p, message });
        a.skippedRoles.push({ name, assign_when: readCondition(r.assign_when, `${p}.assign_when`, []) });
      };
      if (name === undefined || !NAME.test(name)) {
        skip(
          `has no valid name; the role is skipped, and a user ${name === undefined ? "" : `assigned "${name}" or `}its assign_when might hold for sees nothing`,
        );
        return;
      }
      if (seen.has(name)) {
        skip(`repeats role "${name}"; the later definition is skipped, and a user holding ${name} sees nothing`);
        return;
      }
      seen.add(name);
      a.roles.push(normalizeRole(r, name, p, a.mode, skipped));
    });
  } else if (given(raw.roles)) skipped.push({ path: "roles", message: "is not a list; no role applies" });

  let invalid = false;
  const sink: SkippedEntry[] = [];
  if (Array.isArray(raw.restrictions)) {
    raw.restrictions.forEach((x, i) => {
      const p = `restrictions[${i}]`;
      if (!isObj(x)) {
        invalid = true;
        skipped.push({ path: p, message: `is not a mapping${INVALID_RESTRICTION}` });
        return;
      }
      const name = typeof x.name === "string" ? x.name : `#${i}`;
      const targets: NTarget[] = [];
      const rawTargets = typeof x.targets === "string" ? [x.targets] : x.targets;
      if (!Array.isArray(rawTargets) || !rawTargets.length) sink.push({ path: `${p}.targets`, message: "names no target" });
      else
        rawTargets.forEach((t, ti) => {
          const tp = typeof x.targets === "string" ? `${p}.targets` : `${p}.targets[${ti}]`;
          const metric = typeof t === "string" && t.startsWith("metric:");
          const pattern = typeof t === "string" ? (metric ? t.slice(7) : t) : "";
          const problem = typeof t !== "string" ? "is not text" : !pattern.trim() ? "is empty" : validatePattern(pattern);
          if (problem) sink.push({ path: tp, message: problem });
          else targets.push({ pattern, metric, path: tp });
        });
      if (sink.length) invalid = true;
      flush(sink, skipped, INVALID_RESTRICTION);
      const allowSink: SkippedEntry[] = [];
      if (given(x.allow) && !isObj(x.allow)) allowSink.push({ path: `${p}.allow`, message: "is not a mapping" });
      const allow = isObj(x.allow) ? x.allow : {};
      const roles = stringList(allow.roles, `${p}.allow.roles`, allowSink);
      const when = readCondition(allow.when, `${p}.allow.when`, allowSink);
      // An unreadable grant only gives less access.
      flush(allowSink, skipped, "; treated as granting nobody");
      let broken = false;
      if (!roles.length && !when) {
        broken = true;
        skipped.push({ path: `${p}.allow`, message: "gives neither roles nor when; its targets are hidden from everyone" });
      }
      a.restrictions.push({ name, targets, roles, when: when ? when.cond : null, broken });
    });
  } else if (given(raw.restrictions)) {
    invalid = true;
    skipped.push({ path: "restrictions", message: `is not a list${INVALID_RESTRICTION}` });
  }
  if (invalid) {
    skipped.push({
      path: "restrictions",
      message: "a restriction cannot be read, so what it protects is unknown; nothing in access.yaml applies and access is treated as closed",
    });
    return { ...a, mode: "closed", state: "invalid", defaultRole: undefined, defaultUnreadable: false, roles: [], skippedRoles: [], restrictions: [] };
  }
  return a;
}

// --- loading -------------------------------------------------------------------------------

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

// Reads the models, metrics and access.yaml under a semantic root. A file that cannot be read is
// left out and listed in skipped; an unreadable access.yaml is passed on as invalid.
export function loadAccessLayer(root: string): AccessLayer {
  const p = paths(root);
  const skipped: SkippedEntry[] = [];
  const models: Model[] = [];
  for (const source of listSourceNames(root)) {
    let dir: string;
    try {
      dir = p.modelsDir(source);
    } catch {
      continue;
    }
    for (const f of yamlFiles(dir)) {
      const path = join(dir, f);
      try {
        const m = readYaml<Model>(path);
        if (isObj(m) && typeof m.model === "string") models.push({ ...m, source: typeof m.source === "string" ? m.source : source });
        else skipped.push({ path: `models/${source}/${f}`, message: "is not a model; skipped" });
      } catch (e) {
        skipped.push({ path: `models/${source}/${f}`, message: `${(e as Error).message}; skipped` });
      }
    }
  }
  let metrics: Metric[] = [];
  if (existsSync(p.metrics)) {
    try {
      const raw = readYaml<{ metrics?: unknown }>(p.metrics);
      if (isObj(raw) && Array.isArray(raw.metrics)) metrics = raw.metrics.filter((m): m is Metric => isObj(m) && typeof m.name === "string");
    } catch (e) {
      skipped.push({ path: "metrics.yaml", message: `${(e as Error).message}; no metric is listed` });
    }
  }
  const accessPresent = existsSync(p.access);
  let access: unknown = null;
  if (accessPresent) {
    try {
      access = readYaml<unknown>(p.access);
    } catch (e) {
      skipped.push({ path: "access.yaml", message: (e as Error).message });
      access = undefined;
    }
  }
  return { models, metrics, access, access_present: accessPresent, skipped };
}

// --- evaluation ----------------------------------------------------------------------------

const USER_PLACEHOLDER = /\{\{\s*user\.([A-Za-z0-9_]+)\s*\}\}/g;
// An attribute counts as present when it has a value; an empty list is missing.
const present = (v: unknown) => given(v) && !(Array.isArray(v) && !v.length);
const statusOf = (x: { status?: unknown }): "draft" | "approved" => (x.status === "approved" ? "approved" : "draft");
const tagsOf = (x: { tags?: unknown }): string[] => (Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : []);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => isObj(x)) as T[]) : []);
const uniq = (xs: string[]) => [...new Set(xs)];

function safeMatch(pattern: string, dotted: string): boolean {
  try {
    return matchesDotted(pattern, dotted);
  } catch {
    return false;
  }
}

// The measure references a metric combines, as model.measure.
export function metricMeasureRefs(metric: Metric): string[] {
  if (metric.type === "ratio") return [metric.numerator, metric.denominator].filter((r): r is string => typeof r === "string").map((r) => r.trim());
  if (typeof (metric as { expr?: unknown }).expr !== "string") return [];
  return uniq([...metric.expr.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!.trim()));
}

function heldRoles(a: NAccess, user: AccessUser, attrs: Record<string, unknown>): { held: HeldRole[]; unknown: string[] } {
  const byName = new Map(a.roles.map((r) => [r.name, r]));
  const asked = uniq((Array.isArray(user.roles) ? user.roles : []).filter((r) => typeof r === "string").map((r) => r.trim()).filter(Boolean));
  const held: HeldRole[] = [];
  const unknown: string[] = [];
  for (const name of asked) {
    const role = byName.get(name.toLowerCase());
    if (!role) unknown.push(name);
    else if (!held.some((h) => h.name === role.name)) held.push({ name: role.name, how: "assigned" });
  }
  for (const r of a.roles) {
    if (held.some((h) => h.name === r.name) || !r.assign_when?.cond) continue;
    if (evaluateCondition(r.assign_when.cond, attrs)) held.push({ name: r.name, how: "condition", condition: r.assign_when.src });
  }
  if (!held.length && a.defaultRole && byName.has(a.defaultRole)) held.push({ name: a.defaultRole, how: "default" });
  return { held, unknown };
}

// The roles that cannot be read and might apply to this user.
function brokenRoles(a: NAccess, held: HeldRole[], user: AccessUser, attrs: Record<string, unknown>): string[] {
  const asked = new Set((Array.isArray(user.roles) ? user.roles : []).filter((r) => typeof r === "string").map((r) => r.trim().toLowerCase()));
  const out: string[] = [];
  for (const h of held) if (a.roles.find((r) => r.name === h.name)!.broken.length) out.push(h.name);
  for (const r of a.roles) if (r.assign_when && r.assign_when.cond === null) out.push(r.name);
  for (const s of a.skippedRoles) {
    const label = s.name ?? "unnamed";
    if (s.name !== undefined && asked.has(s.name.trim().toLowerCase())) out.push(label);
    else if (s.assign_when && (s.assign_when.cond === null || evaluateCondition(s.assign_when.cond, attrs))) out.push(label);
  }
  if (!held.length) {
    if (a.defaultUnreadable) out.push("default_role");
    else if (a.defaultRole && !a.roles.some((r) => r.name === a.defaultRole)) out.push(a.defaultRole);
  }
  return uniq(out);
}

function rowFilterResult(rf: NRowFilter, attrs: Record<string, unknown>, modelRefs: Set<string>): { filter?: AppliedRowFilter; problem?: string } {
  const raw = rf.raw;
  const hasHierarchy = given(raw.hierarchy);
  const hasExpr = given(raw.expr);
  if (hasHierarchy && hasExpr) return { problem: `${rf.path} has both expr and hierarchy; treated as no rows` };
  if (!hasHierarchy && !hasExpr) return { problem: `${rf.path} has neither expr nor hierarchy; treated as no rows` };
  if (hasHierarchy) {
    if (!isObj(raw.hierarchy)) return { problem: `${rf.path}.hierarchy is not a mapping; treated as no rows` };
    const h = raw.hierarchy;
    const keys = ["column", "via", "manager", "member", "user"] as const;
    const bad = keys.filter((k) => typeof h[k] !== "string" || !(h[k] as string).trim());
    if (bad.length) return { problem: `${rf.path}.hierarchy lacks ${bad.join(", ")}; treated as no rows` };
    if (h.include_self !== undefined && typeof h.include_self !== "boolean")
      return { problem: `${rf.path}.hierarchy.include_self is not true or false; treated as no rows` };
    const via = h.via as string;
    if (!modelRefs.has(via)) return { problem: `${rf.path}.hierarchy.via "${via}" is not a model; treated as no rows` };
    const userAttr = (h.user as string).replace(/^user\./, "");
    const value = attrs[userAttr];
    if (present(value) && typeof value === "object")
      return { problem: `user.${userAttr} is ${Array.isArray(value) ? "a list" : "not a single value"}; a hierarchy filter needs one id; treated as no rows` };
    return {
      filter: {
        kind: "hierarchy",
        column: h.column as string,
        via,
        manager: h.manager as string,
        member: h.member as string,
        user: userAttr,
        include_self: h.include_self !== false,
        user_value: present(value) ? value : null,
        missing: present(value) ? [] : [userAttr],
      },
    };
  }
  if (typeof raw.expr !== "string") return { problem: `${rf.path}.expr is not text; treated as no rows` };
  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const m of raw.expr.matchAll(USER_PLACEHOLDER)) {
    const name = m[1]!;
    if (present(attrs[name])) params[name] = attrs[name];
    else if (!missing.includes(name)) missing.push(name);
  }
  return { filter: { kind: "expr", expr: raw.expr, params, missing } };
}

// Evaluates what one user sees, from an already loaded layer.
export function evaluateLayer(layer: AccessLayer, user: AccessUser = {}): AccessVisibility {
  const skipped: SkippedEntry[] = [...(layer.skipped ?? [])];
  const warnings: SkippedEntry[] = [];
  const invalidFile = layer.access_present && layer.access === undefined;
  const a = invalidFile
    ? ({
        mode: "closed",
        state: "invalid",
        defaultUnreadable: false,
        attributes: new Set(),
        roles: [],
        skippedRoles: [],
        restrictions: [],
      } satisfies NAccess)
    : normalizeAccess(layer.access, layer.access_present, skipped);
  if (invalidFile) skipped.push({ path: "access.yaml", message: "cannot be read; nothing in it applies and access is treated as closed" });

  const modelRefs = new Set(layer.models.map((m) => `${m.source}.${m.model}`));
  // A row filter on a model that does not exist was meant to limit something unknown.
  for (const r of a.roles)
    for (const rf of r.rowFilters)
      if (!modelRefs.has(rf.model)) {
        skipped.push({ path: `${rf.path}.model`, message: `"${rf.model}" is not a model${BROKEN}` });
        r.broken.push(`${rf.path}.model`);
      }

  const attrs: Record<string, unknown> = isObj(user.attributes) ? { ...user.attributes } : {};
  const { held, unknown } = heldRoles(a, user, attrs);
  const broken = brokenRoles(a, held, user, attrs);
  const brokenReasons = broken.map((n) => `broken_role:${n}`);
  const roles = held.map((h) => a.roles.find((r) => r.name === h.name)!);
  const heldNames = new Set(held.map((h) => h.name));
  const granted = new Set(roles.flatMap((r) => r.allowTags));
  const undeclared = layer.access_present ? Object.keys(attrs).filter((k) => !a.attributes.has(k)).sort() : [];

  const targetHits = new Set<string>();
  const restrictionReasons = (ref: string, isMetric: boolean): string[] => {
    const out: string[] = [];
    for (const r of a.restrictions) {
      const hits = r.targets.filter((t) => t.metric === isMetric && safeMatch(t.pattern, ref));
      if (!hits.length) continue;
      for (const t of hits) targetHits.add(t.path);
      const ok = !r.broken && (r.roles.some((n) => heldNames.has(n)) || (r.when !== null && evaluateCondition(r.when, attrs)));
      if (!ok) out.push(`restricted:${r.name}`);
    }
    return out;
  };
  const protectedReasons = (tags: string[]): string[] =>
    uniq(
      lower(tags)
        .filter((t) => (PROTECTED_TAGS as readonly string[]).includes(t) && !granted.has(t))
        .map((t) => `protected_tag:${t}`),
    );
  const deniedByTag = (r: NRole, tags: string[]) => lower(tags).some((t) => r.denyTags.includes(t));

  // Why a role does not see a model, or [] when it does.
  const roleModelReasons = (r: NRole, ref: string, tags: string[]): string[] => {
    const out: string[] = [];
    if (a.mode === "closed" && !(r.allowModels ?? []).some((p) => safeMatch(p, ref))) out.push("not_allowed");
    if (r.denyModels.some((p) => safeMatch(p, ref)) || deniedByTag(r, tags)) out.push(`denied:${r.name}`);
    return out;
  };
  const roleFieldReasons = (r: NRole, ref: string, tags: string[]): string[] =>
    r.denyFields.some((p) => safeMatch(p, ref)) || deniedByTag(r, tags) ? [`denied:${r.name}`] : [];
  // The role layer: visible when any held role sees the item; a user with no role sees everything in
  // open mode and nothing in closed mode.
  const roleLayer = (perRole: (r: NRole) => string[]): string[] => {
    if (!roles.length) return a.mode === "open" ? [] : ["not_allowed"];
    const each = roles.map(perRole);
    return each.some((x) => !x.length) ? [] : uniq(each.flat());
  };

  const bySource = new Map<string, SourceVisibility>();
  const sourceOf = (s: string) => {
    let v = bySource.get(s);
    if (!v) bySource.set(s, (v = { source: s, models: [], metrics: [] }));
    return v;
  };

  for (const m of layer.models) {
    const ref = `${m.source}.${m.model}`;
    const mTags = tagsOf(m);
    const reasons = uniq([
      ...(statusOf(m) === "draft" ? ["draft"] : []),
      ...brokenReasons,
      ...roleLayer((r) => roleModelReasons(r, ref, mTags)),
      ...protectedReasons(mTags),
      ...restrictionReasons(ref, false),
    ]);
    const visible = !reasons.length;
    const fields: FieldVisibility[] = [];
    const addFields = (items: unknown, kind: FieldVisibility["kind"]) => {
      for (const f of list<{ name?: unknown; status?: unknown; tags?: unknown }>(items)) {
        if (typeof f.name !== "string") continue;
        const fref = `${ref}.${f.name}`;
        const own = tagsOf(f);
        const tags = uniq([...own, ...mTags]);
        const fr = uniq([
          ...(statusOf(f) === "draft" ? ["draft"] : []),
          ...brokenReasons,
          ...roleLayer((r) => {
            const mr = roleModelReasons(r, ref, mTags);
            return mr.length ? mr : roleFieldReasons(r, fref, tags);
          }),
          ...protectedReasons(tags),
          ...restrictionReasons(fref, false),
          ...(visible ? [] : ["model_hidden"]),
        ]);
        fields.push({ name: f.name, kind, ref: fref, status: statusOf(f), tags: own, visible: !fr.length, reasons: fr });
      }
    };
    addFields(m.dimensions, "dimension");
    addFields(m.measures, "measure");
    const mv: ModelVisibility = { model: m.model, ref, status: statusOf(m), tags: mTags, visible, reasons, fields };
    if (visible) mv.row_filters = modelRows(ref, mTags);
    sourceOf(m.source).models.push(mv);
  }

  function modelRows(ref: string, tags: string[]): ModelRows {
    // Only the held roles that see the model contribute rows; a contributing role with no filter on
    // the model contributes every row.
    if (!roles.length) return { rows: "all", branches: [] };
    const branches: RowFilterBranch[] = [];
    for (const r of roles) {
      if (roleModelReasons(r, ref, tags).length) continue;
      const mine = r.rowFilters.filter((rf) => rf.model === ref);
      if (!mine.length) return { rows: "all", branches: [] };
      const branch: RowFilterBranch = { role: r.name, filters: [], no_rows: false, problems: [] };
      for (const rf of mine) {
        const { filter, problem } = rowFilterResult(rf, attrs, modelRefs);
        if (filter) {
          branch.filters.push(filter);
          if (filter.missing.length) branch.no_rows = true;
        } else {
          branch.problems.push(problem!);
          branch.no_rows = true;
        }
      }
      branches.push(branch);
    }
    return { rows: branches.every((b) => b.no_rows) ? "none" : "filtered", branches };
  }

  const fieldIndex = new Map<string, FieldVisibility>();
  for (const s of bySource.values()) for (const m of s.models) for (const f of m.fields) fieldIndex.set(f.ref, f);

  for (const metric of layer.metrics) {
    const source = typeof metric.source === "string" ? metric.source : "";
    const tags = tagsOf(metric);
    const ref = `metric:${metric.name}`;
    const measures = metricMeasureRefs(metric);
    const measureReasons = measures.flatMap((mr) => {
      const f = fieldIndex.get(`${source}.${mr}`);
      if (!f || f.kind !== "measure") return [`unknown_measure:${mr}`];
      return f.visible ? [] : [`measure_hidden:${mr}`];
    });
    if (!measures.length) measureReasons.push("unknown_measure:none");
    const reasons = uniq([
      ...(statusOf(metric) === "draft" ? ["draft"] : []),
      ...brokenReasons,
      ...roleLayer((r) => (deniedByTag(r, tags) ? [`denied:${r.name}`] : [])),
      ...protectedReasons(tags),
      ...restrictionReasons(metric.name, true),
      ...measureReasons,
    ]);
    sourceOf(source).metrics.push({ name: metric.name, ref, status: statusOf(metric), tags, measures, visible: !reasons.length, reasons });
  }

  // A restriction target that matches nothing protects nothing; it is likely a mistake.
  const metricNames = layer.metrics.map((m) => m.name);
  for (const r of a.restrictions)
    for (const t of r.targets) {
      if (targetHits.has(t.path)) continue;
      const hint = !t.metric && metricNames.some((n) => safeMatch(t.pattern, n)) ? `; write metric:${t.pattern} to name a metric` : "";
      const what = t.metric ? "no metric" : "no model or field";
      warnings.push({ path: t.path, message: `"${t.metric ? "metric:" : ""}${t.pattern}" matches ${what}, so it hides nothing${hint}` });
    }

  const sources = [...bySource.values()].sort((x, y) => x.source.localeCompare(y.source));
  for (const s of sources) {
    s.models.sort((x, y) => x.model.localeCompare(y.model));
    s.metrics.sort((x, y) => x.name.localeCompare(y.name));
  }
  const count = <T extends { visible: boolean }>(xs: T[]): Counts => ({ visible: xs.filter((x) => x.visible).length, hidden: xs.filter((x) => !x.visible).length });
  const allModels = sources.flatMap((s) => s.models);
  const allFields = allModels.flatMap((m) => m.fields);
  const allMetrics = sources.flatMap((s) => s.metrics);
  const byTag = (x: { status: string; reasons: string[] }) => x.status === "approved" && x.reasons.some((r) => r.startsWith("protected_tag:"));
  const assigned = Array.isArray(user.roles) ? user.roles.filter((r) => typeof r === "string") : [];
  return {
    mode: a.mode,
    access_file: a.state,
    user: { attributes: attrs, roles: uniq(assigned), default_audience: !Object.keys(attrs).length && !assigned.length },
    roles: held,
    unknown_roles: unknown,
    broken_roles: broken,
    undeclared_attributes: undeclared,
    skipped,
    warnings,
    sources,
    summary: {
      models: count(allModels),
      fields: count(allFields),
      metrics: count(allMetrics),
      hidden_by_protected_tags: [...allModels, ...allFields, ...allMetrics].filter(byTag).length,
    },
  };
}

// Evaluates what one user sees of the layer under root. With no user, the default audience: a
// user with no attributes and no assigned roles.
export function evaluateAccess(root: string, user: AccessUser = {}): AccessVisibility {
  return evaluateLayer(loadAccessLayer(root), user);
}

// --- requests ------------------------------------------------------------------------------

export type RequestPosition = "measures" | "dimensions" | "filters" | "order_by";

export interface RequestProblem {
  position: RequestPosition;
  index: number;
  ref: string;
  reasons: string[];
  message: string;
}

export interface RequestCheck {
  ok: boolean;
  problems: RequestProblem[];
}

// Finds a request reference, model.field[:grain] or a bare metric name, in a source.
export function lookup(visibility: AccessVisibility, source: string, ref: string): FieldVisibility | MetricVisibility | undefined {
  const s = visibility.sources.find((x) => x.source === source);
  if (!s) return undefined;
  if (NAME.test(ref)) return s.metrics.find((m) => m.name === ref);
  const parsed = parseRequestField(ref);
  if (!parsed) return undefined;
  const model = s.models.find((m) => m.model === parsed.model);
  return model?.fields.find((f) => f.name === parsed.field);
}

// Checks that a request names only fields and metrics the user may see, in every position it can
// name one: measures (selected), dimensions (grouped), filters and order_by. A reference that
// resolves to nothing is refused too.
export function checkRequest(visibility: AccessVisibility, request: QueryRequest): RequestCheck {
  const problems: RequestProblem[] = [];
  const source = typeof request?.source === "string" ? request.source : "";
  const check = (position: RequestPosition, index: number, ref: unknown) => {
    if (typeof ref !== "string") {
      problems.push({ position, index, ref: String(ref), reasons: ["unreadable"], message: `${position}[${index}] is not a field reference` });
      return;
    }
    const hit = lookup(visibility, source, ref);
    if (!hit) {
      problems.push({ position, index, ref, reasons: ["unknown"], message: `${position}[${index}] names ${ref}, which is not a field or metric of source ${source}` });
      return;
    }
    if (!hit.visible)
      problems.push({ position, index, ref, reasons: hit.reasons, message: `${position}[${index}] names ${ref}, which this user may not see (${hit.reasons.join(", ")})` });
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  arr(request?.measures).forEach((r, i) => check("measures", i, r));
  arr(request?.dimensions).forEach((r, i) => check("dimensions", i, r));
  arr(request?.filters).forEach((f, i) => check("filters", i, isObj(f) ? f.field : f));
  arr(request?.order_by).forEach((o, i) => check("order_by", i, isObj(o) ? o.field : o));
  return { ok: !problems.length, problems };
}

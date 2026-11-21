// Content hashes of approved items. semlayer approve records approved_hash, the SHA-256 of an item's
// normalized semantic content; semlayer validate and semlayer status compare it with the item as it now stands,
// so an edit made after the owner's sign-off is caught instead of silently changing a figure.
import { createHash } from "node:crypto";
import type { WeekDay } from "./compiler/calendar.ts";
import type { Dialect, Model } from "./types.ts";
import { segmentFilters, segmentNames } from "./segments.ts";
import { sqlNames } from "./sql-names.ts";

// Keys of an item that record its approval rather than its content.
const APPROVAL_KEYS = new Set(["status", "approved_by", "approved_at", "approved_hash", "last_approved"]);

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objects(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

// A string trimmed with its line endings made LF; anything else as it is.
function text(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : v;
}

// A plain code-point comparison, the same on every machine and locale.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A list whose order carries no meaning (tags, synonyms, grains, key columns), sorted.
function set(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map(text).sort((a, b) => byCodePoint(JSON.stringify(a) ?? "", JSON.stringify(b) ?? ""));
}

// Canonical JSON: object keys sorted, undefined left out, strings trimmed.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(text(v)) ?? "null";
}

function digest(content: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(content)).digest("hex")}`;
}

// What a join means: its target, keys, relationship and type (left when not written).
function joinContent(j: Obj): Obj {
  const keys = objects(j.keys).map((k) => ({ from: text(k.from), to: text(k.to) }));
  const content: Obj = { to: text(j.to), keys: set(keys), relationship: j.relationship, type: j.type ?? "left" };
  // An override silences the fan-out error, so adding or changing one needs a new approval.
  if (j.fanout_override !== undefined) content.fanout_override = j.fanout_override;
  // A bridge join's meaning includes its bridge, the bridge's keys to the target and how a figure is shared.
  if (isObject(j.through)) {
    const t = j.through;
    const through: Obj = { model: text(t.model), keys: set(objects(t.keys).map((k) => ({ from: text(k.from), to: text(k.to) }))), dedupe: t.dedupe ?? null };
    if (t.weight !== undefined) through.weight = text(t.weight);
    content.through = through;
  }
  return content;
}

// The join a name refers to: an unquoted name matches in any case, a quoted one exactly.
function findJoin(joins: Obj[], name: string, quoted: boolean): Obj | undefined {
  return joins.find((j) => typeof j.name === "string" && (quoted ? j.name === name : j.name === name.toLowerCase()));
}

// The joins a field's SQL reads through, as { path, ...definition }: <join>.<column> reads one of the
// model's joins, and <join>.<join>.<column> also a join of the model it reaches. Each is listed
// once, sorted by path.
function readJoins(model: Obj, sql: unknown[], lookup: (name: string) => Model | undefined, dialect?: Dialect): Obj[] {
  const out = new Map<string, Obj>();
  const joins = objects(model.joins);
  for (const s of sql) {
    if (typeof s !== "string") continue;
    for (const chain of sqlNames(s, dialect).chains) {
      const first = findJoin(joins, chain.parts[0]!, chain.quoted[0]!);
      if (!first) continue;
      out.set(String(first.name), { path: String(first.name), ...joinContent(first) });
      if (chain.parts.length < 3 || typeof first.to !== "string") continue;
      const target = lookup(first.to) as unknown;
      const second = isObject(target) ? findJoin(objects(target.joins), chain.parts[1]!, chain.quoted[1]!) : undefined;
      if (second) {
        const path = `${String(first.name)}.${String(second.name)}`;
        out.set(path, { path, from: first.to, ...joinContent(second) });
      }
    }
  }
  return [...out.keys()].sort(byCodePoint).map((k) => out.get(k)!);
}

export type ItemKind = "model" | "dimension" | "measure" | "join" | "metric" | "access" | "schema-pair";

// Where an item sits, for the parts of its hash that say which item it is, and for reading the joins
// its SQL goes through: the source, the model a field or join belongs to, a lookup of the source's
// other models (the second hop of a join reference), the source's dialect and the day its weeks
// start (sourceWeekStart in compiler/calendar.ts: undefined for Monday, the default).
export interface HashScope {
  source?: string;
  model?: Obj;
  lookup?: (name: string) => Model | undefined;
  dialect?: Dialect;
  weekStart?: WeekDay;
}

// Whether a dimension can be asked for at week grain: a time dimension whose time_grains, when it
// lists them, include week.
function hasWeekGrain(item: Obj): boolean {
  return item.type === "time" && (!Array.isArray(item.time_grains) || item.time_grains.includes("week"));
}

// Which item a field or join is: its source, model and name, and the table the model reads. A field
// renamed, swapped with another or moved to another model, and a model pointed at another table,
// each change the hash of every field they touch.
function fieldIdentity(item: Obj, scope: HashScope): Obj {
  return { source: scope.source, model: text(scope.model?.model), table: text(scope.model?.table), name: text(item.name) };
}

// A measure's non_additive_dimension as hashed: its name and window, and the expr of the dimension it
// names as the model declares it now (null when it declares none), since that column decides which
// row is kept.
function nonAdditiveContent(nad: unknown, model: Obj | undefined): Obj {
  const n = isObject(nad) ? nad : {};
  const dim = objects(model?.dimensions).find((d) => d.name === n.name);
  return { name: text(n.name), window: n.window, expr: dim ? text(dim.expr) : null };
}

// The semantic content each kind of item is hashed over:
// - a dimension: its identity (source, model, name and the model's table), expr, type, time_grains,
//   time_zone, synonyms, tags, the joins its expr reads and, for one with a week grain on a source
//   whose weeks do not start on Monday, the week start (left out otherwise, so its hash is as before);
// - a measure: its identity, expr, filter, agg, format, currency, synonyms, tags, the filter texts of
//   the segments it names (left out when it names none, so its hash is as before segments) and the
//   joins its expr, filter and segments read, its default_time_dimension when set, and its
//   non_additive_dimension when set (its name, window and the expr of the dimension it names);
// - a join: its identity, to, keys, relationship and type;
// - a model: its source and name, table, grain, primary_key, tags and its default_time_dimension when set;
// - a metric: name, source, type, numerator, denominator, expr, format, currency, synonyms and tags;
// - access.yaml: the whole file but its approval and open_questions (top level and per role);
// - a schema pair (an entry of cross_schema in sources/<s>.yaml): its from, to and keys, each key
//   with its from, to and constraint.
// Descriptions are not part of it: editing one changes no figure.
function itemContent(kind: ItemKind, item: Obj, scope: HashScope): Obj {
  const { model, lookup = () => undefined, dialect } = scope;
  switch (kind) {
    case "dimension":
      return {
        kind,
        ...fieldIdentity(item, scope),
        expr: text(item.expr),
        type: item.type,
        time_grains: set(item.time_grains),
        time_zone: text(item.time_zone),
        // The owner's statement that it is the same as another model's dimension; left out when unset.
        ...(item.conforms_to !== undefined ? { conforms_to: text(item.conforms_to) } : {}),
        synonyms: set(item.synonyms),
        tags: set(item.tags),
        joins: model ? readJoins(model, [item.expr], lookup, dialect) : [],
        ...(scope.weekStart && hasWeekGrain(item) ? { week_start: scope.weekStart } : {}),
      };
    case "measure": {
      // Each named segment's filter as the model declares it now, null for one it does not declare.
      const segments = segmentNames(item).length ? segmentFilters(item, model).map((f) => (f === undefined ? null : text(f))) : undefined;
      return {
        kind,
        ...fieldIdentity(item, scope),
        expr: text(item.expr),
        filter: text(item.filter),
        agg: item.agg,
        format: item.format,
        currency: text(item.currency),
        synonyms: set(item.synonyms),
        tags: set(item.tags),
        ...(segments ? { segments: set(segments) } : {}),
        ...(item.default_time_dimension !== undefined ? { default_time_dimension: text(item.default_time_dimension) } : {}),
        ...(item.non_additive_dimension !== undefined ? { non_additive_dimension: nonAdditiveContent(item.non_additive_dimension, model) } : {}),
        joins: model ? readJoins(model, [item.expr, item.filter, ...(segments ?? [])], lookup, dialect) : [],
      };
    }
    case "join":
      return { kind, ...fieldIdentity(item, scope), ...joinContent(item) };
    case "model":
      return {
        kind,
        source: scope.source,
        model: text(item.model),
        table: text(item.table),
        grain: text(item.grain),
        primary_key: set(item.primary_key),
        tags: set(item.tags),
        ...(item.default_time_dimension !== undefined ? { default_time_dimension: text(item.default_time_dimension) } : {}),
      };
    case "metric":
      return {
        kind,
        name: text(item.name),
        source: item.source,
        type: item.type,
        numerator: text(item.numerator),
        denominator: text(item.denominator),
        expr: text(item.expr),
        format: item.format,
        currency: text(item.currency),
        synonyms: set(item.synonyms),
        tags: set(item.tags),
      };
    case "access": {
      const out: Obj = { kind };
      for (const [k, v] of Object.entries(item)) {
        if (APPROVAL_KEYS.has(k) || k === "open_questions") continue;
        out[k] = k === "roles" && Array.isArray(v) ? v.map((r) => (isObject(r) ? { ...r, open_questions: undefined } : r)) : v;
      }
      return out;
    }
    case "schema-pair":
      return {
        kind,
        from: text(item.from),
        to: text(item.to),
        keys: set(objects(item.keys).map((k) => ({ from: text(k.from), to: text(k.to), constraint: text(k.constraint) }))),
      };
  }
}

export function itemHash(kind: ItemKind, item: Obj, scope: HashScope = {}): string {
  return digest(itemContent(kind, item, scope));
}

// A golden target's content hash (golden:<name>): what the owner says yes to before semlayer goldens
// confirm records it. It covers the golden's question, request, cross_check_sql (or the older key
// sql, read as it, so renaming the key keeps the hash), role and user, the tolerance it would
// record and the rows it would record: the rows its request compiles to. Rows keep their order
// when the request orders them; otherwise they are sorted, so a database returning the same rows
// in another order gives the same hash. Its reference and description are not part of it.
export function goldenHash(golden: Obj, rows: unknown[], tolerance: number): string {
  const ordered = isObject(golden.request) && Array.isArray(golden.request.order_by) && golden.request.order_by.length > 0;
  const each = rows.map(canonical);
  return digest({
    kind: "golden",
    name: text(golden.name),
    question: text(golden.question),
    request: golden.request,
    cross_check_sql: text(typeof golden.cross_check_sql === "string" ? golden.cross_check_sql : golden.sql),
    role: text(golden.role),
    // No user and an empty user are the same.
    user: isObject(golden.user) && Object.keys(golden.user).length ? golden.user : undefined,
    tolerance,
    rows: ordered ? each : each.sort(byCodePoint),
  });
}

// One item that carries an approval, located in its file.
export interface ApprovalEntry {
  kind: ItemKind;
  // The approve target: source.model, source.model.field, metric:<name>, access or
  // schema-pair:<source>:<from>:<to>.
  ref: string;
  // Where the item sits in its file, as semlayer approve edits it.
  path: (string | number)[];
  item: Obj;
  // The hash of the item as it now stands.
  hash: string;
}

// The model and each of its dimensions, measures and joins. `lookup` finds another model of the same
// source, for the second hop of a join reference; `weekStart` is the source's (sourceWeekStart).
export function modelEntries(source: string, model: Model, lookup: (name: string) => Model | undefined, dialect?: Dialect, weekStart?: WeekDay): ApprovalEntry[] {
  const m = model as unknown as Obj;
  const base = `${source}.${String(m.model)}`;
  const out: ApprovalEntry[] = [{ kind: "model", ref: base, path: [], item: m, hash: itemHash("model", m, { source }) }];
  const sections = [
    ["dimensions", "dimension"],
    ["measures", "measure"],
    ["joins", "join"],
  ] as const;
  for (const [section, kind] of sections) {
    const list = Array.isArray(m[section]) ? (m[section] as unknown[]) : [];
    list.forEach((x, i) => {
      if (!isObject(x) || typeof x.name !== "string") return;
      out.push({ kind, ref: `${base}.${x.name}`, path: [section, i], item: x, hash: itemHash(kind, x, { source, model: m, lookup, dialect, weekStart }) });
    });
  }
  return out;
}

export function metricEntries(metrics: unknown): ApprovalEntry[] {
  const list = Array.isArray(metrics) ? metrics : [];
  return list.flatMap((x, i) =>
    isObject(x) && typeof x.name === "string" ? [{ kind: "metric" as const, ref: `metric:${x.name}`, path: ["metrics", i], item: x, hash: itemHash("metric", x) }] : [],
  );
}

export function accessEntry(access: unknown): ApprovalEntry | undefined {
  return isObject(access) ? { kind: "access", ref: "access", path: [], item: access, hash: itemHash("access", access) } : undefined;
}

// The schema pairs of a source's cross_schema, each as schema-pair:<source>:<from>:<to>.
export function pairEntries(source: string, config: unknown): ApprovalEntry[] {
  const list = isObject(config) && Array.isArray(config.cross_schema) ? (config.cross_schema as unknown[]) : [];
  return list.flatMap((x, i) =>
    isObject(x) && typeof x.from === "string" && typeof x.to === "string"
      ? [{ kind: "schema-pair" as const, ref: `schema-pair:${source}:${x.from}:${x.to}`, path: ["cross_schema", i], item: x, hash: itemHash("schema-pair", x) }]
      : [],
  );
}

// The relative tolerance a golden records when none is agreed (--tolerance) or kept in its file.
export const DEFAULT_TOLERANCE = 0.005;

// A model of the layer to list: its source, the file it sits in, a lookup of the source's other models
// (the second hop of a join reference), the source's dialect and its week start (sourceWeekStart).
export interface LayerModel {
  source: string;
  model: Model;
  file?: string;
  lookup: (name: string) => Model | undefined;
  dialect?: Dialect;
  weekStart?: WeekDay;
}

// The parts of a layer whose approvals to list, each as its reader loaded it. A part left out is not
// listed: a caller that reads one file passes only that file.
export interface ApprovalLayer {
  models?: LayerModel[];
  // The list under metrics: in metrics.yaml.
  metrics?: unknown;
  metricsFile?: string;
  // access.yaml as parsed; null or undefined when there is none.
  access?: unknown;
  accessFile?: string;
  goldens?: { golden: unknown; file?: string }[];
  // Sources whose schema pairs to list: the source's name and its file as parsed.
  sources?: { source: string; config: unknown; file?: string }[];
}

// Where an entry sits and what it records: its file, its status and the approved_hash it records
// (a golden records none: its owner's yes carries the hash of its recorded rows).
interface Recorded {
  file?: string;
  status?: string;
  recorded_hash?: string;
}

// A model, field, join, metric or access.yaml entry.
export type ItemApproval = ApprovalEntry & Recorded;

// A golden: hash is the hash of its recorded rows and tolerance, the one its owner's yes carries.
// complete is false when it has no name or no recorded rows (its hash then reads them as none).
export interface GoldenApproval extends Recorded {
  kind: "golden";
  ref: string;
  path: (string | number)[];
  item: Obj;
  hash: string;
  complete: boolean;
}

export type Approval = ItemApproval | GoldenApproval;

function recorded(item: Obj, file: string | undefined): Recorded {
  const hash = carriesHash(item) ? String(item.approved_hash).trim() : undefined;
  return { file, status: typeof item.status === "string" ? item.status : undefined, recorded_hash: hash };
}

// Every approval entry of a layer, in one list: each model with its dimensions, measures and joins
// (in the order given), then the sources' schema pairs, the metrics, access.yaml and the goldens. semlayer approve, the typed edits,
// semlayer status, semlayer validate, semlayer access, semlayer readback and the approvals grader list them here; the edit
// hook lists models, metrics and access.yaml here and compares a golden's expected rows directly.
export function listApprovals(layer: ApprovalLayer): Approval[] {
  const out: Approval[] = [];
  for (const m of layer.models ?? [])
    for (const e of modelEntries(m.source, m.model, m.lookup, m.dialect, m.weekStart)) out.push({ ...e, ...recorded(e.item, m.file) });
  for (const s of layer.sources ?? []) for (const e of pairEntries(s.source, s.config)) out.push({ ...e, ...recorded(e.item, s.file) });
  for (const e of metricEntries(layer.metrics)) out.push({ ...e, ...recorded(e.item, layer.metricsFile) });
  const access = accessEntry(layer.access);
  if (access) out.push({ ...access, ...recorded(access.item, layer.accessFile) });
  for (const { golden: g, file } of layer.goldens ?? []) {
    if (!isObject(g)) continue;
    const expected = isObject(g.expected) ? g.expected : {};
    const rows = Array.isArray(expected.rows) ? expected.rows : undefined;
    const tolerance = (expected.tolerance ?? DEFAULT_TOLERANCE) as number;
    out.push({
      kind: "golden",
      ref: `golden:${g.name}`,
      path: [],
      item: g,
      hash: goldenHash(g, rows ?? [], tolerance),
      complete: typeof g.name === "string" && rows !== undefined,
      ...recorded(g, file),
    });
  }
  return out;
}

// The model, field, join, metric and access entries of a list, without its goldens.
export function itemApprovals(list: Approval[]): ItemApproval[] {
  return list.filter((e): e is ItemApproval => e.kind !== "golden");
}

// Whether an item records an approved_hash.
export function carriesHash(item: Obj): boolean {
  return typeof item.approved_hash === "string" && item.approved_hash.trim() !== "";
}

// Whether any of these entries records an approved_hash: once one does, the project has content
// hashes, and an approved item without one may have had its hash removed.
export function holdsHashes(entries: ApprovalEntry[]): boolean {
  return entries.some((e) => carriesHash(e.item));
}

// Where an approval stands: draft (not approved), current (its hash matches), changed (its hash
// does not), unhashed (no hash, in a project where no item records one: approved before content
// hashes were recorded) or missing (no hash, while other items of the project record one, so the
// hash may have been removed).
export type Integrity = "draft" | "current" | "changed" | "unhashed" | "missing";

export function integrity(e: ApprovalEntry, projectHashed = false): Integrity {
  if (e.item.status !== "approved") return "draft";
  if (!carriesHash(e.item)) return projectHashed ? "missing" : "unhashed";
  return String(e.item.approved_hash).trim() === e.hash ? "current" : "changed";
}

// A path as semlayer validate writes one: measures[2], metrics[0], or "" for the file itself.
export function pathText(path: (string | number)[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out ? `.${p}` : p;
  return out;
}

// The message for an approved item whose content no longer matches its hash.
export function changedMessage(e: ApprovalEntry): string {
  const by = typeof e.item.approved_by === "string" ? ` by ${e.item.approved_by}` : "";
  const at = typeof e.item.approved_at === "string" ? ` on ${e.item.approved_at}` : "";
  const reads = e.kind === "dimension" || e.kind === "measure" ? ", or a join it reads through," : "";
  return (
    `${e.ref} changed since it was approved${by}${at}: its definition${reads} no longer matches approved_hash. ` +
    `Read it back to the owner as it now stands and approve it again only after they confirm (semlayer approve --target ${e.ref} --by "<owner>"), ` +
    "or restore the approved definition"
  );
}

export const UNHASHED_MESSAGE =
  "approved before content hashes; run semlayer approve --stamp-hashes to record them, after checking in version control that none changed since approved_at";

// The message for an approved item without a hash in a project whose other items record one.
export function missingMessage(e: ApprovalEntry): string {
  return (
    `${e.ref} is approved, but approved_hash is missing while other approved items carry one; it may have been removed. ` +
    `Read it back to the owner as it now stands and approve it again only after they confirm (semlayer approve --target ${e.ref} --by "<owner>")`
  );
}

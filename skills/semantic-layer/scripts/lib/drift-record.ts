// The drift record, .semlayer/drift.json under the semantic root (spec: Iterating a layer, The drift
// record). semlayer introspect keeps in it (semlayer import writes it too, for a snapshot replaced from a file), per source, the last change it found against the previous
// snapshot and the retyped columns an approved field reads, each with the field's hash and the owner's
// latest yes to it when the change was found. A retyped column stays open for a field until the field
// is edited (its hash changes) or approved again (a newer yes); semlayer validate warns
// release.column_retyped on each field still open. The record holds names and types, never a value.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { modelEntries } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { ledgerState } from "./ledger.ts";
import { writeFileAtomic } from "./lock.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { SCHEMAS_DIR } from "./schema.ts";
import { type SnapshotDiff, sqlIdentifiers } from "./snapshot-diff.ts";
import type { Dialect, LedgerReply, Model, Snapshot } from "./types.ts";

export const DRIFT_FILE = ".semlayer/drift.json";

// An approved field that read a retyped column when the change was found: its approve target, its
// content hash then, and the id of the owner's latest yes to it then (null when there was none).
export interface FieldRead {
  ref: string;
  hash: string;
  yes: string | null;
}

export interface OpenRetype {
  table: string;
  column: string;
  from: string;
  to: string;
  // When an introspect first found the column retyped from `from`.
  at: string;
  reads: FieldRead[];
}

export interface SourceDrift {
  source: string;
  // The last introspect that found a change, and that change.
  at: string;
  diff: SnapshotDiff;
  // Where the snapshot before and after that change came from (the snapshots' `method`), so a reader can
  // tell a schema change from a change of source. Absent in a record written before it was kept.
  methods?: { from: string; to: string };
  // The tables of diff.tables_removed that the database still holds but the role cannot read.
  unreadable?: string[];
  // Retyped columns an approved field still reads as it was approved, by table and column.
  retyped: OpenRetype[];
}

export interface DriftRecord {
  version: 1;
  sources: SourceDrift[];
}

let validator: ValidateFunction | undefined;

// Reads the record: null when there is none; a file that is not JSON or does not match
// schemas/drift.schema.json is refused in one line naming it.
export function readDrift(root: string): DriftRecord | null {
  const file = join(root, DRIFT_FILE);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UserError(`${DRIFT_FILE} is not valid JSON. The next semlayer introspect writes it again.`, "semlayer introspect --source <source>");
  }
  validator ??= new Ajv2020({ allErrors: true, strictTypes: false }).compile(JSON.parse(readFileSync(join(SCHEMAS_DIR, "drift.schema.json"), "utf8")) as object);
  if (!validator(data)) throw new UserError(`${DRIFT_FILE} does not match schemas/drift.schema.json. The next semlayer introspect writes it again.`, "semlayer introspect --source <source>");
  return data as DriftRecord;
}

// A dimension or measure as it now stands: its hash, whether it is approved, the id of the owner's
// latest yes to it, and where it sits in its model file.
export interface FieldNow {
  hash: string;
  approved: boolean;
  yes: string | null;
  model: string;
  path: (string | number)[];
}

// The id of the owner's latest yes to a target, whatever content it was given to.
function latestYes(replies: LedgerReply[], target: string): string | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i]!;
    if (r.target === target && r.about === undefined && r.verdict === "yes") return r.id;
  }
  return null;
}

// The dimensions and measures of a source's models as they now stand, by approve target. A model or
// field that cannot be read as a mapping with a name is left out. A ledger that cannot be read
// counts as having no yes. The hashes here are private to the drift record (both sides of its comparison
// come from this function), so a week start is not passed: they are not compared with an approved_hash.
// Each is the field's definition hash, its description left out: a retyped column concerns what the
// field reads, and a record written before descriptions were part of an approval holds these hashes.
export function fieldsNow(root: string, source: string, models: readonly Model[], dialect: Dialect | undefined): Map<string, FieldNow> {
  const named = models.filter((m) => m && typeof m === "object" && typeof m.model === "string");
  const byName = new Map(named.map((m) => [m.model, m]));
  const replies = ledgerState(root).replies;
  const out = new Map<string, FieldNow>();
  for (const m of named) {
    for (const e of modelEntries(source, m, (n) => byName.get(n), dialect)) {
      if (e.kind !== "dimension" && e.kind !== "measure") continue;
      out.set(e.ref, { hash: e.definitionHash, approved: e.item.status === "approved", yes: latestYes(replies, e.ref), model: m.model, path: e.path });
    }
  }
  return out;
}

// Whether a retyped column is still open for a field: the field exists with the hash it had and no
// newer yes. Its status is not read, so a field revoked to draft stays open until it is approved again.
export function readOpen(read: FieldRead, now: FieldNow | undefined): boolean {
  return !!now && now.hash === read.hash && now.yes === read.yes;
}

// Whether a field's expr or filter names `column`: an unquoted name in any case, a quoted one exactly.
// A name that is a join of the model is a join reference, not a column.
function readsColumn(field: { expr?: unknown; filter?: unknown }, column: string, joins: Set<string>, dialect: Dialect | undefined): boolean {
  for (const sql of [field.expr, field.filter]) {
    if (typeof sql !== "string") continue;
    for (const id of sqlIdentifiers(sql, dialect)) {
      if (id.quoted ? id.v === column : !joins.has(id.v.toLowerCase()) && id.v.toLowerCase() === column.toLowerCase()) return true;
    }
  }
  return false;
}

// The approved dimensions and measures that read `column` of the snapshot table `table` names.
function approvedReaders(table: string, column: string, snapshot: Snapshot, models: readonly Model[], fields: Map<string, FieldNow>, source: string, dialect: Dialect | undefined): FieldRead[] {
  const out: FieldRead[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object" || typeof m.model !== "string" || typeof m.table !== "string") continue;
    const t = findTable(snapshot.tables, m.table);
    if (!t || qualifiedName(t) !== table) continue;
    const joins = new Set((Array.isArray(m.joins) ? m.joins : []).map((j) => (typeof j?.name === "string" ? j.name.toLowerCase() : "")));
    for (const f of [...(Array.isArray(m.dimensions) ? m.dimensions : []), ...(Array.isArray(m.measures) ? m.measures : [])]) {
      if (!f || typeof f.name !== "string" || !readsColumn(f, column, joins, dialect)) continue;
      const ref = `${source}.${m.model}.${f.name}`;
      const now = fields.get(ref);
      if (now?.approved) out.push({ ref, hash: now.hash, yes: now.yes });
    }
  }
  return out;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normType = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

export interface DriftInput {
  source: string;
  dialect: Dialect | undefined;
  // The new snapshot, its diff against the previous one, and the run's clock.
  snapshot: Snapshot;
  diff: SnapshotDiff;
  at: string;
  // The relations, schema.name, the role cannot read.
  unreadable: string[];
  // The snapshot methods before and after, when the run knows them.
  methods?: { from: string; to: string };
  // The source's models; a function that throws (a model file that does not parse) counts as none.
  models: () => readonly Model[];
}

// The source's entry after this run. A diff with changes replaces `at`, `diff` and `unreadable`; one
// without leaves them. Open retyped columns carry over while their table still has the column and a
// field still reads it as approved; a column retyped again keeps its first `from` and `at` and drops
// out when it is back at that type; a newly retyped column opens for each approved field that reads it.
export function nextEntry(previous: SourceDrift | undefined, input: DriftInput, fields: Map<string, FieldNow>, models: readonly Model[]): SourceDrift | undefined {
  const changed = !!(input.diff.tables_added.length || input.diff.tables_removed.length || input.diff.columns.length);
  const columnsNow = new Map(input.snapshot.tables.map((t) => [qualifiedName(t), new Set(t.columns.map((c) => c.name))]));
  const open = new Map<string, OpenRetype>();
  const key = (table: string, column: string) => `${table}\u0000${column}`;
  for (const r of previous?.retyped ?? []) {
    if (!columnsNow.get(r.table)?.has(r.column)) continue;
    open.set(key(r.table, r.column), { ...r, reads: r.reads.filter((x) => readOpen(x, fields.get(x.ref))) });
  }
  for (const c of input.diff.columns) {
    for (const r of c.retyped) {
      const k = key(c.table, r.name);
      const before = open.get(k);
      const readers = approvedReaders(c.table, r.name, input.snapshot, models, fields, input.source, input.dialect);
      const reads = [...(before?.reads ?? []), ...readers.filter((x) => !before?.reads.some((b) => b.ref === x.ref))];
      if (before && normType(before.from) === normType(r.to)) {
        open.delete(k);
        continue;
      }
      open.set(k, { table: c.table, column: r.name, from: before?.from ?? r.from, to: r.to, at: before?.at ?? input.at, reads });
    }
  }
  const retyped = [...open.values()]
    .filter((r) => r.reads.length)
    .map((r) => ({ ...r, reads: [...r.reads].sort((a, b) => byText(a.ref, b.ref)) }))
    .sort((a, b) => byText(a.table, b.table) || byText(a.column, b.column));
  if (!changed && !previous) return undefined;
  const unreadable = changed ? input.diff.tables_removed.filter((t) => input.unreadable.includes(t)).sort(byText) : (previous?.unreadable ?? []);
  return {
    source: input.source,
    at: changed ? input.at : previous!.at,
    diff: changed ? input.diff : previous!.diff,
    ...((changed ? input.methods : previous!.methods) ? { methods: changed ? input.methods : previous!.methods } : {}),
    ...(unreadable.length ? { unreadable } : {}),
    retyped,
  };
}

// .semlayer may be a link to a directory inside the root; one that leads outside it or nowhere is refused.
function assertInside(root: string): void {
  const dir = join(root, ".semlayer");
  if (!lstatSync(dir, { throwIfNoEntry: false })) return;
  const why = `Refusing to write ${DRIFT_FILE}: .semlayer`;
  const fix = "Nothing was written, the snapshot included. Replace the link with a directory inside the semantic root and rerun the command.";
  if (!existsSync(dir)) throw new UserError(`${why} is a symbolic link to nothing. ${fix}`);
  const r = realpathSync(root);
  const p = realpathSync(dir);
  if (p !== r && !p.startsWith(r + sep)) throw new UserError(`${why} resolves outside the semantic root ${resolve(root)}. ${fix}`);
}

// Merges this run into the record and writes it, whole, when it changed. A record that cannot be read
// is replaced. Called under the root's lock, before the snapshot is written, so a refusal here leaves
// both as they were.
export function writeDrift(root: string, input: DriftInput): void {
  let record: DriftRecord | null;
  try {
    record = readDrift(root);
  } catch {
    record = null;
  }
  let models: readonly Model[];
  try {
    models = input.models();
  } catch {
    models = [];
  }
  const fields = fieldsNow(root, input.source, models, input.dialect);
  const previous = record?.sources.find((s) => s.source === input.source);
  const entry = nextEntry(previous, input, fields, models);
  if (!entry) return;
  const sources = [...(record?.sources ?? []).filter((s) => s.source !== input.source), entry].sort((a, b) => byText(a.source, b.source));
  const text = `${JSON.stringify({ version: 1, sources }, null, 2)}\n`;
  const file = join(root, DRIFT_FILE);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  assertInside(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, text);
}

// Typed edits: the shared steps of sl set, sl tag, sl ignore-column, sl question, sl add-field,
// sl remove-field, sl add-metric, sl remove-metric, sl rename and the access edits (lib/access-edit.ts).
// An edit changes YAML files through editYamlText, so the owner's
// comments and every untouched byte survive; the result is validated as the project would read it,
// and it is written only when it adds no error.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import type { LastApproval } from "./access.ts";
import { type ApprovalEntry, carriesHash, itemApprovals, type LayerModel, listApprovals } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";
import { plainText } from "./output.ts";
import { listSourceNames, paths, stem } from "./project.ts";
import { findField, type FieldMatch, parseTarget } from "./refs.ts";
import { DIALECTS, type Dialect, type Model, PROTECTED_TAGS, PUBLIC_TAG, type SnapshotTable } from "./types.ts";
import { matchesDotted } from "./patterns.ts";
import { incomingKeyColumns, referencedColumns } from "./snapshot-diff.ts";
import { sqlNames } from "./sql-names.ts";
import { type Issue, SCHEMAS_DIR, validateProject } from "./validate.ts";
import { editYamlText, parseYaml, parseYamlText, readYamlIfExists } from "./yaml.ts";

// Keys only sl approve writes.
export const APPROVAL_FIELDS = ["status", "approved_by", "approved_at", "approved_hash", "last_approved"];

export type ItemKind = "model" | "dimension" | "measure" | "join" | "metric" | "access";

// One item a ref names: the file that holds it, its path inside the file and its parsed value.
export interface Located {
  ref: string;
  kind: ItemKind;
  file: string;
  path: (string | number)[];
  item: Record<string, unknown>;
  source?: string;
  model?: Model;
}

// Finds the item of an approve-style ref: source.model, source.model.field, metric:<name> or access.
export function locate(root: string, ref: string): Located {
  const t = parseTarget(ref);
  const obj = (x: unknown) => x as Record<string, unknown>;
  switch (t.kind) {
    case "golden":
      throw new UserError(`Goldens are not edited with typed edits; sl goldens run --name ${t.name} shows one.`);
    case "access": {
      const file = paths(root).access;
      const access = readYamlIfExists<Record<string, unknown>>(file);
      if (!access) throw new UserError(`No access.yaml at ${file}. Ask the owner the exceptions question first (sl status names it), then create it with sl set access mode open (or closed for an allowlist).`);
      return { ref, kind: "access", file, path: [], item: access };
    }
    case "metric": {
      const file = paths(root).metrics;
      const metrics = readYamlIfExists<{ metrics?: Record<string, unknown>[] }>(file)?.metrics ?? [];
      const index = Array.isArray(metrics) ? metrics.findIndex((m) => m?.name === t.name) : -1;
      if (index < 0) throw new UserError(`No metric "${t.name}" in metrics.yaml. Run sl status to list the metrics.`);
      return { ref, kind: "metric", file, path: ["metrics", index], item: metrics[index]! };
    }
    case "model":
    case "field": {
      const file = paths(root).model(t.source, t.model);
      const model = readYamlIfExists<Model>(file);
      if (!model) throw new UserError(`No model "${t.model}" in source "${t.source}" (${file}). Run sl status to list the models.`);
      if (t.kind === "model") return { ref, kind: "model", file, path: [], item: obj(model), source: t.source, model };
      const match: FieldMatch | undefined = findField(model, t.field);
      if (!match) {
        const names = [...(model.dimensions ?? []), ...(model.measures ?? []), ...(model.joins ?? [])].map((f) => f.name);
        throw new UserError(`No dimension, measure or join "${t.field}" in ${t.source}.${t.model}. Known: ${names.join(", ") || "none"}. Check the spelling; sl add-field ${t.source}.${t.model} adds a new one.`);
      }
      const section = match.kind === "dimension" ? "dimensions" : match.kind === "measure" ? "measures" : "joins";
      return { ref, kind: match.kind, file, path: [section, match.index], item: obj(match.item), source: t.source, model };
    }
  }
}

// The map an item's path names in an edited document.
export function itemMap(doc: Document, path: (string | number)[]): YAMLMap {
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (!isMap(node)) throw new UserError(`Cannot edit ${path.join(".") || "the file"}: it is not a mapping.`);
  return node as YAMLMap;
}

function keyIndex(map: YAMLMap, key: string): number {
  return map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
}

// Sets `key` to a node. An existing key keeps its place; a new one goes after the first of `after`
// the map holds, else before the first of `before`, else at the end.
export function placeKey(doc: Document, map: YAMLMap, key: string, value: unknown, after: string[], before: string[] = []): void {
  const node = doc.createNode(value);
  const existing = keyIndex(map, key);
  if (existing >= 0) {
    map.items[existing]!.value = node;
    return;
  }
  const pair = doc.createPair(key, node);
  const a = after.map((k) => keyIndex(map, k)).find((i) => i >= 0);
  if (a !== undefined) return void map.items.splice(a + 1, 0, pair);
  const b = before.map((k) => keyIndex(map, k)).find((i) => i >= 0);
  if (b !== undefined) return void map.items.splice(b, 0, pair);
  map.items.push(pair);
}

// Text as one plain line: control characters and ANSI escapes removed and whitespace runs, line
// breaks included, folded to one space, so owner text cannot add YAML keys or comment lines.
export function oneLine(text: string): string {
  return plainText(text.replace(/[\r\n\t]+/g, " ")).replace(/\s+/g, " ").trim();
}

// A file's path relative to the semantic root, with forward slashes.
export function relFile(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

// Refuses a path that resolves outside the semantic root (a symlinked file or directory included).
function assertInside(root: string, file: string): void {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const r = real(root);
  const f = real(file);
  if (f !== r && !f.startsWith(r + sep)) throw new UserError(`Refusing to write ${file}: it resolves outside the semantic root ${root}.`);
}

function sourceDialect(root: string, source: string): Dialect | undefined {
  try {
    const d = readYamlIfExists<{ dialect?: string }>(paths(root).source(source))?.dialect;
    return typeof d === "string" && (DIALECTS as readonly string[]).includes(d) ? (d as Dialect) : undefined;
  } catch {
    return undefined;
  }
}

// Every approval entry of the project, reading each file in `overrides` as its text there (a model
// file only there counts as written) and leaving out the files in `removed`; files that cannot be
// read are skipped.
function projectEntries(root: string, overrides: ReadonlyMap<string, string>, removed: ReadonlySet<string> = new Set()): ApprovalEntry[] {
  const read = (p: string): unknown => {
    try {
      const text = overrides.get(p);
      return text === undefined ? readYamlIfExists<unknown>(p) : parseYamlText(text, p);
    } catch {
      return null;
    }
  };
  const layer: LayerModel[] = [];
  for (const source of listSourceNames(root)) {
    const dir = paths(root).modelsDir(source);
    if (!existsSync(dir)) continue;
    const models = new Map<string, Model>();
    const added = [...overrides.keys()].filter((p) => dirname(p) === dir).map((p) => basename(p));
    for (const f of [...new Set([...readdirSync(dir), ...added])].filter((x) => x.endsWith(".yaml") && !removed.has(join(dir, x))).sort()) {
      const m = read(join(dir, f));
      if (m && typeof m === "object") models.set(stem(f), m as Model);
    }
    const dialect = sourceDialect(root, source);
    for (const [name, m] of models) layer.push({ source, model: { ...m, model: name }, lookup: (n) => models.get(n), dialect });
  }
  const metrics = read(paths(root).metrics) as { metrics?: unknown } | null;
  return itemApprovals(listApprovals({ models: layer, metrics: metrics?.metrics, access: read(paths(root).access) }));
}

// The approved items whose content an edit changes, unless it restores the content their
// approved_hash records: each now needs a readback and a new approval. `renamed` maps an item's
// ref after the edit to its ref before, for an item the edit renames.
function changedApprovals(root: string, after: ReadonlyMap<string, string>, renamed?: ReadonlyMap<string, string>, removed?: ReadonlySet<string>): string[] {
  const was = new Map(projectEntries(root, new Map()).map((e) => [e.ref, e]));
  const out: string[] = [];
  for (const e of projectEntries(root, after, removed)) {
    const old = was.get(renamed?.get(e.ref) ?? e.ref);
    if (!old || old.hash === e.hash || e.item.status !== "approved") continue;
    if (!carriesHash(e.item) || String(e.item.approved_hash).trim() !== e.hash) out.push(e.ref);
  }
  return out.sort();
}

export interface EditOutcome {
  changed: boolean;
  // The edited file, relative to the semantic root.
  file: string;
  // Approved items whose content the edit changed.
  reapprove: string[];
}

// One file's edit; several for the same file run in order on one document.
export interface FileEdit {
  file: string;
  edit: (doc: Document) => void;
}

// A file the edits create or move. `create` maps a file that must not exist yet to the text its
// edits start from. `move` writes the edited text of `from` to `to`, which must not exist yet, and
// removes `from`.
// `warnings` collects the warnings the edits add (a file holding more of one than before, wherever
// it sits, since removing a list entry moves the paths after it); one that `refuse` matches stops
// the edit as an error does.
export interface CommitOptions {
  create?: ReadonlyMap<string, string>;
  move?: { from: string; to: string };
  warnings?: Issue[];
  refuse?: (warning: Issue) => boolean;
}

// Refuses a path where something already is: a file, or a link, even one to nothing.
function assertFree(root: string, file: string): void {
  try {
    lstatSync(file);
  } catch {
    return;
  }
  throw new UserError(`Refusing to write ${relFile(root, file)}: something is already there (a file, or a link). Nothing was written. Run sl validate.`);
}

export interface EditsOutcome {
  changed: boolean;
  // The files the edits changed, relative to the semantic root, sorted.
  files: string[];
  reapprove: string[];
}

// Applies edits to one or more files, validates the project as it would read all of them together
// and writes them only when they add no error: on any error nothing is written. An approved item the
// edits change is not an error here (sl validate reports it, and the result names it in `reapprove`).
// `guard` sees those items first and throws to refuse the edit. Edits that leave every text as it
// was write nothing.
export function commitEdits(
  root: string,
  edits: FileEdit[],
  what: string,
  guard?: (reapprove: string[]) => void,
  renamed?: ReadonlyMap<string, string>,
  opts: CommitOptions = {},
): EditsOutcome {
  const byFile = new Map<string, FileEdit["edit"][]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.edit]);
  const { create, move } = opts;
  if (move && !byFile.has(move.from)) byFile.set(move.from, []);
  const after = new Map<string, string>();
  const removed = new Set<string>();
  for (const [file, fns] of byFile) {
    const rel = relFile(root, file);
    assertInside(root, file);
    const seed = create?.get(file);
    if (seed !== undefined) assertFree(root, file);
    const before = seed ?? readFileSync(file, "utf8");
    const text = editYamlText(before, (doc) => fns.forEach((fn) => fn(doc)), rel);
    if (move?.from === file) {
      assertInside(root, move.to);
      assertFree(root, move.to);
      after.set(move.to, text);
      removed.add(file);
    } else if (text !== before || seed !== undefined) after.set(file, text);
  }
  if (!after.size) return { changed: false, files: [], reapprove: [] };
  const reapprove = changedApprovals(root, after, renamed, removed);
  guard?.(reapprove);
  const moves: [string, string][] = move ? [[relFile(root, move.from), relFile(root, move.to)]] : [];
  if (!batch?.deferred) {
    const added = blamed(addedIssues(validateProject(root, after, removed), () => validateProject(root), { moves, reapprove, warnings: opts.warnings, refuse: opts.refuse }));
    if (added.length) throw invalid(what, added);
  }
  if (batch) {
    // Inside sl apply: the batch validates once at its end and puts every file back on any failure.
    for (const file of [...after.keys(), ...removed]) batchWrite(file);
    batch.moves.push(...moves);
    for (const r of reapprove) batch.reapprove.add(r);
    if (opts.warnings) for (const file of after.keys()) batch.warningFiles.add(relFile(root, file));
    if (opts.refuse) batch.refuse.push(opts.refuse);
  }
  // A created or moved file is written only where nothing is, and the moved file is removed last.
  for (const [file, text] of after) writeFileAtomic(file, text, { exclusive: create?.has(file) || move?.to === file });
  for (const file of removed) unlinkSync(file);
  // Inside a batch the approved items it changed are listed once, at its end.
  return { changed: true, files: [...after.keys(), ...removed].map((f) => relFile(root, f)).sort(), reapprove: batch ? [] : reapprove };
}

function invalid(what: string, added: Issue[]): UserError {
  const lines = added.map((i) => `  - ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`);
  return new UserError(
    `Cannot ${what}: the result would not validate, so nothing was written:\n${lines.join("\n")}\nFix the value and run it again; sl validate lists the project's errors.`,
  );
}

interface AddedOptions {
  // Files the edits moved, from and to, relative to the root, in order.
  moves: [string, string][];
  // Approved items the edits changed: their "changed since it was approved" errors are expected.
  reapprove: Iterable<string>;
  warnings?: Issue[];
  refuse?: (warning: Issue) => boolean;
}

// The errors of `now` (the project as the edits leave it) that `before` (the project as it was) did
// not have, plus the warnings `refuse` matches among the warnings it adds; the other added warnings
// go to `warnings`. The project as it was is validated only when the edits leave an error, or a
// warning to sort, so an edit that leaves the project valid validates it once.
function addedIssues(now: Issue[], before: () => Issue[], o: AddedOptions): Issue[] {
  const reapprove = [...o.reapprove];
  const errors = now.filter((i) => i.level === "error" && !reapprove.some((r) => i.message.startsWith(`${r} changed since it was approved`)));
  const sortWarnings = !!o.warnings && now.some((i) => i.level === "warning");
  if (!errors.length && !sortWarnings) return [];
  // An error the project already has in a moved file counts as known in the file it moves to.
  const fileNow = (file: string) => o.moves.reduce((f, [from, to]) => (f === from ? to : f), file);
  const key = (i: Issue) => `${fileNow(i.file)}\0${i.path}\0${i.message}`;
  const was = before();
  const known = new Set(was.filter((i) => i.level === "error").map(key));
  const added = errors.filter((i) => !known.has(key(i)));
  if (sortWarnings) {
    const left = new Map<string, number>();
    const same = (i: Issue) => `${i.file}\0${i.message}`;
    for (const i of was) if (i.level === "warning") left.set(same(i), (left.get(same(i)) ?? 0) + 1);
    for (const i of now) {
      if (i.level !== "warning") continue;
      const n = left.get(same(i)) ?? 0;
      left.set(same(i), n - 1);
      if (n > 0) continue;
      if (o.refuse?.(i)) added.push(i);
      else o.warnings!.push(i);
    }
  }
  return added;
}

// A batch of typed edits (sl apply). While one is open, commitEdits writes each edit as it comes,
// keeping each file's text from before the batch's first write to it (null for a file the batch
// creates). In the deferred pass it skips each edit's validation, which the batch does once at its end.
interface Batch {
  deferred: boolean;
  originals: Map<string, string | null>;
  moves: [string, string][];
  reapprove: Set<string>;
  // The files of the edits that ask for the warnings they add (the access edits).
  warningFiles: Set<string>;
  refuse: ((warning: Issue) => boolean)[];
  // In the check pass: whether an error an edit adds is one the batch ends with.
  blame?: (issue: Issue) => boolean;
}

let batch: Batch | undefined;

// Whether an edit is inside a batch's deferred pass, so it leaves its validation to the batch's end;
// a writer outside commitEdits that validates checks this and records its file with batchWrite.
export function deferValidation(): boolean {
  return !!batch?.deferred;
}

// The errors an edit adds that count against it: inside a batch's check pass, only those the batch
// ends with, so an entry whose error a later entry fixes runs on.
export function blamed(added: Issue[]): Issue[] {
  return batch?.blame ? added.filter(batch.blame) : added;
}

// Records a file a writer is about to create, change or remove inside a batch.
export function batchWrite(file: string): void {
  if (batch && !batch.originals.has(file)) batch.originals.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
}

export interface BatchOutcome {
  // The approved items the batch changed, as its end leaves them.
  reapprove: string[];
  // The warnings the batch added in the files of the edits that ask for them (the access edits).
  warnings: Issue[];
  // Set when access.yaml was approved before the batch and its end leaves it a draft.
  access_draft?: { last_approved?: LastApproval };
}

function openBatch(deferred: boolean, blame?: Batch["blame"]): Batch {
  if (batch) throw new UserError("sl apply cannot run inside another sl apply.");
  batch = { deferred, originals: new Map(), moves: [], reapprove: new Set(), warningFiles: new Set(), refuse: [], blame };
  return batch;
}

// Runs `edits` as one batch: each typed edit inside writes as it goes, and at the end the project
// is validated once. On any failure every file the batch touched is put back as it was. When the end
// finds an error, the edits run once more, each validated as on its own, so the error thrown is the
// first edit that adds an error the batch ends with (`edits` names its entry); an edit whose error a
// later one fixes runs on. The files are put back after that pass too.
// `what` names the batch in an error no single edit explains.
export async function runBatch(root: string, what: string, edits: () => Promise<void>): Promise<BatchOutcome> {
  const open = openBatch(true);
  let added: Issue[];
  const warnings: Issue[] = [];
  try {
    await edits();
    const before = new Map([...open.originals].filter((e): e is [string, string] => e[1] !== null));
    const created = new Set([...open.originals].filter(([, t]) => t === null).map(([f]) => f));
    added = addedIssues(validateProject(root), () => validateProject(root, before, created), {
      moves: open.moves,
      reapprove: open.reapprove,
      warnings: open.warningFiles.size ? warnings : undefined,
      refuse: open.refuse.length ? (i) => open.refuse.some((r) => r(i)) : undefined,
    });
    if (!added.length) {
      const access_draft = accessDrafted(root, open.originals);
      return { reapprove: stillChanged(root, open.reapprove), warnings: warnings.filter((w) => open.warningFiles.has(w.file)), ...(access_draft ? { access_draft } : {}) };
    }
  } catch (e) {
    restore(open.originals);
    throw e;
  } finally {
    batch = undefined;
  }
  restore(open.originals);
  // An edit's error is keyed by the file it ends in after the batch's moves, its path and message.
  const fileAtEnd = (file: string) => open.moves.reduce((f, [from, to]) => (f === from ? to : f), file);
  const key = (i: Issue) => `${fileAtEnd(i.file)}\0${i.path}\0${i.message}`;
  const ends = new Set(added.map(key));
  const check = openBatch(false, (i) => ends.has(key(i)));
  try {
    await edits();
  } finally {
    batch = undefined;
    restore(check.originals);
  }
  throw invalid(what, added);
}

// What the batch left of an approved access.yaml it changed: a draft, with its last approval kept.
function accessDrafted(root: string, originals: ReadonlyMap<string, string | null>): { last_approved?: LastApproval } | undefined {
  const file = paths(root).access;
  const was = originals.get(file);
  if (!was || !existsSync(file)) return undefined;
  const read = (text: string): { status?: unknown; last_approved?: LastApproval } | null => {
    try {
      return parseYaml(text) as { status?: unknown; last_approved?: LastApproval } | null;
    } catch {
      return null;
    }
  };
  const now = read(readFileSync(file, "utf8"));
  if (read(was)?.status !== "approved" || now?.status === "approved") return undefined;
  return now?.last_approved ? { last_approved: now.last_approved } : {};
}

// Puts each file back as the batch found it: its text, or no file.
function restore(originals: ReadonlyMap<string, string | null>): void {
  for (const [file, text] of originals) {
    if (text !== null) writeFileAtomic(file, text);
    else if (existsSync(file)) unlinkSync(file);
  }
}

// Which of `refs` are approved items whose content no longer matches their approval.
function stillChanged(root: string, refs: Iterable<string>): string[] {
  const wanted = new Set(refs);
  if (!wanted.size) return [];
  return projectEntries(root, new Map())
    .filter((e) => wanted.has(e.ref) && e.item.status === "approved" && (!carriesHash(e.item) || String(e.item.approved_hash).trim() !== e.hash))
    .map((e) => e.ref)
    .sort();
}

// commitEdits for one file.
export function commitEdit(
  root: string,
  file: string,
  what: string,
  edit: (doc: Document) => void,
  guard?: (reapprove: string[]) => void,
): EditOutcome {
  const outcome = commitEdits(root, [{ file, edit }], what, guard);
  return { changed: outcome.changed, file: relFile(root, file), reapprove: outcome.reapprove };
}

// The lines that tell the agent an approved item changed and must be read back and approved again.
export function reapproveLines(refs: string[]): string[] {
  return refs.map(
    (r) =>
      `${r} is approved and changed since its approval: read it back to the owner as it now stands, and approve it again only on their yes ` +
      `(sl approve --target ${r} --by "<owner>").`,
  );
}

// Tools apply an approved item as it stands, so an edit that keeps it approved but loosens its
// protection (removes pii or sensitive, or adds public) would take effect before the owner reads
// it back. This guard refuses such an edit when it leaves `ref` changed since its approval; the
// item is revoked first, then approved again on the owner's yes.
export function protectionGuard(ref: string, before: string[], after: string[]): (reapprove: string[]) => void {
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const was = lower(before);
  const now = lower(after);
  const lost = PROTECTED_TAGS.filter((t) => was.has(t) && !now.has(t));
  const changes = [...(lost.length ? [`remove ${lost.join(" and ")} from`] : []), ...(now.has(PUBLIC_TAG) && !was.has(PUBLIC_TAG) ? ["add public to"] : [])];
  return (reapprove) => {
    if (!changes.length || !reapprove.includes(ref)) return;
    throw new UserError(
      `Cannot ${changes.join(" and ")} ${ref} while it is approved: tools apply the approved item, so everyone who may see it would see its values at once. ` +
        `Nothing was written. Revoke the approval first (sl approve --target ${ref} --revoke), run this again, then read the item back to the owner ` +
        `and approve it again only on their yes.`,
    );
  };
}

// Makes an approved access.yaml a draft in the edited document, as sl approve --target access
// --revoke writes it: status draft, approved_by and approved_at kept as last_approved where
// approved_by stood, approved_hash removed. Tools apply an approved file as it stands, so a typed
// edit of its rules is written as a draft and takes effect only once the owner approves it again.
// Returns undefined when the file is not approved, else the approval set aside (when it names both).
export function accessToDraft(doc: Document): { last_approved?: LastApproval } | undefined {
  const map = itemMap(doc, []);
  if (map.get("status") !== "approved") return undefined;
  const [by, at] = [map.get("approved_by"), map.get("approved_at")];
  const last = typeof by === "string" && by.trim() && typeof at === "string" && at.trim() ? { by, at } : undefined;
  const status = map.get("status", true);
  if (isScalar(status)) status.value = "draft";
  else map.set("status", "draft");
  if (last) {
    const node = doc.createNode(last);
    const existing = keyIndex(map, "last_approved");
    if (existing >= 0) map.items[existing]!.value = node;
    else map.items.splice(Math.max(keyIndex(map, "approved_by"), 0), 0, doc.createPair("last_approved", node));
  }
  for (const key of ["approved_by", "approved_at", "approved_hash"]) map.delete(key);
  return last ? { last_approved: last } : {};
}

// The lines that tell the agent a typed edit made an approved access.yaml a draft again.
export function accessDraftLines(set: { last_approved?: LastApproval }): string[] {
  const kept = set.last_approved
    ? `the version approved by ${set.last_approved.by} on ${set.last_approved.at} keeps applying where it is deployed (kept as last_approved); tell the owner so`
    : "tools serve nothing under it until it is approved";
  return [`access.yaml was approved, so this edit made it a draft again: ${kept}. Read it back with sl readback --targets access and approve it again only on the owner's yes.`];
}

export interface Prop {
  type?: string;
  enum?: unknown[];
}

// The keys the JSON Schema allows on an item of this kind.
export function schemaProperties(kind: ItemKind): Record<string, Prop> {
  const file = kind === "metric" ? "metrics" : kind === "access" ? "access" : "model";
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${file}.schema.json`), "utf8")) as {
    properties: Record<string, Prop>;
    $defs: Record<string, { properties: Record<string, Prop> }>;
  };
  return kind === "model" || kind === "access" ? schema.properties : schema.$defs[kind]!.properties;
}

// The value as written, trimmed: text for a key whose schema is text or a choice of words (so an expr keeps
// its quotes, colons and #), and YAML for every other key, so [a, b] is a list and true a boolean.
export function parseValue(key: string, raw: string, prop: Prop): unknown {
  const words = Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string");
  if (prop.type === "string" || words) return raw.trim();
  const value = parseYamlText(raw, `the value of ${key}`);
  if (prop.type === "array" && !Array.isArray(value)) throw new UserError(`${key} is a list: write it as [a, b], for example [${raw.trim()}].`);
  return value;
}

// What of the model reads `column`: its fields by kind and name, its join keys, its primary key and
// other models' joins to it, by the rules sl validate checks ignored_columns with.
export function readers(model: Model, column: string, others: Model[], dialect: string | undefined): string[] {
  const one: SnapshotTable = { schema: null, name: model.model, kind: "table", columns: [{ name: column, type: "" }] };
  const joinNames = (model.joins ?? []).map((j) => ({ ...j, keys: [] }));
  const reads = (m: Partial<Model>, extra: string[] = []) =>
    referencedColumns({ ...model, dimensions: [], measures: [], primary_key: [], ...m } as Model, one, dialect as never, extra).length > 0;
  const out: string[] = [];
  for (const d of model.dimensions ?? []) if (reads({ dimensions: [d], joins: joinNames })) out.push(`dimension ${d.name}`);
  for (const m of model.measures ?? []) if (reads({ measures: [m], joins: joinNames })) out.push(`measure ${m.name}`);
  for (const j of model.joins ?? []) if (reads({ joins: [j] })) out.push(`the keys of join ${j.name}`);
  if (reads({ joins: joinNames, primary_key: model.primary_key })) out.push("the primary key");
  if (reads({ joins: joinNames }, incomingKeyColumns(model, others))) out.push("a join from another model");
  return out;
}

// The columns of the model's own table one field reads: a join's key columns, or the columns of a
// dimension's or measure's expr and filter. With no snapshot table, only an expr that is one bare
// column counts.
export function fieldColumns(model: Model, kind: "dimension" | "measure" | "join", field: Record<string, unknown>, table: SnapshotTable | undefined, dialect?: Dialect): string[] {
  const spelled = (c: string) => table?.columns.find((x) => x.name === c)?.name ?? table?.columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.name;
  if (kind === "join") {
    const keys = (Array.isArray(field.keys) ? field.keys : []).map((k) => String((k as { from?: unknown })?.from ?? "").trim()).filter(Boolean);
    return [...new Set(keys.map((k) => (table ? spelled(k) : k)).filter((k): k is string => !!k))];
  }
  if (!table) {
    const expr = typeof field.expr === "string" ? field.expr.trim() : "";
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(expr) && !/^(true|false|null)$/i.test(expr) ? [expr] : [];
  }
  const only = { ...model, dimensions: kind === "dimension" ? [field] : [], measures: kind === "measure" ? [field] : [], primary_key: [] };
  const joins = (model.joins ?? []).map((j) => ({ ...j, keys: [] }));
  return referencedColumns({ ...only, joins } as unknown as Model, table, dialect);
}

// SQL tokens with their offsets, read the way tokenizeSql reads them (strings, comments and {{ }}
// placeholders are opaque), so a name can be replaced in place.
type PosToken = { t: "id"; v: string; quoted: boolean; start: number; end: number } | { t: "." | "(" | ":" | "x" };

function positionTokens(sql: string, dialect?: Dialect): PosToken[] {
  const backslash = dialect === "snowflake" || dialect === "bigquery" || dialect === "databricks";
  const doubleIsString = dialect === "bigquery" || dialect === "databricks";
  const stringEnd = (i: number, esc: boolean) => {
    const q = sql[i]!;
    for (i++; i < sql.length; i++) {
      if (esc && sql[i] === "\\") i++;
      else if (sql[i] === q && sql[i + 1] === q) i++;
      else if (sql[i] === q) break;
    }
    return i + 1;
  };
  // The offset just past `close`, searched from `from`, or the end of the text.
  const past = (close: string, from: number) => {
    const at = sql.indexOf(close, from);
    return at < 0 ? sql.length : at + close.length;
  };
  const out: PosToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? "";
    const rest = sql.slice(i);
    const dollar = c === "$" ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)?.[0] : undefined;
    let tok: PosToken | undefined = { t: "x" };
    if (/\s/.test(c)) {
      i++;
      tok = undefined;
    } else if (c === "'" || (c === '"' && doubleIsString)) i = stringEnd(i, backslash);
    else if ((c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) i = stringEnd(i + 1, true);
    else if (c === "-" && next === "-") {
      i = past("\n", i);
      tok = undefined;
    } else if (c === "/" && next === "*") {
      i = past("*/", i + 2);
      tok = undefined;
    } else if (c === "{" && next === "{") i = past("}}", i + 2);
    else if (dollar) i = past(dollar, i + dollar.length);
    else if (c === '"' || c === "`") {
      const start = i;
      let v = "";
      for (i++; i < sql.length; i++) {
        if (sql[i] === c && sql[i + 1] !== c) break;
        if (sql[i] === c) i++;
        v += sql[i];
      }
      i++;
      // A backtick path holding dots is left as it is.
      if (c !== "`" || !v.includes(".")) tok = { t: "id", v, quoted: true, start, end: i };
    } else if (/\d/.test(c) || (c === "." && /\d/.test(next))) i += /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(rest)![0].length;
    else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)![0];
      tok = { t: "id", v: word, quoted: false, start: i, end: i + word.length };
      i += word.length;
    } else if (c === ":" && next === ":") {
      i += 2;
      tok = { t: ":" };
    } else {
      i++;
      if (c === "." || c === "(" || c === ":") tok = { t: c };
    }
    if (tok) out.push(tok);
  }
  return out;
}

type Part = { v: string; quoted: boolean };

// A chain part names `name`: an unquoted part in any case, a quoted one exactly (as approval hashes read joins).
export function namesPart(part: Part, name: string): boolean {
  return part.quoted ? part.v === name : part.v.toLowerCase() === name;
}

// Replaces parts of the dotted names an SQL expression reads (as sqlNames finds them) with `to`:
// `pick` gives the indexes of the parts of a chain to replace. A quoted part stays quoted. Returns the
// new text and the number of chains changed; refuses a rewrite whose result sqlNames would read
// differently from the intended chains.
export function renameInSql(sql: string, dialect: Dialect | undefined, pick: (parts: Part[]) => number[], to: string): { text: string; hits: number } {
  const want = sqlNames(sql, dialect).chains.map((c) => {
    const at = new Set(pick(c.parts.map((v, k) => ({ v, quoted: c.quoted[k]! }))));
    return c.parts.map((p, k) => (at.has(k) ? to : p)).join(".");
  });
  const tokens = positionTokens(sql, dialect);
  const edits: { start: number; end: number; text: string }[] = [];
  let hits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]!;
    if (first.t !== "id") continue;
    const ids = [first];
    let j = i;
    while (tokens[j + 1]?.t === "." && tokens[j + 2]?.t === "id") (ids.push(tokens[j + 2] as typeof first), (j += 2));
    const prev = tokens[i - 1]?.t;
    const call = tokens[j + 1]?.t === "(";
    i = j;
    if (ids.length < 2 || call || prev === ":" || prev === ".") continue;
    const at = pick(ids);
    if (at.length) hits++;
    for (const k of at) edits.push({ start: ids[k]!.start, end: ids[k]!.end, text: ids[k]!.quoted ? `${sql[ids[k]!.start]}${to}${sql[ids[k]!.start]}` : to });
  }
  let text = sql;
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  const got = sqlNames(text, dialect).chains.map((c) => c.parts.join("."));
  if (got.join("\n") !== want.join("\n")) throw new UserError(`Cannot rewrite the join references in "${oneLine(sql)}" safely; edit it by hand and run sl validate.`);
  return { text, hits };
}

// A field or metric that other files name.
export type RefTarget = { kind: "dimension" | "measure" | "join"; source: string; model: string; name: string } | { kind: "metric"; name: string; source: string };

// One place that names a target: the file, the path of the scalar in it, its text, and with a new
// name, its text after a rename.
export interface RefSite {
  file: string;
  path: (string | number)[];
  from: string;
  to: string;
}

export function pathText(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
}

// Every place outside the target's own name that names it: join references in model exprs and
// filters (through the model's own join or a join to the target's model), metric measure
// references, golden requests, and access.yaml restriction targets, deny.fields and row filters.
// `conflicts` lists the access patterns that would make a list of access.yaml cover the new name
// differently from the old one, which a rename would silently change. With no new name, `to` equals `from`.
export function referenceSites(root: string, target: RefTarget, newName = target.name): { sites: RefSite[]; conflicts: string[] } {
  const sites: RefSite[] = [];
  const conflicts: string[] = [];
  const add = (file: string, path: (string | number)[], from: unknown, to: string) => {
    if (typeof from === "string") sites.push({ file, path, from, to });
  };
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const field = target.kind !== "metric" ? target : undefined;
  const dialect = sourceDialect(root, target.source);
  const models = new Map<string, Model>();
  if (field && existsSync(paths(root).modelsDir(field.source))) {
    for (const f of readdirSync(paths(root).modelsDir(field.source)).filter((x) => x.endsWith(".yaml")).sort()) {
      const m = readYamlIfExists<Model>(join(paths(root).modelsDir(field.source), f));
      if (m && typeof m === "object") models.set(stem(f), m);
    }
  }
  // Join references: in model `ctx`, <join>.<column> through the target join, or <join>.<join>.<column>
  // through a join to the target's model and then the target join.
  const pick = (ctx: string) => (parts: Part[]) => {
    if (field?.kind !== "join") return [];
    const at: number[] = [];
    if (ctx === field.model && namesPart(parts[0]!, field.name)) at.push(0);
    const hop = arr(models.get(ctx)?.joins).map(obj).find((j) => typeof j.name === "string" && namesPart(parts[0]!, j.name));
    if (parts.length >= 3 && hop?.to === field.model && namesPart(parts[1]!, field.name)) at.push(1);
    return at;
  };
  const sql = (file: string, path: (string | number)[], ctx: string, value: unknown) => {
    if (typeof value !== "string") return;
    const r = renameInSql(value, dialect, pick(ctx), newName);
    if (r.hits) add(file, path, value, r.text);
  };
  if (field?.kind === "join") {
    for (const [name, m] of models) {
      const file = paths(root).model(field.source, name);
      arr(m.dimensions).forEach((d, i) => sql(file, ["dimensions", i, "expr"], name, obj(d).expr));
      arr(m.measures).forEach((x, i) => {
        sql(file, ["measures", i, "expr"], name, obj(x).expr);
        sql(file, ["measures", i, "filter"], name, obj(x).filter);
      });
    }
  }
  if (field?.kind === "measure") {
    const file = paths(root).metrics;
    const ref = `${field.model}.${field.name}`;
    const to = `${field.model}.${newName}`;
    arr(readYamlIfExists<{ metrics?: unknown }>(file)?.metrics).forEach((raw, i) => {
      const m = obj(raw);
      if (m.source !== field.source) return;
      for (const k of ["numerator", "denominator"]) if (typeof m[k] === "string" && m[k].trim() === ref) add(file, ["metrics", i, k], m[k], to);
      if (typeof m.expr !== "string") return;
      let hits = 0;
      const text = m.expr.replace(/\{(\s*)([^}]*?)(\s*)\}/g, (all, a: string, inner: string, b: string) => (inner === ref ? (hits++, `{${a}${to}${b}}`) : all));
      if (hits) add(file, ["metrics", i, "expr"], m.expr, text);
    });
  }
  // Golden requests: model.field (with an optional :grain) in the request's source, or a metric's bare name.
  const dir = paths(root).goldensDir;
  const goldenFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort() : [];
  for (const f of goldenFiles) {
    const file = join(dir, f);
    let golden: Record<string, unknown>;
    try {
      golden = obj(readYamlIfExists<unknown>(file));
    } catch {
      continue;
    }
    const request = obj(golden.request);
    if (request.source !== target.source) continue;
    const check = (path: (string | number)[], value: unknown) => {
      if (typeof value !== "string") return;
      if (!field) return void (value.trim() === target.name && add(file, path, value, newName));
      const m = /^\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(:[a-z]+)?\s*$/.exec(value);
      if (m && m[1] === field.model && m[2] === field.name) add(file, path, value, `${field.model}.${newName}${m[3] ?? ""}`);
    };
    for (const key of ["measures", "dimensions"]) arr(request[key]).forEach((v, i) => check(["request", key, i], v));
    for (const key of ["filters", "order_by"]) arr(request[key]).forEach((v, i) => check(["request", key, i, "field"], obj(v).field));
  }
  // access.yaml, read as sl access reads it: a restriction target with the metric: prefix names a
  // metric (matched against its bare name), any other a model or field (source.model.field). An entry
  // that names the item exactly is renamed with it. A list (a restriction's targets, a role's
  // deny.fields) covers the item when any entry matches it; a rename that changes whether a list
  // covers it is a conflict, naming the entries that match one name and not the other.
  const accessFile = paths(root).access;
  const access = obj(readYamlIfExists<unknown>(accessFile));
  const oldSubject = field ? `${field.source}.${field.model}.${field.name}` : target.name;
  const newSubject = field ? `${field.source}.${field.model}.${newName}` : newName;
  const oldRef = field ? oldSubject : `metric:${oldSubject}`;
  const newRef = field ? newSubject : `metric:${newSubject}`;
  const matches = (p: string, subject: string) => {
    try {
      return matchesDotted(p, subject);
    } catch {
      return false;
    }
  };
  const patternList = (base: (string | number)[], raw: unknown, prefixed: boolean) => {
    const entries: [(string | number)[], unknown][] = prefixed && typeof raw === "string" ? [[base, raw]] : arr(raw).map((t, k) => [[...base, k], t]);
    let before = false;
    let after = false;
    const odd: string[] = [];
    for (const [path, t] of entries) {
      if (typeof t !== "string") continue;
      const isMetric = prefixed && t.startsWith("metric:");
      if (isMetric !== !field) continue;
      const p = isMetric ? t.slice(7) : t;
      if (!p.startsWith("re:") && !/[*?]/.test(p) && p.toLowerCase() === oldSubject) {
        add(accessFile, path, t, newRef);
        before = after = true;
        continue;
      }
      const b = matches(p, oldSubject);
      const a = matches(p, newSubject);
      before ||= b;
      after ||= a;
      if (b !== a) odd.push(`access.yaml ${pathText(path)}: ${t} matches ${b ? oldRef : newRef} but not ${b ? newRef : oldRef}`);
    }
    if (before !== after) conflicts.push(...odd);
  };
  arr(access.restrictions).forEach((r, i) => patternList(["restrictions", i, "targets"], obj(r).targets, true));
  arr(access.roles).forEach((raw, i) => {
    const role = obj(raw);
    if (field) patternList(["roles", i, "deny", "fields"], obj(role.deny).fields, false);
    if (field?.kind !== "join") return;
    arr(role.row_filters).forEach((rf, k) => {
      const f = obj(rf);
      const m = typeof f.model === "string" ? /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(f.model.trim()) : null;
      if (!m || m[1] !== field.source) return;
      sql(accessFile, ["roles", i, "row_filters", k, "expr"], m[2]!, f.expr);
      sql(accessFile, ["roles", i, "row_filters", k, "hierarchy", "column"], m[2]!, obj(f.hierarchy).column);
    });
  });
  return { sites, conflicts };
}

// The edits that write each site's new text, one per file.
export function siteEdits(sites: RefSite[]): FileEdit[] {
  return sites.map((s) => ({
    file: s.file,
    edit: (doc: Document) => {
      const node = doc.getIn(s.path, true);
      if (!isScalar(node)) throw new UserError(`Cannot edit ${pathText(s.path)}: it is not a single value.`);
      node.value = s.to;
    },
  }));
}

// A line naming the model's open questions that start "<field>: " (as sl question add writes a
// field's), which an edit that renames or removes the field leaves as they are; none, an empty list.
export function questionLines(model: Model | undefined, field: string, file: string): string[] {
  const n = (Array.isArray(model?.open_questions) ? model.open_questions : []).filter((q) => String(q).startsWith(`${field}: `)).length;
  return n ? [`${n} open question${n === 1 ? "" : "s"} in ${file} still start${n === 1 ? "s" : ""} with "${field}: "; edit ${n === 1 ? "it" : "them"} there if ${n === 1 ? "it is" : "they are"} about this field.`] : [];
}

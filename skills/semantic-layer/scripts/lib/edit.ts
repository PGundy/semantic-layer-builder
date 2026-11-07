// Typed edits: the shared steps of sl set, sl tag, sl ignore-column, sl question, sl add-field,
// sl remove-field and sl rename. An edit changes YAML files through editYamlText, so the owner's
// comments and every untouched byte survive; the result is validated as the project would read it,
// and it is written only when it adds no error.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import { accessEntry, carriesHash, metricEntries, modelEntries, type ApprovalEntry } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { plainText } from "./output.ts";
import { listSourceNames, paths, stem } from "./project.ts";
import { findField, type FieldMatch, parseTarget } from "./refs.ts";
import { DIALECTS, type Dialect, type Model, PROTECTED_TAGS, PUBLIC_TAG, type SnapshotTable } from "./types.ts";
import { matchesDotted } from "./patterns.ts";
import { incomingKeyColumns, referencedColumns } from "./snapshot-diff.ts";
import { sqlNames } from "./sql-names.ts";
import { SCHEMAS_DIR, validateProject } from "./validate.ts";
import { editYamlText, parseYamlText, readYamlIfExists } from "./yaml.ts";

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

// Every approval entry of the project, reading each file in `overrides` as its text there; files
// that cannot be read are skipped.
function projectEntries(root: string, overrides: ReadonlyMap<string, string>): ApprovalEntry[] {
  const read = (p: string): unknown => {
    try {
      const text = overrides.get(p);
      return text === undefined ? readYamlIfExists<unknown>(p) : parseYamlText(text, p);
    } catch {
      return null;
    }
  };
  const out: ApprovalEntry[] = [];
  for (const source of listSourceNames(root)) {
    const dir = paths(root).modelsDir(source);
    if (!existsSync(dir)) continue;
    const models = new Map<string, Model>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort()) {
      const m = read(join(dir, f));
      if (m && typeof m === "object") models.set(stem(f), m as Model);
    }
    const dialect = sourceDialect(root, source);
    for (const [name, m] of models) out.push(...modelEntries(source, { ...m, model: name }, (n) => models.get(n), dialect));
  }
  const metrics = read(paths(root).metrics) as { metrics?: unknown } | null;
  out.push(...metricEntries(metrics?.metrics));
  const access = accessEntry(read(paths(root).access));
  if (access) out.push(access);
  return out;
}

// The approved items whose content an edit changes, unless it restores the content their
// approved_hash records: each now needs a readback and a new approval. `renamed` maps an item's
// ref after the edit to its ref before, for an item the edit renames.
function changedApprovals(root: string, after: ReadonlyMap<string, string>, renamed?: ReadonlyMap<string, string>): string[] {
  const was = new Map(projectEntries(root, new Map()).map((e) => [e.ref, e]));
  const out: string[] = [];
  for (const e of projectEntries(root, after)) {
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
): EditsOutcome {
  const byFile = new Map<string, FileEdit["edit"][]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.edit]);
  const after = new Map<string, string>();
  for (const [file, fns] of byFile) {
    const rel = relFile(root, file);
    assertInside(root, file);
    const before = readFileSync(file, "utf8");
    const text = editYamlText(before, (doc) => fns.forEach((fn) => fn(doc)), rel);
    if (text !== before) after.set(file, text);
  }
  if (!after.size) return { changed: false, files: [], reapprove: [] };
  const reapprove = changedApprovals(root, after, renamed);
  guard?.(reapprove);
  const key = (i: { file: string; path: string; message: string }) => `${i.file}\0${i.path}\0${i.message}`;
  const known = new Set(validateProject(root).filter((i) => i.level === "error").map(key));
  const added = validateProject(root, after).filter(
    (i) => i.level === "error" && !known.has(key(i)) && !reapprove.some((r) => i.message.startsWith(`${r} changed since it was approved`)),
  );
  if (added.length) {
    const lines = added.map((i) => `  - ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`);
    throw new UserError(
      `Cannot ${what}: the result would not validate, so nothing was written:\n${lines.join("\n")}\nFix the value and run it again; sl validate lists the project's errors.`,
    );
  }
  for (const [file, text] of after) writeFileSync(file, text);
  return { changed: true, files: [...after.keys()].map((f) => relFile(root, f)).sort(), reapprove };
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

// Refuses an edit to an approved access.yaml: tools apply it as it stands, so access.yaml is edited
// as a draft (see Draft and approved access files).
export function accessGuard(what: string): (reapprove: string[]) => void {
  return (reapprove) => {
    if (!reapprove.includes("access")) return;
    throw new UserError(
      `Cannot ${what} while access.yaml is approved: tools apply the approved file, so the change would take effect before the owner reads it back. ` +
        `Nothing was written. Revoke it first (sl approve --target access --revoke; the approved version keeps applying where it is deployed), ` +
        `run this again, read it back with sl access and approve it again only on the owner's yes.`,
    );
  };
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

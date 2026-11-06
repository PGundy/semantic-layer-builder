// Typed edits: the shared steps of sl set, sl tag, sl ignore-column and sl question. An edit changes
// one YAML file through editYamlText, so the owner's comments and every untouched byte survive; the
// result is validated as the project would read it, and it is written only when it adds no error.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import { accessEntry, carriesHash, metricEntries, modelEntries, type ApprovalEntry } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { plainText } from "./output.ts";
import { listSourceNames, paths, stem } from "./project.ts";
import { findField, type FieldMatch, parseTarget } from "./refs.ts";
import { DIALECTS, type Dialect, type Model, PROTECTED_TAGS, PUBLIC_TAG } from "./types.ts";
import { validateProject } from "./validate.ts";
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
      if (!access) throw new UserError(`No access.yaml at ${file}. Ask the owner the exceptions question first (sl status names it).`);
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
        throw new UserError(`No dimension, measure or join "${t.field}" in ${t.source}.${t.model}. Known: ${names.join(", ") || "none"}.`);
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

// Every approval entry of the project, reading `file` as `text`; files that cannot be read are skipped.
function projectEntries(root: string, file: string, text: string): ApprovalEntry[] {
  const read = (p: string): unknown => {
    try {
      if (p === file) return parseYamlText(text, p);
      return readYamlIfExists<unknown>(p);
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
// approved_hash records: each now needs a readback and a new approval.
function changedApprovals(root: string, file: string, before: string, after: string): string[] {
  const was = new Map(projectEntries(root, file, before).map((e) => [e.ref, e]));
  const out: string[] = [];
  for (const e of projectEntries(root, file, after)) {
    const old = was.get(e.ref);
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

// Applies `edit` to `file`, validates the project as it would read the result and writes it only
// when it adds no error. An approved item the edit changes is not an error here (sl validate
// reports it, and the result names it in `reapprove`). `guard` sees those items first and throws
// to refuse the edit. An edit that leaves the text as it was writes nothing.
export function commitEdit(
  root: string,
  file: string,
  what: string,
  edit: (doc: Document) => void,
  guard?: (reapprove: string[]) => void,
): EditOutcome {
  const rel = relFile(root, file);
  assertInside(root, file);
  const before = readFileSync(file, "utf8");
  const after = editYamlText(before, edit, rel);
  if (after === before) return { changed: false, file: rel, reapprove: [] };
  const reapprove = changedApprovals(root, file, before, after);
  guard?.(reapprove);
  const key = (i: { file: string; path: string; message: string }) => `${i.file}\0${i.path}\0${i.message}`;
  const known = new Set(validateProject(root).filter((i) => i.level === "error").map(key));
  const added = validateProject(root, new Map([[file, after]])).filter(
    (i) => i.level === "error" && !known.has(key(i)) && !reapprove.some((r) => i.message.startsWith(`${r} changed since it was approved`)),
  );
  if (added.length) {
    const lines = added.map((i) => `  - ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`);
    throw new UserError(
      `Cannot ${what}: the result would not validate, so nothing was written:\n${lines.join("\n")}\nFix the value and run it again; sl validate lists the project's errors.`,
    );
  }
  writeFileSync(file, after);
  return { changed: true, file: rel, reapprove };
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

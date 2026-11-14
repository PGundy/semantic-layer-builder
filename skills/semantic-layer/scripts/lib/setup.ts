// The pieces of sl setup (spec: Setup): the source file brought to the state the flags describe,
// edited in place so the owner's comments survive, what changed, and the scope preview.
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Document, isMap, isScalar, isSeq, type YAMLMap } from "yaml";
import { qualifiedName, toSpecName } from "./naming.ts";
import { filterInScope, unmatchedPatterns } from "./patterns.ts";
import type { Scope, Snapshot } from "./types.ts";

// The project name for a new project: the semantic root's directory name, or its parent's when
// the root is the usual `semantic`, as a spec name.
export function projectName(root: string): string {
  const abs = resolve(root);
  const base = basename(abs);
  return toSpecName(base === "semantic" ? basename(dirname(abs)) : base);
}

// The keys sl setup writes, in the order a new file has them. A missing key is inserted after the
// keys that come before it, so an edited file keeps the shape of a new one.
const ORDER: Record<string, string[]> = {
  "": ["source", "dialect", "description", "connection", "intake", "scope"],
  connection: ["env", "env_prefix", "database", "setup", "views"],
  intake: ["mode", "reason", "schemas", "export"],
  scope: ["include", "exclude", "tables_file"],
};

// Sets `key` of `map` to `value` (undefined removes it), touching nothing when the value is already
// there. A list is synced item by item and a map key by key, so unchanged items keep their comments.
function setKey(doc: Document, map: YAMLMap, key: string, value: unknown, order: string[]): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  const node = map.get(key, true);
  if (node !== undefined && isDeepStrictEqual(isScalar(node) ? node.value : (node as { toJSON(): unknown }).toJSON(), value)) return;
  if (Array.isArray(value) && isSeq(node) && value.length) {
    const wanted = value.map(String);
    for (let i = node.items.length - 1; i >= 0; i--) {
      const item = node.items[i];
      const v = isScalar(item) ? String(item.value) : undefined;
      if (v === undefined || !wanted.includes(v) || node.items.findIndex((x) => isScalar(x) && String(x.value) === v) !== i) node.items.splice(i, 1);
    }
    const present = node.items.map((x) => (isScalar(x) ? String(x.value) : ""));
    for (const v of wanted) if (!present.includes(v)) node.items.push(doc.createNode(v));
    return;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && isMap(node)) {
    const obj = value as Record<string, unknown>;
    for (const k of node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key))) if (!(k in obj)) node.delete(k);
    for (const [k, v] of Object.entries(obj)) setKey(doc, node, k, v, Object.keys(obj));
    return;
  }
  if (node !== undefined) {
    // A scalar keeps its node, so a comment on its line stays.
    if (isScalar(node) && (value === null || typeof value !== "object")) node.value = value;
    else map.set(key, doc.createNode(value));
    return;
  }
  const at = order.indexOf(key);
  const before = order.slice(0, Math.max(at, 0));
  let index = 0;
  map.items.forEach((p, i) => {
    if (before.includes(String(isScalar(p.key) ? p.key.value : p.key))) index = i + 1;
  });
  if (at < 0) index = map.items.length;
  map.items.splice(index, 0, doc.createPair(key, value));
}

// The parts of a source file sl setup decides. A key left undefined is left as the file has it;
// a scope or a views map, when given, replaces the file's.
export interface SourceState {
  env?: string;
  // connection.env_prefix; given, it replaces connection.env, as env replaces it.
  envPrefix?: string;
  database?: string;
  views?: Record<string, string>;
  mode: "connection" | "export";
  reason?: string;
  schemas?: string[];
  exportFile?: string;
  scope?: Scope;
}

// Brings a parsed source file to `state`.
export function applySourceState(doc: Document, state: SourceState): void {
  const root = doc.contents as YAMLMap;
  const section = (key: string): YAMLMap => {
    const node = root.get(key, true);
    if (isMap(node)) return node;
    setKey(doc, root, key, {}, ORDER[""]!);
    return root.get(key, true) as unknown as YAMLMap;
  };
  const prune = (key: string) => {
    const node = root.get(key, true);
    if (isMap(node) && !node.items.length) root.delete(key);
  };
  const conn = section("connection");
  if (state.env !== undefined) {
    setKey(doc, conn, "env", state.env, ORDER.connection!);
    setKey(doc, conn, "env_prefix", undefined, ORDER.connection!);
  }
  if (state.envPrefix !== undefined) {
    setKey(doc, conn, "env_prefix", state.envPrefix, ORDER.connection!);
    setKey(doc, conn, "env", undefined, ORDER.connection!);
  }
  if (state.database !== undefined) setKey(doc, conn, "database", state.database, ORDER.connection!);
  if (state.views !== undefined) setKey(doc, conn, "views", state.views, ORDER.connection!);
  prune("connection");
  const intake = section("intake");
  setKey(doc, intake, "mode", state.mode, ORDER.intake!);
  if (state.mode === "export") {
    if (state.reason !== undefined) setKey(doc, intake, "reason", state.reason, ORDER.intake!);
    setKey(doc, intake, "export", { file: state.exportFile }, ORDER.intake!);
  }
  if (state.schemas !== undefined) setKey(doc, intake, "schemas", state.schemas.length ? state.schemas : undefined, ORDER.intake!);
  if (state.scope !== undefined) {
    const scope = section("scope");
    setKey(doc, scope, "include", state.scope.include?.length ? state.scope.include : undefined, ORDER.scope!);
    setKey(doc, scope, "exclude", state.scope.exclude?.length ? state.scope.exclude : undefined, ORDER.scope!);
    setKey(doc, scope, "tables_file", state.scope.tables_file, ORDER.scope!);
    prune("scope");
  }
}

// The identity of a scope pattern, as sl scope compares them: a glob matches case-insensitively,
// so it compares lowercased; a re: body or a "quoted" part matches case included, so it stays exact.
export function patternKey(p: string): string {
  return p.startsWith("re:") || p.includes('"') ? p : p.toLowerCase();
}

export interface ListChange {
  added: string[];
  removed: string[];
}

export function listChange(before: readonly string[] | undefined, after: readonly string[] | undefined): ListChange {
  const b = before ?? [];
  const a = after ?? [];
  return { added: a.filter((x) => !b.includes(x)), removed: b.filter((x) => !a.includes(x)) };
}

export interface ScopePreview {
  include: string[];
  exclude: string[];
  tables_file: string | null;
  total: number;
  in_scope: number;
  by_schema: { schema: string | null; in_scope: number; total: number }[];
  tables: { table: string; rows: number | null }[];
  added: string[];
  removed: string[];
  unmatched_patterns: string[];
  needs_focus: boolean;
  focus_threshold: number;
}

// The in-scope tables of `snapshot` under `effective` (the scope with its table-list file joined),
// by schema, and the tables that entered or left scope since `before` (null when there was none).
export function scopePreview(scope: Scope | undefined, effective: Scope, snapshot: Snapshot, before: string[] | null, threshold: number): ScopePreview {
  const tables = [...snapshot.tables].sort((a, b) => (qualifiedName(a) < qualifiedName(b) ? -1 : qualifiedName(a) > qualifiedName(b) ? 1 : 0));
  const selected = filterInScope(effective, tables);
  const names = selected.map(qualifiedName);
  const bySchema = new Map<string | null, { in_scope: number; total: number }>();
  for (const t of tables) {
    const k = t.schema ?? null;
    const row = bySchema.get(k) ?? { in_scope: 0, total: 0 };
    row.total++;
    bySchema.set(k, row);
  }
  for (const t of selected) bySchema.get(t.schema ?? null)!.in_scope++;
  const prev = before ?? [];
  const now = new Set(names);
  const was = new Set(prev);
  return {
    include: scope?.include ?? [],
    exclude: scope?.exclude ?? [],
    tables_file: scope?.tables_file ?? null,
    total: tables.length,
    in_scope: selected.length,
    by_schema: [...bySchema].map(([schema, v]) => ({ schema, ...v })),
    tables: selected.map((t) => ({ table: qualifiedName(t), rows: typeof t.row_count === "number" ? t.row_count : null })),
    added: before === null ? [] : names.filter((n) => !was.has(n)),
    removed: prev.filter((n) => !now.has(n)),
    unmatched_patterns: unmatchedPatterns(effective, tables),
    needs_focus: selected.length > threshold,
    focus_threshold: threshold,
  };
}

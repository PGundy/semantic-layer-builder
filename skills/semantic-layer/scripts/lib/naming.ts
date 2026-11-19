import type { SnapshotTable } from "./types.ts";

export function qualifiedName(table: { schema?: string | null; name: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function splitQualified(name: string): { schema: string | null; name: string } {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? { schema: null, name } : { schema: name.slice(0, dot), name: name.slice(dot + 1) };
}

interface TableIndex {
  size: number;
  // The first table of each lower-case qualified name, and every table of each lower-case bare name.
  qualified: Map<string, SnapshotTable>;
  bare: Map<string, SnapshotTable[]>;
}

// One index per list of tables, built on its first lookup and built again when the list's length
// changes; a list whose entries are replaced in place keeps its length, so such a list is not looked up here.
const indexes = new WeakMap<readonly SnapshotTable[], TableIndex>();

function tableIndex(tables: readonly SnapshotTable[]): TableIndex {
  const known = indexes.get(tables);
  if (known && known.size === tables.length) return known;
  const index: TableIndex = { size: tables.length, qualified: new Map(), bare: new Map() };
  for (const t of tables) {
    const q = qualifiedName(t).toLowerCase();
    if (!index.qualified.has(q)) index.qualified.set(q, t);
    const b = t.name.toLowerCase();
    const list = index.bare.get(b);
    if (list) list.push(t);
    else index.bare.set(b, [t]);
  }
  indexes.set(tables, index);
  return index;
}

// Finds a snapshot table by qualified name, or by bare name when that is unambiguous.
export function findTable(tables: readonly SnapshotTable[], ref: string): SnapshotTable | undefined {
  const lower = ref.toLowerCase();
  const index = tableIndex(tables);
  const exact = index.qualified.get(lower);
  if (exact) return exact;
  if (ref.includes(".")) return undefined;
  const byName = index.bare.get(lower) ?? [];
  return byName.length === 1 ? byName[0] : undefined;
}

// Turns any identifier into a valid spec name: lowercase, [a-z0-9_], starting with a letter.
export function toSpecName(raw: string): string {
  let s = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!/^[a-z]/.test(s)) s = `t_${s}`;
  return s || "unnamed";
}

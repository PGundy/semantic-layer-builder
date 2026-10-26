import type { SnapshotTable } from "./types.ts";

export function qualifiedName(table: { schema?: string | null; name: string }): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function splitQualified(name: string): { schema: string | null; name: string } {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? { schema: null, name } : { schema: name.slice(0, dot), name: name.slice(dot + 1) };
}

// Finds a snapshot table by qualified name, or by bare name when that is unambiguous.
export function findTable(tables: SnapshotTable[], ref: string): SnapshotTable | undefined {
  const lower = ref.toLowerCase();
  const exact = tables.find((t) => qualifiedName(t).toLowerCase() === lower);
  if (exact) return exact;
  if (ref.includes(".")) return undefined;
  const byName = tables.filter((t) => t.name.toLowerCase() === lower);
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

// Turns the rows of an introspection plan (lib/sql/introspection.ts) into a snapshot,
// carrying over what earlier runs learned that a catalog read cannot see again.
import type {
  ForeignKey,
  PlanResults,
  ResultRows,
  Snapshot,
  SnapshotColumn,
  SnapshotTable,
  SourceConfig,
  TableKind,
} from "./types.ts";

type Row = Record<string, unknown>;

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function description(v: unknown): string | null {
  const s = text(v)?.trim();
  return s ? s : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

// Normalizes is_nullable: a boolean, YES/NO, Y/N or true/false.
export function nullable(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = text(v)?.trim().toLowerCase();
  if (s === undefined || s === null) return null;
  if (["yes", "y", "true", "t", "1"].includes(s)) return true;
  if (["no", "n", "false", "f", "0"].includes(s)) return false;
  return null;
}

function kind(v: unknown): TableKind {
  const s = text(v)?.toLowerCase();
  return s === "view" || s === "external" ? s : "table";
}

function rowCount(v: unknown): number | null {
  const n = num(v);
  return n === null || n < 0 ? null : Math.round(n);
}

function key(schema: string | null, name: string): string {
  return `${schema ?? ""}\u0000${name}`;
}

function tableKey(r: Row): string | null {
  const name = text(r.table_name);
  return name === null ? null : key(text(r.table_schema), name);
}

function byOrdinal(a: Row, b: Row): number {
  return (num(a.ordinal_position) ?? 0) - (num(b.ordinal_position) ?? 0);
}

function rows(results: PlanResults, id: string): ResultRows {
  return results[id] ?? [];
}

// Drops repeated key rows for the same column, keeping the first in key order.
function distinctColumns(list: Row[]): Row[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const name = text(r.column_name)!;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function sameType(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Builds a live snapshot from introspection results. From `previous` it keeps each
// column's profile while the column exists with the same type (and the table's
// profiled_at when no column is new and no profile was dropped), descriptions and row counts the new read
// leaves null, unique keys over columns that still exist, and the keys of a dialect
// whose plan has no primary_keys or foreign_keys query.
export function buildSnapshot(source: SourceConfig, results: PlanResults, capturedAt: string, previous: Snapshot | null): Snapshot {
  const tables = new Map<string, SnapshotTable>();
  const ensure = (schema: string | null, name: string): SnapshotTable => {
    const k = key(schema, name);
    let t = tables.get(k);
    if (!t) {
      t = { schema, name, kind: "table", row_count: null, description: null, primary_key: [], unique_keys: [], foreign_keys: [], columns: [] };
      tables.set(k, t);
    }
    return t;
  };

  for (const r of rows(results, "tables")) {
    const name = text(r.table_name);
    if (name === null) continue;
    const t = ensure(text(r.table_schema), name);
    t.kind = kind(r.table_kind);
    t.row_count = t.kind === "view" ? null : rowCount(r.row_count);
    t.description = description(r.description);
  }

  const columnRows = new Map<string, Row[]>();
  for (const r of rows(results, "columns")) {
    const k = tableKey(r);
    if (k === null || text(r.column_name) === null) continue;
    ensure(text(r.table_schema), text(r.table_name)!);
    const list = columnRows.get(k) ?? [];
    list.push(r);
    columnRows.set(k, list);
  }
  for (const [k, list] of columnRows) {
    const t = tables.get(k)!;
    const seen = new Set<string>();
    for (const r of [...list].sort(byOrdinal)) {
      const name = text(r.column_name)!;
      if (seen.has(name)) continue;
      seen.add(name);
      t.columns.push({ name, type: text(r.data_type) ?? "unknown", nullable: nullable(r.is_nullable), description: description(r.description) });
    }
  }

  const pkRows = new Map<string, Row[]>();
  for (const r of rows(results, "primary_keys")) {
    const k = tableKey(r);
    if (k === null || !tables.has(k) || text(r.column_name) === null) continue;
    pkRows.set(k, [...(pkRows.get(k) ?? []), r]);
  }
  for (const [k, list] of pkRows) tables.get(k)!.primary_key = distinctColumns(list.sort(byOrdinal)).map((r) => text(r.column_name)!);

  // Rows group by constraint name. A row without one belongs to an unnamed key on
  // the same referenced table; ordinal position 1 (or a position that does not
  // follow the last one) starts the next such key.
  const fkRows = new Map<string, Map<string, Row[]>>();
  const unnamed = new Map<string, { n: number; last: number }>();
  for (const r of rows(results, "foreign_keys")) {
    const k = tableKey(r);
    if (k === null || !tables.has(k) || text(r.column_name) === null || text(r.ref_table) === null || text(r.ref_column) === null) continue;
    const byConstraint = fkRows.get(k) ?? new Map<string, Row[]>();
    let c = text(r.constraint_name);
    if (c === null) {
      const ref = `${k}\u0000${text(r.ref_schema) ?? ""}.${text(r.ref_table)}`;
      const pos = num(r.ordinal_position) ?? 1;
      const run = unnamed.get(ref) ?? { n: 0, last: Number.POSITIVE_INFINITY };
      if (pos <= 1 || pos <= run.last) run.n++;
      run.last = pos;
      unnamed.set(ref, run);
      c = `\u0000${text(r.ref_schema) ?? ""}.${text(r.ref_table)}#${String(run.n).padStart(6, "0")}`;
    }
    byConstraint.set(c, [...(byConstraint.get(c) ?? []), r]);
    fkRows.set(k, byConstraint);
  }
  for (const [k, byConstraint] of fkRows) {
    const fks: ForeignKey[] = [];
    for (const c of [...byConstraint.keys()].sort()) {
      const list = distinctColumns(byConstraint.get(c)!.sort(byOrdinal));
      const first = list[0]!;
      fks.push({
        columns: list.map((r) => text(r.column_name)!),
        references: { schema: text(first.ref_schema), table: text(first.ref_table)!, columns: list.map((r) => text(r.ref_column)!) },
      });
    }
    const distinct = new Map(fks.map((fk) => [JSON.stringify(fk), fk]));
    tables.get(k)!.foreign_keys = [...distinct.values()];
  }

  const keepKeys = { primary: results.primary_keys === undefined, foreign: results.foreign_keys === undefined };
  if (previous) mergePrevious(tables, previous, keepKeys);

  const out = [...tables.values()].sort((a, b) => `${a.schema ?? ""}.${a.name}`.localeCompare(`${b.schema ?? ""}.${b.name}`));
  return { snapshot_version: 1, source: source.source, dialect: source.dialect, captured_at: capturedAt, method: "live", tables: out };
}

function mergePrevious(tables: Map<string, SnapshotTable>, previous: Snapshot, keepKeys: { primary: boolean; foreign: boolean }): void {
  const prevByKey = new Map(previous.tables.map((t) => [key(t.schema, t.name), t]));
  for (const [k, t] of tables) {
    const prev = prevByKey.get(k);
    if (!prev) continue;
    const prevCols = new Map(prev.columns.map((c) => [c.name, c]));
    const names = new Set(t.columns.map((c) => c.name));
    // Columns a profile run would still need to read: new ones and retyped ones.
    let unprofiled = 0;
    t.columns = t.columns.map((c): SnapshotColumn => {
      const p = prevCols.get(c.name);
      if (!p) {
        unprofiled++;
        return c;
      }
      const merged: SnapshotColumn = { ...c, description: c.description ?? p.description ?? null };
      if (!sameType(p.type, c.type)) unprofiled++;
      else if (p.profile) merged.profile = p.profile;
      return merged;
    });
    t.description = t.description ?? prev.description ?? null;
    if ((t.row_count === null || t.row_count === undefined) && t.kind !== "view") t.row_count = prev.row_count ?? null;
    if (prev.profiled_at && unprofiled === 0) t.profiled_at = prev.profiled_at;
    const covered = (cols: string[]) => cols.length > 0 && cols.every((c) => names.has(c));
    t.unique_keys = (prev.unique_keys ?? []).filter(covered);
    if (keepKeys.primary && !t.primary_key?.length && prev.primary_key && covered(prev.primary_key)) t.primary_key = prev.primary_key;
    if (keepKeys.foreign && !t.foreign_keys?.length) t.foreign_keys = (prev.foreign_keys ?? []).filter((fk) => covered(fk.columns));
  }
}

export function snapshotCounts(snapshot: Snapshot): { tables: number; columns: number; primary_keys: number; foreign_keys: number } {
  let columns = 0;
  let primary = 0;
  let foreign = 0;
  for (const t of snapshot.tables) {
    columns += t.columns.length;
    if (t.primary_key?.length) primary++;
    foreign += t.foreign_keys?.length ?? 0;
  }
  return { tables: snapshot.tables.length, columns, primary_keys: primary, foreign_keys: foreign };
}

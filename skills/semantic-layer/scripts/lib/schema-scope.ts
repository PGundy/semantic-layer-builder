// Schema scope (spec: Schema scope): the one schema a first layer reads and joins within, and the
// declared foreign keys that leave a table's own schema.
import { intakeSchemas } from "./intake.ts";
import type { ForeignKey, Snapshot, SnapshotTable, SourceConfig } from "./types.ts";

// The source's primary schema: intake.primary when set; else the only entry of intake.schemas; else,
// with no schema list, the only schema of the snapshot's tables. With more than one candidate there
// is none: the tools never guess.
export function primarySchema(source: Pick<SourceConfig, "intake" | "source">, snapshot?: Pick<Snapshot, "tables"> | null): string | undefined {
  const explicit = source.intake?.primary;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const listed = intakeSchemas(source);
  if (listed.length) return listed.length === 1 ? listed[0] : undefined;
  const seen = new Set((snapshot?.tables ?? []).map((t) => t.schema).filter((s): s is string => typeof s === "string" && s !== ""));
  return seen.size === 1 ? [...seen][0] : undefined;
}

// The schema a foreign key points into: its own, or the table's when the key names none.
export function referencedSchema(table: Pick<SnapshotTable, "schema">, fk: ForeignKey): string | null {
  return fk.references.schema ?? table.schema;
}

// True when a declared foreign key points into another schema than its table's.
export function crossesSchema(table: Pick<SnapshotTable, "schema">, fk: ForeignKey): boolean {
  return referencedSchema(table, fk) !== table.schema;
}

export interface CrossSchemaFk {
  table: SnapshotTable;
  fk: ForeignKey;
  from_schema: string | null;
  to_schema: string | null;
}

// Every declared foreign key of the snapshot that points into another schema than its table's, in
// snapshot order.
export function crossSchemaFks(snapshot: Pick<Snapshot, "tables">): CrossSchemaFk[] {
  const out: CrossSchemaFk[] = [];
  for (const table of snapshot.tables) {
    for (const fk of table.foreign_keys ?? []) {
      if (crossesSchema(table, fk)) out.push({ table, fk, from_schema: table.schema, to_schema: referencedSchema(table, fk) });
    }
  }
  return out;
}

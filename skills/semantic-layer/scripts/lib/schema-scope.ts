// Schema scope (spec: Schema scope): the one schema a first layer reads and joins within, and the
// declared foreign keys that leave a table's own schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./errors.ts";
import { intakeSchemas } from "./intake.ts";
import { findTable } from "./naming.ts";
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

// Declared schema pairs (spec: Schema scope, Schema pairs): `cross_schema` in sources/<s>.yaml. A pair
// runs from the schema holding the foreign key to the schema it references, and lists the key
// relationships that connect them, each a column of a table in `from` and one of a table in `to`
// (`<table>.<column>`), with the constraint it came from when it came from one. A join either way
// between those tables, on those keys, is allowed once the pair is approved. A declined pair records
// the owner's no.
export type PairStatus = "draft" | "approved" | "declined";

export interface PairKey {
  from: string;
  to: string;
  constraint?: string;
}

export interface CrossSchemaPair {
  from: string;
  to: string;
  status: PairStatus;
  keys?: PairKey[];
  reply?: string;
  declined_at?: string;
  approved_by?: string;
  approved_at?: string;
  approved_hash?: string;
}

// The tool version from which an approved join across an undeclared pair is an error rather than a
// warning: the next minor version after 0.1.0, the version this check was added in (decision 8).
export const UNDECLARED_GRACE_ENDS = "0.2.0";

// The tool's version, from the plugin manifest beside the skill; undefined when it cannot be read.
let version: { value: string | undefined } | undefined;

export function toolVersion(): string | undefined {
  version ??= { value: readVersion() };
  return version.value;
}

function readVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

// The level of an approved join across an undeclared pair at a tool version: a warning before
// UNDECLARED_GRACE_ENDS, an error from it on, and an error when the version is unknown.
export function undeclaredApprovedLevel(version: string | undefined): "warning" | "error" {
  const parse = (v: string) => v.split(".").slice(0, 2).map((n) => Number.parseInt(n, 10));
  if (!version) return "error";
  const [major, minor] = parse(version);
  const [endMajor, endMinor] = parse(UNDECLARED_GRACE_ENDS);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return "error";
  return major! < endMajor! || (major === endMajor && minor! < endMinor!) ? "warning" : "error";
}

// The source's pairs, leaving out entries that are not objects with a from and a to.
export function crossSchemaPairs(source: Pick<SourceConfig, "cross_schema">): CrossSchemaPair[] {
  const raw: unknown = source.cross_schema;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is CrossSchemaPair => !!p && typeof p === "object" && typeof p.from === "string" && typeof p.to === "string");
}

// The pair between two schemas, declared either way; the first when several are.
export function findPair(pairs: readonly CrossSchemaPair[], a: string, b: string): CrossSchemaPair | undefined {
  return pairs.find((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a));
}

// An approved pair carries the fields semlayer approve stamps on it.
export function pairApproved(pair: CrossSchemaPair | undefined): boolean {
  return pair?.status === "approved" && typeof pair.approved_by === "string" && typeof pair.approved_at === "string";
}

// Whether the owner has answered the question a key between the pair's schemas asks: declined or approved.
export function pairAnswered(pair: CrossSchemaPair | undefined): boolean {
  return pair?.status === "declined" || pairApproved(pair);
}

// `<table>.<column>`, split at its last dot.
export function splitKeyEnd(end: string): { table: string; column: string } | undefined {
  const dot = end.lastIndexOf(".");
  if (dot <= 0 || dot === end.length - 1) return undefined;
  return { table: end.slice(0, dot), column: end.slice(dot + 1) };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface SchemaJoin {
  fromSchema: string;
  fromTable: string;
  toSchema: string;
  toTable: string;
  keys: readonly { from: string; to: string }[];
}

// Whether a join between tables of two schemas is allowed: an approved pair between the schemas
// declares every key of the join, in either direction. A join within one schema always is.
export function pairAllowed(pairs: readonly CrossSchemaPair[], join: SchemaJoin): boolean {
  if (join.fromSchema === join.toSchema) return true;
  const pair = findPair(pairs, join.fromSchema, join.toSchema);
  if (!pairApproved(pair) || !join.keys.length) return false;
  const forward = pair!.from === join.fromSchema;
  const declared = (pair!.keys ?? []).map((k) => ({ from: splitKeyEnd(k.from), to: splitKeyEnd(k.to) }));
  return join.keys.every((jk) => {
    const near = { table: join.fromTable, column: jk.from };
    const far = { table: join.toTable, column: jk.to };
    const [f, t] = forward ? [near, far] : [far, near];
    return declared.some((d) => d.from && d.to && same(d.from.table, f.table) && same(d.from.column, f.column) && same(d.to.table, t.table) && same(d.to.column, t.column));
  });
}

// The join between the tables two models read, as the snapshot places them; undefined when the
// snapshot lacks either table or its schema, so nothing is known about the schemas it joins.
export function schemaJoin(snapshot: Pick<Snapshot, "tables"> | null | undefined, nearTable: string, farTable: string, keys: readonly { from: string; to: string }[]): SchemaJoin | undefined {
  if (!snapshot || !Array.isArray(snapshot.tables)) return undefined;
  const near = findTable(snapshot.tables, nearTable);
  const far = findTable(snapshot.tables, farTable);
  if (!near || !far || typeof near.schema !== "string" || typeof far.schema !== "string") return undefined;
  return { fromSchema: near.schema, fromTable: near.name, toSchema: far.schema, toTable: far.name, keys };
}

// How a join across schemas stands: undefined when it stays in one schema or an approved pair
// declares its keys; else an error, or a warning for an approved join until UNDECLARED_GRACE_ENDS.
// validate, add-join, check-join and the compiler all decide by it.
export function crossSchemaLevel(pairs: readonly CrossSchemaPair[], join: SchemaJoin, joinStatus: unknown): "warning" | "error" | undefined {
  if (pairAllowed(pairs, join)) return undefined;
  return joinStatus === "approved" && undeclaredApprovedLevel(toolVersion()) === "warning" ? "warning" : "error";
}

// What is wrong with a join across an undeclared pair, in the words every check uses.
export function undeclaredJoinText(join: SchemaJoin): string {
  return `joins ${join.fromSchema}.${join.fromTable} to ${join.toSchema}.${join.toTable} across schemas, and no approved schema pair declares these keys`;
}

// The join as the pair between its schemas runs, when one is declared the other way round.
export function pairOriented(pairs: readonly CrossSchemaPair[], join: SchemaJoin): SchemaJoin {
  if (findPair(pairs, join.fromSchema, join.toSchema)?.from !== join.toSchema) return join;
  return { fromSchema: join.toSchema, fromTable: join.toTable, toSchema: join.fromSchema, toTable: join.fromTable, keys: join.keys.map((k) => ({ from: k.to, to: k.from })) };
}

// The command that records the pair a join across schemas needs, with the join's keys, in the
// direction of the pair already declared between the schemas when there is one.
export function addPairCommand(source: string, join: SchemaJoin, pairs: readonly CrossSchemaPair[] = []): string {
  const j = pairOriented(pairs, join);
  const keys = j.keys.map((k) => `${j.fromTable}.${k.from}=${j.toTable}.${k.to}`).join(",");
  return `semlayer add-cross-schema --source ${source} --from ${j.fromSchema} --to ${j.toSchema} --keys ${keys}`;
}

// The refusal of a command that would add or measure a join across an undeclared pair (add-join,
// check-join): what joins which schemas, the pair to record, and the command to run once it is
// approved. Its code is scope.cross_schema_undeclared.
export function undeclaredPairError(what: string, source: string, join: SchemaJoin, pairs: readonly CrossSchemaPair[], then: string): UserError {
  const record = addPairCommand(source, join, pairs);
  const pair = pairOriented(pairs, join);
  return new UserError(
    `${what} ${undeclaredJoinText(join)}. Nothing was written. Ask the owner whether the layer joins these schemas; ` +
      `if yes, record the pair with ${record}, read it back and approve it on their yes ` +
      `(semlayer approve --target schema-pair:${source}:${pair.fromSchema}:${pair.toSchema}), then ${then}.`,
    record,
    "scope.cross_schema_undeclared",
  );
}

// What is wrong with one key of a pair against the snapshot: a table missing from its schema, a
// column missing from its table, or a constraint that is no foreign key of the from table into the
// to schema. Undefined when the key is in the snapshot.
export function keyProblem(snapshot: Pick<Snapshot, "tables">, pair: Pick<CrossSchemaPair, "from" | "to">, key: PairKey): string | undefined {
  const ends: [string, string][] = [
    [key.from, pair.from],
    [key.to, pair.to],
  ];
  const tables: SnapshotTable[] = [];
  for (const [end, schema] of ends) {
    const parts = splitKeyEnd(end);
    if (!parts) return `"${end}" is not <table>.<column>`;
    const table = snapshot.tables.find((t) => t.schema === schema && same(t.name, parts.table));
    if (!table) return `the snapshot has no table ${schema}.${parts.table}`;
    if (!table.columns.some((c) => same(c.name, parts.column))) return `${schema}.${table.name} has no column ${parts.column} in the snapshot`;
    tables.push(table);
  }
  if (key.constraint !== undefined) {
    const fk = (tables[0]!.foreign_keys ?? []).find((k) => k.constraint === key.constraint);
    if (!fk || referencedSchema(tables[0]!, fk) !== pair.to) return `${pair.from}.${tables[0]!.name} has no foreign key ${key.constraint} into ${pair.to} in the snapshot`;
  }
  return undefined;
}

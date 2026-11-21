// Schema scope (spec: Schema scope): the one schema a first layer reads and joins within, and the
// declared foreign keys that leave a table's own schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ApprovalLedger, backed, itemHash, pairEntries } from "./approval-hash.ts";
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

// The source's pairs as tools that use them read them: an approved pair that no recorded yes of the
// owner backs (approval-hash.ts backed) is a draft, as every other approved item is. Without a
// ledger reading, the pairs as written.
export function backedPairs(source: Pick<SourceConfig, "source" | "cross_schema">, ledger: ApprovalLedger | undefined): CrossSchemaPair[] {
  const pairs = crossSchemaPairs(source);
  if (!ledger) return pairs;
  const entries = pairEntries(source.source, { cross_schema: pairs });
  return pairs.map((p, i) => (p.status === "approved" && !backed(ledger, entries[i]!) ? { ...p, status: "draft" } : p));
}

// The pair between two schemas, declared either way; the first when several are.
export function findPair(pairs: readonly CrossSchemaPair[], a: string, b: string): CrossSchemaPair | undefined {
  return pairs.find((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a));
}

// The one definition of an approved pair, which validate, the join commands, the compiler and draft
// all read: it carries the fields semlayer approve stamps on it, and its approved_hash is the hash of
// its from, to and keys as they stand (approval-hash.ts). A key added or changed by hand, or a stamp
// written by hand without its hash, leaves the pair a draft.
export function pairApproved(pair: CrossSchemaPair | undefined): boolean {
  if (pair?.status !== "approved" || typeof pair.approved_by !== "string" || typeof pair.approved_at !== "string") return false;
  return typeof pair.approved_hash === "string" && pair.approved_hash === itemHash("schema-pair", pair as unknown as Record<string, unknown>);
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

// The schemas of the snapshot's tables in scope (`inScope`, every table when omitted): those
// intake.schemas lists, in its order, then the rest by name. A table with no schema counts for none.
export function schemasRead(
  source: Pick<SourceConfig, "intake" | "source">,
  snapshot: Pick<Snapshot, "tables"> | null | undefined,
  inScope: (t: SnapshotTable) => boolean = () => true,
): string[] {
  const seen = new Set((snapshot?.tables ?? []).filter(inScope).map((t) => t.schema).filter((s): s is string => typeof s === "string" && s !== ""));
  let listed: string[] = [];
  try {
    listed = intakeSchemas(source);
  } catch {
    // A malformed list is reported by the intake checks.
  }
  return [...listed.filter((s) => seen.has(s)), ...[...seen].filter((s) => !listed.includes(s)).sort()];
}

// Whether the source keeps a first layer to its primary schema: the schema question and draft's
// refusal and default are designed for postgres only, so a source of another dialect drafts as before.
export function keepsToPrimary(source: Pick<SourceConfig, "dialect">): boolean {
  return source.dialect === "postgres";
}

// intake.primary as written, trimmed; undefined when the source names none.
export function explicitPrimary(source: Pick<SourceConfig, "intake">): string | undefined {
  const p = source.intake?.primary;
  return typeof p === "string" && p.trim() ? p.trim() : undefined;
}

// The schema question (spec: Schema scope, The schema question): asked once the snapshot's tables in
// scope are in more than one schema, while intake.primary is unset, or while a declared foreign key of
// such a table between the primary schema and another of those schemas has no approved or declined pair.
export interface SchemaQuestion {
  source: string;
  // The schemas read, the primary first.
  schemas: string[];
  // intake.primary, or, while it is unset, the schema the question proposes: the first intake.schemas
  // lists, else the first by name. It is only proposed; nothing records it until the owner answers.
  primary: string;
  primary_set: boolean;
  others: string[];
  // The foreign keys between the primary schema and another schema read that no pair answers.
  keys: { from: string; to: string; table: string; columns: string[]; references: string; constraint: string | null; draft: boolean }[];
  // The semlayer setup that writes intake.primary, with the source's connection flags.
  setup: string[];
}

export function schemaQuestion(
  source: SourceConfig,
  snapshot: Pick<Snapshot, "tables"> | null | undefined,
  inScope: (t: SnapshotTable) => boolean = () => true,
): SchemaQuestion | undefined {
  if (!keepsToPrimary(source)) return undefined;
  const read = schemasRead(source, snapshot, inScope);
  if (read.length < 2) return undefined;
  const explicit = explicitPrimary(source);
  const primary = explicit ?? read[0]!;
  const pairs = crossSchemaPairs(source);
  const keys = crossSchemaFks({ tables: snapshot!.tables.filter(inScope) })
    .filter((x) => x.from_schema !== null && x.to_schema !== null && read.includes(x.from_schema) && read.includes(x.to_schema))
    .filter((x) => (x.from_schema === primary || x.to_schema === primary) && !pairAnswered(findPair(pairs, x.from_schema!, x.to_schema!)))
    .map((x) => ({
      from: x.from_schema!,
      to: x.to_schema!,
      table: `${x.from_schema}.${x.table.name}`,
      columns: x.fk.columns,
      references: `${x.to_schema}.${x.fk.references.table}`,
      constraint: x.fk.constraint ?? null,
      draft: findPair(pairs, x.from_schema!, x.to_schema!) !== undefined,
    }));
  if (explicit !== undefined && !keys.length) return undefined;
  return {
    source: source.source,
    schemas: [primary, ...read.filter((s) => s !== primary)],
    primary,
    primary_set: explicit !== undefined,
    others: read.filter((s) => s !== primary),
    keys,
    setup: ["--source", source.source, "--dialect", source.dialect, ...connectionArgs(source)],
  };
}

// The flags semlayer setup takes again to update an existing source: its connection as written.
function connectionArgs(source: SourceConfig): string[] {
  const c = source.connection ?? {};
  if (source.intake?.mode === "export") return ["--export", "<export file>"];
  if (c.env) return ["--env", c.env];
  if (c.env_prefix) return ["--env-prefix", c.env_prefix];
  if (source.dialect === "duckdb") {
    const views = Object.entries(c.views ?? {}).flatMap(([k, v]) => ["--view", `${k}=${v}`]);
    return [...(c.database ? ["--database", c.database] : []), ...views];
  }
  return ["--env", "<VAR>"];
}

const words = (items: string[], last: string) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`);

// The question as the owner hears it.
export function schemaQuestionText(q: SchemaQuestion): string {
  const others = words(q.others, "or");
  return (
    `Your data sits in more than one schema (${q.schemas.join(", ")}). Is ${q.primary} enough for your questions? ` +
    `If you also need ${others}, tell me which ${q.primary} tables relate to which ${others} tables, and by which columns.`
  );
}

// One answer the owner can give, and the commands that record it, in order.
export interface SchemaAnswer {
  answer: string;
  commands: string[];
}

// The answers to the schema question: keep to the primary (setup --primary, then a declined pair for
// each pair of schemas a foreign key leaves unanswered); also join the other schemas (the pair of
// each such key, or one the owner names, read back for their yes); or another schema as the primary.
export function schemaAnswers(q: SchemaQuestion): SchemaAnswer[] {
  const setup = (schema: string) => ["semlayer", "setup", ...q.setup, "--primary", schema].join(" ");
  const first = q.primary_set ? [] : [setup(q.primary)];
  const add = `semlayer add-cross-schema --source ${q.source}`;
  const declared = [...new Map(q.keys.map((k) => [`${k.from}\u0000${k.to}`, k])).values()];
  const keep = declared.map((k) => `${add} --from ${k.from} --to ${k.to} --decline --reply "<the owner's words>"`);
  const join = q.keys.map((k) =>
    k.constraint !== null
      ? `${add} --from ${k.from} --to ${k.to} --constraint ${k.constraint}`
      : `${add} --from ${k.from} --to ${k.to} --keys ${k.table.slice(k.from.length + 1)}.${k.columns[0]}=${k.references.slice(k.to.length + 1)}.<column>`,
  );
  const named = q.others.filter((s) => !declared.some((k) => k.from === s || k.to === s));
  for (const s of named) join.push(`${add} --from ${q.primary} --to ${s} --keys <${q.primary} table>.<column>=<${s} table>.<column>`);
  const pairs = [...declared.map((k) => [k.from, k.to] as const), ...named.map((s) => [q.primary, s] as const)];
  const readback = `semlayer readback --targets ${pairs.map(([f, t]) => `schema-pair:${q.source}:${f}:${t}`).join(",")}`;
  const out: SchemaAnswer[] = [
    { answer: `No, keep to ${q.primary}`, commands: [...first, ...keep] },
    { answer: `Yes, I also need ${words(q.others, "and")}`, commands: [...first, ...join, readback] },
  ];
  if (!q.primary_set) out.push({ answer: "Another schema holds what my questions are about", commands: [setup("<schema>")] });
  return out;
}

// The step that asks it: semlayer setup --primary while intake.primary is unset, else the declined
// pair of the first key no pair answers. Both wait on the owner's answer.
// A pair the owner said yes to and that still waits for its readback is not asked again: the step
// is that readback, so no step that follows it declines what the owner just asked for.
export function schemaQuestionArgs(q: SchemaQuestion): { command: string; args: string[]; kind: "run" | "ask_owner" } {
  if (!q.primary_set) return { command: "setup", args: [...q.setup, "--primary", q.primary], kind: "ask_owner" };
  const d = q.keys.find((x) => x.draft);
  if (d) return { command: "readback", args: ["--targets", `schema-pair:${q.source}:${d.from}:${d.to}`], kind: "run" };
  const k = q.keys[0]!;
  return { kind: "ask_owner", command: "add-cross-schema", args: ["--source", q.source, "--from", k.from, "--to", k.to, "--decline", "--reply", "<the owner's words>"] };
}

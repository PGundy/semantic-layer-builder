// Turns profile query results into snapshot column profiles, reads the facts
// the skill uses from a profiled table, and keeps raw values of protected
// columns out of the snapshot.
import { createHash } from "node:crypto";
import { classifyType, isNumeric, isTemporal } from "./column-types.ts";
import { UserError } from "./errors.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { sensitivityOf } from "./sensitivity.ts";
import { referencedColumns } from "./snapshot-diff.ts";
import { approximateDistinct, hasMinMax, hasTopValues, statsQueryId, topQueryId } from "./sql/profile.ts";
import type {
  ColumnProfile,
  Dialect,
  Dimension,
  Join,
  Measure,
  Model,
  PlanResults,
  QueryPlan,
  Scalar,
  Snapshot,
  SnapshotColumn,
  SnapshotTable,
  TopValue,
} from "./types.ts";
import { PROTECTED_TAGS, PUBLIC_TAG } from "./types.ts";
import { sqlNames } from "./validate.ts";

// Columns with at most this many distinct values count as low-cardinality.
export const LOW_CARDINALITY_MAX = 20;
// Relative slack for candidate keys when counts are sampled or approximate.
export const KEY_TOLERANCE = 0.01;

function toCount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.round(Number(v));
  return null;
}

// Six significant digits: any fraction above zero stays above zero.
function fraction(part: number, whole: number): number {
  return Number((part / whole).toPrecision(6));
}

// A min or max read back from its text cast: numbers for numeric columns, text
// otherwise. A numeric column keeps the text form for a value no JavaScript
// number holds exactly (Postgres money such as "$1.50", integers beyond 2^53),
// so one column can carry a number for min and text for max.
function bound(v: unknown, column: SnapshotColumn): Scalar {
  if (v === null || v === undefined) return null;
  const text = String(v);
  const category = classifyType(column.type);
  if (isNumeric(category)) {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) return text;
    if (category === "integer" && !Number.isSafeInteger(n)) return text;
    return n;
  }
  return text;
}

function topValue(v: unknown, column: SnapshotColumn): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const text = String(v);
  if (classifyType(column.type) === "boolean") {
    const lower = text.toLowerCase();
    if (lower === "true" || lower === "t" || lower === "1") return true;
    if (lower === "false" || lower === "f" || lower === "0") return false;
  }
  return text;
}

function profileTable(
  table: SnapshotTable,
  plan: Set<string>,
  results: PlanResults,
  profiledAt: string,
  usedSample: boolean,
): SnapshotTable {
  const statsId = statsQueryId(table);
  const rows = results[statsId];
  if (!rows || rows.length !== 1) throw new UserError(`Results for "${statsId}" must hold exactly one row, got ${rows?.length ?? 0}.`);
  const row = rows[0]!;
  const rowCount = toCount(row.row_count);
  if (rowCount === null) throw new UserError(`Results for "${statsId}" have no numeric row_count.`);
  let measured = rowCount;
  if (usedSample) {
    const sampleCount = toCount(row.sample_count);
    if (sampleCount === null) throw new UserError(`Results for "${statsId}" have no numeric sample_count; the query reads a sample.`);
    measured = sampleCount;
  }
  const sampled = usedSample && measured < rowCount;
  const boolean = (col: SnapshotColumn): boolean => classifyType(col.type) === "boolean";

  const columns = table.columns.map((col, i): SnapshotColumn => {
    const nulls = toCount(row[`c${i}_nulls`]);
    const nonNull = nulls === null ? measured : Math.max(0, measured - nulls);
    let distinct = toCount(row[`c${i}_distinct`]);
    if (distinct !== null) {
      distinct = Math.min(distinct, nonNull);
      // A sample with more than LOW_CARDINALITY_MAX non-null values, nearly all
      // distinct, stands for a column that is distinct throughout, so its count
      // scales to the full table. Booleans and sparse samples keep their own count.
      if (sampled && !boolean(col) && nonNull > LOW_CARDINALITY_MAX && distinct >= nonNull * (1 - KEY_TOLERANCE)) {
        distinct = Math.min(rowCount, Math.round((distinct * rowCount) / measured));
      }
    }
    const profile: ColumnProfile = {
      null_fraction: nulls === null || measured === 0 ? null : fraction(nulls, measured),
      distinct_count: distinct,
      min: hasMinMax(col) ? bound(row[`c${i}_min`], col) : null,
      max: hasMinMax(col) ? bound(row[`c${i}_max`], col) : null,
    };
    const topId = topQueryId(table, col.name);
    if (hasTopValues(col) && plan.has(topId)) {
      profile.top_values = (results[topId] ?? []).map(
        (r): TopValue => ({ value: topValue(r.value, col), count: toCount(r.n) ?? 0 }),
      );
    }
    profile.sampled = sampled;
    return { ...col, profile };
  });

  return { ...table, row_count: rowCount, profiled_at: profiledAt, columns };
}

// Writes the results of a profile plan into the snapshot's tables. `sampled`
// names the tables whose statistics query read a sample.
export function applyProfile(
  snapshot: Snapshot,
  plan: QueryPlan,
  results: PlanResults,
  profiledAt: string,
  sampled: Iterable<string>,
): Snapshot {
  const ids = new Set(plan.queries.map((q) => q.id));
  const sampledSet = new Set(sampled);
  return {
    ...snapshot,
    tables: snapshot.tables.map((t) =>
      ids.has(statsQueryId(t)) ? profileTable(t, ids, results, profiledAt, sampledSet.has(qualifiedName(t))) : t,
    ),
  };
}

export interface TableSummary {
  candidate_keys: string[];
  low_cardinality: string[];
}

// Candidate keys have no nulls and one distinct value per row (within 1% when the
// profile was sampled or the dialect's distinct counts are approximate).
// Low-cardinality columns have 1 to 20 distinct values and are not candidate keys.
export function summarizeTable(table: SnapshotTable, dialect?: Dialect): TableSummary {
  const approximate = dialect ? approximateDistinct(dialect) : false;
  const rowCount = table.row_count ?? null;
  const candidate_keys: string[] = [];
  const low_cardinality: string[] = [];
  for (const col of table.columns) {
    const p = col.profile;
    const distinct = p?.distinct_count;
    if (!p || distinct === null || distinct === undefined) continue;
    let key = false;
    const keyType = ((c) => c === "integer" || c === "string")(classifyType(col.type));
    if (keyType && rowCount !== null && rowCount > 0 && p.null_fraction === 0) {
      key = p.sampled || approximate ? Math.abs(distinct - rowCount) <= rowCount * KEY_TOLERANCE : distinct === rowCount;
    }
    if (key) candidate_keys.push(col.name);
    // A column unique on every row is not low-cardinality, whatever its type.
    else if (distinct > 0 && distinct <= LOW_CARDINALITY_MAX && !(rowCount !== null && distinct === rowCount && p.null_fraction === 0))
      low_cardinality.push(col.name);
  }
  return { candidate_keys, low_cardinality };
}

// Protected columns ------------------------------------------------------------

// The stored form of a value of a protected column: "sha256:" and the first 16 hex characters of
// the SHA-256 of its text, lowercased and trimmed.
export function hashValue(text: string): string {
  return `sha256:${createHash("sha256").update(text.toLowerCase().trim()).digest("hex").slice(0, 16)}`;
}

const HASHED_VALUE = /^sha256:[0-9a-f]{16}$/;

export function isHashedValue(v: unknown): v is string {
  return typeof v === "string" && HASHED_VALUE.test(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function hasProtectedTag(tags: unknown): boolean {
  return stringList(tags).some((t) => (PROTECTED_TAGS as readonly string[]).includes(t.toLowerCase()));
}

function objects(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

// The columns of a source's tables whose raw values the snapshot never holds, as column names by
// qualified table name. A column is protected when a model over its table is tagged pii or
// sensitive, when a pii- or sensitive-tagged field of such a model reads it (its own columns, and
// the columns its join references <join>.<column> and <join>.<join>.<column> read on the joined
// models' tables), when a model lists it in ignored_columns and no untagged field of an untagged
// model over the same table reads it, or when sensitivityOf flags it and it is not read only by
// fields tagged public (the owner's record that everyone may see it).
// `models` are the source's model files as read; entries without the expected shape are skipped.
export function protectedColumns(tables: SnapshotTable[], models: unknown[], dialect?: Dialect): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const mark = (table: SnapshotTable, name: string) => {
    const col = table.columns.find((c) => c.name === name) ?? table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!col) return;
    const q = qualifiedName(table);
    const set = out.get(q) ?? new Set<string>();
    set.add(col.name);
    out.set(q, set);
  };
  const list = models.filter((m): m is Model => isRecord(m) && typeof m.model === "string" && typeof m.table === "string");
  const byName = new Map(list.map((m) => [m.model, m]));
  const tableOf = (m: Model | undefined) => (m ? findTable(tables, m.table) : undefined);
  const joinNamed = (m: Model | undefined, name: string) =>
    objects(m?.joins).find((j) => typeof j.name === "string" && j.name.toLowerCase() === name.toLowerCase()) as Join | undefined;

  // Key columns per table, which sensitivityOf's near-unique rule skips.
  const keys = new Map<string, Set<string>>();
  const addKey = (table: SnapshotTable | undefined, name: unknown) => {
    if (!table || typeof name !== "string") return;
    const q = qualifiedName(table);
    const set = keys.get(q) ?? new Set<string>();
    set.add(name.toLowerCase());
    keys.set(q, set);
  };
  for (const t of tables) for (const k of t.primary_key ?? []) addKey(t, k);
  for (const m of list) {
    const t = tableOf(m);
    for (const k of stringList(m.primary_key)) addKey(t, k);
    for (const j of objects(m.joins)) {
      const target = typeof j.to === "string" ? tableOf(byName.get(j.to)) : undefined;
      for (const k of objects(j.keys)) {
        addKey(t, k.from);
        addKey(target, k.to);
      }
    }
  }

  // Who reads each column of its own table: untagged fields of untagged models read it openly;
  // public-tagged fields record that everyone may see it.
  const readers = new Map<string, { open: boolean; publicOnly: boolean }>();
  const ignored: [SnapshotTable, string][] = [];
  const read = (t: SnapshotTable, col: string, open: boolean, isPublic: boolean) => {
    const k = `${qualifiedName(t)}\u0000${col.toLowerCase()}`;
    const r = readers.get(k) ?? { open: false, publicOnly: true };
    r.open ||= open;
    r.publicOnly &&= isPublic;
    readers.set(k, r);
  };
  const readerOf = (t: SnapshotTable, col: string) => readers.get(`${qualifiedName(t)}\u0000${col.toLowerCase()}`);

  for (const m of list) {
    const t = tableOf(m);
    if (!t) continue;
    for (const c of stringList(m.ignored_columns)) ignored.push([t, c]);
    const modelTagged = hasProtectedTag(m.tags);
    if (modelTagged) for (const c of t.columns) mark(t, c.name);
    const joinsOnly = objects(m.joins).map((j) => ({ ...j, keys: [] })) as unknown as Join[];
    const fields: [Record<string, unknown>, "dimension" | "measure"][] = [
      ...objects(m.dimensions).map((d) => [d, "dimension"] as [Record<string, unknown>, "dimension"]),
      ...objects(m.measures).map((x) => [x, "measure"] as [Record<string, unknown>, "measure"]),
    ];
    for (const [field, kind] of fields) {
      const one = { ...m, primary_key: undefined, joins: joinsOnly, dimensions: [], measures: [] } as Model;
      if (kind === "dimension") one.dimensions = [field as unknown as Dimension];
      else one.measures = [field as unknown as Measure];
      const fieldTagged = hasProtectedTag(field.tags);
      if (!modelTagged && !fieldTagged) {
        const isPublic = stringList(field.tags).some((x) => x.toLowerCase() === PUBLIC_TAG);
        for (const c of referencedColumns(one, t, dialect)) read(t, c, true, isPublic);
        continue;
      }
      for (const c of referencedColumns(one, t, dialect)) mark(t, c);
      for (const sql of [field.expr, field.filter]) {
        if (typeof sql !== "string") continue;
        for (const chain of sqlNames(sql, dialect).chains) {
          const first = joinNamed(m, chain.parts[0]!);
          const hop1 = first ? byName.get(first.to) : undefined;
          if (!hop1 || chain.parts.length < 2) continue;
          const second = chain.parts.length >= 3 ? joinNamed(hop1, chain.parts[1]!) : undefined;
          const hop2 = second ? byName.get(second.to) : undefined;
          const target = second ? hop2 : hop1;
          const column = second ? chain.parts[2] : chain.parts[1];
          const targetTable = tableOf(target);
          if (targetTable && column) mark(targetTable, column);
        }
      }
    }
  }

  for (const [t, c] of ignored) if (!readerOf(t, c)?.open) mark(t, c);

  for (const t of tables) {
    const tableKeys = keys.get(qualifiedName(t));
    for (const c of t.columns) {
      if (readerOf(t, c.name)?.publicOnly) continue;
      if (sensitivityOf(c.name, c, t.row_count, { key: tableKeys?.has(c.name.toLowerCase()) ?? false })) mark(t, c.name);
    }
  }
  return out;
}

// Whether a column's min and max may be stored for a protected column: numbers, dates and booleans.
function keepsBounds(column: Pick<SnapshotColumn, "type">): boolean {
  const c = classifyType(column.type);
  return isNumeric(c) || isTemporal(c) || c === "boolean";
}

// Whether a protected column's profile still holds raw values: a top value that is not hashed, or
// a text min or max.
export function holdsRawValues(profile: ColumnProfile | undefined, column: Pick<SnapshotColumn, "type">): boolean {
  if (!isRecord(profile)) return false;
  const raw = (Array.isArray(profile.top_values) ? profile.top_values : []).some(
    (tv) => isRecord(tv) && tv.value !== null && tv.value !== undefined && !isHashedValue(tv.value),
  );
  if (raw) return true;
  if (keepsBounds(column)) return false;
  return (profile.min !== null && profile.min !== undefined) || (profile.max !== null && profile.max !== undefined);
}

// A protected column's profile as stored: each top value hashed with its count kept, no min and
// max for a text column, and redacted: true.
export function redactProfile(profile: ColumnProfile, column: Pick<SnapshotColumn, "type">): ColumnProfile {
  const out: ColumnProfile = { ...profile };
  if (Array.isArray(profile.top_values)) {
    out.top_values = profile.top_values.map(
      (tv): TopValue => ({ ...tv, value: tv.value === null || isHashedValue(tv.value) ? tv.value : hashValue(String(tv.value)) }),
    );
  }
  if (!keepsBounds(column)) {
    delete out.min;
    delete out.max;
  }
  out.redacted = true;
  return out;
}

// Redacts the profiles of the protected columns of the snapshot's tables, or of the tables named in
// `only` (qualified names). Other profiles and tables are returned as they were. `redacted` lists
// the columns whose profile changed, as table.column.
export function redactSnapshot(
  snapshot: Snapshot,
  protectedCols: Map<string, Set<string>>,
  only?: Set<string>,
): { snapshot: Snapshot; redacted: string[] } {
  const redacted: string[] = [];
  const tables = snapshot.tables.map((t) => {
    const q = qualifiedName(t);
    const cols = protectedCols.get(q);
    if (!cols || (only && !only.has(q))) return t;
    let changed = false;
    const columns = t.columns.map((c) => {
      if (!cols.has(c.name) || !c.profile) return c;
      if (c.profile.redacted === true && !holdsRawValues(c.profile, c)) return c;
      changed = true;
      redacted.push(`${q}.${c.name}`);
      return { ...c, profile: redactProfile(c.profile, c) };
    });
    return changed ? { ...t, columns } : t;
  });
  return { snapshot: redacted.length ? { ...snapshot, tables } : snapshot, redacted };
}

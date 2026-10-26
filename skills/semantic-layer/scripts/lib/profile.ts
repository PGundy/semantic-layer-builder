// Turns profile query results into snapshot column profiles, and reads the
// facts the skill uses from a profiled table.
import { classifyType, isNumeric } from "./column-types.ts";
import { UserError } from "./errors.ts";
import { qualifiedName } from "./naming.ts";
import { approximateDistinct, hasMinMax, hasTopValues, statsQueryId, topQueryId } from "./sql/profile.ts";
import type { ColumnProfile, Dialect, PlanResults, QueryPlan, Scalar, Snapshot, SnapshotColumn, SnapshotTable, TopValue } from "./types.ts";

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

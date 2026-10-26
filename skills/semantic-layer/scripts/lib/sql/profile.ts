// SQL for `sl profile`: one statistics query per table and one top-values query
// per string or boolean column. Column statistics use index aliases (c0_nulls,
// c0_distinct, c0_min, c0_max) so no column name needs quoting as an alias.
import { classifyType, isNumeric, isTemporal } from "../column-types.ts";
import { approxCountDistinct, castText, quoteIdent, quoteTable, sampledFrom } from "../dialect.ts";
import { qualifiedName } from "../naming.ts";
import type { Dialect, QueryPlan, SnapshotColumn, SnapshotTable, SourceConfig } from "../types.ts";

// Top-values queries per table at most; the remaining columns get none.
export const MAX_TOP_COLUMNS = 40;

export interface ProfileSettings {
  sample_rows?: number;
  top_values: number;
}

export interface ProfilePlanDetails {
  plan: QueryPlan;
  // Qualified names of tables whose statistics read a sample.
  sampled: string[];
  // Per table, the string or boolean columns left without top values by MAX_TOP_COLUMNS.
  capped: { table: string; columns: string[] }[];
}

export function statsQueryId(table: { schema?: string | null; name: string }): string {
  return `stats:${qualifiedName(table)}`;
}

export function topQueryId(table: { schema?: string | null; name: string }, column: string): string {
  return `top:${qualifiedName(table)}:${column}`;
}

// Types with no equality comparison in some engines (Postgres json and the
// geometric types, geometry, arrays), which a distinct count cannot read.
const NO_DISTINCT =
  /^(json|xml|geometry|geography|variant|object|struct|map|array|list|point|line|lseg|box|path|polygon|circle)\b|\[\d*\]$/;
// Array types, including DuckDB fixed-size arrays such as INTEGER[2].
const ARRAY_TYPE = /\[\d*\]$/;
// Floating-point types, whose min and max skip NaN.
const FLOAT_TYPE = /^(float|float4|float8|float64|double|real)\b/;

export function hasDistinct(column: SnapshotColumn): boolean {
  return !NO_DISTINCT.test(column.type.trim().toLowerCase());
}

export function hasMinMax(column: SnapshotColumn): boolean {
  if (ARRAY_TYPE.test(column.type.trim())) return false;
  const c = classifyType(column.type);
  return isNumeric(c) || isTemporal(c);
}

// The expression min and max read: floating-point columns drop NaN (and
// infinities, since x - x is NaN for them), which engines otherwise sort above
// every number.
function boundExpr(column: SnapshotColumn, quoted: string): string {
  return FLOAT_TYPE.test(column.type.trim().toLowerCase()) ? `case when ${quoted} - ${quoted} = 0 then ${quoted} end` : quoted;
}

export function hasTopValues(column: SnapshotColumn): boolean {
  const c = classifyType(column.type);
  return c === "string" || c === "boolean";
}

// DuckDB's approx_count_distinct is off by several percent even on a handful of
// values, so DuckDB counts exactly; the other engines use their approximation.
function distinctCount(dialect: Dialect, expr: string): string {
  return dialect === "duckdb" ? `count(distinct ${expr})` : approxCountDistinct(dialect, expr);
}

// True when a dialect's distinct counts are estimates.
export function approximateDistinct(dialect: Dialect): boolean {
  return dialect !== "duckdb" && dialect !== "postgres";
}

function shouldSample(table: SnapshotTable, sampleRows: number | undefined): boolean {
  if (!sampleRows || sampleRows <= 0) return false;
  return table.row_count === null || table.row_count === undefined || table.row_count > sampleRows;
}

export function buildProfilePlan(source: SourceConfig, tables: SnapshotTable[], settings: ProfileSettings): ProfilePlanDetails {
  const d = source.dialect;
  const queries: QueryPlan["queries"] = [];
  const sampled: string[] = [];
  const capped: ProfilePlanDetails["capped"] = [];
  const topN = Number.isFinite(settings.top_values) ? Math.max(0, Math.floor(settings.top_values)) : 0;

  for (const table of tables) {
    const q = qualifiedName(table);
    const full = quoteTable(d, table);
    const sample = shouldSample(table, settings.sample_rows);
    if (sample) sampled.push(q);
    const from = `${sampledFrom(d, full, sample ? settings.sample_rows : undefined)} as s`;

    const select: string[] = sample
      ? [`(select count(*) from ${full}) as row_count`, "count(*) as sample_count"]
      : ["count(*) as row_count"];
    table.columns.forEach((col, i) => {
      const c = quoteIdent(d, col.name);
      select.push(`count(*) - count(${c}) as c${i}_nulls`);
      if (hasDistinct(col)) select.push(`${distinctCount(d, c)} as c${i}_distinct`);
      if (hasMinMax(col)) {
        const b = boundExpr(col, c);
        select.push(`${castText(d, `min(${b})`)} as c${i}_min`);
        select.push(`${castText(d, `max(${b})`)} as c${i}_max`);
      }
    });
    queries.push({
      id: statsQueryId(table),
      purpose: `Row count and column statistics for ${q}${sample ? ` (statistics over a ${settings.sample_rows}-row sample)` : ""}`,
      sql: `select\n  ${select.join(",\n  ")}\nfrom ${from}`,
    });

    // top_values 0 asks for no top-values queries at all.
    const topColumns = topN > 0 ? table.columns.filter(hasTopValues) : [];
    const kept = topColumns.slice(0, MAX_TOP_COLUMNS);
    if (topColumns.length > kept.length) capped.push({ table: q, columns: topColumns.slice(MAX_TOP_COLUMNS).map((c) => c.name) });
    for (const col of kept) {
      const c = quoteIdent(d, col.name);
      queries.push({
        id: topQueryId(table, col.name),
        purpose: `Most common values of ${q}.${col.name}`,
        sql:
          `select ${castText(d, c)} as value, count(*) as n\nfrom ${from}\nwhere ${c} is not null\n` +
          `group by 1\norder by n desc, value\nlimit ${topN}`,
      });
    }
  }

  return { plan: { command: "profile", source: source.source, dialect: d, queries }, sampled, capped };
}

export function profilePlan(source: SourceConfig, tables: SnapshotTable[], settings: ProfileSettings): QueryPlan {
  return buildProfilePlan(source, tables, settings).plan;
}

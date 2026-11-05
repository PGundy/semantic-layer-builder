// SQL for `sl profile`: one statistics query per table and one top-values query per table that
// covers its string and boolean columns, grouping one read of the table (or of one sample of it)
// by each column with GROUPING SETS. Column statistics use index aliases (c0_nulls, c0_distinct,
// c0_min, c0_max) and top-value rows carry the column's index (column_index), so no column name
// needs quoting as an alias.
import { classifyType, isNumeric, isTemporal } from "../column-types.ts";
import { approxCountDistinct, castText, quoteIdent, quoteTable } from "../dialect.ts";
import { qualifiedName } from "../naming.ts";
import type { Dialect, QueryPlan, SnapshotColumn, SnapshotTable, SourceConfig } from "../types.ts";

// Columns per table that get top values at most; the remaining columns get none.
export const MAX_TOP_COLUMNS = 40;

// The seed of repeatable samples, so a re-profile of unchanged data reads the same sample.
const SAMPLE_SEED = 42;
// TABLESAMPLE SYSTEM picks whole storage blocks, so a percent sized for a few rows can reach no
// block at all. Its percent is sized for at least this many rows, and a smaller sample keeps the
// first `rows` of the rows it reads.
const SYSTEM_SAMPLE_MIN_ROWS = 1000;

export interface ProfileSettings {
  sample_rows?: number;
  top_values: number;
  // Protected columns by qualified table name (protectedColumns in lib/profile.ts): the plan
  // selects no top values for them.
  protect?: Map<string, Set<string>>;
}

export interface ProfilePlanDetails {
  plan: QueryPlan;
  // Qualified names of tables whose statistics read a sample.
  sampled: string[];
  // Sampled tables on postgres or bigquery that TABLESAMPLE cannot read (a view or external table,
  // or a table with no row estimate, such as a partitioned Postgres parent), whose sample sorts
  // every row of the table instead.
  sorted_samples: string[];
  // Per table, the string or boolean columns left without top values by MAX_TOP_COLUMNS.
  capped: { table: string; columns: string[] }[];
  // Per table with a top-values query, the indexes of the columns it covers.
  top_columns: Map<string, number[]>;
}

export function statsQueryId(table: { schema?: string | null; name: string }): string {
  return `stats:${qualifiedName(table)}`;
}

export function topQueryId(table: { schema?: string | null; name: string }): string {
  return `top:${qualifiedName(table)}`;
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

// The percent of a table's rows that a sample of `rows` rows reads, as a decimal literal of at
// most six places and at least 0.000001.
function samplePercent(rows: number, rowCount: number): string {
  const p = Math.min(100, (100 * rows) / rowCount);
  const text = p.toFixed(6).replace(/\.?0+$/, "");
  return text === "0" ? "0.000001" : text;
}

// Whether a sample of the table can use TABLESAMPLE SYSTEM on postgres or bigquery: a table (not
// a view or external table) with a row estimate.
function tablesample(table: SnapshotTable): boolean {
  return table.kind === "table" && typeof table.row_count === "number" && table.row_count > 0;
}

// The FROM item a profile query reads: the whole table, or a sample of about `rows` rows. Postgres
// and bigquery read a sample with TABLESAMPLE SYSTEM, a percent of the table's storage blocks
// computed from its row estimate, so the query reads only those blocks; the percent is sized for
// at least SYSTEM_SAMPLE_MIN_ROWS rows, and a smaller sample keeps the first `rows` rows read.
// Where TABLESAMPLE does not apply they sort every row at random and keep `rows`.
function sampleFrom(dialect: Dialect, table: SnapshotTable, rows: number | undefined): string {
  const full = quoteTable(dialect, table);
  if (!rows) return full;
  const n = Math.max(1, Math.floor(rows));
  const system = (suffix: string) => {
    const percent = samplePercent(Math.max(n, SYSTEM_SAMPLE_MIN_ROWS), table.row_count!);
    return `tablesample system (${percent}${suffix})`;
  };
  const limit = n < SYSTEM_SAMPLE_MIN_ROWS ? ` limit ${n}` : "";
  switch (dialect) {
    case "duckdb":
      return `(select * from ${full} using sample reservoir(${n} rows) repeatable (${SAMPLE_SEED}))`;
    case "postgres":
      return tablesample(table)
        ? `(select * from ${full} ${system("")} repeatable (${SAMPLE_SEED})${limit})`
        : `(select * from ${full} order by random() limit ${n})`;
    case "snowflake":
      return `(select * from ${full} sample (${n} rows))`;
    case "bigquery":
      return tablesample(table) ? `(select * from ${full} ${system(" percent")}${limit})` : `(select * from ${full} order by rand() limit ${n})`;
    case "databricks":
      return `(select * from ${full} tablesample (${n} rows))`;
  }
}

// The row count a sampled statistics query reports: on postgres, when TABLESAMPLE reads the
// sample, the table's row estimate, since count(*) over a Postgres table scans all of it; else a
// count of the whole table, which the other engines answer from metadata or a cheap scan.
function sampledRowCount(dialect: Dialect, table: SnapshotTable, full: string): string {
  if (dialect === "postgres" && tablesample(table)) return `${Math.round(table.row_count!)} as row_count`;
  return `(select count(*) from ${full}) as row_count`;
}

// One query for the top values of `columns` (with their indexes in the table): each column's
// `topN` most common non-null values with their counts, ties ordered by value, as rows of
// column_index, value and n.
function topValuesSql(d: Dialect, from: string, columns: [SnapshotColumn, number][], topN: number): string {
  const quoted = columns.map(([c, i]) => [quoteIdent(d, c.name), i] as const);
  const index = quoted.map(([c, i]) => `when grouping(${c}) = 0 then ${i}`).join(" ");
  const value = quoted.map(([c]) => `when grouping(${c}) = 0 then ${castText(d, c)}`).join(" ");
  const sets = quoted.map(([c]) => `(${c})`).join(", ");
  return (
    "select column_index, value, n\nfrom (\n" +
    "  select column_index, value, n, row_number() over (partition by column_index order by n desc, value) as rank_in_column\n" +
    "  from (\n" +
    `    select case ${index} end as column_index, case ${value} end as value, count(*) as n\n` +
    `    from ${from}\n` +
    `    group by grouping sets (${sets})\n` +
    "  ) as g\n" +
    "  where value is not null\n" +
    ") as r\n" +
    `where rank_in_column <= ${topN}\n` +
    "order by column_index, rank_in_column"
  );
}

export function buildProfilePlan(source: SourceConfig, tables: SnapshotTable[], settings: ProfileSettings): ProfilePlanDetails {
  const d = source.dialect;
  const queries: QueryPlan["queries"] = [];
  const sampled: string[] = [];
  const sorted: string[] = [];
  const capped: ProfilePlanDetails["capped"] = [];
  const topColumnsByTable = new Map<string, number[]>();
  const topN = Number.isFinite(settings.top_values) ? Math.max(0, Math.floor(settings.top_values)) : 0;

  for (const table of tables) {
    const q = qualifiedName(table);
    const full = quoteTable(d, table);
    const sample = shouldSample(table, settings.sample_rows);
    if (sample) {
      sampled.push(q);
      if ((d === "postgres" || d === "bigquery") && !tablesample(table)) sorted.push(q);
    }
    const from = `${sampleFrom(d, table, sample ? settings.sample_rows : undefined)} as s`;

    const select: string[] = sample
      ? [sampledRowCount(d, table, full), "count(*) as sample_count"]
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
      purpose: `Row count and column statistics for ${q}${
        sample
          ? ` (statistics over a ${settings.sample_rows}-row sample${d === "postgres" && tablesample(table) ? "; the row count is the table's estimate" : ""})`
          : ""
      }`,
      sql: `select\n  ${select.join(",\n  ")}\nfrom ${from}`,
    });

    // top_values 0 asks for no top-values query at all; protected columns get none.
    const protectedNames = settings.protect?.get(q);
    const topColumns: [SnapshotColumn, number][] =
      topN > 0
        ? table.columns.map((c, i) => [c, i] as [SnapshotColumn, number]).filter(([c]) => hasTopValues(c) && !protectedNames?.has(c.name))
        : [];
    const kept = topColumns.slice(0, MAX_TOP_COLUMNS);
    if (topColumns.length > kept.length) capped.push({ table: q, columns: topColumns.slice(MAX_TOP_COLUMNS).map(([c]) => c.name) });
    if (kept.length) {
      topColumnsByTable.set(q, kept.map(([, i]) => i));
      queries.push({
        id: topQueryId(table),
        purpose: `Most common values of ${kept.length === 1 ? "column" : "columns"} ${kept.map(([c]) => c.name).join(", ")} of ${q}${
          sample ? " (over one sample)" : ""
        }`,
        sql: topValuesSql(d, from, kept, topN),
      });
    }
  }

  return { plan: { command: "profile", source: source.source, dialect: d, queries }, sampled, sorted_samples: sorted, capped, top_columns: topColumnsByTable };
}

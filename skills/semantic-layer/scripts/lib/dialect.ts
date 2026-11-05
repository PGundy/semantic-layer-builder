// Dialect-specific SQL fragments shared by every SQL generator.
import type { Dialect } from "./types.ts";

export function quoteIdent(dialect: Dialect, name: string): string {
  if (dialect === "bigquery" || dialect === "databricks") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Quotes each part of a qualified table name: schema.table -> "schema"."table".
export function quoteTable(dialect: Dialect, table: { schema?: string | null; name: string }): string {
  const parts = table.schema ? [...table.schema.split("."), table.name] : [table.name];
  return parts.map((p) => quoteIdent(dialect, p)).join(".");
}

export function approxCountDistinct(dialect: Dialect, expr: string): string {
  switch (dialect) {
    case "postgres":
    case "duckdb":
      // DuckDB's HyperLogLog is far off on small sets, so counts there are exact.
      return `count(distinct ${expr})`;
    default:
      return `approx_count_distinct(${expr})`;
  }
}

// Text cast used to compare or display values of any type.
export function castText(dialect: Dialect, expr: string): string {
  switch (dialect) {
    case "bigquery":
      return `cast(${expr} as string)`;
    case "databricks":
      return `cast(${expr} as string)`;
    default:
      return `cast(${expr} as varchar)`;
  }
}


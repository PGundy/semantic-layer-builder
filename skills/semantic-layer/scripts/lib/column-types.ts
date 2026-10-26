// Classifies a column's database type, as written in a snapshot, across dialects.
export type TypeCategory = "integer" | "decimal" | "date" | "timestamp" | "time" | "string" | "boolean" | "other";

export function classifyType(raw: string): TypeCategory {
  const t = raw.trim().toLowerCase();
  if (/\[\]$/.test(t) || /^(array|list|struct|map)\b/.test(t)) return "other";
  if (/^(bool|boolean)$/.test(t)) return "boolean";
  if (/^(tinyint|smallint|int|integer|bigint|hugeint|int2|int4|int8|int64|byteint|utinyint|usmallint|uinteger|ubigint|uhugeint|serial|bigserial|smallserial)\b/.test(t))
    return "integer";
  const num = t.match(/^(number|numeric|decimal)\s*(?:\(\s*\d+\s*(?:,\s*(\d+)\s*)?\))?/);
  if (num) return num[2] === undefined ? (num[0].includes("(") ? "integer" : "decimal") : num[2] === "0" ? "integer" : "decimal";
  if (/^(float|float4|float8|float64|double|double precision|real|bignumeric|money)\b/.test(t)) return "decimal";
  if (/^date$/.test(t)) return "date";
  if (/^(timestamp|datetime|timestamptz|timestamp_ntz|timestamp_ltz|timestamp_tz|timestamp with time zone|timestamp without time zone)/.test(t))
    return "timestamp";
  if (/^time\b/.test(t)) return "time";
  if (/^(varchar|char|character|character varying|text|string|nvarchar|nchar|bpchar|citext|uuid|enum|name)\b/.test(t)) return "string";
  return "other";
}

export function isNumeric(c: TypeCategory): boolean {
  return c === "integer" || c === "decimal";
}

export function isTemporal(c: TypeCategory): boolean {
  return c === "date" || c === "timestamp";
}

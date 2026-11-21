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

// A type name reduced to what its spelling does not change: lower case, no length, precision or
// scale, one spelling per synonym ("character varying" and "varchar(20)" are both varchar,
// "NUMBER(38,0)" and "numeric(10,2)" both numeric). Empty for a type a source did not know.
const SYNONYMS: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  number: "numeric",
  decimal: "numeric",
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  float8: "double precision",
  double: "double precision",
  float4: "real",
  bool: "boolean",
  timestamptz: "timestamp with time zone",
  "timestamp without time zone": "timestamp",
  string: "varchar",
  text: "varchar",
  bpchar: "char",
};

export function typeFamily(raw: string): string {
  const t = raw.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (t === "" || t === "unknown") return "";
  return SYNONYMS[t] ?? t;
}

// Whether two spellings are the same type for a change report that compares snapshots from different
// sources. A type one side does not know is not a change.
export function sameTypeFamily(a: string, b: string): boolean {
  const x = typeFamily(a);
  const y = typeFamily(b);
  if (x === "" || y === "") return true;
  if (x !== y) return false;
  // Precision and scale count only when both sides state them: "numeric" knows less than "numeric(10,2)".
  const pa = a.match(/\(([^)]*)\)/)?.[1]?.replace(/\s+/g, "");
  const pb = b.match(/\(([^)]*)\)/)?.[1]?.replace(/\s+/g, "");
  return pa === undefined || pb === undefined || pa === pb;
}

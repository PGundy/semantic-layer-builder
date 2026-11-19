// Builds snapshot tables from an export of information_schema.columns, as CSV
// or as JSON (an array of row objects). Header names are case-insensitive.
// The canonical exports in references/exports/ also carry keys: is_primary_key and
// pk_ordinal give the primary key, and fk_name, fk_ordinal and references_* give the
// foreign keys (a column in several foreign keys has one row per key).
import { UserError } from "../errors.ts";
import type { ForeignKey, SnapshotColumn, SnapshotTable, TableKind } from "../types.ts";
import { forEachCsvRow } from "./csv.ts";

export interface ImportResult {
  tables: SnapshotTable[];
  warnings: string[];
}

// Header aliases accepted for each field, first match wins.
const FIELDS = {
  catalog: ["table_catalog", "catalog", "database", "table_database", "database_name", "project_id"],
  schema: ["table_schema", "schema", "schema_name", "table_schem", "dataset"],
  table: ["table_name", "table", "relation_name"],
  column: ["column_name", "column", "field", "field_name"],
  type: ["data_type", "type", "column_type", "data_type_name", "full_data_type"],
  fullType: ["column_type", "full_data_type"],
  nullable: ["is_nullable", "nullable", "null"],
  ordinal: ["ordinal_position", "ordinal", "position", "column_index", "column_id"],
  tableType: ["table_type", "kind", "object_type"],
  description: ["description", "comment", "column_comment", "remarks", "column_description"],
  tableDescription: ["table_comment", "table_description"],
  rowCount: ["row_count", "rows", "table_rows", "row_estimate", "num_rows", "reltuples"],
  udtName: ["udt_name"],
  precision: ["numeric_precision"],
  scale: ["numeric_scale"],
  isPrimaryKey: ["is_primary_key", "is_pk"],
  pkOrdinal: ["pk_ordinal", "pk_position"],
  fkName: ["fk_name", "foreign_key_name"],
  fkOrdinal: ["fk_ordinal", "fk_position"],
  refSchema: ["references_schema", "referenced_table_schema", "ref_schema"],
  refTable: ["references_table", "referenced_table_name", "ref_table"],
  refColumn: ["references_column", "referenced_column_name", "ref_column"],
} as const;

const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "pg_toast", "performance_schema", "mysql", "sys"]);

type Row = Record<string, unknown>;

// Maps a table_type value from any dialect to a snapshot kind.
export function kindFromTableType(raw: unknown): TableKind {
  const t = String(raw ?? "").toUpperCase();
  if (t.includes("VIEW")) return "view";
  if (t.includes("EXTERNAL") || t.includes("FOREIGN")) return "external";
  return "table";
}

// Returns a function that names a table's schema, prefixing the catalog only
// when the input spans more than one catalog.
export function schemaNamer(catalogs: Iterable<string | null | undefined>): (catalog: string | null | undefined, schema: string | null) => string | null {
  const distinct = new Set<string>();
  for (const c of catalogs) if (c) distinct.add(c);
  const multi = distinct.size > 1;
  return (catalog, schema) => {
    if (!multi || !catalog) return schema;
    return schema ? `${catalog}.${schema}` : catalog;
  };
}

function pick(row: Row, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseNullable(v: unknown): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (["yes", "y", "true", "t", "1", "nullable"].includes(s)) return true;
  if (["no", "n", "false", "f", "0", "not null"].includes(s)) return false;
  return null;
}

function parseNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function columnType(row: Row): string | null {
  const full = text(pick(row, FIELDS.fullType));
  if (full) return full;
  const base = text(pick(row, FIELDS.type));
  if (!base) return null;
  // Postgres reports enum and array columns as USER-DEFINED and ARRAY; udt_name holds the real type (_text for text[]).
  const udt = text(pick(row, FIELDS.udtName));
  if (udt && /^user-defined$/i.test(base)) return udt;
  if (udt && /^array$/i.test(base)) return udt.startsWith("_") ? `${udt.slice(1)}[]` : `${udt}[]`;
  if (/^(number|numeric|decimal)$/i.test(base)) {
    const p = parseNumber(pick(row, FIELDS.precision));
    const s = parseNumber(pick(row, FIELDS.scale));
    if (p !== null && s !== null) return `${base}(${p},${s})`;
  }
  return base;
}

// Values command-line clients print for SQL NULL in delimited output: NULL (mysql --batch,
// sqlcmd) and \N (MySQL SELECT ... INTO OUTFILE).
const NULL_MARKERS = new Set(["NULL", "\\N"]);

// True for the dashed line sqlcmd prints under its header.
function isRuleRow(row: Row): boolean {
  let dashes = false;
  for (const k in row) {
    const v = String(row[k] ?? "").trim();
    if (v === "") continue;
    if (!/^-+$/.test(v)) return false;
    dashes = true;
  }
  return dashes;
}

function lowerKeys(row: unknown): Row {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  return Object.fromEntries(Object.entries(row as Row).map(([k, v]) => [k.trim().toLowerCase(), v]));
}

// Reads rows from CSV text, a JSON array, or a JSON object holding one array of rows.
export function readRows(content: string, label = "input"): Row[] {
  const trimmed = content.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new UserError(`${label}: looks like JSON but does not parse: ${(e as Error).message}`);
    }
    let rows: unknown = parsed;
    if (!Array.isArray(parsed) && parsed && typeof parsed === "object") {
      const arrays = Object.values(parsed as Row).filter(Array.isArray);
      if (arrays.length !== 1) throw new UserError(`${label}: expected a JSON array of row objects, or an object holding exactly one such array.`);
      rows = arrays[0];
    }
    return (rows as unknown[]).map(lowerKeys);
  }
  const rows: Row[] = [];
  forEachCsvRow(content, (r) => {
    if (isRuleRow(r)) return;
    for (const k in r) if (NULL_MARKERS.has(r[k]!.trim())) r[k] = "";
    rows.push(r);
  });
  return rows;
}

export function importInformationSchema(content: string, label = "input"): ImportResult {
  const rows = readRows(content, label);
  const warnings: string[] = [];
  if (!rows.length) throw new UserError(`${label}: no rows.`);
  const headers = new Set<string>();
  for (const r of rows) for (const k in r) headers.add(k);
  const has = (keys: readonly string[]) => keys.some((k) => headers.has(k));
  const missing: string[] = [];
  if (!has(FIELDS.table)) missing.push("table_name");
  if (!has(FIELDS.column)) missing.push("column_name");
  if (!has(FIELDS.type)) missing.push("data_type");
  if (missing.length) {
    throw new UserError(
      `${label}: missing required column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ` +
        `Found: ${[...headers].join(", ") || "none"}. Alias the export's columns to table_schema, table_name, column_name, data_type, is_nullable, ordinal_position.`,
    );
  }
  for (const [field, name] of [
    [FIELDS.schema, "table_schema"],
    [FIELDS.nullable, "is_nullable"],
    [FIELDS.ordinal, "ordinal_position"],
  ] as const) {
    if (!has(field)) warnings.push(`No ${name} column; ${name === "table_schema" ? "tables have no schema" : name === "is_nullable" ? "nullability is unknown" : "columns keep file order"}.`);
  }

  const name = schemaNamer(rows.map((r) => text(pick(r, FIELDS.catalog))));
  const keyColumns = { primary: has(FIELDS.isPrimaryKey), foreign: has(FIELDS.refTable) && has(FIELDS.refColumn) };
  interface KeyPart {
    column: string;
    ordinal: number | null;
    seq: number;
  }
  interface FkPart extends KeyPart {
    refColumn: string;
  }
  interface PendingFk {
    name: string | null;
    refSchema: string | null;
    refTable: string;
    parts: FkPart[];
  }
  interface Pending {
    table: SnapshotTable;
    columns: { col: SnapshotColumn; ordinal: number | null; seq: number }[];
    seen: Set<string>;
    pk: Map<string, KeyPart>;
    fks: Map<string, PendingFk>;
    // For keys without fk_name: the open key per referenced table, by its map key.
    unnamed: Map<string, string>;
  }
  const tables = new Map<string, Pending>();
  const system = new Set<string>();
  let untyped = 0;
  let duplicates = 0;
  let seq = 0;
  let skippedRows = 0;

  // Records the foreign key a row names, if any. Rows group by fk_name; rows without one group
  // by referenced table, and a new key starts when fk_ordinal does not follow the last one or,
  // without fk_ordinal, when the referenced column is already in the open key.
  const addForeignKey = (pending: Pending, row: Row, column: string, catalog: string | null, rawSchema: string | null, rowSeq: number): boolean => {
    const refTable = text(pick(row, FIELDS.refTable));
    const refColumn = text(pick(row, FIELDS.refColumn));
    if (!refTable || !refColumn) return false;
    const refSchema = name(catalog, text(pick(row, FIELDS.refSchema)) ?? rawSchema);
    const fkName = text(pick(row, FIELDS.fkName));
    const ordinal = parseNumber(pick(row, FIELDS.fkOrdinal));
    let mapKey: string;
    if (fkName) mapKey = `n\u0000${fkName}`;
    else {
      const ref = `${refSchema ?? ""}\u0000${refTable}`;
      const open = pending.unnamed.get(ref);
      const current = open ? pending.fks.get(open) : undefined;
      const last = current?.parts.at(-1);
      const restart =
        !current ||
        (ordinal !== null ? ordinal <= 1 || (last?.ordinal ?? 0) >= ordinal : current.parts.some((p) => p.refColumn.toLowerCase() === refColumn.toLowerCase()));
      mapKey = restart ? `u\u0000${ref}\u0000${String(pending.fks.size).padStart(6, "0")}` : open!;
      pending.unnamed.set(ref, mapKey);
    }
    let fk = pending.fks.get(mapKey);
    if (!fk) {
      fk = { name: fkName, refSchema, refTable, parts: [] };
      pending.fks.set(mapKey, fk);
    }
    if (!fk.parts.some((p) => p.column.toLowerCase() === column.toLowerCase())) fk.parts.push({ column, refColumn, ordinal, seq: rowSeq });
    return true;
  };

  for (const row of rows) {
    const tableName = text(pick(row, FIELDS.table));
    const columnName = text(pick(row, FIELDS.column));
    if (!tableName || !columnName) {
      skippedRows++;
      continue;
    }
    const rawSchema = text(pick(row, FIELDS.schema));
    if (rawSchema && SYSTEM_SCHEMAS.has(rawSchema.toLowerCase())) {
      system.add(`${rawSchema}.${tableName}`);
      continue;
    }
    const catalog = text(pick(row, FIELDS.catalog));
    const schema = name(catalog, rawSchema);
    const key = `${schema ?? ""}\u0000${tableName}`;
    let pending = tables.get(key);
    if (!pending) {
      const table: SnapshotTable = { schema, name: tableName, kind: kindFromTableType(pick(row, FIELDS.tableType)), row_count: null, description: null, columns: [] };
      pending = { table, columns: [], seen: new Set(), pk: new Map(), fks: new Map(), unnamed: new Map() };
      tables.set(key, pending);
    }
    const t = pending.table;
    const rowCount = parseNumber(pick(row, FIELDS.rowCount));
    if (rowCount !== null && (t.row_count === null || t.row_count === undefined)) t.row_count = Math.round(rowCount);
    const tableDescription = text(pick(row, FIELDS.tableDescription));
    if (tableDescription && !t.description) t.description = tableDescription;
    const rowSeq = seq++;
    const ordinal = parseNumber(pick(row, FIELDS.ordinal));
    if (parseNullable(pick(row, FIELDS.isPrimaryKey)) === true && !pending.pk.has(columnName.toLowerCase())) {
      pending.pk.set(columnName.toLowerCase(), { column: columnName, ordinal: parseNumber(pick(row, FIELDS.pkOrdinal)) ?? ordinal, seq: rowSeq });
    }
    const keyed = addForeignKey(pending, row, columnName, catalog, rawSchema, rowSeq);
    if (pending.seen.has(columnName.toLowerCase())) {
      // A column in several foreign keys has one row per key; any other repeat is a duplicate.
      if (!keyed) duplicates++;
      continue;
    }
    pending.seen.add(columnName.toLowerCase());
    let type = columnType(row);
    if (!type) {
      untyped++;
      type = "unknown";
    }
    pending.columns.push({
      col: { name: columnName, type, nullable: parseNullable(pick(row, FIELDS.nullable)), description: text(pick(row, FIELDS.description)) },
      ordinal,
      seq: rowSeq,
    });
  }

  if (skippedRows) warnings.push(`Skipped ${skippedRows} row${skippedRows === 1 ? "" : "s"} with no table or column name.`);
  if (system.size) warnings.push(`Skipped ${system.size} system table${system.size === 1 ? "" : "s"} (information_schema, pg_catalog and similar).`);
  if (duplicates) warnings.push(`Ignored ${duplicates} repeated column row${duplicates === 1 ? "" : "s"}.`);
  if (untyped) warnings.push(`${untyped} column${untyped === 1 ? " has" : "s have"} no data_type; recorded as "unknown".`);

  const byOrdinal = (a: { ordinal: number | null; seq: number }, b: { ordinal: number | null; seq: number }) =>
    (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq;
  const out: SnapshotTable[] = [];
  for (const { table, columns, pk, fks } of tables.values()) {
    columns.sort(byOrdinal);
    table.columns = columns.map((c) => c.col);
    if (keyColumns.primary) table.primary_key = [...pk.values()].sort(byOrdinal).map((p) => p.column);
    if (keyColumns.foreign) {
      // Named keys sort by name, as introspection does; unnamed keys keep file order after them.
      const order = [...[...fks.keys()].filter((k) => k.startsWith("n")).sort(), ...[...fks.keys()].filter((k) => k.startsWith("u"))];
      const keys: ForeignKey[] = order.map((k) => {
        const fk = fks.get(k)!;
        const parts = [...fk.parts].sort(byOrdinal);
        return { columns: parts.map((p) => p.column), references: { schema: fk.refSchema, table: fk.refTable, columns: parts.map((p) => p.refColumn) } };
      });
      const distinct = new Map(keys.map((fk) => [JSON.stringify(fk), fk]));
      table.foreign_keys = [...distinct.values()];
    }
    out.push(table);
  }
  return { tables: out, warnings };
}

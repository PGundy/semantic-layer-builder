// Builds a snapshot from shared context (an information_schema export, a dbt
// manifest, or DDL) instead of a live connection.
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { UserError } from "../errors.ts";
import type { Snapshot, SnapshotMethod, SourceConfig } from "../types.ts";
import { importDbt } from "./dbt.ts";
import { importDdl } from "./ddl.ts";
import { importInformationSchema } from "./information-schema.ts";

export const IMPORT_FORMATS = ["information_schema", "dbt_manifest", "ddl"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number] & SnapshotMethod;

export interface ImportFiles {
  // Absolute path of the main input file.
  file: string;
  // Absolute path of a dbt catalog.json, for dbt_manifest only.
  catalog?: string;
}

// Header names that mark a delimited file as a column export: a table and a column field.
const TABLE_HEADERS = new Set(["table_name", "table", "relation_name"]);
const COLUMN_HEADERS = new Set(["column_name", "column", "field", "field_name"]);

function csvHeader(content: string): string[] {
  const first = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";", "|"].find((d) => first.includes(d));
  if (!delimiter) return [];
  return first.split(delimiter).map((h) => h.trim().replace(/^"(.*)"$/, "$1").trim().toLowerCase());
}

// Works out a file's format from its name and content: a .sql or .ddl file is DDL, a JSON object
// with "nodes" is a dbt manifest (a dbt catalog.json, which also has "nodes", is a UserError), and a JSON array of rows (bare, or the one array an object
// holds) or delimited text (a .csv or .tsv file, or a header naming a table and a column field)
// is an information_schema export. Other text that opens with CREATE, ALTER, COMMENT ON or SET
// is DDL. Returns null when none applies.
export function detectFormat(path: string, content: string): ImportFormat | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".sql" || ext === ".ddl") return "ddl";
  const trimmed = content.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new UserError(`${basename(path)}: looks like JSON but does not parse: ${(e as Error).message}`);
    }
    if (Array.isArray(parsed)) return "information_schema";
    if (!parsed || typeof parsed !== "object") return null;
    if ("nodes" in parsed) {
      const version = (parsed as { metadata?: { dbt_schema_version?: unknown } }).metadata?.dbt_schema_version;
      if (typeof version === "string" && version.includes("catalog")) {
        throw new UserError(
          `${basename(path)} is a dbt catalog.json: pass target/manifest.json with --file and this file with --catalog.`,
        );
      }
      return "dbt_manifest";
    }
    const arrays = Object.values(parsed).filter(Array.isArray);
    return arrays.length === 1 ? "information_schema" : null;
  }
  if (ext === ".csv" || ext === ".tsv") return "information_schema";
  const header = csvHeader(trimmed);
  if (header.some((h) => TABLE_HEADERS.has(h)) && header.some((h) => COLUMN_HEADERS.has(h))) return "information_schema";
  if (/^\s*(--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(create|alter|comment\s+on|set)\b/i.test(trimmed)) return "ddl";
  return null;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new UserError(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

// Imports a file in the given format, or in the format detectFormat finds when none is given.
// `detected` is true when the format came from the file.
export async function importSnapshot(
  source: SourceConfig,
  requested: ImportFormat | undefined,
  files: ImportFiles,
  capturedAt: string,
): Promise<{ snapshot: Snapshot; warnings: string[]; format: ImportFormat; detected: boolean }> {
  const content = read(files.file);
  const label = basename(files.file);
  const format = requested ?? detectFormat(files.file, content);
  if (!format) {
    throw new UserError(
      `Cannot tell the format of ${label}. Pass --format: one of ${IMPORT_FORMATS.join(", ")} ` +
        "(information_schema: a CSV or JSON array of column rows; dbt_manifest: target/manifest.json; ddl: a .sql file of CREATE statements).",
    );
  }
  if (files.catalog && format !== "dbt_manifest") throw new UserError("--catalog applies only to --format dbt_manifest.");
  const result =
    format === "information_schema"
      ? importInformationSchema(content, label)
      : format === "dbt_manifest"
        ? importDbt(content, files.catalog ? read(files.catalog) : undefined, {
            manifest: label,
            catalog: files.catalog ? basename(files.catalog) : "catalog.json",
          })
        : await importDdl(content, source.dialect);
  const warnings = [...result.warnings];
  const seen = new Map<string, number>();
  const tables = result.tables.filter((t) => {
    const k = `${t.schema ?? ""}.${t.name}`.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
    return seen.get(k) === 1;
  });
  const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.replace(/^\./, ""));
  if (repeated.length) warnings.push(`Kept the first definition of ${repeated.length} table${repeated.length === 1 ? "" : "s"} defined more than once: ${repeated.slice(0, 5).join(", ")}${repeated.length > 5 ? ", ..." : ""}.`);
  const snapshot: Snapshot = {
    snapshot_version: 1,
    source: source.source,
    dialect: source.dialect,
    captured_at: capturedAt,
    method: format,
    tables: tables.sort((a, b) => `${a.schema ?? ""}.${a.name}`.localeCompare(`${b.schema ?? ""}.${b.name}`)),
  };
  return { snapshot, warnings, format, detected: requested === undefined };
}

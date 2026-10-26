// Builds a snapshot from shared context (an information_schema export, a dbt
// manifest, or DDL) instead of a live connection.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
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

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new UserError(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

export async function importSnapshot(
  source: SourceConfig,
  format: ImportFormat,
  files: ImportFiles,
  capturedAt: string,
): Promise<{ snapshot: Snapshot; warnings: string[] }> {
  if (files.catalog && format !== "dbt_manifest") throw new UserError("--catalog applies only to --format dbt_manifest.");
  const content = read(files.file);
  const label = basename(files.file);
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
  return { snapshot, warnings };
}

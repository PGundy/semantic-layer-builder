// The intake block of a source file (spec: sources/<source>.yaml, Intake): the mode, the reason
// an export stands in for a connection, the schemas read and the export file.
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { UserError } from "./errors.ts";
import { schemaMatcher } from "./sql/introspection.ts";
import type { Dialect, IntakeMode, Snapshot, SnapshotTable, SourceConfig } from "./types.ts";

export function intakeMode(source: Pick<SourceConfig, "intake">): IntakeMode {
  return source.intake?.mode ?? "connection";
}

// A schema name is a plain identifier, or two joined by a dot where the tools read one: a
// BigQuery project.dataset (the project id may hold hyphens; a dataset holds no $) or a DuckDB
// attached database's <database>.<schema>, as introspect reports it.
const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";
const BQ_IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const SCHEMA_NAME = new RegExp(`^${IDENT}(\\.${IDENT})?$`);
const BIGQUERY_SCHEMA_NAME = new RegExp(`^([A-Za-z][A-Za-z0-9-]*\\.)?${BQ_IDENT}$`);
// Dialects whose tools read only the connected database's (catalog's) own schemas.
const NO_DOTTED: readonly Dialect[] = ["postgres", "snowflake", "databricks"];

export function isSchemaName(name: string, dialect: Dialect): boolean {
  if (dialect === "bigquery") return BIGQUERY_SCHEMA_NAME.test(name);
  return SCHEMA_NAME.test(name) && !(NO_DOTTED.includes(dialect) && name.includes("."));
}

export const SCHEMA_NAME_HINT =
  "write a plain identifier such as analytics (for BigQuery a dataset or project.dataset; for DuckDB an attached database's schema as database.schema)";

const NO_DOTTED_HINT =
  "names another database's schema, and the tools read only the schemas of the database the connection opens; write the schema alone, such as analytics, or point the connection at that database";

// The name DuckDB gives the database a source opens (its file name up to the first dot, or
// memory), whose schemas introspect reports without a database part; undefined when unknown.
function duckdbDatabase(source: Pick<SourceConfig, "dialect" | "connection">): string | undefined {
  if (source.dialect !== "duckdb") return undefined;
  const db = source.connection?.database;
  if (db === undefined || db === ":memory:") return "memory";
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(db) ? undefined : basename(db).split(".")[0];
}

export interface IntakeIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

// Problems with a list of schema names: a name that is not one, an exact repeat (errors), two
// names that differ only in case and a DuckDB name that matches no table (warnings). A refused
// name is never echoed: the path names it.
export function schemaListIssues(
  schemas: readonly string[],
  source: Pick<SourceConfig, "dialect" | "connection">,
  at: (i: number) => string,
): IntakeIssue[] {
  const out: IntakeIssue[] = [];
  const seen = new Map<string, number>();
  const folded = new Map<string, number>();
  const own = duckdbDatabase(source)?.toLowerCase();
  schemas.forEach((name, i) => {
    if (!isSchemaName(name, source.dialect)) {
      const dotted = NO_DOTTED.includes(source.dialect) && SCHEMA_NAME.test(name);
      out.push({ level: "error", path: at(i), message: dotted ? NO_DOTTED_HINT : `is not a schema name; ${SCHEMA_NAME_HINT}` });
      return;
    }
    const [db, schema] = name.split(".");
    if (schema !== undefined && own !== undefined && [own, "temp"].includes(db!.toLowerCase())) {
      out.push({
        level: "warning",
        path: at(i),
        message: `names a schema of the database this source opens (${db}), which introspect reports as ${schema} alone, so it matches no table; write ${schema}`,
      });
    }
    const first = seen.get(name);
    if (first !== undefined) {
      out.push({ level: "error", path: at(i), message: `repeats ${at(first)} ("${name}"); remove one of them` });
      return;
    }
    seen.set(name, i);
    const other = folded.get(name.toLowerCase());
    if (other !== undefined) {
      out.push({
        level: "warning",
        path: at(i),
        message: `differs from ${at(other)} ("${schemas[other]}") only in case; most warehouses read unquoted names in one case, so keep the one the catalog shows`,
      });
    } else folded.set(name.toLowerCase(), i);
  });
  return out;
}

// The real path of `p`, or of its nearest existing ancestor with the rest appended, so a missing
// file under a symlinked directory, or behind a dangling link, resolves where the link points.
function realish(p: string, depth = 0): string {
  if (existsSync(p)) return realpathSync(p);
  const parent = dirname(p);
  if (parent === p) return p;
  const here = resolve(realish(parent, depth), basename(p));
  if (depth < 40 && lstatSync(here, { throwIfNoEntry: false })?.isSymbolicLink()) return realish(resolve(dirname(here), readlinkSync(here)), depth + 1);
  return here;
}

// Whether `file` (relative to `root`) resolves inside the root, symlinks followed.
export function insideRoot(root: string, file: string): boolean {
  const r = realish(resolve(root));
  const f = realish(resolve(root, file));
  return f === r || f.startsWith(r + sep);
}

const AFTER = "then run sl validate.";

// The semantic checks of a source's intake block, for a file that passed its schema. The
// export file's path is checked, never its contents.
export function intakeIssues(source: SourceConfig, root: string): IntakeIssue[] {
  const intake = source.intake;
  if (!intake) return [];
  const out: IntakeIssue[] = [];
  const mode = intakeMode(source);
  if (mode === "export" && !intake.reason?.trim()) {
    out.push({
      level: "warning",
      path: "intake.reason",
      message:
        "is empty while intake.mode is export. The skill asks for a connection first and takes an export only when one is not possible; " +
        `write why in intake.reason, or set intake.mode to connection if the owner can connect, ${AFTER}`,
    });
  }
  if (intake.schemas?.length === 0) {
    out.push({ level: "warning", path: "intake.schemas", message: `is empty, which reads every schema; list the schemas to read or remove intake.schemas, ${AFTER}` });
  }
  out.push(...schemaListIssues(intake.schemas ?? [], source, (i) => `intake.schemas[${i}]`).map((x) => ({ ...x, message: `${x.message}, ${AFTER}` })));
  const file = intake.export?.file;
  if (intake.export && mode === "connection") {
    out.push({
      level: "error",
      path: "intake.export",
      message: `applies only to intake.mode export, and this source's mode is connection; remove intake.export, or set intake.mode to export with a reason, ${AFTER}`,
    });
  }
  if (file !== undefined) {
    if (isAbsolute(file) || !insideRoot(root, file)) {
      out.push({
        level: "error",
        path: "intake.export.file",
        message: `must be a path inside the semantic root, written relative to it; copy the export under the root (for example exports/<file>) and point intake.export.file at it, ${AFTER}`,
      });
    } else if (!existsSync(resolve(root, file))) {
      out.push({
        level: "warning",
        path: "intake.export.file",
        message: `names a file that does not exist under the semantic root; copy the export there or fix the path, ${AFTER}`,
      });
    } else if (!statSync(resolve(root, file)).isFile()) {
      out.push({ level: "warning", path: "intake.export.file", message: `names a directory, not a file; point it at the export file itself, ${AFTER}` });
    }
  }
  return out;
}

// The schemas intake.schemas names, or [] when it is absent or empty (every schema is read).
// A source file not yet checked by sl validate can hold any value there, so a list of anything
// but names is refused with the fix.
export function intakeSchemas(source: Pick<SourceConfig, "intake" | "source">): string[] {
  const raw: unknown = source.intake?.schemas ?? [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    throw new UserError(
      `intake.schemas in sources/${source.source}.yaml must be a list of schema names, such as [analytics, marts]; fix it and run sl validate.`,
    );
  }
  return [...new Set((raw as string[]).map((s) => s.trim()).filter(Boolean))];
}

// Whether a snapshot table's schema is one of `schemas`, as the dialect names schemas: the case
// rules of introspect's own filter (schemaMatcher), plus the forms an import can carry. A BigQuery
// dataset written alone matches it under any project (`analytics` matches `proj.analytics`), and a
// project.dataset matches the bare dataset id; a DuckDB table whose schema is prefixed with the
// database the source opens (`memory.acme`, from an import spanning databases) matches `acme`. A
// table with no schema matches nothing.
export function schemaFilter(
  source: Pick<SourceConfig, "dialect" | "connection">,
  schemas: readonly string[],
): (schema: string | null | undefined) => boolean {
  const base = schemaMatcher(source.dialect, [...schemas]);
  const bareDatasets = new Set(source.dialect === "bigquery" ? schemas.filter((s) => !s.includes(".")) : []);
  const own = duckdbDatabase(source)?.toLowerCase();
  return (schema) => {
    if (!schema) return false;
    if (base(schema)) return true;
    if (bareDatasets.size) return bareDatasets.has(schema.slice(schema.lastIndexOf(".") + 1));
    const dot = schema.indexOf(".");
    return dot > 0 && own !== undefined && schema.slice(0, dot).toLowerCase() === own && base(schema.slice(dot + 1));
  };
}

// Removes the snapshot's tables whose schema fails schemaFilter for `schemas` (none when it is
// empty) and returns them, how many and their schemas, sorted (null for tables with no schema).
export function dropOtherSchemas(
  source: Pick<SourceConfig, "dialect" | "connection">,
  snapshot: Snapshot,
  schemas: readonly string[],
): { tables: number; schemas: (string | null)[]; removed: SnapshotTable[] } {
  if (!schemas.length) return { tables: 0, schemas: [], removed: [] };
  const wanted = schemaFilter(source, schemas);
  const out = new Set<string | null>();
  const removed: SnapshotTable[] = [];
  snapshot.tables = snapshot.tables.filter((t) => {
    if (wanted(t.schema)) return true;
    out.add(t.schema || null);
    removed.push(t);
    return false;
  });
  const names = [...out].filter((x): x is string => x !== null).sort();
  return { tables: removed.length, schemas: out.has(null) ? [...names, null] : names, removed };
}

// "a, b, (no schema)", at most ten names.
export function schemaListText(schemas: readonly (string | null)[]): string {
  const shown = schemas.slice(0, 10).map((s) => s ?? "(no schema)");
  return `${shown.join(", ")}${schemas.length > 10 ? `, and ${schemas.length - 10} more` : ""}`;
}

// "12 tables in 2 schemas", "3 tables in 1 schema or with no schema", "1 table with no schema".
export function droppedText(dropped: { tables: number; schemas: readonly (string | null)[] }): string {
  const named = dropped.schemas.filter((s) => s !== null).length;
  const tables = `${dropped.tables} table${dropped.tables === 1 ? "" : "s"}`;
  const none = named < dropped.schemas.length;
  if (!named) return `${tables} with no schema`;
  return `${tables} in ${named} schema${named === 1 ? "" : "s"}${none ? " or with no schema" : ""}`;
}

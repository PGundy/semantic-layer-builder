import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { patternFlags } from "../lib/export-filters.ts";
import { droppedText, dropOtherSchemas, insideRoot, intakeMode, intakeSchemas, schemaListText } from "../lib/intake.ts";
import { IMPORT_FORMATS, type ImportFormat, importSnapshot } from "../lib/importers/index.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope, unmatchedPatterns } from "../lib/patterns.ts";
import { listModels, loadProject, loadSnapshot, loadSource, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables, recordScope, scopeLines, selectionMatcher, tablesFlag } from "../lib/snapshot-diff.ts";
import { effectiveScope } from "../lib/table-list.ts";
import { RUNNABLE_DIALECTS, type Snapshot, type SnapshotTable, type SourceConfig } from "../lib/types.ts";

const normType = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

// Carries profiles over from the previous snapshot for columns whose name and type are unchanged.
// Returns the number of column profiles kept and the previous tables missing from the import.
function carryOver(next: Snapshot, prev: Snapshot | null): { kept: number; dropped: SnapshotTable[] } {
  if (!prev) return { kept: 0, dropped: [] };
  const old = new Map(prev.tables.map((t) => [qualifiedName(t).toLowerCase(), t]));
  const present = new Set<string>();
  let kept = 0;
  for (const t of next.tables) {
    const k = qualifiedName(t).toLowerCase();
    present.add(k);
    const before = old.get(k);
    if (!before) continue;
    const cols = new Map(before.columns.map((c) => [c.name.toLowerCase(), c]));
    let any = false;
    for (const c of t.columns) {
      const o = cols.get(c.name.toLowerCase());
      if (o?.profile && normType(o.type) === normType(c.type)) {
        c.profile = o.profile;
        kept++;
        any = true;
      }
    }
    if (any && before.profiled_at) t.profiled_at = before.profiled_at;
    if ((t.row_count === null || t.row_count === undefined) && typeof before.row_count === "number") t.row_count = before.row_count;
  }
  const dropped = prev.tables.filter((t) => !present.has(qualifiedName(t).toLowerCase()));
  return { kept, dropped };
}

// The file to import: --file (from the working directory), else an export source's
// intake.export.file (from the semantic root, and only inside it).
function importFile(root: string, cwd: string, source: SourceConfig, given: string | undefined): string {
  if (given) return resolve(cwd, given);
  const saved = intakeMode(source) === "export" ? source.intake?.export?.file : undefined;
  if (!saved) {
    throw new UserError(
      `--file is required: pass the export to import, as in sl import --source ${source.source} --file schema.csv` +
        " (an export source with intake.export.file set imports that file when --file is left out).",
    );
  }
  if (isAbsolute(saved) || !insideRoot(root, saved)) {
    throw new UserError(
      `intake.export.file in sources/${source.source}.yaml must be a path inside the semantic root; copy the export under the root, ` +
        "point intake.export.file at it and run sl validate, or pass --file.",
    );
  }
  const file = resolve(root, saved);
  if (!existsSync(file)) {
    throw new UserError(
      `intake.export.file in sources/${source.source}.yaml names ${saved}, which does not exist under the semantic root; ` +
        "copy the export there or fix the path and run sl validate, or pass --file.",
    );
  }
  return file;
}

const spec: CommandSpec = {
  summary: "Build the snapshot from a schema export, a dbt manifest or DDL.",
  usage:
    "import --source <source> [--file <path>] [--format information_schema|dbt_manifest|ddl] [--catalog <catalog.json>]\n" +
    "       [--include <pattern>]... [--exclude <pattern>]...\n\n" +
    "  --file is optional for an export source whose intake.export.file names the export (read from the semantic root).\n" +
    "  When the source file's intake.schemas lists schemas, only their tables are kept; the rest are dropped and counted.\n\n" +
    "  --format is read from the file when left out: a .sql file is ddl, a JSON object with nodes is dbt_manifest,\n" +
    "  a CSV or JSON array is information_schema.\n\n" +
    "  information_schema  CSV or JSON rows of information_schema.columns: table_schema, table_name, column_name,\n" +
    "                      data_type, is_nullable, ordinal_position; optional table_type, table_comment, row_count,\n" +
    "                      column_comment, and keys: is_primary_key, pk_ordinal, fk_name, fk_ordinal,\n" +
    "                      references_schema, references_table, references_column. `sl export-sql --dialect <d>`\n" +
    "                      prints a query that returns exactly these columns.\n" +
    "  dbt_manifest        target/manifest.json; add --catalog target/catalog.json for column types and row counts\n" +
    "  ddl                 a .sql file of CREATE TABLE / CREATE VIEW / COMMENT ON statements (pg_dump, get_ddl, SHOW CREATE TABLE)\n\n" +
    "  --include, --exclude  keep only the tables that match an include and no exclude (the scope pattern grammar),\n" +
    "                      such as the patterns sl export-sql lists for its query to leave to sl import;\n" +
    "                      they apply to the tables intake.schemas keeps.",
  options: {
    source: { type: "string" },
    format: { type: "string" },
    file: { type: "string" },
    catalog: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
  },
  writes: "whole",
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const format = str(values, "format");
    if (format !== undefined && !(IMPORT_FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`--format must be one of ${IMPORT_FORMATS.join(", ")}, or left out to read it from the file.`);
    }
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    const scope = effectiveScope(ctx.root, source);
    const fileArg = str(values, "file");
    const file = importFile(ctx.root, ctx.cwd, source, fileArg);
    // The file as messages name it: --file as given, else the path from the working directory.
    const shown = fileArg ?? (relative(ctx.cwd, file) || file);
    if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
    const catalogArg = str(values, "catalog");
    const catalog = catalogArg ? resolve(ctx.cwd, catalogArg) : undefined;
    if (catalog && !existsSync(catalog)) throw new UserError(`No such file: ${catalog}`);
    const include = patternFlags(values, "include");
    const exclude = patternFlags(values, "exclude");

    const { snapshot, warnings, format: used, detected } = await importSnapshot(source, format as ImportFormat | undefined, { file, catalog }, ctx.now().toISOString());
    if (!snapshot.tables.length) {
      throw new UserError(`No tables found in ${shown}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
    }
    // intake.schemas first, then --include and --exclude, before the snapshot is compared or saved.
    const kept = intakeSchemas(source);
    const left = dropOtherSchemas(source, snapshot, kept);
    if (!snapshot.tables.length) {
      throw new UserError(
        `None of the ${left.tables} tables in ${shown} is in intake.schemas (${kept.join(", ")}); the file holds ${schemaListText(left.schemas)}. ` +
          `Export the listed schemas, or fix intake.schemas in sources/${source.source}.yaml and run sl validate, then rerun sl import --source ${source.source}.`,
      );
    }
    if (left.tables) {
      warnings.push(
        `Dropped ${droppedText(left)} not in intake.schemas: ${schemaListText(left.schemas)}. ` +
          `To keep them, add the schema to intake.schemas in sources/${source.source}.yaml, run sl validate and rerun sl import --source ${source.source}.`,
      );
    }
    // Messages about the patterns say when intake.schemas already narrowed the file.
    const within = left.tables ? " within intake.schemas" : "";
    // Tables dropped here are counted in their own line, not again as lost from the previous snapshot.
    const counted = new Set(left.removed.map((t) => qualifiedName(t).toLowerCase()));
    let filters: { include: string[]; exclude: string[]; kept: number; dropped: number } | null = null;
    if (include.length || exclude.length) {
      const selection = { include, exclude };
      const read = snapshot.tables.length;
      for (const p of unmatchedPatterns(selection, snapshot.tables)) warnings.push(`Pattern "${p}" matches no table in ${shown}${within}.`);
      const matched = filterInScope(selection, snapshot.tables);
      const keep = new Set(matched);
      for (const t of snapshot.tables) if (!keep.has(t)) counted.add(qualifiedName(t).toLowerCase());
      snapshot.tables = matched;
      if (!snapshot.tables.length) {
        throw new UserError(
          `No table in ${shown}${within} matches --include and --exclude, so nothing was imported. ` +
            `Check the patterns against the table names in the file${left.tables ? " and the schemas in intake.schemas" : ""} and run sl import again.`,
        );
      }
      filters = { include, exclude, kept: snapshot.tables.length, dropped: read - snapshot.tables.length };
    }
    const previous = loadSnapshot(ctx.root, source.source);
    const diff = previous ? diffSnapshots(previous, snapshot) : null;
    const loadModels = () => listModels(ctx.root, source.source).map((l) => l.model);
    const scopeChanges = recordScope(previous, snapshot, selectionMatcher(source, scope), loadModels);
    const changes = diff && scopeChanges ? { ...diff, ...scopeChanges } : null;
    const { kept: profiles, dropped: missing } = carryOver(snapshot, previous);
    const dropped = missing.map((t) => qualifiedName(t)).filter((q) => !counted.has(q.toLowerCase()));
    if (profiles) warnings.push(`Kept the profiles of ${profiles} unchanged column${profiles === 1 ? "" : "s"} from the previous snapshot.`);
    if (dropped.length) {
      warnings.push(
        `${dropped.length} table${dropped.length === 1 ? " in the previous snapshot is" : "s in the previous snapshot are"} not in this import and ${dropped.length === 1 ? "was" : "were"} dropped: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}.`,
      );
    }
    saveSnapshot(ctx.root, snapshot);

    const columns = snapshot.tables.reduce((n, t) => n + t.columns.length, 0);
    const primaryKeys = snapshot.tables.filter((t) => (t.primary_key ?? []).length).length;
    const foreignKeys = snapshot.tables.reduce((n, t) => n + (t.foreign_keys ?? []).length, 0);
    const inScope = filterInScope(scope, snapshot.tables).length;
    const { focus_threshold } = projectSettings(project);
    const next =
      inScope > focus_threshold
        ? `sl tables --source ${source.source} --groups`
        : snapshot.scope_state?.left_scope.length
          ? "sl status"
          : RUNNABLE_DIALECTS.includes(source.dialect)
            ? `sl profile --source ${source.source}`
            : `sl draft --source ${source.source}${tablesFlag(snapshot.scope_state?.new_in_scope ?? [])}`;

    if (ctx.json) {
      ctx.out(
        formatJson({
          source: source.source,
          method: snapshot.method,
          format: used,
          format_detected: detected,
          tables: snapshot.tables.length,
          columns,
          primary_keys: primaryKeys,
          foreign_keys: foreignKeys,
          dropped: { tables: left.tables, schemas: left.schemas },
          warnings,
          changes,
          next,
          ...(filters ? { filters } : {}),
        }),
      );
      return 0;
    }
    const lines = [
      `Imported ${snapshot.tables.length} table${snapshot.tables.length === 1 ? "" : "s"} and ${columns} column${columns === 1 ? "" : "s"} ` +
        `(${primaryKeys} with a primary key, ${foreignKeys} foreign key${foreignKeys === 1 ? "" : "s"}) from ${used}${detected ? " (read from the file)" : ""} into snapshots/${source.source}.json.`,
    ];
    if (filters) {
      lines.push(
        `Kept the ${filters.kept} table${filters.kept === 1 ? "" : "s"} matching --include and --exclude; dropped ${filters.dropped} other${filters.dropped === 1 ? "" : "s"} ${left.tables ? "of the tables intake.schemas keeps" : "from the file"}.`,
      );
    }
    if (warnings.length) lines.push("Warnings:", ...warnings.map((w) => `  - ${w}`));
    const modeled = diff ? modeledTables(snapshot, loadModels, scope) : undefined;
    lines.push(...changeLines(diff, source.source, modeled), ...scopeLines(scopeChanges, source.source, diff?.tables_removed));
    lines.push(
      inScope > focus_threshold
        ? `Next: ${inScope} tables are in scope, more than the focus threshold of ${focus_threshold}. Run \`${next}\` and choose which tables to focus on.`
        : `Next: \`${next}\`.`,
    );
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

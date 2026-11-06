import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { droppedText, dropOtherSchemas, insideRoot, intakeMode, intakeSchemas, schemaListText } from "../lib/intake.ts";
import { IMPORT_FORMATS, type ImportFormat, importSnapshot } from "../lib/importers/index.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope } from "../lib/patterns.ts";
import { listModels, loadProject, loadSnapshot, loadSource, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables } from "../lib/snapshot-diff.ts";
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
    "import --source <source> [--file <path>] [--format information_schema|dbt_manifest|ddl] [--catalog <catalog.json>]\n\n" +
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
    "  ddl                 a .sql file of CREATE TABLE / CREATE VIEW / COMMENT ON statements (pg_dump, get_ddl, SHOW CREATE TABLE)",
  options: {
    source: { type: "string" },
    format: { type: "string" },
    file: { type: "string" },
    catalog: { type: "string" },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const format = str(values, "format");
    if (format !== undefined && !(IMPORT_FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`--format must be one of ${IMPORT_FORMATS.join(", ")}, or left out to read it from the file.`);
    }
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    const file = importFile(ctx.root, ctx.cwd, source, str(values, "file"));
    if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
    const catalogArg = str(values, "catalog");
    const catalog = catalogArg ? resolve(ctx.cwd, catalogArg) : undefined;
    if (catalog && !existsSync(catalog)) throw new UserError(`No such file: ${catalog}`);

    const { snapshot, warnings, format: used, detected } = await importSnapshot(source, format as ImportFormat | undefined, { file, catalog }, ctx.now().toISOString());
    if (!snapshot.tables.length) {
      throw new UserError(`No tables found in ${file}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
    }
    const kept = intakeSchemas(source);
    const left = dropOtherSchemas(source, snapshot, kept);
    if (!snapshot.tables.length) {
      throw new UserError(
        `None of the ${left.tables} tables in ${file} is in intake.schemas (${kept.join(", ")}); the file holds ${schemaListText(left.schemas)}. ` +
          `Export the listed schemas, or fix intake.schemas in sources/${source.source}.yaml and run sl validate, then rerun sl import --source ${source.source}.`,
      );
    }
    if (left.tables) {
      warnings.push(
        `Dropped ${droppedText(left)} not in intake.schemas: ${schemaListText(left.schemas)}. ` +
          `To keep them, add the schema to intake.schemas in sources/${source.source}.yaml, run sl validate and rerun sl import --source ${source.source}.`,
      );
    }
    const previous = loadSnapshot(ctx.root, source.source);
    const changes = previous ? diffSnapshots(previous, snapshot) : null;
    const { kept: profiles, dropped: missing } = carryOver(snapshot, previous);
    // Tables the file holds outside intake.schemas are already counted in the line above.
    const counted = new Set(left.removed.map((t) => qualifiedName(t).toLowerCase()));
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
    const inScope = filterInScope(source.scope, snapshot.tables).length;
    const { focus_threshold } = projectSettings(project);
    const next =
      inScope > focus_threshold
        ? `sl tables --source ${source.source} --groups`
        : RUNNABLE_DIALECTS.includes(source.dialect)
          ? `sl profile --source ${source.source}`
          : `sl draft --source ${source.source}`;

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
        }),
      );
      return 0;
    }
    const lines = [
      `Imported ${snapshot.tables.length} table${snapshot.tables.length === 1 ? "" : "s"} and ${columns} column${columns === 1 ? "" : "s"} ` +
        `(${primaryKeys} with a primary key, ${foreignKeys} foreign key${foreignKeys === 1 ? "" : "s"}) from ${used}${detected ? " (read from the file)" : ""} into snapshots/${source.source}.json.`,
    ];
    if (warnings.length) lines.push("Warnings:", ...warnings.map((w) => `  - ${w}`));
    const modeled = changes ? modeledTables(snapshot, () => listModels(ctx.root, source.source).map((l) => l.model), source.scope) : undefined;
    lines.push(...changeLines(changes, source.source, modeled));
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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { patternFlags } from "../lib/export-filters.ts";
import { IMPORT_FORMATS, type ImportFormat, importSnapshot } from "../lib/importers/index.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope, unmatchedPatterns } from "../lib/patterns.ts";
import { listModels, loadProject, loadSnapshot, loadSource, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables } from "../lib/snapshot-diff.ts";
import { effectiveScope } from "../lib/table-list.ts";
import { RUNNABLE_DIALECTS, type Snapshot } from "../lib/types.ts";

const normType = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

// Carries profiles over from the previous snapshot for columns whose name and type are unchanged.
// Returns the number of column profiles kept and the previous tables missing from the import.
function carryOver(next: Snapshot, prev: Snapshot | null): { kept: number; dropped: string[] } {
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
  const dropped = prev.tables.map((t) => qualifiedName(t)).filter((q) => !present.has(q.toLowerCase()));
  return { kept, dropped };
}

const spec: CommandSpec = {
  summary: "Build the snapshot from a schema export, a dbt manifest or DDL.",
  usage:
    "import --source <source> --file <path> [--format information_schema|dbt_manifest|ddl] [--catalog <catalog.json>]\n" +
    "       [--include <pattern>]... [--exclude <pattern>]...\n\n" +
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
    "                      such as the patterns sl export-sql lists for its query to leave to sl import.",
  options: {
    source: { type: "string" },
    format: { type: "string" },
    file: { type: "string" },
    catalog: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
  },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const format = str(values, "format");
    if (format !== undefined && !(IMPORT_FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`--format must be one of ${IMPORT_FORMATS.join(", ")}, or left out to read it from the file.`);
    }
    const fileArg = str(values, "file");
    if (!fileArg) throw new UserError("--file is required.");
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    const scope = effectiveScope(ctx.root, source);
    const file = resolve(ctx.cwd, fileArg);
    if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
    const catalogArg = str(values, "catalog");
    const catalog = catalogArg ? resolve(ctx.cwd, catalogArg) : undefined;
    if (catalog && !existsSync(catalog)) throw new UserError(`No such file: ${catalog}`);
    const include = patternFlags(values, "include");
    const exclude = patternFlags(values, "exclude");

    const { snapshot, warnings, format: used, detected } = await importSnapshot(source, format as ImportFormat | undefined, { file, catalog }, ctx.now().toISOString());
    if (!snapshot.tables.length) {
      throw new UserError(`No tables found in ${file}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
    }
    // --include and --exclude keep the selected tables, before the snapshot is compared or saved.
    let filters: { include: string[]; exclude: string[]; kept: number; dropped: number } | null = null;
    if (include.length || exclude.length) {
      const selection = { include, exclude };
      const read = snapshot.tables.length;
      for (const p of unmatchedPatterns(selection, snapshot.tables)) warnings.push(`Pattern "${p}" matches no table in ${fileArg}.`);
      snapshot.tables = filterInScope(selection, snapshot.tables);
      if (!snapshot.tables.length) {
        throw new UserError(
          `No table in ${fileArg} matches --include and --exclude, so nothing was imported. ` +
            `Check the patterns against the table names in the file and run sl import again.`,
        );
      }
      filters = { include, exclude, kept: snapshot.tables.length, dropped: read - snapshot.tables.length };
    }
    const previous = loadSnapshot(ctx.root, source.source);
    const changes = previous ? diffSnapshots(previous, snapshot) : null;
    const { kept, dropped } = carryOver(snapshot, previous);
    if (kept) warnings.push(`Kept the profiles of ${kept} unchanged column${kept === 1 ? "" : "s"} from the previous snapshot.`);
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
        `Kept the ${filters.kept} table${filters.kept === 1 ? "" : "s"} matching --include and --exclude; dropped ${filters.dropped} other${filters.dropped === 1 ? "" : "s"} from the file.`,
      );
    }
    if (warnings.length) lines.push("Warnings:", ...warnings.map((w) => `  - ${w}`));
    const modeled = changes ? modeledTables(snapshot, () => listModels(ctx.root, source.source).map((l) => l.model), scope) : undefined;
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

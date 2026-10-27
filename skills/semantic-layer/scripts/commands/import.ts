import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { IMPORT_FORMATS, type ImportFormat, importSnapshot } from "../lib/importers/index.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope } from "../lib/patterns.ts";
import { listModels, loadProject, loadSnapshot, loadSource, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables } from "../lib/snapshot-diff.ts";
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
  summary: "Build the snapshot from an information_schema export, a dbt manifest or DDL.",
  usage:
    "import --source <source> --format information_schema|dbt_manifest|ddl --file <path> [--catalog <catalog.json>]\n\n" +
    "  information_schema  CSV or JSON rows of information_schema.columns: table_schema, table_name, column_name,\n" +
    "                      data_type, is_nullable, ordinal_position; optional table_type, description, row_count\n" +
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
    if (!format || !(IMPORT_FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`--format is required: one of ${IMPORT_FORMATS.join(", ")}.`);
    }
    const fileArg = str(values, "file");
    if (!fileArg) throw new UserError("--file is required.");
    const project = loadProject(ctx.root);
    const source = loadSource(ctx.root, sourceName);
    const file = resolve(ctx.cwd, fileArg);
    if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
    const catalogArg = str(values, "catalog");
    const catalog = catalogArg ? resolve(ctx.cwd, catalogArg) : undefined;
    if (catalog && !existsSync(catalog)) throw new UserError(`No such file: ${catalog}`);

    const { snapshot, warnings } = await importSnapshot(source, format as ImportFormat, { file, catalog }, ctx.now().toISOString());
    if (!snapshot.tables.length) {
      throw new UserError(`No tables found in ${file}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
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
          tables: snapshot.tables.length,
          columns,
          primary_keys: primaryKeys,
          foreign_keys: foreignKeys,
          warnings,
          changes,
          next,
        }),
      );
      return 0;
    }
    const lines = [
      `Imported ${snapshot.tables.length} table${snapshot.tables.length === 1 ? "" : "s"} and ${columns} column${columns === 1 ? "" : "s"} ` +
        `(${primaryKeys} with a primary key, ${foreignKeys} foreign key${foreignKeys === 1 ? "" : "s"}) from ${format} into snapshots/${source.source}.json.`,
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

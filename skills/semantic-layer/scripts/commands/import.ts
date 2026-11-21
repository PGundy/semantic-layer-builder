import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { writeDrift } from "../lib/drift-record.ts";
import { projectEntries } from "./baseline.ts";
import { type DbtEdits, toEdits } from "../lib/dbt-edits.ts";
import { UserError } from "../lib/errors.ts";
import { patternFlags } from "../lib/export-filters.ts";
import { droppedText, dropOtherSchemas, insideRoot, intakeMode, intakeSchemas, schemaListText } from "../lib/intake.ts";
import { placeDbtSemantic, semanticJson, semanticLines } from "../lib/importers/dbt-semantic.ts";
import { IMPORT_FORMATS, type ImportFormat, importSnapshot } from "../lib/importers/index.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { filterInScope, unmatchedPatterns } from "../lib/patterns.ts";
import { listModels, loadMetrics, loadProject, loadSnapshot, loadSource, projectSettings, saveSnapshot } from "../lib/project.ts";
import { changeLines, diffSnapshots, modeledTables, recordScope, scopeLines, selectionMatcher, tablesFlag } from "../lib/snapshot-diff.ts";
import { shellQuote } from "../lib/ledger.ts";
import { writeFileAtomic } from "../lib/lock.ts";
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
      `--file is required: pass the export to import, as in semlayer import --source ${source.source} --file schema.csv` +
        " (an export source with intake.export.file set imports that file when --file is left out).",
    );
  }
  if (isAbsolute(saved) || !insideRoot(root, saved)) {
    throw new UserError(
      `intake.export.file in sources/${source.source}.yaml must be a path inside the semantic root; copy the export under the root, ` +
        "point intake.export.file at it and run semlayer validate, or pass --file.",
    );
  }
  const file = resolve(root, saved);
  if (!existsSync(file)) {
    throw new UserError(
      `intake.export.file in sources/${source.source}.yaml names ${saved}, which does not exist under the semantic root; ` +
        "copy the export there or fix the path and run semlayer validate, or pass --file.",
    );
  }
  return file;
}

// Where --emit writes: the path given, resolved from the working directory as --file is (and as
// semlayer apply --file reads it), and it must lie inside the semantic root, also through a link in
// an existing parent, as baseline --out must. Refused: a path outside the root, one of the project's own
// files or directories, a link, a directory, a missing parent and an existing file, so a layer file or an
// earlier edits file is never replaced.
function emitPath(root: string, cwd: string, given: string): string {
  const base = resolve(root);
  // A path that works from the working directory, for the messages: the semantic root is often a folder below it.
  const example = `--emit ${relative(resolve(cwd), join(base, "edits.json")) || "edits.json"}`;
  if (!given.trim()) throw new UserError(`--emit needs a file path, such as ${example}.`);
  const target = resolve(cwd, given);
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new UserError(`--emit ${given} is outside the semantic root ${root}; give a path inside it, such as ${example}.`);
  }
  const parent = dirname(target);
  if (!existsSync(parent)) throw new UserError(`The folder ${parent} does not exist; create it or give another path with --emit.`);
  const realRoot = realpathSync(base);
  const realRel = relative(realRoot, realpathSync(parent));
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new UserError(`--emit ${given} leads outside the semantic root ${root} through a link; give a path inside it.`);
  }
  const own = projectEntries(base);
  const norm = join(realRel, basename(target)).split(sep).join("/").toLowerCase();
  if (own.files.includes(norm)) throw new UserError(`--emit ${given} is one of the project's own files; give another path, such as ${example}.`);
  const dir0 = [...own.dirs, ".semlayer"].find((d) => norm === d || norm.startsWith(`${d}/`));
  if (dir0) throw new UserError(`--emit ${given} is inside the project's ${dir0}/ directory, which semlayer manages; give another path, such as ${example}.`);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new UserError(`${given} is a symbolic link; give a plain file path with --emit.`);
  if (stat?.isDirectory()) throw new UserError(`${given} is a directory; give a file path with --emit, such as ${example}.`);
  if (stat) throw new UserError(`${given} already exists, so it is not overwritten. Remove it or give another path with --emit.`);
  return target;
}

const argText = (p: string): string => (/^[A-Za-z0-9_./-]+$/.test(p) ? p : shellQuote(p));

function emitLines(source: string, shown: string, e: DbtEdits, written: boolean): string[] {
  const n = (kind: string) => e.items.filter((i) => i.kind === kind).length;
  const lines = [
    written
      ? `Wrote ${e.edits.length} edit${e.edits.length === 1 ? "" : "s"} to ${shown} (${n("dimension")} dimensions, ${n("measure")} measures, ${n("join")} joins, ${n("metric")} metrics), each a draft described as from the dbt manifest. Nothing in the layer changed.`
      : "Nothing to emit: every item is already in the layer or was skipped, so no edits file was written.",
  ];
  if (e.skipped.length) lines.push("Not emitted, with the reason:", ...e.skipped.map((x) => `  - ${x.kind} ${x.name}: ${x.reason}`));
  for (const u of e.undrafted) lines.push(`Not drafted yet: semantic model ${u.model} (table ${u.table}); run \`${u.command}\` first, then import again.`);
  if (written) lines.push(`Next: \`semlayer apply --file ${argText(shown)}\`, then semlayer validate and semlayer status (every item is a draft until the owner says yes on a readback).`);
  return lines;
}

const spec: CommandSpec = {
  summary: "Build the snapshot from a schema export, a dbt manifest or DDL.",
  usage:
    "import --source <source> [--file <path>] [--format information_schema|dbt_manifest|ddl] [--catalog <catalog.json>]\n" +
    "       [--include <pattern>]... [--exclude <pattern>]... [--semantic [--emit <file>]] [--replace-snapshot]\n\n" +
    "  --file is optional for an export source whose intake.export.file names the export (read from the semantic root).\n" +
    "  When the source file's intake.schemas lists schemas, only their tables are kept; the rest are dropped and counted.\n\n" +
    "  --format is read from the file when left out: a .sql file is ddl, a JSON object with nodes is dbt_manifest,\n" +
    "  a CSV or JSON array is information_schema.\n\n" +
    "  information_schema  CSV or JSON rows of information_schema.columns: table_schema, table_name, column_name,\n" +
    "                      data_type, is_nullable, ordinal_position; optional table_type, table_comment, row_count,\n" +
    "                      column_comment, and keys: is_primary_key, pk_ordinal, fk_name, fk_ordinal,\n" +
    "                      references_schema, references_table, references_column. `semlayer export-sql --dialect <d>`\n" +
    "                      prints a query that returns exactly these columns.\n" +
    "  dbt_manifest        target/manifest.json; add --catalog target/catalog.json for column types and row counts\n" +
    "  ddl                 a .sql file of CREATE TABLE / CREATE VIEW / COMMENT ON statements (pg_dump, get_ddl, SHOW CREATE TABLE)\n\n" +
    "  --include, --exclude  keep only the tables that match an include and no exclude (the scope pattern grammar),\n" +
    "                      such as the patterns semlayer export-sql lists for its query to leave to semlayer import;\n" +
    "                      they apply to the tables intake.schemas keeps.\n\n" +
    "  --semantic          with a dbt manifest, also report its semantic models and metrics: counts, join candidates and what\n" +
    "                      was skipped, with a reason for each. It reads only; no layer file is written. When the source's snapshot\n" +
    "                      was taken from the database, that snapshot is kept (not replaced by the manifest's) and the models are\n" +
    "                      placed against its tables.\n\n" +
    "  --replace-snapshot  a source whose snapshot was taken from the database (semlayer introspect) is not replaced by a file's: a plain\n" +
    "                      import is refused, writing nothing, because the file usually holds fewer keys and less exact types. Pass this when\n" +
    "                      the file really is meant to replace it. A source with no snapshot, an export source and a snapshot made from a\n" +
    "                      file are imported as before. A replaced snapshot is recorded in .semlayer/drift.json as semlayer introspect does.\n\n" +
    "  --emit <file>       with --semantic, also write the manifest's dimensions, measures, joins and metrics as typed edits for\n" +
    "                      models already drafted, ready for semlayer apply --file <file>. Every edit is a draft described as from\n" +
    "                      the dbt manifest; a join is inferred. Names already in the layer are left as they are and listed, as is each\n" +
    "                      item that could not be mapped. The file is a new path inside the semantic root, never an existing file or one of the project's own files or directories.",
  options: {
    source: { type: "string" },
    format: { type: "string" },
    file: { type: "string" },
    catalog: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    semantic: { type: "boolean" },
    "replace-snapshot": { type: "boolean" },
    emit: { type: "string" },
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

    const wantSemantic = values.semantic === true;
    const emitArg = str(values, "emit");
    if (emitArg !== undefined && !wantSemantic) throw new UserError("--emit goes with --semantic: run semlayer import --source <s> --file <manifest> --semantic --emit edits.json.");
    const emitTo = emitArg === undefined ? undefined : emitPath(ctx.root, ctx.cwd, emitArg);
    const { snapshot, warnings, format: used, detected, semantic } = await importSnapshot(
      source,
      format as ImportFormat | undefined,
      { file, catalog, semantic: wantSemantic },
      ctx.now().toISOString(),
    );
    // With --semantic, a snapshot taken from the database is kept: the manifest is read for its semantic
    // models and metrics, and they are placed against the tables the database really has.
    const previous = loadSnapshot(ctx.root, source.source);
    const keep = wantSemantic && previous?.method === "live" ? previous : null;
    if (!keep && !snapshot.tables.length) {
      throw new UserError(`No tables found in ${shown}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
    }
    // intake.schemas first, then --include and --exclude, before the snapshot is compared or saved.
    const kept = intakeSchemas(source);
    const left = dropOtherSchemas(source, snapshot, kept);
    if (!keep && !snapshot.tables.length) {
      throw new UserError(
        `None of the ${left.tables} tables in ${shown} is in intake.schemas (${kept.join(", ")}); the file holds ${schemaListText(left.schemas)}. ` +
          `Export the listed schemas, or fix intake.schemas in sources/${source.source}.yaml and run semlayer validate, then rerun semlayer import --source ${source.source}.`,
      );
    }
    if (left.tables && !keep) {
      warnings.push(
        `Dropped ${droppedText(left)} not in intake.schemas: ${schemaListText(left.schemas)}. ` +
          `To keep them, add the schema to intake.schemas in sources/${source.source}.yaml, run semlayer validate and rerun semlayer import --source ${source.source}.`,
      );
    }
    // Messages about the patterns say when intake.schemas already narrowed the file.
    const within = left.tables ? " within intake.schemas" : "";
    // Tables dropped here are counted in their own line, not again as lost from the previous snapshot.
    const counted = new Set(left.removed.map((t) => qualifiedName(t).toLowerCase()));
    let filters: { include: string[]; exclude: string[]; kept: number; dropped: number } | null = null;
    if (keep && values["replace-snapshot"] === true) {
      warnings.push("--replace-snapshot was not used: --semantic keeps the snapshot from the database. Rerun without --semantic to replace it with the file's.");
    }
    if (keep && (include.length || exclude.length)) {
      warnings.push("--include and --exclude were not applied: no snapshot was written, so there is nothing to narrow. Narrow the scope with semlayer scope instead.");
    } else if (include.length || exclude.length) {
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
            `Check the patterns against the table names in the file${left.tables ? " and the schemas in intake.schemas" : ""} and run semlayer import again.`,
        );
      }
      filters = { include, exclude, kept: snapshot.tables.length, dropped: read - snapshot.tables.length };
    }
    // A database snapshot holds keys, exact types and row estimates a file usually lacks: replacing it is deliberate.
    if (!keep && previous?.method === "live" && intakeMode(source) !== "export" && values["replace-snapshot"] !== true) {
      const keys = (s: Snapshot) => ({ pk: s.tables.filter((t) => (t.primary_key ?? []).length).length, fk: s.tables.reduce((n, t) => n + (t.foreign_keys ?? []).length, 0) });
      const had = keys(previous);
      const has = keys(snapshot);
      const s = source.source;
      throw new UserError(
        `Nothing was written: the snapshot of "${s}" was read from the database (${previous.tables.length} tables, ${had.pk} with a primary key, ${had.fk} foreign keys) and ${shown} would replace it ` +
          `(${snapshot.tables.length} tables, ${has.pk} with a primary key, ${has.fk} foreign keys); drafts, join checks and validation read those keys and exact types. ` +
          `To refresh from the database run \`semlayer introspect --source ${s}\`; ` +
          `${used === "dbt_manifest" ? "to read only the manifest's semantic models and metrics and keep the snapshot, rerun the same command with --semantic; " : ""}` +
          `if the file is meant to replace the snapshot, rerun the same command with --replace-snapshot.`,
        `semlayer introspect --source ${s}`,
        "snapshot_from_database",
      );
    }
    const diff = previous && !keep ? diffSnapshots(previous, snapshot, { byFamily: previous.method !== snapshot.method }) : null;
    const loadModels = () => listModels(ctx.root, source.source).map((l) => l.model);
    const scopeChanges = recordScope(previous, snapshot, selectionMatcher(source, scope), loadModels);
    const changes = diff && scopeChanges ? { ...diff, ...scopeChanges } : null;
    const { kept: profiles, dropped: missing } = keep ? { kept: 0, dropped: [] } : carryOver(snapshot, previous);
    const dropped = missing.map((t) => qualifiedName(t)).filter((q) => !counted.has(q.toLowerCase()));
    if (profiles) warnings.push(`Kept the profiles of ${profiles} unchanged column${profiles === 1 ? "" : "s"} from the previous snapshot.`);
    if (dropped.length) {
      warnings.push(
        `${dropped.length} table${dropped.length === 1 ? " in the previous snapshot is" : "s in the previous snapshot are"} not in this import and ${dropped.length === 1 ? "was" : "were"} dropped: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}.`,
      );
    }
    // The drift record is written first, so a refusal there leaves the snapshot as it was.
    if (diff) writeDrift(ctx.root, { source: source.source, dialect: source.dialect, snapshot, diff, at: ctx.now().toISOString(), unreadable: [], methods: { from: previous!.method, to: snapshot.method }, models: loadModels });
    if (!keep) saveSnapshot(ctx.root, snapshot);
    // The snapshot the layer reads: the one kept, else the one just written.
    const current = keep ?? snapshot;
    const outside = semantic ? placeDbtSemantic(semantic, current.tables, left.removed) : [];
    let emitted: DbtEdits | undefined;
    if (semantic && emitTo) {
      const models = listModels(ctx.root, source.source).map((l) => l.model);
      emitted = toEdits(semantic, { source, snapshot: current, models, metricNames: (loadMetrics(ctx.root).metrics ?? []).map((m) => String(m?.name)), outside });
      if (emitted.edits.length) writeFileAtomic(emitTo, `${JSON.stringify({ edits: emitted.edits }, null, 2)}\n`, { exclusive: true });
    }

    const columns = current.tables.reduce((n, t) => n + t.columns.length, 0);
    const primaryKeys = current.tables.filter((t) => (t.primary_key ?? []).length).length;
    const foreignKeys = current.tables.reduce((n, t) => n + (t.foreign_keys ?? []).length, 0);
    const inScope = filterInScope(scope, current.tables).length;
    const { focus_threshold } = projectSettings(project);
    const next =
      inScope > focus_threshold
        ? `semlayer tables --source ${source.source} --groups`
        : current.scope_state?.left_scope.length
          ? "semlayer status"
          : RUNNABLE_DIALECTS.includes(source.dialect)
            ? `semlayer profile --source ${source.source}`
            : `semlayer draft --source ${source.source}${tablesFlag(current.scope_state?.new_in_scope ?? [])}`;

    if (ctx.json) {
      ctx.out(
        formatJson({
          source: source.source,
          method: current.method,
          format: used,
          format_detected: detected,
          // With the snapshot kept, method, tables, columns and the key counts describe the kept snapshot.
          ...(keep ? { snapshot_kept: true } : {}),
          tables: current.tables.length,
          columns,
          primary_keys: primaryKeys,
          foreign_keys: foreignKeys,
          dropped: { tables: left.tables, schemas: left.schemas },
          warnings,
          changes,
          next,
          ...(filters ? { filters } : {}),
          ...(semantic ? { semantic: semanticJson(semantic, outside) } : {}),
          ...(emitted
            ? {
                emit: {
                  file: emitArg,
                  written: emitted.edits.length > 0,
                  edits: emitted.edits.length,
                  items: emitted.items,
                  skipped: emitted.skipped,
                  undrafted: emitted.undrafted,
                  next: emitted.edits.length ? `semlayer apply --file ${argText(emitArg!)}` : next,
                },
              }
            : {}),
        }),
      );
      return 0;
    }
    const lines = keep
      ? [
          `Kept the snapshot from the database (snapshots/${source.source}.json: ${keep.tables.length} table${keep.tables.length === 1 ? "" : "s"}, ${primaryKeys} with a primary key, ${foreignKeys} foreign key${foreignKeys === 1 ? "" : "s"}); only the manifest's semantic models and metrics were read.`,
        ]
      : [
          `Imported ${snapshot.tables.length} table${snapshot.tables.length === 1 ? "" : "s"} and ${columns} column${columns === 1 ? "" : "s"} ` +
            `(${primaryKeys} with a primary key, ${foreignKeys} foreign key${foreignKeys === 1 ? "" : "s"}) from ${used}${detected ? " (read from the file)" : ""} into snapshots/${source.source}.json.`,
        ];
    if (filters) {
      lines.push(
        `Kept the ${filters.kept} table${filters.kept === 1 ? "" : "s"} matching --include and --exclude; dropped ${filters.dropped} other${filters.dropped === 1 ? "" : "s"} ${left.tables ? "of the tables intake.schemas keeps" : "from the file"}.`,
      );
    }
    if (semantic) lines.push(...semanticLines(semantic, outside));
    if (emitted) lines.push(...emitLines(source.source, emitArg!, emitted, emitted.edits.length > 0));
    if (warnings.length) lines.push("Warnings:", ...warnings.map((w) => `  - ${w}`));
    const modeled = diff ? modeledTables(snapshot, loadModels, scope) : undefined;
    if (!keep) lines.push(...changeLines(diff, source.source, modeled), ...scopeLines(scopeChanges, source.source, diff?.tables_removed));
    if (!emitted?.edits.length) {
      lines.push(
        inScope > focus_threshold
          ? `Next: ${inScope} tables are in scope, more than the focus threshold of ${focus_threshold}. Run \`${next}\` and choose which tables to focus on.`
          : `Next: \`${next}\`.`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { redactCredentials } from "../lib/credentials.ts";
import { UserError } from "../lib/errors.ts";
import { patternFlags } from "../lib/export-filters.ts";
import { intakeMode, intakeSchemas, SCHEMA_NAME_HINT, schemaListIssues } from "../lib/intake.ts";
import { qualifiedName } from "../lib/naming.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { filterInScope } from "../lib/patterns.ts";
import { listModels, loadProject, loadSnapshot, loadSource, paths, projectSettings } from "../lib/project.ts";
import { applySourceState, listChange, type ListChange, patternKey, projectName, scopePreview, type SourceState } from "../lib/setup.ts";
import { changeLines, type SnapshotDiff } from "../lib/snapshot-diff.ts";
import { type Contradiction, contradictedRefs, dropExportIntake, findContradictions } from "../lib/upgrade.ts";
import { profileState } from "../lib/status.ts";
import { effectiveScope, parseTableList, problemsMessage, rootPath } from "../lib/table-list.ts";
import { DIALECTS, NAME_PATTERN, RUNNABLE_DIALECTS, type Dialect, type Snapshot, type SourceConfig } from "../lib/types.ts";
import { editYamlText, parseYamlText } from "../lib/yaml.ts";
import { checkEnv, many, NOT_A_FILE, parseViews, refuseCredentials } from "./add-source.ts";
import checkJoinCommand from "./check-join.ts";
import importCommand from "./import.ts";
import initCommand from "./init.ts";
import introspectCommand from "./introspect.ts";
import profileCommand from "./profile.ts";

const CONNECTION_FIRST =
  "sl setup needs a connection, or a schema export when a connection is not possible. A connection gives a much better layer: " +
  "the tool can measure which values exist and how often, which keys are unique, how tables join and whether a join repeats rows, " +
  "and check figures the owner trusts (profiles, join evidence, goldens). Pass --env <VAR>, the name of the environment variable " +
  "that holds the connection URL (for a duckdb source, --database <path> or --view name=relation). Only when a connection is not " +
  'possible, pass --export <file> with --reason "<why>": the layer then starts from table definitions alone.';

type CopyStatus = "added" | "replaced" | "removed" | null;

interface Copy {
  to: string;
  rel: string;
  data: Buffer;
  status: CopyStatus;
}

// A file copied under the semantic root at `rel`, or null when `from` already is that file.
function plannedCopy(root: string, from: string, rel: string, what: string): Copy {
  const to = rootPath(root, rel, what);
  const data = readFileSync(from);
  if (resolve(from) === to || !existsSync(to)) return { to, rel, data, status: resolve(from) === to ? null : "added" };
  if (!statSync(to).isFile()) throw new UserError(`${rel} is not a file; move it away and run sl setup again.`);
  return { to, rel, data, status: readFileSync(to).equals(data) ? null : "replaced" };
}

// A file the user names, from the working directory.
function inputFile(ctx: CommandContext, arg: string, flag: string, what: string): string {
  const path = resolve(ctx.cwd, arg);
  if (!arg.trim() || !existsSync(path) || !statSync(path).isFile()) throw new UserError(`${flag}: no file at ${path}. Give the path of ${what}.`);
  return path;
}

// Runs another command's run with its output captured as JSON, so setup reports one result.
async function runQuiet(command: CommandSpec, values: Record<string, string | boolean>, ctx: CommandContext): Promise<Record<string, unknown>> {
  const out: string[] = [];
  await command.run({ values, positionals: [] }, { ...ctx, json: true, out: (t) => out.push(t) });
  return JSON.parse(out.join("\n") || "{}") as Record<string, unknown>;
}

interface UpgradeReport {
  profiled: string[];
  joins_checked: string[];
  joins_skipped: { ref: string; reason: string }[];
  contradictions: Contradiction[];
}

// The upgrade's steps after introspect: profiles the in-scope tables (none when no table or more
// than the focus threshold are in scope), checks every join with check-join --all, and lists the
// items the evidence contradicts against the exported snapshot. `backup` keeps each model file
// before check-join writes evidence into it, so a failure puts it back.
async function upgradeSteps(ctx: CommandContext, name: string, exported: Snapshot | null, backup: (path: string) => void): Promise<UpgradeReport> {
  const source = loadSource(ctx.root, name);
  const inScope = filterInScope(effectiveScope(ctx.root, source), loadSnapshot(ctx.root, name)?.tables ?? []).length;
  const focused = inScope > 0 && inScope <= projectSettings(loadProject(ctx.root)).focus_threshold;
  const profile = focused ? await runQuiet(profileCommand, { source: name }, ctx) : {};
  const profiled = ((profile.profiled ?? []) as { table: string }[]).map((t) => t.table);
  for (const l of listModels(ctx.root, name)) backup(l.path);
  const joins = await runQuiet(checkJoinCommand, { source: name, all: true }, ctx);
  const checks = (joins.checks ?? []) as { model: string; join: string; evidence: unknown; sentence: string }[];
  const skipped = (joins.skipped ?? []) as { model: string; join: string; reason: string }[];
  const ref = (x: { model: string; join: string }) => `${name}.${x.model}.${x.join}`;
  const models = listModels(ctx.root, name).map((l) => l.model);
  return {
    profiled,
    joins_checked: checks.filter((c) => c.evidence).map(ref),
    joins_skipped: [...skipped.map((x) => ({ ref: ref(x), reason: x.reason })), ...checks.filter((c) => !c.evidence).map((c) => ({ ref: ref(c), reason: c.sentence }))],
    contradictions: findContradictions(name, source.dialect, exported, loadSnapshot(ctx.root, name)!, models),
  };
}

// What the upgrade did and found, for the text output; null `report` when the dialect is not read.
function upgradeLines(rel: string, name: string, exportFile: string | undefined, report: UpgradeReport | null): string[] {
  const kept = exportFile ? ` The export ${exportFile} stays on disk.` : "";
  const lines = [`Upgraded ${name} from a schema export to a connection: ${rel} now has intake.mode connection, without intake.reason or intake.export.${kept}`];
  if (!report) return [...lines, "Profiles and join checks follow once the catalog is read through the query plan below."];
  lines.push(report.profiled.length ? `Profiled ${plural(report.profiled.length, "table")}.` : "Profiled no table: none is in scope, or more than the focus threshold are.");
  lines.push(`Checked ${plural(report.joins_checked.length, "join")} and wrote ${report.joins_checked.length === 1 ? "its" : "their"} evidence.`);
  for (const s of report.joins_skipped) lines.push(`  ${s.ref} not checked: ${s.reason}`);
  if (!report.contradictions.length) return [...lines, "The data contradicts no drafted or approved item."];
  lines.push(`The data contradicts ${plural(report.contradictions.length, "item")}; read ${report.contradictions.length === 1 ? "it" : "them"} back to the owner (approvals stay until they answer):`);
  for (const c of report.contradictions) lines.push(`  ${c.ref}${c.approved ? " (approved)" : ""}: ${c.evidence}`);
  return lines;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listText = (c: ListChange) => [c.added.length ? `added ${c.added.join(", ")}` : "", c.removed.length ? `removed ${c.removed.join(", ")}` : ""].filter(Boolean).join("; ");
const MAX_SHOWN = 40;

const spec: CommandSpec = {
  summary: "Create or update a source in one step: project, source file, schemas, scope and snapshot.",
  usage:
    "setup --source <source> --dialect duckdb|postgres|snowflake|bigquery|databricks (--env VAR | --export <file> [--reason <text>])\n" +
    "      [--schemas a,b] [--include <pattern>]... [--exclude <pattern>]... [--tables-file <path>]\n" +
    "      [--database <path>] [--view name=relation]... [--name <project>]\n\n" +
    "  Runs sl init when there is no project, writes or updates sources/<source>.yaml in place, sets the scope,\n" +
    "  reads the catalog (introspect, or import of the export copied to exports/<source>.<ext>) and previews the scope.\n" +
    "  A connection comes first: --export with --reason is the fallback. The same arguments again change nothing;\n" +
    "  a group of flags left out (--schemas; the scope flags; --database; --view) leaves that part of the source as it is.\n" +
    "  An export source given its connection is upgraded: it introspects, profiles, checks every join and lists the items\n" +
    "  the data contradicts, for sl readback.",
  options: {
    source: { type: "string" },
    dialect: { type: "string" },
    env: { type: "string" },
    export: { type: "string" },
    reason: { type: "string" },
    schemas: { type: "string", multiple: true },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    "tables-file": { type: "string" },
    database: { type: "string" },
    view: { type: "string", multiple: true },
    name: { type: "string" },
  },
  async run({ values }, ctx) {
    // Every flag is checked before anything is written.
    const name = str(values, "source");
    if (!name || !NAME_PATTERN.test(name)) throw new UserError("--source is required and must match ^[a-z][a-z0-9_]*$, for example --source warehouse.");
    const dialectRaw = str(values, "dialect");
    if (!dialectRaw || !(DIALECTS as readonly string[]).includes(dialectRaw)) throw new UserError(`--dialect is required and must be one of: ${DIALECTS.join(", ")}.`);
    const dialect = dialectRaw as Dialect;
    const duck = dialect === "duckdb";
    const env = str(values, "env");
    const exportArg = str(values, "export");
    const reasonArg = str(values, "reason");
    const database = str(values, "database");
    const views = many(values, "view");
    const tablesArg = str(values, "tables-file");
    const projectArg = str(values, "name");
    const mode = exportArg !== undefined ? "export" : "connection";

    if (exportArg !== undefined && (env !== undefined || database !== undefined || views.length)) {
      throw new UserError(
        "--export is the fallback for when no connection is possible, so it takes no --env, --database or --view. Run sl setup again with the connection, or with --export and --reason alone.",
      );
    }
    if (exportArg === undefined && env === undefined && !(duck && (database !== undefined || views.length))) {
      if (!existsSync(paths(ctx.root).source(name))) throw new UserError(CONNECTION_FIRST);
      throw new UserError(
        `Source "${name}" exists, and sl setup needs its connection flags again (--env, or for duckdb --database or --view; --export for an export source), as they were. ` +
          `To change only its scope, run sl scope --source ${name} --include <pattern> --write.`,
      );
    }
    if (reasonArg !== undefined && exportArg === undefined) throw new UserError('--reason records why a connection is not possible, so it goes with --export; run sl setup again without it.');
    if (env !== undefined) checkEnv(env, dialect);
    if (!duck && (database !== undefined || views.length)) throw new UserError("--database and --view apply only to duckdb sources; run sl setup again without them.");
    if (database !== undefined) {
      if (!database.trim()) throw new UserError("--database must not be empty.");
      refuseCredentials("--database", database);
      if (database !== ":memory:" && !NOT_A_FILE.test(database) && !existsSync(resolve(ctx.root, database))) {
        throw new UserError(`--database: no DuckDB file at ${resolve(ctx.root, database)} (the path resolves from the semantic root). Fix the path and run sl setup again.`);
      }
    }
    const viewMap = views.length ? parseViews(views) : undefined;
    const schemas = list(values, "schemas");
    if (values.schemas !== undefined && !schemas.length) throw new UserError(`--schemas needs at least one schema name; ${SCHEMA_NAME_HINT}.`);
    const schemaIssues = schemaListIssues(schemas, { dialect, connection: { database } }, (i) => `name ${i + 1}`);
    const schemaError = schemaIssues.find((x) => x.level === "error");
    if (schemaError) throw new UserError(`--schemas: ${schemaError.path} ${schemaError.message}. Fix it and run sl setup again.`);
    const include = patternFlags(values, "include");
    const exclude = patternFlags(values, "exclude");
    let tablesFrom: string | undefined;
    if (tablesArg !== undefined) {
      tablesFrom = inputFile(ctx, tablesArg, "--tables-file", "a text file with one table or pattern per line");
      const parsed = parseTableList(readFileSync(tablesFrom, "utf8"));
      if (parsed.problems.length) throw new UserError(`${problemsMessage(tablesArg, parsed.problems)}\nFix the file and run sl setup again.`);
    }
    const exportFrom = exportArg === undefined ? undefined : inputFile(ctx, exportArg, "--export", "the schema export (sl export-sql prints the query that makes one)");
    if (projectArg !== undefined && !NAME_PATTERN.test(projectArg)) throw new UserError("--name must match ^[a-z][a-z0-9_]*$.");

    // The source as it is, and the checks that need it.
    const p = paths(ctx.root);
    const rel = `sources/${name}.yaml`;
    const file = rootPath(ctx.root, rel, "The source file");
    if (existsSync(file.replace(/\.yaml$/, ".yml"))) throw new UserError(`sources/${name}.yml exists; sl setup edits sources/${name}.yaml. Rename the file and run sl setup again.`);
    const oldText = existsSync(file) ? readFileSync(file, "utf8") : null;
    const old = oldText === null ? null : (parseYamlText(oldText, rel) as SourceConfig | null);
    if (oldText !== null && (old === null || typeof old !== "object")) throw new UserError(`${rel} is not a source file; fix it (sl validate names the problem) and run sl setup again.`);
    if (old && old.dialect !== dialect) {
      throw new UserError(`Source "${name}" is a ${old.dialect} source, and sl setup does not change a dialect. Run sl setup with --dialect ${old.dialect}, or pick another --source name.`);
    }
    // An export source given its connection is upgraded (spec: Setup, Upgrade from an export).
    const upgrading = old !== null && intakeMode(old) === "export" && mode === "connection";
    if (old && intakeMode(old) === "connection" && mode === "export") {
      throw new UserError(`Source "${name}" reads the catalog through a connection; sl setup does not turn it into an export source. Keep using the connection, or set up the export under another --source name.`);
    }

    const warnings = schemaIssues.map((x) => `--schemas: ${x.path} ${x.message}.`);
    const reason = reasonArg === undefined ? undefined : redactCredentials(reasonArg.trim());
    if (reason?.redacted) warnings.push("--reason held something that looks like a credential; it was replaced with [redacted] in intake.reason. Rotate that credential.");
    const ext = extname(exportArg ?? "").toLowerCase();
    const exportRel = exportArg === undefined ? undefined : `exports/${name}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ""}`;
    const scopeGiven = include.length > 0 || exclude.length > 0 || tablesArg !== undefined;
    // A glob given in another case is the pattern the file has, so the file's spelling stays.
    const spelled = (given: string[], had: readonly string[] | undefined) => given.map((g) => had?.find((h) => patternKey(h) === patternKey(g)) ?? g);
    const state: SourceState = {
      env,
      database: duck && mode === "connection" ? (database ?? (old && !upgrading ? undefined : ":memory:")) : undefined,
      views: viewMap,
      mode,
      // Without --reason a recorded reason stays; a source without one gets "" and a warning.
      reason: mode === "export" ? (reason?.text ?? (typeof old?.intake?.reason === "string" ? undefined : "")) : undefined,
      schemas: values.schemas !== undefined ? schemas : undefined,
      exportFile: exportRel,
      scope: scopeGiven ? { include: spelled(include, old?.scope?.include), exclude: spelled(exclude, old?.scope?.exclude), tables_file: tablesArg !== undefined ? `scope/${name}.txt` : undefined } : undefined,
    };
    const newText = editYamlText(oldText ?? `source: ${name}\ndialect: ${dialect}\n`, (doc) => {
      applySourceState(doc, state);
      if (upgrading) dropExportIntake(doc);
    }, rel);
    const next = parseYamlText(newText, rel) as SourceConfig;
    if (mode === "export" && !next.intake?.reason) {
      warnings.push(
        'intake.reason is recorded as empty. The skill asks the owner for a connection first and uses an export only when one is not possible; record why with sl setup ... --reason "<why>".',
      );
    }
    const tablesCopy = tablesFrom === undefined ? undefined : plannedCopy(ctx.root, tablesFrom, state.scope!.tables_file!, "The table-list copy");
    const exportCopy = exportFrom === undefined ? undefined : plannedCopy(ctx.root, exportFrom, exportRel!, "The export copy");

    // What changed, as the source file and the copies compare.
    const oc = (old?.connection ?? {}) as Record<string, unknown>;
    const nc = (next.connection ?? {}) as Record<string, unknown>;
    const oldScope = old?.scope ?? {};
    const newScope = next.scope ?? {};
    const changes = {
      connection: ["env", "database", "views"].filter((k) => !isDeepStrictEqual(oc[k], nc[k])),
      intake_mode: old?.intake?.mode !== next.intake?.mode,
      reason: (old?.intake?.reason ?? null) !== (next.intake?.reason ?? null),
      schemas: listChange(old ? intakeSchemas(old) : [], intakeSchemas(next)),
      include: listChange(oldScope.include, newScope.include),
      exclude: listChange(oldScope.exclude, newScope.exclude),
      tables_file: (newScope.tables_file === undefined ? (oldScope.tables_file === undefined ? null : "removed") : (tablesCopy?.status ?? (oldScope.tables_file === newScope.tables_file ? null : "added"))) as CopyStatus,
      export_file: (exportCopy?.status ?? (old?.intake?.export?.file === next.intake?.export?.file ? null : next.intake?.export?.file === undefined ? "removed" : "added")) as CopyStatus,
    };
    const created = oldText === null;
    const updated = !created && newText !== oldText;
    const oldSnapshot = existsSync(p.project) ? loadSnapshot(ctx.root, name) : null;
    const schemasChanged = changes.schemas.added.length + changes.schemas.removed.length > 0;
    const refresh = created || !oldSnapshot || changes.connection.length > 0 || changes.intake_mode || schemasChanged || changes.export_file !== null;
    const live = mode === "export" || RUNNABLE_DIALECTS.includes(dialect);
    const read = refresh && live;
    if (read && dialect === "postgres" && mode === "connection" && !ctx.env[next.connection?.env ?? ""]) {
      throw new UserError(
        `Environment variable ${next.connection?.env} is not set in this shell, so sl setup cannot read the catalog, and nothing was written. ` +
          `Ask the owner to set it to the connection URL (export ${next.connection?.env}=...), then run the same sl setup command again.`,
      );
    }
    if (!read && dialect === "postgres" && mode === "connection" && !ctx.env[next.connection?.env ?? ""]) {
      warnings.push(`Environment variable ${next.connection?.env} is not set in this shell; set it before running queries.`);
    }
    let before: string[] | null = null;
    if (old && oldSnapshot) {
      try {
        before = filterInScope(effectiveScope(ctx.root, old), oldSnapshot.tables).map(qualifiedName);
      } catch {
        before = null;
      }
    }

    // The writes, undone together when reading the catalog fails.
    let projectCreated = false;
    if (!existsSync(p.project)) {
      await runQuiet(initCommand, { name: projectArg ?? projectName(ctx.root) }, ctx);
      projectCreated = true;
    } else if (projectArg !== undefined && loadProject(ctx.root).name !== projectArg) {
      warnings.push(`The project already exists as ${loadProject(ctx.root).name}; --name is used only when sl setup creates the project.`);
    }
    const project = loadProject(ctx.root);
    const backups = new Map<string, Buffer | null>();
    const write = (path: string, data: string | Buffer) => {
      if (!backups.has(path)) backups.set(path, existsSync(path) ? readFileSync(path) : null);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    };
    let result: Record<string, unknown> | null = null;
    let upgrade: UpgradeReport | null = null;
    try {
      if (created || updated) write(file, newText);
      for (const c of [tablesCopy, exportCopy]) if (c?.status) write(c.to, c.data);
      if (read) {
        const snap = p.snapshot(name);
        backups.set(snap, existsSync(snap) ? readFileSync(snap) : null);
        result = await runQuiet(mode === "export" ? importCommand : introspectCommand, { source: name }, ctx);
        if (upgrading) upgrade = await upgradeSteps(ctx, name, oldSnapshot, (path) => backups.has(path) || backups.set(path, readFileSync(path)));
      }
    } catch (e) {
      for (const [path, data] of backups) {
        if (data === null) rmSync(path, { force: true });
        else writeFileSync(path, data);
      }
      if (!(e instanceof UserError)) throw e;
      const kept = projectCreated ? " (the project it created stays)" : "";
      const models = upgrading ? ", the snapshot and the model files" : " and the snapshot";
      throw new UserError(`${e.message}\nsl setup put ${rel}, the copies${models} back as they were${kept}; fix the problem and run the same sl setup command again.`);
    }

    const snapshot = loadSnapshot(ctx.root, name);
    const scope = effectiveScope(ctx.root, next);
    const { focus_threshold } = projectSettings(project);
    const preview = snapshot ? scopePreview(next.scope, scope, snapshot, before, focus_threshold) : null;
    for (const pat of preview?.unmatched_patterns ?? []) warnings.push(`Pattern "${pat}" matches no table in the snapshot; check its spelling against sl tables --source ${name} --all.`);
    for (const w of (result?.warnings as string[] | undefined) ?? []) warnings.push(w);
    if (preview?.needs_focus) warnings.push(`${preview.in_scope} tables are in scope, more than the focus threshold of ${focus_threshold}; narrow the scope with the owner before drafting.`);
    const dialectFlag = RUNNABLE_DIALECTS.includes(dialect) ? "" : " --emit-sql";
    // A connection the CLI does not read keeps the query-plan step while its snapshot came from an export.
    const unread = refresh || (mode === "connection" && !live && snapshot !== null && snapshot.method !== "live");
    const contradicted = contradictedRefs(upgrade?.contradictions ?? []);
    const nextAction = contradicted.length
      ? `sl readback --targets ${contradicted.join(",")}`
      : unread && !read
        ? `sl introspect --source ${name} --emit-sql`
        : !preview || preview.in_scope === 0
          ? `sl tables --source ${name} --all`
          : preview.needs_focus
            ? `sl tables --source ${name} --groups`
            : mode === "connection" && filterInScope(scope, snapshot!.tables).some((t) => profileState(t) !== "yes")
              ? `sl profile --source ${name}${dialectFlag}`
              : `sl baseline --source ${name}`;
    const changed = projectCreated || created || updated || Boolean(tablesCopy?.status) || Boolean(exportCopy?.status) || read;
    const intake = { mode, schemas: intakeSchemas(next), ...(mode === "export" ? { reason: next.intake?.reason ?? "", export_file: exportRel } : {}) };
    const counts = result ? { tables: Number(result.tables ?? 0), columns: Number(result.columns ?? 0) } : null;

    if (ctx.json) {
      ctx.out(
        formatJson({
          project_created: projectCreated,
          project: project.name,
          source: { name, path: rel, created, updated, changes },
          intake,
          snapshot: { read, current: !refresh || read, ...(counts ?? {}), changes: (result?.changes as SnapshotDiff | null | undefined) ?? null },
          scope: preview,
          changed,
          warnings,
          next: nextAction,
          upgraded: upgrading,
          changes: upgrading ? ((result?.changes as SnapshotDiff | null | undefined) ?? null) : null,
          profiled: upgrade?.profiled ?? [],
          joins_checked: upgrade?.joins_checked ?? [],
          joins_skipped: upgrade?.joins_skipped ?? [],
          contradictions: upgrade?.contradictions ?? [],
        }),
      );
      return 0;
    }

    const lines: string[] = [];
    if (!changed) lines.push(`Nothing changed: ${rel}, its scope and the snapshot are as they were.`);
    if (projectCreated) lines.push(`Created semantic.yaml for project ${project.name}.`);
    // The database value and the view relations stay out of the output, as sl add-source keeps them.
    const viewNames = Object.keys(next.connection?.views ?? {});
    const how = mode === "export" ? `schema export ${exportRel}` : env ? `connection through ${env}` : viewNames.length ? `views ${viewNames.join(", ")}` : "a database file";
    const schemaText = intake.schemas.length ? `; ${intake.schemas.length === 1 ? "schema" : "schemas"} ${intake.schemas.join(", ")}` : "; every schema";
    if (created) lines.push(`Created ${rel} (${dialect}; ${how}${schemaText}).`);
    else if (updated) {
      lines.push(`Updated ${rel} in place:`);
      if (changes.connection.length) lines.push(`  connection: ${changes.connection.join(", ")} changed`);
      if (changes.intake_mode) lines.push(`  intake.mode: ${mode}`);
      if (changes.reason) lines.push(upgrading ? "  intake.reason and intake.export removed" : "  intake.reason changed");
      for (const [key, c] of [["schemas", changes.schemas], ["include", changes.include], ["exclude", changes.exclude]] as const) {
        if (listText(c)) lines.push(`  ${key}: ${listText(c)}`);
      }
      if (changes.tables_file === "removed") lines.push("  scope.tables_file removed (the file itself is kept)");
    }
    if (tablesCopy?.status) lines.push(`${tablesCopy.status === "added" ? "Copied" : "Replaced"} ${tablesCopy.rel} ${tablesCopy.status === "added" ? "from" : "with"} ${tablesArg}.`);
    if (exportCopy?.status) lines.push(`${exportCopy.status === "added" ? "Copied" : "Replaced"} ${exportCopy.rel} ${exportCopy.status === "added" ? "from" : "with"} ${exportArg}.`);
    if (result && counts) {
      lines.push(mode === "export" ? `Imported ${plural(counts.tables, "table")} and ${plural(counts.columns, "column")} from ${exportRel}.` : `Introspected ${name}: ${plural(counts.tables, "table")}, ${plural(counts.columns, "column")}.`);
      lines.push(...changeLines((result.changes as SnapshotDiff | null) ?? null, name));
    } else if (refresh) {
      lines.push(`The CLI does not connect to ${dialect}, so the catalog is read through the query plan below.`);
    } else if (unread) {
      lines.push(`The snapshot came from a schema export, not the connection; the CLI does not connect to ${dialect}, so read it through the query plan below.`);
    } else if (snapshot) {
      lines.push(`The snapshot was not read again: the connection, schemas and export are unchanged (sl ${mode === "export" ? "import" : "introspect"} --source ${name} reads it again).`);
    }
    if (preview) {
      lines.push("", `Scope: ${preview.in_scope} of ${plural(preview.total, "table")} in scope.`);
      for (const s of preview.by_schema) lines.push(`  ${s.schema ?? "(no schema)"}: ${s.in_scope} of ${s.total}`);
      if (preview.added.length) lines.push(`Added to scope (${preview.added.length}): ${preview.added.join(", ")}`);
      if (preview.removed.length) lines.push(`Removed from scope (${preview.removed.length}): ${preview.removed.join(", ")}`);
      const rows = preview.tables.slice(0, MAX_SHOWN).map((t) => ({ table: t.table, rows: t.rows === null ? "?" : t.rows.toLocaleString("en-US") }));
      if (rows.length) lines.push(formatTable(rows, ["table", "rows"]));
      if (preview.tables.length > MAX_SHOWN) lines.push(`... and ${preview.tables.length - MAX_SHOWN} more (sl tables --source ${name}).`);
    }
    if (upgrading) lines.push("", ...upgradeLines(rel, name, old?.intake?.export?.file, upgrade));
    for (const w of warnings) lines.push(`Warning: ${w}`);
    lines.push("");
    lines.push(
      unread && !read && !contradicted.length
        ? `Next: ${nextAction}, run the queries it prints with your own SQL tool, save the results as a JSON file, then run sl introspect --source ${name} --results <file>.`
        : `Next: ${nextAction}`,
    );
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

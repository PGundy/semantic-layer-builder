import { validateProject } from "../lib/validate.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { canRun } from "../lib/adapters/index.ts";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, str, today } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import type { CompileResult } from "../lib/compiler/index.ts";
import {
  compareRows,
  compileGolden,
  crossCheckQueryId,
  crossCheckSql,
  currencyColumns,
  displayRows,
  goldenDraftFields,
  goldenPlan,
  goldenQueryId,
  judgeGolden,
  onlyUnsupportedDialect,
  refusalNext,
  resultColumns,
} from "../lib/goldens.ts";
import { formatJson, formatTable, maskRows, plainText, protectedNames, protectedNote, protectedResultColumns } from "../lib/output.ts";
import { emitPlan, executePlan, planResults, resultsInput } from "../lib/plan.ts";
import { listGoldens, loadAccess, loadMetrics, loadSource, paths, stem, type LoadedGolden } from "../lib/project.ts";
import type { Golden, GoldenRunAs, Metric, Model, PlanResults, QueryPlan, ResultRows, SourceConfig } from "../lib/types.ts";
import { NAME_PATTERN } from "../lib/types.ts";
import { schemaIssues } from "../lib/validate.ts";
import { parseYamlText, readJson, readYaml, updateYaml, writeYaml } from "../lib/yaml.ts";

export const MAX_CONFIRM_ROWS = 200;
export const DEFAULT_TOLERANCE = 0.005;

const SUBCOMMANDS = ["run", "confirm", "check", "new"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface GoldenCheck {
  name: string;
  ok: boolean;
  diffs: string[];
  // How the rows compiled from the YAML compared: pass or fail; refused when the compiler refused
  // the request; unsupported when it does not compile the source's dialect (cross_check_sql alone runs).
  compiled?: "pass" | "fail" | "refused" | "unsupported";
  // How cross_check_sql compared, when the golden has one and it ran.
  cross_check?: "pass" | "fail";
  // The step that resolves a refusal.
  next?: string;
}

// The golden file for a name, refusing any name that could reach outside goldens/.
function goldenPath(ctx: CommandContext, name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new UserError(`"${name}" is not a golden name: use lower case letters, digits and underscores, starting with a letter.`);
  }
  const dir = resolve(paths(ctx.root).goldensDir);
  const path = resolve(paths(ctx.root).golden(name));
  if (!path.startsWith(dir + sep)) throw new UserError(`"${name}" is not a golden name.`);
  return path;
}

// Why a loaded golden cannot be used as is, or undefined when it can.
function goldenProblem(loaded: LoadedGolden): string | undefined {
  const { path, golden } = loaded;
  if (!golden || typeof golden !== "object") return `${basename(path)} is not a golden.`;
  const fileStem = stem(basename(path));
  if (golden.name !== fileStem) {
    return `${basename(path)} holds a golden named "${String(golden.name)}"; its name must match the file name, "${fileStem}".`;
  }
  return undefined;
}

function loadGolden(ctx: CommandContext, name: string): LoadedGolden {
  const path = goldenPath(ctx, name);
  if (!existsSync(path)) {
    const known = listGoldens(ctx.root).map((g) => stem(basename(g.path)));
    throw new UserError(`No golden "${name}" (${relative(ctx.root, path)}). Goldens: ${known.length ? known.join(", ") : "none"}.`);
  }
  const loaded = { path, golden: readYaml<Golden>(path) };
  const problem = goldenProblem(loaded);
  if (problem) throw new UserError(problem);
  return loaded;
}

function goldenSource(ctx: CommandContext, g: Golden): SourceConfig {
  const name = g.request?.source;
  if (!name) throw new UserError(`Golden "${g.name}" has no request.source.`);
  return loadSource(ctx.root, name);
}

function requireName(values: OptionValues, sub: Subcommand): string {
  const name = str(values, "name");
  if (!name) throw new UserError(`goldens ${sub} needs --name <golden>.`);
  return name;
}

// A golden's plan: its request compiled from the current YAML (see compileGolden) and its
// cross_check_sql, each when there is one.
function planGolden(ctx: CommandContext, g: Golden, source: SourceConfig): { plan: QueryPlan; compiled: CompileResult } {
  const compiled = compileGolden(ctx.root, g);
  return { plan: goldenPlan(g, source, compiled), compiled };
}

interface GoldenRows {
  compiled: CompileResult;
  // The compiled query's rows, when the request compiled; the cross_check_sql rows, when it has one.
  rows?: ResultRows;
  cross?: ResultRows;
}

// Runs a golden's queries, live, from a results file or from a stored plan.
async function runGoldenQueries(ctx: CommandContext, g: Golden, source: SourceConfig, input: { resultsFile?: string; planId?: string }): Promise<GoldenRows> {
  const { plan, compiled } = planGolden(ctx, g, source);
  const results = await executePlan(plan, { root: ctx.root, source, env: ctx.env, ...input, warn: ctx.err });
  return {
    compiled,
    ...(compiled.ok ? { rows: results[goldenQueryId(g.name)] ?? [] } : {}),
    ...(crossCheckSql(g) !== undefined ? { cross: results[crossCheckQueryId(g.name)] ?? [] } : {}),
  };
}

// What a golden's rows are when its request does not compile: its cross_check_sql's, said on stderr.
function notCompiledNote(g: Golden, compiled: CompileResult): string {
  if (compiled.ok) return "";
  return plainText(
    `Golden "${g.name}" does not compile from the current YAML (${compiled.reason}); these rows come from its cross_check_sql. ${refusalNext(g, compiled)}`,
  );
}

// The rows a golden records: the rows compiled from the YAML, or its cross_check_sql's when its
// request does not compile. Refused when both ran and disagree.
async function runGolden(
  ctx: CommandContext,
  g: Golden,
  source: SourceConfig,
  input: { resultsFile?: string; planId?: string },
): Promise<ResultRows> {
  const { compiled, rows, cross } = await runGoldenQueries(ctx, g, source, input);
  if (rows && cross) {
    const cmp = compareRows(rows, cross, { ordered: orderedGolden(g), tolerance: g.expected?.tolerance ?? DEFAULT_TOLERANCE, protectedColumns: protectedColumnsOf(ctx, source, [rows, cross]) });
    if (!cmp.ok) {
      throw new UserError(
        `Golden "${g.name}": cross_check_sql gives other rows than the request compiled from the YAML (expected is the compiled, got is cross_check_sql): ` +
          `${cmp.diffs.join(" ")} Fix cross_check_sql or the layer, then run sl goldens run --name ${g.name}.`,
      );
    }
  }
  if (!rows) ctx.err(notCompiledNote(g, compiled));
  return rows ?? cross ?? [];
}

const orderedGolden = (g: Golden): boolean => (g.request?.order_by ?? []).length > 0;

// The protected columns (see protectedResultColumns) of the given results, always masked in differences.
function protectedColumnsOf(ctx: CommandContext, source: SourceConfig, results: ResultRows[]): string[] {
  return protectedResultColumns([...new Set(results.flatMap((r) => resultColumns(r)))], protectedNames(ctx.root, source));
}

// The result columns whose values goldens prints as [protected] (see protectedResultColumns),
// none with --show-protected.
function maskedColumns(ctx: CommandContext, values: OptionValues, source: SourceConfig, columns: string[]): string[] {
  if (bool(values, "show-protected")) return [];
  return protectedResultColumns(columns, protectedNames(ctx.root, source));
}

function lowerKeys(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), v])));
}

// The tolerance to record: --tolerance, else the one already in the file, else the default.
function parseTolerance(values: OptionValues, g: Golden): { tolerance: number; from: "flag" | "file" | "default" } {
  const raw = str(values, "tolerance");
  if (raw === undefined) {
    const kept = g.expected?.tolerance;
    return typeof kept === "number" ? { tolerance: kept, from: "file" } : { tolerance: DEFAULT_TOLERANCE, from: "default" };
  }
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0 || t >= 1) throw new UserError(`--tolerance must be a number from 0 up to 1, such as 0.005; got "${raw}".`);
  return { tolerance: t, from: "flag" };
}

interface Layer {
  models: Model[];
  metrics: Metric[];
}

// The source's models and metrics.yaml, read for advisory use: a file that cannot be read is
// skipped, with a notice on stderr pointing to sl validate when `purpose` names what it was read for.
function readLayer(ctx: CommandContext, source: SourceConfig, purpose?: string): Layer {
  const unread: string[] = [];
  let firstError = "";
  const attempt = <T>(path: string, read: () => T): T | undefined => {
    try {
      return read();
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      unread.push(relative(ctx.root, path));
      firstError ||= e.message.split("\n")[0] ?? "";
      return undefined;
    }
  };
  const dir = paths(ctx.root).modelsDir(source.source);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const models = files.flatMap((f) => {
    const m = attempt(join(dir, f), () => readYaml<Model>(join(dir, f)));
    return m ? [m] : [];
  });
  const metricsFile = attempt(paths(ctx.root).metrics, () => loadMetrics(ctx.root));
  const metrics = metricsFile && Array.isArray(metricsFile.metrics) ? metricsFile.metrics : [];
  if (unread.length && purpose) {
    ctx.err(`Could not read ${unread.join(", ")} to ${purpose} (${firstError}); run sl validate.`);
  }
  return { models, metrics };
}

// Rows as printed: the result columns named like the request's currency measures and metrics
// (see currencyColumns) shown to two decimals; a column the sql aliases otherwise shows as
// returned. The recorded and JSON rows are not changed.
function shownRows(g: Golden, layer: Layer, rows: ResultRows, columns: string[]): ResultRows {
  return displayRows(rows, currencyColumns(g, layer.models, layer.metrics, columns));
}

// The role and user a golden's file writes, which confirm records as confirmed_as and sl validate
// compares with the file's role and user. A golden without a role records no role: confirmed_as
// tracks the golden's own fields, not access.yaml's default_role.
function runAs(g: Golden): GoldenRunAs {
  const out: GoldenRunAs = {};
  if (typeof g.role === "string") out.role = g.role;
  if (g.user && typeof g.user === "object" && !Array.isArray(g.user)) out.user = g.user;
  return out;
}

// A warning when the role a golden runs as (its role, else access.yaml's default_role) is defined
// only in a draft access.yaml, whose rules may still change before access is approved. An
// access.yaml that cannot be read is left to sl validate.
function draftRoleWarning(ctx: CommandContext, g: Golden): string | undefined {
  let access: ReturnType<typeof loadAccess>;
  try {
    access = loadAccess(ctx.root);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return undefined;
  }
  if (!access || typeof access !== "object" || access.status === "approved") return undefined;
  const own = typeof g.role === "string" ? g.role : undefined;
  const role = own ?? (typeof access.default_role === "string" ? access.default_role : undefined);
  if (!role) return undefined;
  const defined = Array.isArray(access.roles) && access.roles.some((r) => r && typeof r === "object" && r.name === role);
  if (!defined) return undefined;
  return (
    `Golden "${g.name}" runs as role ${role}${own ? "" : " (access.yaml's default_role)"}, which is defined only in a draft access.yaml: ` +
    "its rules may still change before access is approved. Confirm a golden that runs as a role after access.yaml is approved; " +
    `confirmed now, rerun sl goldens check --name ${g.name} and read it back to the owner after every change to role ${role}.`
  );
}

// What to do with the rows goldens run printed: an approved golden is rechecked with
// goldens check; a draft one is confirmed only once its measures are approved and the
// owner says the rows match a figure they trust.
export function runHint(golden: Golden): string {
  if (golden.status === "approved") {
    return `Already confirmed; sl goldens check --name ${golden.name} compares these rows with the recorded ones.`;
  }
  return (
    "Read these rows back to the owner. Confirm only once its measures are approved and the owner says these rows match " +
    `a figure they trust: sl goldens confirm --name ${golden.name} --by "<owner>" --tolerance <agreed tolerance>.`
  );
}

async function runCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const { golden } = loadGolden(ctx, requireName(values, "run"));
  const source = goldenSource(ctx, golden);
  const input = resultsInput(ctx, values);
  if (bool(values, "emit-sql")) {
    ctx.out(formatJson(emitPlan(ctx, planGolden(ctx, golden, source).plan, { name: "goldens", positionals: ["run"], values })));
    return 0;
  }
  const { compiled, rows: compiledRows, cross } = await runGoldenQueries(ctx, golden, source, input);
  const rows = compiledRows ?? cross ?? [];
  const columns = resultColumns(rows);
  const masked = maskedColumns(ctx, values, source, columns);
  // cross_check_sql against the compiled rows: expected is the compiled, got is cross_check_sql.
  const crossCheck =
    compiledRows && cross
      ? compareRows(compiledRows, cross, {
          ordered: orderedGolden(golden),
          tolerance: golden.expected?.tolerance ?? DEFAULT_TOLERANCE,
          protectedColumns: maskedColumns(ctx, values, source, resultColumns([...compiledRows, ...cross])),
        })
      : undefined;
  if (ctx.json) {
    ctx.out(
      formatJson({
        name: golden.name,
        columns,
        rows: maskRows(rows, masked),
        protected_columns: masked,
        compiled: compiled.ok,
        ...(compiled.ok ? { sql: compiled.sql, params: compiled.params } : { refused: { reason: compiled.reason, next: refusalNext(golden, compiled) } }),
        ...(crossCheck ? { cross_check: crossCheck } : {}),
      }),
    );
  } else {
    ctx.out(plainText(`${golden.name}: ${golden.question}`));
    ctx.out(formatTable(maskRows(shownRows(golden, readLayer(ctx, source), rows, columns), masked), columns));
    ctx.out(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
    if (masked.length) ctx.out(protectedNote(masked));
    ctx.out(compiledRows ? "These rows are the request compiled from the current YAML." : notCompiledNote(golden, compiled));
    if (crossCheck?.ok) ctx.out("cross_check_sql gives the same rows.");
    else if (crossCheck) {
      ctx.out("cross_check_sql gives other rows (expected is the compiled, got is cross_check_sql):");
      for (const d of crossCheck.diffs) ctx.out(`  ${plainText(d)}`);
      ctx.out(`Fix cross_check_sql or the layer before confirming, then run sl goldens run --name ${golden.name} again.`);
    }
    ctx.out(runHint(golden));
  }
  return 0;
}

async function confirmCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const { path, golden } = loadGolden(ctx, requireName(values, "confirm"));
  const by = str(values, "by")?.trim();
  if (!by) throw new UserError('goldens confirm needs --by "<name of the owner who confirmed the rows>".');
  const { tolerance, from: toleranceFrom } = parseTolerance(values, golden);
  const source = goldenSource(ctx, golden);
  const input = resultsInput(ctx, values);
  if (bool(values, "emit-sql")) {
    ctx.out(formatJson(emitPlan(ctx, planGolden(ctx, golden, source).plan, { name: "goldens", positionals: ["confirm"], values })));
    return 0;
  }
  const layer = readLayer(ctx, source, "list draft fields");
  const draftFields = goldenDraftFields(golden, layer.models, layer.metrics);
  if (draftFields.length && !ctx.json) {
    ctx.out(
      `This golden's request uses draft field(s): ${draftFields.join(", ")}. A golden is confirmed after its measures are ` +
        `approved. Approve each field after its readback, then run sl goldens check --name ${golden.name}; if it passes the ` +
        "recorded rows stand, and only changed rows need a new confirm. sl validate warns until then.",
    );
  }
  const rows = await runGolden(ctx, golden, source, input);
  if (!rows.length) throw new UserError(`Golden "${golden.name}" returned no rows; a golden needs at least one expected row.`);
  if (rows.length > MAX_CONFIRM_ROWS && !bool(values, "force")) {
    throw new UserError(
      `Golden "${golden.name}" returned ${rows.length} rows, more than ${MAX_CONFIRM_ROWS}. A golden should be an aggregate the ` +
        "owner can check by eye; aggregate further or add a limit, or pass --force to record every row.",
    );
  }
  // A request naming a field that does not exist yet makes the approved golden invalid; say so before recording.
  const unknown = validateProject(ctx.root).filter(
    (i) => i.file === `goldens/${golden.name}.yaml` && i.path.startsWith("request") && (i.level === "error" || i.message.includes("before confirming")),
  );
  if (unknown.length && !ctx.json) {
    ctx.err(
      `Golden "${golden.name}" names fields the layer does not have yet; sl validate errors on it once confirmed:\n` +
        unknown.map((i) => `  ${i.path}: ${i.message}`).join("\n"),
    );
  }
  const warnings = [draftRoleWarning(ctx, golden)].filter((w): w is string => w !== undefined);
  if (!ctx.json) for (const w of warnings) ctx.err(w);
  const confirmedAt = today(ctx);
  const confirmedAs = runAs(golden);
  updateYaml(path, (doc) => {
    doc.set("expected", doc.createNode({ tolerance, rows }));
    doc.set("status", "approved");
    doc.set("confirmed_by", by);
    doc.set("confirmed_at", confirmedAt);
    doc.set("confirmed_as", doc.createNode(confirmedAs));
  });
  const columns = resultColumns(rows);
  const masked = maskedColumns(ctx, values, source, columns);
  if (ctx.json) {
    ctx.out(
      formatJson({
        name: golden.name,
        rows: maskRows(rows, masked),
        protected_columns: masked,
        written: true,
        tolerance,
        draft_fields: draftFields,
        confirmed_as: confirmedAs,
        warnings,
      }),
    );
  } else {
    const toleranceNote =
      toleranceFrom === "flag" ? "" : toleranceFrom === "file" ? ", kept from the file" : ", the default; agree one with the owner and pass --tolerance";
    ctx.out(formatTable(maskRows(shownRows(golden, layer, rows, columns), masked), columns));
    if (masked.length) ctx.out(protectedNote(masked));
    ctx.out(
      `Recorded ${rows.length} expected row${rows.length === 1 ? "" : "s"} in ${relative(ctx.root, path)} (tolerance ${tolerance}${toleranceNote}), ` +
        `confirmed by ${by} on ${confirmedAt}.`,
    );
  }
  return 0;
}

function selectForCheck(ctx: CommandContext, values: OptionValues): LoadedGolden[] {
  const name = str(values, "name");
  const sourceFilter = str(values, "source");
  if (name) {
    if (sourceFilter) throw new UserError("Pass --name <g> or --source <s> to goldens check, not both.");
    const loaded = loadGolden(ctx, name);
    if (!loaded.golden.expected?.rows?.length) {
      throw new UserError(`Golden "${name}" has no expected rows yet. Run sl goldens confirm --name ${name} --by "<owner>" --tolerance <t> first.`);
    }
    return [loaded];
  }
  return listGoldens(ctx.root).filter(
    ({ golden: g }) => g && typeof g === "object" && g.status === "approved" && (!sourceFilter || g.request?.source === sourceFilter),
  );
}

// Whether a results file holds an entry for every query id given.
function resultsCover(file: string, ids: string[]): boolean {
  const raw = readJson<Record<string, unknown>>(file);
  return ids.every((id) => raw && typeof raw === "object" && id in raw);
}

interface Planned {
  golden: Golden;
  plan: QueryPlan;
  compiled: CompileResult;
}

// The one plan of every golden goldens check runs: refused when they read more than one source
// or one of them cannot be loaded. A golden the compiler refuses is not planned; it fails the check.
function checkPlan(bySource: Map<string, { source: SourceConfig; goldens: Planned[] }>, problems: GoldenCheck[]): QueryPlan {
  if (bySource.size > 1) {
    throw new UserError(
      `The goldens to check read sources ${[...bySource.keys()].join(", ")}. A plan covers one source: pass --source <s> or --name <g> with --emit-sql or --plan <plan_id>.`,
    );
  }
  if (problems.length) {
    throw new UserError(
      `Cannot plan every golden: ${problems.map((c) => `${c.name}: ${c.diffs[0]}`).join(" ")} Fix them, or pass --source <s> to plan the others.`,
    );
  }
  const [group] = bySource.values();
  if (!group) throw new UserError("No approved goldens to check that compile or have cross_check_sql; sl goldens check without --emit-sql says why.");
  const plans = group.goldens.map((g) => g.plan);
  return { ...plans[0]!, queries: plans.flatMap((p) => p.queries) };
}

// A golden the compiler refuses, as a failed check that names why and the step that resolves it.
function refusedCheck(g: Golden, compiled: CompileResult & { ok: false }): GoldenCheck {
  return { name: g.name, ok: false, diffs: [`The request does not compile from the current YAML: ${compiled.reason}.`], compiled: "refused", next: refusalNext(g, compiled) };
}

async function checkCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const selected = selectForCheck(ctx, values);
  const checks: GoldenCheck[] = [];
  const problems: GoldenCheck[] = [];
  const bySource = new Map<string, { source: SourceConfig; goldens: Planned[] }>();
  for (const loaded of selected) {
    const g = loaded.golden;
    const problem = goldenProblem(loaded);
    if (problem) {
      problems.push({ name: stem(basename(loaded.path)), ok: false, diffs: [problem] });
      continue;
    }
    let source: SourceConfig;
    let planned: { plan: QueryPlan; compiled: CompileResult };
    try {
      source = goldenSource(ctx, g);
      const compiled = compileGolden(ctx.root, g);
      // A source the compiler does not support is checked by its cross_check_sql alone; any other
      // refusal fails the golden, whatever its cross_check_sql gives.
      if (!compiled.ok && (!onlyUnsupportedDialect(compiled) || crossCheckSql(g) === undefined)) {
        checks.push(refusedCheck(g, compiled));
        continue;
      }
      planned = { plan: goldenPlan(g, source, compiled), compiled };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      const next = `Fix what this says in goldens/${g.name}.yaml or the layer, then run sl validate and sl goldens check --name ${g.name}.`;
      problems.push({ name: g.name, ok: false, diffs: [`Cannot plan this golden: ${e.message.split("\n")[0]}`], next });
      continue;
    }
    const group = bySource.get(source.source) ?? { source, goldens: [] };
    group.goldens.push({ golden: g, ...planned });
    bySource.set(source.source, group);
  }

  const { resultsFile, planId } = resultsInput(ctx, values);
  if (bool(values, "emit-sql")) {
    const plan = checkPlan(bySource, problems);
    for (const c of checks) ctx.err(plainText(`Not planned: ${c.name}. ${c.diffs[0]} ${c.next}`));
    ctx.out(formatJson(emitPlan(ctx, plan, { name: "goldens", positionals: ["check"], values })));
    return 0;
  }
  checks.push(...problems);
  // With --plan, every golden's rows come from the stored plan of the whole check.
  const stored: PlanResults | undefined = planId !== undefined ? planResults(ctx.root, planId, checkPlan(bySource, problems)) : undefined;

  for (const { source } of bySource.values()) {
    if (!canRun(source) && !resultsFile && !stored) {
      throw new UserError(
        `Source "${source.source}" is ${source.dialect}. Rerun with --emit-sql --source ${source.source}, run each query with your ` +
          "own tool, store each result with sl results add --plan <plan_id> --query <query id> --file <rows.json> and rerun with " +
          "--plan <plan_id>; or save {\"<query id>\": [rows...]} to a JSON file and rerun with --results <file>.",
      );
    }
  }

  for (const { source, goldens: group } of bySource.values()) {
    for (const { golden: g, plan, compiled } of group) {
      const ids = plan.queries.map((q) => q.id);
      const fromFile = resultsFile && (!canRun(source) || resultsCover(resultsFile, ids)) ? resultsFile : undefined;
      // Each query runs on its own, so a failure names the one that failed.
      const results: PlanResults = stored ?? {};
      let failure: string | undefined;
      for (const q of stored ? [] : plan.queries) {
        try {
          Object.assign(results, await executePlan({ ...plan, queries: [q] }, { root: ctx.root, source, env: ctx.env, resultsFile: fromFile, warn: ctx.err }));
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          const why = e.message.split("\n")[0]!.replace(/^Query failed: /, "");
          failure = q.id === goldenQueryId(g.name) ? `The query did not run: ${why}` : `cross_check_sql did not run: ${why}`;
          break;
        }
      }
      if (failure) {
        checks.push({ name: g.name, ok: false, diffs: [failure] });
        continue;
      }
      const expected = lowerKeys(g.expected?.rows ?? []);
      const compiledRows = compiled.ok ? (results[goldenQueryId(g.name)] ?? []) : undefined;
      const crossRows = crossCheckSql(g) !== undefined ? (results[crossCheckQueryId(g.name)] ?? []) : undefined;
      const judged = judgeGolden(expected, compiledRows, crossRows, {
        ordered: orderedGolden(g),
        tolerance: g.expected?.tolerance ?? DEFAULT_TOLERANCE,
        protectedColumns: maskedColumns(ctx, values, source, resultColumns([...expected, ...(compiledRows ?? []), ...(crossRows ?? [])])),
      });
      checks.push({ name: g.name, ...judged, ...(compiled.ok ? {} : { compiled: "unsupported" as const }) });
    }
  }
  checks.sort((a, b) => a.name.localeCompare(b.name));
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;

  if (ctx.json) ctx.out(formatJson({ passed, failed, results: checks }));
  else if (!checks.length) ctx.out("No approved goldens to check.");
  else {
    const lines: string[] = [];
    for (const c of checks) {
      const note = c.compiled === "unsupported" ? "  (checked by cross_check_sql alone: sl sql compiles postgres and duckdb sources)" : "";
      lines.push(`${c.ok ? "pass" : "FAIL"}  ${c.name}${note}`);
      for (const d of c.diffs) lines.push(`      ${plainText(d)}`);
      if (c.next) lines.push(`      Next: ${plainText(c.next)}`);
    }
    lines.push(`${passed} passed, ${failed} failed.`);
    const changed = checks.find((c) => !c.ok && !c.next);
    if (changed) {
      lines.push(
        `Next: sl goldens run --name ${changed.name} shows its rows; read any change back to the owner, and confirm again only on their yes ` +
          `(sl goldens confirm --name ${changed.name} --by "<owner>").`,
      );
    }
    ctx.out(lines.join("\n"));
  }
  return failed ? 1 : 0;
}

// --request for goldens new: a JSON object, or a YAML or JSON file holding a request or a whole
// golden (its request, role and user). A request without a source takes --source.
function readNewRequest(ctx: CommandContext, text: string, sourceFlag: string | undefined): { request: Record<string, unknown>; role?: string; user?: Record<string, unknown> } {
  let doc: unknown;
  if (text.trim().startsWith("{")) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new UserError(`--request is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    const file = resolve(ctx.cwd, text);
    if (!existsSync(file)) throw new UserError(`--request: no file ${text}. Pass a request as a JSON object or a file holding one.`);
    doc = parseYamlText(readFileSync(file, "utf8"), text);
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(doc)) throw new UserError('--request must be a JSON object, such as {"source": "lake", "measures": ["sessions.session_count"]}.');
  const whole = isObj(doc.request);
  const request = whole ? (doc.request as Record<string, unknown>) : doc;
  if (request.source === undefined && sourceFlag) request.source = sourceFlag;
  if (sourceFlag && request.source !== sourceFlag) throw new UserError(`The request is on source ${String(request.source)}, not ${sourceFlag}; drop --source or fix the request.`);
  return {
    request,
    ...(whole && typeof doc.role === "string" ? { role: doc.role } : {}),
    ...(whole && isObj(doc.user) ? { user: doc.user } : {}),
  };
}

function parseUserFlag(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new UserError(`--user is not valid JSON: ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new UserError('--user must be a JSON object of user attributes, such as {"department": "sales"}.');
  return v as Record<string, unknown>;
}

// Why a new golden's role or user does not fit access.yaml, as sl validate reports it.
function accessProblem(ctx: CommandContext, role: string | undefined, user: Record<string, unknown> | undefined): string | undefined {
  const access = loadAccess(ctx.root);
  if (!access || typeof access !== "object") return undefined;
  const roles = Array.isArray(access.roles) ? access.roles.map((r) => r?.name) : [];
  if (role !== undefined && !roles.includes(role)) return `--role ${role} is not a role in access.yaml (roles: ${roles.join(", ") || "none"}); sl access lists them.`;
  const attrs = Array.isArray(access.user_attributes) ? access.user_attributes.map((a) => a?.name) : [];
  const unknown = Object.keys(user ?? {}).filter((k) => !attrs.includes(k));
  if (unknown.length) return `--user names ${unknown.join(", ")}, which access.yaml does not declare as user attributes (declared: ${attrs.join(", ") || "none"}).`;
  return undefined;
}

// goldens new: writes goldens/<name>.yaml as a draft golden holding the question and request, and
// prints the SQL the request compiles to now. The SQL is not stored: the request is the golden, and
// sl sql --request goldens/<name>.yaml prints it again from the YAML as it then stands.
async function newCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const name = requireName(values, "new");
  const path = goldenPath(ctx, name);
  const file = relative(ctx.root, path);
  const taken = listGoldens(ctx.root).find((g) => stem(basename(g.path)) === name);
  if (taken) {
    throw new UserError(`Golden "${name}" already exists (${relative(ctx.root, taken.path)}). Pick another --name, or see it with sl goldens run --name ${name}.`);
  }
  const question = str(values, "question")?.trim();
  if (!question) throw new UserError('goldens new needs --question "<the question in plain English>".');
  const text = str(values, "request");
  if (!text) throw new UserError("goldens new needs --request <json|file>: a JSON object or a file holding a request.");
  const read = readNewRequest(ctx, text, str(values, "source"));
  const role = str(values, "role") ?? read.role;
  const userFlag = str(values, "user");
  const user = userFlag !== undefined ? parseUserFlag(userFlag) : read.user;
  const golden = { name, question, ...(role !== undefined ? { role } : {}), ...(user !== undefined ? { user } : {}), request: read.request, status: "draft" } as unknown as Golden;
  const issues = schemaIssues("golden", golden, file);
  if (issues.length) {
    throw new UserError(
      `The golden would not be valid, so nothing was written:\n${issues.map((i) => `  ${i.path || "golden"}: ${i.message}`).join("\n")}\n` +
        "Fix the request (the format is in references/spec.md, goldens) and run sl goldens new again.",
    );
  }
  const source = goldenSource(ctx, golden);
  const problem = accessProblem(ctx, role, user);
  if (problem) throw new UserError(`${problem} Nothing was written.`);
  // The whole project as sl validate would read it with this golden written (JSON is YAML).
  const errors = validateProject(ctx.root, new Map([[paths(ctx.root).golden(name), JSON.stringify(golden)]])).filter((i) => i.level === "error" && i.file === file.split(sep).join("/"));
  if (errors.length) {
    throw new UserError(
      `sl validate would report errors on the golden, so nothing was written:\n${errors.map((i) => `  ${i.path || "golden"}: ${i.message}`).join("\n")}\n` +
        "Fix the request, --role or --user and run sl goldens new again.",
    );
  }
  const compiled = compileGolden(ctx.root, golden);
  writeYaml(path, golden);
  const next =
    `Run sl goldens run --name ${name} and read its rows back to the owner; once its measures are approved and the owner says the rows match ` +
    `a figure they trust, confirm it with sl goldens confirm --name ${name} --by "<owner>" --tolerance <agreed tolerance>.`;
  const refused = compiled.ok ? undefined : { reason: compiled.reason, refusals: compiled.refusals, next: refusalNext(golden, compiled) };
  if (ctx.json) {
    ctx.out(
      formatJson({
        name,
        path: file,
        written: true,
        status: "draft",
        source: source.source,
        compiled: compiled.ok,
        ...(compiled.ok ? { sql: compiled.sql, params: compiled.params } : { refused }),
        next,
      }),
    );
    return 0;
  }
  ctx.out(`Wrote ${file}, a draft golden.`);
  if (compiled.ok) {
    ctx.out(`Its request compiles from the current YAML to this SQL, which the golden does not store (sl sql --request ${file} prints it again):`);
    ctx.out(plainText(compiled.sql));
    ctx.out(plainText(`Parameters, bound in order: ${compiled.params.map((v, i) => `$${i + 1} = ${JSON.stringify(v)}`).join(", ") || "none"}`));
  } else ctx.out(plainText(`Its request does not compile from the current YAML yet: ${refused!.reason}. ${refused!.next}`));
  ctx.out(next);
  return 0;
}

const spec: CommandSpec = {
  summary: "Compile and run a golden's request, record the owner-confirmed rows, recheck approved goldens, or write a draft golden.",
  usage:
    "goldens run --name <g> | goldens confirm --name <g> --by <name> [--tolerance <t>] [--force] | " +
    "goldens check [--name <g>] [--source <s>]   (each takes --emit-sql, --results <file>, --plan <plan_id> and --show-protected; values of protected " +
    "columns show as [protected] unless --show-protected) | " +
    'goldens new --name <g> --question "<question>" --request <json|file> [--source <s>] [--role <role>] [--user <json>]',
  options: {
    name: { type: "string" },
    by: { type: "string" },
    tolerance: { type: "string" },
    force: { type: "boolean" },
    source: { type: "string" },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
    plan: { type: "string" },
    "show-protected": { type: "boolean" },
    question: { type: "string" },
    request: { type: "string" },
    role: { type: "string" },
    user: { type: "string" },
  },
  positionals: true,
  async run({ values, positionals }, ctx) {
    const [sub, ...rest] = positionals;
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new UserError(`Pass a subcommand: ${SUBCOMMANDS.join(", ")}.`);
    }
    if (rest.length) throw new UserError(`Unexpected argument "${rest[0]}".`);
    switch (sub as Subcommand) {
      case "run":
        return runCommand(ctx, values);
      case "confirm":
        return confirmCommand(ctx, values);
      case "check":
        return checkCommand(ctx, values);
      case "new":
        return newCommand(ctx, values);
    }
  },
};
export default spec;

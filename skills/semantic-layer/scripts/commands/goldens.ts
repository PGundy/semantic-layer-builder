import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { canRun } from "../lib/adapters/index.ts";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, str, today } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { compareRows, goldenDraftFields, goldenPlan, goldenQueryId, resultColumns } from "../lib/goldens.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { executePlan } from "../lib/plan.ts";
import { listGoldens, loadMetrics, loadSource, paths, stem, type LoadedGolden } from "../lib/project.ts";
import type { Golden, Model, ResultRows, SourceConfig } from "../lib/types.ts";
import { NAME_PATTERN } from "../lib/types.ts";
import { readJson, readYaml, updateYaml } from "../lib/yaml.ts";

export const MAX_CONFIRM_ROWS = 200;
export const DEFAULT_TOLERANCE = 0.005;

const SUBCOMMANDS = ["run", "confirm", "check"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface GoldenCheck {
  name: string;
  ok: boolean;
  diffs: string[];
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

function resultsPath(ctx: CommandContext, values: OptionValues): string | undefined {
  const file = str(values, "results");
  return file ? resolve(ctx.cwd, file) : undefined;
}

// Runs one golden's query, live or from a results file.
async function runGolden(ctx: CommandContext, g: Golden, source: SourceConfig, resultsFile: string | undefined): Promise<ResultRows> {
  const plan = goldenPlan(g, source);
  const results = await executePlan(plan, { root: ctx.root, source, env: ctx.env, resultsFile });
  return results[goldenQueryId(g.name)] ?? [];
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

// Draft fields and metrics the golden's request uses, read from the source's models and
// metrics.yaml. The list is advisory: a file that cannot be read is skipped with a notice
// on stderr pointing to sl validate, and confirm goes on.
function draftFieldsOf(ctx: CommandContext, g: Golden, source: SourceConfig): string[] {
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
  if (unread.length) {
    ctx.err(`Could not read ${unread.join(", ")} to list draft fields (${firstError}); run sl validate.`);
  }
  return goldenDraftFields(g, models, metrics);
}

async function runCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const { golden } = loadGolden(ctx, requireName(values, "run"));
  const source = goldenSource(ctx, golden);
  if (bool(values, "emit-sql")) {
    ctx.out(formatJson(goldenPlan(golden, source)));
    return 0;
  }
  const rows = await runGolden(ctx, golden, source, resultsPath(ctx, values));
  const columns = resultColumns(rows);
  if (ctx.json) ctx.out(formatJson({ name: golden.name, columns, rows }));
  else {
    ctx.out(`${golden.name}: ${golden.question}`);
    ctx.out(formatTable(rows, columns));
    ctx.out(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
    ctx.out(`Read these rows back to the owner. Once they confirm them: sl goldens confirm --name ${golden.name} --by "<owner>" --tolerance <agreed tolerance>.`);
  }
  return 0;
}

async function confirmCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const { path, golden } = loadGolden(ctx, requireName(values, "confirm"));
  const by = str(values, "by")?.trim();
  if (!by) throw new UserError('goldens confirm needs --by "<name of the owner who confirmed the rows>".');
  const { tolerance, from: toleranceFrom } = parseTolerance(values, golden);
  const source = goldenSource(ctx, golden);
  if (bool(values, "emit-sql")) {
    ctx.out(formatJson(goldenPlan(golden, source)));
    return 0;
  }
  const draftFields = draftFieldsOf(ctx, golden, source);
  if (draftFields.length && !ctx.json) {
    ctx.out(
      `This golden's request uses draft field(s): ${draftFields.join(", ")}. A golden is confirmed after its measures are ` +
        "approved. Approve them once the owner confirms their readbacks, then confirm this golden again; sl validate warns until then.",
    );
  }
  const rows = await runGolden(ctx, golden, source, resultsPath(ctx, values));
  if (!rows.length) throw new UserError(`Golden "${golden.name}" returned no rows; a golden needs at least one expected row.`);
  if (rows.length > MAX_CONFIRM_ROWS && !bool(values, "force")) {
    throw new UserError(
      `Golden "${golden.name}" returned ${rows.length} rows, more than ${MAX_CONFIRM_ROWS}. A golden should be an aggregate the ` +
        "owner can check by eye; aggregate further or add a limit, or pass --force to record every row.",
    );
  }
  const confirmedAt = today(ctx);
  updateYaml(path, (doc) => {
    doc.set("expected", doc.createNode({ tolerance, rows }));
    doc.set("status", "approved");
    doc.set("confirmed_by", by);
    doc.set("confirmed_at", confirmedAt);
  });
  if (ctx.json) ctx.out(formatJson({ name: golden.name, rows, written: true, tolerance, draft_fields: draftFields }));
  else {
    const toleranceNote =
      toleranceFrom === "flag" ? "" : toleranceFrom === "file" ? ", kept from the file" : ", the default; agree one with the owner and pass --tolerance";
    ctx.out(formatTable(rows, resultColumns(rows)));
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

async function checkCommand(ctx: CommandContext, values: OptionValues): Promise<number> {
  const selected = selectForCheck(ctx, values);
  const checks: GoldenCheck[] = [];
  const bySource = new Map<string, { source: SourceConfig; goldens: Golden[] }>();
  for (const loaded of selected) {
    const g = loaded.golden;
    const problem = goldenProblem(loaded);
    if (problem) {
      checks.push({ name: stem(basename(loaded.path)), ok: false, diffs: [problem] });
      continue;
    }
    let source: SourceConfig;
    try {
      source = goldenSource(ctx, g);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      checks.push({ name: g.name, ok: false, diffs: [`Cannot load its source: ${e.message.split("\n")[0]}`] });
      continue;
    }
    const group = bySource.get(source.source) ?? { source, goldens: [] };
    group.goldens.push(g);
    bySource.set(source.source, group);
  }

  if (bool(values, "emit-sql")) {
    if (bySource.size > 1) {
      throw new UserError(
        `The goldens to check read sources ${[...bySource.keys()].join(", ")}. A plan covers one source: pass --source <s> or --name <g> with --emit-sql.`,
      );
    }
    if (checks.length) {
      throw new UserError(
        `Cannot plan every golden: ${checks.map((c) => `${c.name}: ${c.diffs[0]}`).join(" ")} Fix them, or pass --source <s> to plan the others.`,
      );
    }
    const [group] = bySource.values();
    if (!group) throw new UserError("No approved goldens to check.");
    const plans = group.goldens.map((g) => goldenPlan(g, group.source));
    ctx.out(formatJson({ ...plans[0]!, queries: plans.flatMap((p) => p.queries) }));
    return 0;
  }

  const resultsFile = resultsPath(ctx, values);
  for (const { source } of bySource.values()) {
    if (!canRun(source) && !resultsFile) {
      throw new UserError(
        `Source "${source.source}" is ${source.dialect}. Rerun with --emit-sql --source ${source.source}, run each query with your ` +
          "own tool, save {\"<query id>\": [rows...]} to a JSON file and rerun with --results <file>.",
      );
    }
  }

  for (const { source, goldens: group } of bySource.values()) {
    for (const g of group) {
      const id = goldenQueryId(g.name);
      const fromFile = resultsFile && (!canRun(source) || resultsCover(resultsFile, [id])) ? resultsFile : undefined;
      let actual: ResultRows;
      try {
        actual = await runGolden(ctx, g, source, fromFile);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        checks.push({ name: g.name, ok: false, diffs: [`The query did not run: ${e.message.split("\n")[0]!.replace(/^Query failed: /, "")}`] });
        continue;
      }
      const { ok, diffs } = compareRows(lowerKeys(g.expected?.rows ?? []), actual, {
        ordered: (g.request?.order_by ?? []).length > 0,
        tolerance: g.expected?.tolerance ?? DEFAULT_TOLERANCE,
      });
      checks.push({ name: g.name, ok, diffs });
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
      lines.push(`${c.ok ? "pass" : "FAIL"}  ${c.name}`);
      for (const d of c.diffs) lines.push(`      ${d}`);
    }
    lines.push(`${passed} passed, ${failed} failed.`);
    ctx.out(lines.join("\n"));
  }
  return failed ? 1 : 0;
}

const spec: CommandSpec = {
  summary: "Run a golden's SQL, record the owner-confirmed rows, or recheck approved goldens.",
  usage:
    "goldens run --name <g> | goldens confirm --name <g> --by <name> [--tolerance <t>] [--force] | " +
    "goldens check [--name <g>] [--source <s>]   (each takes --emit-sql and --results <file>)",
  options: {
    name: { type: "string" },
    by: { type: "string" },
    tolerance: { type: "string" },
    force: { type: "boolean" },
    source: { type: "string" },
    "emit-sql": { type: "boolean" },
    results: { type: "string" },
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
    }
  },
};
export default spec;

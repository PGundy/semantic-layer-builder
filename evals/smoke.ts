#!/usr/bin/env bun
// bun evals/smoke.ts [--report-only] [--update-baseline] [--baseline <file>] [--out <dir>]
//   [--driver scripted|sdk] [--runs <n>] [--model <id>]
// Runs the smoke subset, grades each run and compares every grader's score with evals/baseline.json
// (docs/PRD.md FR-6.4); a PostgreSQL scenario whose URL variable is unset is reported "not run".
// Exit codes: 0 when no score fell below its baseline by more than its band (always with --report-only or --update-baseline), 1 on a regression, 2 when the smoke could not run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import type { GradeReport } from "./graders/types.ts";
import { scriptedDriver } from "./runner/drivers/scripted.ts";
import { sdkDriver } from "./runner/drivers/sdk.ts";
import { loadScenario, loadScript, REPO_ROOT, scenarioPath, stableJson } from "./runner/files.ts";
import { runScenario, steppingClock } from "./runner/runner.ts";
import { EvalError, NotRun, type StopReason } from "./runner/types.ts";

// One fixture, two personas.
export const SMOKE_SCENARIOS = ["acme-structured", "acme-terse"] as const;
// The PostgreSQL scenarios join the subset when their URL variable is set; otherwise the smoke says each
// was not run, compares nothing for it and keeps its baseline entry as it is.
export const PG_SMOKE_SCENARIO = "acme-pg-structured";
export const PG_NOISY_SCENARIO = "acme-noisy-200";
export const PG_SMOKE_SCENARIOS = [PG_SMOKE_SCENARIO, PG_NOISY_SCENARIO] as const;
// Graders that measure and never fail: recorded in the baseline's `effort`, never compared.
export const REPORT_ONLY_GRADERS = new Set(["effort"]);
// The effort metrics the baseline records: every one but the per-item and per-role token figures,
// which the scripted driver computes at replay; `tokens`, the run's total, stays as a reference.
export const recordedEffort = (metric: string) => metric === "tokens" || !metric.includes("token");
// How far above the baseline's `effort.tokens` a run's total may go before the smoke warns.
export const TOKEN_WARN_SHARE = 0.1;
export const BASELINE_FILE = join(REPO_ROOT, "evals", "baseline.json");
// The scripted driver's clock starts here on every run, so its runs and the baseline are reproducible.
export const SMOKE_START = "2026-01-01T00:00:00Z";

export const USAGE =
  "Usage: bun evals/smoke.ts [--report-only] [--update-baseline] [--baseline <file>] [--out <dir>] [--driver scripted|sdk] [--runs <n>] [--model <id>]";

export interface BaselineGrader {
  score: number | null;
  // How far below `score` a run may fall before it is a regression.
  band: number;
}

export interface BaselineScenario {
  stop_reason: StopReason;
  graders: Record<string, BaselineGrader>;
  effort: Record<string, number | null>;
}

export interface Baseline {
  version: 1;
  driver: "scripted" | "sdk";
  runs: number;
  scenarios: Record<string, BaselineScenario>;
}

// One scenario's runs: each run's grades and why it stopped.
export interface Observed {
  scenario: string;
  runs: { report: GradeReport; stop_reason: StopReason }[];
}

export interface Row {
  scenario: string;
  grader: string;
  baseline: string;
  score: string;
  band: string;
  status: "ok" | "improved" | "new" | "not graded" | "not run" | "REGRESSION";
  why?: string;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const show = (n: number | null | undefined) => (n === null || n === undefined ? "-" : String(n));

// A path as messages show it: relative to the working directory when inside it, else absolute.
export function shownPath(p: string): string {
  const r = relative(process.cwd(), p);
  return !r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r) ? p : r;
}

export const RECORD_COMMAND = "bun run eval:smoke -- --update-baseline";

// Per grader: the mean score over the runs (null when no run scored it) and the spread between the
// highest and lowest; the effort metrics' means; and the stop reason (the first that is not done).
export function aggregate(o: Observed): { scores: Map<string, { score: number | null; spread: number }>; effort: Record<string, number | null>; stop_reason: StopReason } {
  const scores = new Map<string, { score: number | null; spread: number }>();
  const metricValues = new Map<string, number[]>();
  for (const { report } of o.runs) {
    for (const g of report.graders) {
      if (REPORT_ONLY_GRADERS.has(g.grader)) {
        for (const [k, v] of Object.entries(g.metrics ?? {}).filter(([k]) => recordedEffort(k))) {
          if (!metricValues.has(k)) metricValues.set(k, []);
          if (v !== null) metricValues.get(k)!.push(v);
        }
        continue;
      }
      if (!scores.has(g.grader)) scores.set(g.grader, { score: null, spread: 0 });
    }
  }
  for (const name of scores.keys()) {
    const xs = o.runs.flatMap(({ report }) => report.graders.filter((g) => g.grader === name && g.score !== null).map((g) => g.score as number));
    const m = mean(xs);
    scores.set(name, { score: m === null ? null : round(m, 4), spread: xs.length > 1 ? round(Math.max(...xs) - Math.min(...xs), 4) : 0 });
  }
  const effort = Object.fromEntries([...metricValues].map(([k, xs]) => [k, xs.length ? round(mean(xs)!, 2) : null]));
  const stop_reason = o.runs.find((r) => r.stop_reason !== "done")?.stop_reason ?? "done";
  return { scores, effort, stop_reason };
}

// A baseline from the observed runs. With more than one run a grader's band is the observed spread;
// with one, it keeps the band the previous baseline (of the same driver) gave it, else 0.
export function buildBaseline(observed: Observed[], driver: Baseline["driver"], runs: number, previous?: Baseline): Baseline {
  const keep = previous && previous.driver === driver ? previous : undefined;
  const scenarios: Record<string, BaselineScenario> = {};
  for (const o of observed) {
    const a = aggregate(o);
    const graders: Record<string, BaselineGrader> = {};
    for (const [name, { score, spread }] of a.scores) {
      graders[name] = { score, band: runs > 1 ? spread : (keep?.scenarios[o.scenario]?.graders[name]?.band ?? 0) };
    }
    scenarios[o.scenario] = { stop_reason: a.stop_reason, graders, effort: a.effort };
  }
  return { version: 1, driver, runs, scenarios };
}

export function baselineText(b: Baseline): string {
  return `${stableJson(b, 2)}\n`;
}

// Compares each grader's score with the baseline. A score below the baseline minus its band is a
// regression, and so is a grader that was scored and no longer is, a missing grader, a run that no
// longer finishes as the baseline's did, and a scenario the baseline lacks.
export function compare(baseline: Baseline, observed: Observed[]): Row[] {
  const rows: Row[] = [];
  for (const o of observed) {
    const base = baseline.scenarios[o.scenario];
    const a = aggregate(o);
    if (!base) {
      rows.push({ scenario: o.scenario, grader: "(all)", baseline: "-", score: "-", band: "-", status: "REGRESSION", why: "the baseline has no entry for this scenario" });
      continue;
    }
    if (base.stop_reason === "done" && a.stop_reason !== "done") {
      rows.push({ scenario: o.scenario, grader: "(run)", baseline: "done", score: a.stop_reason, band: "-", status: "REGRESSION", why: `the run stopped on ${a.stop_reason}` });
    }
    const names = [...a.scores.keys(), ...Object.keys(base.graders).filter((n) => !a.scores.has(n)).sort()];
    for (const name of names) {
      const b = base.graders[name];
      const now = a.scores.get(name);
      const row = { scenario: o.scenario, grader: name, baseline: show(b?.score), score: now ? show(now.score) : "missing", band: b ? String(b.band) : "-" };
      if (!b) rows.push({ ...row, status: "new", why: "no baseline yet" });
      else if (!now) rows.push({ ...row, status: "REGRESSION", why: "the run has no such grader" });
      else if (b.score === null) rows.push({ ...row, status: now.score === null ? "not graded" : "new", ...(now.score === null ? {} : { why: "graded now, not in the baseline" }) });
      else if (now.score === null) rows.push({ ...row, status: "REGRESSION", why: "no longer graded" });
      else if (now.score < b.score - b.band - 1e-9) rows.push({ ...row, status: "REGRESSION", why: `below ${round(b.score - b.band, 4)}` });
      else rows.push({ ...row, status: now.score > b.score + b.band + 1e-9 ? "improved" : "ok" });
    }
  }
  const run = new Set(observed.map((o) => o.scenario));
  for (const name of Object.keys(baseline.scenarios).filter((n) => !run.has(n)).sort()) {
    rows.push({ scenario: name, grader: "(all)", baseline: "-", score: "-", band: "-", status: "not run", why: "the smoke subset no longer runs it" });
  }
  return rows;
}

// The baseline without the named scenarios, for a comparison that leaves them out.
function withoutScenarios(b: Baseline, names: Set<string>): Baseline {
  return { ...b, scenarios: Object.fromEntries(Object.entries(b.scenarios).filter(([n]) => !names.has(n))) };
}

export function formatRows(rows: Row[]): string {
  const head = ["scenario", "grader", "baseline", "score", "band", "status"];
  const cells = rows.map((r) => [r.scenario, r.grader, r.baseline, r.score, r.band, r.why ? `${r.status} (${r.why})` : r.status]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]! + 2))).join("");
  return [line(head), ...cells.map(line)].join("\n");
}

// The effort metrics beside the baseline's: reported, never compared. A run whose total tokens are
// more than TOKEN_WARN_SHARE above the baseline's `effort.tokens` gets a warning, which fails nothing.
export function formatEffort(baseline: Baseline | undefined, observed: Observed[], recordWith = RECORD_COMMAND): string {
  const lines = ["Effort (report only; it never fails the smoke):"];
  const warnings: string[] = [];
  for (const o of observed) {
    const base = baseline?.scenarios[o.scenario]?.effort ?? {};
    const effort = aggregate(o).effort;
    const parts = Object.entries(effort)
      .filter(([k, v]) => v !== null || (base[k] ?? null) !== null)
      .map(([k, v]) => `${k} ${show(v)} (baseline ${show(base[k])})`);
    lines.push(`  ${o.scenario}: ${parts.join(", ") || "nothing measured"}`);
    const now = effort.tokens ?? null;
    const was = base.tokens ?? null;
    if (now !== null && was !== null && was > 0 && now > was * (1 + TOKEN_WARN_SHARE)) {
      warnings.push(
        `Warning: ${o.scenario} used ${now} tokens, ${Math.round((now / was - 1) * 100)}% above the baseline's ${was} (more than ${TOKEN_WARN_SHARE * 100}%). ` +
          `Check what the change makes the agent read; if the rise is intended, record it with ${recordWith}.`,
      );
    }
  }
  return [...lines, ...warnings].join("\n");
}

// The baseline in an existing file, or what is wrong with it.
function parseBaseline(file: string): Baseline | string {
  const rel = shownPath(file);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return `${rel} is not valid JSON.`;
  }
  const issues = evalSchemaIssues("eval-baseline", data, rel);
  if (issues.length) return `${rel} does not match its schema:\n${issues.map((i) => `  ${i.path || "(top)"} ${i.message}`).join("\n")}`;
  return data as Baseline;
}

// `recordWith` is the command that records the baseline again, as the user would type it.
export function loadBaseline(file: string, recordWith = RECORD_COMMAND): Baseline {
  if (!existsSync(file)) throw new EvalError(`No baseline at ${shownPath(file)}. Record one with: ${recordWith}`);
  const b = parseBaseline(file);
  if (typeof b === "string") throw new EvalError(`${b}\nFix it, or record it again with: ${recordWith}`);
  return b;
}

export interface RunOneOptions {
  driver: Baseline["driver"];
  model?: string;
  env: Record<string, string | undefined>;
  outDir: string;
}

// Runs and grades one scenario once.
export async function runOne(name: string, opts: RunOneOptions): Promise<{ report: GradeReport; stop_reason: StopReason }> {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  const clock = opts.driver === "scripted" ? steppingClock(SMOKE_START) : () => new Date();
  const driver = opts.driver === "sdk" ? await sdkDriver({ model: opts.model, env: opts.env, agents: scenario.agents }) : scriptedDriver(loadScript(scenario, file), clock, scenario.fixture);
  const r = await runScenario({ scenario, driver, driverName: opts.driver, clock, outDir: opts.outDir, scenarioFile: file, env: opts.env });
  return { report: r.grades, stop_reason: r.summary.stop_reason };
}

export interface SmokeIO {
  out: (t: string) => void;
  err: (t: string) => void;
  env: Record<string, string | undefined>;
  // Replaced in tests to feed synthetic grades.
  runOne?: typeof runOne;
}

export async function main(argv: string[], io: SmokeIO): Promise<number> {
  let tempDir: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "report-only": { type: "boolean" },
        "update-baseline": { type: "boolean" },
        baseline: { type: "string" },
        out: { type: "string" },
        driver: { type: "string" },
        runs: { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    const driver = values.driver ?? "scripted";
    if (driver !== "scripted" && driver !== "sdk") throw new EvalError(`--driver is scripted or sdk, not "${driver}".`);
    const runs = values.runs === undefined ? 1 : Number(values.runs);
    if (!Number.isInteger(runs) || runs < 1) throw new EvalError(`--runs takes a whole number of 1 or more, not "${values.runs}".`);
    const file = resolve(values.baseline ?? BASELINE_FILE);
    const rel = shownPath(file);
    const update = values["update-baseline"] === true;
    // The command that records this baseline again, built from the flags given.
    const recordWith = [
      RECORD_COMMAND,
      ...(driver !== "scripted" ? [`--driver ${driver}`] : []),
      ...(runs > 1 ? [`--runs ${runs}`] : []),
      ...(values.baseline !== undefined ? [`--baseline ${rel}`] : []),
    ].join(" ");
    const ownFile = `${RECORD_COMMAND} --driver ${driver} --baseline evals/baseline.${driver}.json`;
    let baseline: Baseline | undefined;
    if (!update) {
      baseline = loadBaseline(file, recordWith);
      if (baseline.driver !== driver) {
        throw new EvalError(`${rel} was recorded with the ${baseline.driver} driver; rerun with --driver ${baseline.driver}, or record ${driver === "sdk" ? "an" : "a"} ${driver} baseline in its own file with: ${ownFile}`);
      }
    } else if (existsSync(file)) {
      // The previous baseline only lends its bands, so a broken one is set aside rather than fatal.
      const prev = parseBaseline(file);
      if (typeof prev === "string") {
        io.err(`smoke: ignoring the previous baseline: ${prev}\nEvery band starts at 0.`);
      } else if (prev.driver !== driver && values.baseline === undefined) {
        throw new EvalError(`${rel} holds the ${prev.driver} driver's baseline, which CI compares with; record ${driver === "sdk" ? "an" : "a"} ${driver} baseline in its own file with: ${ownFile}`);
      } else {
        baseline = prev;
      }
    }

    // Runs go to --out, kept, or to a temporary directory removed afterwards; never to the repository.
    const outRoot = values.out ? resolve(values.out) : (tempDir = mkdtempSync(join(tmpdir(), "semlayer-smoke-")));
    const run = io.runOne ?? runOne;
    const observed: Observed[] = [];
    const notRun: { scenario: string; why: string }[] = [];
    for (const name of [...SMOKE_SCENARIOS, ...PG_SMOKE_SCENARIOS]) {
      const o: Observed = { scenario: name, runs: [] };
      try {
        for (let i = 0; i < runs; i++) {
          const outDir = runs > 1 ? join(outRoot, `run-${i + 1}`) : outRoot;
          mkdirSync(outDir, { recursive: true });
          o.runs.push(await run(name, { driver, model: values.model, env: io.env, outDir }));
        }
      } catch (e) {
        if (!(e instanceof NotRun)) throw e;
        notRun.push({ scenario: name, why: e.message });
        continue;
      }
      observed.push(o);
    }
    // A scenario that was not run is neither compared nor dropped from the baseline.
    const skipped = new Set(notRun.map((n) => n.scenario));
    const notRunText = notRun.map((n) => n.why).join("\n");

    if (update) {
      const next = buildBaseline(observed, driver, runs, baseline);
      for (const name of skipped) if (baseline?.scenarios[name]) next.scenarios[name] = baseline.scenarios[name]!;
      if (baseline) io.out(`${formatRows(compare(withoutScenarios(baseline, skipped), observed.filter((o) => baseline!.scenarios[o.scenario])))}\n`);
      writeFileSync(file, baselineText(next));
      io.out(formatEffort(next, observed));
      io.out("");
      if (notRunText) io.out(`${notRunText}\nIts baseline entry is kept as it was; record it where the variable is set.\n`);
      io.out(`Wrote ${rel} from ${runs} ${driver} run(s) of ${observed.map((o) => o.scenario).join(", ")}.`);
      io.out(`Next: commit ${rel}, and say in the pull request why the scores changed.`);
      return 0;
    }

    const rows = compare(withoutScenarios(baseline!, skipped), observed);
    const regressions = rows.filter((r) => r.status === "REGRESSION");
    io.out(formatRows(rows));
    io.out("");
    io.out(formatEffort(baseline, observed, recordWith));
    io.out("");
    if (notRunText) {
      io.out(notRunText);
      io.out("");
    }
    const kept = values.out ? ` The runs are in ${shownPath(outRoot)}.` : "";
    if (regressions.length) {
      io.out(`Smoke: ${regressions.length} regression(s) against ${rel}.${kept}`);
      io.out(
        `Next: rerun with --out <dir> to keep the runs, and read each run's grades.json and transcript.jsonl; ` +
          `if the drop is intended, record it with ${recordWith} and say why in the pull request.`,
      );
      if (values["report-only"]) {
        io.out("--report-only: exiting 0 despite the regression(s).");
        return 0;
      }
      return 1;
    }
    const stale = rows.some((r) => r.status === "improved" || r.status === "new" || r.status === "not run");
    io.out(`Smoke: no regression against ${rel}.${kept}`);
    io.out(stale ? `Next: the baseline is out of date (a score rose, a grader is new or a scenario is no longer run); record it with ${recordWith}.` : "Next: nothing to do for the evals.");
    return 0;
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`smoke: ${(e as Error).message}. ${USAGE}`);
      return 2;
    }
    io.err(e instanceof EvalError ? `smoke: ${(e as Error).message}` : `smoke: unexpected error: ${(e as Error).stack ?? e}`);
    return 2;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t), env: process.env }));
}

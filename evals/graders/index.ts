// Grades a finished run directory from its files alone: the final semantic root, transcript.jsonl
// and summary.json. No grader calls a model, and the same run always grades the same.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadScenario, readTree, REPO_ROOT, SCENARIOS_DIR, scenarioPath, stableJson } from "../runner/files.ts";
import type { Scenario, Summary, TranscriptTurn } from "../runner/types.ts";
import { EvalError } from "../runner/types.ts";
import { redactSecrets } from "../runner/redact.ts";
import { gradeApprovals } from "./approvals.ts";
import { gradeAuthority } from "./authority.ts";
import { gradeConnectionFirst } from "./connection-first.ts";
import { gradeEffort } from "./effort.ts";
import { gradeFigures } from "./figures.ts";
import { gradeSecrets, maskProtected, protectedValues } from "./secrets.ts";
import { gradeSelection } from "./selection.ts";
import type { GradeReport, GraderResult, RunFiles } from "./types.ts";

export const GRADES_FILE = "grades.json";

export interface GradeOptions {
  // The scenario to grade against; by default the one summary.json names, from evals/scenarios/.
  scenario?: Scenario;
  // Its file, which a mapping file in grading resolves from; evals/scenarios/ when not given.
  scenarioFile?: string;
}

// JSON text, or an EvalError naming the file (and line) that does not parse.
function parseJson<T>(text: string, where: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EvalError(`${where} is not valid JSON; rerun the scenario with bun evals/runner/run.ts to write it again.`);
  }
}

export function loadRun(dir: string, opts: GradeOptions = {}): RunFiles {
  const summaryFile = join(dir, "summary.json");
  if (!existsSync(summaryFile)) throw new EvalError(`${dir} holds no summary.json; pass a run directory that bun evals/runner/run.ts wrote.`);
  const summary = parseJson<Summary>(readFileSync(summaryFile, "utf8"), summaryFile);
  let scenario = opts.scenario;
  let scenarioFile = opts.scenarioFile;
  if (!scenario) {
    try {
      scenarioFile ??= scenarioPath(summary.scenario);
    } catch (e) {
      throw new EvalError(`${(e as Error).message.replace(/ Run: .*$/, "")} Grade against one with: bun evals/graders/grade.ts --run <dir> --scenario <name|file>`);
    }
    scenario = loadScenario(scenarioFile);
  }
  const transcriptFile = join(dir, "transcript.jsonl");
  const transcriptText = existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "";
  const transcript = transcriptText
    .split("\n")
    .map((l, i) => [l, i + 1] as const)
    .filter(([l]) => l.trim())
    .map(([l, n]) => parseJson<TranscriptTurn>(l, `${transcriptFile} line ${n}`));
  const root = join(dir, "semantic");
  const files = Object.fromEntries(Object.entries(readTree(root)).map(([p, t]) => [`semantic/${p}`, t]));
  return {
    dir,
    root,
    summary,
    transcript,
    transcriptText,
    files,
    fixtureDir: join(REPO_ROOT, "fixtures", summary.fixture),
    grading: scenario.grading ?? {},
    intakeSource: scenario.intake.source,
    scenarioDir: scenarioFile ? dirname(scenarioFile) : SCENARIOS_DIR,
  };
}

// Why a grader could not grade, safe to write: the message's first line only (a YAML error's
// second part quotes the file), paths relative to the run directory or the repository, credentials
// redacted and protected values masked.
export function cleanReason(message: string, dir: string, words?: Map<string, string>): string {
  const first = (message.split("\n")[0] ?? "").replace(/:\s*$/, "");
  const relative = first.replaceAll(`${dir}${sep}`, "").replaceAll(`${REPO_ROOT}${sep}`, "");
  return maskProtected(redactSecrets(relative), words);
}

// Runs every grader; one that throws fails with the reason, and the rest still run. Effort fails only
// on the scenario's max_interviewer_share: when it cannot measure, it says why and scores null.
export async function gradeRun(dir: string, opts: GradeOptions = {}): Promise<GradeReport> {
  const run = loadRun(dir, opts);
  const graders: [string, (r: RunFiles) => GraderResult | Promise<GraderResult>][] = [
    ["figures", gradeFigures],
    ["secrets", gradeSecrets],
    ["selection", gradeSelection],
    ["approvals", gradeApprovals],
    ["connection_first", gradeConnectionFirst],
    ["authority", gradeAuthority],
    ["effort", gradeEffort],
  ];
  const results: GraderResult[] = [];
  for (const [name, grade] of graders) {
    try {
      results.push(await grade(run));
    } catch (e) {
      const words = (await protectedValues(run.fixtureDir, run.grading.protected_columns).catch(() => undefined))?.words;
      const reason = cleanReason(String((e as Error).message ?? e), resolve(dir), words);
      results.push(
        name === "effort"
          ? { grader: name, score: null, passed: true, details: [`could not measure: ${reason}`] }
          : { grader: name, score: 0, passed: false, details: [`could not grade: ${reason}`] },
      );
    }
  }
  const scores = results.map((r) => r.score).filter((s): s is number => s !== null);
  return {
    run_id: run.summary.run_id,
    scenario: run.summary.scenario,
    persona: run.summary.persona,
    passed: results.every((r) => r.passed),
    score: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10000) / 10000 : null,
    graders: results,
  };
}

export function writeGrades(dir: string, report: GradeReport): string {
  const file = join(dir, GRADES_FILE);
  writeFileSync(file, `${stableJson(report, 2)}\n`);
  return file;
}

// The report as a table and the details under it.
export function formatReport(report: GradeReport): string {
  const score = (s: number | null) => (s === null ? "-" : s.toFixed(2));
  const result = (r: GraderResult) => (r.score === null && r.passed ? (r.grader === "effort" ? "measured" : "not graded") : r.passed ? "pass" : "FAIL");
  const lines = [
    `Grades for ${report.run_id}: ${report.passed ? "passed" : "failed"}, score ${score(report.score)}.`,
    "",
    `${"grader".padEnd(18)}${"score".padEnd(7)}result`,
    ...report.graders.map((r) => `${r.grader.padEnd(18)}${score(r.score).padEnd(7)}${result(r)}`),
  ];
  for (const r of report.graders) {
    lines.push("", `${r.grader}:`);
    for (const d of r.details) lines.push(`  - ${d}`);
  }
  return lines.join("\n");
}

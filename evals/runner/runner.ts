// Plays a skill agent against a simulated data owner for one scenario, under a turn and a token
// budget, and writes the run: transcript.jsonl, summary.json, the final semantic root and, from the
// graders, grades.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runCli } from "../../skills/semantic-layer/scripts/lib/cli.ts";
import { gradeRun, writeGrades } from "../graders/index.ts";
import type { GradeReport } from "../graders/types.ts";
import { PERSONAS_DIR, readTree, REPO_ROOT, stableJson } from "./files.ts";
import { redactSecrets } from "./redact.ts";
import type { Clock, Driver, Scenario, Speaker, StopReason, Summary, TranscriptTurn } from "./types.ts";
import { EvalError } from "./types.ts";

export interface RunOptions {
  scenario: Scenario;
  driver: Driver;
  driverName: string;
  clock: Clock;
  // The directory runs are written under; each run gets <outDir>/<run_id>/.
  outDir: string;
  // The scenario's file, which a mapping file in its grading resolves from.
  scenarioFile?: string;
}

export interface RunResult {
  runDir: string;
  summary: Summary;
  replaced: boolean;
  grades: GradeReport;
}

// A clock that starts at `start` and moves `stepMs` forward on every read, for tests and --now.
export function steppingClock(start: string | Date, stepMs = 1000): Clock {
  let t = new Date(start).getTime();
  if (Number.isNaN(t)) throw new EvalError(`"${String(start)}" is not a date; pass an ISO time such as 2026-01-01T00:00:00Z.`);
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

// <scenario>-<UTC time to the millisecond>, as 20260101T000000000Z.
export function runIdFor(scenario: string, at: Date): string {
  return `${scenario}-${at.toISOString().replace(/[-:.]/g, "")}`;
}

// Runs sl in-process in the working root with the run's clock, capturing its output.
export async function slIn(root: string, args: string[], clock: Clock): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--root", root], {
    cwd: root,
    env: { SL_NOW: clock().toISOString() },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// Writes the starting root for the scenario's intake: a project and one source, as a setup
// engineer leaves it. View paths are relative to the root, so the run directory stays readable.
async function prepareRoot(scenario: Scenario, root: string, clock: Clock): Promise<void> {
  const fixtureDir = relative(root, join(REPO_ROOT, "fixtures", scenario.fixture)).split("\\").join("/");
  const steps: string[][] = [
    ["init", "--name", scenario.fixture.replace(/[^a-z0-9_]/g, "_")],
    [
      "add-source",
      "--name",
      scenario.intake.source,
      "--dialect",
      scenario.intake.dialect,
      ...Object.entries(scenario.intake.views).flatMap(([name, rel]) => ["--view", `${name}=${rel.replaceAll("{fixture}", fixtureDir)}`]),
    ],
  ];
  for (const args of steps) {
    const r = await slIn(root, args, clock);
    if (r.code !== 0) throw new EvalError(`Setting up the working root failed at sl ${args[0]}: ${r.err || r.out}`);
  }
}

// The owner's brief, with the fixture's reference figures appended when it has them, since the
// simulated owner has no tools to open the file the brief points at.
function ownerBrief(fixture: string): string {
  const dir = join(REPO_ROOT, "fixtures", fixture);
  const brief = readFileSync(join(dir, "owner-brief.md"), "utf8");
  const figures = join(dir, "reference-figures.json");
  if (!existsSync(figures)) return brief;
  return `${brief}\n\n## fixtures/${fixture}/reference-figures.json\n\n${readFileSync(figures, "utf8")}`;
}

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const { scenario, driver, clock } = opts;
  const started = clock();
  const runId = runIdFor(scenario.name, started);
  const runDir = join(opts.outDir, runId);
  const replaced = existsSync(runDir);
  rmSync(runDir, { recursive: true, force: true });
  const root = join(runDir, "semantic");
  mkdirSync(root, { recursive: true });

  const turns: TranscriptTurn[] = [];
  const spent = { skill: 0, owner: 0 };
  const record = (speaker: Speaker, text: string, tokens: number, extra: Partial<TranscriptTurn> = {}) => {
    spent[speaker] += tokens;
    turns.push({ turn: turns.length + 1, speaker, text, tokens, timestamp: clock().toISOString(), ...extra });
  };
  const overTokens = () => spent.skill + spent.owner > scenario.budgets.max_tokens;
  const outOfTurns = () => turns.length >= scenario.budgets.max_turns;

  let stop: StopReason | undefined;
  let error: string | undefined;
  try {
    await prepareRoot(scenario, root, clock);
    const brief = ownerBrief(scenario.fixture);
    const personaPrompt = readFileSync(join(PERSONAS_DIR, `${scenario.persona}.md`), "utf8");
    record("owner", scenario.opening, 0);
    let ownerMessage = scenario.opening;
    while (!stop) {
      if (outOfTurns()) {
        stop = "turn_budget";
        break;
      }
      // A fresh context: the files as they stand and the latest owner message, nothing else.
      const skill = await driver.skillTurn({ root, files: readTree(root), owner_message: ownerMessage });
      record("skill", skill.text, skill.tokens, skill.commands?.length ? { commands: skill.commands } : {});
      if (overTokens()) stop = "token_budget";
      else if (skill.done) stop = "done";
      else if (outOfTurns()) stop = "turn_budget";
      if (stop) break;
      const owner = await driver.ownerTurn({
        brief,
        persona: scenario.persona,
        persona_prompt: personaPrompt,
        skill_message: skill.text,
        history: turns.map((t) => ({ speaker: t.speaker, text: t.text })),
      });
      record("owner", owner.text, owner.tokens);
      ownerMessage = owner.text;
      if (overTokens()) stop = "token_budget";
    }
  } catch (e) {
    stop = "error";
    error = (e as Error).message;
  }

  const summary: Summary = {
    run_id: runId,
    scenario: scenario.name,
    fixture: scenario.fixture,
    intake: scenario.intake.path,
    persona: scenario.persona,
    driver: opts.driverName,
    budgets: scenario.budgets,
    turns: turns.length,
    skill_turns: turns.filter((t) => t.speaker === "skill").length,
    owner_turns: turns.filter((t) => t.speaker === "owner").length,
    tokens: spent.skill + spent.owner,
    tokens_by_speaker: spent,
    stop_reason: stop ?? "error",
    ...(error === undefined ? {} : { error: redactSecrets(error) }),
    started_at: started.toISOString(),
    finished_at: clock().toISOString(),
  };
  // Written once the run stops, so a skill turn cannot read earlier turns from the run directory.
  const lines = turns.map((t) =>
    stableJson({ ...t, text: redactSecrets(t.text), commands: t.commands?.map((c) => ({ ...c, command: redactSecrets(c.command) })) }),
  );
  writeFileSync(join(runDir, "transcript.jsonl"), lines.map((l) => `${l}\n`).join(""));
  writeFileSync(join(runDir, "summary.json"), `${stableJson(summary, 2)}\n`);
  const grades = await gradeRun(runDir, { scenario, scenarioFile: opts.scenarioFile });
  writeGrades(runDir, grades);
  return { runDir, summary, replaced, grades };
}

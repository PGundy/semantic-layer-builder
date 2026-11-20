import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, scenarioPath } from "../evals/runner/files.ts";
import { runScenario, steppingClock } from "../evals/runner/runner.ts";
import { gradeRun } from "../evals/graders/index.ts";
import { isRegistered } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
import { tempDir } from "./helpers.ts";

// The validate grader: the final root of the scripted acme-structured run passes semlayer validate and
// scores 1; a root with a broken join scores 0 and lists the issue code.

const START = "2026-01-01T00:00:00.000Z";

let finished: string | undefined;
async function cleanRun(): Promise<string> {
  if (finished) return finished;
  const file = scenarioPath("acme-structured");
  const scenario = loadScenario(file);
  const out = tempDir("validate-grader");
  const r = await runScenario({
    scenario,
    driver: scriptedDriver(loadScript(scenario, file), steppingClock("2026-06-01T00:00:00Z")),
    driverName: "scripted",
    clock: steppingClock(START),
    outDir: out,
    scenarioFile: file,
  });
  finished = r.runDir;
  return r.runDir;
}
// A copy of the clean run at the same depth, so the fixture paths its views use still resolve.
async function copyRun(): Promise<{ dir: string; root: string }> {
  const dir = join(tempDir("validate-grader-copy"), "acme-structured-20260101T000000000Z");
  cpSync(await cleanRun(), dir, { recursive: true });
  return { dir, root: join(dir, "semantic") };
}
const validate = async (dir: string) => (await gradeRun(dir)).graders.find((g) => g.grader === "validate")!;

describe("validate grader", () => {
  test("the clean Acme root scores 1", async () => {
    const g = await validate(await cleanRun());
    expect(g).toMatchObject({ grader: "validate", score: 1, passed: true });
    expect(g.details).toHaveLength(1);
    expect(g.details[0]).toContain("no error");
  }, 30_000);

  test("a root with a broken join scores 0 and lists the code of each error", async () => {
    const { dir, root } = await copyRun();
    // A join without its required keys, relationship and status.
    appendFileSync(join(root, "models", "lake", "sessions.yaml"), "joins:\n  - { name: broken, to: marketing_spend }\n");
    const g = await validate(dir);
    expect(g).toMatchObject({ grader: "validate", score: 0, passed: false });
    const codes = [...g.details.join("\n").matchAll(/: ([a-z_]+\.[a-z0-9_]+)(?: at |:)/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(0);
    // A join missing its required keys is a schema.required error.
    expect(codes).toContain("schema.required");
    for (const c of codes) expect(isRegistered(c)).toBe(true);
    expect(g.details[0]).toContain("semantic/models/lake/sessions.yaml");
    expect(g.details.at(-1)).toContain("codes:");
  }, 30_000);

  test("a run that left no semantic root scores 0 with the next command", async () => {
    const { dir, root } = await copyRun();
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
    const g = await validate(dir);
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details[0]).toContain("bun evals/runner/run.ts");
  }, 30_000);
});

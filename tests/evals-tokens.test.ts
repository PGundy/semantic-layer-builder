import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { agentDefinitionChars, FIXED_CONTEXT, interviewerTokens, ownerTokens, printed, roleTokens, tokensOf } from "../evals/runner/count.ts";
import { fillForm, scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, REPO_ROOT, SCENARIOS_DIR, type Script, type ScriptTurn, scenarioPath, scriptWritePath } from "../evals/runner/files.ts";
import { runScenario, semlayerIn, steppingClock } from "../evals/runner/runner.ts";
import type { Driver, Scenario, Summary, TranscriptTurn } from "../evals/runner/types.ts";
import { BASELINE_FILE, type Baseline } from "../evals/smoke.ts";
import { type Role, ROLES, semlayerRefusal } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { tempDir } from "./helpers.ts";

// The counting rule of evals/README.md, Token counts, lives in evals/runner/count.ts and the scripted
// driver applies it at replay: no script carries a count. Here every script's replay is checked
// against a recount made apart from the driver, count.ts against a fixed sample, and a reworded
// printed sentence in a scratch copy of the repository moves the counts without failing the smoke or
// the eval tests.

const START = "2026-01-01T00:00:00Z";

// Replays a scenario with the scripted driver and returns its transcript.
async function replay(file: string, out: string, script?: Script, scenario?: Scenario) {
  const sc = scenario ?? loadScenario(file);
  const driver = scriptedDriver(script ?? loadScript(sc, file), steppingClock(START), sc.fixture);
  const r = await runScenario({ scenario: sc, driver, driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file });
  const transcript = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
  return { ...r, transcript };
}

// The counts of every skill turn (interviewer and role, in script order) and owner answer, recounted
// apart from the driver: a driver of its own replays the script and applies count.ts's rule to it.
async function recount(file: string): Promise<{ skill: number[]; owner: number[] }> {
  const scenario = loadScenario(file);
  const script = loadScript(scenario, file);
  const clock = steppingClock("2026-06-01T00:00:00Z");
  const skill: number[] = [];
  const owner: number[] = [];
  let at = 0;
  let ownerAt = 0;
  const run = async (role: Role, turn: ScriptTurn, root: string) => {
    const fixtureDir = relative(root, join(REPO_ROOT, "fixtures", scenario.fixture)).split(sep).join("/");
    const shown: string[] = [];
    for (const args of turn.semlayer ?? []) {
      const refused = semlayerRefusal(role, args);
      if (refused) shown.push(refused);
      else {
        const r = await semlayerIn(root, args.map((a) => a.replaceAll("{fixture}", fixtureDir)), clock);
        shown.push(printed(r.out, r.err, root));
      }
    }
    return shown;
  };
  const driver: Driver = {
    async skillTurn(input) {
      const turn = script.skill[at++]!;
      const written = Object.entries(turn.write ?? {}).map(([rel, text]) => {
        const path = scriptWritePath(input.root, rel, text);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        return text;
      });
      const shown = await run(ROLES.interviewer, turn, input.root);
      const roles: number[] = [];
      const reports: string[] = [];
      while (script.skill[at]?.agent) {
        const task = script.skill[at++]!;
        const role = ROLES[task.agent!];
        roles.push(roleTokens(role, { text: task.text, printed: await run(role, task, input.root) }));
        reports.push(task.text);
      }
      const tokens = interviewerTokens({ text: turn.text, written, printed: shown, reports });
      skill.push(tokens, ...roles);
      return { text: turn.text, tokens, done: turn.done === true };
    },
    async ownerTurn(input) {
      const turn = script.owner[ownerAt++]!;
      owner.push(ownerTokens(turn.text));
      const files = Object.fromEntries((turn.fill ?? []).map((f) => [f.as, fillForm(f, input.forms ?? {}, ownerAt)]));
      return { text: turn.text, tokens: owner.at(-1)!, ...(turn.fill?.length ? { files } : {}) };
    },
  };
  await runScenario({ scenario, driver, driverName: "scripted", clock: steppingClock(START), outDir: tempDir("evals-tokens"), scenarioFile: file });
  return { skill, owner };
}

const scenarios = readdirSync(SCENARIOS_DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".script.json") && !f.endsWith(".figures.json"))
  .map((f) => join(SCENARIOS_DIR, f))
  .filter((f) => loadScenario(f).script !== undefined)
  .sort();

describe("the counting rule, count.ts", () => {
  test("on a fixed sample", () => {
    expect(FIXED_CONTEXT).toBe(500);
    expect([tokensOf(0), tokensOf(1), tokensOf(4), tokensOf(5)]).toEqual([0, 1, 1, 2]);
    // 4 + 8 + 6 + 3 characters: 21, so 6 tokens over the fixed context.
    expect(interviewerTokens({ text: "Keep", written: ["name: a\n"], printed: ["Valid."], reports: ["ok."] })).toBe(506);
    expect(interviewerTokens({ text: "", written: [], printed: [], reports: [] })).toBe(500);
    const role = ROLES.batch_analyst;
    const definition = readFileSync(join(REPO_ROOT, "agents", `${role.agent}.md`), "utf8").length;
    expect(agentDefinitionChars(role)).toBe(definition);
    expect(roleTokens(role, { text: "1. one row per visit?", printed: ["abc"] })).toBe(Math.ceil((definition + 21 + 3) / 4));
    expect(ownerTokens("yep")).toBe(1);
    expect(ownerTokens("build the layer")).toBe(4);
    // Output then error, nothing between them, and the root's path written as ".".
    expect(printed("Wrote /r/x/a.yaml.", "warning: /r/x/b", "/r/x")).toBe("Wrote ./a.yaml.warning: ./b");
  });

  test("a script with no tokens field replays, and each turn's count is count.ts's", async () => {
    const file = scenarioPath("acme-multi");
    const scenario = loadScenario(file);
    const golden = "name: g\n";
    const script: Script = {
      skill: [
        { text: "I wrote a draft.", write: { "goldens/g.yaml": golden } },
        { text: "Done.", semlayer: [["approve", "--target", "model:lake.sessions"]], done: true },
        { text: "Tried.", agent: "batch_analyst", semlayer: [["approve", "--target", "model:lake.sessions"]] },
      ],
      owner: [{ text: "go ahead" }],
    };
    const r = await replay(file, tempDir("evals-tokens"), script, { ...scenario, grading: {} });
    expect(r.summary.stop_reason).toBe("done");
    const refusal = semlayerRefusal(ROLES.batch_analyst, ["approve", "--target", "model:lake.sessions"])!;
    expect(refusal).toBeString();
    const [opening, first, owner, second, role] = r.transcript;
    expect(opening!.tokens).toBe(0);
    expect(first!.tokens).toBe(FIXED_CONTEXT + tokensOf("I wrote a draft.".length + golden.length));
    expect(owner!.tokens).toBe(tokensOf("go ahead".length));
    expect(role).toMatchObject({ speaker: "batch_analyst", tokens: tokensOf(agentDefinitionChars(ROLES.batch_analyst) + "Tried.".length + refusal.length) });
    expect(role!.commands).toEqual([{ command: "semlayer approve --target model:lake.sessions", exit_code: 1, refused: refusal }]);
    // The interviewer's approve ran and printed; its turn holds that text and the role's report.
    expect(second!.tokens).toBeGreaterThan(FIXED_CONTEXT + tokensOf("Done.".length + "Tried.".length));
    expect(r.summary.tokens).toBe(r.transcript.reduce((n, t) => n + t.tokens, 0));
  }, 60_000);

  test("a script that still gives a turn tokens fails its schema", () => {
    const issues = evalSchemaIssues("eval-script", { skill: [{ text: "hi", tokens: 5 }], owner: [{ text: "yo", tokens: 1 }] }, "x.script.json");
    expect(issues.length).toBe(2);
  });
});

describe("scripted token counts", () => {
  test("every scenario with a script is counted, and no script holds a count", () => {
    expect(scenarios.map((f) => f.slice(SCENARIOS_DIR.length + 1))).toEqual([
      "acme-busy.json",
      "acme-contradicting.json",
      "acme-credential.json",
      "acme-export-upgrade.json",
      "acme-export.json",
      "acme-hedging.json",
      "acme-injection.json",
      "acme-multi.json",
      "acme-structured.json",
      "acme-terse.json",
    ]);
    for (const f of readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".script.json"))) {
      expect(JSON.stringify(JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8"))), f).not.toContain('"tokens":');
    }
  });

  for (const file of scenarios) {
    const name = loadScenario(file).name;
    test(`${name}: every turn the driver records equals a recount by the rule`, async () => {
      const r = await replay(file, tempDir("evals-tokens"));
      expect(r.summary.stop_reason).toBe("done");
      const answers = r.transcript.slice(1).filter((t) => t.speaker === "owner");
      const got = { skill: r.transcript.filter((t) => t.speaker !== "owner").map((t) => t.tokens), owner: answers.map((t) => t.tokens) };
      const want = await recount(file);
      expect(got).toEqual(want);
    }, 60_000);
  }

  test("the spec's summary example adds up, and its figures are not pinned to a run", () => {
    const spec = readFileSync(join(REPO_ROOT, "skills", "semantic-layer", "references", "spec.md"), "utf8");
    const block = spec.split("```json\n").map((b) => b.split("\n```")[0]!).find((b) => b.includes('"run_id": "acme-terse-') && b.includes('"tokens_by_speaker"'));
    const example = JSON.parse(block!) as Summary;
    expect(evalSchemaIssues("eval-summary", example, "spec.md")).toEqual([]);
    expect(example.tokens).toBe(example.tokens_by_speaker.skill + example.tokens_by_speaker.owner);
    expect(example.turns).toBe(example.skill_turns + example.owner_turns);
    expect(spec).toContain("show the shape and the sums");
  });

  test("a count does not depend on where the run is written", async () => {
    const shallow = tempDir("t");
    const deep = join(tempDir("evals-tokens-deeper"), "one", "two", "three");
    for (const name of ["acme-structured", "acme-export-upgrade"]) {
      const file = scenarioPath(name);
      const d = await replay(file, deep);
      const s = await replay(file, shallow);
      expect(d.transcript.map((t) => t.tokens)).toEqual(s.transcript.map((t) => t.tokens));
    }
  }, 120_000);
});

// A scratch copy of what the smoke reads, with node_modules linked, in which a source file is changed.
function scratchCopy(): string {
  const dir = tempDir("evals-tokens-copy");
  for (const entry of [".github", ".gitignore", "agents", "bunfig.toml", "evals", "examples", "fixtures", "skills", "tests", "package.json", "tsconfig.json"]) {
    cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true, filter: (src) => !src.includes(`${sep}evals${sep}runs`) });
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function reword(dir: string, from: string, to: string) {
  const file = join(dir, "skills", "semantic-layer", "scripts", "commands", "validate.ts");
  const text = readFileSync(file, "utf8");
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

function smokeIn(dir: string) {
  const r = Bun.spawnSync(["bun", "evals/smoke.ts"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// The eval test files that compare token counts, run in the copy.
const COUNTING_TESTS = ["evals-baseline", "evals-multi", "evals-runner", "evals-graders", "next-runnable"].map((t) => `tests/${t}.test.ts`);

function testsIn(dir: string) {
  const r = Bun.spawnSync(["bun", "test", ...COUNTING_TESTS], { cwd: dir, env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
}

// The total each smoke scenario printed: "  <scenario>: ..., tokens <n> (baseline <m>), ...".
const printedTotals = (out: string) =>
  Object.fromEntries([...out.matchAll(/^ {2}(acme-[a-z]+): .*\btokens (\d+) \(baseline (\d+)\)/gm)].map((m) => [m[1]!, { now: Number(m[2]), was: Number(m[3]) }]));

describe("a reworded printed sentence", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;

  test("changes the counts and fails nothing; only a rise past 10% warns", () => {
    const dir = scratchCopy();
    // semlayer validate's last line, which the scripted runs print.
    reword(dir, "`Valid: ${", "`The layer is valid, with ${");
    const small = smokeIn(dir);
    expect(small.err).toBe("");
    expect(small.code).toBe(0);
    const totals = printedTotals(small.out);
    for (const [name, s] of Object.entries(baseline.scenarios)) {
      expect(totals[name]!.was).toBe(s.effort.tokens!);
      expect(totals[name]!.now).not.toBe(s.effort.tokens!);
    }
    expect(small.out).not.toContain("Warning:");
    expect(small.out).toContain("Smoke: no regression against evals/baseline.json.");
    // No test pins a count: the eval tests pass in the reworded copy with no recount.
    const tests = testsIn(dir);
    expect(tests.code, tests.text.split("\n").filter((l) => l.startsWith("(fail)")).join("\n")).toBe(0);
    expect(tests.text).toContain(" 0 fail");

    // The deliberate breach: a sentence long enough to lift every total past 10% warns, and still exits 0.
    reword(dir, "`The layer is valid, with ${", '`${"The layer is valid. ".repeat(400)}${');
    const big = smokeIn(dir);
    expect(big.code).toBe(0);
    for (const name of Object.keys(baseline.scenarios)) expect(big.out).toContain(`Warning: ${name} used `);
    expect(big.out).toContain("Smoke: no regression against evals/baseline.json.");
  }, 240_000);
});

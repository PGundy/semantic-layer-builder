import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type Role, ROLES, slRefusal } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { loadScenario, loadScript, REPO_ROOT, SCENARIOS_DIR, type Script, type ScriptTurn, scriptWritePath } from "../evals/runner/files.ts";
import { runScenario, slIn, steppingClock } from "../evals/runner/runner.ts";
import type { Driver, RoleTurn, Summary, Scenario } from "../evals/runner/types.ts";

// The counting rule of evals/README.md, Token counts: every scripted scenario's canned tokens are
// recomputed by replaying its script with a driver that counts each turn by the rule instead of
// reading its `tokens`. SL_EVAL_RECOUNT=1 rewrites the scripts' counts in place to the recount.

const FIXED_CONTEXT = 500;
const tokensOf = (chars: number) => Math.ceil(chars / 4);
// A character is one UTF-16 code unit (a string's length); the counted text holds none outside the
// Basic Multilingual Plane, so that is also the count a reader gets character by character.
const chars = (text: string) => {
  if ([...text].length !== text.length) throw new Error(`Counted text holds a character outside the Basic Multilingual Plane: ${JSON.stringify(text.slice(0, 80))}; write it without one.`);
  return text.length;
};
const SPEC = join(REPO_ROOT, "skills", "semantic-layer", "references", "spec.md");
const agentDefinition = (role: Role) => chars(readFileSync(join(REPO_ROOT, "agents", `${role.agent}.md`), "utf8"));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Recount {
  skill: number[];
  owner: number[];
}

// Replays the script as the scripted driver does (writes, role guard, `{fixture}`), counting each turn.
async function recount(file: string, outDir: string): Promise<Recount & { stop: string; summary: Summary }> {
  const scenario: Scenario = loadScenario(file);
  const script: Script = loadScript(scenario, file);
  const clock = steppingClock("2026-06-01T00:00:00Z");
  const skill: number[] = [];
  let at = 0;
  let ownerAt = 0;
  // The characters a turn's sl commands print, stdout and stderr, the working root's path counted as ".".
  const printed = async (role: Role, turn: ScriptTurn, root: string) => {
    const fixtureDir = relative(root, join(REPO_ROOT, "fixtures", scenario.fixture)).split(sep).join("/");
    let n = 0;
    for (const args of turn.sl ?? []) {
      const refused = slRefusal(role, args);
      if (refused) {
        n += chars(refused);
        continue;
      }
      const r = await slIn(root, args.map((a) => a.replaceAll("{fixture}", fixtureDir)), clock);
      n += chars((r.out + r.err).replaceAll(root, "."));
    }
    return n;
  };
  const driver: Driver = {
    async skillTurn(input) {
      const turn = script.skill[at++]!;
      const mine = skill.push(0) - 1;
      let n = chars(turn.text);
      for (const [rel, text] of Object.entries(turn.write ?? {})) {
        const path = scriptWritePath(input.root, rel, text);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        n += chars(text);
      }
      n += await printed(ROLES.interviewer, turn, input.root);
      const dispatches: RoleTurn[] = [];
      while (script.skill[at]?.agent) {
        const task = script.skill[at++]!;
        const role = ROLES[task.agent!];
        const tokens = tokensOf(agentDefinition(role) + (await printed(role, task, input.root)) + chars(task.text));
        skill.push(tokens);
        // The interviewer reads the role's report.
        n += chars(task.text);
        dispatches.push({ agent: task.agent!, text: task.text, tokens });
      }
      skill[mine] = FIXED_CONTEXT + tokensOf(n);
      return { text: turn.text, tokens: skill[mine]!, done: turn.done === true, ...(dispatches.length ? { dispatches } : {}) };
    },
    async ownerTurn() {
      const turn = script.owner[ownerAt++]!;
      return { text: turn.text, tokens: tokensOf(chars(turn.text)) };
    },
  };
  const r = await runScenario({ scenario, driver, driverName: "scripted", clock: steppingClock("2026-01-01T00:00:00Z"), outDir, scenarioFile: file });
  return { skill, owner: script.owner.slice(0, ownerAt).map((t) => tokensOf(chars(t.text))), stop: r.summary.stop_reason, summary: r.summary };
}

// Rewrites the script's `"tokens": n` values, which sit one per turn, skill turns before owner turns.
function rewrite(path: string, counts: Recount) {
  const values = [...counts.skill, ...counts.owner];
  const text = readFileSync(path, "utf8");
  const found = text.match(/"tokens": \d+/g) ?? [];
  if (found.length !== values.length) throw new Error(`${relative(REPO_ROOT, path)} holds ${found.length} token counts for ${values.length} turns; give every turn a "tokens" and run again.`);
  let i = 0;
  writeFileSync(path, text.replace(/"tokens": \d+/g, () => `"tokens": ${values[i++]}`));
}

const scenarios = readdirSync(SCENARIOS_DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".script.json") && !f.endsWith(".figures.json"))
  .map((f) => join(SCENARIOS_DIR, f))
  .filter((f) => loadScenario(f).script !== undefined)
  .sort();

describe("scripted token counts", () => {
  test("every scenario with a script is counted", () => {
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
  });

  for (const file of scenarios) {
    const name = loadScenario(file).name;
    test(`${name}: every turn's tokens recompute from the counting rule`, async () => {
      const out = mkdtempSync(join(tmpdir(), "sl-evals-tokens-"));
      dirs.push(out);
      const scenario = loadScenario(file);
      const script = loadScript(scenario, file);
      const got = await recount(file, out);
      expect(got.stop).toBe("done");
      const canned: Recount = { skill: script.skill.map((t) => t.tokens ?? -1), owner: script.owner.map((t) => t.tokens ?? -1) };
      if (process.env.SL_EVAL_RECOUNT === "1") rewrite(join(dirname(file), scenario.script!), got);
      else expect(canned, `${scenario.script}: recount with SL_EVAL_RECOUNT=1 bun test tests/evals-tokens.test.ts, then bun run eval:smoke -- --update-baseline, then update the figures that follow (evals/README.md, Token counts)`).toEqual({ skill: got.skill, owner: got.owner });
    }, 60_000);
  }

  test("the spec's summary example is acme-terse's scripted run", async () => {
    const out = mkdtempSync(join(tmpdir(), "sl-evals-tokens-"));
    dirs.push(out);
    const block = readFileSync(SPEC, "utf8").split("```json\n").map((b) => b.split("\n```")[0]!).find((b) => b.includes('"run_id": "acme-terse-'));
    const example = JSON.parse(block!) as Summary;
    const { summary } = await recount(join(SCENARIOS_DIR, "acme-terse.json"), out);
    expect({ tokens: example.tokens, tokens_by_speaker: example.tokens_by_speaker, turns: example.turns }).toEqual({ tokens: summary.tokens, tokens_by_speaker: summary.tokens_by_speaker, turns: summary.turns });
  }, 60_000);

  test("a count does not depend on where the run is written", async () => {
    const shallow = mkdtempSync(join(tmpdir(), "sl-t-"));
    const deep = join(mkdtempSync(join(tmpdir(), "sl-evals-tokens-deeper-")), "one", "two", "three");
    dirs.push(shallow, dirname(dirname(dirname(deep))));
    for (const name of ["acme-structured", "acme-export-upgrade"]) {
      const file = join(SCENARIOS_DIR, `${name}.json`);
      const { summary: _d, ...d } = await recount(file, deep);
      const { summary: _s, ...s } = await recount(file, shallow);
      expect(d).toEqual(s);
    }
  }, 120_000);
});

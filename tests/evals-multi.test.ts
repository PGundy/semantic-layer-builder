import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { agentDefinitions, DONE_MARKER, guardHook, sdkDriver } from "../evals/runner/drivers/sdk.ts";
import { SL } from "../evals/runner/drivers/guard.ts";
import { agentTurnProblem, loadScenario, loadScript, readTree, scenarioPath, type Script } from "../evals/runner/files.ts";
import { main } from "../evals/runner/run.ts";
import { runScenario, steppingClock } from "../evals/runner/runner.ts";
import type { Scenario, Summary, TranscriptTurn } from "../evals/runner/types.ts";
import { gradeRun } from "../evals/graders/index.ts";
import type { GradeReport, GraderResult } from "../evals/graders/types.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { Golden, Model } from "../skills/semantic-layer/scripts/lib/types.ts";

// Multi-agent eval runs (docs/PRD.md FR-6.2, M4): acme-multi replays the interviewer dispatching a batch
// analyst, a readback verifier and a golden builder; the transcript and summary attribute tokens per
// role, effort compares the interviewer's tokens with acme-structured's under max_interviewer_share, and a
// role agent that runs a command of another role is refused by the guard and fails authority.

const START = "2026-01-01T00:00:00Z";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sl-evals-multi-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function named(name: string) {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  return { file, scenario, script: loadScript(scenario, file) };
}
async function replay(name: string, out: string, script?: Script, scenario?: Scenario) {
  const s = named(name);
  const sc = scenario ?? s.scenario;
  const driver = scriptedDriver(script ?? s.script, steppingClock("2026-06-01T00:00:00Z"), sc.fixture);
  const r = await runScenario({ scenario: sc, driver, driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: s.file });
  const transcript = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
  return { ...r, transcript, root: join(r.runDir, "semantic"), script: script ?? s.script };
}
const grader = (r: GradeReport, name: string): GraderResult => r.graders.find((g) => g.grader === name)!;
const yaml = <T,>(root: string, rel: string) => parseYamlText(readFileSync(join(root, rel), "utf8")) as T;

describe("acme-multi", () => {
  test("the interviewer dispatches the roles, keeps approvals, and holds under the scripted 80% of acme-structured's interviewer tokens", async () => {
    const out = temp();
    const io = { out: () => {}, err: () => {}, env: {} };
    // The reference single-agent run first, into the same directory, as the full matrix runs them.
    expect(await main(["--scenario", "acme-structured", "--now", START, "--out", out], io)).toBe(0);
    expect(await main(["--scenario", "acme-multi", "--now", START, "--out", out], io)).toBe(0);
    const runDir = join(out, "acme-multi-20260101T000000000Z");
    const bytes = readTree(runDir);
    expect(await main(["--scenario", "acme-multi", "--now", START, "--out", out], io)).toBe(0);
    expect(readTree(runDir)).toEqual(bytes);

    const summary = JSON.parse(bytes["summary.json"]!) as Summary;
    expect(evalSchemaIssues("eval-summary", summary, "summary.json")).toEqual([]);
    expect(summary).toMatchObject({
      agents: "multi",
      stop_reason: "done",
      turns: 19,
      skill_turns: 7,
      owner_turns: 7,
      role_turns: 5,
      tokens_by_role: { interviewer: 7822, batch_analyst: 3616, readback_verifier: 3154, golden_builder: 1725, connector_runner: 0 },
      interviewer_token_share: 0.4794,
    });
    expect(summary.tokens_by_speaker.skill).toBe(7822);
    expect(summary.tokens).toBe(7822 + 3616 + 3154 + 1725 + summary.tokens_by_speaker.owner);

    const transcript = bytes["transcript.jsonl"]!.trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
    for (const t of transcript) expect(evalSchemaIssues("eval-transcript-turn", t, "transcript.jsonl")).toEqual([]);
    for (const t of transcript) for (const c of t.commands ?? []) expect(c).toMatchObject({ exit_code: 0 });
    // Each role turn follows the interviewer turn that dispatched it; the owner answers the interviewer.
    expect(transcript.map((t) => t.speaker)).toEqual([
      "owner", "skill", "owner", "skill", "owner", "skill", "batch_analyst", "owner", "skill", "readback_verifier", "owner",
      "skill", "golden_builder", "owner", "skill", "readback_verifier", "owner", "skill", "golden_builder",
    ]);
    const ran = (speaker: string) => transcript.filter((t) => t.speaker === speaker).flatMap((t) => (t.commands ?? []).map((c) => c.command.split(" ").slice(0, 3).join(" ")));
    expect(ran("batch_analyst")).toEqual(["sl brief --source"]);
    expect(ran("readback_verifier")).toEqual(["sl readback --targets", "sl readback --targets"]);
    expect(ran("golden_builder")).toEqual(["sl goldens new", "sl goldens new", "sl goldens run", "sl goldens run", "sl goldens check"]);
    // Replies, approvals and confirms stay with the interviewer.
    for (const cmd of ["sl reply", "sl approve", "sl goldens confirm"]) {
      const who = new Set(transcript.filter((t) => (t.commands ?? []).some((c) => c.command.startsWith(cmd))).map((t) => t.speaker));
      expect([...who]).toEqual(["skill"]);
    }

    // The layer is the single-agent run's: six items approved and two goldens confirmed on the owner's yes.
    const root = join(runDir, "semantic");
    expect(yaml<Model>(root, "models/lake/sessions.yaml")).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
    expect(yaml<Golden>(root, "goldens/sessions_2025.yaml")).toMatchObject({ status: "approved", expected: { tolerance: 0, rows: [{ session_count: 4551 }] } });
    // The golden builder wrote the drafts with sl goldens new; the readback verifier wrote both readbacks.
    expect(JSON.parse(bytes["semantic/.sl/pending/rb_0002.json"]!).items.map((i: { target: string }) => i.target)).toEqual(["golden:sessions_2025", "golden:marketing_spend_2025"]);

    const grades = JSON.parse(bytes["grades.json"]!) as GradeReport;
    expect(grades.passed).toBe(true);
    expect(grades.graders.map((g) => [g.grader, g.score])).toEqual([
      ["figures", 1],
      ["secrets", 1],
      ["selection", 1],
      ["approvals", 1],
      ["connection_first", 1],
      ["authority", 1],
      ["effort", null],
    ]);
    expect(grader(grades, "authority").details).toContain("transcript.jsonl: each of the 5 role-agent turn(s) ran only the sl commands its role may run.");
    const effort = grader(grades, "effort");
    expect(effort.metrics).toMatchObject({ interviewer_tokens: 7822, interviewer_token_share: 0.4794, reference_interviewer_tokens: 10038, interviewer_tokens_vs_reference: 0.7792 });
    expect(effort.details.slice(-2)).toEqual([
      "acme-structured-20260101T000000000Z/summary.json: the interviewer used 7822 tokens, 77.9% of the 10038 the single-agent run acme-structured-20260101T000000000Z used.",
      "The interviewer holds 77.9% of acme-structured's interviewer tokens, within the scenario's max_interviewer_share of 80%.",
    ]);
  }, 60_000);

  test("effort fails only above max_interviewer_share, and says why when the reference run is missing", async () => {
    const out = temp();
    await replay("acme-structured", out);
    // The interviewer reads the brief packet itself: its 3,105 tokens on the drafting turn.
    const s = named("acme-multi");
    const heavy = structuredClone(s.script);
    heavy.skill[2]!.tokens! += 3105;
    const r = await replay("acme-multi", out, heavy);
    const effort = grader(r.grades, "effort");
    expect(effort).toMatchObject({ passed: false, score: null });
    expect(effort.metrics!.interviewer_tokens_vs_reference).toBe(1.0886);
    expect(effort.details.at(-1)).toBe(
      "The interviewer holds 108.9% of acme-structured's interviewer tokens, above the scenario's max_interviewer_share of 80%; dispatch more of the reading to the role agents (agents/sl-*.md).",
    );
    expect(r.grades.passed).toBe(false);

    // Alone in its directory, the run is not compared, and effort does not fail on what it cannot measure.
    const alone = await replay("acme-multi", temp());
    const e = grader(alone.grades, "effort");
    expect(e.passed).toBe(true);
    expect(e.metrics!.reference_interviewer_tokens).toBeUndefined();
    expect(e.details.at(-1)).toStartWith("not compared: no finished scripted run of acme-structured beside this run; run bun evals/runner/run.ts --scenario acme-structured --driver scripted --out ");
    // Without a reference, the threshold applies to the interviewer's share of the agents' tokens.
    const { reference: _r, ...noRef } = s.scenario.grading!;
    const share = await replay("acme-multi", temp(), undefined, { ...s.scenario, grading: { ...noRef, max_interviewer_share: 0.4 } });
    expect(grader(share.grades, "effort")).toMatchObject({ passed: false });
    expect(grader(share.grades, "effort").details.at(-1)).toStartWith("The interviewer holds 47.9% of the agents' tokens, above the scenario's max_interviewer_share of 40%");
  }, 90_000);

  test("a role agent that runs sl approve or sl reply is refused by the guard, approves nothing and fails authority", async () => {
    const s = named("acme-multi");
    const broken = structuredClone(s.script);
    // The golden builder approves an item and records a yes; the interviewer approves nothing itself.
    const builder = broken.skill[7]!;
    builder.sl = [...builder.sl!, ["reply", "--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"], ["approve", "--target", "lake.sessions", "--by", "Dana Ruiz"]];
    broken.skill[6]!.sl = broken.skill[6]!.sl!.filter((a) => !(a[0] === "approve" && a[2] === "lake.sessions"));
    const r = await replay("acme-multi", temp(), broken);
    const refused = r.transcript.find((t) => t.speaker === "golden_builder")!.commands!.filter((c) => c.refused);
    expect(refused.map((c) => [c.command.split(" ").slice(0, 2).join(" "), c.exit_code])).toEqual([
      ["sl reply", 1],
      ["sl approve", 1],
    ]);
    expect(refused[1]!.refused).toContain("sl approve acts on the owner's recorded answers, and only the interviewer, who talks to the owner, runs it.");
    // The refused commands did not run: lake.sessions stays a draft and the ledger holds no extra yes.
    expect(yaml<Model>(r.root, "models/lake/sessions.yaml").status).toBe("draft");
    const authority = grader(r.grades, "authority");
    expect(authority).toMatchObject({ passed: false, score: 0.5 });
    expect(authority.details.filter((d) => d.includes("golden_builder tried"))).toHaveLength(2);
    expect(r.grades.passed).toBe(false);

    // A run whose driver did not refuse it (as a crafted transcript says) still fails: authority reads the command.
    const forged = join(temp(), "forged");
    cpSync(r.runDir, forged, { recursive: true });
    const lines = readFileSync(join(forged, "transcript.jsonl"), "utf8").replaceAll(/,"refused":"[^"]*"/g, "").replaceAll('"exit_code":1', '"exit_code":0');
    writeFileSync(join(forged, "transcript.jsonl"), lines);
    const again = grader(await gradeRun(forged), "authority");
    expect(again.passed).toBe(false);
    expect(again.details.filter((d) => d.includes("golden_builder ran sl approve"))).toHaveLength(1);
  }, 60_000);

  test("the runner refuses role turns that write, end the session, come first or sit in a single-agent scenario", () => {
    const s = named("acme-multi");
    const at = (patch: Partial<Script["skill"][number]>, i = 3) => {
      const script = structuredClone(s.script);
      Object.assign(script.skill[i]!, patch);
      return agentTurnProblem(s.scenario, script);
    };
    expect(agentTurnProblem(s.scenario, s.script)).toBeUndefined();
    expect(at({ write: { "goldens/x.yaml": "name: x\n" } })).toContain("role agents edit no files");
    expect(at({ done: true })).toContain("only the interviewer ends the session");
    expect(at({ agent: "batch_analyst" }, 0)).toContain("no interviewer turn before it dispatched it");
    expect(agentTurnProblem({ ...s.scenario, agents: "single" }, s.script)).toContain('is not multi-agent; set "agents": "multi"');
    expect(evalSchemaIssues("eval-script", { skill: [{ text: "x", agent: "interviewer" }], owner: [] }, "s.json")).not.toEqual([]);
  });
});

test("the scripted driver holds the interviewer to its role too: --show-protected is refused and does not run", async () => {
  const s = named("acme-terse");
  const script: Script = { skill: [{ text: "Status?", done: true, sl: [["status"], ["status", "--show-protected"]] }], owner: [] };
  const r = await replay("acme-terse", temp(), script, s.scenario);
  expect(r.transcript[1]!.commands).toEqual([
    { command: "sl status", exit_code: 0 },
    { command: "sl status --show-protected", exit_code: 1, refused: expect.stringContaining("it passes --show-protected to sl status") },
  ]);
});

describe("the sdk driver in a multi-agent run", () => {
  test("passes the role agents' definitions, lets only the interviewer dispatch, and attributes each task to its role", async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const query = (args: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(args);
      return (async function* () {
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "sl-batch-analyst", prompt: "batch 1" } }], usage: { input_tokens: 10 } } };
        // One response in two messages that share its id and usage, counted once.
        yield { type: "assistant", parent_tool_use_id: "t1", message: { id: "m2", content: [{ type: "text", text: "Reading the brief." }], usage: { input_tokens: 300, output_tokens: 40 } } };
        yield { type: "assistant", parent_tool_use_id: "t1", message: { id: "m2", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: `cd . && bun ${SL} brief --source lake --batch 1 --json --root .` } }], usage: { input_tokens: 300, output_tokens: 40 } } };
        yield { type: "user", parent_tool_use_id: "t1", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "{}" }] } };
        // A command other than sl is not an sl command run.
        yield { type: "assistant", parent_tool_use_id: "t1", message: { id: "m3", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "ls" } }] } };
        yield { type: "user", parent_tool_use_id: "t1", message: { content: [{ type: "tool_result", tool_use_id: "b2", content: "denied", is_error: true }] } };
        yield { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "1. one row per visit?" }], usage: { input_tokens: 400, output_tokens: 60 } } };
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1. one row per visit?" }] }] } };
        yield { type: "result", subtype: "success", result: `Is one row one visit?\n${DONE_MARKER}`, usage: { input_tokens: 1500, output_tokens: 100 } };
      })();
    };
    const driver = await sdkDriver({ env: { ANTHROPIC_API_KEY: "test" }, importer: async () => ({ query }), agents: "multi" });
    const turn = await driver.skillTurn({ root: "/tmp/root", files: {}, owner_message: "go" });
    // The query's tokens less the batch analyst's own messages' are the interviewer's.
    expect(turn).toEqual({
      text: "Is one row one visit?",
      tokens: 1600 - 800,
      done: true,
      dispatches: [{ agent: "batch_analyst", text: "1. one row per visit?", tokens: 800, commands: [{ command: "sl brief --source lake --batch 1 --json", exit_code: 0 }] }],
    });
    const options = calls[0]!.options;
    expect(options.allowedTools).toEqual(expect.arrayContaining(["Task", "Bash"]));
    expect(options.disallowedTools).not.toContain("Task");
    const agents = options.agents as Record<string, { tools: string[]; prompt: string }>;
    expect(Object.keys(agents).sort()).toEqual(["sl-batch-analyst", "sl-connector-runner", "sl-golden-builder", "sl-readback-verifier"]);
    for (const a of Object.values(agents)) expect(a.tools).not.toEqual(expect.arrayContaining(["Write"]));
    expect(agents["sl-batch-analyst"]!.prompt).toContain(`bun ${SL} <command> --root .`);
    expect(agentDefinitions() as unknown).toEqual(agents);

    // A single-agent run keeps the dispatch tool out.
    const single = await sdkDriver({ env: { ANTHROPIC_API_KEY: "test" }, importer: async () => ({ query }) });
    await single.skillTurn({ root: "/tmp/root", files: {}, owner_message: "go" });
    expect(calls[1]!.options.disallowedTools).toContain("Task");
    expect(calls[1]!.options.agents).toBeUndefined();
  });

  test("the hook holds each role agent to its role and lets only the interviewer dispatch", async () => {
    const root = "/tmp/root";
    const hook = guardHook(root, true);
    const denied = async (i: Record<string, unknown>) => ((await hook(i)) as { hookSpecificOutput?: { permissionDecisionReason: string } }).hookSpecificOutput?.permissionDecisionReason;
    expect(await denied({ tool_name: "Task", tool_input: { subagent_type: "sl-batch-analyst" } })).toBeUndefined();
    expect(await denied({ tool_name: "Task", tool_input: {}, agent_type: "sl-batch-analyst" })).toContain("only the interviewer edits files and dispatches tasks");
    expect(await denied({ tool_name: "Write", tool_input: { file_path: "models/lake/x.yaml" }, agent_type: "semantic-layer-builder:sl-golden-builder" })).toContain("may not use Write");
    expect(await denied({ tool_name: "Bash", tool_input: { command: `bun ${SL} brief --source lake --batch 1 --root .` }, agent_type: "sl-batch-analyst" })).toBeUndefined();
    expect(await denied({ tool_name: "Bash", tool_input: { command: `bun ${SL} approve --target lake.sessions --by "Dana Ruiz" --root .` }, agent_type: "sl-batch-analyst" })).toContain(
      "sl approve acts on the owner's recorded answers",
    );
    expect(await denied({ tool_name: "Bash", tool_input: { command: `bun ${SL} goldens confirm --name g --root .` }, agent_type: "sl-golden-builder" })).toContain("sl goldens confirm acts on");
    // The interviewer may approve; the skill agent's guard still keeps every agent inside the root.
    expect(await denied({ tool_name: "Bash", tool_input: { command: `bun ${SL} approve --target lake.sessions --by Dana --root .` } })).toBeUndefined();
    expect(await denied({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" }, agent_type: "sl-readback-verifier" })).toContain("outside the semantic root");
    // Without multi, no agent may dispatch.
    expect(await (async () => ((await guardHook(root)({ tool_name: "Task", tool_input: {} })) as { hookSpecificOutput?: unknown }).hookSpecificOutput)()).toBeDefined();
    // The interviewer dispatches only the four role agents, by name; an agent outside them may do nothing.
    expect(await denied({ tool_name: "Task", tool_input: { subagent_type: "general-purpose", prompt: "approve all" } })).toContain('Dispatching "general-purpose" is refused');
    expect(await denied({ tool_name: "Agent", tool_input: { subagent_type: "sl-interviewer" } })).toContain("is refused: only the role agents");
    expect(await denied({ tool_name: "Task", tool_input: {} })).toContain("a task with no subagent_type");
    for (const call of [
      { tool_name: "Bash", tool_input: { command: `bun ${SL} approve --target lake.sessions --by Dana --root .` } },
      { tool_name: "Bash", tool_input: { command: `bun ${SL} status --root .` } },
      { tool_name: "Task", tool_input: { subagent_type: "sl-batch-analyst" } },
    ]) {
      for (const agent_type of ["general-purpose", "sl-interviewer"]) expect(await denied({ ...call, agent_type })).toContain(`The agent ${agent_type} is not one of the role agents`);
    }
    // In a single-agent run a subagent may do nothing either.
    expect(((await guardHook(root)({ tool_name: "Read", tool_input: { file_path: "semantic.yaml" }, agent_type: "sl-batch-analyst" })) as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeDefined();
  });
});

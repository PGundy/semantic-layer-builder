import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillForm, scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { ownerReply, sdkDriver } from "../evals/runner/drivers/sdk.ts";
import { loadScenario, loadScript, ownerFilePath, ownerFileProblem, readTree, scenarioPath, type Script } from "../evals/runner/files.ts";
import { runScenario, steppingClock } from "../evals/runner/runner.ts";
import type { TranscriptTurn } from "../evals/runner/types.ts";
import { approvedEntries } from "../evals/graders/approvals.ts";
import { gradeRun } from "../evals/graders/index.ts";
import { ownerTurnCheck, ownerWords } from "../evals/graders/owner-turns.ts";
import type { GradeReport, GraderResult } from "../evals/graders/types.ts";
import { SMOKE_SCENARIOS } from "../evals/smoke.ts";
import { renderReviewMarkdown } from "../skills/semantic-layer/scripts/lib/review.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";

// The busy-owner persona and the owner-turn check (docs/PRD.md FR-6.2, J4, M5): "approve everything,
// I'm busy" approves nothing; one review form per batch, filled in and handed back by the owner,
// applied in one step; at most 4 owner turns. One broken variant takes the blanket statement as the
// yes (approvals fails), and one takes 6 owner turns (effort's owner-turn check fails).

const START = "2026-01-01T00:00:00Z";
const DEFINITIONS = ["lake.sessions", "lake.sessions.session_count", "lake.sessions.started_at", "lake.marketing_spend", "lake.marketing_spend.spend", "lake.marketing_spend.spend_date"];
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sl-evals-busy-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function named(name: string, scriptFile?: string) {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  return { file, scenario, script: loadScript(scenario, file, scriptFile) };
}
async function replay(name: string, opts: { script?: Script; scriptFile?: string; out?: string } = {}) {
  const s = named(name, opts.scriptFile);
  const script = opts.script ?? s.script;
  const driver = scriptedDriver(script, steppingClock("2026-06-01T00:00:00Z"), s.scenario.fixture);
  const r = await runScenario({ scenario: s.scenario, driver, driverName: "scripted", clock: steppingClock(START), outDir: opts.out ?? temp(), scenarioFile: s.file });
  const transcript = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
  return { ...r, transcript, root: join(r.runDir, "semantic"), script };
}
const variant = (v: string) => join(import.meta.dir, "..", "evals", "scenarios", `acme-busy-${v}.script.json`);
const grader = (r: GradeReport, name: string): GraderResult => r.graders.find((g) => g.grader === name)!;
const ledger = (root: string) =>
  readFileSync(join(root, ".sl", "ledger.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind: string; target?: string; verdict?: string | null; text?: string; readback_id?: string });
const latest = (root: string, target: string) => ledger(root).filter((e) => e.kind === "reply" && e.target === target).at(-1);
const approvedRefs = (root: string) => approvedEntries(root).map((e) => e.entry.ref).sort();
const ran = (t: TranscriptTurn, cmd: string) => (t.commands ?? []).some((c) => c.command.startsWith(`sl ${cmd}`) && c.exit_code === 0);

describe("acme-busy", () => {
  test("the scenario and its scripts match their schemas, and the smoke subset is unchanged", () => {
    const { scenario } = named("acme-busy");
    expect(scenario).toMatchObject({ persona: "busy", grading: { max_owner_turns: 4 } });
    expect(scenario.opening).toContain("approve everything, I'm busy");
    for (const v of ["blanket", "slow"]) expect(() => named("acme-busy", variant(v))).not.toThrow();
    expect([...SMOKE_SCENARIOS]).toEqual(["acme-structured", "acme-terse"]);
    expect(readFileSync(join(import.meta.dir, "..", "evals", "runner", "personas", "busy.md"), "utf8")).toContain('"approve everything, I\'m busy"');
  });

  test("completes Acme's lake layer in 4 owner turns, through one review form per batch, and grades clean", async () => {
    const r = await replay("acme-busy");
    expect(r.summary.stop_reason).toBe("done");
    for (const t of r.transcript) for (const c of t.commands ?? []) expect(c).toMatchObject({ exit_code: 0 });
    expect(r.grades.graders.filter((g) => !g.passed).map((g) => [g.grader, g.details])).toEqual([]);
    for (const g of ["figures", "approvals", "secrets", "selection", "authority"]) expect(grader(r.grades, g).score).toBe(1);
    const effort = grader(r.grades, "effort");
    expect(effort.metrics).toMatchObject({ owner_turns: 4, max_owner_turns: 4, approved_items: 8, owner_turns_per_approved_item: 0.5 });
    expect(effort.details).toContain("transcript.jsonl: the owner answered 4 time(s) (0.5 per approved item), within the scenario's max_owner_turns of 4.");

    // "Approve everything" approves nothing: no approval before the first form comes back.
    const firstApprove = r.transcript.find((t) => ran(t, "approve"))!;
    const firstForm = r.transcript.find((t) => t.files)!;
    expect(firstForm).toMatchObject({ speaker: "owner", turn: 7 });
    expect(Object.keys(firstForm.files!)).toEqual(["shared/rb_0001.md"]);
    expect(firstApprove.turn).toBe(firstForm.turn + 1);
    // One form per batch, exported by the skill, applied in one step; no answer goes in by sl reply.
    const exports = r.transcript.flatMap((t) => (t.commands ?? []).filter((c) => c.command.startsWith("sl review export")).map((c) => c.command));
    expect(exports).toEqual(["sl review export --readback rb_0001 --format md", "sl review export --readback rb_0002 --format md"]);
    const applies = r.transcript.flatMap((t) => (t.commands ?? []).filter((c) => c.command.startsWith("sl review apply")).map((c) => `${t.turn}: ${c.command}`));
    expect(applies).toEqual(["8: sl review apply shared/rb_0001.md --by Dana Ruiz", "10: sl review apply shared/rb_0002.md --by Dana Ruiz"]);
    expect(r.transcript.some((t) => ran(t, "reply"))).toBe(false);

    // The same approved set as acme-structured; the owner's change and no stay drafts with their words.
    const structured = await replay("acme-structured");
    expect(approvedRefs(r.root)).toEqual(approvedRefs(structured.root));
    expect(approvedRefs(r.root)).toEqual([...DEFINITIONS].sort());
    const spend = parseYamlText(readFileSync(join(r.root, "models/lake/marketing_spend.yaml"), "utf8")) as Model;
    const events = parseYamlText(readFileSync(join(r.root, "models/lake/web_events.yaml"), "utf8")) as Model;
    expect(spend.dimensions!.find((d) => d.name === "channel")).toMatchObject({ status: "draft" });
    expect(spend.dimensions!.find((d) => d.name === "channel")!.description).toContain("paid_search, paid_social, email, affiliate or display");
    expect(events.dimensions!.find((d) => d.name === "event_type")).toMatchObject({ status: "draft" });
    expect(events.dimensions!.find((d) => d.name === "event_type")!.description).toContain("not an order");
    expect(latest(r.root, "lake.marketing_spend.channel")).toMatchObject({ verdict: "change", readback_id: "rb_0001" });
    expect(latest(r.root, "lake.marketing_spend.channel")!.text).toContain("matching sessions.utm_channel");
    expect(latest(r.root, "lake.web_events.event_type")).toMatchObject({ verdict: "no", readback_id: "rb_0001" });
    expect(latest(r.root, "lake.web_events.event_type")!.text).toContain("fct_orders in the warehouse is the source of truth");
    // The form's open questions were answered and resolved too.
    expect(events).toMatchObject({ grain: "One row per tracked event.", primary_key: ["event_id"] });
    expect(events.open_questions ?? []).toEqual([]);
    for (const g of ["sessions_2025", "marketing_spend_2025"]) expect(latest(r.root, `golden:${g}`)).toMatchObject({ verdict: "yes", readback_id: "rb_0002" });

    // Every turn validates, and the owner's files are in the transcript and the root alike.
    for (const t of r.transcript) expect(evalSchemaIssues("eval-transcript-turn", t, `turn ${t.turn}`)).toEqual([]);
    expect(readFileSync(join(r.root, "shared/rb_0001.md"), "utf8")).toBe(firstForm.files!["shared/rb_0001.md"]!);
  }, 60_000);

  test("the run replays to the same files", async () => {
    const out1 = temp();
    const out2 = temp();
    const a = await replay("acme-busy", { out: out1 });
    const b = await replay("acme-busy", { out: out2 });
    expect(readTree(a.runDir)).toEqual(readTree(b.runDir));
  }, 60_000);

  test("taking the opening's \"approve everything\" as the owner's yes, with no form, fails approvals", async () => {
    const r = await replay("acme-busy", { scriptFile: variant("blanket") });
    // sl approve accepts any recorded yes: only the grader sees that no per-item yes stands behind it.
    for (const t of r.transcript) for (const c of t.commands ?? []) expect(c).toMatchObject({ exit_code: 0 });
    expect(approvedRefs(r.root)).toEqual([...DEFINITIONS].sort());
    const g = grader(r.grades, "approvals");
    expect(g).toMatchObject({ passed: false, score: 0 });
    expect(g.details).toHaveLength(6);
    expect(g.details).toContain(
      `semantic/models/lake/sessions.yaml: lake.sessions is approved on ans_0007, whose text ("Please build the layer; approve everything, I'm busy.") approves everything at once, so it is no per-item yes to its readback; export the readback as a review form (sl review export --readback rb_0001 --format md) and approve only what the owner marks yes.`,
    );
    expect(grader(r.grades, "effort").passed).toBe(true);
  }, 60_000);

  test("the same layer in 6 owner turns fails the owner-turn check, and nothing else", async () => {
    const r = await replay("acme-busy", { scriptFile: variant("slow") });
    expect(r.summary.stop_reason).toBe("done");
    expect(approvedRefs(r.root)).toEqual([...DEFINITIONS].sort());
    const effort = grader(r.grades, "effort");
    expect(effort).toMatchObject({ passed: false, score: null, metrics: { owner_turns: 6, max_owner_turns: 4, owner_turns_per_approved_item: 0.75 } });
    expect(effort.details).toContain(
      "transcript.jsonl: the owner answered 6 time(s) (0.75 per approved item), above the scenario's max_owner_turns of 4; batch the questions into fewer messages and send each batch's readback as one review form (sl review export --readback <id> --format md).",
    );
    expect(r.grades.graders.filter((g) => !g.passed).map((g) => g.grader)).toEqual(["effort"]);
  }, 60_000);

  test("a yes the owner's form does not give, or a hedge it gives, fails authority", async () => {
    const s = named("acme-busy");
    // The skill records its own yes to the item the owner said no to, and approves it.
    const forged = structuredClone(s.script);
    forged.skill[3]!.sl!.push(["reply", "--readback", "rb_0001", "--item", "8", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"], ["approve", "--target", "lake.web_events.event_type", "--by", "Dana Ruiz"]);
    forged.skill[3]!.sl = forged.skill[3]!.sl!.filter((a) => !(a[0] === "set" && a[1] === "lake.web_events.event_type"));
    // The form decides even when the owner's message that handed it back says "yes".
    const chatYes = structuredClone(forged);
    chatYes.owner[2]!.text = "Yes, here is the form back, filled in: shared/rb_0001.md.";
    for (const script of [forged, chatYes]) {
      const r = await replay("acme-busy", { script });
      expect(approvedRefs(r.root)).toContain("lake.web_events.event_type");
      const a = grader(r.grades, "authority");
      expect(a.passed).toBe(false);
      expect(a.details).toEqual([
        expect.stringContaining('(a yes to lake.web_events.event_type, recorded in transcript.jsonl turn 8) is not what the owner\'s latest form for rb_0001 (transcript.jsonl turn 7) says for item 8, which is "no"'),
      ]);
    }

    // The owner marks yes but hedges in the answer: the form's yes is a hedge.
    const hedged = structuredClone(s.script);
    hedged.owner[2]!.fill![0]!.items!["lake.sessions"] = { verdict: "yes", answer: "I think so, ask Sam" };
    const h = grader((await replay("acme-busy", { script: hedged })).grades, "authority");
    expect(h.passed).toBe(false);
    expect(h.details).toEqual([expect.stringContaining("(a yes to lake.sessions) records a hedge as a yes (the owner's form in transcript.jsonl turn 7)")]);

    // A ledger yes the owner's latest form for that readback does not mark yes is no owner's answer.
    const flipped = structuredClone(s.script);
    flipped.owner[2]!.fill![0]!.items!["lake.sessions"] = { verdict: "yes", answer: "Right." };
    const f = await replay("acme-busy", { script: flipped });
    expect(grader(f.grades, "authority").passed).toBe(true);
    const form = f.transcript.find((t) => t.files)!;
    form.files!["shared/rb_0001.md"] = form.files!["shared/rb_0001.md"]!.replace(/Verdict: \[x\] yes {2}\[ \] no {2}\[ \] change/, "Verdict: [ ] yes  [x] no  [ ] change");
    writeFileSync(join(f.runDir, "transcript.jsonl"), f.transcript.map((t) => `${JSON.stringify(t)}\n`).join(""));
    const g = grader(await gradeRun(f.runDir), "authority");
    expect(g.details).toEqual([expect.stringContaining("is not what the owner's latest form for rb_0001 (transcript.jsonl turn 7) says for item 1")]);
  }, 120_000);
});

describe("owner files and forms", () => {
  test("a credential the owner writes into a form is redacted before the form reaches the root or the transcript", async () => {
    const script = structuredClone(named("acme-busy").script);
    script.owner[2]!.fill![0]!.items!["lake.marketing_spend.channel"]!.answer = "use postgresql://dana:hunter2pass@warehouse.acme.example/acme";
    const r = await replay("acme-busy", { script });
    expect(readFileSync(join(r.root, "shared", "rb_0001.md"), "utf8")).not.toContain("hunter2pass");
    expect(readFileSync(join(r.runDir, "transcript.jsonl"), "utf8")).not.toContain("hunter2pass");
    expect(grader(r.grades, "secrets").passed).toBe(true);
    expect(r.transcript.find((t) => t.files)!.files!["shared/rb_0001.md"]).toContain("[redacted]");
  }, 60_000);

  test("the skill turn after an owner hands a form back hears which file came back", async () => {
    const s = named("acme-busy");
    const inner = scriptedDriver(s.script, steppingClock("2026-06-01T00:00:00Z"), s.scenario.fixture);
    const heard: string[] = [];
    const driver = { ...inner, skillTurn: (input: Parameters<typeof inner.skillTurn>[0]) => (heard.push(input.owner_message), inner.skillTurn(input)) };
    await runScenario({ scenario: s.scenario, driver, driverName: "scripted", clock: steppingClock(START), outDir: temp(), scenarioFile: s.file });
    expect(heard[3]).toBe("Here is the form back, filled in: shared/rb_0001.md.\n\n(handed back: shared/rb_0001.md)");
    expect(heard[1]).not.toContain("handed back");
  }, 60_000);

  test("an owner's file goes under shared/ as .md or .json, never through a link", () => {
    expect(ownerFileProblem("shared/rb_0001.md")).toBeUndefined();
    expect(ownerFileProblem("shared/rb_0001.json")).toBeUndefined();
    for (const bad of [".sl/reviews/rb_0001.md", "shared/../models/x.md", "/tmp/x.md", "shared/a/b.md", "shared/x.yaml", "models/lake/sessions.md"])
      expect(ownerFileProblem(bad)).toContain("shared/<name>.md or shared/<name>.json");
    const root = temp();
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "shared"));
    expect(() => ownerFilePath(root, "shared/rb_0001.md")).toThrow("would leave the semantic root through a link");
  });

  test("a script whose owner fills a form outside .sl/reviews/, or hands it back elsewhere or in another format, is refused", () => {
    const { scenario, file } = named("acme-busy");
    const dir = temp();
    const base = named("acme-busy").script;
    for (const [fill, why] of [
      [{ form: "models/lake/sessions.yaml", as: "shared/x.md" }, "fill[0].form must match"],
      [{ form: ".sl/reviews/rb_0001.md", as: ".sl/reviews/rb_0001.md" }, "fill[0].as must match"],
      [{ form: ".sl/reviews/rb_0001.md", as: "shared/rb_0001.json" }, "keep the form's format (.md)"],
    ] as const) {
      const bad = structuredClone(base);
      bad.owner[2]!.fill = [fill];
      const path = join(dir, "bad.script.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => loadScript(scenario, file, path)).toThrow(why);
    }
  });

  test("filling a form the skill has not written, or an item it lacks, stops the run naming the fix", async () => {
    const s = named("acme-busy");
    const early = structuredClone(s.script);
    early.owner[2]!.fill![0]!.form = ".sl/reviews/rb_0009.md";
    const r = await replay("acme-busy", { script: early });
    expect(r.summary.stop_reason).toBe("error");
    expect(r.summary.error).toContain("Owner turn 3 fills .sl/reviews/rb_0009.md, which the skill has not written; export it first with sl review export");
    expect(() => fillForm({ form: ".sl/reviews/rb_0001.md", as: "shared/rb_0001.md", items: { "lake.nope": { verdict: "yes" } } }, { ".sl/reviews/rb_0001.md": readForm() }, 3)).toThrow(
      "Owner turn 3 answers lake.nope, which is not an item of .sl/reviews/rb_0001.md",
    );
  }, 60_000);

  test("the owner-turn check fails a run that stopped early or approved nothing, however few its turns", () => {
    const owner = (turn: number) => ({ speaker: "owner", turn, text: "ok", tokens: 1, timestamp: START }) as TranscriptTurn;
    const run = (stop_reason: string) => ({ grading: { max_owner_turns: 4 }, summary: { stop_reason }, transcript: [owner(1), owner(3)] }) as unknown as Parameters<typeof ownerTurnCheck>[0];
    expect(ownerTurnCheck(run("done"), 2)).toMatchObject({ passed: true });
    expect(ownerTurnCheck(run("done"), 0)).toMatchObject({ passed: false, detail: expect.stringContaining("but the run approved nothing") });
    expect(ownerTurnCheck(run("turn_budget"), 2)).toMatchObject({ passed: false, detail: expect.stringContaining("but the run stopped on turn_budget") });
  });

  test("owner words count a form's answers and marked verdicts, not its printed text", () => {
    const filled = fillForm({ form: ".sl/reviews/rb_0001.md", as: "shared/rb_0001.md", items: { "lake.sessions": { verdict: "yes" }, "lake.sessions.started_at": { verdict: "change", answer: "say UTC days" } } }, { ".sl/reviews/rb_0001.md": readForm() }, 3);
    const turn: TranscriptTurn = { turn: 3, speaker: "owner", text: "Form back.", tokens: 3, timestamp: START, files: { "shared/rb_0001.md": filled } };
    expect(ownerWords(turn)).toBe(2 + 1 + 1 + 3);
    expect(ownerWords({ ...turn, files: { "shared/notes.md": "three plain words" } })).toBe(5);
  });

  test("the sdk owner sees the forms the skill wrote and hands one back in a file block", async () => {
    expect(ownerReply("Here it is.\n<<<file shared/rb_0001.md\n# Review\nVerdict: [x] yes\n>>>\nThanks.")).toEqual({ text: "Here it is.\n\nThanks.", files: { "shared/rb_0001.md": "# Review\nVerdict: [x] yes\n" } });
    expect(ownerReply("yep")).toEqual({ text: "yep" });
    const prompts: string[] = [];
    const query = (args: { prompt: string }) => {
      prompts.push(args.prompt);
      return (async function* () {
        yield { type: "result", subtype: "success", result: "Done.\n<<<file shared/rb_0001.md\nfilled\n>>>", usage: { input_tokens: 10 } };
      })();
    };
    const driver = await sdkDriver({ env: { ANTHROPIC_API_KEY: "test" }, importer: async () => ({ query }) });
    const owner = await driver.ownerTurn({ brief: "B", persona: "busy", persona_prompt: "P", skill_message: "form?", history: [], forms: { ".sl/reviews/rb_0001.md": "# Review of readback rb_0001\n" } });
    expect(owner).toEqual({ text: "Done.", tokens: 10, files: { "shared/rb_0001.md": "filled\n" } });
    expect(prompts[0]).toContain("<<<form .sl/reviews/rb_0001.md\n# Review of readback rb_0001\n>>>");
    expect(prompts[0]).toContain("between a line `<<<file shared/<name>.md`");
  });

  test("the schemas take max_owner_turns, an owner turn's fill and a transcript turn's files", () => {
    const sc = JSON.parse(readFileSync(scenarioPath("acme-busy"), "utf8"));
    expect(evalSchemaIssues("eval-scenario", sc, "acme-busy.json")).toEqual([]);
    expect(evalSchemaIssues("eval-scenario", { ...sc, grading: { max_owner_turns: 0 } }, "x").length).toBeGreaterThan(0);
    const turn = { turn: 3, speaker: "owner", text: "", tokens: 0, timestamp: START };
    expect(evalSchemaIssues("eval-transcript-turn", { ...turn, files: { "shared/a.md": "x" } }, "t")).toEqual([]);
    expect(evalSchemaIssues("eval-transcript-turn", { ...turn, files: { "models/a.md": "x" } }, "t").length).toBeGreaterThan(0);
    const script = { skill: [{ text: "x" }], owner: [{ text: "y", fill: [{ form: ".sl/reviews/rb_0001.md", as: "shared/rb_0001.md", items: { "lake.sessions": { verdict: "maybe" } } }] }] };
    expect(evalSchemaIssues("eval-script", script, "s").length).toBeGreaterThan(0);
  });
});

// A review form as sl review export writes it, for two items, from the shipped renderer.
function readForm(): string {
  const hash = `sha256:${"0".repeat(64)}`;
  return renderReviewMarkdown({
    version: 1,
    readback_id: "rb_0001",
    created_at: START,
    items: [
      { n: 1, target: "lake.sessions", content_hash: hash, text: "lake.sessions (table)", verdict: null, answer: "" },
      { n: 2, target: "lake.sessions.started_at", content_hash: hash, text: "lake.sessions.started_at (dimension)", verdict: null, answer: "" },
    ],
    questions: [],
  });
}

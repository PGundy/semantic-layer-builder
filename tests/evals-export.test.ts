import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, readTree, REPO_ROOT, scenarioPath, type Script } from "../evals/runner/files.ts";
import { main } from "../evals/runner/run.ts";
import { runScenario, sharedExportPath, steppingClock } from "../evals/runner/runner.ts";
import type { OwnerTurnInput, SkillTurnInput, Summary, TranscriptTurn } from "../evals/runner/types.ts";
import { statusWhileWaiting } from "../evals/graders/connection-first.ts";
import { gradeRun } from "../evals/graders/index.ts";
import type { GradeReport, GraderResult } from "../evals/graders/types.ts";
import { computeStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Model, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl } from "./helpers.ts";

// The export intake paths of the eval harness (docs/PRD.md FR-6.2) and the connection_first rows
// for them (FR-6.3): acme-export ends waiting on a connection with no golden confirmed, and
// acme-export-upgrade upgrades the same layer, checks every join and routes a contradicted draft
// back to the owner. Each replays to the same bytes, grades clean, and a broken copy fails the rows.

const START = "2026-01-01T00:00:00Z";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sl-evals-export-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The items both scripts read back and approve from the export, in readback order.
const APPROVED = ["lake.sessions", "lake.sessions.session_count", "lake.marketing_spend", "lake.marketing_spend.spend", "lake.web_events", "lake.web_events.page_views", "lake.web_events.session"];

function scenarioNamed(name: string) {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  return { scenario, file, script: loadScript(scenario, file) };
}

async function replay(name: string, script?: Script, out = temp()) {
  const s = scenarioNamed(name);
  const seen: SkillTurnInput[] = [];
  const briefs: string[] = [];
  const inner = scriptedDriver(script ?? s.script, steppingClock("2026-06-01T00:00:00Z"), s.scenario.fixture);
  const driver = {
    skillTurn: (i: SkillTurnInput) => (seen.push(structuredClone(i)), inner.skillTurn(i)),
    ownerTurn: (i: OwnerTurnInput) => (briefs.push(i.brief), inner.ownerTurn(i)),
  };
  const result = await runScenario({ scenario: s.scenario, driver, driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: s.file });
  const transcript = readFileSync(join(result.runDir, "transcript.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as TranscriptTurn);
  return { ...result, transcript, seen, briefs, root: join(result.runDir, "semantic"), ...s };
}

const grader = (r: GradeReport, name: string): GraderResult => r.graders.find((g) => g.grader === name)!;
const yaml = <T,>(root: string, rel: string) => parseYamlText(readFileSync(join(root, rel), "utf8")) as T;
const ledger = (root: string) =>
  readFileSync(join(root, ".sl", "ledger.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind: string; target?: string; verdict?: string; readback_id?: string; by?: string });
function copyOf(runDir: string): { dir: string; root: string } {
  const dir = join(temp(), runDir.split(/[\\/]/).at(-1)!);
  cpSync(runDir, dir, { recursive: true });
  return { dir, root: join(dir, "semantic") };
}

// The connection-first order every export transcript keeps: ask, decline, then the export.
function expectConnectionFirst(transcript: TranscriptTurn[]) {
  expect(transcript[1]!.text).toContain("can you give me a read-only connection to the lake?");
  expect(transcript[1]!.text).not.toMatch(/export/i);
  expect(transcript[2]!.text).toContain("a connection is not possible");
  const exportTurn = transcript.find((t) => (t.commands ?? []).some((c) => /^sl (export-sql|setup .*--export)/.test(c.command)))!;
  expect(exportTurn.turn).toBe(4);
  expect(exportTurn.commands![0]!.command).toBe("sl export-sql --dialect duckdb --schemas main");
}

describe("acme-export", () => {
  test("replays to the same bytes, ends waiting on a connection with the upgrade named, and grades clean", async () => {
    const out = temp();
    const r = await replay("acme-export", undefined, out);
    const bytes = readTree(r.runDir);
    const again = await replay("acme-export", undefined, out);
    expect(again.replaced).toBe(true);
    expect(readTree(again.runDir)).toEqual(bytes);

    expect(r.summary).toMatchObject({ scenario: "acme-export", intake: "export", stop_reason: "done", turns: 12, owner_turns: 6 });
    for (const t of r.transcript) for (const c of t.commands ?? []) expect(c).toMatchObject({ exit_code: 0 });
    expectConnectionFirst(r.transcript);

    // The simulated owner's brief ends with the scenario's note on why a connection is not possible.
    expect(r.briefs[0]).toContain("# Owner brief: Dana Ruiz");
    expect(r.briefs[0]!.trimEnd()).toEndWith(`## In this scenario\n\n${r.scenario.brief_note}`);
    // The root starts with the project and the owner's export, which the skill imports only later.
    expect(Object.keys(r.seen[0]!.files)).toEqual([".gitignore", "semantic.yaml", sharedExportPath("lake")]);
    const csv = r.seen[0]!.files[sharedExportPath("lake")]!.trimEnd().split("\n");
    expect(csv[0]).toStartWith("table_schema,table_name,table_type,table_comment,row_count,column_name,");
    expect(csv.slice(1).map((l) => l.split(",").slice(1, 2)[0]).filter((v, i, a) => a.indexOf(v) === i)).toEqual(["marketing_spend", "sessions", "tmp_session_dedupe", "web_events", "web_events_2024_archive"]);
    expect(csv).toHaveLength(25);
    // The shared export holds catalog rows only: no path on this machine and no file the lake reads.
    expect(r.seen[0]!.files[sharedExportPath("lake")]).not.toMatch(new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|fixtures|parquet`));

    const source = yaml<SourceConfig>(r.root, "sources/lake.yaml");
    const reason = "IT does not allow any connection to the lake files from outside the office network.";
    // Why a connection is not possible is recorded in intake.reason and in the source's description.
    expect(source.intake).toEqual({ mode: "export", reason, schemas: ["main"], export: { file: "exports/lake.csv" } });
    expect(source.description).toContain(reason);
    // Definitions are approved on the owner's recorded yeses; no golden is confirmed.
    const replies = ledger(r.root).filter((e) => e.kind === "reply");
    expect(replies.map((e) => [e.target, e.verdict, e.readback_id, e.by])).toEqual(APPROVED.map((t) => [t, "yes", "rb_0001", "Dana Ruiz"]));
    const events = yaml<Model>(r.root, "models/lake/web_events.yaml");
    expect(events).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
    expect(events.joins![0]).toMatchObject({ name: "session", status: "approved" });
    expect(events.joins![0]!.evidence).toBeUndefined();
    expect(r.transcript.flatMap((t) => t.commands ?? []).some((c) => c.command.startsWith("sl goldens"))).toBe(false);

    // sl status: the data-dependent steps wait on a connection, the step is not done, and the
    // upgrade is named; the last turn names it to the owner too.
    const status = computeStatus(r.root);
    expect(status.sources[0]!.waiting_on_connection.map((w) => w.step)).toEqual(["profiles", "join_evidence", "goldens", "drift_from_data"]);
    expect(status.sources[0]!.approved_joins_without_evidence).toEqual(["web_events.session"]);
    expect(status.next_step.phase).not.toBe("done");
    expect(status.next_step.connection_upgrade).toStartWith("sl setup --source lake --dialect duckdb");
    expect((await sl(r.root, ["status"])).out).toContain("With a connection, the waiting steps run: sl setup --source lake --dialect duckdb");
    expect(r.transcript.at(-1)!.text).toContain("sl setup --source lake --dialect duckdb");
    expect(r.transcript.at(-1)!.commands!.map((c) => c.command).slice(-3)).toEqual(["sl validate", "sl status", "sl next"]);

    expect(r.grades.passed).toBe(true);
    expect(r.grades.graders.map((g) => [g.grader, g.score])).toEqual([
      ["figures", null],
      ["secrets", 1],
      ["selection", 1],
      ["approvals", 1],
      ["connection_first", 1],
      ["authority", 1],
      ["effort", null],
    ]);
    expect(grader(r.grades, "connection_first").details).toEqual([
      "transcript.jsonl: the skill asks for a connection in turn 2, and offers an export in turn 4 only after the owner says one is not possible in turn 3.",
      "semantic/goldens/: no golden is confirmed on this export scenario.",
      "sl status: the next step is metrics, not done, while lake waits on a connection (profiles, join_evidence, goldens, drift_from_data).",
    ]);
    expect(grader(r.grades, "approvals").details).toEqual(["All 7 approved item(s) have the owner's latest reply as a yes with a matching hash."]);
  }, 60_000);

  test("a confirmed golden, a done status while steps wait and a lost export source each fail connection_first", async () => {
    const r = await replay("acme-export");
    const golden = copyOf(r.runDir);
    writeFileSync(
      join(golden.root, "goldens", "sessions_2025.yaml"),
      "name: sessions_2025\nquestion: How many sessions in 2025?\nrequest: { source: lake, measures: [sessions.session_count] }\nsql: select 1\nexpected: { tolerance: 0, rows: [{ session_count: 4551 }] }\nstatus: approved\nconfirmed_by: Dana Ruiz\nconfirmed_at: 2026-06-01\n",
    );
    const g = grader(await gradeRun(golden.dir), "connection_first");
    expect(g).toMatchObject({ passed: false, score: 2 / 3 });
    expect(g.details).toContain("semantic/goldens/: an export scenario has no data to confirm against, but sessions_2025 is confirmed.");

    // sl status never reports done for an export source; a status that did fails the row.
    const status = computeStatus(r.root);
    expect(statusWhileWaiting(status).ok).toBe(true);
    expect(statusWhileWaiting({ ...status, next_step: { ...status.next_step, phase: "done" } })).toEqual({
      ok: false,
      detail: "sl status: the next step is done while lake waits on a connection (profiles, join_evidence, goldens, drift_from_data).",
    });

    // A source hand-edited to connection mode leaves no export source to wait on.
    const lost = copyOf(r.runDir);
    const file = join(lost.root, "sources", "lake.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("mode: export", "mode: connection").replace(/ {2}reason:.*\n/, "").replace(/ {2}export:\n {4}file:.*\n/, ""));
    const l = grader(await gradeRun(lost.dir), "connection_first");
    expect(l).toMatchObject({ passed: false, score: 2 / 3 });
    expect(l.details.at(-1)).toBe("semantic/sources/: no source is a schema export at the end of this export scenario (never set up with sl setup --export, or upgraded).");
  }, 60_000);
});

describe("acme-export-upgrade", () => {
  test("replays to the same bytes with --now, upgrades the source, checks every join and routes the contradicted draft back", async () => {
    const out = temp();
    const io = { out: () => {}, err: () => {}, env: {} };
    expect(await main(["--scenario", "acme-export-upgrade", "--now", START, "--out", out], io)).toBe(0);
    const runDir = join(out, "acme-export-upgrade-20260101T000000000Z");
    const bytes = readTree(runDir);
    expect(await main(["--scenario", "acme-export-upgrade", "--now", START, "--out", out], io)).toBe(0);
    expect(readTree(runDir)).toEqual(bytes);

    const root = join(runDir, "semantic");
    const summary = JSON.parse(bytes["summary.json"]!) as Summary;
    expect(summary).toMatchObject({ intake: "export_upgrade", stop_reason: "done", turns: 18, owner_turns: 9 });
    const transcript = bytes["transcript.jsonl"]!.trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
    for (const t of transcript) for (const c of t.commands ?? []) expect(c).toMatchObject({ exit_code: 0 });
    expectConnectionFirst(transcript);
    // The transcript keeps the script's {fixture}, so it reads the same wherever the run is written.
    const upgrade = transcript.flatMap((t) => (t.commands ?? []).map((c) => ({ turn: t.turn, ...c }))).find((c) => c.command.startsWith("sl setup") && !c.command.includes("--export"))!;
    expect(upgrade.turn).toBe(14);
    expect(upgrade.command).toContain("--view sessions=read_parquet('{fixture}/data/lake/sessions.parquet')");

    // The source reads a connection now; the schemas, the scope and the export copy stay.
    const source = yaml<SourceConfig>(root, "sources/lake.yaml");
    expect(source.intake).toEqual({ mode: "connection", schemas: ["main"] });
    expect(source.scope).toEqual({ exclude: ["web_events_2024_archive", "tmp_session_dedupe"] });
    expect(source.connection!.views!.sessions).toBe(`read_parquet('${relative(root, join(REPO_ROOT, "fixtures", "acme"))}/data/lake/sessions.parquet')`);
    expect(Object.keys(bytes)).toContain("semantic/exports/lake.csv");
    const status = computeStatus(root);
    expect(status.sources[0]).toMatchObject({ intake_mode: "connection", waiting_on_connection: [], unprofiled_tables: [], joins_without_evidence: 0 });
    const events = yaml<Model>(root, "models/lake/web_events.yaml");
    expect(events.joins![0]!.evidence).toMatchObject({ to: "sessions", matched_rows: 30551, right_key_unique: true });

    // The owner's earlier yeses stay; the contradicted draft was read back, answered and approved.
    const replies = ledger(root).filter((e) => e.kind === "reply");
    expect(replies.map((e) => [e.target, e.verdict, e.readback_id])).toEqual([...APPROVED.map((t) => [t, "yes", "rb_0001"]), ["lake.web_events.event_type", "yes", "rb_0003"]]);
    const eventType = events.dimensions!.find((d) => d.name === "event_type")!;
    expect(eventType).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
    expect(eventType.description).toContain("page_view, search, add_to_cart, checkout_start or purchase");
    expect(JSON.parse(bytes["semantic/.sl/pending/rb_0002.json"]!).items.map((i: { target: string }) => i.target)).toEqual(["lake.web_events.event_type"]);
    expect((await sl(root, ["validate"])).code).toBe(0);

    const grades = JSON.parse(bytes["grades.json"]!) as GradeReport;
    expect(grades.passed).toBe(true);
    expect(grader(grades, "connection_first")).toMatchObject({ score: 1, passed: true });
    expect(grader(grades, "connection_first").details.slice(1)).toEqual([
      "transcript.jsonl: no golden is confirmed before the upgrade in turn 14.",
      "semantic/models/: after the upgrade, all 1 join(s) have check-join evidence.",
    ]);
  }, 60_000);

  test("the upgrade the script runs lists exactly the contradicted draft and reads it back next", async () => {
    // The script up to the approvals from the export, then the upgrade by hand with --json.
    const { scenario, script } = scenarioNamed("acme-export-upgrade");
    const at = script.skill.findIndex((t) => (t.sl ?? []).some((a) => a[0] === "setup" && !a.includes("--export")));
    const before: Script = { skill: script.skill.slice(0, at - 1).concat({ ...script.skill[at - 1]!, done: true }), owner: script.owner.slice(0, at - 1) };
    const r = await replay("acme-export-upgrade", before);
    expect(r.summary.stop_reason).toBe("done");
    const fixtureDir = relative(r.root, join(REPO_ROOT, "fixtures", scenario.fixture));
    const args = script.skill[at]!.sl!.find((a) => a[0] === "setup")!.map((a) => a.replaceAll("{fixture}", fixtureDir));
    const u = await sl(r.root, [...args, "--json"]);
    expect(u.code).toBe(0);
    const j = u.json<{ upgraded: boolean; joins_checked: string[]; profiled: string[]; contradictions: { ref: string; kind: string; approved: boolean; evidence: string }[]; next: string }>();
    expect(j).toMatchObject({ upgraded: true, joins_checked: ["lake.web_events.session"], profiled: ["main.marketing_spend", "main.sessions", "main.web_events"] });
    expect(j.contradictions.map((c) => [c.ref, c.kind, c.approved])).toEqual([["lake.web_events.event_type", "unlisted_value", false]]);
    expect(j.contradictions[0]!.evidence).toContain('"search" (2,542 rows)');
    expect(j.next).toBe("sl readback --targets lake.web_events.event_type");
  }, 60_000);

  test("a join without current evidence, a source never upgraded and a confirm before the upgrade each fail connection_first", async () => {
    const r = await replay("acme-export-upgrade");
    const rows = (dir: string) => gradeRun(dir).then((g) => grader(g, "connection_first"));

    const noEvidence = copyOf(r.runDir);
    const file = join(noEvidence.root, "models", "lake", "web_events.yaml");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/\n {4}evidence:\n(?: {6}.*\n)+/, "\n"));
    expect(readFileSync(file, "utf8")).not.toContain("evidence:");
    const n = await rows(noEvidence.dir);
    expect(n).toMatchObject({ passed: false, score: 2 / 3 });
    expect(n.details.at(-1)).toBe("semantic/models/lake/web_events.yaml: after the upgrade, join lake.web_events.session has no evidence for its current keys; run sl check-join on it.");

    // Evidence measured for other keys is not evidence for the join as it stands.
    const stale = copyOf(r.runDir);
    const sfile = join(stale.root, "models", "lake", "web_events.yaml");
    writeFileSync(sfile, readFileSync(sfile, "utf8").replace("      - { from: session_id, to: session_id }", "      - { from: event_id, to: session_id }"));
    expect((await rows(stale.dir)).details.at(-1)).toContain("join lake.web_events.session has no evidence for its current keys");

    // The export run graded as an upgrade: the source is still an export.
    const exported = await replay("acme-export");
    const never = copyOf(exported.runDir);
    const summaryFile = join(never.dir, "summary.json");
    writeFileSync(summaryFile, JSON.stringify({ ...JSON.parse(readFileSync(summaryFile, "utf8")), intake: "export_upgrade" }));
    const v = await rows(never.dir);
    expect(v).toMatchObject({ passed: false, score: 2 / 3 });
    expect(v.details.at(-1)).toBe("semantic/sources/lake.yaml: the source is still a schema export; the upgrade (sl setup --source lake with its connection) never ran.");

    // A confirm that succeeded before the upgrade had no data behind it.
    const early = copyOf(r.runDir);
    const tfile = join(early.dir, "transcript.jsonl");
    const turns = readFileSync(tfile, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as TranscriptTurn);
    turns[11]!.commands = [...(turns[11]!.commands ?? []), { command: "sl goldens confirm --name sessions_2025 --by Dana Ruiz", exit_code: 0 }];
    writeFileSync(tfile, turns.map((t) => `${JSON.stringify(t)}\n`).join(""));
    const e = await rows(early.dir);
    expect(e).toMatchObject({ passed: false, score: 2 / 3 });
    expect(e.details).toContain("transcript.jsonl turn 12: sl goldens confirm succeeded while the source was still an export, before the upgrade.");
    // A confirm after the upgrade is fine.
    turns[11]!.commands!.pop();
    turns[15]!.commands = [...(turns[15]!.commands ?? []), { command: "sl goldens confirm --name sessions_2025 --by Dana Ruiz", exit_code: 0 }];
    writeFileSync(tfile, turns.map((t) => `${JSON.stringify(t)}\n`).join(""));
    expect((await rows(early.dir)).passed).toBe(true);
  }, 120_000);

  test("a run that sets up no source, or only prints role SQL, fails the upgrade rows", async () => {
    // With no source the join row has nothing to vouch for; an empty export run fails too.
    const empty: Script = { skill: [{ text: "Hello, nothing to do.", done: true }], owner: [] };
    const u = grader((await replay("acme-export-upgrade", empty)).grades, "connection_first");
    expect(u).toMatchObject({ passed: false, score: 2 / 3 });
    expect(u.details.at(-1)).toBe("semantic/sources/lake.yaml: no source; the export was never set up or upgraded.");
    expect(grader((await replay("acme-export", empty)).grades, "connection_first")).toMatchObject({ passed: false, score: 2 / 3 });

    // sl setup --print-role-sql reads no connection, so it is not the upgrade.
    const role: Script = {
      skill: [{ text: "Can you give me a read-only connection?", sl: [["setup", "--print-role-sql", "--dialect", "postgres", "--schemas", "main"]] }, { text: "Understood.", done: true }],
      owner: [{ text: "A connection is not possible." }],
    };
    const p = grader((await replay("acme-export-upgrade", role)).grades, "connection_first");
    expect(p.details).toContain("transcript.jsonl: no golden is confirmed before the upgrade.");
    expect(p.passed).toBe(false);
  }, 120_000);
});

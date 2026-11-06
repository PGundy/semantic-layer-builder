import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hasCredential } from "../skills/semantic-layer/scripts/lib/credentials.ts";
import { join } from "node:path";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { evalSchemaIssues, type EvalSchemaKind } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { refuseSkillTool, SKILL_DIR, SL } from "../evals/runner/drivers/guard.ts";
import { DONE_MARKER, guardHook, SDK_PACKAGE, sdkDriver } from "../evals/runner/drivers/sdk.ts";
import { loadScenario, loadScript, readTree, REPO_ROOT, scenarioPath, type Script } from "../evals/runner/files.ts";
import { REDACTED, redactSecrets } from "../evals/runner/redact.ts";
import { main } from "../evals/runner/run.ts";
import { runIdFor, runScenario, steppingClock } from "../evals/runner/runner.ts";
import type { Driver, Scenario, SkillTurnInput, Summary, TranscriptTurn } from "../evals/runner/types.ts";
import { sl } from "./helpers.ts";

// The eval runner (evals/runner, FR-6.1) with the scripted driver: transcript and summary shape,
// budget stops, fresh context per skill turn, redaction of credentials and deterministic output.

const START = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function outDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sl-evals-"));
  dirs.push(d);
  return d;
}

function scenarioNamed(name: string): { scenario: Scenario; file: string; script: Script } {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  return { scenario, file, script: loadScript(scenario, file) };
}

async function run(scenario: Scenario, driver: Driver, out = outDir()) {
  const result = await runScenario({ scenario, driver, driverName: "scripted", clock: steppingClock(START), outDir: out });
  const transcript = readFileSync(join(result.runDir, "transcript.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l) as TranscriptTurn);
  const summary = JSON.parse(readFileSync(join(result.runDir, "summary.json"), "utf8")) as Summary;
  return { ...result, transcript, summary, out };
}

const scripted = (scenario: Scenario, script: Script) => scriptedDriver(script, steppingClock("2026-06-01T00:00:00Z"));

describe("both shipped scenarios run with the scripted driver", () => {
  for (const name of ["acme-structured", "acme-terse"]) {
    test(name, async () => {
      const { scenario, script } = scenarioNamed(name);
      const r = await run(scenario, scripted(scenario, script));

      expect(r.summary.run_id).toBe(`${name}-20260101T000000000Z`);
      expect(evalSchemaIssues("eval-summary", r.summary, "summary.json")).toEqual([]);
      expect(r.summary).toMatchObject({ scenario: name, fixture: "acme", intake: "connection", driver: "scripted", stop_reason: "done", turns: 6 });
      expect(r.summary.skill_turns + r.summary.owner_turns).toBe(r.summary.turns);
      expect(r.summary.tokens).toBe(r.transcript.reduce((n, t) => n + t.tokens, 0));
      expect(r.summary.tokens_by_speaker.skill).toBe(8400);

      for (const t of r.transcript) expect(evalSchemaIssues("eval-transcript-turn", t, "transcript.jsonl")).toEqual([]);
      expect(r.transcript.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.transcript.map((t) => t.speaker)).toEqual(["owner", "skill", "owner", "skill", "owner", "skill"]);
      expect(r.transcript[0]).toMatchObject({ text: scenario.opening, tokens: 0 });
      const times = r.transcript.map((t) => t.timestamp);
      expect([...times].sort()).toEqual(times);
      expect(times[0]!.startsWith("2026-01-01T00:00:")).toBe(true);
      expect(r.transcript[1]!.commands).toEqual([
        { command: "sl status", exit_code: 0 },
        { command: "sl introspect --source lake", exit_code: 0 },
      ]);
      if (name === "acme-terse") expect(r.transcript[2]!.text).toBe("yep");

      // The final semantic root holds what the scripted commands wrote, and it validates.
      const root = join(r.runDir, "semantic");
      expect(Object.keys(readTree(root))).toEqual([
        ".gitignore",
        "models/lake/marketing_spend.yaml",
        "models/lake/sessions.yaml",
        "models/lake/web_events.yaml",
        "semantic.yaml",
        "snapshots/lake.json",
        "sources/lake.yaml",
      ]);
      const source = parseYamlText(readFileSync(join(root, "sources", "lake.yaml"), "utf8")) as { scope: { exclude: string[] } };
      expect(source.scope.exclude).toEqual(["web_events_2024_archive", "tmp_session_dedupe"]);
      expect((await sl(root, ["validate"])).code).toBe(0);
    });
  }
});

describe("budgets", () => {
  test("the turn budget stops the run once the transcript holds max_turns turns", async () => {
    const { scenario, script } = scenarioNamed("acme-structured");
    const r = await run({ ...scenario, budgets: { ...scenario.budgets, max_turns: 3 } }, scripted(scenario, script));
    expect(r.summary).toMatchObject({ stop_reason: "turn_budget", turns: 3, skill_turns: 1, owner_turns: 2 });
    expect(r.transcript.map((t) => t.speaker)).toEqual(["owner", "skill", "owner"]);
  });

  test("the turn budget stops the run before a skill turn as well", async () => {
    const { scenario, script } = scenarioNamed("acme-structured");
    const r = await run({ ...scenario, budgets: { ...scenario.budgets, max_turns: 2 } }, scripted(scenario, script));
    expect(r.summary).toMatchObject({ stop_reason: "turn_budget", turns: 2 });
  });

  test("the token budget stops the run on the turn that goes past it", async () => {
    const { scenario, script } = scenarioNamed("acme-structured");
    const r = await run({ ...scenario, budgets: { ...scenario.budgets, max_tokens: 2460 } }, scripted(scenario, script));
    // 2,400 after the first skill turn is within the budget; the owner's 60 more make 2,460, not past it.
    // The next skill turn's 3,100 goes past it.
    expect(r.summary).toMatchObject({ stop_reason: "token_budget", turns: 4, tokens: 5560 });
    expect(r.transcript.at(-1)!.speaker).toBe("skill");
  });

  test("a done turn that goes past the token budget is a budget stop", async () => {
    const { scenario } = scenarioNamed("acme-structured");
    const script: Script = { skill: [{ text: "all done", tokens: 50, done: true }], owner: [] };
    const r = await run({ ...scenario, budgets: { max_turns: 10, max_tokens: 49 } }, scripted(scenario, script));
    expect(r.summary.stop_reason).toBe("token_budget");
  });
});

describe("fresh context per skill turn", () => {
  test("the skill driver receives only the root, its files as they stand and the latest owner message", async () => {
    const { scenario, script } = scenarioNamed("acme-structured");
    const inner = scripted(scenario, script);
    const seen: { input: SkillTurnInput; onDisk: Record<string, string>; transcript: boolean }[] = [];
    const recording: Driver = {
      async skillTurn(input) {
        const transcript = existsSync(join(input.root, "..", "transcript.jsonl"));
        seen.push({ input: structuredClone(input), onDisk: readTree(input.root), transcript });
        return inner.skillTurn(input);
      },
      ownerTurn: (input) => inner.ownerTurn(input),
    };
    const r = await run(scenario, recording);
    expect(seen).toHaveLength(3);

    const owners = r.transcript.filter((t) => t.speaker === "owner").map((t) => t.text);
    const skills = r.transcript.filter((t) => t.speaker === "skill").map((t) => t.text);
    seen.forEach(({ input, onDisk }, i) => {
      expect(Object.keys(input).sort()).toEqual(["files", "owner_message", "root"]);
      expect(input.root).toBe(join(r.runDir, "semantic"));
      expect(input.files).toEqual(onDisk);
      expect(input.owner_message).toBe(owners[i]!);
      const text = JSON.stringify(input);
      for (const earlier of skills.slice(0, i)) expect(text).not.toContain(earlier);
      for (const earlier of owners.slice(0, i)) expect(text).not.toContain(earlier);
    });
    // Files carry over: the second turn sees the snapshot the first turn's introspect wrote.
    expect(Object.keys(seen[0]!.input.files)).toEqual([".gitignore", "semantic.yaml", "sources/lake.yaml"]);
    expect(Object.keys(seen[1]!.input.files)).toContain("snapshots/lake.json");
    // No transcript sits in the run directory while the run is going.
    expect(seen.map((s) => s.transcript)).toEqual([false, false, false]);
  });

  test("the owner driver receives the brief, the persona and the conversation so far", async () => {
    const { scenario, script } = scenarioNamed("acme-terse");
    const inner = scripted(scenario, script);
    const inputs: Parameters<Driver["ownerTurn"]>[0][] = [];
    await run(scenario, { skillTurn: (i) => inner.skillTurn(i), ownerTurn: (i) => (inputs.push(i), inner.ownerTurn(i)) });
    expect(inputs[0]!.brief).toContain("# Owner brief: Dana Ruiz");
    expect(inputs[0]!.brief).toContain("common_mistakes");
    expect(inputs[0]!.persona).toBe("terse");
    expect(inputs[0]!.persona_prompt).toContain("Persona: terse");
    expect(inputs[1]!.history.map((h) => h.speaker)).toEqual(["owner", "skill", "owner", "skill"]);
    expect(inputs[1]!.skill_message).toBe(inputs[1]!.history.at(-1)!.text);
  });
});

describe("redaction", () => {
  const URL = "postgres://dana:Fake-Pw-0042@warehouse.acme.example:5432/acme";
  test("a pasted credential never reaches the transcript or the summary", async () => {
    const { scenario } = scenarioNamed("acme-structured");
    const script: Script = {
      skill: [
        { text: "Which variable holds the warehouse connection?", tokens: 10 },
        { text: `Please don't paste it. I would never write SET s3_secret_access_key='FAKEKEY0042' or password=fakepw0042 anywhere.`, tokens: 10, done: true },
      ],
      owner: [{ text: `here: WAREHOUSE_URL=${URL} (and the same as "${URL}")`, tokens: 10 }],
    };
    const inner = scripted(scenario, script);
    const received: string[] = [];
    const r = await run(scenario, { skillTurn: (i) => (received.push(i.owner_message), inner.skillTurn(i)), ownerTurn: (i) => inner.ownerTurn(i) });
    // The agent sees what the owner typed, so the scenario tests what it does with it.
    expect(received[1]).toContain("Fake-Pw-0042");
    const written = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8") + readFileSync(join(r.runDir, "summary.json"), "utf8");
    for (const secret of ["Fake-Pw-0042", "FAKEKEY0042", "fakepw0042", "dana:"]) expect(written).not.toContain(secret);
    expect(r.transcript[2]!.text).toBe(`here: ${REDACTED} (and the same as "${REDACTED}")`);
    expect(r.transcript[3]!.text).toContain(`SET s3_secret_access_key='${REDACTED}'`);
  });

  test("an error message holding a credential is redacted in the summary", async () => {
    const { scenario } = scenarioNamed("acme-structured");
    const failing: Driver = {
      skillTurn: async () => {
        throw new Error(`could not connect to ${URL}`);
      },
      ownerTurn: async () => ({ text: "", tokens: 0 }),
    };
    const r = await run(scenario, failing);
    expect(r.summary.stop_reason).toBe("error");
    expect(r.summary.error).toBe(`could not connect to ${REDACTED}`);
  });

  test("text without a credential is left as it is", () => {
    for (const text of [
      "read_parquet('../fixtures/acme/data/lake/sessions.parquet')",
      "SET secret_directory='/tmp/secrets'",
      "connect with the WAREHOUSE_URL variable; see https://example.com/docs?page=2",
      "yep\n\n  ok",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
    expect(redactSecrets("CREATE SECRET (TYPE s3, KEY_ID 'AKFAKE', SECRET 'shh')")).toBe(
      `CREATE SECRET (TYPE s3, KEY_ID '${REDACTED}', SECRET '${REDACTED}')`,
    );
  });

  test("spaces around = and inside a quoted literal do not hide a credential", () => {
    const cases: [string, string][] = [
      ["password = hunter2", `password = ${REDACTED}`],
      ["my_token =abc", `my_token =${REDACTED}`],
      ["my password=hunter2.", `my password=${REDACTED}.`],
      ["token=abc\npassword=def", `token=${REDACTED}\npassword=${REDACTED}`],
      ["SET s3_secret_access_key = 'two words'", `SET s3_secret_access_key = '${REDACTED}'`],
      ["CREATE SECRET (TYPE s3, KEY_ID 'AK FAKE', SECRET 'my secret value')", `CREATE SECRET (TYPE s3, KEY_ID '${REDACTED}', SECRET '${REDACTED}')`],
      ["'host=h password=pw dbname=d'", `'host=h password=${REDACTED} dbname=d'`],
      ["https://x.example/c?sv=1&sig=AbC%3D&se=2", `https://x.example/c?sv=1&sig=${REDACTED}&se=2`],
      ["(postgres://u:p@h/db)", `(${REDACTED})`],
    ];
    for (const [text, want] of cases) {
      expect(hasCredential("setup", text)).toBe(true);
      expect(redactSecrets(text)).toBe(want);
    }
    // A double-quoted value, which the rules do not flag, is redacted too.
    expect(redactSecrets('password="hunter2"')).toBe(`password="${REDACTED}"`);
  });

  test("text the scans cannot split but the rules flag is redacted whole", () => {
    expect(hasCredential("database", "pwd=&x")).toBe(true);
    expect(redactSecrets("pwd=&x")).toBe(REDACTED);
  });

  test("a credential in an sl command a skill turn ran is redacted", async () => {
    const { scenario } = scenarioNamed("acme-terse");
    const script: Script = { skill: [{ text: "x", sl: [["add-source", "--name", "md", "--dialect", "duckdb", "--database", "md:db?motherduck_token=FAKE0042"]], done: true }], owner: [] };
    const r = await run(scenario, scripted(scenario, script));
    expect(readFileSync(join(r.runDir, "transcript.jsonl"), "utf8")).not.toContain("FAKE0042");
  });
});

describe("determinism", () => {
  test("the same scenario and clock write the same bytes", async () => {
    const { scenario, script } = scenarioNamed("acme-terse");
    const out = outDir();
    const first = await run(scenario, scripted(scenario, script), out);
    const bytes = readTree(first.runDir);
    const again = await run(scenario, scripted(scenario, script), out);
    expect(again.runDir).toBe(first.runDir);
    expect(again.replaced).toBe(true);
    expect(readTree(again.runDir)).toEqual(bytes);
    expect(Object.keys(bytes)).toContain("transcript.jsonl");
    // Keys are sorted at every level.
    const line = readFileSync(join(first.runDir, "transcript.jsonl"), "utf8").split("\n")[1]!;
    expect(line.startsWith('{"commands":[{"command":')).toBe(true);
  });

  test("the run id comes from the scenario and the clock", () => {
    expect(runIdFor("acme-terse", new Date("2026-03-04T05:06:07.089Z"))).toBe("acme-terse-20260304T050607089Z");
  });
});

describe("errors are plain and name the fix", () => {
  test("a script that runs out of skill turns", async () => {
    const { scenario } = scenarioNamed("acme-structured");
    const r = await run(scenario, scripted(scenario, { skill: [{ text: "hello" }], owner: [{ text: "hi" }] }));
    expect(r.summary.stop_reason).toBe("error");
    expect(r.summary.error).toContain('"done": true');
    expect(r.transcript.map((t) => t.tokens)).toEqual([0, 2, 1]);
  });

  test("a scenario that fails its schema", () => {
    const dir = outDir();
    const file = join(dir, "broken.json");
    writeFileSync(file, JSON.stringify({ name: "broken", fixture: "acme", persona: "terse", opening: "hi" }));
    expect(() => loadScenario(file)).toThrow(/intake is required[\s\S]*budgets is required/);
  });

  test("a scenario whose name is not its file name, or whose persona has no prompt", () => {
    const dir = outDir();
    const base = JSON.parse(readFileSync(scenarioPath("acme-terse"), "utf8")) as Scenario;
    writeFileSync(join(dir, "other.json"), JSON.stringify(base));
    expect(() => loadScenario(join(dir, "other.json"))).toThrow('a scenario\'s name equals its file name, "other"');
    writeFileSync(join(dir, "acme-terse.json"), JSON.stringify({ ...base, persona: "hedging" }));
    expect(() => loadScenario(join(dir, "acme-terse.json"))).toThrow("Add hedging.md there");
  });

  test("a script command that passes --root is refused", () => {
    const dir = outDir();
    const { scenario, file } = scenarioNamed("acme-terse");
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify({ skill: [{ text: "x", sl: [["status", "--root", "/elsewhere"]] }], owner: [] }));
    expect(() => loadScript(scenario, file, path)).toThrow("remove it");
  });

  test("the CLI names the known scenarios and the flags", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {} };
    expect(await main(["--scenario", "nope"], io)).toBe(1);
    expect(err.join("\n")).toContain("Known scenarios: acme-structured, acme-terse. Run: bun evals/runner/run.ts --scenario <name>");
    expect(await main([], io)).toBe(1);
    expect(err.join("\n")).toContain("--scenario is required");
    expect(await main(["--scenario", "acme-terse", "--driver", "robot"], io)).toBe(1);
    expect(err.join("\n")).toContain("--driver is scripted or sdk");
    expect(await main(["--scenario", "acme-terse", "--bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain("Unknown option '--bogus'. Usage: bun evals/runner/run.ts --scenario <name>");
  });

  test("the CLI runs a scenario with a fixed clock", async () => {
    const out: string[] = [];
    const dir = outDir();
    const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(t), env: {} };
    expect(await main(["--scenario", "acme-terse", "--now", START, "--out", dir], io)).toBe(0);
    expect(out[0]).toBe("Run acme-terse-20260101T000000000Z: 6 turns (3 owner), 8410 tokens, stopped: done.");
    expect(out.at(-1)).toContain("Next: read");
    expect(existsSync(join(dir, "acme-terse-20260101T000000000Z", "summary.json"))).toBe(true);
  });
});

describe("the sdk driver", () => {
  test("without the package it names the package and ANTHROPIC_API_KEY", async () => {
    const missing = () => Promise.reject(new Error("Cannot find package"));
    const p = sdkDriver({ env: { ANTHROPIC_API_KEY: "x" }, importer: missing });
    await expect(p).rejects.toThrow(SDK_PACKAGE);
    await expect(sdkDriver({ env: {}, importer: missing })).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("without a key it says to set ANTHROPIC_API_KEY", async () => {
    await expect(sdkDriver({ env: {}, importer: async () => ({ query: () => [] }) })).rejects.toThrow("needs ANTHROPIC_API_KEY set");
  });

  test("the CLI fails plainly when the sdk driver cannot start", async () => {
    const err: string[] = [];
    const code = await main(["--scenario", "acme-terse", "--driver", "sdk", "--out", outDir()], { out: () => {}, err: (t) => err.push(t), env: {} });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ANTHROPIC_API_KEY");
    expect(err.join("\n")).toContain("--driver scripted");
  });

  test("each skill turn is a new query in the root, from the files and the latest owner message", async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const query = (args: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(args);
      return (async function* () {
        yield { type: "assistant" };
        yield {
          type: "result",
          subtype: "success",
          result: calls.length === 1 ? `All set.\n${DONE_MARKER}` : "yep",
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        };
      })();
    };
    const driver = await sdkDriver({ env: { ANTHROPIC_API_KEY: "test" }, importer: async () => ({ query }) });
    const skill = await driver.skillTurn({ root: "/tmp/root", files: { "semantic.yaml": "version: 1\n" }, owner_message: "build it" });
    expect(skill).toEqual({ text: "All set.", tokens: 125, done: true });
    expect(calls[0]!.options).toMatchObject({ cwd: "/tmp/root", settingSources: [] });
    expect(calls[0]!.prompt).toContain("- semantic.yaml");
    expect(calls[0]!.prompt.endsWith("build it")).toBe(true);
    const owner = await driver.ownerTurn({ brief: "B", persona: "terse", persona_prompt: "P", skill_message: "ok?", history: [{ speaker: "skill", text: "ok?" }] });
    expect(owner).toEqual({ text: "yep", tokens: 125 });
    expect(calls[1]!.options).toMatchObject({ allowedTools: [], maxTurns: 1 });
    expect(calls[1]!.options.disallowedTools).toEqual(expect.arrayContaining(["Read", "Bash", "Write"]));
    expect(String(calls[1]!.options.systemPrompt)).toStartWith("P\n");
    // The skill query carries the guard as a PreToolUse hook.
    const hooks = calls[0]!.options.hooks as { PreToolUse: { hooks: ((i: unknown) => Promise<unknown>)[] }[] };
    const denied = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Read", tool_input: { file_path: join(REPO_ROOT, "fixtures", "acme", "owner-brief.md") } });
    expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  });

  test("a stopped query names its errors, redacted", async () => {
    const query = () =>
      (async function* () {
        yield { type: "result", subtype: "error_max_turns", errors: ["could not reach postgres://u:FAKE0042@h/db"] };
      })();
    const driver = await sdkDriver({ env: { ANTHROPIC_API_KEY: "test" }, importer: async () => ({ query }) });
    const p = driver.ownerTurn({ brief: "B", persona: "terse", persona_prompt: "P", skill_message: "ok?", history: [] });
    await expect(p).rejects.toThrow(`stopped with error_max_turns: could not reach ${REDACTED}. Fix the cause and rerun`);
  });
});

describe("the sdk skill agent stays inside the root", () => {
  const root = join(REPO_ROOT, "evals", "runs", "acme-terse-20260101T000000000Z", "semantic");
  const refused = (tool: string, input: Record<string, unknown>) => refuseSkillTool(tool, input, root);

  test("it may read the root and the skill, write the root and run sl there", () => {
    for (const [tool, input] of [
      ["Read", { file_path: "semantic.yaml" }],
      ["Read", { file_path: join(root, "sources", "lake.yaml") }],
      ["Read", { file_path: join(SKILL_DIR, "SKILL.md") }],
      ["Glob", { pattern: "**/*.yaml" }],
      ["Grep", { pattern: "dialect", path: "sources" }],
      ["Write", { file_path: "models/lake/web_events.yaml" }],
      ["Edit", { file_path: join(root, "semantic.yaml") }],
      ["Bash", { command: `bun ${SL} status --root .` }],
      ["Bash", { command: `bun ${SL} scope --source lake --exclude tmp_session_dedupe --write --root .` }],
      ["Bash", { command: `bun ${SL} add-source --name l2 --dialect duckdb --view "s=read_parquet('data/s.parquet')" --root .` }],
    ] as [string, Record<string, unknown>][]) {
      expect(refused(tool, input)).toBeUndefined();
    }
  });

  test("it may not read the owner's brief, the reference figures or earlier runs, nor write outside the root", () => {
    for (const [tool, input] of [
      ["Read", { file_path: join(REPO_ROOT, "fixtures", "acme", "owner-brief.md") }],
      ["Read", { file_path: "../../acme-terse-20250101T000000000Z/transcript.jsonl" }],
      ["Read", { file_path: "../transcript.jsonl" }],
      ["Glob", { pattern: "../../**/*.jsonl" }],
      ["Glob", { pattern: join(REPO_ROOT, "fixtures", "**") }],
      ["Grep", { pattern: "Dana", path: join(REPO_ROOT, "fixtures") }],
      ["Write", { file_path: join(SKILL_DIR, "SKILL.md") }],
      ["Edit", { file_path: "../summary.json" }],
      ["Bash", { command: "cat ../../../fixtures/acme/owner-brief.md" }],
      ["Bash", { command: `bun ${SL} status --root . ; cat /etc/passwd` }],
      ["Bash", { command: `bun ${SL} status --root ..` }],
      ["Bash", { command: `bun ${SL} baseline --source lake --out /tmp/x.md --root .` }],
      ["Bash", { command: `bun ${SL} add-source --name l2 --dialect duckdb --view "s=read_text('../../../fixtures/acme/owner-brief.md')" --root .` }],
      ["Bash", { command: `bun ${SL} add-source --name l2 --dialect duckdb --view "s=read_text('~/x')" --root .` }],
      ["WebFetch", { url: "https://example.com" }],
    ] as [string, Record<string, unknown>][]) {
      expect(refused(tool, input)).toBeString();
    }
  });

  test("the hook allows a call the guard accepts", async () => {
    expect(await guardHook(root)({ tool_name: "Read", tool_input: { file_path: "semantic.yaml" } })).toEqual({});
  });
});

describe("spec examples of eval files pass their schemas", () => {
  const spec = readFileSync(join(REPO_ROOT, "skills", "semantic-layer", "references", "spec.md"), "utf8");
  const section = spec.slice(spec.indexOf("## Eval runs"), spec.indexOf("## Baseline brief"));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  const kindOf = (b: Record<string, unknown>): EvalSchemaKind =>
    "opening" in b ? "eval-scenario" : "speaker" in b ? "eval-transcript-turn" : "stop_reason" in b ? "eval-summary" : "graders" in b ? "eval-grades" : "figures" in b ? "eval-figures" : "eval-script";

  test("the section shows one example of each file", () => {
    expect(blocks.map(kindOf).sort()).toEqual(["eval-figures", "eval-grades", "eval-scenario", "eval-script", "eval-summary", "eval-transcript-turn"]);
  });
  for (const [i, b] of blocks.entries()) {
    test(`example ${i + 1} (${kindOf(b)})`, () => expect(evalSchemaIssues(kindOf(b), b, "spec.md")).toEqual([]));
  }
});

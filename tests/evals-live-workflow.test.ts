import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { REPO_ROOT } from "../evals/runner/files.ts";
import type { GradeReport } from "../evals/graders/types.ts";
import { baselineText, compare, gateLines, main, type Baseline, type Observed, type RunOneOptions, type SmokeIO } from "../evals/smoke.ts";
import { NotRun } from "../evals/runner/types.ts";
import { tempDir } from "./helpers.ts";

// A5: the live gate of the smoke (`--gate`, driver sdk) and the workflow that runs it on a schedule.

// A synthetic baseline for the sdk driver. It is made up for these tests and is not a recorded run.
function syntheticBaseline(): Baseline {
  const graders = { figures: { score: 1, band: 0.1 }, selection: { score: 0.8, band: 0 } };
  return { version: 1, driver: "sdk", runs: 5, scenarios: { "acme-structured": { stop_reason: "done", graders, effort: { tokens: 1000 } }, "acme-terse": { stop_reason: "done", graders, effort: { tokens: 1000 } } } };
}
function observed(scenario: string, scores: Record<string, number | null>): Observed {
  const graders = Object.entries(scores).map(([grader, score]) => ({ grader, score, passed: true, details: [] }));
  return { scenario, runs: [{ report: { run_id: scenario, scenario, persona: "x", passed: true, score: 1, graders } as GradeReport, stop_reason: "done" }] };
}
const regressions = (b: Baseline, o: Observed[]) => compare(b, o).filter((r) => r.status === "REGRESSION");

describe("the gate comparison", () => {
  const both = (a: Record<string, number | null>) => [observed("acme-structured", a), observed("acme-terse", a)];

  test("below baseline minus band is a regression, at it and above it are not", () => {
    const b = syntheticBaseline();
    expect(regressions(b, both({ figures: 0.9, selection: 0.8 }))).toEqual([]);
    expect(regressions(b, both({ figures: 0.8999, selection: 0.8 })).map((r) => `${r.scenario}/${r.grader}`)).toEqual(["acme-structured/figures", "acme-terse/figures"]);
    expect(regressions(b, both({ figures: 1, selection: 0.7999 })).map((r) => r.grader)).toEqual(["selection", "selection"]);
    expect(regressions(b, both({ figures: 1, selection: 1 }))).toEqual([]);
  });

  test("a scenario the baseline lacks, and a grader missing on either side", () => {
    const b = syntheticBaseline();
    delete b.scenarios["acme-terse"];
    expect(regressions(b, both({ figures: 1, selection: 0.8 })).map((r) => `${r.scenario}/${r.grader}`)).toEqual(["acme-terse/(all)"]);
    const full = syntheticBaseline();
    // In the baseline, not in the run.
    expect(regressions(full, [observed("acme-structured", { figures: 1 }), observed("acme-terse", { figures: 1, selection: 0.8 })]).map((r) => `${r.scenario}/${r.grader}/${r.why}`)).toEqual([
      "acme-structured/selection/the run has no such grader",
    ]);
    // In the run, not in the baseline: new, never a failure.
    delete full.scenarios["acme-structured"]!.graders.selection;
    expect(regressions(full, [observed("acme-structured", { figures: 1, selection: 0 }), observed("acme-terse", { figures: 1, selection: 0.8 })])).toEqual([]);
  });

  test("the gate lines name the scenario, grader, score, baseline and band", () => {
    const lines = gateLines(compare(syntheticBaseline(), [observed("acme-structured", { figures: 0.5, selection: 0.8 }), observed("acme-terse", { figures: 1, selection: 0.8 })]));
    expect(lines).toEqual(["Gate: acme-structured / figures: score 0.5, baseline 1, band 0.1 (below 0.9)."]);
  });
});

function io(env: Record<string, string | undefined>, importer?: SmokeIO["importer"]) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[] = [];
  const outDirs: string[] = [];
  const smoke: SmokeIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env,
    importer,
    runOne: async (name: string, o: RunOneOptions) => {
      if (!(name in syntheticBaseline().scenarios)) throw new NotRun(`${name} was not run (no PG_URL).`);
      ran.push(name);
      outDirs.push(o.outDir);
      const base = syntheticBaseline().scenarios[name];
      const scores = Object.fromEntries(Object.entries(base?.graders ?? {}).map(([k, v]) => [k, (fakeScores[k] ?? v.score) as number]));
      return { report: observed(name, scores).runs[0]!.report, stop_reason: "done" };
    },
  };
  return { smoke, out, err, ran, outDirs };
}
let fakeScores: Record<string, number> = {};
const live = { query: () => [] };
const file = () => {
  const f = join(tempDir(), "baseline.sdk.json");
  writeFileSync(f, baselineText(syntheticBaseline()));
  return f;
};

describe("smoke --gate with the sdk driver", () => {
  test("without a key it exits 2 and runs nothing: no driver, no run, no directory", async () => {
    const outDir = join(tempDir(), "runs");
    const t = io({}, async () => live);
    expect(await main(["--driver", "sdk", "--gate", "--baseline", file(), "--out", outDir], t.smoke)).toBe(2);
    expect(t.err.join("\n")).toContain("ANTHROPIC_API_KEY");
    expect(t.ran).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });

  test("without the package it exits 2 and names the package", async () => {
    const outDir = join(tempDir(), "runs");
    const t = io({ ANTHROPIC_API_KEY: "k" }, async () => {
      throw new Error("not found");
    });
    expect(await main(["--driver", "sdk", "--gate", "--baseline", file(), "--out", outDir], t.smoke)).toBe(2);
    expect(t.err.join("\n")).toContain("@anthropic-ai/claude-agent-sdk");
    expect(t.ran).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
  });

  test("the real command without a key exits 2 and creates no run directory", async () => {
    const outDir = join(tempDir(), "runs");
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.ANTHROPIC_API_KEY;
    const p = Bun.spawn(["bun", join(REPO_ROOT, "evals", "smoke.ts"), "--driver", "sdk", "--gate", "--baseline", file(), "--out", outDir], { env, stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT });
    const [code, err] = [await p.exited, await new Response(p.stderr).text()];
    expect(code).toBe(2);
    expect(err).toMatch(/ANTHROPIC_API_KEY|claude-agent-sdk/);
    expect(existsSync(outDir)).toBe(false);
  });

  test("without a baseline it exits 2, runs nothing and names the record command", async () => {
    const t = io({ ANTHROPIC_API_KEY: "k" }, async () => live);
    expect(await main(["--driver", "sdk", "--gate", "--baseline", join(tempDir(), "none.json")], t.smoke)).toBe(2);
    expect(t.err.join("\n")).toContain("--update-baseline --driver sdk --runs 5 --baseline");
    expect(t.ran).toEqual([]);
  });

  test("by default it reads evals/baseline.sdk.json, which is not committed until the owner records it", async () => {
    const t = io({ ANTHROPIC_API_KEY: "k" }, async () => live);
    if (existsSync(join(REPO_ROOT, "evals", "baseline.sdk.json"))) return;
    expect(await main(["--driver", "sdk", "--gate"], t.smoke)).toBe(2);
    expect(t.err.join("\n")).toContain("No baseline at evals/baseline.sdk.json. Record one with: bun run eval:smoke -- --update-baseline --driver sdk --runs 5 --baseline evals/baseline.sdk.json");
    expect(t.ran).toEqual([]);
  });

  test("a score below baseline minus band exits 1 and says which; within it exits 0", async () => {
    fakeScores = { figures: 0.8 };
    const bad = io({ ANTHROPIC_API_KEY: "k" }, async () => live);
    expect(await main(["--driver", "sdk", "--gate", "--baseline", file()], bad.smoke)).toBe(1);
    expect(bad.out.join("\n")).toContain("Gate: acme-structured / figures: score 0.8, baseline 1, band 0.1 (below 0.9).");
    fakeScores = { figures: 0.9 };
    const ok = io({ ANTHROPIC_API_KEY: "k" }, async () => live);
    expect(await main(["--driver", "sdk", "--gate", "--baseline", file()], ok.smoke)).toBe(0);
    fakeScores = {};
  });

  test("--gate cannot go with --report-only or --update-baseline", async () => {
    for (const flag of ["--report-only", "--update-baseline"]) {
      const t = io({ ANTHROPIC_API_KEY: "k" }, async () => live);
      expect(await main(["--driver", "sdk", "--gate", flag, "--baseline", file()], t.smoke)).toBe(2);
      expect(t.err.join("\n")).toContain("--gate");
      expect(t.ran).toEqual([]);
    }
  });

  test("with the scripted driver it is the default comparison: the committed baseline passes", async () => {
    const t = io({});
    t.smoke.runOne = undefined;
    expect(await main(["--gate"], t.smoke)).toBe(0);
    expect(t.out.join("\n")).toContain("Smoke: no regression against evals/baseline.json.");
  });
});

describe("smoke --gate with the scripted driver", () => {
  test("a regression prints and exits the same with and without --gate", async () => {
    // Synthetic scripted baseline, written to a temp file; scores come from the fake runOne.
    const f = join(tempDir(), "baseline.json");
    writeFileSync(f, baselineText({ ...syntheticBaseline(), driver: "scripted", runs: 1 }));
    fakeScores = { figures: 0.5 };
    const a = io({});
    const b = io({});
    const plain = await main(["--baseline", f], a.smoke);
    const gated = await main(["--gate", "--baseline", f], b.smoke);
    fakeScores = {};
    expect([plain, gated]).toEqual([1, 1]);
    expect(b.out).toEqual(a.out);
    expect(a.out.join("\n")).toContain("Smoke: 2 regression(s)");
    expect(a.out.join("\n")).not.toContain("Gate:");
  });
});

describe("the eval-live workflow", () => {
  const path = join(REPO_ROOT, ".github", "workflows", "eval-live.yml");
  const text = readFileSync(path, "utf8");
  type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
  const wf = parseYamlText(text, "eval-live.yml") as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string };
    jobs: Record<string, { if?: string; "timeout-minutes"?: number; permissions?: unknown; env?: unknown; steps: Step[] }>;
  };
  const job = wf.jobs["eval-live"]!;
  const ci = parseYamlText(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"), "ci.yml") as { jobs: Record<string, { steps: Step[] }> };

  test("triggers: schedule, workflow_dispatch and a pull_request that is only `labeled`; never pull_request_target", () => {
    expect(text).not.toContain("pull_request_target");
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(wf.on.pull_request).toEqual({ types: ["labeled"] });
    expect((wf.on.schedule as { cron: string }[]).length).toBe(1);
    // Weekly, at an off-peak minute: a fixed minute that is not :00 or :30, on one weekday.
    expect((wf.on.schedule as { cron: string }[])[0]!.cron).toMatch(/^([1-9]|[1-5]\d) \d{1,2} \* \* [0-6]$/);
    expect((wf.on.schedule as { cron: string }[])[0]!.cron).not.toMatch(/^(0|30) /);
  });

  test("the job runs on a pull_request only for the eval-live label", () => {
    expect(job.if).toContain("github.event.label.name == 'eval-live'");
    expect(job.if).toMatch(/github\.event_name != 'pull_request' \|\|/);
  });

  test("permissions are contents: read and nothing more, at the workflow and the job", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });

  test("the secret is in the env of one step, never in a run string, never echoed", () => {
    expect(text.match(/secrets\./g)?.length).toBe(1);
    const withSecret = job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets."));
    expect(withSecret.length).toBe(1);
    expect(withSecret[0]!.env).toEqual({ ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" });
    expect(job.env).toBeUndefined();
    for (const s of job.steps) {
      expect(s.run ?? "").not.toContain("${{");
      expect(s.run ?? "").not.toMatch(/secrets\./);
    }
    const run = withSecret[0]!.run!;
    for (const line of run.split("\n")) {
      // No command prints the key or puts it on a command line: only the shell tests and a builtin printf into a pattern file.
      if (/\becho\b/.test(line)) expect(line).not.toContain("ANTHROPIC_API_KEY");
      if (line.includes("ANTHROPIC_API_KEY") && !/\[ -z "\$ANTHROPIC_API_KEY" \]/.test(line)) expect(line).toContain("printf '%s' \"$ANTHROPIC_API_KEY\"");
    }
    expect(run).not.toMatch(/>\s*\S*\$ANTHROPIC_API_KEY|--api-key|export ANTHROPIC/);
  });

  test("every action is pinned the way ci.yml pins them, and bun is the version ci.yml pins", () => {
    const pins = new Set(Object.values(ci.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter((u): u is string => !!u)));
    const mine = job.steps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(mine.length).toBeGreaterThan(0);
    for (const u of mine) expect(u).toMatch(/^[\w-]+\/[\w-]+@v\d+$/);
    for (const u of mine.filter((u) => !u.startsWith("actions/upload-artifact"))) expect(pins.has(u)).toBe(true);
    const bun = job.steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun"))!;
    const ciBun = ci.jobs.checks!.steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun"))!;
    expect(bun.with).toEqual(ciBun.with);
  });

  test("the skip conditions: no secret and no baseline print a notice and end green", () => {
    const step = job.steps.find((s) => s.id === "live")!;
    const run = step.run!;
    expect(run).toMatch(/if \[ -z "\$ANTHROPIC_API_KEY" \]; then\s+echo "::notice::[^\n]*\n\s+exit 0/);
    expect(run).toMatch(/if \[ ! -f evals\/baseline\.sdk\.json \]; then\s+echo "::notice::[^\n]*\n\s+exit 0/);
    expect(job.steps.find((s) => s.name === "Install the SDK")!.if).toBe("hashFiles('evals/baseline.sdk.json') != ''");
  });

  test("it installs the SDK at an exact version without saving it, and runs the live gate", () => {
    const install = job.steps.find((s) => s.name === "Install the SDK")!;
    expect(install.run).toMatch(/^bun add --no-save @anthropic-ai\/claude-agent-sdk@\d+\.\d+\.\d+$/);
    const run = job.steps.find((s) => s.id === "live")!.run!;
    expect(run).toContain("bun run eval:smoke -- --driver sdk --gate --runs 3");
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(JSON.stringify(pkg)).not.toContain("claude-agent-sdk");
  });

  test("the runs are uploaded only after a scan for the key, and the scan fails closed", () => {
    const run = job.steps.find((s) => s.id === "live")!.run!;
    const scan = run.indexOf("grep -rqFf");
    expect(scan).toBeGreaterThan(0);
    expect(run.indexOf("upload=true")).toBeGreaterThan(scan);
    expect(run).toMatch(/\[ "\$s" -ne 1 \]; then\s+rm -rf "\$out"\s+echo "::error::[^\n]*\n\s+exit 1/);
    const up = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(up.if).toContain("steps.live.outputs.upload == 'true'");
  });

  test("a concurrency group and a timeout; ci.yml does not depend on the job", () => {
    expect(wf.concurrency.group).toBeTruthy();
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    const ciText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ciText).not.toContain("eval-live");
    expect(readdirSync(join(REPO_ROOT, ".github", "workflows")).sort()).toEqual(["ci.yml", "eval-live.yml"]);
  });
});

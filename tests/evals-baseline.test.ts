import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { REPO_ROOT } from "../evals/runner/files.ts";
import type { GradeReport } from "../evals/graders/types.ts";
import type { StopReason } from "../evals/runner/types.ts";
import {
  aggregate,
  BASELINE_FILE,
  buildBaseline,
  compare,
  main,
  shownPath,
  SMOKE_SCENARIOS,
  type Baseline,
  type Observed,
  type RunOneOptions,
  type SmokeIO,
} from "../evals/smoke.ts";
import { tempDir } from "./helpers.ts";

// The smoke run and evals/baseline.json (FR-6.4, D6): the committed baseline passes, a lowered score
// is a regression with exit 1, --report-only exits 0, --update-baseline writes the same bytes every
// time, the baseline matches its schema, and the CI job is non-blocking and uses no secret.


const committed = () => JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;

// A grade report as the graders write one, with every grader at the committed baseline's score
// unless `scores` says otherwise; `omit` leaves a grader out.
function report(scenario: string, scores: Record<string, number | null> = {}, omit: string[] = [], effort: Record<string, number | null> = {}): GradeReport {
  const base = committed().scenarios[scenario]!;
  const graders = Object.entries(base.graders)
    .filter(([name]) => !omit.includes(name))
    .map(([grader, b]) => {
      const score = grader in scores ? scores[grader]! : b.score;
      return { grader, score, passed: score === null || score === 1, details: [] };
    });
  graders.push({ grader: "effort", score: null, passed: true, details: [], metrics: { ...base.effort, ...effort } } as never);
  return { run_id: `${scenario}-20260101T000000000Z`, scenario, persona: scenario.replace("acme-", ""), passed: true, score: 1, graders };
}

// An io whose runOne returns synthetic grades instead of running the scenarios.
function fakeIO(grades: Record<string, GradeReport | GradeReport[]>, stops: Record<string, StopReason> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const outDirs: string[] = [];
  const calls = new Map<string, number>();
  const io: SmokeIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env: {},
    runOne: async (name: string, opts: RunOneOptions) => {
      outDirs.push(opts.outDir);
      const n = calls.get(name) ?? 0;
      calls.set(name, n + 1);
      const g = grades[name] ?? report(name);
      return { report: Array.isArray(g) ? g[n % g.length]! : g, stop_reason: stops[name] ?? "done" };
    },
  };
  return { io, out, err, outDirs, text: () => out.join("\n") };
}

function realIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {} } as SmokeIO, out, err, text: () => out.join("\n") };
}

const tableRow = (text: string, scenario: string, grader: string) =>
  text.split("\n").find((l) => l.startsWith(`${scenario} `) && l.split(/\s+/)[1] === grader);

describe("the committed baseline", () => {
  test("matches its schema and covers the smoke subset", () => {
    const b = committed();
    expect(evalSchemaIssues("eval-baseline", b, "evals/baseline.json")).toEqual([]);
    expect(Object.keys(b.scenarios).sort()).toEqual([...SMOKE_SCENARIOS].sort());
    expect(b.driver).toBe("scripted");
    for (const s of Object.values(b.scenarios)) {
      expect(s.stop_reason).toBe("done");
      // The scripted driver is deterministic, so every band is 0; effort is not a compared grader.
      for (const g of Object.values(s.graders)) expect(g.band).toBe(0);
      expect(s.graders.effort).toBeUndefined();
      expect(Object.keys(s.graders).sort()).toEqual(["approvals", "authority", "connection_first", "figures", "secrets", "selection"]);
      expect(s.effort.tokens).toBeGreaterThan(0);
      expect(s.graders.figures!.score).toBe(1);
      expect(s.graders.approvals!.score).toBe(1);
      expect(s.effort.approved_items).toBeGreaterThan(0);
    }
  });

  test("the schema refuses a negative band, a score above 1 and a missing field", () => {
    const b = committed();
    const bad = structuredClone(b) as unknown as { scenarios: Record<string, { graders: Record<string, { band: number; score: number }>; effort?: unknown }> };
    bad.scenarios["acme-terse"]!.graders.secrets!.band = -0.1;
    bad.scenarios["acme-terse"]!.graders.selection!.score = 1.5;
    delete bad.scenarios["acme-structured"]!.effort;
    const issues = evalSchemaIssues("eval-baseline", bad, "evals/baseline.json").map((i) => i.path);
    expect(issues.some((p) => p.includes("secrets") && p.includes("band"))).toBe(true);
    expect(issues.some((p) => p.includes("selection") && p.includes("score"))).toBe(true);
    expect(issues.some((p) => p.includes("acme-structured"))).toBe(true);
  });

  test("smoke against it passes with the real scripted runs", async () => {
    const r = realIO();
    expect(await main([], r.io)).toBe(0);
    const text = r.text();
    expect(text.split("\n")[0]).toMatch(/^scenario\s+grader\s+baseline\s+score\s+band\s+status$/);
    for (const s of SMOKE_SCENARIOS) {
      // The scripted runs reach approvals and goldens, so every grader is scored, and scores 1.
      for (const g of ["figures", "secrets", "selection", "approvals", "connection_first", "authority"]) expect(tableRow(text, s, g)).toMatch(/\s1\s+1\s+0\s+ok$/);
    }
    expect(text).not.toContain("REGRESSION");
    expect(text).toContain("Effort (report only; it never fails the smoke):");
    expect(text).toContain("Smoke: no regression against evals/baseline.json.");
    expect(text).toContain("Next: nothing to do for the evals.");
    expect(r.err).toEqual([]);
  }, 30_000);
});

describe("regressions", () => {
  test("a lowered score is a regression: exit 1, a REGRESSION row and the next command", async () => {
    const f = fakeIO({ "acme-terse": report("acme-terse", { secrets: 0 }) });
    expect(await main([], f.io)).toBe(1);
    expect(tableRow(f.text(), "acme-terse", "secrets")).toMatch(/1\s+0\s+0\s+REGRESSION \(below 1\)$/);
    expect(tableRow(f.text(), "acme-structured", "secrets")).toMatch(/ok$/);
    expect(f.text()).toContain("Smoke: 1 regression(s) against evals/baseline.json.");
    expect(f.text()).toContain("bun run eval:smoke -- --update-baseline");
  });

  test("--report-only prints the regression and exits 0", async () => {
    const f = fakeIO({ "acme-terse": report("acme-terse", { secrets: 0 }) });
    expect(await main(["--report-only"], f.io)).toBe(0);
    expect(tableRow(f.text(), "acme-terse", "secrets")).toContain("REGRESSION");
    expect(f.text()).toContain("--report-only: exiting 0 despite the regression(s).");
  });

  test("a grader no longer scored, a missing grader and an unfinished run are regressions", async () => {
    const f = fakeIO({ "acme-structured": report("acme-structured", { selection: null }, ["connection_first"]) }, { "acme-terse": "turn_budget" });
    expect(await main([], f.io)).toBe(1);
    const t = f.text();
    expect(tableRow(t, "acme-structured", "selection")).toContain("REGRESSION (no longer graded)");
    expect(tableRow(t, "acme-structured", "connection_first")).toMatch(/missing\s+0\s+REGRESSION \(the run has no such grader\)$/);
    expect(tableRow(t, "acme-terse", "(run)")).toContain("REGRESSION (the run stopped on turn_budget)");
    expect(t).toContain("Smoke: 3 regression(s)");
  });

  test("effort metrics never fail the smoke, however far they move", async () => {
    const f = fakeIO({ "acme-terse": report("acme-terse", {}, [], { tokens: 999999, owner_turns: 40 }) });
    expect(await main([], f.io)).toBe(0);
    expect(f.text()).toContain("tokens 999999 (baseline 9978)");
    expect(f.text()).not.toContain("REGRESSION");
  });

  test("a score within the band is ok; below it, a regression; above it, improved", () => {
    const b = structuredClone(committed());
    b.scenarios["acme-terse"]!.graders.secrets = { score: 0.8, band: 0.25 };
    const rows = (secrets: number) =>
      compare(b, [{ scenario: "acme-terse", runs: [{ report: report("acme-terse", { secrets }), stop_reason: "done" }] }]).find((r) => r.grader === "secrets")!;
    expect(rows(0.55).status).toBe("ok");
    expect(rows(0.5).status).toBe("REGRESSION");
    expect(rows(1).status).toBe("ok");
    b.scenarios["acme-terse"]!.graders.secrets = { score: 0.5, band: 0.25 };
    expect(rows(1).status).toBe("improved");
  });

  test("a scenario the baseline lacks is a regression, and a grader it lacks is new", () => {
    const b = structuredClone(committed());
    delete b.scenarios["acme-structured"];
    const extra = report("acme-terse");
    extra.graders.push({ grader: "evidence", score: 1, passed: true, details: [] });
    const rows = compare(b, [
      { scenario: "acme-structured", runs: [{ report: report("acme-terse"), stop_reason: "done" }] },
      { scenario: "acme-terse", runs: [{ report: extra, stop_reason: "done" }] },
    ]);
    expect(rows.find((r) => r.scenario === "acme-structured")).toMatchObject({ status: "REGRESSION", why: "the baseline has no entry for this scenario" });
    expect(rows.find((r) => r.grader === "evidence")).toMatchObject({ status: "new" });
  });

  test("a baseline scenario the smoke no longer runs is noted, not failed, and the hint names --baseline", async () => {
    const file = join(tempDir(), "baseline.json");
    const b = committed();
    b.scenarios["acme-old"] = structuredClone(b.scenarios["acme-terse"]!);
    writeFileSync(file, JSON.stringify(b));
    const f = fakeIO({});
    expect(await main(["--baseline", file], f.io)).toBe(0);
    expect(tableRow(f.text(), "acme-old", "(all)")).toContain("not run (the smoke subset no longer runs it)");
    expect(f.text()).toContain(`record it with bun run eval:smoke -- --update-baseline --baseline ${shownPath(file)}.`);
  });

  test("the regression hint repeats the --baseline the run was given", async () => {
    const file = join(tempDir(), "baseline.json");
    writeFileSync(file, readFileSync(BASELINE_FILE));
    const f = fakeIO({ "acme-terse": report("acme-terse", { secrets: 0 }) });
    expect(await main(["--baseline", file], f.io)).toBe(1);
    expect(f.text()).toContain(`record it with bun run eval:smoke -- --update-baseline --baseline ${shownPath(file)} and say why`);
  });

  test("aggregate: the mean ignores nulls, the spread covers scored runs, the stop reason is the first not done", () => {
    const r = (secrets: number | null) => report("acme-terse", { secrets });
    const a = aggregate({
      scenario: "acme-terse",
      runs: [
        { report: r(1), stop_reason: "done" },
        { report: r(null), stop_reason: "turn_budget" },
        { report: r(0.5), stop_reason: "error" },
      ],
    });
    expect(a.scores.get("secrets")).toEqual({ score: 0.75, spread: 0.5 });
    expect(a.stop_reason).toBe("turn_budget");
  });
});

describe("--update-baseline", () => {
  test("writes the same bytes every time, equal to the committed baseline", async () => {
    const dir = tempDir();
    const file = join(dir, "baseline.json");
    const r1 = realIO();
    expect(await main(["--update-baseline", "--baseline", file], r1.io)).toBe(0);
    const first = readFileSync(file, "utf8");
    const r2 = realIO();
    expect(await main(["--update-baseline", "--baseline", file], r2.io)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(first).toBe(readFileSync(BASELINE_FILE, "utf8"));
    expect(evalSchemaIssues("eval-baseline", JSON.parse(first), file)).toEqual([]);
    // Keys sorted at every level.
    const walk = (v: unknown): void => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        expect(Object.keys(v)).toEqual(Object.keys(v).sort());
        Object.values(v).forEach(walk);
      }
    };
    walk(JSON.parse(first));
    expect(Object.keys(JSON.parse(first))).toEqual(["driver", "runs", "scenarios", "version"]);
    expect(r2.text()).toContain("Next: commit");
  }, 30_000);

  test("records a lowered score, so the next smoke against it passes", async () => {
    const dir = tempDir();
    const file = join(dir, "baseline.json");
    writeFileSync(file, readFileSync(BASELINE_FILE));
    const lowered = { "acme-terse": report("acme-terse", { secrets: 0.5 }) };
    const u = fakeIO(lowered);
    expect(await main(["--update-baseline", "--baseline", file], u.io)).toBe(0);
    // The update prints the comparison with the old baseline before it rewrites the file.
    expect(tableRow(u.text(), "acme-terse", "secrets")).toContain("REGRESSION");
    expect((JSON.parse(readFileSync(file, "utf8")) as Baseline).scenarios["acme-terse"]!.graders.secrets).toEqual({ score: 0.5, band: 0 });
    expect(await main(["--baseline", file], fakeIO(lowered).io)).toBe(0);
  });

  test("with several runs, the score is the mean and the band the observed spread", async () => {
    const dir = tempDir();
    const file = join(dir, "baseline.json");
    const f = fakeIO({ "acme-terse": [report("acme-terse", { secrets: 1 }), report("acme-terse", { secrets: 0.5 }), report("acme-terse", { secrets: 0.75 })] });
    expect(await main(["--update-baseline", "--baseline", file, "--runs", "3"], f.io)).toBe(0);
    const b = JSON.parse(readFileSync(file, "utf8")) as Baseline;
    expect(b.runs).toBe(3);
    expect(b.scenarios["acme-terse"]!.graders.secrets).toEqual({ score: 0.75, band: 0.5 });
    expect(b.scenarios["acme-structured"]!.graders.secrets).toEqual({ score: 1, band: 0 });
    // Each run of a scenario gets its own directory.
    expect(new Set(f.outDirs).size).toBe(3);
  });

  test("a previous baseline that is not valid JSON or fails its schema is set aside, and a valid one is written", async () => {
    for (const broken of ["{bad", JSON.stringify({ version: 2 })]) {
      const file = join(tempDir(), "baseline.json");
      writeFileSync(file, broken);
      const f = fakeIO({});
      expect(await main(["--update-baseline", "--baseline", file], f.io)).toBe(0);
      expect(f.err.join("\n")).toContain("smoke: ignoring the previous baseline:");
      expect(f.err.join("\n")).toContain("Every band starts at 0.");
      expect(readFileSync(file, "utf8")).toBe(readFileSync(BASELINE_FILE, "utf8"));
      expect(await main(["--baseline", file], fakeIO({}).io)).toBe(0);
    }
  });

  test("a baseline of another driver is not replaced unless --baseline names the file", async () => {
    // The default file is evals/baseline.json, recorded with the scripted driver: refused before any run.
    // A run that throws keeps a regression of the check from ever writing the committed file.
    const ran: string[] = [];
    const f = fakeIO({});
    f.io.runOne = async (name) => {
      ran.push(name);
      throw new Error("must not run");
    };
    expect(await main(["--update-baseline", "--driver", "sdk"], f.io)).toBe(2);
    expect(ran).toEqual([]);
    expect(f.err.at(-1)).toContain("--update-baseline --driver sdk --baseline evals/baseline.sdk.json");
    // Named explicitly, the file is replaced.
    const file = join(tempDir(), "baseline.json");
    writeFileSync(file, readFileSync(BASELINE_FILE));
    expect(await main(["--update-baseline", "--driver", "sdk", "--baseline", file], fakeIO({}).io)).toBe(0);
    expect((JSON.parse(readFileSync(file, "utf8")) as Baseline).driver).toBe("sdk");
  });

  test("a run that fails during --update-baseline exits 2, leaves the file as it was and removes the runs", async () => {
    const file = join(tempDir(), "baseline.json");
    writeFileSync(file, readFileSync(BASELINE_FILE));
    const before = readFileSync(file, "utf8");
    const f = fakeIO({});
    const seen: string[] = [];
    f.io.runOne = async (_n, o) => {
      seen.push(o.outDir);
      throw new Error("boom");
    };
    expect(await main(["--update-baseline", "--baseline", file], f.io)).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(f.err.at(-1)).toContain("smoke: unexpected error");
    for (const d of seen) expect(existsSync(d)).toBe(false);
  });

  test("with one run, a band the previous baseline gives a grader is kept", () => {
    const prev = structuredClone(committed());
    prev.scenarios["acme-terse"]!.graders.secrets!.band = 0.2;
    const observed: Observed[] = SMOKE_SCENARIOS.map((s) => ({ scenario: s, runs: [{ report: report(s), stop_reason: "done" as const }] }));
    expect(buildBaseline(observed, "scripted", 1, prev).scenarios["acme-terse"]!.graders.secrets!.band).toBe(0.2);
    // A baseline of another driver gives no bands.
    expect(buildBaseline(observed, "scripted", 1, { ...prev, driver: "sdk" }).scenarios["acme-terse"]!.graders.secrets!.band).toBe(0);
  });
});

describe("errors and where runs go", () => {
  test("a missing baseline exits 2 and names the command that records one", async () => {
    const f = fakeIO({});
    expect(await main(["--baseline", join(tempDir(), "none.json")], f.io)).toBe(2);
    expect(f.err.at(-1)).toContain("Record one with: bun run eval:smoke -- --update-baseline");
  });

  test("a baseline that fails its schema exits 2", async () => {
    const file = join(tempDir(), "baseline.json");
    writeFileSync(file, JSON.stringify({ version: 1, driver: "scripted", runs: 1, scenarios: { "acme-terse": { graders: {} } } }));
    const f = fakeIO({});
    expect(await main(["--baseline", file], f.io)).toBe(2);
    expect(f.err.at(-1)).toContain("does not match its schema");
  });

  test("a run of another driver than the baseline's is refused", async () => {
    const f = fakeIO({});
    expect(await main(["--driver", "sdk"], f.io)).toBe(2);
    expect(f.err.at(-1)).toContain("was recorded with the scripted driver; rerun with --driver scripted");
  });

  test("bad flags exit 2 with the usage", async () => {
    for (const argv of [["--bogus"], ["--runs", "0"], ["--driver", "live"]]) {
      const f = fakeIO({});
      expect(await main(argv, f.io)).toBe(2);
      expect(f.err.at(-1)).toMatch(/^smoke: /);
    }
  });

  test("runs go to a temporary directory that is removed afterwards, never into the repository", async () => {
    const f = fakeIO({});
    expect(await main([], f.io)).toBe(0);
    expect(f.outDirs.length).toBe(SMOKE_SCENARIOS.length);
    for (const d of f.outDirs) {
      expect(d.startsWith(REPO_ROOT)).toBe(false);
      expect(existsSync(d)).toBe(false);
    }
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n")).toContain("evals/runs/");
  });

  test("--out keeps the runs", async () => {
    const dir = tempDir();
    const r = realIO();
    expect(await main(["--out", dir], r.io)).toBe(0);
    for (const s of SMOKE_SCENARIOS) expect(existsSync(join(dir, `${s}-20260101T000000000Z`, "grades.json"))).toBe(true);
    expect(r.text()).toContain("The runs are in");
  }, 30_000);

  test("paths outside the working directory are shown absolute", () => {
    const outside = join(tempDir(), "out");
    expect(shownPath(outside)).toBe(outside);
    expect(shownPath(BASELINE_FILE)).toBe("evals/baseline.json");
  });
});

describe("the CI job", () => {
  const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const ci = parseYamlText(text, "ci.yml") as { jobs: Record<string, Record<string, unknown>> };
  const job = ci.jobs["eval-smoke"]!;

  test("eval-smoke parses, is non-blocking and runs the smoke command after an install", () => {
    expect(job).toBeDefined();
    expect(job["continue-on-error"]).toBe(true);
    expect(String(job.name)).toContain("non-blocking");
    const runs = (job.steps as { run?: string }[]).map((s) => s.run).filter(Boolean);
    expect(runs).toEqual(["bun install --frozen-lockfile", "bun run eval:smoke"]);
  });

  test("eval-smoke uses no secret, no key and no environment", () => {
    const jobText = text.slice(text.indexOf("  eval-smoke:"));
    expect(jobText).not.toMatch(/secrets\.|API_KEY|TOKEN|PASSWORD/i);
    expect(job.env).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("--driver");
  });

  test("the checks job stays blocking and runs verify.sh", () => {
    const checks = ci.jobs.checks!;
    expect(checks["continue-on-error"]).toBeUndefined();
    expect((checks.steps as { run?: string }[]).some((s) => s.run === "bash scripts/verify.sh")).toBe(true);
  });

  test("package.json runs the smoke as eval:smoke", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["eval:smoke"]).toBe("bun evals/smoke.ts");
  });
});

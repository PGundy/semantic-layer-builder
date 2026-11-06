import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, readTree, REPO_ROOT, scenarioPath, type Script } from "../evals/runner/files.ts";
import { runScenario, steppingClock } from "../evals/runner/runner.ts";
import type { TranscriptTurn } from "../evals/runner/types.ts";
import { main as gradeMain } from "../evals/graders/grade.ts";
import { equalsFigure, firstModel, inlineParams } from "../evals/graders/figures.ts";
import { cleanReason, formatReport, GRADES_FILE, gradeRun } from "../evals/graders/index.ts";
import { protectedValues } from "../evals/graders/secrets.ts";
import type { GradeReport, GraderResult } from "../evals/graders/types.ts";
import type { Golden, Metric } from "../skills/semantic-layer/scripts/lib/types.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { approveWithYes, sl } from "./helpers.ts";

// The deterministic graders (evals/graders, FR-6.3): both scripted scenarios grade clean, and
// synthetic run directories built from a scripted run fail each grader the way the spec says.

const START = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sl-grades-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The scenario's script, or with draftOnly its first three skill turns, ending after sl draft with
// nothing approved, which the synthetic run directories below start from.
async function scripted(name: string, out = temp(), draftOnly = false) {
  const file = scenarioPath(name);
  const scenario = loadScenario(file);
  const full = loadScript(scenario, file);
  const script: Script = draftOnly ? { skill: full.skill.slice(0, 3).map((t, i) => (i === 2 ? { ...t, done: true } : t)), owner: full.owner.slice(0, 2) } : full;
  return runScenario({ scenario, driver: scriptedDriver(script, steppingClock("2026-06-01T00:00:00Z")), driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file });
}

// A copy of the acme-structured run up to its drafts, at the same depth under the temp directory so
// its view paths still reach the fixture.
let base: string;
beforeAll(async () => {
  base = (await scripted("acme-structured", temp(), true)).runDir;
});
function copyRun(): { dir: string; root: string } {
  const dir = join(temp(), "acme-structured-20260101T000000000Z");
  cpSync(base, dir, { recursive: true });
  return { dir, root: join(dir, "semantic") };
}
const grader = (r: GradeReport, name: string): GraderResult => r.graders.find((g) => g.grader === name)!;
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
function setTranscript(dir: string, turns: Partial<TranscriptTurn>[]) {
  const lines = turns.map((t, i) => JSON.stringify({ speaker: "skill", tokens: 1, timestamp: START, turn: i + 1, text: "", ...t }));
  writeFileSync(join(dir, "transcript.jsonl"), lines.map((l) => `${l}\n`).join(""));
}

// Approves what a lake golden needs: models with grain and key, the measures with a description.
async function approveLake(root: string) {
  const edits: [string, string, string][] = [
    ["lake.sessions", "grain", "One row per visit."],
    ["lake.sessions.session_count", "description", "Sessions, anonymous ones included."],
    ["lake.marketing_spend", "grain", "One row per day per paid channel."],
    ["lake.marketing_spend", "primary_key", '["spend_date", "channel"]'],
    ["lake.marketing_spend.spend", "description", "Spend in US dollars."],
  ];
  for (const [ref, key, value] of edits) expect((await sl(root, ["set", ref, key, value])).code).toBe(0);
  for (const t of ["sessions", "sessions.session_count", "sessions.started_at", "marketing_spend", "marketing_spend.spend", "marketing_spend.channel", "marketing_spend.spend_date"]) {
    const r = await approveWithYes(root, ["--target", `lake.${t}`, "--by", "Dana Ruiz"]);
    expect(r.err).toBe("");
  }
}

function golden(root: string, name: string, request: Record<string, unknown>, rows: Record<string, unknown>[], extra = "") {
  const yaml = [
    `name: ${name}`,
    `question: What is ${name}?`,
    `request: ${JSON.stringify(request)}`,
    "sql: select 1",
    `expected: { tolerance: 0, rows: ${JSON.stringify(rows)} }`,
    "status: approved",
    "confirmed_by: Dana Ruiz",
    "confirmed_at: 2026-01-15",
    extra,
  ].join("\n");
  write(join(root, "goldens", `${name}.yaml`), `${yaml}\n`);
}
// The acme-structured scenario with its figure mapping replaced, in a temp directory.
function withMapping(figures: unknown[]) {
  const scenarioDir = temp();
  const file = join(scenarioDir, "acme-structured.json");
  const base = JSON.parse(readFileSync(scenarioPath("acme-structured"), "utf8"));
  writeFileSync(file, JSON.stringify({ ...base, grading: { ...base.grading, figures: "map.json" } }));
  writeFileSync(join(scenarioDir, "map.json"), JSON.stringify({ figures }));
  return { scenario: loadScenario(file), scenarioFile: file };
}
// A draft warehouse orders model the compiler refuses, so goldens on it use their recorded rows.
async function draftWarehouse(root: string) {
  expect((await sl(root, ["add-source", "--name", "warehouse", "--dialect", "postgres", "--env", "WAREHOUSE_URL"])).code).toBe(0);
  const model = "model: orders\nsource: warehouse\ntable: acme.fct_orders\nstatus: draft\nmeasures:\n  - { name: revenue, expr: amount_cents / 100.0, agg: sum, status: draft }\n";
  write(join(root, "models", "warehouse", "orders.yaml"), model);
}
const in2025 = (field: string) => [
  { field, op: "gte", value: "2025-01-01" },
  { field, op: "lt", value: "2026-01-01" },
];

describe("both scripted scenarios grade clean", () => {
  for (const name of ["acme-structured", "acme-terse"]) {
    test(name, async () => {
      const r = await scripted(name);
      const written = JSON.parse(readFileSync(join(r.runDir, GRADES_FILE), "utf8")) as GradeReport;
      expect(written).toEqual(r.grades);
      expect(evalSchemaIssues("eval-grades", written, GRADES_FILE)).toEqual([]);
      expect(written.graders.map((g) => [g.grader, g.score, g.passed])).toEqual([
        ["figures", 1, true],
        ["secrets", 1, true],
        ["selection", 1, true],
        ["approvals", 1, true],
        ["connection_first", 1, true],
        ["effort", null, true],
      ]);
      expect(written).toMatchObject({ run_id: `${name}-20260101T000000000Z`, scenario: name, passed: true, score: 1 });
      // Both goldens map to a lake figure and take the compiler path, not their recorded rows.
      expect(grader(written, "figures").details).toEqual([
        "semantic/goldens/marketing_spend_2025.yaml: marketing_spend_2025 matches the reference figure (compiled by the reference compiler and run on lake).",
        "semantic/goldens/sessions_2025.yaml: sessions_2025 matches the reference figure (compiled by the reference compiler and run on lake).",
      ]);
      expect(grader(written, "approvals").details).toEqual(["All 6 approved item(s) have a ledger yes with a matching hash."]);
      expect(grader(written, "selection").details).toEqual([
        "semantic/sources/lake.yaml: the scope is the intended 3 table(s): web_events, sessions, marketing_spend.",
        "warehouse: not graded, the run has no source warehouse.",
      ]);
      expect(grader(written, "secrets").details[0]).toContain("dim_customers.email, dim_customers.first_name, dim_customers.last_name, dim_customers.phone");
      expect(grader(written, "effort").metrics).toMatchObject({ approved_items: 8, owner_turns: 5, tokens: r.summary.tokens, wall_time_seconds: 15 });
    });
  }

  test("without the ledger's yes for an approved item, the approvals grader fails on the scripted run", async () => {
    const r = await scripted("acme-terse");
    const ledger = join(r.runDir, "semantic", ".sl", "ledger.jsonl");
    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n");
    const isYes = (l: string) => (JSON.parse(l) as { kind: string; target?: string; verdict?: string }).verdict === "yes";
    const dropped = lines.find((l) => isYes(l) && JSON.parse(l).target === "lake.sessions.session_count")!;
    expect(dropped).toBeDefined();
    writeFileSync(ledger, `${lines.filter((l) => l !== dropped).join("\n")}\n`);
    const g = grader(await gradeRun(r.runDir), "approvals");
    expect(g).toMatchObject({ passed: false, score: 5 / 6 });
    expect(g.details).toEqual([
      `semantic/models/lake/sessions.yaml: lake.sessions.session_count is approved, but the ledger holds no yes for it with hash ${JSON.parse(dropped).content_hash}.`,
    ]);
    // With no yes left at all, nothing approved is backed and the grader scores 0.
    writeFileSync(ledger, lines.filter((l) => !isYes(l)).map((l) => `${l}\n`).join(""));
    expect(grader(await gradeRun(r.runDir), "approvals")).toMatchObject({ passed: false, score: 0 });
  });

  test("the same run grades to the same bytes", async () => {
    const { dir } = copyRun();
    const first = readFileSync(join(dir, GRADES_FILE), "utf8");
    expect(await gradeMain(["--run", dir], { out: () => {}, err: () => {} })).toBe(0);
    expect(readFileSync(join(dir, GRADES_FILE), "utf8")).toBe(first);
  });
});

describe("figures", () => {
  test("approved lake goldens are compiled, run on the lake and equal the reference figures", async () => {
    const { dir, root } = copyRun();
    await approveLake(root);
    golden(root, "sessions_2025", { source: "lake", measures: ["sessions.session_count"], filters: in2025("sessions.started_at") }, [{ session_count: 1 }]);
    golden(root, "marketing_spend_2025", { source: "lake", measures: ["marketing_spend.spend"], filters: in2025("marketing_spend.spend_date") }, [{ spend: 1 }]);
    golden(root, "spend_by_channel_2025", { source: "lake", measures: ["marketing_spend.spend"], dimensions: ["marketing_spend.channel"], filters: in2025("marketing_spend.spend_date") }, [{ channel: "x", spend: 1 }]);
    const g = grader(await gradeRun(dir), "figures");
    // The recorded rows are wrong on purpose: the compiled path does not read them.
    expect(g).toMatchObject({ score: 1, passed: true });
    expect(g.details).toEqual([
      "semantic/goldens/marketing_spend_2025.yaml: marketing_spend_2025 matches the reference figure (compiled by the reference compiler and run on lake).",
      "semantic/goldens/sessions_2025.yaml: sessions_2025 matches the reference figure (compiled by the reference compiler and run on lake).",
      "semantic/goldens/spend_by_channel_2025.yaml: marketing_spend_by_channel_2025 matches the reference figure (compiled by the reference compiler and run on lake).",
    ]);
  });

  test("a compiled figure that differs from the reference fails, naming the row", async () => {
    const { dir, root } = copyRun();
    await approveLake(root);
    golden(root, "sessions_2025", { source: "lake", measures: ["sessions.session_count"] }, [{ session_count: 4551 }]);
    golden(root, "spend_by_channel_2025", { source: "lake", measures: ["marketing_spend.spend"], dimensions: ["marketing_spend.channel"] }, [{ channel: "x", spend: 1 }]);
    const g = grader(await gradeRun(dir), "figures");
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details[0]).toBe("semantic/goldens/sessions_2025.yaml: sessions_2025 does not match the reference figure: it is 8000, not 4551 (compiled by the reference compiler and run on lake).");
    expect(g.details[1]).toMatch(/^semantic\/goldens\/spend_by_channel_2025\.yaml: marketing_spend_by_channel_2025 does not match the reference figure: affiliate is 2\d+\.\d+, not 1479\.93/);
  });

  test("a golden the compiler refuses falls back to its recorded rows, and a common mistake fails", async () => {
    const { dir, root } = copyRun();
    await draftWarehouse(root);
    const req = { source: "warehouse", measures: ["orders.revenue"] };
    golden(root, "revenue_2025", req, [{ revenue: 323286.12 }]);
    golden(root, "gross_revenue_2025", req, [{ revenue: 301050.82 }]);
    golden(root, "revenue_check", req, [{ revenue: 344517.51 }]);
    golden(root, "sales_count", req, [{ n: 12 }]);
    const g = grader(await gradeRun(dir), "figures");
    // Three checks: the two mapped goldens and the unmapped one that equals a common mistake.
    expect(g).toMatchObject({ score: 1 / 3, passed: false });
    const refused = "from the golden's recorded rows, since sl sql refuses it: measures[0] names orders.revenue, which this user may not see (draft, model_hidden)";
    expect(g.details).toEqual([
      `semantic/goldens/gross_revenue_2025.yaml: revenue_2025 matches the reference figure (${refused}).`,
      `semantic/goldens/revenue_2025.yaml: revenue_2025 does not match the reference figure: it is 323286.12, not 301050.82 (${refused}).`,
      "semantic/goldens/revenue_2025.yaml: revenue_2025 equals the common mistake revenue_2025_with_test_accounts: Revenue without excluding test accounts.",
      `semantic/goldens/revenue_check.yaml: 344517.51 (${refused}) equals the common mistake revenue_2025_all_statuses: Revenue with cancelled and refunded orders left in.`,
      "semantic/goldens/sales_count.yaml: maps to no reference figure in evals/scenarios/acme.figures.json, so it is not compared.",
    ]);
  });

  test("a golden whose measure is a metric maps through the metric's first measure", async () => {
    const { dir, root } = copyRun();
    await approveLake(root);
    write(join(root, "metrics.yaml"), 'metrics:\n  - name: sessions_total\n    source: lake\n    type: derived\n    expr: "{sessions.session_count}"\n    format: integer\n    description: Sessions.\n    status: approved\n');
    // The compiler refuses metrics, so the wrong recorded value is what is compared.
    golden(root, "sessions_2025", { source: "lake", measures: ["sessions_total"], filters: in2025("sessions.started_at") }, [{ sessions_total: 1 }]);
    const g = grader(await gradeRun(dir), "figures");
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details[0]).toStartWith("semantic/goldens/sessions_2025.yaml: sessions_2025 does not match the reference figure: it is 1, not 4551 (from the golden's recorded rows, since sl sql refuses it:");
  });

  test("a request's first model: a measure's, a ratio's numerator's, a derived metric's first placeholder's, else a dimension's", () => {
    const metrics = [
      { name: "aov", source: "warehouse", type: "ratio", numerator: "orders.revenue", denominator: "customers.order_count" },
      { name: "net", source: "warehouse", type: "derived", expr: "{ refunds.amount } - {orders.revenue}" },
    ] as Metric[];
    const req = (r: Record<string, unknown>) => ({ name: "g", request: { source: "warehouse", ...r } }) as unknown as Golden;
    expect(firstModel(req({ measures: ["orders.revenue"] }), metrics)).toBe("orders");
    expect(firstModel(req({ measures: ["aov"] }), metrics)).toBe("orders");
    expect(firstModel(req({ measures: ["net"] }), metrics)).toBe("refunds");
    expect(firstModel(req({ dimensions: ["customers.region"] }), metrics)).toBe("customers");
    expect(firstModel({ ...req({ measures: ["aov"] }), request: { source: "lake", measures: ["aov"] } } as Golden, metrics)).toBeUndefined();
  });

  test("a mapping tolerance does not widen a common mistake", async () => {
    const { dir, root } = copyRun();
    await draftWarehouse(root);
    golden(root, "revenue_2025", { source: "warehouse", measures: ["orders.revenue"] }, [{ revenue: 301050.82 }]);
    // revenue_2025_with_shipping is 305494.15, within 2% of the right figure.
    const opts = withMapping([{ figure: "revenue_2025", golden: "revenue_2025", tolerance: 0.02 }]);
    expect(grader(await gradeRun(dir, opts), "figures")).toMatchObject({ score: 1, passed: true });
  });

  test("a mapping entry naming a figure the reference lacks fails the grader", async () => {
    const { dir } = copyRun();
    const g = grader(await gradeRun(dir, withMapping([{ figure: "revenue_2052", golden: "*revenue*" }])), "figures");
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details).toEqual([expect.stringMatching(/map\.json: revenue_2052 is not a figure of fixtures\/acme\/reference-figures\.json; fix the name in the mapping file\.$/)]);
  });

  test("a mapping file that fails its schema fails the grader", async () => {
    const { dir } = copyRun();
    const scenarioDir = temp();
    const base = JSON.parse(readFileSync(scenarioPath("acme-structured"), "utf8"));
    writeFileSync(join(scenarioDir, "acme-structured.json"), JSON.stringify({ ...base, grading: { ...base.grading, figures: "bad.json" } }));
    writeFileSync(join(scenarioDir, "bad.json"), JSON.stringify({ figures: [{ golden: "x" }] }));
    const r = await gradeRun(dir, { scenario: loadScenario(join(scenarioDir, "acme-structured.json")), scenarioFile: join(scenarioDir, "acme-structured.json") });
    expect(grader(r, "figures").passed).toBe(false);
    expect(grader(r, "figures").details.join("\n")).toContain("figure is required");
  });

  test("equality allows the figure's rounding and the relative tolerance", () => {
    expect(equalsFigure(16502.340000000004, 16502.34)).toBe(true);
    expect(equalsFigure("134.4577", 134.46)).toBe(true);
    expect(equalsFigure(4552, 4551)).toBe(false);
    expect(equalsFigure(4552, 4551, 0.001)).toBe(true);
    expect(equalsFigure("x", 1)).toBe(false);
  });

  test("parameters are written in as literals outside quotes", () => {
    expect(inlineParams(`select '$1' as "$2" from t where a >= $1 and b in ($2, $3) and c = $10`, ["it's", 2, true])).toBe(
      `select '$1' as "$2" from t where a >= 'it''s' and b in (2, true) and c = $10`,
    );
    expect(() => inlineParams("select $1", [{}])).toThrow("not a string, number or boolean");
  });
});

describe("secrets", () => {
  const EMAIL = "ruby.patel1@inbox.example.com";
  const URL = "postgres://dana:Fake-Pw-0042@warehouse.acme.example:5432/acme";

  test("the protected values come from the fixture's data, read once", async () => {
    const fixture = join(REPO_ROOT, "fixtures", "acme");
    const p = await protectedValues(fixture, ["dim_customers.email"]);
    expect(p).toBe(await protectedValues(fixture, ["dim_customers.email"]));
    expect(p.words.get(EMAIL)).toBe("dim_customers.email");
    expect(p.words.get("ruby patel")).toBe("dim_customers.first_name and last_name");
    expect(p.words.has("ruby")).toBe(false);
    expect(p.whole.get("ruby")).toBe("dim_customers.first_name");
    expect(p.columns).toContain("stg_customers.full_name");
  });

  test("a leaked email in a snapshot fails, naming the file, line and column but not the value", async () => {
    const { dir, root } = copyRun();
    const snap = join(root, "snapshots", "lake.json");
    writeFileSync(snap, readFileSync(snap, "utf8").replace('"value": "affiliate"', `"value": "${EMAIL.toUpperCase()}"`));
    const r = await gradeRun(dir);
    const g = grader(r, "secrets");
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details).toHaveLength(1);
    expect(g.details[0]).toMatch(/^semantic\/snapshots\/lake\.json line \d+ holds a value of the protected column dim_customers\.email \(not shown\)\.$/);
    expect(JSON.stringify(r)).not.toContain(EMAIL);
  });

  test("a first name as a whole value in a model fails; inside a sentence it does not", async () => {
    const { dir, root } = copyRun();
    const model = join(root, "models", "lake", "sessions.yaml");
    writeFileSync(model, `${readFileSync(model, "utf8")}description: Visits, as Ruby would say.\nsynonyms:\n  - Ruby\n`);
    const g = grader(await gradeRun(dir), "secrets");
    expect(g.details).toEqual([expect.stringMatching(/^semantic\/models\/lake\/sessions\.yaml line \d+ holds a value of the protected column dim_customers\.first_name/)]);
  });

  test("a pasted URL credential, and a full name in the transcript, fail", async () => {
    const { dir, root } = copyRun();
    const source = join(root, "sources", "lake.yaml");
    writeFileSync(source, `${readFileSync(source, "utf8")}description: copied from ${URL}\n`);
    appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify({ speaker: "owner", text: "ask Ruby Patel, she knows", tokens: 1, timestamp: START, turn: 7 })}\n`);
    const r = await gradeRun(dir);
    const g = grader(r, "secrets");
    expect(g.passed).toBe(false);
    expect(g.details).toEqual([
      expect.stringMatching(/^semantic\/sources\/lake\.yaml line \d+ holds a URL with a password, or a key=value secret \(not shown\)\.$/),
      "transcript.jsonl line 7 holds a value of the protected column dim_customers.first_name and last_name (not shown).",
    ]);
    expect(JSON.stringify(r)).not.toContain("Fake-Pw-0042");
  });

  test("a phone number in other punctuation is found; a free-text column's common phrase is not", async () => {
    const { dir, root } = copyRun();
    write(join(root, "notes.md"), "Call 630-555-0175.\nOr (630) 555-0175.\n");
    const model = join(root, "models", "lake", "sessions.yaml");
    // tmp_import_errors.message is free text the sensitivity rules flag; "duplicate id" is one of its values.
    writeFileSync(model, `${readFileSync(model, "utf8")}synonyms:\n  - duplicate id\n`);
    const g = grader(await gradeRun(dir), "secrets");
    expect(g.details).toEqual([
      "semantic/notes.md line 1 holds a value of the protected column dim_customers.phone (not shown).",
      "semantic/notes.md line 2 holds a value of the protected column dim_customers.phone (not shown).",
    ]);
  });

  test("a failed read of the fixture's data is not kept", async () => {
    const fixture = temp();
    write(join(fixture, "data", "broken.parquet"), "not parquet");
    const first = protectedValues(fixture);
    await expect(first).rejects.toThrow();
    const second = protectedValues(fixture);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });

  test("a redacted credential is not a finding", async () => {
    const { dir } = copyRun();
    appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify({ speaker: "skill", text: "SET s3_secret_access_key='[redacted]' and [redacted]", tokens: 1, timestamp: START, turn: 7 })}\n`);
    expect(grader(await gradeRun(dir), "secrets").passed).toBe(true);
  });
});

describe("selection", () => {
  test("a wrong scope fails, naming what it keeps and leaves out", async () => {
    const { dir, root } = copyRun();
    const file = join(root, "sources", "lake.yaml");
    const text = readFileSync(file, "utf8").replace("scope:\n  exclude:\n    - web_events_2024_archive\n", "scope:\n  include: [sessions, web_events*]\n  exclude:\n");
    writeFileSync(file, text);
    expect((await sl(root, ["validate"])).code).toBe(0);
    const g = grader(await gradeRun(dir), "selection");
    expect(g).toMatchObject({ score: 0, passed: false });
    expect(g.details).toEqual([
      "semantic/sources/lake.yaml: the scope leaves out marketing_spend, which the owner's brief puts in scope.",
      "semantic/sources/lake.yaml: the scope keeps main.web_events_2024_archive, which the owner's brief leaves out.",
      "warehouse: not graded, the run has no source warehouse.",
    ]);
  });

  test("an intake source without a snapshot fails", async () => {
    const { dir, root } = copyRun();
    rmSync(join(root, "snapshots"), { recursive: true });
    expect(grader(await gradeRun(dir), "selection").details[0]).toBe(
      "semantic/snapshots/lake.json is missing, so lake has no scope to grade; the skill never ran sl introspect --source lake.",
    );
  });
});

describe("approvals", () => {
  test("a run with no ledger yet is not graded, and neither are its figures without an approved golden", async () => {
    const { dir } = copyRun();
    const g = await gradeRun(dir);
    expect(grader(g, "approvals")).toMatchObject({ score: null, passed: true, details: ["not graded: no ledger yet (semantic/.sl/ledger.jsonl)"] });
    expect(grader(g, "figures")).toMatchObject({ score: null, passed: true, details: ["not graded: the run has no approved golden (semantic/goldens/)"] });
  });

  test("every approved item needs a ledger yes with its hash", async () => {
    const { dir, root } = copyRun();
    await approveLake(root);
    const hashOf = (ref: string) => {
      const [, model, field] = ref.split(".");
      const text = readFileSync(join(root, "models", "lake", `${model}.yaml`), "utf8");
      const at = field ? text.indexOf(`name: ${field}\n`) : 0;
      return /approved_hash: (sha256:[0-9a-f]{64})/.exec(text.slice(at))![1]!;
    };
    const refs = ["lake.sessions", "lake.sessions.session_count", "lake.sessions.started_at", "lake.marketing_spend", "lake.marketing_spend.spend", "lake.marketing_spend.channel"];
    const lines = refs.map((target, i) => JSON.stringify({ readback_id: "rb_0001", item: i + 1, target, content_hash: hashOf(target), verdict: "yes", text: "yes" }));
    lines.push(JSON.stringify({ target: "lake.marketing_spend.spend_date", content_hash: "sha256:0", verdict: "yes" }));
    write(join(root, ".sl", "ledger.jsonl"), `${lines.join("\n")}\n`);
    const g = grader(await gradeRun(dir), "approvals");
    expect(g).toMatchObject({ passed: false, score: 6 / 7 });
    expect(g.details).toEqual([
      `semantic/models/lake/marketing_spend.yaml: lake.marketing_spend.spend_date is approved, but the ledger holds no yes for it with hash ${hashOf("lake.marketing_spend.spend_date")}.`,
    ]);
    appendFileSync(join(root, ".sl", "ledger.jsonl"), `${JSON.stringify({ target: "lake.marketing_spend.spend_date", content_hash: hashOf("lake.marketing_spend.spend_date"), verdict: "yes" })}\n`);
    expect(grader(await gradeRun(dir), "approvals")).toMatchObject({ passed: true, score: 1, details: ["All 7 approved item(s) have a ledger yes with a matching hash."] });
  });
});

describe("connection first", () => {
  const ask = { speaker: "skill" as const, text: "Can you give me a read-only connection to the warehouse?" };
  const offer = { speaker: "skill" as const, text: "Then run this catalog query and send me the export." };

  test("an export offered before asking for a connection fails", async () => {
    const { dir } = copyRun();
    setTranscript(dir, [{ speaker: "owner", text: "hi" }, offer]);
    const g = grader(await gradeRun(dir), "connection_first");
    expect(g).toMatchObject({ score: 0, passed: false, details: ["transcript.jsonl turn 2: the skill offers an export before it asks for a connection."] });
  });

  test("an export offered before the owner declines a connection fails", async () => {
    const { dir } = copyRun();
    setTranscript(dir, [{ speaker: "owner", text: "hi" }, ask, { speaker: "owner", text: "let me check" }, offer]);
    expect(grader(await gradeRun(dir), "connection_first").details).toEqual([
      "transcript.jsonl turn 4: the skill offers an export before the owner says a connection is not possible (it asked in turn 2).",
    ]);
  });

  test("a negated export is no offer", async () => {
    const { dir } = copyRun();
    setTranscript(dir, [{ speaker: "owner", text: "hi" }, { speaker: "skill", text: "You're connected, so no export is needed and you don't need an export later. Keep three tables in scope?" }]);
    expect(grader(await gradeRun(dir), "connection_first")).toMatchObject({ passed: true, details: ["transcript.jsonl: the skill never offers an export."] });
  });

  test("an sl export-sql run counts as an offer", async () => {
    const { dir } = copyRun();
    setTranscript(dir, [{ speaker: "owner", text: "hi" }, { speaker: "skill", text: "Here you go.", commands: [{ command: "sl export-sql --dialect postgres", exit_code: 0 }] }]);
    expect(grader(await gradeRun(dir), "connection_first").passed).toBe(false);
  });

  test("ask, decline, then export passes; on an export scenario a confirmed golden fails", async () => {
    const { dir, root } = copyRun();
    setTranscript(dir, [
      { speaker: "owner", text: "hi" },
      ask,
      { speaker: "owner", text: "IT says we can't connect anything to the warehouse." },
      offer,
      { speaker: "skill", text: "Confirmed.", commands: [{ command: "sl goldens confirm --name g", exit_code: 0 }] },
    ]);
    expect(grader(await gradeRun(dir), "connection_first")).toMatchObject({ passed: true, score: 1 });
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...summary, intake: "export" }));
    golden(root, "g", { source: "lake", measures: ["sessions.session_count"] }, [{ session_count: 8000 }]);
    const g = grader(await gradeRun(dir), "connection_first");
    expect(g).toMatchObject({ passed: false, score: 0.5 });
    expect(g.details.slice(1)).toEqual([
      "semantic/goldens/: an export scenario has no data to confirm against, but g is confirmed.",
      "transcript.jsonl turn 5: sl goldens confirm succeeded on an export scenario.",
    ]);
  });
});

describe("effort", () => {
  test("owner turns, words and tokens per approved item, and wall time", async () => {
    const { dir, root } = copyRun();
    await approveLake(root);
    golden(root, "sessions_2025", { source: "lake", measures: ["sessions.session_count"], filters: in2025("sessions.started_at") }, [{ session_count: 4551 }]);
    const g = grader(await gradeRun(dir), "effort");
    expect(g).toMatchObject({ score: null, passed: true });
    expect(g.metrics).toEqual({
      approved_items: 8,
      owner_turns: 2,
      owner_words: 35,
      owner_turns_per_approved_item: 0.25,
      owner_words_per_approved_item: 4.38,
      tokens: 8490,
      tokens_per_approved_item: 1061.25,
      skill_tokens_per_approved_item: 1050,
      wall_time_seconds: 9,
    });
  });
});

describe("the grade command", () => {
  test("prints a table, writes grades.json and exits 1 when a grader fails", async () => {
    const { dir, root } = copyRun();
    rmSync(join(root, "snapshots"), { recursive: true });
    const out: string[] = [];
    expect(await gradeMain(["--run", dir], { out: (t) => out.push(t), err: (t) => out.push(t) })).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("Grades for acme-structured-20260101T000000000Z: failed, score 0.67.");
    expect(text).toContain("selection         0.00   FAIL");
    expect(text).toContain("figures           -      not graded");
    expect(text).toContain("effort            -      measured");
    expect(text).toContain(`Wrote ${join(dir, GRADES_FILE)}.`);
    expect(out.at(-1)).toStartWith("Next: read the failing details above");
    const written = JSON.parse(readFileSync(join(dir, GRADES_FILE), "utf8")) as GradeReport;
    expect(formatReport(written)).toBe(out.slice(0, -3).join("\n"));
  });

  test("--json prints the report", async () => {
    const { dir } = copyRun();
    const out: string[] = [];
    expect(await gradeMain(["--run", dir, "--json"], { out: (t) => out.push(t), err: () => {} })).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(JSON.parse(readFileSync(join(dir, GRADES_FILE), "utf8")));
  });

  test("errors are plain and name the fix", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (t: string) => err.push(t) };
    expect(await gradeMain([], io)).toBe(1);
    expect(err.at(-1)).toContain("--run is required");
    expect(await gradeMain(["--run", temp()], io)).toBe(1);
    expect(err.at(-1)).toContain("holds no summary.json; pass a run directory that bun evals/runner/run.ts wrote.");
    expect(await gradeMain(["--bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain("Usage: bun evals/graders/grade.ts --run");
  });

  test("a grader that throws fails with a clean reason while the rest run, and effort still passes", async () => {
    const { dir, root } = copyRun();
    const email = "ruby.patel1@inbox.example.com";
    write(join(root, "goldens", "broken.yaml"), `name: x\nquestion: [ask ${email} or postgres://dana:Fake-Pw-0042@h/db\n`);
    expect(await gradeMain(["--run", dir], { out: () => {}, err: () => {} })).toBe(1);
    const text = readFileSync(join(dir, GRADES_FILE), "utf8");
    for (const leak of [email, "Fake-Pw-0042", dir, REPO_ROOT]) expect(text).not.toContain(leak);
    const r = JSON.parse(text) as GradeReport;
    expect(grader(r, "figures")).toMatchObject({ passed: false, score: 0 });
    expect(grader(r, "figures").details).toEqual([expect.stringMatching(/^could not grade: semantic\/goldens\/broken\.yaml: invalid YAML: [^\n]* at line \d+, column \d+$/)]);
    expect(grader(r, "effort")).toMatchObject({ passed: true, score: null, details: [expect.stringMatching(/^could not measure: semantic\/goldens\/broken\.yaml: invalid YAML/)] });
    expect(grader(r, "selection").passed).toBe(true);
    // The secrets grader finds the planted email and password in the file, without quoting them.
    expect(grader(r, "secrets").details).toHaveLength(2);
    // Effort's null is not in the mean: figures 0, secrets 0, selection 1, connection_first 1.
    expect(r.score).toBe(0.5);
  });

  test("a failure reason keeps its first line, relative paths, and no credential or protected value", () => {
    const words = new Map([["ruby patel", "dim_customers.first_name and last_name"]]);
    const msg = `${REPO_ROOT}/x/semantic/a.yaml: Ruby Patel at bob@corp.example.org via postgres://u:Pw-1234@h/db:\n\nsecond line`;
    expect(cleanReason(msg, join(REPO_ROOT, "x"), words)).toBe("semantic/a.yaml: [protected value] at [an email] via [redacted]");
  });

  test("a corrupt transcript line and an unknown scenario give plain errors naming the next command", async () => {
    const { dir } = copyRun();
    const err: string[] = [];
    const io = { out: () => {}, err: (t: string) => err.push(t) };
    appendFileSync(join(dir, "transcript.jsonl"), "{not json\n");
    expect(await gradeMain(["--run", dir], io)).toBe(1);
    expect(err.at(-1)).toBe(`grade: ${join(dir, "transcript.jsonl")} line 7 is not valid JSON; rerun the scenario with bun evals/runner/run.ts to write it again.`);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...summary, scenario: "nope" }));
    expect(await gradeMain(["--run", dir], io)).toBe(1);
    expect(err.at(-1)).toStartWith('grade: No scenario named "nope".');
    expect(err.at(-1)).toEndWith("Grade against one with: bun evals/graders/grade.ts --run <dir> --scenario <name|file>");
  });
});

describe("the run directory stays readable after grading", () => {
  test("grading writes only grades.json", async () => {
    const { dir } = copyRun();
    const before = readTree(dir);
    await gradeMain(["--run", dir], { out: () => {}, err: () => {} });
    const after = readTree(dir);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const k of Object.keys(before)) if (k !== GRADES_FILE) expect(after[k]).toBe(before[k]!);
  });
});

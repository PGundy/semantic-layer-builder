import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, REPO_ROOT, scenarioPath } from "../evals/runner/files.ts";
import { evalSchemaName, runScenario, steppingClock } from "../evals/runner/runner.ts";
import { DECOY_COUNT, decoyDdl, decoyTables, REAL_TABLES, SEED } from "../fixtures/noisy/generate.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { assertLocalPg, PG_URL, tempDir } from "./helpers.ts";

// The 200-table scenario: three Acme tables with data and 197 empty decoys in one
// PostgreSQL schema, and a selection grade that names a decoy a scope keeps.

const START = "2026-01-01T00:00:00.000Z";
const NOISY = join(REPO_ROOT, "fixtures", "noisy", "decoys.sql");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = tempDir("evals-noisy");
  dirs.push(d);
  return d;
};

describe("the decoy generator", () => {
  test("its output is byte-identical on two runs and equals the committed file", () => {
    expect(decoyDdl(decoyTables())).toBe(decoyDdl(decoyTables()));
    expect(decoyDdl()).toBe(readFileSync(NOISY, "utf8"));
    expect(JSON.stringify(decoyTables(SEED))).toBe(JSON.stringify(decoyTables(SEED)));
    expect(JSON.stringify(decoyTables(SEED + 1))).not.toBe(JSON.stringify(decoyTables(SEED)));
  });

  test("it makes 197 distinct plain names, none of them a real table's", () => {
    const names = decoyTables().map((t) => t.name);
    expect(names.length).toBe(DECOY_COUNT);
    expect(DECOY_COUNT + REAL_TABLES.length).toBe(200);
    expect(new Set(names).size).toBe(DECOY_COUNT);
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(REAL_TABLES as readonly string[]).not.toContain(n);
      expect(n).toMatch(/orders|customers|regions/);
    }
  });
});

describe("the scenario", () => {
  const file = scenarioPath("acme-noisy-200");
  test("matches its schema, names its three tables and its decoy script, and holds no connection value", () => {
    const scenario = loadScenario(file);
    expect(scenario.intake).toMatchObject({ dialect: "postgres", url_env: "PG_URL", tables: [...REAL_TABLES], decoys: "noisy/decoys.sql" });
    expect(scenario.grading?.selection).toEqual({ warehouse: [...REAL_TABLES] });
    expect(loadScript(scenario, file).skill.length).toBeGreaterThan(0);
    const text = readFileSync(file, "utf8") + readFileSync(join(REPO_ROOT, "evals", "scenarios", "acme-noisy-200.script.json"), "utf8");
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(text).not.toMatch(/:[^\s"@/]+@/);
  });

  test("tables and decoys belong to a postgres intake only", () => {
    const issues = (intake: Record<string, unknown>) => evalSchemaIssues("eval-scenario", { name: "x", fixture: "acme", intake, persona: "terse", budgets: { max_turns: 1, max_tokens: 1 }, opening: "hi" }, "x.json");
    const pg = { path: "connection", source: "w", dialect: "postgres", schema: "per_run", url_env: "PG_URL" };
    expect(issues({ ...pg, tables: ["fct_orders"], decoys: "noisy/decoys.sql" })).toEqual([]);
    expect(issues({ ...pg, tables: [] })).not.toEqual([]);
    expect(issues({ ...pg, decoys: "../decoys.sql" })).not.toEqual([]);
    const duck = { path: "connection", source: "w", dialect: "duckdb", views: { a: "b" } };
    expect(issues({ ...duck, tables: ["fct_orders"] })).not.toEqual([]);
    expect(issues({ ...duck, decoys: "noisy/decoys.sql" })).not.toEqual([]);
  });
});

describe("a run on PostgreSQL", () => {
  async function run(scopeAlso: string[] = []) {
    const file = scenarioPath("acme-noisy-200");
    const scenario = loadScenario(file);
    const script = loadScript(scenario, file);
    // The scripted turn that writes the scope gains the extra includes.
    const turn = script.skill.find((t) => t.semlayer?.some((c) => c[0] === "scope"))!;
    const cmd = turn.semlayer!.find((c) => c[0] === "scope")!;
    cmd.splice(cmd.indexOf("--write"), 0, ...scopeAlso.flatMap((p) => ["--include", p]));
    const out = temp();
    const started = Date.now();
    const r = await runScenario({ scenario, driver: scriptedDriver(script, steppingClock(START)), driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file, env: { PG_URL } });
    return { r, out, seconds: (Date.now() - started) / 1000 };
  }
  const selection = (r: Awaited<ReturnType<typeof run>>["r"]) => r.grades.graders.find((g) => g.grader === "selection")!;

  test.skipIf(!PG_URL)("selection is 1 on 3 of 200 tables, the others all grade, and the replay stays under 10 seconds", async () => {
    assertLocalPg(PG_URL);
    const { r, out, seconds } = await run();
    expect(r.summary.error).toBeUndefined();
    expect(r.summary.stop_reason).toBe("done");
    expect(selection(r)).toMatchObject({ score: 1, passed: true });
    expect(selection(r).details).toEqual(["semantic/sources/warehouse.yaml: the scope is the intended 3 table(s): fct_orders, dim_customers, dim_regions."]);
    for (const g of r.grades.graders.filter((x) => x.score !== null)) expect({ grader: g.grader, score: g.score }).toEqual({ grader: g.grader, score: 1 });
    expect(seconds).toBeLessThan(10);
    // The snapshot read all 200 tables: the three real ones with their rows, the decoys empty.
    const snapshot = JSON.parse(readFileSync(join(r.runDir, "semantic", "snapshots", "warehouse.json"), "utf8")) as { tables: { name: string; row_count: number }[] };
    expect(snapshot.tables.length).toBe(200);
    const rows = Object.fromEntries(snapshot.tables.filter((t) => (REAL_TABLES as readonly string[]).includes(t.name)).map((t) => [t.name, t.row_count]));
    expect(rows).toEqual({ fct_orders: 5000, dim_customers: 500, dim_regions: 6 });
    // The decoys are empty: a row count of 0, or none on PostgreSQL 13, which cannot tell an empty
    // analyzed table from one never analyzed.
    expect(snapshot.tables.filter((t) => !t.row_count).length).toBe(DECOY_COUNT);
    expect(readdirSync(out).length).toBe(1);
  }, 60_000);

  test.skipIf(!PG_URL)("a script that scopes decoys scores selection below 1 and names each one", async () => {
    assertLocalPg(PG_URL);
    const { r } = await run(["fct_orders_*"]);
    const decoys = decoyTables()
      .map((t) => t.name)
      .filter((n) => n.startsWith("fct_orders_"));
    expect(decoys.length).toBeGreaterThan(0);
    const g = selection(r);
    expect(g.score).toBeLessThan(1);
    expect(g.passed).toBe(false);
    const schema = evalSchemaName(r.summary.run_id);
    const keeps = g.details.find((d) => d.includes("the scope keeps"))!;
    for (const n of decoys) expect(keeps).toContain(`${schema}.${n}`);
    expect(keeps).not.toContain("dim_");
    expect(keeps.endsWith("which the owner's brief leaves out.")).toBe(true);
  }, 60_000);

  test.skipIf(!PG_URL)("no schema remains and no file holds the URL", async () => {
    assertLocalPg(PG_URL);
    const { out } = await run();
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      const left = (await db.unsafe("select schema_name from information_schema.schemata where schema_name like 'semlayer_eval_acme_noisy%'")) as unknown[];
      expect(left).toEqual([]);
    } finally {
      await db.close();
    }
    const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")]));
    const url = new URL(PG_URL!);
    const password = decodeURIComponent(url.password);
    for (const text of all(out)) {
      expect(text).not.toContain(PG_URL!);
      if (password) expect(text).not.toContain(`:${password}@`);
      if (password && password !== "postgres" && password !== decodeURIComponent(url.username)) expect(text).not.toContain(password);
    }
  }, 60_000);
});

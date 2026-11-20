import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { gradeRun } from "../evals/graders/index.ts";
import { scriptedDriver } from "../evals/runner/drivers/scripted.ts";
import { loadScenario, loadScript, REPO_ROOT } from "../evals/runner/files.ts";
import { main } from "../evals/runner/run.ts";
import { evalSchemaName, runScenario, steppingClock } from "../evals/runner/runner.ts";
import { type Driver, EvalError, NotRun, type Scenario } from "../evals/runner/types.ts";
import { evalSchemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { approveWithYes, assertLocalPg, PG_URL, semlayer, tempDir, uniqueSchema } from "./helpers.ts";

// A scenario that names a PostgreSQL source (docs/PLAN-v1x.md, A3a): the runner loads the fixture into
// a schema of its own, runs the commands and the figures grader on it, and drops the schema.

const START = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = tempDir("evals-pg");
  dirs.push(d);
  return d;
}

const INTAKE = { path: "connection", source: "warehouse", dialect: "postgres", schema: "per_run", url_env: "PG_URL" };

// A postgres scenario and its script in a temp directory; the script reads the fixture through the run's
// schema with `{schema}`.
function pgScenario(name = "acme-pg-test", intake: Record<string, unknown> = INTAKE) {
  const dir = temp();
  const file = join(dir, `${name}.json`);
  const scenario = {
    name,
    fixture: "acme",
    intake,
    persona: "terse",
    budgets: { max_turns: 10, max_tokens: 100000 },
    opening: "The warehouse is hooked up. Build the layer.",
    script: "script.json",
  };
  const script = {
    skill: [
      {
        text: "Counting the orders.",
        semlayer: [["status"], ["run", "--source", "warehouse", "--sql", "select count(*) as n from {schema}.fct_orders"]],
        done: true,
      },
    ],
    owner: [],
  };
  writeFileSync(file, JSON.stringify(scenario));
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  const loaded = loadScenario(file);
  return { file, scenario: loaded, script: loadScript(loaded, file) };
}

// The eval schemas present in the database, through a connection of the test's own.
async function evalSchemas(url: string): Promise<string[]> {
  const db = new SQL({ url, max: 1 });
  try {
    const rows = (await db.unsafe("select schema_name from information_schema.schemata where schema_name like 'semlayer_eval%' order by 1")) as { schema_name: string }[];
    return rows.map((r) => r.schema_name);
  } finally {
    await db.close();
  }
}

// Every file under a directory, by path, as text.
function allText(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allText(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")]));
}

describe("the scenario schema", () => {
  const issues = (intake: Record<string, unknown>) => evalSchemaIssues("eval-scenario", { name: "x", fixture: "acme", intake, persona: "terse", budgets: { max_turns: 1, max_tokens: 1 }, opening: "hi" }, "x.json");
  test("a postgres intake needs schema and url_env and takes no views or database", () => {
    expect(issues(INTAKE)).toEqual([]);
    expect(issues({ path: "connection", source: "w", dialect: "postgres", url_env: "PG_URL" })).not.toEqual([]);
    expect(issues({ path: "connection", source: "w", dialect: "postgres", schema: "per_run" })).not.toEqual([]);
    expect(issues({ ...INTAKE, views: { a: "b" } })).not.toEqual([]);
    expect(issues({ ...INTAKE, database: "acme/x.sql" })).not.toEqual([]);
    expect(issues({ ...INTAKE, path: "export", views: { a: "b" } })).not.toEqual([]);
    expect(issues({ ...INTAKE, url_env: "pg-url" })).not.toEqual([]);
  });
  test("a duckdb intake is as before and takes neither schema nor url_env", () => {
    expect(issues({ path: "connection", source: "w", dialect: "duckdb", views: { a: "b" } })).toEqual([]);
    expect(issues({ path: "connection", source: "w", dialect: "duckdb" })).not.toEqual([]);
    expect(issues({ path: "connection", source: "w", dialect: "duckdb", views: { a: "b" }, url_env: "PG_URL" })).not.toEqual([]);
    expect(issues({ path: "export", source: "w", dialect: "duckdb", views: { a: "b" }, schema: "per_run" })).not.toEqual([]);
  });
});

describe("the run's schema name", () => {
  test("comes from the run id as a plain identifier", () => {
    expect(evalSchemaName("acme-pg-structured-20260101T000000000Z")).toBe("semlayer_eval_acme_pg_structured_20260101t000000000z");
  });
  test("a name longer than Postgres allows is refused, not quoted or cut", () => {
    expect(() => evalSchemaName(`${"a".repeat(40)}-20260101T000000000Z`)).toThrow(EvalError);
  });
});

describe("without a connection URL the scenario is not run", () => {
  test("runScenario stops before it writes anything", async () => {
    const { scenario, script } = pgScenario();
    const out = temp();
    const opts = { scenario, driver: scriptedDriver(script, steppingClock(START)), driverName: "scripted", clock: steppingClock(START), outDir: out, env: {} };
    const err = await runScenario(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotRun);
    expect((err as Error).message).toContain("PG_URL, which is not set");
    expect(readdirSync(out)).toEqual([]);
  });

  test("run.ts says so and exits 0, as it does not for a failure", async () => {
    const { file } = pgScenario();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["--scenario", file, "--out", temp(), "--now", START], { out: (t) => out.push(t), err: (t) => err.push(t), env: {} });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toMatch(/not run: it reads PostgreSQL through PG_URL/);
  });
});

describe("with a connection URL", () => {
  test.skipIf(!PG_URL)("a run ends done, its commands use the schema, and no eval schema remains", async () => {
    assertLocalPg(PG_URL);
    const before = await evalSchemas(PG_URL!);
    const { scenario, script, file } = pgScenario();
    const out = temp();
    const r = await runScenario({ scenario, driver: scriptedDriver(script, steppingClock(START)), driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file, env: { PG_URL } });
    expect(r.summary.error).toBeUndefined();
    expect(r.summary.stop_reason).toBe("done");
    const schema = evalSchemaName(r.summary.run_id);
    expect(schema).toBe("semlayer_eval_acme_pg_test_20260101t000000000z");
    const skill = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { speaker: string; commands?: { command: string; exit_code: number }[] });
    const commands = skill.flatMap((t) => t.commands ?? []);
    expect(commands.map((c) => c.exit_code)).toEqual([0, 0]);
    // The transcript keeps the argument as written; the root's source names the variable, not its value.
    expect(commands[1]!.command).toContain("{schema}.fct_orders");
    const source = readFileSync(join(r.runDir, "semantic", "sources", "warehouse.yaml"), "utf8");
    expect(source).toContain("env: PG_URL");
    expect(source).toContain(schema);
    expect(await evalSchemas(PG_URL!)).toEqual(before);
  });

  test.skipIf(!PG_URL)("no file of the run holds the URL's password", async () => {
    assertLocalPg(PG_URL);
    const { scenario, script, file } = pgScenario();
    const out = temp();
    const url = new URL(PG_URL!);
    const password = decodeURIComponent(url.password);
    // A password that is not the cluster's own would not connect, so the connection URL used below is
    // the real one and the check is on every file for the URL, for the password as a URL carries it
    // and, when it has one, for the bare password. A password that is also the role's name or the
    // dialect's (CI's is "postgres") appears in the files as that word, so only its URL form is checked.
    const ordinaryWord = password === decodeURIComponent(url.username) || password === "postgres";
    await runScenario({ scenario, driver: scriptedDriver(script, steppingClock(START)), driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file, env: { PG_URL } });
    for (const text of allText(out)) {
      expect(text).not.toContain(PG_URL!);
      if (password) {
        expect(text).not.toContain(`:${password}@`);
        expect(text).not.toContain(`:${url.password}@`);
        if (!ordinaryWord) expect(text).not.toContain(password);
      }
    }
  });

  test("a load that cannot connect writes no password and the error never shows it", async () => {
    const { scenario, script, file } = pgScenario();
    const out = temp();
    const url = "postgres://semlayer_user:Zq7-not-a-real-pw@127.0.0.1:1/nothing";
    const err = await runScenario({ scenario, driver: scriptedDriver(script, steppingClock(START)), driverName: "scripted", clock: steppingClock(START), outDir: out, scenarioFile: file, env: { PG_URL: url } }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("Zq7-not-a-real-pw");
    for (const text of allText(out)) expect(text).not.toContain("Zq7-not-a-real-pw");
  });

  test.skipIf(!PG_URL)("the schema is dropped when the driver throws", async () => {
    assertLocalPg(PG_URL);
    const { scenario, file } = pgScenario();
    let seen: string[] = [];
    let named = "";
    const failing: Driver = {
      async skillTurn(input) {
        named = input.schema ?? "";
        // The schema exists while the run is on.
        seen = await evalSchemas(PG_URL!);
        throw new Error("the driver failed");
      },
      async ownerTurn() {
        throw new Error("not reached");
      },
    };
    const r = await runScenario({ scenario, driver: failing, driverName: "scripted", clock: steppingClock(START), outDir: temp(), scenarioFile: file, env: { PG_URL } });
    expect(r.summary.stop_reason).toBe("error");
    expect(r.summary.error).toBe("the driver failed");
    expect(seen).toContain(named);
    expect(await evalSchemas(PG_URL!)).not.toContain(named);
  });

  test.skipIf(!PG_URL)("the schema is dropped when the run itself throws", async () => {
    assertLocalPg(PG_URL);
    const { scenario, file } = pgScenario();
    // A clock that throws once the run is under way, after the schema exists.
    let reads = 0;
    const clock = () => {
      if (++reads > 5) throw new Error("the clock failed");
      return new Date(Date.parse(START) + reads * 1000);
    };
    const failing: Driver = {
      async skillTurn() {
        return { text: "ok", tokens: 1, done: true };
      },
      async ownerTurn() {
        throw new Error("not reached");
      },
    };
    const err = await runScenario({ scenario, driver: failing, driverName: "scripted", clock, outDir: temp(), scenarioFile: file, env: { PG_URL } }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("the clock failed");
    expect(await evalSchemas(PG_URL!)).toEqual([]);
  });
});

describe("the figures grader on a postgres source", () => {
  test.skipIf(!PG_URL)("compiles an approved golden and runs it on the run's PostgreSQL schema", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("a3a_fig");
    // The acme-structured run's directory shape, so its mapping and reference figures apply.
    const scenarioFile = join(REPO_ROOT, "evals", "scenarios", "acme-structured.json");
    const scenario: Scenario = loadScenario(scenarioFile);
    const dir = join(temp(), "acme-structured-20260101T000000000Z");
    const root = join(dir, "semantic");
    mkdirSync(root, { recursive: true });
    const summary = { run_id: "acme-structured-20260101T000000000Z", scenario: "acme-structured", fixture: "acme", intake: "connection", persona: "terse", driver: "scripted", budgets: scenario.budgets, turns: 1, skill_turns: 0, owner_turns: 1, tokens: 0, tokens_by_speaker: { skill: 0, owner: 0 }, stop_reason: "done", started_at: START, finished_at: START };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
    expect((await semlayer(root, ["init", "--name", "acme"])).code).toBe(0);
    const env = { PG_URL };
    const sql = new SQL({ url: PG_URL!, max: 1 });
    try {
      await loadPostgres(PG_URL!, join(REPO_ROOT, "fixtures", "acme", "data"), schema);
      expect((await semlayer(root, ["add-source", "--name", "warehouse", "--dialect", "postgres", "--env", "PG_URL", "--schemas", schema], env)).code).toBe(0);
      mkdirSync(join(root, "models", "warehouse"), { recursive: true });
      mkdirSync(join(root, "goldens"), { recursive: true });
      writeFileSync(
        join(root, "models", "warehouse", "orders.yaml"),
        `model: orders\nsource: warehouse\ntable: ${schema}.fct_orders\ngrain: One row per order.\nprimary_key: [order_id]\nstatus: draft\nmeasures:\n  - { name: revenue, expr: amount_cents * 0.01, agg: sum, description: Revenue in US dollars., status: draft }\n`,
      );
      for (const t of ["warehouse.orders", "warehouse.orders.revenue"]) expect((await approveWithYes(root, ["--target", t, "--by", "Dana Ruiz"])).err).toBe("");
      writeFileSync(
        join(root, "goldens", "revenue_2025.yaml"),
        'name: revenue_2025\nquestion: What is revenue?\nrequest: {"source":"warehouse","measures":["orders.revenue"]}\nsql: select 1\nexpected: { tolerance: 0, rows: [{ revenue: 1 }] }\nstatus: approved\nconfirmed_by: Dana Ruiz\nconfirmed_at: 2026-01-15\n',
      );
      const direct = Number(((await sql.unsafe(`select sum(amount_cents)::numeric / 100 as v from "${schema}".fct_orders`)) as { v: string }[])[0]!.v);
      const g = (await gradeRun(dir, { scenario, scenarioFile, env })).graders.find((x) => x.grader === "figures")!;
      // All statuses and test accounts are in this golden, so it is not the reference figure; the
      // value it reports was computed on PostgreSQL from the compiled request.
      const m = /revenue_2025 does not match the reference figure: it is ([\d.]+), not 301050\.82 \(compiled by the reference compiler and run on warehouse\)/.exec(g.details[0] ?? "");
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m![1]) - direct)).toBeLessThan(0.005);
      expect(g.score).toBe(0);
    } finally {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`);
      await sql.close();
    }
  });

  test("without the URL variable the golden fails with the adapter's own message, naming the variable", async () => {
    const dir = join(temp(), "acme-structured-20260101T000000000Z");
    const root = join(dir, "semantic");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ run_id: "acme-structured-20260101T000000000Z", scenario: "acme-structured", fixture: "acme", intake: "connection", persona: "terse", driver: "scripted", budgets: { max_turns: 1, max_tokens: 1 }, turns: 1, skill_turns: 0, owner_turns: 1, tokens: 0, tokens_by_speaker: { skill: 0, owner: 0 }, stop_reason: "done", started_at: START, finished_at: START }));
    expect((await semlayer(root, ["init", "--name", "acme"])).code).toBe(0);
    expect((await semlayer(root, ["add-source", "--name", "warehouse", "--dialect", "postgres", "--env", "A3A_NO_SUCH_URL", "--schemas", "s"])).code).toBe(0);
    mkdirSync(join(root, "models", "warehouse"), { recursive: true });
    mkdirSync(join(root, "goldens"), { recursive: true });
    writeFileSync(join(root, "models", "warehouse", "orders.yaml"), "model: orders\nsource: warehouse\ntable: s.fct_orders\ngrain: One row per order.\nprimary_key: [order_id]\nstatus: draft\nmeasures:\n  - { name: revenue, expr: amount_cents * 0.01, agg: sum, description: Revenue., status: draft }\n");
    for (const t of ["warehouse.orders", "warehouse.orders.revenue"]) expect((await approveWithYes(root, ["--target", t, "--by", "Dana Ruiz"])).err).toBe("");
    writeFileSync(join(root, "goldens", "revenue_2025.yaml"), 'name: revenue_2025\nquestion: q\nrequest: {"source":"warehouse","measures":["orders.revenue"]}\nsql: select 1\nexpected: { tolerance: 0, rows: [{ revenue: 1 }] }\nstatus: approved\nconfirmed_by: Dana Ruiz\nconfirmed_at: 2026-01-15\n');
    const g = (await gradeRun(dir, { env: {} })).graders.find((x) => x.grader === "figures")!;
    expect(g.passed).toBe(false);
    expect(g.details[0]).toContain("compiling or running its request failed");
    expect(g.details[0]).toContain("A3A_NO_SUCH_URL");
    expect(existsSync(join(dir, "summary.json"))).toBe(true);
  });
});

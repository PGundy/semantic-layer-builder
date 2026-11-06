// sl goldens compiles each golden's request from the current YAML (FR-2.2): Acme's approved goldens
// pass as committed, the analytics reviewer's experiment fails every golden that uses revenue, a
// cross-check that disagrees names itself, a refused golden is reported, and sl goldens new writes a
// valid draft. All data is the synthetic Acme fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { gradeFigures } from "../evals/graders/figures.ts";
import type { FigureMapping, RunFiles } from "../evals/graders/types.ts";
import { REPO_ROOT } from "../evals/runner/files.ts";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { inlineParams } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { PROTECTED_VALUE } from "../skills/semantic-layer/scripts/lib/output.ts";
import type { Golden, Model, QueryPlan } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, initProject, PG_URL, reapprove, sl, tempRoot, uniqueSchema } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DATA = join(import.meta.dir, "..", "fixtures", "acme", "data");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface CheckResult {
  name: string;
  ok: boolean;
  diffs: string[];
  compiled?: string;
  cross_check?: string;
  next?: string;
}
interface CheckJson {
  passed: number;
  failed: number;
  results: CheckResult[];
}

const LAKE_GOLDENS = ["sessions_2025", "spend_2025", "spend_by_channel_2025"];
const WAREHOUSE_GOLDENS = [
  "analyst_rep_101_by_name_2025",
  "discount_2025",
  "finance_net_revenue_2025",
  "net_revenue_2025",
  "order_count_by_region_2025",
  "refunds_2025",
  "revenue_2025",
  "revenue_by_region_2025",
  "sales_head_301_2025",
  "sales_manager_201_2025",
  "sales_manager_202_2025",
  "sales_manager_203_2025",
  "sales_rep_101_2025",
];
// The approved goldens that use orders.revenue, themselves or through a metric (net_revenue).
const USING_REVENUE = [
  "analyst_rep_101_by_name_2025",
  "finance_net_revenue_2025",
  "net_revenue_2025",
  "revenue_2025",
  "revenue_by_region_2025",
  "sales_head_301_2025",
  "sales_manager_201_2025",
  "sales_manager_202_2025",
  "sales_manager_203_2025",
  "sales_rep_101_2025",
];

// Acme's warehouse tables and fixtures/acme/evolve.sql in a DuckDB file under schema acme, in DuckDB's
// dialect: no constraints or comments, and the rep assignment without a correlated offset.
async function warehouseDuckdb(file: string): Promise<void> {
  const instance = await DuckDBInstance.create(file);
  const cx = await instance.connect();
  await cx.run("create schema acme");
  for (const tb of WAREHOUSE_TABLES) await cx.run(`create table acme.${tb.name} as select * from ${readCsvSql(join(DATA, "warehouse", `${tb.name}.csv`), tb)}`);
  const evolve = readFileSync(join(DATA, "..", "evolve.sql"), "utf8")
    .replace(/--.*$/gm, "")
    .replace(/\s+references acme\.\w+ \(\w+\)/g, "")
    .replace(/^(comment on|analyze|begin|commit)[^;]*;/gm, "")
    .replace(" not null default 0", " default 0")
    .replace(
      /update acme\.fct_orders o\s+set sales_rep_id[\s\S]*?where sales_rep_id is null/,
      "update acme.fct_orders as o set sales_rep_id = r.rep_id from (select rep_id, region_code, row_number() over (partition by region_code order by rep_id) - 1 as k " +
        "from acme.dim_sales_reps) as r where r.region_code = o.ship_region and r.k = o.order_id % 2 and o.sales_rep_id is null",
    );
  for (const stmt of evolve.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await cx.run(stmt);
  cx.closeSync();
  instance.closeSync();
}

function copyAcme(): { root: string; dir: string } {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  cpSync(ACME, t.root, { recursive: true });
  return t;
}

// A copy of Acme whose warehouse source reads that DuckDB file. DuckDB reads `/ 100.0` as a DOUBLE,
// so each warehouse measure divides cents as an exact amount, `* 0.01`, approved again on the copy
// owner's recorded yes, and the goldens' cross_check_sql (Postgres SQL) does the same and formats a
// date with DuckDB's strftime.
async function duckdbAcme(): Promise<{ root: string; dir: string }> {
  const t = copyAcme();
  const file = join(t.dir, "warehouse.duckdb");
  await warehouseDuckdb(file);
  writeFileSync(join(t.root, "sources", "warehouse.yaml"), `source: warehouse\ndialect: duckdb\nconnection:\n  database: ${JSON.stringify(file)}\n`);
  const models = join(t.root, "models", "warehouse");
  for (const f of readdirSync(models)) {
    const m = readYaml<Model>(join(models, f));
    for (const x of m.measures) if (x.expr) x.expr = x.expr.replace(" / 100.0", " * 0.01");
    writeYaml(join(models, f), m);
  }
  for (const name of WAREHOUSE_GOLDENS) {
    const path = join(t.root, "goldens", `${name}.yaml`);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(" / 100.0", " * 0.01").replaceAll("to_char(rev.order_date_year, 'YYYY-MM-DD')", "strftime(rev.order_date_year, '%Y-%m-%d')"));
  }
  await reapprove(t.root);
  return t;
}

function withCancelled(root: string): void {
  const path = join(root, "models", "warehouse", "orders.yaml");
  const m = readYaml<Model>(path);
  const revenue = m.measures.find((x) => x.name === "revenue")!;
  expect(revenue.filter).toContain("status in ('completed', 'shipped')");
  revenue.filter = revenue.filter!.replace("status in ('completed', 'shipped')", "status in ('completed', 'shipped', 'cancelled')");
  writeYaml(path, m);
}

const byName = (doc: CheckJson) => Object.fromEntries(doc.results.map((r) => [r.name, r]));

// Every approved golden of `source` passes: the compiled rows equal expected.rows, and so do the
// rows of its hand-written SQL, which every Acme golden has.
function expectAllPass(doc: CheckJson, names: string[]): void {
  expect(doc.results.map((r) => r.name)).toEqual(names);
  for (const r of doc.results) expect({ name: r.name, ok: r.ok, diffs: r.diffs, compiled: r.compiled, cross_check: r.cross_check }).toEqual({ name: r.name, ok: true, diffs: [], compiled: "pass", cross_check: "pass" });
  expect(doc).toMatchObject({ passed: names.length, failed: 0 });
}

// The analytics reviewer's experiment: orders.revenue counts cancelled orders. Before the owner says
// yes to the change, every golden that uses revenue is refused and fails with the step that resolves
// it; once revenue is approved again, each one fails on its figures, while the hand-written SQL still
// gives the confirmed rows. The goldens that do not use revenue keep passing.
async function revenueExperiment(root: string, env: Record<string, string> = {}): Promise<CheckJson> {
  withCancelled(root);
  const before = await sl(root, ["goldens", "check", "--source", "warehouse", "--json"], env);
  expect(before.code).toBe(1);
  const refused = byName(before.json<CheckJson>());
  for (const name of WAREHOUSE_GOLDENS) {
    const r = refused[name]!;
    if (!USING_REVENUE.includes(name)) {
      expect({ name, ok: r.ok }).toEqual({ name, ok: true });
      continue;
    }
    expect({ name, ok: r.ok, compiled: r.compiled }).toEqual({ name, ok: false, compiled: "refused" });
    expect(r.diffs[0]).toStartWith("The request does not compile from the current YAML: ");
    // revenue itself is changed since its approval; a metric that reads it is hidden while it is.
    expect(r.diffs[0]).toMatch(/changed since approval|measure_hidden:orders\.revenue/);
    expect(r.next).toStartWith("Read warehouse.orders.revenue back to the owner with sl readback --targets warehouse.orders.revenue and approve it on their yes");
  }
  const human = await sl(root, ["goldens", "check", "--name", "revenue_2025"], env);
  expect(human.code).toBe(1);
  expect(human.out).toContain("FAIL  revenue_2025");
  expect(human.out).toContain("Next: Read warehouse.orders.revenue back to the owner");

  await reapprove(root, ["warehouse.orders.revenue"]);
  const after = await sl(root, ["goldens", "check", "--source", "warehouse", "--json"], env);
  expect(after.code).toBe(1);
  const doc = after.json<CheckJson>();
  expect(doc.results.filter((r) => !r.ok).map((r) => r.name)).toEqual(USING_REVENUE);
  for (const name of USING_REVENUE) {
    const r = byName(doc)[name]!;
    expect({ name, compiled: r.compiled, cross_check: r.cross_check }).toEqual({ name, compiled: "fail", cross_check: "pass" });
    expect(r.diffs[0]).toBe("The rows compiled from the YAML differ from expected.rows, and cross_check_sql still gives them: the layer no longer computes the confirmed figure.");
    expect(r.diffs.slice(1).every((d) => d.startsWith("Compiled: "))).toBe(true);
    // Each names the figure that moved: revenue, or net_revenue for the metric that reads it.
    const figure = name.includes("net_revenue") ? "net_revenue" : "revenue";
    const named = r.diffs.some((d) => d.startsWith("Compiled: ") && new RegExp(`(column |[{ ])${figure}: `).test(d));
    expect({ name, named }).toEqual({ name, named: true });
  }
  const text = await sl(root, ["goldens", "check", "--source", "warehouse"], env);
  expect(text.out).toContain(`${WAREHOUSE_GOLDENS.length - USING_REVENUE.length} passed, ${USING_REVENUE.length} failed.`);
  expect(text.out).toContain("Next: sl goldens run --name analyst_rep_101_by_name_2025 shows its rows");
  return doc;
}

describe("Acme's approved goldens compile from the YAML", () => {
  test("the lake's pass as committed on duckdb, compiled and cross-checked", async () => {
    const r = await sl(ACME, ["goldens", "check", "--source", "lake", "--json"]);
    expect(r.code).toBe(0);
    expectAllPass(r.json<CheckJson>(), LAKE_GOLDENS);
  });

  test("the warehouse's pass on duckdb; the experiment fails every golden using revenue, refused until approved again", async () => {
    const { root } = await duckdbAcme();
    const r = await sl(root, ["goldens", "check", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    expectAllPass(r.json<CheckJson>(), WAREHOUSE_GOLDENS);
    // The same inputs give the same output.
    expect((await sl(root, ["goldens", "check", "--source", "warehouse", "--json"])).out).toBe(r.out);
    const doc = await revenueExperiment(root);
    expect(byName(doc).revenue_2025!.diffs.slice(1)).toEqual([
      "Compiled: Row 1: expected {revenue: 301050.82, order_count: 2239, average_order_value: 134.45771326485038}, but no result row matches it.",
      "Compiled: Result row 1: got {revenue: 334559.67, order_count: 2239, average_order_value: 149.42370254577935}, which is not expected.",
    ]);
  }, 120_000);

  test.skipIf(!PG_URL)(
    "every approved golden passes on postgres as committed; the experiment fails every golden using revenue",
    async () => {
      assertLocalPg(PG_URL);
      const db = `sl_goldens_${process.pid}_${Date.now()}`;
      const admin = new SQL({ url: PG_URL!, max: 1 });
      const url = new URL(PG_URL!);
      url.pathname = `/${db}`;
      const env = { WAREHOUSE_URL: url.toString() };
      await admin.unsafe(`CREATE DATABASE "${db}"`);
      try {
        // The committed layer reads schema acme through WAREHOUSE_URL: a database of its own holds it.
        await loadPostgres(env.WAREHOUSE_URL, DATA, "acme");
        const tx = new SQL({ url: env.WAREHOUSE_URL, max: 1 });
        await tx.unsafe(readFileSync(join(DATA, "..", "evolve.sql"), "utf8"));
        await tx.close();
        const r = await sl(ACME, ["goldens", "check", "--json"], env);
        expect(r.code).toBe(0);
        expectAllPass(r.json<CheckJson>(), [...WAREHOUSE_GOLDENS, ...LAKE_GOLDENS].sort());
        await revenueExperiment(copyAcme().root, env);
      } finally {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
        await admin.close();
      }
    },
    180_000,
  );
});

// The figures grader on a copy of Acme with every source on DuckDB, its lake views reading the
// fixture by absolute path, mapped to fixtures/acme/reference-figures.json by the eval scenarios'
// figure mapping. Acme's net revenue goldens group by the order's year, one row, so their entry
// here matches grouped requests too.
function gradeAcme(dir: string, root: string) {
  const lake = join(root, "sources", "lake.yaml");
  writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("'../../../fixtures/", `'${join(REPO_ROOT, "fixtures")}/`));
  const mapping = JSON.parse(readFileSync(join(REPO_ROOT, "evals", "scenarios", "acme.figures.json"), "utf8")) as FigureMapping;
  for (const e of mapping.figures) if (e.figure === "net_revenue_2025") delete e.request!.grouped;
  writeFileSync(join(dir, "figures.json"), JSON.stringify(mapping));
  const run = { dir, root, fixtureDir: join(REPO_ROOT, "fixtures", "acme"), scenarioDir: dir, grading: { figures: "figures.json" } };
  return gradeFigures(run as unknown as RunFiles);
}

describe("the figures grader on Acme", () => {
  test("compiles every approved golden and each mapped one equals its reference figure; the experiment fails the revenue ones", async () => {
    const { dir, root } = await duckdbAcme();
    const g = await gradeAcme(dir, root);
    expect(g.details.filter((d) => !d.includes("matches the reference figure") && !d.includes("maps to no reference figure"))).toEqual([]);
    const matched = g.details.filter((d) => d.includes("matches the reference figure")).map((d) => d.split(":")[0]);
    const goldenFiles = (names: string[]) => names.map((n) => `semantic/goldens/${n}.yaml`);
    expect(matched).toEqual(
      goldenFiles([
        "finance_net_revenue_2025",
        "net_revenue_2025",
        "refunds_2025",
        "revenue_2025",
        "revenue_by_region_2025",
        "sessions_2025",
        "spend_2025",
        "spend_by_channel_2025",
      ]),
    );
    expect(g).toMatchObject({ score: 1, passed: true });

    // Before the owner's yes to the change, the goldens using revenue are refused, so they fail.
    withCancelled(root);
    const refused = await gradeAcme(dir, root);
    expect(refused.passed).toBe(false);
    const failing = (r: typeof g) => [...new Set(r.details.filter((d) => !d.includes("matches the reference figure") && !d.includes("maps to no reference figure")).map((d) => d.split(":")[0]!.replace(/^semantic\/goldens\/|\.yaml$/g, "")))];
    expect(failing(refused)).toEqual(USING_REVENUE);
    expect(refused.details.filter((d) => d.includes("sl sql refuses its request")).length).toBe(USING_REVENUE.length);
    // Approved again on a recorded yes, each revenue golden mapped to a figure fails, naming it.
    await reapprove(root, ["warehouse.orders.revenue"]);
    const after = await gradeAcme(dir, root);
    expect(after.passed).toBe(false);
    const wrong = after.details.filter((d) => d.includes("does not match the reference figure"));
    expect(wrong.map((d) => d.split(":")[0])).toEqual(goldenFiles(["finance_net_revenue_2025", "net_revenue_2025", "revenue_2025", "revenue_by_region_2025"]));
    expect(after.details).toContain(
      "semantic/goldens/revenue_2025.yaml: revenue_2025 does not match the reference figure: it is 334559.67, not 301050.82 (compiled by the reference compiler and run on warehouse).",
    );
  }, 120_000);
});

describe("cross_check_sql", () => {
  test("a cross-check that disagrees names itself; the compiled rows still pass; validate reads the older key sql", async () => {
    const { root } = await duckdbAcme();
    const path = join(root, "goldens", "revenue_2025.yaml");
    // The example's golden under the older key sql: sl validate reads it as cross_check_sql, asks for
    // the key to be renamed, and errors when a golden has both.
    const { cross_check_sql: committed, ...rest } = readYaml<Golden>(path);
    expect(committed).toBeDefined();
    const g: Golden = { ...rest, sql: committed };
    writeYaml(path, g);
    const warned = validateProject(root).filter((i) => i.file === "goldens/revenue_2025.yaml" && i.path === "sql");
    expect(warned.map((i) => [i.level, i.message.split(":")[0]])).toEqual([["warning", "is now cross_check_sql"]]);
    // Counts cancelled orders, which revenue's rule leaves out.
    const wrong = g.sql!.replaceAll("o.status in ('completed', 'shipped')", "o.status in ('completed', 'shipped', 'cancelled')");
    writeYaml(path, { ...g, cross_check_sql: wrong });
    expect(validateProject(root).filter((i) => i.file === "goldens/revenue_2025.yaml" && i.level === "error").map((i) => [i.path, i.message])).toEqual([
      ["sql", "is the older name of cross_check_sql, and the golden has both; keep cross_check_sql and remove sql"],
    ]);
    const { sql: _old, ...renamed } = { ...g, cross_check_sql: wrong };
    writeYaml(path, renamed);
    expect(validateProject(root).filter((i) => i.file === "goldens/revenue_2025.yaml" && (i.path === "sql" || i.level === "error"))).toEqual([]);

    const r = await sl(root, ["goldens", "check", "--name", "revenue_2025", "--json"]);
    expect(r.code).toBe(1);
    const [res] = r.json<CheckJson>().results;
    expect(res).toMatchObject({ name: "revenue_2025", ok: false, compiled: "pass", cross_check: "fail" });
    expect(res!.diffs[0]).toBe("cross_check_sql differs from expected.rows, and the rows compiled from the YAML match them: fix cross_check_sql or remove it.");
    expect(res!.diffs[1]).toStartWith("cross_check_sql: Row 1: expected {revenue: 301050.82, order_count: 2239, ");

    // goldens run shows the compiled rows and names the disagreement; confirm records nothing.
    const run = await sl(root, ["goldens", "run", "--name", "revenue_2025"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("These rows are the request compiled from the current YAML.");
    expect(run.out).toContain("cross_check_sql gives other rows (expected is the compiled, got is cross_check_sql):");
    const before = readFileSync(path, "utf8");
    const confirm = await sl(root, ["goldens", "confirm", "--name", "revenue_2025", "--by", "Dana Ruiz", "--tolerance", "0"]);
    expect(confirm.code).toBe(1);
    expect(confirm.err).toContain("cross_check_sql gives other rows than the request compiled from the YAML");
    expect(readFileSync(path, "utf8")).toBe(before);

    // Without a cross-check the compiled rows alone are checked.
    const { cross_check_sql: _x, ...alone } = renamed;
    writeYaml(path, alone);
    const pass = await sl(root, ["goldens", "check", "--name", "revenue_2025", "--json"]);
    expect(pass.json<CheckJson>().results).toEqual([{ name: "revenue_2025", ok: true, diffs: [], compiled: "pass" }]);
  }, 60_000);
});

describe("goldens the compiler refuses", () => {
  test("fail with the reason and the step that resolves it, never skipped, even with a cross-check that passes", async () => {
    const { root } = await duckdbAcme();
    const path = join(root, "goldens", "discount_2025.yaml");
    const g = readYaml<Golden>(path);
    writeYaml(path, { ...g, request: { ...g.request, measures: ["orders.discounts"] } });
    const r = await sl(root, ["goldens", "check", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(1);
    const doc = r.json<CheckJson>();
    expect(doc).toMatchObject({ passed: WAREHOUSE_GOLDENS.length - 1, failed: 1 });
    const res = byName(doc).discount_2025!;
    expect(res).toMatchObject({ ok: false, compiled: "refused" });
    expect(res.cross_check).toBeUndefined();
    expect(res.diffs[0]).toContain("orders.discounts");
    expect(res.next).toBe("Run sl sql --request goldens/discount_2025.yaml to see why, fix the request or the layer, then run sl goldens check --name discount_2025.");

    // --emit-sql plans the others and says which it left out; finishing reports it as failed.
    const emit = await sl(root, ["goldens", "check", "--source", "warehouse", "--emit-sql"]);
    expect(emit.code).toBe(0);
    expect(emit.err).toContain("Not planned: discount_2025. The request does not compile from the current YAML");
    const plan = emit.json<QueryPlan & { plan_id: string }>();
    expect(plan.queries.some((q) => q.id.startsWith("golden:discount_2025"))).toBe(false);
    expect(plan.queries.filter((q) => !q.id.endsWith(":cross_check")).length).toBe(WAREHOUSE_GOLDENS.length - 1);
    // A plan's compiled queries carry their values as literals, so any tool runs them as they stand.
    expect(plan.queries.every((q) => !/\$\d/.test(q.sql))).toBe(true);
  }, 60_000);

  test("on a dialect the compiler does not support, the cross-check alone runs and says so; without one the golden fails", async () => {
    const t = copyAcme();
    writeFileSync(join(t.root, "sources", "lake.yaml"), "source: lake\ndialect: snowflake\nconnection:\n  env: LAKE_URL\n");
    const results = join(t.dir, "results.json");
    writeFileSync(results, JSON.stringify({ "golden:sessions_2025:cross_check": [{ SESSION_COUNT: 4551 }] }));
    const r = await sl(t.root, ["goldens", "check", "--name", "sessions_2025", "--results", results]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pass  sessions_2025  (checked by cross_check_sql alone: sl sql compiles postgres and duckdb sources)");
    const path = join(t.root, "goldens", "sessions_2025.yaml");
    const { cross_check_sql: _s, ...noCross } = readYaml<Golden>(path);
    writeYaml(path, noCross);
    const none = await sl(t.root, ["goldens", "check", "--name", "sessions_2025", "--json"]);
    expect(none.code).toBe(1);
    const [res] = none.json<CheckJson>().results;
    expect(res).toMatchObject({ ok: false, compiled: "refused" });
    expect(res!.next).toBe(
      "sl sql compiles postgres and duckdb sources only: write the golden's query by hand from the model YAML as cross_check_sql, then run sl goldens run --name sessions_2025 --emit-sql to plan it.",
    );
  });

  test("while access.yaml is a draft every approved golden fails, naming the readback and approval of access", async () => {
    const t = copyAcme();
    const path = join(t.root, "access.yaml");
    writeYaml(path, { ...readYaml<Record<string, unknown>>(path), status: "draft" });
    const r = await sl(t.root, ["goldens", "check", "--source", "lake", "--json"]);
    expect(r.code).toBe(1);
    const doc = r.json<CheckJson>();
    expect(doc).toMatchObject({ passed: 0, failed: LAKE_GOLDENS.length });
    for (const res of doc.results) {
      expect(res).toMatchObject({ ok: false, compiled: "refused" });
      expect(res.next).toBe(
        `Read access back to the owner with sl readback --targets access and approve it on their yes, then run sl goldens check --name ${res.name}; if its rows changed, confirm again only on the owner's yes.`,
      );
    }
  });

  test("a cross_check_sql that writes is refused in check and run, naming the fix", async () => {
    const t = copyAcme();
    const path = join(t.root, "goldens", "sessions_2025.yaml");
    const g = readYaml<Golden>(path);
    writeYaml(path, { ...g, cross_check_sql: "delete from sessions" });
    const r = await sl(t.root, ["goldens", "check", "--name", "sessions_2025"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Cannot plan this golden: Golden "sessions_2025": Only read-only queries run here');
    expect(r.out).toContain("Next: Fix what this says in goldens/sessions_2025.yaml or the layer, then run sl validate and sl goldens check --name sessions_2025.");
    expect(r.out).not.toContain("Next: sl goldens run");
    const run = await sl(t.root, ["goldens", "run", "--name", "sessions_2025"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("Only read-only queries run here");
  });
});

describe("goldens and protected values", () => {
  test("a protected column of the compiled rows is masked in run and in check's differences", async () => {
    const { root } = await duckdbAcme();
    const run = await sl(root, ["goldens", "run", "--name", "analyst_rep_101_by_name_2025", "--json"]);
    expect(run.code).toBe(0);
    const ran = run.json<{ rows: Record<string, unknown>[]; protected_columns: string[]; compiled: boolean }>();
    expect(ran.compiled).toBe(true);
    expect(ran.protected_columns).toEqual(["full_name"]);
    expect(ran.rows).toEqual([{ full_name: PROTECTED_VALUE, revenue: 34938.49, order_count: 251 }]);
    expect(run.out).not.toContain("Avery Patel");
    const human = await sl(root, ["goldens", "run", "--name", "analyst_rep_101_by_name_2025"]);
    expect(human.out).not.toContain("Avery Patel");

    const path = join(root, "goldens", "analyst_rep_101_by_name_2025.yaml");
    const g = readYaml<Golden>(path);
    writeYaml(path, { ...g, expected: { tolerance: 0, rows: [{ full_name: "Synthetic Person", revenue: 34938.49, order_count: 251 }] } });
    const check = await sl(root, ["goldens", "check", "--name", "analyst_rep_101_by_name_2025"]);
    expect(check.code).toBe(1);
    expect(check.out).toContain(PROTECTED_VALUE);
    expect(check.out).not.toContain("Avery Patel");
    expect(check.out).not.toContain("Synthetic Person");
  }, 60_000);

  test("a hostile user attribute stays one quoted value: the query never returns other reps' rows", async () => {
    const { root } = await duckdbAcme();
    const path = join(root, "goldens", "sales_rep_101_2025.yaml");
    const g = readYaml<Golden>(path);
    writeYaml(path, { ...g, user: { ...g.user, employee_id: "101) or (1=1" } });
    const r = await sl(root, ["goldens", "check", "--name", "sales_rep_101_2025", "--json"]);
    expect(r.code).toBe(1);
    const [res] = r.json<CheckJson>().results;
    expect(res!.ok).toBe(false);
    expect(res!.diffs[0]).toStartWith("The query did not run: ");
    const emit = await sl(root, ["goldens", "check", "--name", "sales_rep_101_2025", "--emit-sql"]);
    expect(emit.json<QueryPlan>().queries[0]!.sql).toContain("'101) or (1=1'");
  }, 60_000);
});

describe("inlineParams", () => {
  test("writes each parameter as a literal, outside strings and comments only", () => {
    const sql = "select '$1' as a, -- $2\n x from t where a = $1 and b in ($2, $3) and c > $4 and d = $5 /* $1 */";
    expect(inlineParams(sql, ["it's", 2, -3, 1.5, true], "duckdb")).toBe(
      "select '$1' as a, -- $2\n x from t where a = 'it''s' and b in (2, (-3)) and c > 1.5 and d = true /* $1 */",
    );
    expect(inlineParams("select $1", ["a\\'b"], "postgres")).toBe("select E'a\\\\''b'");
    // On postgres a number is quoted, so it takes the compared column's type as a bound parameter does.
    expect(inlineParams("select $1, $2, $3", [7, -3, 1.5], "postgres")).toBe("select '7', '-3', '1.5'");
    expect(inlineParams("select $1", ["a\\'b"], "duckdb")).toBe("select 'a\\''b'");
    expect(() => inlineParams("select $1", [{ x: 1 }], "duckdb")).toThrow(/text, numbers or true and false/);
    expect(() => inlineParams("select $1", [Number.NaN], "duckdb")).toThrow(/text, numbers or true and false/);
    expect(() => inlineParams("select $2", ["a"], "duckdb")).toThrow(/does not bind/);
  });
});

describe("goldens new", () => {
  const request = JSON.stringify({ source: "warehouse", measures: ["orders.revenue"], dimensions: ["orders.ship_region"], order_by: [{ field: "orders.ship_region" }] });

  test("writes a valid draft golden with the request, prints the compiled SQL and stores none", async () => {
    const t = copyAcme();
    const r = await sl(t.root, ["goldens", "new", "--name", "revenue_by_ship_region", "--question", "What was revenue by ship region?", "--request", request, "--role", "analyst", "--user", '{"department":"analytics"}']);
    expect(r.code).toBe(0);
    const path = join(t.root, "goldens", "revenue_by_ship_region.yaml");
    expect(r.out).toStartWith("Wrote goldens/revenue_by_ship_region.yaml, a draft golden.");
    const sql = await sl(t.root, ["sql", "--request", path, "--json"]);
    const compiled = sql.json<{ sql: string }>().sql;
    expect(r.out).toContain(compiled);
    // The next step is the confirm flow, which needs the owner's recorded yes (3.3a): readback, reply, then confirm.
    expect(r.out).toContain(
      "Run sl goldens run --name revenue_by_ship_region to see its rows; once its measures are approved, confirm it on the owner's yes: " +
        "sl readback --targets golden:revenue_by_ship_region --tolerance <agreed tolerance>, read it to the owner, record their answer with sl reply",
    );
    const g = readYaml<Golden>(path);
    expect(g).toEqual({
      name: "revenue_by_ship_region",
      question: "What was revenue by ship region?",
      role: "analyst",
      user: { department: "analytics" },
      request: JSON.parse(request),
      status: "draft",
    });
    expect(validateProject(t.root).filter((i) => i.file === "goldens/revenue_by_ship_region.yaml")).toEqual([]);

    // The same inputs write the same file in another root.
    const u = copyAcme();
    const json = await sl(u.root, ["goldens", "new", "--name", "revenue_by_ship_region", "--question", "What was revenue by ship region?", "--request", request, "--role", "analyst", "--user", '{"department":"analytics"}', "--json"]);
    expect(readFileSync(join(u.root, "goldens", "revenue_by_ship_region.yaml"), "utf8")).toBe(readFileSync(path, "utf8"));
    expect(json.json()).toMatchObject({ name: "revenue_by_ship_region", path: "goldens/revenue_by_ship_region.yaml", written: true, status: "draft", compiled: true, sql: compiled, params: [] });

    // An existing name is refused and the file is kept.
    const again = await sl(t.root, ["goldens", "new", "--name", "revenue_by_ship_region", "--question", "Other?", "--request", request]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('Golden "revenue_by_ship_region" already exists (goldens/revenue_by_ship_region.yaml)');
    expect(readYaml<Golden>(path).question).toBe("What was revenue by ship region?");
  });

  test("a request from a file, with --source; a request that does not compile yet is written and says why", async () => {
    const t = copyAcme();
    const file = join(t.dir, "req.yaml");
    writeFileSync(file, "measures: [customers.new_customers]\n");
    const r = await sl(t.root, ["goldens", "new", "--name", "new_customers_q1", "--question", "How many new customers in Q1?", "--request", file, "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    const doc = r.json<{ compiled: boolean; refused: { reason: string; next: string }; next: string }>();
    expect(doc.compiled).toBe(false);
    expect(doc.refused.reason).toContain("customers.new_customers");
    expect(doc.next).toContain("sl goldens run --name new_customers_q1");
    // A golden without expected rows is rechecked with goldens run: goldens check refuses it.
    expect(doc.refused.next).toEndWith("then run sl goldens run --name new_customers_q1.");
    expect(doc.refused.next).not.toContain("goldens check");
    expect(readYaml<Golden>(join(t.root, "goldens", "new_customers_q1.yaml")).request).toEqual({ measures: ["customers.new_customers"], source: "warehouse" });
  });

  test("refuses, writing nothing, an invalid request, an unknown source, role or user attribute, and a missing question", async () => {
    const t = copyAcme();
    const before = readdirSync(join(t.root, "goldens")).sort();
    const cases: [string[], string][] = [
      [["--request", '{"source":"warehouse","metrics":["net_revenue"]}'], "there is no metrics key"],
      [["--request", '{"source":"nowhere","measures":["orders.revenue"]}'], 'Unknown source "nowhere"'],
      [["--request", request, "--role", "auditor"], "--role auditor is not a role in access.yaml"],
      [["--request", request, "--user", '{"team":"x"}'], "--user names team, which access.yaml does not declare"],
      [["--request", "not json"], "--request: no file not json"],
      [["--request", request, "--user", "[1]"], "--user must be a JSON object"],
      [["--request", request, "--source", "lake"], "The request is on source warehouse, not lake"],
      // sl validate would error on it once written: measures of two models.
      [["--request", '{"source":"warehouse","measures":["orders.revenue","refunds.refund_amount"]}'], "a request's measures must share one model, or be one metric"],
    ];
    for (const [args, message] of cases) {
      const r = await sl(t.root, ["goldens", "new", "--name", "nope", "--question", "Q?", ...args]);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.err).toContain(message);
    }
    const noQuestion = await sl(t.root, ["goldens", "new", "--name", "nope", "--request", request]);
    expect(noQuestion.err).toContain('goldens new needs --question "<the question in plain English>".');
    const badName = await sl(t.root, ["goldens", "new", "--name", "../nope", "--question", "Q?", "--request", request]);
    expect(badName.err).toContain("not a golden name");
    expect(readdirSync(join(t.root, "goldens")).sort()).toEqual(before);
    // A name a .yml file holds is taken too.
    writeFileSync(join(t.root, "goldens", "nope.yml"), "name: nope\nquestion: Q?\nrequest:\n  source: warehouse\n  measures: [orders.revenue]\nstatus: draft\n");
    const yml = await sl(t.root, ["goldens", "new", "--name", "nope", "--question", "Q?", "--request", request]);
    expect(yml.code).toBe(1);
    expect(yml.err).toContain('Golden "nope" already exists (goldens/nope.yml)');
    expect(existsSync(join(t.root, "goldens", "nope.yaml"))).toBe(false);
  });

  test("a new draft golden runs: its preview compiles its draft fields as approved", async () => {
    const { root } = await duckdbAcme();
    const r = await sl(root, ["goldens", "new", "--name", "revenue_by_ship_region", "--question", "Revenue by ship region?", "--request", request]);
    expect(r.code).toBe(0);
    const run = await sl(root, ["goldens", "run", "--name", "revenue_by_ship_region", "--json"]);
    expect(run.code).toBe(0);
    const ran = run.json<{ compiled: boolean; columns: string[]; rows: unknown[] }>();
    expect(ran.compiled).toBe(true);
    expect(ran.columns).toEqual(["ship_region", "revenue"]);
    expect(ran.rows.length).toBeGreaterThan(1);
  }, 60_000);
});

describe("goldens on postgres", () => {
  test.skipIf(!PG_URL)("filter values stay one value each: a quote and a backslash in text, a number against a text column", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("goldens_pg");
    const admin = new SQL({ url: PG_URL!, max: 1 });
    await admin.unsafe(
      `create schema ${schema}; create table ${schema}.orders (id int, region text, code text, amount numeric(10,2)); ` +
        `insert into ${schema}.orders values (1, 'east', '7', 100), (2, E'a\\\\''b', '8', 50.5), (3, 'west', '7', 200);`,
    );
    try {
      const t = tempRoot();
      cleanups.push(t.cleanup);
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres", connection: { env: "WH_URL" } });
      const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-15" };
      writeYaml(join(t.root, "models", "wh", "orders.yaml"), {
        model: "orders",
        source: "wh",
        table: `${schema}.orders`,
        ...ok,
        primary_key: ["id"],
        dimensions: [
          { name: "region", expr: "region", type: "string", ...ok },
          { name: "code", expr: "code", type: "string", ...ok },
        ],
        measures: [{ name: "revenue", expr: "amount", agg: "sum", description: "Revenue.", ...ok }],
        joins: [],
      });
      const env = { WH_URL: PG_URL! };
      const cases: [string, string, unknown, unknown][] = [
        ["q1", "orders.region", "a\\'b", 50.5],
        ["q2", "orders.region", "x\\' or 1=1 --", null],
        ["q3", "orders.code", 7, 300],
      ];
      for (const [name, field, value, want] of cases) {
        const req = JSON.stringify({ source: "wh", measures: ["orders.revenue"], filters: [{ field, op: "eq", value }] });
        expect((await sl(t.root, ["goldens", "new", "--name", name, "--question", "Q?", "--request", req], env)).code).toBe(0);
        const r = await sl(t.root, ["goldens", "run", "--name", name, "--json"], env);
        expect({ name, code: r.code, err: r.code ? r.err : "" }).toEqual({ name, code: 0, err: "" });
        expect(r.json<{ rows: { revenue: unknown }[] }>().rows).toEqual([{ revenue: want }]);
      }
    } finally {
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.close();
    }
  }, 60_000);
});

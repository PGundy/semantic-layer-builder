// FR-1.7: a catalog of 50,000 tables and 1,000,000 columns. Runs only with SL_PERF=1
// (`bun run perf`): it builds the synthetic catalog once per generator version, caches it under
// the system temp directory (SL_PERF_CACHE overrides), and runs each command as its own process.
// The live Postgres case also needs PG_URL; its 50,000 tables are created once in schemas named
// for the generator version and kept for the next run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, initProject, PG_URL, tempRoot } from "../helpers.ts";
import { cachedCsv, cachedDuckDb, catalogTables, ensurePgCatalog, SCHEMAS } from "./catalog.ts";
import { ok, report, tableListText, type Timed, timedSl } from "./harness.ts";

const PERF = process.env.SL_PERF === "1";
const TABLES = 50_000;
// FR-1.7 budgets: import or introspect plus scope preview under 20 s, each process under 2 GB.
const PREVIEW_BUDGET_MS = 20_000;
const MEMORY_BUDGET = 2 * 1024 ** 3;
// The baseline brief and the other read commands on the full catalog.
const BASELINE_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 10_000;
const STEP_TIMEOUT = 600_000;

const SCOPE = {
  include: ["fct_*", "dim_*", "re:rpt_(orders|payments|invoices)_\\d{5}"],
  exclude: ["re:.*_(19|20)\\d{2}", "*_tmp", "archive.*"],
  tables_file: "scope/wh.txt",
};

function within(r: Timed, budgetMs: number): void {
  expect(r.ms).toBeLessThan(budgetMs);
  expect(r.maxRss).toBeLessThan(MEMORY_BUDGET);
}

async function project(source: Record<string, unknown>): Promise<{ root: string; cleanup: () => void }> {
  const t = tempRoot();
  await initProject(t.root);
  mkdirSync(join(t.root, "scope"), { recursive: true });
  writeFileSync(join(t.root, "scope", "wh.txt"), tableListText(500));
  writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", ...source, scope: SCOPE });
  return { root: t.root, cleanup: t.cleanup };
}

describe.skipIf(!PERF)("50,000 tables and 1,000,000 columns", () => {
  let csv = "";
  let root = "";
  let cleanup: (() => void) | undefined;
  beforeAll(async () => {
    csv = await cachedCsv(TABLES);
    ({ root, cleanup } = await project({ dialect: "postgres", intake: { mode: "export", reason: "perf suite", schemas: [...SCHEMAS] } }));
  }, STEP_TIMEOUT);
  afterAll(() => cleanup?.());

  test(
    "import plus scope preview finish under 20 s and 2 GB",
    async () => {
      const imported = ok(await timedSl(root, ["import", "--source", "wh", "--file", csv, "--json"]), "sl import");
      report("import (first)", imported);
      const j = JSON.parse(imported.out) as { tables: number; columns: number };
      expect(j.tables).toBe(TABLES);
      expect(j.columns).toBe(TABLES * 20);
      const preview = ok(await timedSl(root, ["scope", "--source", "wh"]), "sl scope");
      report("scope preview", preview);
      expect(preview.out).toContain(`of ${TABLES} (was`);
      console.log(`perf: import + scope preview total ${((imported.ms + preview.ms) / 1000).toFixed(2)} s`);
      within(imported, PREVIEW_BUDGET_MS);
      within(preview, PREVIEW_BUDGET_MS);
      expect(imported.ms + preview.ms).toBeLessThan(PREVIEW_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );

  test(
    "a second import of the same file, which diffs against the saved snapshot, stays in budget",
    async () => {
      const again = ok(await timedSl(root, ["import", "--source", "wh", "--file", csv, "--json"]), "sl import again");
      report("import (diff against previous)", again);
      within(again, PREVIEW_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );

  test(
    "scope --json, scope --explain, tables --groups and status read the full catalog in budget",
    async () => {
      const json = ok(await timedSl(root, ["scope", "--source", "wh", "--json"]), "sl scope --json");
      report("scope --json", json);
      const entries = (JSON.parse(json.out) as { entries: unknown[] }).entries;
      expect(entries.length).toBeGreaterThan(400);
      const first = catalogTables(1).next().value!;
      const explain = ok(await timedSl(root, ["scope", "--source", "wh", "--explain", `${first.schema}.${first.name}`]), "sl scope --explain");
      report("scope --explain", explain);
      const groups = ok(await timedSl(root, ["tables", "--source", "wh", "--groups", "--json"]), "sl tables --groups");
      report("tables --groups", groups);
      const status = ok(await timedSl(root, ["status", "--json"]), "sl status");
      report("status", status);
      for (const r of [json, explain, groups, status]) within(r, READ_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );

  test(
    "the baseline brief finishes in budget",
    async () => {
      const brief = ok(await timedSl(root, ["baseline", "--source", "wh", "--out", "baseline.md"]), "sl baseline");
      report("baseline brief", brief);
      within(brief, BASELINE_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(!PERF)("introspect 50,000 tables from DuckDB", () => {
  test(
    "introspect plus scope preview finish under 20 s and 2 GB",
    async () => {
      const db = await cachedDuckDb(TABLES);
      const { root, cleanup } = await project({ dialect: "duckdb", connection: { database: db }, intake: { schemas: [...SCHEMAS] } });
      try {
        const introspected = ok(await timedSl(root, ["introspect", "--source", "wh", "--json"]), "sl introspect");
        report("introspect duckdb", introspected);
        const j = JSON.parse(introspected.out) as { tables: number; columns: number };
        expect(j.tables).toBe(TABLES);
        expect(j.columns).toBe(TABLES * 20);
        const preview = ok(await timedSl(root, ["scope", "--source", "wh"]), "sl scope");
        report("scope preview", preview);
        // DuckDB itself takes about 1.4 GB of the 2 GB to open a 50,000-table database.
        within(introspected, PREVIEW_BUDGET_MS);
        within(preview, PREVIEW_BUDGET_MS);
        expect(introspected.ms + preview.ms).toBeLessThan(PREVIEW_BUDGET_MS);
      } finally {
        cleanup();
      }
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(!PERF || !PG_URL)("introspect 50,000 tables from a local Postgres", () => {
  test(
    "introspect plus scope preview finish under 20 s and 2 GB",
    async () => {
      assertLocalPg(PG_URL);
      const created = performance.now();
      const { schemas, reused } = await ensurePgCatalog(PG_URL!, TABLES);
      console.log(`perf: postgres catalog ${reused ? "reused" : `created in ${((performance.now() - created) / 1000).toFixed(1)} s`}`);
      const { root, cleanup } = await project({ dialect: "postgres", connection: { env: "SL_PERF_PG_URL" }, intake: { schemas } });
      try {
        const env = { SL_PERF_PG_URL: PG_URL! };
        const introspected = ok(await timedSl(root, ["introspect", "--source", "wh", "--json"], env), "sl introspect");
        report("introspect postgres", introspected);
        const j = JSON.parse(introspected.out) as { tables: number; columns: number };
        expect(j.tables).toBe(TABLES);
        expect(j.columns).toBe(TABLES * 20);
        const preview = ok(await timedSl(root, ["scope", "--source", "wh"]), "sl scope");
        report("scope preview", preview);
        console.log(`perf: introspect + scope preview total ${((introspected.ms + preview.ms) / 1000).toFixed(2)} s`);
        within(introspected, PREVIEW_BUDGET_MS);
        expect(introspected.ms + preview.ms).toBeLessThan(PREVIEW_BUDGET_MS);
      } finally {
        cleanup();
      }
    },
    STEP_TIMEOUT,
  );
});

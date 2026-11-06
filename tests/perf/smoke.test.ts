// The quick performance check in the normal suite: a synthetic catalog of 5,000 tables and
// 100,000 columns imported and previewed by the CLI as its own process, with a bound generous
// enough for a slow CI machine. The full 50,000-table suite is large-catalog.test.ts
// (`bun run perf`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { FIXED_NOW, initProject, tempRoot } from "../helpers.ts";
import { SCHEMAS, writeInformationSchemaCsv } from "./catalog.ts";
import { ok, report, SL, tableListText, timedSl } from "./harness.ts";

const TABLES = 5_000;
const BUDGET_MS = 15_000;

let root = "";
let csv = "";
let cleanup: (() => void) | undefined;

beforeAll(async () => {
  const t = tempRoot();
  cleanup = t.cleanup;
  root = t.root;
  await initProject(root);
  csv = join(t.dir, "catalog.csv");
  await writeInformationSchemaCsv(csv, TABLES);
  mkdirSync(join(root, "scope"), { recursive: true });
  writeFileSync(join(root, "scope", "wh.txt"), tableListText(500));
  writeYaml(join(root, "sources", "wh.yaml"), {
    source: "wh",
    dialect: "postgres",
    intake: { mode: "export", reason: "perf suite", schemas: [...SCHEMAS] },
    scope: { include: ["fct_*", "dim_*"], exclude: ["re:.*_(19|20)\\d{2}"], tables_file: "scope/wh.txt" },
  });
});
afterAll(() => cleanup?.());

describe("5,000 tables", () => {
  test("import plus scope preview stay within a generous bound", async () => {
    const imported = ok(await timedSl(root, ["import", "--source", "wh", "--file", csv, "--json"]), "sl import");
    report("smoke: import 5,000 tables", imported);
    const j = JSON.parse(imported.out) as { tables: number; columns: number };
    expect(j).toMatchObject({ tables: TABLES, columns: TABLES * 20 });
    const preview = ok(await timedSl(root, ["scope", "--source", "wh"]), "sl scope");
    report("smoke: scope preview", preview);
    expect(preview.out).toContain(`of ${TABLES} (was`);
    expect(imported.ms + preview.ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  test("a large --json result reaches a reader that starts late, whole", async () => {
    const proc = Bun.spawn(["bun", SL, "scope", "--source", "wh", "--json", "--root", root], {
      cwd: root,
      env: { ...process.env, SL_NOW: FIXED_NOW },
      stdout: "pipe",
      stderr: "pipe",
    });
    // The reader waits, so the pipe fills and the CLI has output left to write when it finishes.
    await Bun.sleep(500);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(128 * 1024);
    const j = JSON.parse(out) as { entries: unknown[]; tables: unknown[] };
    expect(j.entries.length).toBeGreaterThan(400);
    expect(j.tables.length).toBeGreaterThan(0);
  }, 60_000);
});

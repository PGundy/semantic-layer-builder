// HR-11: validation and typed edits on a large layer, 870 models over a 5,000-table catalog. Runs
// only with SL_PERF=1 (`bun run perf`), each command as its own process: sl validate under 5 s, one
// typed edit under 8 s, and a batch of edits through sl apply under the same 8 s.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, tempRoot } from "../helpers.ts";
import { SCHEMAS, writeInformationSchemaCsv } from "./catalog.ts";
import { ok, report, timedSl } from "./harness.ts";
import { firstModel, writeLayer } from "./layer.ts";

const PERF = process.env.SL_PERF === "1";
const TABLES = 5_000;
const MODELS = 870;
const VALIDATE_BUDGET_MS = 5_000;
const EDIT_BUDGET_MS = 8_000;
const STEP_TIMEOUT = 600_000;

describe.skipIf(!PERF)("870 models over 5,000 tables", () => {
  let root = "";
  let dir = "";
  let cleanup: (() => void) | undefined;
  const model = firstModel(TABLES);
  beforeAll(async () => {
    const t = tempRoot();
    ({ root, dir, cleanup } = t);
    await initProject(root);
    const csv = join(dir, "catalog.csv");
    await writeInformationSchemaCsv(csv, TABLES);
    writeYaml(join(root, "sources", "wh.yaml"), { source: "wh", dialect: "postgres", intake: { mode: "export", reason: "perf suite", schemas: [...SCHEMAS] } });
    ok(await timedSl(root, ["import", "--source", "wh", "--file", csv, "--json"]), "sl import");
    writeLayer(root, "wh", MODELS, TABLES);
  }, STEP_TIMEOUT);
  afterAll(() => cleanup?.());

  test(
    "sl validate finishes under 5 s with no error",
    async () => {
      const r = await timedSl(root, ["validate", "--json"]);
      report("validate (870 models)", r);
      const issues = (JSON.parse(r.out) as { issues: { level: string; file: string; message: string }[] }).issues;
      expect(issues.filter((i) => i.level === "error")).toEqual([]);
      expect(r.ms).toBeLessThan(VALIDATE_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );

  test(
    "a typed edit finishes under 8 s",
    async () => {
      const r = ok(await timedSl(root, ["set", `wh.${model}.row_count`, "description", "Number of rows, every one."]), "sl set");
      report("typed edit (sl set)", r);
      expect(r.ms).toBeLessThan(EDIT_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );

  test(
    "a batch of twelve edits through sl apply finishes under 8 s",
    async () => {
      const edits = Array.from({ length: 12 }, (_, i) => ["set", `wh.${model}.created_at`, "description", `When the row was created (${i}).`]);
      const file = join(dir, "edits.json");
      writeFileSync(file, JSON.stringify({ edits }));
      const r = ok(await timedSl(root, ["apply", "--file", file]), "sl apply");
      report("sl apply (12 edits)", r);
      expect(r.ms).toBeLessThan(EDIT_BUDGET_MS);
    },
    STEP_TIMEOUT,
  );
});

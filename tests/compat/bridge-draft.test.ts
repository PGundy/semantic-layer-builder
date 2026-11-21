// The draft proposes the bridge join on a live server (spec: Bridges and multi-fact requests), on
// whatever server PG_URL names; the CI `compat` job runs it once per supported major version.
// fixtures/semantics/bridge.sql is loaded into a unique schema and drafted: orders reach tags through
// order_tags with no dedupe rule, semlayer validate passes it, check-join measures it, and
// semlayer next asks the owner how a figure is shared.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { Join, Model } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { walkToDedupeQuestion } from "../draft-bridge-walk.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_compat_bridge_draft");
const FIXTURE = readFileSync(join(import.meta.dir, "..", "..", "fixtures", "semantics", "bridge.sql"), "utf8");
let pg: SQL | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  pg = new SQL({ url: PG_URL, max: 1 });
  await pg.unsafe(`create schema ${schema}`);
  await pg.unsafe(`set search_path to ${schema}`);
  await pg.unsafe(FIXTURE);
  await pg.unsafe("set search_path to default");
}, 60_000);

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

describe("a drafted bridge join on postgres", () => {
  test.skipIf(!PG_URL)("orders.tag is drafted with no dedupe rule, validates, is measured by check-join and is asked about by next", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const root = t.root;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    const run = async (args: string[]) => {
      const r = await semlayer(root, args, env);
      if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${r.err}`);
      return r;
    };
    await initProject(root);
    await run(["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", schema, "--primary", schema]);
    await run(["draft", "--source", "warehouse", "--tables", `${schema}.orders,${schema}.tags,${schema}.order_tags`]);

    const orders = readYaml<Model>(join(root, "models", "warehouse", "orders.yaml"));
    const bridge = orders.joins!.filter((j) => j.through);
    expect(bridge.map((j) => [j.name, j.to, j.status, j.origin, j.through!.model, j.through!.dedupe])).toEqual([["tag", "tags", "draft", "inferred", "order_tags", undefined]]);
    expect(orders.open_questions!.at(-1)).toContain("semlayer add-bridge --source warehouse --model tags --name order --to orders --through order_tags");

    const v = (await run(["validate", "--json"])).json<{ issues: { level: string; code: string }[] }>();
    expect(v.issues.filter((i) => i.level === "error")).toEqual([]);

    const c = (await run(["check-join", "--source", "warehouse", "--model", "orders", "--join", "tag", "--json"])).json<{ checks: { evidence: NonNullable<Join["evidence"]> }[] }>();
    const ev = c.checks[0]!.evidence;
    expect(ev.left_rows).toBe(5);
    expect(ev.through).toMatchObject({ facts_one_value: 2, facts_many_values: 2, facts_unbridged: 1, duplicate_rows: 1 });

    expect(await walkToDedupeQuestion(root, env, { order_tags: "[order_id, tag_id]" })).toContain("how is its figure shared");
  }, 120_000);
});

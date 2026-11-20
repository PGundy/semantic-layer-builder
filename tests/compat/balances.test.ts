// A balance on a live server (spec: Metric semantics, Semi-additive measures), on whatever server
// PG_URL names; the CI `compat` job runs it once per supported major version. fixtures/semantics/
// balances.sql is loaded into a unique schema, the layer is built with typed commands, the balance
// is approved on the owner's yes and its golden is confirmed with semlayer goldens confirm. Every
// value is synthetic and each expected number is counted by hand in the fixture's header.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, confirmWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_balances");
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
  const script = readFileSync(join(import.meta.dir, "..", "..", "fixtures", "semantics", "balances.sql"), "utf8");
  await pg.unsafe(`create schema ${schema}; set search_path to ${schema}; ${script}; reset search_path`);
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

const ok = async (p: Promise<{ code: number; out: string; err: string }>) => {
  const r = await p;
  if (r.code !== 0) throw new Error(`${r.out}\n${r.err}`);
  return r;
};

describe("a balance on postgres", () => {
  test.skipIf(!PG_URL)("by month gives each month's closing balance, the golden is confirmed, and goldens check passes", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const root = t.root;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    const run = (args: string[]) => ok(semlayer(root, args, env));
    await initProject(root);
    await run(["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", schema, "--primary", schema]);
    await run(["draft", "--source", "pg"]);
    const model = `pg.balances`;
    await run(["set", model, "grain", "One row per account per day its balance was read."]);
    // The drafted sum of every row is the figure a balance must not be: it becomes the closing balance.
    await run(["rename", `${model}.balance`, "closing_balance"]);
    await run(["set", `${model}.closing_balance`, "description", "Balance at the end of the period."]);
    await run(["set", `${model}.closing_balance`, "currency", "USD"]);
    const set = await run(["set", `${model}.closing_balance`, "non_additive_dimension", "{name: snapshot_date, window: last}"]);
    expect(set.out).toContain("Set non_additive_dimension on pg.balances.closing_balance");

    expect((await approveWithYes(root, ["--target", model, "--recursive", "--by", "Test Owner"])).code).toBe(0);
    const sql = await run(["sql", "--source", "pg", "--request", JSON.stringify({ measures: ["balances.closing_balance"], dimensions: ["balances.snapshot_date:month"] })]);
    expect(sql.out).toContain("select distinct on (account_id, cast(date_trunc('month', snapshot_date) as date))");
    const request = JSON.stringify({ source: "pg", measures: ["balances.closing_balance"], dimensions: ["balances.snapshot_date:month"], order_by: [{ field: "balances.snapshot_date:month" }] });
    await run(["goldens", "new", "--name", "closing_by_month", "--question", "What was the closing balance each month?", "--request", request]);
    const confirmed = await confirmWithYes(root, ["--name", "closing_by_month", "--by", "Test Owner"], {}, env);
    expect(confirmed.code).toBe(0);
    const g = readYaml<Golden>(join(root, "goldens", "closing_by_month.yaml"));
    expect(g.status).toBe("approved");
    expect(g.expected!.rows.map((r) => [String(r.snapshot_date_month).slice(0, 10), Number(r.closing_balance)])).toEqual([
      ["2024-01-01", 1220],
      ["2024-02-01", 1500],
    ]);
    expect((await semlayer(root, ["goldens", "check", "--name", "closing_by_month"], env)).code).toBe(0);
  }, 30_000);
});

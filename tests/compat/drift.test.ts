// The drift record on a live server (spec: Iterating a layer, The drift record), on whatever server
// PG_URL names; the CI `compat` job runs it once per supported major version. The Acme warehouse is
// loaded into a unique schema, a small layer is approved with typed commands, fixtures/acme/evolve-retype.sql
// retypes fct_orders.amount_cents and drops shipping_cents, and semlayer introspect records both.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgres } from "../../fixtures/acme/load-postgres.ts";
import { approveWithYes, assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const ACME = join(import.meta.dir, "..", "..", "fixtures", "acme");
const schema = uniqueSchema("t_compat_drift");
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  await loadPostgres(PG_URL, join(ACME, "data"), schema);
}, 30000);

afterAll(async () => {
  if (!PG_URL) return;
  const pg = new SQL({ url: PG_URL, max: 1 });
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

interface Issue {
  level: string;
  file: string;
  path: string;
  message: string;
  code: string;
}

describe("the drift record on postgres", () => {
  test.skipIf(!PG_URL)("a retyped and a dropped column are recorded, and the approved field reading amount_cents is warned", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const root = t.root;
    const env = { SEMLAYER_TEST_PG: PG_URL! };
    await initProject(root);
    expect((await semlayer(root, ["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", schema], env)).code).toBe(0);
    const drafted = await semlayer(root, ["draft", "--source", "pg", "--tables", `${schema}.fct_orders`, "--json"], env);
    expect(drafted.code).toBe(0);
    const model = drafted.json<{ drafted: { model: string }[] }>().drafted[0]!.model;
    const add = ["add-field", `pg.${model}`, "--kind", "measure", "--name", "revenue", "--agg", "sum", "--expr", "amount_cents / 100.0", "--description", "Order value in dollars."];
    expect((await semlayer(root, add, env)).code).toBe(0);
    expect((await approveWithYes(root, ["--target", `pg.${model}.revenue`, "--by", "Dana"])).code).toBe(0);

    const pg = new SQL({ url: PG_URL!, max: 1 });
    try {
      // The file names no schema: it runs through the search path.
      await pg.begin(async (tx) => {
        await tx.unsafe(`set local search_path to ${schema}`);
        await tx.unsafe(readFileSync(join(ACME, "evolve-retype.sql"), "utf8").replace(/^\s*(begin|commit);\s*$/gm, ""));
      });
    } finally {
      await pg.close();
    }

    expect((await semlayer(root, ["introspect", "--source", "pg"], env)).code).toBe(0);
    const record = JSON.parse(readFileSync(join(root, ".semlayer", "drift.json"), "utf8")) as {
      sources: { source: string; diff: { columns: { table: string; removed: string[]; retyped: { name: string; from: string; to: string }[] }[] }; retyped: unknown[] }[];
    };
    const entry = record.sources.find((s) => s.source === "pg")!;
    const orders = entry.diff.columns.find((c) => c.table === `${schema}.fct_orders`)!;
    expect(orders.removed).toEqual(["shipping_cents"]);
    expect(orders.retyped).toEqual([{ name: "amount_cents", from: "integer", to: "numeric(12,2)" }]);
    expect(entry.retyped).toEqual([
      expect.objectContaining({ table: `${schema}.fct_orders`, column: "amount_cents", from: "integer", to: "numeric(12,2)", reads: [expect.objectContaining({ ref: `pg.${model}.revenue` })] }),
    ]);

    const issues = (await semlayer(root, ["validate", "--json"], env)).json<{ issues: Issue[] }>().issues.filter((i) => i.code === "release.column_retyped");
    expect(issues).toEqual([
      expect.objectContaining({
        level: "warning",
        file: `models/pg/${model}.yaml`,
        message: expect.stringContaining(`pg.${model}.revenue reads ${schema}.fct_orders.amount_cents, which changed from integer to numeric(12,2)`),
      }),
    ]);
  }, 30000);
});

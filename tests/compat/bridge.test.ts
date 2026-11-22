// A golden grouped through a bridge join on a live server (spec: Bridges and multi-fact requests), on
// whatever server PG_URL names; the CI `compat` job runs it once per supported major version.
// fixtures/semantics/bridge.sql is loaded into a unique schema, a small layer of orders, tags and the
// order_tags bridge is drafted and approved with typed commands, the bridge join is measured and read
// back, and a revenue-by-tag golden is confirmed with semlayer goldens confirm. Its figures equal the
// hand-computed ones and a hand-written query's.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, confirmWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_compat_bridge");
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

type Row = Record<string, unknown>;

describe("a by-tag golden on postgres", () => {
  test.skipIf(!PG_URL)("revenue by tag through the bridge is confirmed: each order counts once per tag, never once per bridge row", async () => {
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
    // The draft's guessed joins from order_tags leave the layer, which reads the bridge only through orders.tag.
    for (const name of ["order", "tag"]) await run(["remove-join", "--source", "warehouse", "--model", "order_tags", "--name", name]);
    // The draft also proposed orders.tag with no dedupe rule; it is replaced by the join add-bridge writes with the owner's rule.
    await run(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "tag"]);
    await run([
      "add-bridge", "--source", "warehouse", "--model", "orders", "--name", "tag", "--to", "tags", "--through", "order_tags",
      "--keys", "order_id=order_id", "--through-keys", "tag_id=tag_id", "--dedupe", "distinct_pairs",
    ]);
    await run(["check-join", "--source", "warehouse", "--model", "orders", "--join", "tag"]);
    const edits = join(t.dir, "edits.json");
    writeFileSync(
      edits,
      JSON.stringify({
        edits: [
          ["set", "warehouse.orders", "grain", "One row per order."],
          ["set", "warehouse.tags", "grain", "One row per tag."],
          ["set", "warehouse.order_tags", "grain", "One row per order and tag, a pair sometimes listed twice."],
          ["set", "warehouse.order_tags", "primary_key", "[order_id, tag_id]"],
          ["set", "warehouse.orders.amount", "description", "The order value in US dollars, amount_cents divided by 100."],
          ["set", "warehouse.orders.amount", "currency", "USD"],
          ["set", "warehouse.tags.tag_name", "description", "The tag's name."],
          ["set", "warehouse.orders.tag", "description", "The tags of each order, through order_tags."],
        ],
      }),
    );
    await run(["apply", "--file", edits]);
    const ready = await semlayer(root, ["validate", "--json"], env);
    const errors = ready.json<{ issues: { level: string; message: string }[] }>().issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
    for (const target of ["warehouse.orders", "warehouse.orders.amount", "warehouse.tags", "warehouse.tags.tag_name", "warehouse.order_tags", "warehouse.orders.tag"]) {
      const r = await approveWithYes(root, ["--target", target, "--by", "Dana Ruiz"]);
      expect({ target, code: r.code, err: r.err }).toEqual({ target, code: 0, err: "" });
    }

    const sql = (await run(["sql", "--source", "warehouse", "--request", JSON.stringify({ source: "warehouse", measures: ["orders.amount"], dimensions: ["tags.tag_name"] })])).out;
    expect(sql).toContain(`group by "orders.tag bridge"."order_id", "orders.tag bridge"."tag_id"`);

    const name = "revenue_by_tag";
    const request = { source: "warehouse", measures: ["orders.amount"], dimensions: ["tags.tag_name"], order_by: [{ field: "tags.tag_name" }] };
    await run(["goldens", "new", "--name", name, "--question", "What was order revenue by tag?", "--request", JSON.stringify(request)]);
    const rb = await run(["readback", "--targets", `golden:${name}`]);
    expect(rb.out).toContain("Totals by tag can add up to more than the overall total");
    const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Dana Ruiz"], {}, env);
    if (confirmed.code !== 0) throw new Error(confirmed.err);
    const golden = readYaml<Golden>(join(root, "goldens", `${name}.yaml`));
    expect(golden.status).toBe("approved");
    const rows = (golden.expected!.rows as Row[]).map((r) => [r.tag_name, Number(r.amount)]);
    // Worked out by hand from bridge.sql: gift orders 1, 2 and 5 (listed twice, counted once), rush 1
    // and 2, wholesale 2 and 3, and order 4, with no tag, under an empty tag.
    expect(rows).toEqual([
      ["gift", 35],
      ["rush", 30],
      ["wholesale", 50],
      [null, 40],
    ]);
    const hand = (await pg!.unsafe(
      `select t.tag_name, sum(o.amount_cents / 100.0)::float8 as v from ${schema}.tags t join ${schema}.orders o
         on exists (select 1 from ${schema}.order_tags b where b.order_id = o.order_id and b.tag_id = t.tag_id)
       group by 1
       union all select null, sum(amount_cents / 100.0)::float8 from ${schema}.orders o where not exists (select 1 from ${schema}.order_tags b where b.order_id = o.order_id)
       order by 1 nulls last`,
    )) as { tag_name: string | null; v: number }[];
    expect(hand.map((h) => [h.tag_name, h.v] as unknown[])).toEqual(rows);
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
  });
});

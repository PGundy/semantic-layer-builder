// Conformed dimensions on a live server (spec: Bridges and multi-fact requests), on whatever server PG_URL
// names; the CI `compat` job runs it once per supported major version. fixtures/semantics/conformed.sql is
// loaded into a unique schema; a small layer of orders and refunds is drafted with typed commands, semlayer
// conform declares refunds.refunded_on the same as orders.order_date and refunds.region_code the same as
// orders.ship_region, and goldens by month and by region are confirmed with semlayer goldens confirm. Each
// figure equals the hand-counted one in the fixture's header and a hand-written query's, a month or a
// region only one of the two has included.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, confirmWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_compat_conformed");
const FIXTURE = readFileSync(join(import.meta.dir, "..", "..", "fixtures", "semantics", "conformed.sql"), "utf8");
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
const num = (v: unknown) => (v === null ? null : Number(v));
const key = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

describe("conformed dimensions on postgres", () => {
  test.skipIf(!PG_URL)("orders and refunds by month and by region group on the dimensions the owner declared the same", async () => {
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
    await run(["draft", "--source", "warehouse", "--tables", `${schema}.orders,${schema}.refunds`]);
    await run(["conform", "--source", "warehouse", "--dimension", "refunds.refunded_on", "--to", "orders.order_date"]);
    const edits = join(t.dir, "edits.json");
    writeFileSync(
      edits,
      JSON.stringify({
        edits: [
          ["conform", "--source", "warehouse", "--dimension", "refunds.region_code", "--to", "orders.ship_region"],
          ["set", "warehouse.orders", "grain", "One row per order."],
          ["set", "warehouse.refunds", "grain", "One row per refund."],
          ["set", "warehouse.orders.amount", "description", "The order value in US dollars, amount_cents divided by 100."],
          ["set", "warehouse.orders.amount", "currency", "USD"],
          ["set", "warehouse.refunds.refunded", "description", "The refunded value in US dollars, refunded_cents divided by 100."],
          ["set", "warehouse.refunds.refunded", "currency", "USD"],
        ],
      }),
    );
    await run(["apply", "--file", edits]);
    const rb = await run(["readback", "--targets", "warehouse.refunds.refunded_on"]);
    expect(rb.out).toContain("Treated as the same as orders.order_date when a question combines refunds with orders");
    const errors = (await semlayer(root, ["validate", "--json"], env)).json<{ issues: { level: string; message: string }[] }>().issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
    const targets = ["orders", "orders.order_date", "orders.ship_region", "orders.amount", "refunds", "refunds.refunded_on", "refunds.region_code", "refunds.refunded"].map((x) => `warehouse.${x}`);
    for (const target of targets) {
      const r = await approveWithYes(root, ["--target", target, "--by", "Dana Ruiz"]);
      expect({ target, code: r.code, err: r.err }).toEqual({ target, code: 0, err: "" });
    }

    const byMonth = { source: "warehouse", measures: ["orders.amount", "refunds.refunded"], dimensions: ["orders.order_date:month"], order_by: [{ field: "orders.order_date:month" }] };
    const sql = (await run(["sql", "--source", "warehouse", "--request", JSON.stringify(byMonth)])).out;
    expect(sql).toContain(`"refunds measures" ("order_date_month", "refunded") as (`);
    expect(sql).toContain(`date_trunc('month', refunded_on)`);

    const confirm = async (name: string, question: string, request: object) => {
      await run(["goldens", "new", "--name", name, "--question", question, "--request", JSON.stringify(request)]);
      const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Dana Ruiz"], {}, env);
      if (confirmed.code !== 0) throw new Error(confirmed.err);
      const golden = readYaml<Golden>(join(root, "goldens", `${name}.yaml`));
      expect(golden.status).toBe("approved");
      return golden.expected!.rows as Row[];
    };

    // By month, written as the request names it: refunds group by the month they were issued.
    const months = await confirm("orders_refunds_by_month", "What were order amounts and refunds by month?", byMonth);
    expect(Object.keys(months[0]!)).toEqual(["order_date_month", "amount", "refunded"]);
    expect(months.map((r) => [key(r.order_date_month), num(r.amount), num(r.refunded)])).toEqual([
      ["2025-01-01", 30, 2],
      ["2025-02-01", 30, 4],
      ["2025-03-01", 5, null],
      ["2025-04-01", null, 4],
    ]);
    const hand = async (text: string) => new Map(((await pg!.unsafe(text)) as { k: unknown; v: string }[]).map((x) => [key(x.k), Number(x.v)]));
    const orderMonths = await hand(`select date_trunc('month', order_date)::date as k, sum(amount_cents / 100.0) as v from ${schema}.orders group by 1`);
    const refundMonths = await hand(`select date_trunc('month', refunded_on)::date as k, sum(refunded_cents / 100.0) as v from ${schema}.refunds group by 1`);
    for (const r of months) expect([num(r.amount), num(r.refunded)]).toEqual([orderMonths.get(key(r.order_date_month)) ?? null, refundMonths.get(key(r.order_date_month)) ?? null]);

    // By region, named from the refunds side: orders group by ship_region under the name region_code.
    const regions = await confirm("orders_refunds_by_region", "What were order amounts and refunds by region?", {
      source: "warehouse",
      measures: ["orders.amount", "refunds.refunded"],
      dimensions: ["refunds.region_code"],
      order_by: [{ field: "refunds.region_code" }],
    });
    expect(regions.map((r) => [r.region_code, num(r.amount), num(r.refunded)])).toEqual([
      ["east", 40, 3],
      ["north", 5, null],
      ["south", null, 4],
      ["west", 20, 3],
    ]);
    const orderRegions = await hand(`select ship_region as k, sum(amount_cents / 100.0) as v from ${schema}.orders group by 1`);
    const refundRegions = await hand(`select region_code as k, sum(refunded_cents / 100.0) as v from ${schema}.refunds group by 1`);
    for (const r of regions) expect([num(r.amount), num(r.refunded)]).toEqual([orderRegions.get(String(r.region_code)) ?? null, refundRegions.get(String(r.region_code)) ?? null]);
    // Neither total is dropped or multiplied: each adds up to its table's total.
    const total = (rows: Row[], col: string) => rows.reduce((s, r) => s + (num(r[col]) ?? 0), 0);
    expect([total(months, "amount"), total(months, "refunded"), total(regions, "amount"), total(regions, "refunded")]).toEqual([65, 10, 65, 10]);
    expect((await semlayer(root, ["goldens", "check", "--name", "orders_refunds_by_region"], env)).code).toBe(0);
  });
});

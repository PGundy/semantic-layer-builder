// A multi-fact golden on a live server (spec: Bridges and multi-fact requests), on whatever server PG_URL
// names; the CI `compat` job runs it once per supported major version. The Acme warehouse is loaded
// into a unique schema, a small layer of orders and refunds is drafted and approved with typed commands,
// and the orders-and-refunds-by-month golden is confirmed with semlayer goldens confirm.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { loadPostgres } from "../../fixtures/acme/load-postgres.ts";
import type { Golden } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, assertLocalPg, confirmWithYes, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_compat_multifact");
const DATA = join(import.meta.dir, "..", "..", "fixtures", "acme", "data");
let pg: SQL | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  await loadPostgres(PG_URL, DATA, schema);
  pg = new SQL({ url: PG_URL, max: 1 });
}, 60_000);

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null ? null : Number(v));

describe("a multi-fact golden on postgres", () => {
  test.skipIf(!PG_URL)("orders and refunds by month is confirmed, its figures equal two one-model queries", async () => {
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
    await run(["draft", "--source", "warehouse", "--tables", `${schema}.fct_orders,${schema}.fct_refunds`, "--strip-prefix", "fct_"]);
    // The draft's guessed join to customers leaves the layer, which holds orders and refunds only.
    await run(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "dim_customer"]);
    await run(["set", "warehouse.refunds", "grain", "One row per refund."]);
    const edits = join(t.dir, "edits.json");
    writeFileSync(
      edits,
      JSON.stringify({
        edits: [
          ["set", "warehouse.orders.amount", "description", "The order value in US dollars, amount_cents divided by 100, every order."],
          ["set", "warehouse.orders.amount", "currency", "USD"],
          ["set", "warehouse.orders.created_at", "description", "When the order was placed, UTC."],
          ["set", "warehouse.refunds.refunded", "description", "The refunded value in US dollars, refunded_cents divided by 100, every refund."],
          ["set", "warehouse.refunds.refunded", "currency", "USD"],
          ["set", "warehouse.refunds.order", "description", "The order each refund was issued against."],
        ],
      }),
    );
    await run(["apply", "--file", edits]);
    for (const target of ["warehouse.orders", "warehouse.orders.created_at", "warehouse.orders.amount", "warehouse.refunds", "warehouse.refunds.refunded", "warehouse.refunds.order"]) {
      const r = await approveWithYes(root, ["--target", target, "--by", "Dana Ruiz"]);
      expect({ target, code: r.code, err: r.err }).toEqual({ target, code: 0, err: "" });
    }

    const name = "orders_refunds_by_month";
    const request = {
      source: "warehouse",
      measures: ["orders.amount", "refunds.refunded"],
      dimensions: ["orders.created_at:month"],
      order_by: [{ field: "orders.created_at:month" }],
    };
    await run(["goldens", "new", "--name", name, "--question", "What were order amounts and refunds by month?", "--request", JSON.stringify(request)]);
    const confirmed = await confirmWithYes(root, ["--name", name, "--by", "Dana Ruiz"], {}, env);
    if (confirmed.code !== 0) throw new Error(confirmed.err);
    const golden = readYaml<Golden>(join(root, "goldens", `${name}.yaml`));
    expect(golden.status).toBe("approved");
    const rows = golden.expected!.rows as Row[];
    expect(Object.keys(rows[0]!)).toEqual(["created_at_month", "amount", "refunded"]);

    // The same figures from two one-model queries, written by hand: refunds grouped by their order's month.
    const orders = (await pg!.unsafe(
      `select date_trunc('month', created_at)::date::text as m, sum(amount_cents / 100.0) as v from ${schema}.fct_orders group by 1`,
    )) as { m: string; v: string }[];
    const refunds = (await pg!.unsafe(
      `select date_trunc('month', o.created_at)::date::text as m, sum(r.refunded_cents / 100.0) as v from ${schema}.fct_refunds r left join ${schema}.fct_orders o on r.order_id = o.order_id group by 1`,
    )) as { m: string; v: string }[];
    const byMonth = (list: { m: string; v: string }[]) => new Map(list.map((x) => [x.m, Number(x.v)]));
    const [o, f] = [byMonth(orders), byMonth(refunds)];
    expect(rows.length).toBe(new Set([...o.keys(), ...f.keys()]).size);
    for (const r of rows) {
      const m = String(r.created_at_month).slice(0, 10);
      expect({ m, amount: num(r.amount), refunded: num(r.refunded) }).toEqual({ m, amount: o.get(m) ?? null, refunded: f.get(m) ?? null });
    }
    const total = (col: string) => rows.reduce((t, r) => t + (num(r[col]) ?? 0), 0);
    const direct = (await pg!.unsafe(
      `select (select sum(amount_cents / 100.0) from ${schema}.fct_orders) as a, (select sum(refunded_cents / 100.0) from ${schema}.fct_refunds) as r`,
    )) as { a: string; r: string }[];
    expect(total("amount")).toBeCloseTo(Number(direct[0]!.a), 2);
    expect(total("refunded")).toBeCloseTo(Number(direct[0]!.r), 2);

    const issues = (await semlayer(root, ["validate", "--json"], env)).json<{ issues: { level: string; file: string }[] }>().issues;
    expect(issues.filter((i) => i.level === "error" && i.file === `goldens/${name}.yaml`)).toEqual([]);
    // goldens check passes and goldens run names both models' measures.
    expect((await semlayer(root, ["goldens", "check", "--name", name], env)).code).toBe(0);
    const ran = (await run(["goldens", "run", "--name", name, "--json"])).json<{ sql: string; rows: Row[] }>();
    expect(ran.sql).toContain('"orders measures"');
    expect(ran.sql).toContain('"refunds measures"');
    expect(Object.keys(ran.rows[0]!)).toEqual(["created_at_month", "amount", "refunded"]);
  });
});

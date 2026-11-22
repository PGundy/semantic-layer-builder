// Segments in the compiler (spec: Metric semantics, Segments): a measure's segments are ANDed with its
// filter inside its aggregate, on DuckDB and on PostgreSQL, inside a metric's part too; a plain request's
// segments narrow WHERE under the user's row filters; the approval hash covers a segment's filter
// text and leaves every measure without segments as it was; a segment reads protected columns as a
// filter does. All data is the synthetic Acme fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { itemHash, modelEntries } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { protectedColumns } from "../skills/semantic-layer/scripts/lib/profile.ts";
import type { Model, QueryRequest, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;
const REPO = join(import.meta.dir, "..");
const DATA = join(REPO, "fixtures", "acme", "data");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function compiled(r: CompileResult): Compiled {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
function refused(r: CompileResult): Refused {
  if (r.ok) throw new Error(`compiled: ${r.sql}`);
  return r;
}

async function runDuckdb(file: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    const p = await cx.prepare(sql);
    if (params.length) p.bind(params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

// Rows with every number as a JS number rounded to cents, so both dialects and hand SQL compare.
const plain = (rows: Row[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) || typeof v === "number" ? Math.round(Number(v) * 10000) / 10000 : v])));

const ok = { status: "approved", approved_by: "Dana Ruiz", approved_at: "2026-10-26" };
const SALES = "status in ('completed', 'shipped')";

// The orders model of the Acme warehouse, with a segment `sales` and measures that name it.
function ordersModel(table: string, edit: (m: Model) => void = () => {}): Model {
  const m = {
    model: "orders",
    source: "acme",
    table,
    grain: "One row per order.",
    primary_key: ["order_id"],
    ...ok,
    segments: [
      { name: "sales", filter: SALES, description: "Orders that count as sales." },
      { name: "big", filter: "amount_cents >= 10000" },
    ],
    dimensions: [
      { name: "ship_region", expr: "ship_region", type: "string", ...ok },
      { name: "status", expr: "status", type: "string", ...ok },
    ],
    measures: [
      { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "ship_region <> 'INT'", segments: ["sales"], description: "Sales revenue outside INT.", ...ok },
      { name: "all_revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "ship_region <> 'INT'", description: "Every order's amount outside INT.", ...ok },
      { name: "order_count", agg: "count", description: "Orders.", ...ok },
      { name: "big_sales", agg: "count", segments: ["sales", "big"], description: "Sales of 100 dollars or more.", ...ok },
    ],
  } as unknown as Model;
  edit(m);
  return m;
}

const METRICS = { metrics: [{ name: "sales_share", source: "acme", type: "ratio", numerator: "orders.revenue", denominator: "orders.all_revenue", description: "Share of revenue that is sales.", ...ok }] };

async function acme(edit: (m: Model) => void = () => {}): Promise<{ root: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const orders = WAREHOUSE_TABLES.find((x) => x.name === "fct_orders")!;
  const src = await duckdbSource(t.root, t.dir, "acme", [`create table fct_orders as select * from ${readCsvSql(join(DATA, "warehouse", "fct_orders.csv"), orders)}`]);
  writeYaml(join(t.root, "models", "acme", "orders.yaml"), ordersModel("main.fct_orders", edit));
  writeYaml(join(t.root, "metrics.yaml"), METRICS);
  return { root: t.root, file: src.connection!.database! };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "acme", ...r }) as QueryRequest;
const byRegion = (measures: string[], extra: Partial<QueryRequest> = {}) => req({ measures, dimensions: ["orders.ship_region"], order_by: [{ field: "orders.ship_region" }], ...extra });

const HAND_REVENUE = (table: string) =>
  `select ship_region, sum(case when ship_region <> 'INT' and ${SALES} then amount_cents * 0.01 end) as revenue from ${table} group by 1 order by 1 nulls last`;

describe("a measure's segments", () => {
  test("compile to filter (where a and b) and give the hand SQL's figures on the demo data in DuckDB", async () => {
    const { root, file } = await acme();
    const c = compiled(compileRequest(root, byRegion(["orders.revenue"])));
    expect(c.sql).toContain(`sum(amount_cents * 0.01) filter (where (ship_region <> 'INT') and (${SALES})) as "revenue"`);
    const got = plain(await runDuckdb(file, c.sql, c.params));
    expect(got.length).toBeGreaterThan(1);
    expect(got).toEqual(plain(await runDuckdb(file, HAND_REVENUE("fct_orders"))));
    // Two segments and no filter of its own: both in order, each in parentheses.
    const two = compiled(compileRequest(root, req({ measures: ["orders.big_sales"] })));
    expect(two.sql).toContain(`count(*) filter (where (${SALES}) and (amount_cents >= 10000)) as "big_sales"`);
    expect(plain(await runDuckdb(file, two.sql))).toEqual(plain(await runDuckdb(file, `select count(*) as big_sales from fct_orders where ${SALES} and amount_cents >= 10000`)));
  });

  test("a measure that names no segment compiles as it did before segments", async () => {
    const { root } = await acme();
    const c = compiled(compileRequest(root, req({ measures: ["orders.all_revenue", "orders.order_count"] })));
    expect(c.sql).toBe(["select", `  sum(amount_cents * 0.01) filter (where ship_region <> 'INT') as "all_revenue",`, `  count(*) as "order_count"`, `from "main"."fct_orders"`].join("\n"));
  });

  test("apply inside a metric's part: a ratio whose numerator has a segment", async () => {
    const { root, file } = await acme();
    const c = compiled(compileRequest(root, byRegion(["sales_share"])));
    expect(c.sql).toContain(`filter (where (ship_region <> 'INT') and (${SALES}))`);
    const hand = `select ship_region, coalesce(sum(amount_cents * 0.01) filter (where ship_region <> 'INT' and ${SALES}), 0)
      / nullif(sum(amount_cents * 0.01) filter (where ship_region <> 'INT'), 0) as sales_share
      from fct_orders group by 1 order by 1 nulls last`;
    expect(plain(await runDuckdb(file, c.sql, c.params))).toEqual(plain(await runDuckdb(file, hand)));
  });

  test("a segment the model does not declare is refused as invalid_layer, naming it and the fix", async () => {
    const { root } = await acme((m) => {
      m.measures[0]!.segments = ["sales", "gone"];
    });
    const r = refused(compileRequest(root, req({ measures: ["orders.revenue"] })));
    expect(r.refusals.map((x) => [x.code, x.message])).toEqual([["invalid_layer", "orders.revenue names segment gone, which model orders does not declare with a filter"]]);
    expect(r.refusals[0]!.next).toContain("run semlayer validate");
  });

  test.skipIf(!PG_URL)("give the same figures as hand SQL on the Acme warehouse in PostgreSQL", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("c1a_seg");
    const t = tempRoot();
    cleanup = t.cleanup;
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      await loadPostgres(PG_URL!, DATA, schema);
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "acme.yaml"), { source: "acme", dialect: "postgres", connection: { env: "PG_URL" } });
      writeYaml(join(t.root, "models", "acme", "orders.yaml"), ordersModel(`${schema}.fct_orders`));
      writeYaml(join(t.root, "metrics.yaml"), METRICS);
      const run = async (sql: string, params: unknown[] = []) =>
        plain(await db.begin("read only", async (tx) => [...((await tx.unsafe(sql, params as never[])) as Row[])]));
      const c = compiled(compileRequest(t.root, byRegion(["orders.revenue"])));
      expect(c.sql).toContain(`filter (where (ship_region <> 'INT') and (${SALES}))`);
      const got = await run(c.sql, c.params);
      expect(got.length).toBeGreaterThan(1);
      expect(got).toEqual(await run(HAND_REVENUE(`"${schema}".fct_orders`)));
      const share = compiled(compileRequest(t.root, req({ measures: ["sales_share"] })));
      const hand = `select sum(amount_cents) filter (where ${SALES})::numeric / nullif(sum(amount_cents), 0) as sales_share from "${schema}".fct_orders where ship_region <> 'INT'`;
      expect(await run(share.sql, share.params)).toEqual(await run(hand));
    } finally {
      await db.unsafe(`drop schema if exists "${schema}" cascade`);
      await db.close();
    }
  });
});

describe("the readback of a measure that names segments", () => {
  test("shows each segment's conditions with the segment's name, beside the measure's own, and the whole predicate in its SQL", async () => {
    const { root } = await acme();
    const r = await semlayer(root, ["readback", "--targets", "acme.orders.revenue,acme.orders.big_sales,acme.orders.all_revenue"]);
    expect(r.code).toBe(0);
    const part = (ref: string) => r.out.slice(r.out.indexOf(`${ref} (measure)`)).split(/\n(?=acme\.orders\.\w+ \(measure\))/)[0]!;
    // Its own filter first, then the segment's, so the owner sees every condition they say yes to.
    const revenue = part("acme.orders.revenue");
    expect(revenue).toContain("- It counts only rows where:");
    expect(revenue).toContain("(segment sales)");
    expect(revenue).toContain(`where (ship_region <> 'INT') and (${SALES})`);
    // No filter of its own and two segments.
    const big = part("acme.orders.big_sales");
    expect(big).toContain("(segment sales)");
    expect(big).toContain("(segment big)");
    expect(big).not.toContain("It counts every row.");
    // A measure without segments reads as before.
    expect(part("acme.orders.all_revenue")).not.toContain("(segment");
  });
});

describe("a request's segments", () => {
  test("narrow WHERE after the user's row filters and before the request's filters, binding no parameter", async () => {
    const { root, file } = await acme();
    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      user_attributes: [{ name: "region", type: "string" }],
      roles: [{ name: "rep", assign_when: "user.region is set", row_filters: [{ model: "acme.orders", expr: "ship_region = {{ user.region }}" }] }],
    });
    const c = compiled(
      compileRequest(root, req({ measures: ["orders.order_count"], segments: ["orders.sales"], filters: [{ field: "orders.status", op: "eq", value: "shipped" }] }), { user: { region: "NE" } }),
    );
    expect(c.sql).toBe(["select", `  count(*) as "order_count"`, `from "main"."fct_orders"`, "where (ship_region = $1)", `  and (${SALES})`, "  and (status) = $2"].join("\n"));
    expect(c.params).toEqual(["NE", "shipped"]);
    expect(c.row_filters.map((r) => r.model)).toEqual(["orders"]);
    const hand = `select count(*) as order_count from fct_orders where ship_region = 'NE' and ${SALES} and status = 'shipped'`;
    expect(plain(await runDuckdb(file, c.sql, c.params))).toEqual(plain(await runDuckdb(file, hand)));
  });

  test("a segment no approved measure names is refused as not_visible, with what approves it", async () => {
    const { root } = await acme((m) => {
      (m.measures[0] as unknown as Record<string, unknown>).status = "draft";
      m.measures[3]!.segments = ["big"];
    });
    const r = refused(compileRequest(root, req({ measures: ["orders.order_count"], segments: ["orders.sales"] })));
    expect(r.refusals.map((x) => x.code)).toEqual(["not_visible"]);
    expect(r.refusals[0]!.message).toBe(
      "segments[0] names orders.sales, which no approved measure this user may see names; a request applies a segment once a measure that names it is approved, since that approval covers its filter",
    );
    expect(r.refusals[0]!.next).toContain("approve it on the owner's yes");
  });

  test("a request that names a metric and segments is refused with metric.segments_on_metric", async () => {
    const { root } = await acme();
    const r = refused(compileRequest(root, req({ measures: ["sales_share"], segments: ["orders.sales"] })));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["metric.segments_on_metric", "sales_share"]]);
    expect(r.refusals[0]!.next).toContain("run semlayer sql again");
  });

  test("an unknown segment is refused as invalid_request", async () => {
    const { root } = await acme();
    const r = refused(compileRequest(root, req({ measures: ["orders.order_count"], segments: ["orders.nope"] })));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["invalid_request", "orders.nope"]]);
  });
});

describe("the approval hash of a measure with segments", () => {
  const hashes = (m: Model) => new Map(modelEntries("acme", m, () => undefined, "duckdb").map((e) => [e.ref, e.hash]));

  test("changes when a segment it names changes its filter, and not for a measure that names none", () => {
    const before = hashes(ordersModel("main.fct_orders"));
    const after = hashes(ordersModel("main.fct_orders", (m) => (m.segments![0]!.filter = "status = 'completed'")));
    expect(after.get("acme.orders.revenue")).not.toBe(before.get("acme.orders.revenue"));
    expect(after.get("acme.orders.big_sales")).not.toBe(before.get("acme.orders.big_sales"));
    expect(after.get("acme.orders.all_revenue")).toBe(before.get("acme.orders.all_revenue"));
    // A measure without segments hashes as one written before segments existed.
    const m = ordersModel("main.fct_orders");
    const plainMeasure = { ...(m.measures[1] as unknown as Record<string, unknown>) };
    expect(itemHash("measure", plainMeasure, { source: "acme", model: { ...m, segments: undefined } as never })).toBe(before.get("acme.orders.all_revenue")!);
    // A segment's description is not part of it.
    const reworded = hashes(ordersModel("main.fct_orders", (m) => (m.segments![0]!.description = "Sales, in other words.")));
    expect(reworded.get("acme.orders.revenue")).toBe(before.get("acme.orders.revenue"));
  });

  test("editing a segment's filter after approval makes validate report each measure that names it as changed", async () => {
    const { root } = await acme();
    const path = join(root, "models", "acme", "orders.yaml");
    const stamped = ordersModel("main.fct_orders");
    const h = hashes(stamped);
    const withHash = (m: Model) => {
      (m as unknown as Record<string, unknown>).approved_hash = h.get("acme.orders");
      for (const x of [...m.dimensions, ...m.measures]) (x as unknown as Record<string, unknown>).approved_hash = h.get(`acme.orders.${x.name}`);
      return m;
    };
    writeYaml(path, withHash(ordersModel("main.fct_orders")));
    expect(validateProject(root).filter((i) => i.code === "approval.hash_changed")).toEqual([]);
    writeYaml(path, withHash(ordersModel("main.fct_orders", (m) => (m.segments![0]!.filter = "status = 'completed'"))));
    const changed = validateProject(root).filter((i) => i.code === "approval.hash_changed");
    expect(changed.map((i) => i.path).sort()).toEqual(["measures[0]", "measures[3]"]);
  });

  test("every approval in examples/acme still matches its recorded hash", () => {
    const issues = validateProject(join(REPO, "examples", "acme", "semantic"));
    expect(issues.filter((i) => i.code === "approval.hash_changed" || i.code === "approval.hash_missing")).toEqual([]);
  });
});

describe("a segment that reads a column", () => {
  const table: SnapshotTable = {
    schema: "main",
    name: "fct_orders",
    kind: "table",
    columns: ["order_id", "status", "amount_cents", "ship_region", "channel"].map((name) => ({ name, type: name.endsWith("cents") || name === "order_id" ? "INTEGER" : "VARCHAR" })),
  };
  const model = (tags: string[] | undefined, ignored: string[] = []) =>
    ordersModel("main.fct_orders", (m) => {
      m.segments = [{ name: "gifted", filter: "channel is not null" }];
      m.ignored_columns = ignored;
      m.measures = [{ ...m.measures[2]!, segments: ["gifted"], ...(tags ? { tags } : {}) }];
      m.dimensions = [];
    });

  test("is protected by a pii-tagged measure that names it, as the measure's filter would be", () => {
    const viaSegment = protectedColumns([table], [model(["pii"])]).get("main.fct_orders");
    const viaFilter = protectedColumns([table], [ordersModel("main.fct_orders", (m) => {
      m.measures = [{ ...m.measures[2]!, filter: "channel is not null", tags: ["pii"] }];
      m.dimensions = [];
    })]).get("main.fct_orders");
    expect(viaSegment?.has("channel")).toBe(true);
    expect([...(viaSegment ?? [])].sort()).toEqual([...(viaFilter ?? [])].sort());
    expect(protectedColumns([table], [model(undefined)]).get("main.fct_orders")?.has("channel") ?? false).toBe(false);
  });

  test("an ignored column an untagged measure reads through its segment is read openly, as through its filter", () => {
    expect(protectedColumns([table], [model(undefined, ["channel"])]).get("main.fct_orders")?.has("channel") ?? false).toBe(false);
    // Read by nothing, the ignored column is protected.
    const unread = model(undefined, ["channel"]);
    unread.measures[0]!.segments = [];
    expect(protectedColumns([table], [unread]).get("main.fct_orders")?.has("channel")).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { columnRefs } from "../skills/semantic-layer/scripts/lib/compiler/qualify.ts";
import { compareRows } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { listGoldens } from "../skills/semantic-layer/scripts/lib/project.ts";
import { sqlNames } from "../skills/semantic-layer/scripts/lib/sql-names.ts";
import type { Golden, Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, expectRefusedAsChanged, initProject, PG_URL, reapprove, sl, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DATA = join(import.meta.dir, "..", "fixtures", "acme", "data");

function compiled(r: CompileResult): Compiled {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
function refused(r: CompileResult): Refused {
  if (r.ok) throw new Error(`compiled: ${r.sql}`);
  return r;
}

// Runs SQL on a duckdb file, read-only, session time zone UTC, with its parameters bound.
async function runDuckdb(file: string, c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    await cx.run("SET TimeZone='UTC'");
    const p = await cx.prepare(c.sql);
    if (c.params.length) p.bind(c.params as DuckDBValue[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

async function runPg(c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const db = new SQL({ url: PG_URL!, max: 1 });
  try {
    return await db.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL TIME ZONE 'UTC'");
      const rows = (await tx.unsafe(c.sql, c.params as never[])) as Row[];
      return [...rows].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
    });
  } finally {
    await db.close();
  }
}

const diffs = (expected: Row[], actual: Row[], ordered: boolean, tolerance = 0) => compareRows(expected, actual, { ordered, tolerance }).diffs;

// --- a small synthetic shop: orders -> customers -> regions and segments, orders -> regions ---

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const evidence = (to: string, keys: { from: string; to: string }[], extra: Record<string, unknown> = {}) => ({
  checked_at: "2026-01-01T00:00:00.000Z",
  to,
  keys,
  left_rows: 6,
  left_null_keys: 1,
  matched_rows: 4,
  match_rate: 0.67,
  right_rows: 3,
  right_key_unique: true,
  left_key_unique: false,
  max_fanout: 1,
  suggested_relationship: "many_to_one",
  ...extra,
});
const CUSTOMER_KEYS = [{ from: "customer_id", to: "customer_id" }];

function shopModels(): Record<string, Model> {
  const time = { type: "string", ...ok };
  return {
    orders: {
      model: "orders",
      source: "shop",
      table: "main.shop_orders",
      ...ok,
      dimensions: [
        { name: "status", expr: "status", ...time },
        { name: "ship_code", expr: "ship_code", ...time },
        { name: "customer_home", expr: "customer.home_code -- the customer's home", ...time },
        { name: "customer_home_name", expr: "customer.home.name", ...time },
      ],
      measures: [
        { name: "revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "status <> 'cancelled'", ...ok },
        { name: "real_revenue", expr: "amount_cents * 0.01", agg: "sum", filter: "coalesce(customer.is_test, false) = false", ...ok },
        { name: "order_count", agg: "count", ...ok },
        { name: "homed_orders", agg: "count", filter: "customer.home.name is not null and customer.is_test = false", ...ok },
      ],
      joins: [
        { name: "customer", to: "customers", keys: CUSTOMER_KEYS, relationship: "many_to_one", type: "left", ...ok, evidence: evidence("customers", CUSTOMER_KEYS) },
        { name: "ship_to", to: "regions", keys: [{ from: "ship_code", to: "code" }], relationship: "many_to_one", type: "left", ...ok },
      ],
    },
    customers: {
      model: "customers",
      source: "shop",
      table: "main.shop_customers",
      ...ok,
      dimensions: [
        { name: "region", expr: "home_code", ...time },
        { name: "is_test", expr: "is_test", type: "boolean", ...ok },
      ],
      measures: [{ name: "customer_count", agg: "count", ...ok }],
      joins: [
        { name: "home", to: "regions", keys: [{ from: "home_code", to: "code" }], relationship: "many_to_one", type: "left", ...ok },
        { name: "segment", to: "segments", keys: [{ from: "segment_id", to: "segment_id" }], relationship: "many_to_one", type: "left", ...ok },
        { name: "orders", to: "orders", keys: CUSTOMER_KEYS, relationship: "one_to_many", type: "left", ...ok },
      ],
    },
    regions: {
      model: "regions",
      source: "shop",
      table: "main.shop_regions",
      ...ok,
      dimensions: [
        { name: "name", expr: "name", ...time },
        { name: "opened", expr: "year", type: "number", ...ok },
      ],
      measures: [],
    },
    segments: { model: "segments", source: "shop", table: "main.shop_segments", ...ok, dimensions: [{ name: "label", expr: "label", ...time }], measures: [] },
  } as unknown as Record<string, Model>;
}

const SHOP = [
  "create table shop_orders (order_id integer, customer_id integer, status varchar, amount_cents integer, ship_code varchar, year integer)",
  `insert into shop_orders values
    (1, 10, 'completed', 1000, 'NE', 2025), (2, 10, 'cancelled', 2000, 'NE', 2025), (3, 11, 'completed', 3000, 'WC', 2025),
    (4, 12, 'completed', 4000, 'WC', 2025), (5, 99, 'completed', 5000, 'SE', 2025), (6, null, 'completed', 6000, 'XX', 2025)`,
  "create table shop_customers (customer_id integer, home_code varchar, segment_id integer, is_test boolean)",
  "insert into shop_customers values (10, 'NE', 1, false), (11, 'WC', 2, true), (12, 'SE', null, false)",
  "create table shop_regions (code varchar, name varchar, year integer)",
  "insert into shop_regions values ('NE', 'Northeast', 1990), ('WC', 'West Coast', 2001), ('SE', 'Southeast', 2010)",
  "create table shop_segments (segment_id integer, label varchar)",
  "insert into shop_segments values (1, 'Retail'), (2, 'Wholesale')",
];

async function shop(edit?: (m: Record<string, Model>) => void): Promise<{ root: string; file: string; write: (edit: (m: Record<string, Model>) => void) => void }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", SHOP);
  let models = shopModels();
  const write = (e: (m: Record<string, Model>) => void) => {
    models = structuredClone(models);
    e(models);
    for (const m of Object.values(models)) writeYaml(join(t.root, "models", "shop", `${m.model}.yaml`), m);
  };
  write(edit ?? (() => {}));
  return { root: t.root, file: src.connection!.database!, write };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const join_ = (m: Record<string, Model>, model: string, name: string) => m[model]!.joins!.find((j) => j.name === name)!;

describe("definition joins", () => {
  test("a one-hop measure filter and a request dimension through two hops, as exact SQL that runs", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_revenue"], dimensions: ["segments.label"], order_by: [{ field: "segments.label" }] })));
    expect(c.sql).toBe(
      [
        "select",
        `  "orders.customer.segment".label as "label",`,
        `  sum("orders".amount_cents * 0.01) filter (where coalesce("orders~customer".is_test, false) = false) as "real_revenue"`,
        `from "main"."shop_orders" as "orders"`,
        `left join "main"."shop_customers" as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id"`,
        `left join "main"."shop_segments" as "orders.customer.segment" on "orders.customer"."segment_id" = "orders.customer.segment"."segment_id"`,
        `left join "main"."shop_customers" as "orders~customer" on "orders"."customer_id" = "orders~customer"."customer_id"`,
        "group by 1",
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(c.joins).toEqual([
      { alias: "orders.customer", via: "orders.customer", model: "customers", type: "left", for: "request" },
      { alias: "orders.customer.segment", via: "customers.segment", model: "segments", type: "left", for: "request" },
      { alias: "orders~customer", via: "orders.customer", model: "customers", type: "left", for: "definition" },
    ]);
    // Test account 11 is left out; orders 5 and 6, whose customer is missing, count.
    expect(await runDuckdb(file, c)).toEqual([
      { label: "Retail", real_revenue: "30.00" },
      { label: "Wholesale", real_revenue: null },
      { label: null, real_revenue: "150.00" },
    ]);
  });

  test("two hops in a dimension expr and a measure filter, sharing one alias per chain, with a -- comment kept", async () => {
    const { root, file } = await shop();
    const c = compiled(
      compileRequest(root, req({ measures: ["orders.homed_orders", "orders.real_revenue"], dimensions: ["orders.customer_home_name", "orders.customer_home"], order_by: [{ field: "orders.customer_home_name" }] })),
    );
    expect(c.joins.map((j) => j.alias)).toEqual(["orders~customer", "orders~customer.home"]);
    expect(c.sql).toContain(`  "orders~customer.home".name as "customer_home_name",\n  ("orders~customer".home_code -- the customer's home\n) as "customer_home",`);
    expect(c.sql).toContain(`left join "main"."shop_regions" as "orders~customer.home" on "orders~customer"."home_code" = "orders~customer.home"."code"`);
    expect(c.sql).toContain(`count(*) filter (where "orders~customer.home".name is not null and "orders~customer".is_test = false) as "homed_orders"`);
    const hand =
      "select r.name as customer_home_name, c.home_code as customer_home, count(*) filter (where r.name is not null and c.is_test = false) as homed_orders, " +
      "sum(o.amount_cents * 0.01) filter (where coalesce(c.is_test, false) = false) as real_revenue " +
      "from shop_orders o left join shop_customers c on c.customer_id = o.customer_id left join shop_regions r on r.code = c.home_code group by 1, 2 order by 1 nulls last";
    const rows = await runDuckdb(file, c);
    expect(rows.length).toBe(4);
    expect(diffs(await runDuckdb(file, { sql: hand, params: [] }), rows, true)).toEqual([]);
  });

  test("a definition join is its own join, apart from the request's path along the same declared join", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_revenue"], dimensions: ["customers.region", "orders.customer_home"] })));
    expect(c.joins.map((j) => `${j.for}:${j.alias}`)).toEqual(["request:orders.customer", "definition:orders~customer"]);
    expect(c.sql).toContain(`"orders.customer".home_code as "region"`);
    expect(c.sql).toContain(`("orders~customer".home_code -- the customer's home\n) as "customer_home"`);
    expect(await runDuckdb(file, c)).toHaveLength(4);
  });

  test("a definition join applies whatever the role may see, and without the target's row filters", async () => {
    const { root, file } = await shop();
    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      user_attributes: [{ name: "region", type: "string" }],
      roles: [{ name: "rep", assign_when: "user.region is set", row_filters: [{ model: "shop.customers", expr: "home_code = {{ user.region }}" }] }],
      restrictions: [{ name: "customers_private", targets: ["shop.customers"], allow: { roles: ["rep"] } }],
    });
    const everyone = compiled(compileRequest(root, req({ measures: ["orders.real_revenue"] })));
    const rep = compiled(compileRequest(root, req({ measures: ["orders.real_revenue"] }), { user: { region: "NE" } }));
    expect(rep.sql).toBe(everyone.sql);
    expect(await runDuckdb(file, everyone)).toEqual([{ real_revenue: "180.00" }]);
    // Naming the model is what visibility governs: hidden from everyone, row-filtered for the rep.
    expect(refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["customers.region"] }))).refusals.map((r) => r.code)).toEqual(["not_visible"]);
    const path = compiled(compileRequest(root, req({ measures: ["orders.real_revenue"], dimensions: ["customers.region"] }), { user: { region: "NE" } }));
    expect(path.sql).toContain(`left join "main"."shop_customers" as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id" and ("orders.customer".home_code = $1)`);
    expect(path.joins.map((j) => `${j.for}:${j.alias}`)).toEqual(["request:orders.customer", "definition:orders~customer"]);
  });
});

describe("request paths", () => {
  test("a dimension one hop away, the shortest path winning over a longer one, as filters in WHERE with parameters in reading order", async () => {
    const { root, file } = await shop();
    const c = compiled(
      compileRequest(
        root,
        req({
          measures: ["orders.revenue"],
          dimensions: ["regions.name"],
          filters: [
            { field: "orders.revenue", op: "gt", value: 1 },
            { field: "customers.region", op: "in", value: ["NE", "WC", "SE"] },
            { field: "segments.label", op: "neq", value: "Wholesale" },
          ],
        }),
      ),
    );
    // regions is one hop through ship_to, and two through customer.home: ship_to wins.
    expect(c.joins.map((j) => j.alias)).toEqual(["orders.ship_to", "orders.customer", "orders.customer.segment"]);
    expect(c.sql).toContain(
      `where ("orders.customer".home_code) in ($1, $2, $3)\n  and ("orders.customer.segment".label) <> $4\ngroup by 1\nhaving (sum("orders".amount_cents * 0.01) filter (where "orders".status <> 'cancelled')) > $5`,
    );
    expect(c.params).toEqual(["NE", "WC", "SE", "Wholesale", 1]);
    const hand =
      "select r.name, sum(o.amount_cents * 0.01) filter (where o.status <> 'cancelled') as revenue from shop_orders o " +
      "left join shop_regions r on r.code = o.ship_code left join shop_customers c on c.customer_id = o.customer_id " +
      "left join shop_segments s on s.segment_id = c.segment_id where c.home_code in ('NE', 'WC', 'SE') and s.label <> 'Wholesale' group by 1 having sum(o.amount_cents * 0.01) filter (where o.status <> 'cancelled') > 1";
    expect(diffs(await runDuckdb(file, { sql: hand, params: [] }), await runDuckdb(file, c), false)).toEqual([]);
  });

  test("left keeps rows whose target is missing, with its columns null; inner drops them, and an inner second hop drops a missing first hop", async () => {
    const { root, file, write } = await shop();
    const byRegion = req({ measures: ["orders.order_count"], dimensions: ["customers.region"], order_by: [{ field: "customers.region" }] });
    expect(await runDuckdb(file, compiled(compileRequest(root, byRegion)))).toEqual([
      { region: "NE", order_count: "2" },
      { region: "SE", order_count: "1" },
      { region: "WC", order_count: "1" },
      { region: null, order_count: "2" },
    ]);
    const total = req({ measures: ["orders.real_revenue"] });
    expect(await runDuckdb(file, compiled(compileRequest(root, total)))).toEqual([{ real_revenue: "180.00" }]);
    write((m) => {
      join_(m, "orders", "customer").type = "inner";
    });
    const inner = compiled(compileRequest(root, byRegion));
    expect(inner.sql).toContain(`inner join "main"."shop_customers" as "orders.customer"`);
    expect(await runDuckdb(file, inner)).toEqual([
      { region: "NE", order_count: "2" },
      { region: "SE", order_count: "1" },
      { region: "WC", order_count: "1" },
    ]);
    // An inner definition join drops orders 5 and 6 from the measure too, as the declared type says.
    expect(await runDuckdb(file, compiled(compileRequest(root, total)))).toEqual([{ real_revenue: "70.00" }]);

    write((m) => {
      join_(m, "orders", "customer").type = "left";
      join_(m, "customers", "home").type = "inner";
    });
    const twoHop = compiled(compileRequest(root, req({ measures: ["orders.order_count"], dimensions: ["orders.customer_home_name"], order_by: [{ field: "orders.customer_home_name" }] })));
    expect(await runDuckdb(file, twoHop)).toEqual([
      { customer_home_name: "Northeast", order_count: "2" },
      { customer_home_name: "Southeast", order_count: "1" },
      { customer_home_name: "West Coast", order_count: "1" },
    ]);
  });

  test("two shortest paths tie: refused, naming both and what to do", async () => {
    const { root, write } = await shop();
    write((m) => {
      m.orders!.joins!.push({ name: "buyer", to: "customers", keys: CUSTOMER_KEYS, relationship: "many_to_one", type: "left", ...ok } as never);
    });
    const one = refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["customers.region"] })));
    expect(one.refusals).toEqual([
      {
        code: "ambiguous_join_path",
        ref: "customers.region",
        message: "customers.region is on model customers, which a request on orders reaches by 2 paths of one join each, orders.customer and orders.buyer, so the request does not say which it means",
        next: "Ask the owner which path the figure means, then add a dimension to orders that reads the field through that join (as customer.<column>) or a join to orders that reaches customers directly, and run sl sql again.",
      },
    ]);
    const two = refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["segments.label"] })));
    expect(two.reason).toContain("reaches by 2 paths of two joins each, orders.customer.segment and orders.buyer.segment");
    // A definition join names its join, so it never ties.
    expect(compileRequest(root, req({ measures: ["orders.real_revenue"] })).ok).toBe(true);
    const cli = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["orders.revenue"], dimensions: ["customers.region"] }))]);
    expect(cli.code).toBe(1);
    expect(cli.err).toContain("orders.customer and orders.buyer");
    expect(cli.err).toContain("Ask the owner which path the figure means");
  });

  test("a path only through a one_to_many join, or none at all, is refused; so is a filter on another model's measure", async () => {
    const { root } = await shop();
    const fan = refused(compileRequest(root, req({ measures: ["customers.customer_count"], dimensions: ["orders.status"] })));
    expect(fan.refusals[0]).toMatchObject({
      code: "no_join_path",
      message: "orders.status is on model orders, which a request on customers reaches only through join customers.orders, which is one_to_many: it would repeat rows of customers and multiply its measures (fan-out)",
    });
    const none = refused(compileRequest(root, req({ dimensions: ["regions.name", "segments.label"] })));
    expect(none.reason).toBe("segments.label is on model segments, which a request on regions reaches through no many_to_one or one_to_one join within two hops");
    expect(none.refusals[0]!.next).toContain("Add a many_to_one or one_to_one join from regions toward segments");
    const measureFilter = refused(compileRequest(root, req({ measures: ["orders.revenue"], filters: [{ field: "customers.customer_count", op: "gt", value: 1 }] })));
    expect(measureFilter.reason).toBe("filters[0] names customers.customer_count, a measure of model customers; a request filters only on measures of orders, the model of its measures");
  });
});

describe("fan-out safety", () => {
  const fanning = { right_key_unique: false, max_fanout: 2 };

  test("a to-one join whose current evidence shows fan-out is refused naming sl check-join, unless fanout_override says why", async () => {
    const { root, write } = await shop((m) => {
      join_(m, "orders", "customer").evidence = evidence("customers", CUSTOMER_KEYS, fanning) as never;
    });
    for (const r of [req({ measures: ["orders.real_revenue"] }), req({ measures: ["orders.revenue"], dimensions: ["customers.region"] })]) {
      const x = refused(compileRequest(root, r));
      expect(x.refusals.map((y) => y.code)).toEqual(["join_fans_out"]);
      expect(x.reason).toBe(
        "join orders.customer is many_to_one, but its evidence shows fan-out (the key of customers is not unique and a row matches up to 2 rows of customers), so it would repeat rows of orders and multiply its measures",
      );
      expect(x.refusals[0]!.next).toContain("sl check-join --source shop --model orders --join customer");
    }
    const cli = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["orders.real_revenue"] })), "--json"]);
    expect(cli.json<{ next: string }>().next).toContain("Measure the join again with sl check-join --source shop --model orders --join customer");

    write((m) => {
      join_(m, "orders", "customer").fanout_override = "Customer 10 has two rows in the export; the owner accepts it.";
    });
    expect(compileRequest(root, req({ measures: ["orders.real_revenue"] })).ok).toBe(true);
    // Evidence measured for another target is stale (sl validate warns), and refuses nothing.
    write((m) => {
      const j = join_(m, "orders", "customer");
      delete j.fanout_override;
      j.evidence = evidence("regions", CUSTOMER_KEYS, fanning) as never;
    });
    expect(compileRequest(root, req({ measures: ["orders.real_revenue"] })).ok).toBe(true);
    // many_to_many evidence needs a bridge table whatever fanout_override says.
    write((m) => {
      const j = join_(m, "orders", "customer");
      j.fanout_override = "accepted";
      j.evidence = evidence("customers", CUSTOMER_KEYS, { ...fanning, suggested_relationship: "many_to_many" }) as never;
    });
    expect(refused(compileRequest(root, req({ measures: ["orders.real_revenue"] }))).reason).toContain("needs a bridge table whatever fanout_override says");
  });

  test("a join reference through a one_to_many join, and a measure expr that reads a join, are layer errors", async () => {
    const { root } = await shop((m) => {
      m.customers!.dimensions.push({ name: "first_status", expr: "orders.status", type: "string", ...ok } as never);
      m.orders!.measures.push({ name: "bad", expr: "customer.customer_id", agg: "count_distinct", ...ok } as never);
    });
    const many = refused(compileRequest(root, req({ dimensions: ["customers.first_status"] })));
    expect(many.reason).toBe("customers.first_status reads through join customers.orders, which is one_to_many; a join reference reads only through many_to_one and one_to_one joins; run sl validate");
    expect(refused(compileRequest(root, req({ measures: ["orders.bad"] }))).reason).toContain("a measure expr reads only its model's own columns; run sl validate");
  });

  test("a joined model's expr that is not read-only is refused by the read-only check (invariant 1)", async () => {
    const { root } = await shop((m) => {
      m.segments!.dimensions.push({ name: "leak", expr: "pg_read_file('/etc/passwd')", type: "string", ...ok } as never);
    });
    const r = refused(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["segments.leak"] })));
    expect(r.refusals[0]!.code).toBe("invalid_layer");
    expect(r.reason).toContain("the compiled SQL is not read-only");
  });
});

describe("determinism and qualification", () => {
  test("the same request and layer give the same SQL, parameters and joins (invariant 7); a one-table query stays unqualified", async () => {
    const { root } = await shop();
    const r = req({ measures: ["orders.real_revenue"], dimensions: ["segments.label", "regions.name"], filters: [{ field: "customers.region", op: "eq", value: "NE" }] });
    const a = compiled(compileRequest(root, r));
    expect(compiled(compileRequest(root, structuredClone(r)))).toEqual(a);
    const cli1 = await sl(root, ["sql", "--request", JSON.stringify(r), "--json"]);
    const cli2 = await sl(root, ["sql", "--request", JSON.stringify(r), "--json"]);
    expect(cli1.out).toBe(cli2.out);
    expect(cli1.json<Compiled>().joins).toEqual(a.joins);
    const plain = compiled(compileRequest(root, req({ measures: ["orders.revenue"], dimensions: ["orders.status"] })));
    expect(plain.sql).toBe(`select\n  status as "status",\n  sum(amount_cents * 0.01) filter (where status <> 'cancelled') as "revenue"\nfrom "main"."shop_orders"\ngroup by 1`);
    expect(plain.joins).toEqual([]);
  });

  test("with a snapshot, a column named like a SQL keyword is qualified too", async () => {
    const { root, file } = await shop();
    const table = (name: string, columns: string[]) => ({ schema: "main", name, kind: "table", columns: columns.map((c) => ({ name: c, type: "VARCHAR" })) });
    writeFileSync(
      join(root, "snapshots", "shop.json"),
      JSON.stringify({
        snapshot_version: 1,
        source: "shop",
        dialect: "duckdb",
        captured_at: "2026-01-01T00:00:00.000Z",
        method: "live",
        tables: [
          table("shop_orders", ["order_id", "customer_id", "status", "amount_cents", "ship_code", "year"]),
          table("shop_regions", ["code", "name", "year"]),
          table("shop_customers", ["customer_id", "home_code", "segment_id", "is_test"]),
          table("shop_segments", ["segment_id", "label"]),
        ],
      }),
    );
    const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"], dimensions: ["regions.opened"], order_by: [{ field: "regions.opened" }] })));
    expect(c.sql).toContain(`"orders.ship_to".year as "opened"`);
    expect(await runDuckdb(file, c)).toEqual([
      { opened: 1990, order_count: "2" },
      { opened: 2001, order_count: "2" },
      { opened: 2010, order_count: "1" },
      { opened: null, order_count: "1" },
    ]);
  });

  test("columnRefs reads columns as sqlNames does, leaving keywords, calls, casts, literals and lambda parameters", () => {
    const refs = (sql: string, cols?: string[]) => columnRefs(sql, cols).map((r) => sql.slice(r.start, r.end));
    expect(refs("coalesce(customer.is_test, false) = false and status not like '%x.y%' -- a.b")).toEqual(["customer.is_test", "status"]);
    expect(refs(`cast(amount as double precision) + x::timestamp with time zone + "Odd Col"`)).toEqual(["amount", "x", '"Odd Col"']);
    expect(refs("x::int and y")).toEqual(["x", "y"]);
    expect(refs("created_at at time zone 'UTC' >= date '2025-01-01' + interval '1' day")).toEqual(["created_at"]);
    expect(refs("extract(year from created_at) = year", ["created_at", "year"])).toEqual(["created_at", "year"]);
    expect(refs("list_filter(items, x -> x.kind = 'a') and (lambda y: y + z)")).toEqual(["items", "z"]);
    expect(refs("list_reduce(l, (a, b) -> a + b) + list_transform(m, x -> x + 1)")).toEqual(["l", "m"]);
    // Postgres's JSON operators bind nothing: ->> always, -> before a string or a number.
    expect(refs("coalesce(meta->>'k', 'none') = (payload->'a')->>'b'")).toEqual(["meta", "payload"]);
    expect(refs("coalesce(a, b)->>'k' or f(arr -> 0) or g(doc -> 'k')")).toEqual(["a", "b", "arr", "doc"]);
    expect(refs("created_at + interval 30 days < now() - interval 2 weeks")).toEqual(["created_at"]);
    expect(refs("case when status = 'a' then 1 else null end is not distinct from E'it\\'s' or $$a.b$$ = n")).toEqual(["status", "n"]);
    const texts = [
      "order.status in ('completed', 'shipped') and coalesce(order.test_account.is_test_account, false) = false",
      "lower(customer.email) like '%@x.test' or region.\"Name\" = 'NE'",
      "list_filter(items, x -> x.kind = 'a') and payload -> 'k' is not null and s.field = 1",
    ];
    for (const t of texts) {
      const mine = columnRefs(t).filter((r) => r.parts.length > 1).map((r) => r.parts.join("."));
      expect(mine).toEqual(sqlNames(t, "postgres").chains.map((c) => c.text));
    }
  });
});

// --- Acme: every approved golden that needs joins and nothing a later version adds -----------

const NEEDS_LATER = new Set(["unsupported_metric"]);
const asUser = (g: Golden) => ({ ...(g.role ? { role: g.role } : {}), user: g.user ?? {} });

// A copy of Acme whose warehouse models read the tables in schema, on dialect, each changed item
// approved again by the copy's owner.
async function acmeCopy(dialect: "duckdb" | "postgres", schema: string, database?: string): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  cpSync(ACME, t.root, { recursive: true });
  const dir = join(t.root, "models", "warehouse");
  for (const f of readdirSync(dir)) {
    const m = readYaml<Model>(join(dir, f));
    m.table = m.table.replace(/^acme\./, `${schema}.`);
    // Cents as an exact amount on duckdb, where / 100.0 is a DOUBLE (spec: models).
    if (dialect === "duckdb") for (const x of m.measures) if (x.expr) x.expr = x.expr.replace(" / 100.0", " * 0.01");
    writeYaml(join(dir, f), m);
  }
  const conn = dialect === "duckdb" ? `connection:\n  database: ${JSON.stringify(database)}\n` : "connection:\n  env: PG_URL\n";
  writeFileSync(join(t.root, "sources", "warehouse.yaml"), `source: warehouse\ndialect: ${dialect}\n${conn}`);
  await reapprove(t.root);
  return t.root;
}

function withCancelled(root: string): void {
  const path = join(root, "models", "warehouse", "orders.yaml");
  const m = readYaml<Model>(path);
  const revenue = m.measures.find((x) => x.name === "revenue")!;
  revenue.filter = revenue.filter!.replace("status in ('completed', 'shipped')", "status in ('completed', 'shipped', 'cancelled')");
  writeYaml(path, m);
}

// Compiles every approved warehouse golden, runs each that compiles, and returns the names that
// compiled; the others are refused only for what a later version adds.
async function checkGoldens(root: string, run: (c: Compiled) => Promise<Row[]>): Promise<string[]> {
  const names: string[] = [];
  for (const { golden: g } of listGoldens(root)) {
    if (g.status !== "approved" || g.request.source !== "warehouse") continue;
    const r = compileRequest(root, g.request, asUser(g));
    if (!r.ok) {
      for (const x of r.refusals) expect(NEEDS_LATER.has(x.code)).toBe(true);
      continue;
    }
    names.push(g.name);
    const found = diffs(g.expected!.rows, await run(r), (g.request.order_by ?? []).length > 0, g.expected!.tolerance ?? 0);
    expect({ golden: g.name, diffs: found }).toEqual({ golden: g.name, diffs: [] });
  }
  return names.sort();
}

// The analytics reviewer's experiment: with orders.revenue counting cancelled orders, every
// compiled golden that uses revenue is refused until the owner approves revenue again, and then
// gives a different result.
async function revenueChanged(root: string, run: (c: Compiled) => Promise<Row[]>, compiledNames: string[]): Promise<void> {
  const using = listGoldens(root)
    .map((x) => x.golden)
    .filter((g) => compiledNames.includes(g.name) && (g.request.measures ?? []).includes("orders.revenue"));
  expect(using.map((g) => g.name)).toEqual([
    "analyst_rep_101_by_name_2025",
    "revenue_by_region_2025",
    "sales_head_301_2025",
    "sales_manager_201_2025",
    "sales_manager_202_2025",
    "sales_manager_203_2025",
    "sales_rep_101_2025",
  ]);
  withCancelled(root);
  for (const g of using) expectRefusedAsChanged(compileRequest(root, g.request, asUser(g)), "warehouse", "orders.revenue");
  await reapprove(root, ["warehouse.orders.revenue"]);
  for (const g of using) {
    const c = compiled(compileRequest(root, g.request, asUser(g)));
    expect(c.sql).toContain("'cancelled'");
    expect(diffs(g.expected!.rows, await run(c), (g.request.order_by ?? []).length > 0).length).toBeGreaterThan(0);
  }
}

const JOIN_GOLDENS = [
  "analyst_rep_101_by_name_2025",
  "discount_2025",
  "order_count_by_region_2025",
  "refunds_2025",
  "revenue_by_region_2025",
  "sales_head_301_2025",
  "sales_manager_201_2025",
  "sales_manager_202_2025",
  "sales_manager_203_2025",
  "sales_rep_101_2025",
];

describe("Acme's approved goldens that need joins", () => {
  test("compile to their recorded rows on duckdb; revenue counting cancelled orders is refused until approved again, then changes every one using revenue", async () => {
    const t = tempRoot();
    const file = join(t.dir, "warehouse.duckdb");
    const instance = await DuckDBInstance.create(file);
    const cx = await instance.connect();
    await cx.run("create schema acme");
    for (const tb of WAREHOUSE_TABLES) await cx.run(`create table acme.${tb.name} as select * from ${readCsvSql(join(DATA, "warehouse", `${tb.name}.csv`), tb)}`);
    // fixtures/acme/evolve.sql in DuckDB's dialect: no constraints or comments, and the rep
    // assignment (two reps per region, the order's parity picks one) without a correlated offset.
    const evolve = readFileSync(join(DATA, "..", "evolve.sql"), "utf8")
      .replace(/--.*$/gm, "")
      .replace(/\s+references acme\.\w+ \(\w+\)/g, "")
      .replace(/^(comment on|analyze|begin|commit)[^;]*;/gm, "")
      .replace(" not null default 0", " default 0")
      .replace(
        /update acme\.fct_orders o\s+set sales_rep_id[\s\S]*?where sales_rep_id is null/,
        "update acme.fct_orders as o set sales_rep_id = r.rep_id from (select rep_id, region_code, row_number() over (partition by region_code order by rep_id) - 1 as k " +
          "from acme.dim_sales_reps) as r where r.region_code = o.ship_region and r.k = o.order_id % 2 and o.sales_rep_id is null",
      );
    for (const stmt of evolve.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await cx.run(stmt);
    cx.closeSync();
    instance.closeSync();
    const root = await acmeCopy("duckdb", "acme", file);
    const outer = cleanup;
    cleanup = () => {
      outer?.();
      t.cleanup();
    };
    const run = (c: Compiled) => runDuckdb(file, c);
    const names = await checkGoldens(root, run);
    expect(names).toEqual(JOIN_GOLDENS);
    await revenueChanged(root, run, names);
  }, 60_000);

  test.skipIf(!PG_URL)(
    "compile to their recorded rows on postgres; revenue counting cancelled orders is refused until approved again, then changes every one using revenue",
    async () => {
      assertLocalPg(PG_URL);
      const schema = uniqueSchema("sl_joins");
      const db = new SQL({ url: PG_URL!, max: 1 });
      try {
        await loadPostgres(PG_URL!, DATA, schema);
        await db.unsafe(readFileSync(join(DATA, "..", "evolve.sql"), "utf8").replace(/(?<!@)\bacme\./g, `${schema}.`));
        const root = await acmeCopy("postgres", schema);
        const names = await checkGoldens(root, runPg);
        expect(names).toEqual(JOIN_GOLDENS);
        await revenueChanged(root, runPg, names);
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await db.close();
      }
    },
    120_000,
  );
});

// --- edge cases on a second synthetic shop -----------------------------------------------

const str_ = { type: "string", ...ok };
const K_EDGE = [{ from: "customer_id", to: "customer_id" }];

function edgeModels(): Record<string, Model> {
  return {
    orders: {
      model: "orders",
      source: "shop",
      table: "main.o",
      ...ok,
      dimensions: [
        { name: "status", expr: "status", ...str_ },
        { name: "kind", expr: "payload.kind", ...str_ },
        { name: "j", expr: "coalesce(meta->>'k', 'none')", ...str_ },
        { name: "due", expr: "created_at + interval 30 days", type: "time", time_grains: ["day", "month"], ...ok },
        { name: "parent_status", expr: "parent.status", ...str_ },
        { name: "made", expr: "created_at", type: "time", time_grains: ["day", "month"], ...ok },
      ],
      measures: [
        { name: "n", agg: "count", ...ok },
        { name: "real_n", agg: "count", filter: "coalesce(customer.is_test, false) = false", ...ok },
        { name: "multi_n", agg: "count", filter: "pair.label is not null", ...ok },
      ],
      joins: [
        { name: "customer", to: "customers", keys: K_EDGE, relationship: "many_to_one", type: "left", ...ok },
        { name: "parent", to: "orders", keys: [{ from: "parent_id", to: "order_id" }], relationship: "many_to_one", type: "left", ...ok },
        {
          name: "pair",
          to: "pairs",
          keys: [
            { from: "customer_id", to: "cid" },
            { from: "status", to: "st" },
          ],
          relationship: "many_to_one",
          type: "left",
          ...ok,
        },
      ],
    },
    customers: {
      model: "customers",
      source: "shop",
      table: "main.c",
      ...ok,
      dimensions: [
        { name: "region", expr: "region", ...str_ },
        { name: "signup", expr: "signup_at", type: "time", time_grains: ["day", "month"], ...ok },
        { name: "seg_label", expr: "segment.label", ...str_ },
      ],
      measures: [{ name: "customer_count", agg: "count", ...ok }],
      joins: [{ name: "segment", to: "segments", keys: [{ from: "segment_id", to: "segment_id" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    segments: { model: "segments", source: "shop", table: "main.sg", ...ok, dimensions: [{ name: "label", expr: "label", ...str_ }], measures: [] },
    pairs: { model: "pairs", source: "shop", table: "main.p", ...ok, dimensions: [{ name: "label", expr: "label", ...str_ }], measures: [] },
  } as unknown as Record<string, Model>;
}

const EDGE_DB = [
  "create table o (order_id integer, parent_id integer, customer_id integer, status varchar, payload struct(kind varchar), meta json, created_at timestamp)",
  `insert into o values
    (1, null, 10, 'done', {'kind': 'a'}, '{"k":"x"}', '2025-01-05'),
    (2, 1, 10, 'open', {'kind': 'b'}, '{"k":"y"}', '2025-02-05'),
    (3, 1, 11, 'done', {'kind': 'a'}, null, '2025-02-06')`,
  "create table c (customer_id integer, region varchar, signup_at timestamp, segment_id integer, is_test boolean, meta json)",
  "insert into c values (10, 'NE', '2024-03-01', 1, false, null), (11, 'WC', '2024-04-02', 2, true, null)",
  "create table sg (segment_id integer, label varchar)",
  "insert into sg values (1, 'Retail'), (2, 'Wholesale')",
  "create table p (cid integer, st varchar, label varchar)",
  "insert into p values (10, 'done', 'A'), (10, 'open', 'B')",
];

async function edgeShop(edit?: (m: Record<string, Model>) => void) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", EDGE_DB);
  const m = edgeModels();
  edit?.(m);
  for (const x of Object.values(m)) writeYaml(join(t.root, "models", "shop", `${x.model}.yaml`), x);
  return { root: t.root, file: src.connection!.database! };
}

describe("edge cases: self-joins, struct and JSON reads, interval units, second-hop fan-out, join order", () => {
  test("self-join definition join and multi-key join run", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.multi_n"], dimensions: ["orders.parent_status"], order_by: [{ field: "orders.parent_status" }] })));
    expect(c.sql).toContain(`left join "main"."o" as "orders~parent" on "orders"."parent_id" = "orders~parent"."order_id"`);
    expect(c.sql).toContain(`"orders"."customer_id" = "orders~pair"."cid" and "orders"."status" = "orders~pair"."st"`);
    expect(await runDuckdb(file, c)).toEqual([
      { parent_status: "done", multi_n: "1" },
      { parent_status: null, multi_n: "1" },
    ]);
  });

  test("a grain on another model's time dimension, a where filter on it, and order_by on it", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(
      compileRequest(
        root,
        req({ measures: ["orders.n"], dimensions: ["customers.signup:month"], filters: [{ field: "customers.signup", op: "gte", value: "2024-01-01" }], order_by: [{ field: "customers.signup" }] }),
      ),
    );
    expect(await runDuckdb(file, c)).toEqual([
      { signup_month: "2024-03-01", n: "2" },
      { signup_month: "2024-04-01", n: "1" },
    ]);
  });

  test("a reached model's own definition join gets alias path~join", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_n"], dimensions: ["customers.seg_label"], order_by: [{ field: "customers.seg_label" }] })));
    expect(c.joins.map((j) => `${j.for}:${j.alias}`)).toEqual(["request:orders.customer", "definition:orders.customer~segment", "definition:orders~customer"]);
    expect(await runDuckdb(file, c)).toEqual([
      { seg_label: "Retail", real_n: "2" },
      { seg_label: "Wholesale", real_n: "0" },
    ]);
  });

  test("a struct read on the base model's own column in a joined query runs on duckdb", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_n"], dimensions: ["orders.kind"], order_by: [{ field: "orders.kind" }] })));
    expect(c.sql).toContain(`"orders".payload.kind`);
    expect(await runDuckdb(file, c)).toEqual([
      { kind: "a", real_n: "1" },
      { kind: "b", real_n: "1" },
    ]);
  });

  test("a JSON arrow inside a call is qualified in a joined query, not taken for a lambda parameter", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.n"], dimensions: ["orders.j", "customers.region"], order_by: [{ field: "orders.j" }] })));
    // meta exists on both o and c; an unqualified meta is ambiguous.
    expect(c.sql).toContain(`coalesce("orders".meta->>'k', 'none') as "j"`);
    expect(await runDuckdb(file, c)).toEqual([
      { j: "none", region: "WC", n: "1" },
      { j: "x", region: "NE", n: "1" },
      { j: "y", region: "NE", n: "1" },
    ]);
  });

  test("without a snapshot, the unit of DuckDB's interval 30 days is not qualified as a column", async () => {
    const { root, file } = await edgeShop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_n"], dimensions: ["orders.due:month"], order_by: [{ field: "orders.due" }] })));
    expect(c.sql).toContain(`"orders".created_at + interval 30 days`);
    expect(await runDuckdb(file, c)).toEqual([
      { due_month: "2025-02-01", real_n: "1" },
      { due_month: "2025-03-01", real_n: "1" },
    ]);
  });

  test("fan-out evidence on the second hop of a request path is refused naming check-join on that join", async () => {
    const { root } = await edgeShop((m) => {
      m.customers!.joins![0]!.evidence = {
        checked_at: "2026-01-01T00:00:00.000Z",
        to: "segments",
        keys: [{ from: "segment_id", to: "segment_id" }],
        right_key_unique: false,
        max_fanout: 3,
        suggested_relationship: "many_to_one",
      } as never;
    });
    const r = compileRequest(root, req({ measures: ["orders.n"], dimensions: ["segments.label"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.code)).toEqual(["join_fans_out"]);
    expect(r.refusals[0]!.next).toContain("sl check-join --source shop --model customers --join segment");
    const cli = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["orders.n"], dimensions: ["segments.label"] }))]);
    expect(cli.code).toBe(1);
    expect(cli.err).toContain("sl check-join --source shop --model customers --join segment");
  });

  test("joins follow reading order: a WHERE filter's request join before a HAVING filter's definition join", async () => {
    const { root } = await edgeShop();
    const c = compiled(
      compileRequest(
        root,
        req({ measures: ["orders.n"], filters: [{ field: "orders.real_n", op: "gt", value: 0 }, { field: "customers.region", op: "eq", value: "NE" }] }),
      ),
    );
    // WHERE reads before HAVING, so the WHERE filter's request join comes first.
    expect(c.joins.map((j) => j.alias)).toEqual(["orders.customer", "orders~customer"]);
    expect(c.params).toEqual(["NE", 0]);
  });

  test("the same request compiles to the same SQL and joins twice", async () => {
    const { root } = await edgeShop();
    const r = req({ measures: ["orders.real_n"], dimensions: ["segments.label", "customers.region"], filters: [{ field: "orders.parent_status", op: "eq", value: "done" }] });
    const a = compiled(compileRequest(root, r));
    const b = compiled(compileRequest(root, JSON.parse(JSON.stringify(r))));
    expect(b.sql).toBe(a.sql);
    expect(b.joins).toEqual(a.joins);
  });
});

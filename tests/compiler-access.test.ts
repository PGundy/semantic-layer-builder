import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { readCsvSql, WAREHOUSE_TABLES } from "../fixtures/acme/schema.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import type { Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, reapprove, sl, tempRoot, uniqueSchema } from "./helpers.ts";

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
      return [...((await tx.unsafe(c.sql, c.params as never[])) as Row[])];
    });
  } finally {
    await db.close();
  }
}

// --- a small synthetic shop: orders -> customers -> regions, order lines -> orders, a closure ---

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const str = { type: "string", ...ok };
const num = { type: "number", ...ok };
const CUSTOMER = [{ from: "customer_id", to: "customer_id" }];

function shopModels(): Record<string, Model> {
  return {
    orders: {
      model: "orders",
      source: "shop",
      table: "main.orders",
      ...ok,
      dimensions: [
        { name: "status", expr: "status", ...str },
        { name: "region", expr: "region", ...str },
        { name: "rep_id", expr: "rep_id", ...num },
      ],
      measures: [
        { name: "order_count", agg: "count", ...ok },
        { name: "real_count", agg: "count", filter: "coalesce(customer.is_test, false) = false", ...ok },
      ],
      joins: [{ name: "customer", to: "customers", keys: CUSTOMER, relationship: "many_to_one", type: "left", ...ok }],
    },
    customers: {
      model: "customers",
      source: "shop",
      table: "main.customers",
      ...ok,
      dimensions: [
        { name: "home", expr: "home_code", ...str },
        { name: "home_name", expr: "home.name", ...str },
      ],
      measures: [{ name: "customer_count", agg: "count", ...ok }],
      joins: [{ name: "home", to: "regions", keys: [{ from: "home_code", to: "code" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    regions: { model: "regions", source: "shop", table: "main.regions", ...ok, dimensions: [{ name: "name", expr: "name", ...str }], measures: [] },
    lines: {
      model: "lines",
      source: "shop",
      table: "main.lines",
      ...ok,
      dimensions: [{ name: "order_id", expr: "order_id", ...num }],
      measures: [{ name: "line_count", agg: "count", ...ok }],
      joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "order_id" }], relationship: "many_to_one", type: "left", ...ok }],
    },
    closure: { model: "closure", source: "shop", table: "main.closure", ...ok, dimensions: [{ name: "manager_id", expr: "manager_id", ...num }], measures: [] },
  } as unknown as Record<string, Model>;
}

const SHOP = [
  "create table orders (order_id integer, customer_id integer, rep_id integer, region varchar, status varchar)",
  "insert into orders values (1, 10, 101, 'NE', 'done'), (2, 10, 102, 'NE', 'done'), (3, 11, 103, 'WC', 'done'), (4, 12, 201, 'SE', 'open'), (5, 99, 101, 'NE', 'done')",
  "create table customers (customer_id integer, home_code varchar, is_test boolean, team varchar)",
  "insert into customers values (10, 'NE', false, 'a'), (11, 'WC', true, 'b'), (12, 'SE', false, 'a')",
  "create table regions (code varchar, name varchar, area varchar)",
  "insert into regions values ('NE', 'Northeast', 'east'), ('WC', 'West Coast', 'west'), ('SE', 'Southeast', 'east')",
  "create table lines (line_id integer, order_id integer)",
  "insert into lines values (1, 1), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5)",
  "create table closure (manager_id integer, member_id integer)",
  "insert into closure values (201, 101), (201, 102), (301, 101), (301, 102), (301, 103), (301, 201)",
];

const hierarchy = (column: string, extra: Record<string, unknown> = {}) => ({
  hierarchy: { column, via: "shop.closure", manager: "manager_id", member: "member_id", user: "user.employee_id", ...extra },
});

function shopAccess(): Record<string, unknown> {
  return {
    ...ok,
    mode: "open",
    user_attributes: [
      { name: "region", type: "string" },
      { name: "regions", type: "string_list" },
      { name: "team", type: "string" },
      { name: "employee_id", type: "number" },
    ],
    roles: [
      { name: "rep", assign_when: "user.region is set", row_filters: [{ model: "shop.orders", expr: "region = {{ user.region }}" }] },
      { name: "multi", row_filters: [{ model: "shop.orders", expr: "region in {{ user.regions }}" }] },
      { name: "teamlead", row_filters: [{ model: "shop.customers", expr: "team = {{ user.team }}" }] },
      { name: "east", row_filters: [{ model: "shop.customers", expr: "home.area = 'east'" }] },
      { name: "real", row_filters: [{ model: "shop.orders", expr: "coalesce(customer.is_test, false) = false and status = {{ user.team }}" }] },
      { name: "manager", row_filters: [{ model: "shop.orders", ...hierarchy("rep_id") }, { model: "shop.lines", ...hierarchy("order.rep_id") }] },
      { name: "viewer" },
    ],
  };
}

async function shop(access: (a: Record<string, unknown>) => void = () => {}, edit: (m: Record<string, Model>) => void = () => {}) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", SHOP);
  const models = shopModels();
  edit(models);
  for (const m of Object.values(models)) writeYaml(join(t.root, "models", "shop", `${m.model}.yaml`), m);
  const a = shopAccess();
  access(a);
  writeYaml(join(t.root, "access.yaml"), a);
  return { root: t.root, file: src.connection!.database! };
}

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const as = (role: string | undefined, user: Record<string, unknown> = {}) => ({ ...(role ? { role } : {}), user });
const roleOf = (a: Record<string, unknown>, name: string) => (a.roles as Record<string, unknown>[]).find((r) => r.name === name)!;

describe("a row filter on the base model", () => {
  test("goes in WHERE before the request's filters, its attribute a bound parameter", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"], filters: [{ field: "orders.status", op: "eq", value: "done" }] }), as(undefined, { region: "NE" })));
    expect(c.sql).toBe(["select", `  count(*) as "order_count"`, `from "main"."orders"`, "where (region = $1)", "  and (status) = $2"].join("\n"));
    expect(c.params).toEqual(["NE", "done"]);
    expect(c.row_filters).toEqual([{ model: "orders", alias: "orders", in: "where", roles: ["rep"], rows: "filtered" }]);
    expect(await runDuckdb(file, c)).toEqual([{ order_count: "3" }]);
    // The default audience holds no role, so no row filter applies.
    const all = compiled(compileRequest(root, req({ measures: ["orders.order_count"] })));
    expect(all.row_filters).toEqual([]);
    expect(await runDuckdb(file, all)).toEqual([{ order_count: "5" }]);
  });

  test("one that reads through a join adds it as a definition join, shared with a field that reads the same chain", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.real_count", "orders.order_count"] }), as("real", { team: "done" })));
    expect(c.sql).toBe(
      [
        "select",
        `  count(*) filter (where coalesce("orders~customer".is_test, false) = false) as "real_count",`,
        `  count(*) as "order_count"`,
        `from "main"."orders" as "orders"`,
        `left join "main"."customers" as "orders~customer" on "orders"."customer_id" = "orders~customer"."customer_id"`,
        `where (coalesce("orders~customer".is_test, false) = false and "orders".status = $1)`,
      ].join("\n"),
    );
    expect(c.joins.map((j) => `${j.for}:${j.alias}`)).toEqual(["definition:orders~customer"]);
    // Order 3 is a test account's; order 4 is open; order 5's customer is missing and counts.
    expect(await runDuckdb(file, c)).toEqual([{ real_count: "3", order_count: "3" }]);
    // The query reads only orders' table otherwise, and the filter's join still qualifies it.
    const only = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("real", { team: "done" })));
    expect(only.sql).toContain(`from "main"."orders" as "orders"\nleft join "main"."customers" as "orders~customer"`);
    expect(await runDuckdb(file, only)).toEqual([{ order_count: "3" }]);
  });

  test("a list attribute binds one parameter per element for IN, inside the parentheses the expr writes or its own", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("multi", { regions: ["NE", "SE"] })));
    expect(c.sql).toContain("where (region in ($1, $2))");
    expect(c.params).toEqual(["NE", "SE"]);
    expect(await runDuckdb(file, c)).toEqual([{ order_count: "4" }]);
    const { root: r2, file: f2 } = await shop((a) => {
      (roleOf(a, "multi").row_filters as Record<string, unknown>[])[0]!.expr = "region in ( {{ user.regions }} ) -- the user's regions";
    });
    const c2 = compiled(compileRequest(r2, req({ measures: ["orders.order_count"] }), as("multi", { regions: ["WC"] })));
    expect(c2.sql).toContain("where (region in ( $1 ) -- the user's regions\n)");
    expect(await runDuckdb(f2, c2)).toEqual([{ order_count: "1" }]);
  });
});

describe("a row filter on a model a request path reaches", () => {
  test("goes in that join's ON clause: a left join keeps every base row with the joined columns blank, an inner join drops them", async () => {
    const { root, file } = await shop();
    const request = req({ measures: ["orders.order_count"], dimensions: ["customers.home"], order_by: [{ field: "customers.home" }] });
    const c = compiled(compileRequest(root, request, as("teamlead", { team: "a" })));
    expect(c.sql).toContain(`left join "main"."customers" as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id" and ("orders.customer".team = $1)`);
    expect(c.sql).not.toContain("where");
    expect(c.row_filters).toEqual([{ model: "customers", alias: "orders.customer", in: "on", roles: ["teamlead"], rows: "filtered" }]);
    // Customer 11 is on team b: its order keeps counting, with a blank home, as order 5's missing customer does.
    expect(await runDuckdb(file, c)).toEqual([
      { home: "NE", order_count: "2" },
      { home: "SE", order_count: "1" },
      { home: null, order_count: "2" },
    ]);
    const { root: r2, file: f2 } = await shop(undefined, (m) => {
      m.orders!.joins![0]!.type = "inner";
    });
    const inner = compiled(compileRequest(r2, request, as("teamlead", { team: "a" })));
    expect(inner.sql).toContain(`inner join "main"."customers" as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id" and ("orders.customer".team = $1)`);
    expect(await runDuckdb(f2, inner)).toEqual([
      { home: "NE", order_count: "2" },
      { home: "SE", order_count: "1" },
    ]);
  });

  test("one that reads through joins nests them inside the path's join, apart from a field's definition join along the same chain", async () => {
    const { root, file } = await shop();
    const c = compiled(
      compileRequest(root, req({ measures: ["orders.order_count"], dimensions: ["customers.home_name"], order_by: [{ field: "customers.home_name" }] }), as("east")),
    );
    expect(c.sql).toBe(
      [
        "select",
        `  "orders.customer~home".name as "home_name",`,
        `  count(*) as "order_count"`,
        `from "main"."orders" as "orders"`,
        `left join ("main"."customers" as "orders.customer"`,
        `  left join "main"."regions" as "orders.customer~row_filter~home" on "orders.customer"."home_code" = "orders.customer~row_filter~home"."code") on "orders"."customer_id" = "orders.customer"."customer_id" and ("orders.customer~row_filter~home".area = 'east')`,
        `left join "main"."regions" as "orders.customer~home" on "orders.customer"."home_code" = "orders.customer~home"."code"`,
        "group by 1",
        "order by 1 asc nulls last",
      ].join("\n"),
    );
    expect(c.joins.map((j) => `${j.for}:${j.alias}`)).toEqual(["request:orders.customer", "definition:orders.customer~row_filter~home", "definition:orders.customer~home"]);
    expect(await runDuckdb(file, c)).toEqual([
      { home_name: "Northeast", order_count: "2" },
      { home_name: "Southeast", order_count: "1" },
      { home_name: null, order_count: "2" },
    ]);
  });

  test("a hierarchy filter, and a second hop's own row filter, go in the ON clause of the join that reaches their model", async () => {
    const { root, file } = await shop((a) => {
      (a.roles as unknown[]).push(
        { name: "lead", row_filters: [{ model: "shop.orders", ...hierarchy("rep_id") }] },
        { name: "west", row_filters: [{ model: "shop.regions", expr: "area = {{ user.team }}" }] },
      );
    });
    const lines = req({ measures: ["lines.line_count"], dimensions: ["orders.status"], order_by: [{ field: "orders.status" }] });
    const c = compiled(compileRequest(root, lines, as("lead", { employee_id: 201 })));
    expect(c.sql).toContain(
      `left join "main"."orders" as "lines.order" on "lines"."order_id" = "lines.order"."order_id" and ("lines.order".rep_id = $1 or "lines.order".rep_id in (select "closure"."member_id" from "main"."closure" as "closure" where "closure"."manager_id" = $2))`,
    );
    expect(c.row_filters).toEqual([{ model: "orders", alias: "lines.order", in: "on", roles: ["lead"], rows: "filtered" }]);
    // Order 3's line keeps counting with a blank status; the other five lines are 201's or below.
    expect(await runDuckdb(file, c)).toEqual([
      { status: "done", line_count: "4" },
      { status: "open", line_count: "1" },
      { status: null, line_count: "1" },
    ]);
    const two = compiled(compileRequest(root, req({ measures: ["orders.order_count"], dimensions: ["regions.name"], order_by: [{ field: "regions.name" }] }), as("west", { team: "west" })));
    expect(two.sql).toContain(`as "orders.customer.home" on "orders.customer"."home_code" = "orders.customer.home"."code" and ("orders.customer.home".area = $1)`);
    expect(two.row_filters).toEqual([{ model: "regions", alias: "orders.customer.home", in: "on", roles: ["west"], rows: "filtered" }]);
    expect(await runDuckdb(file, two)).toEqual([
      { name: "West Coast", order_count: "1" },
      { name: null, order_count: "4" },
    ]);
  });

  test("a definition join never carries the target's row filter", async () => {
    const { root, file } = await shop();
    const lead = as("teamlead", { team: "a" });
    const everyone = compiled(compileRequest(root, req({ measures: ["orders.real_count"] })));
    const filtered = compiled(compileRequest(root, req({ measures: ["orders.real_count"] }), lead));
    expect(filtered.sql).toBe(everyone.sql);
    expect(filtered.row_filters).toEqual([]);
    expect(await runDuckdb(file, filtered)).toEqual([{ real_count: "4" }]);
    const both = compiled(compileRequest(root, req({ measures: ["orders.real_count"], dimensions: ["customers.home"] }), lead));
    expect(both.sql).toContain(`as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id" and ("orders.customer".team = $1)`);
    expect(both.sql).toContain(`left join "main"."customers" as "orders~customer" on "orders"."customer_id" = "orders~customer"."customer_id"\n`);
    // Test account 11 stays out of real_count although the team filter blanks its customer row.
    const rows = await runDuckdb(file, both);
    expect(rows.reduce((n, r) => n + Number(r.real_count), 0)).toBe(4);
  });
});

describe("hierarchy row filters", () => {
  test("the column equals the user's id or a member below them in the closure, the id bound once per use, the closure read without row filters", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: 201 })));
    expect(c.sql).toBe(
      [
        "select",
        `  count(*) as "order_count"`,
        `from "main"."orders"`,
        `where (rep_id = $1 or rep_id in (select "closure"."member_id" from "main"."closure" as "closure" where "closure"."manager_id" = $2))`,
      ].join("\n"),
    );
    expect(c.params).toEqual([201, 201]);
    expect(await runDuckdb(file, c)).toEqual([{ order_count: "4" }]);
    expect(await runDuckdb(file, compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: 301 }))))).toEqual([
      { order_count: "5" },
    ]);
    expect(await runDuckdb(file, compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: 103 }))))).toEqual([
      { order_count: "1" },
    ]);
  });

  test("without include_self only members below the user; a column read through a join adds that join", async () => {
    const { root, file } = await shop((a) => {
      (roleOf(a, "manager").row_filters as Record<string, unknown>[])[0] = { model: "shop.orders", ...hierarchy("rep_id", { include_self: false }) };
    });
    const own = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: 201 })));
    expect(own.sql).toContain(`where (rep_id in (select "closure"."member_id" from "main"."closure" as "closure" where "closure"."manager_id" = $1))`);
    expect(await runDuckdb(file, own)).toEqual([{ order_count: "3" }]);
    const lines = compiled(compileRequest(root, req({ measures: ["lines.line_count"] }), as("manager", { employee_id: 201 })));
    expect(lines.sql).toBe(
      [
        "select",
        `  count(*) as "line_count"`,
        `from "main"."lines" as "lines"`,
        `left join "main"."orders" as "lines~order" on "lines"."order_id" = "lines~order"."order_id"`,
        `where ("lines~order".rep_id = $1 or "lines~order".rep_id in (select "closure"."member_id" from "main"."closure" as "closure" where "closure"."manager_id" = $2))`,
      ].join("\n"),
    );
    expect(lines.joins).toEqual([{ alias: "lines~order", via: "lines.order", model: "orders", type: "left", for: "definition" }]);
    // The lines of orders 1, 2, 4 and 5.
    expect(await runDuckdb(file, lines)).toEqual([{ line_count: "5" }]);
  });

  test("a closure model in another source is refused as a layer error", async () => {
    const { root } = await shop((a) => {
      (roleOf(a, "manager").row_filters as Record<string, unknown>[])[0] = { model: "shop.orders", ...hierarchy("rep_id", { via: "lake.closure" }) };
    });
    writeYaml(join(root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb", connection: { database: ":memory:" } });
    writeYaml(join(root, "models", "lake", "closure.yaml"), { ...shopModels().closure!, source: "lake" });
    const r = refused(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: 201 })));
    expect(r.refusals.map((x) => x.code)).toEqual(["invalid_layer"]);
    expect(r.reason).toContain("reads lake.closure, which is not a model of source shop");
  });
});

describe("users with no rows, several roles, and attribute values", () => {
  test("a user who lacks a row filter's attribute reads false: no rows of the base model, blank columns through a left join", async () => {
    const { root, file } = await shop();
    const base = compiled(compileRequest(root, req({ measures: ["orders.order_count"], filters: [{ field: "orders.status", op: "eq", value: "done" }] }), as("rep")));
    expect(base.sql).toContain("where false\n  and (status) = $1");
    expect(base.params).toEqual(["done"]);
    expect(base.row_filters).toEqual([{ model: "orders", alias: "orders", in: "where", roles: ["rep"], rows: "none" }]);
    expect(await runDuckdb(file, base)).toEqual([{ order_count: "0" }]);
    for (const user of [as("manager"), as("multi", { regions: [] })]) expect(await runDuckdb(file, compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), user)))).toEqual([{ order_count: "0" }]);
    const joined = compiled(compileRequest(root, req({ measures: ["orders.order_count"], dimensions: ["customers.home"] }), as("teamlead")));
    expect(joined.sql).toContain(`"orders"."customer_id" = "orders.customer"."customer_id" and false`);
    expect(await runDuckdb(file, joined)).toEqual([{ home: null, order_count: "5" }]);
  });

  test("across held roles the rows are the union, and a held role without a filter on the model lifts it", async () => {
    const { root, file } = await shop();
    const both = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { region: "WC", employee_id: 201 })));
    expect(both.sql).toContain(`where ((rep_id = $1 or rep_id in (select "closure"."member_id" from "main"."closure" as "closure" where "closure"."manager_id" = $2)) or (region = $3))`);
    expect(both.params).toEqual([201, 201, "WC"]);
    expect(both.row_filters[0]!.roles).toEqual(["manager", "rep"]);
    expect(await runDuckdb(file, both)).toEqual([{ order_count: "5" }]);
    // One role without the attribute contributes no rows; the other still does.
    const half = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { region: "WC" })));
    expect(half.sql).toContain("where (region = $1)");
    expect(await runDuckdb(file, half)).toEqual([{ order_count: "1" }]);
    const viewer = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("viewer", { region: "WC" })));
    expect(viewer.row_filters).toEqual([]);
    expect(await runDuckdb(file, viewer)).toEqual([{ order_count: "5" }]);
  });

  test("hostile attribute values stay bound parameters and never enter the SQL text", async () => {
    const { root, file } = await shop();
    const hostile = ["NE' or '1'='1", "NE'); select 1; --", "$1", "{{ user.region }}", 'NE" or "x"="x'];
    for (const value of hostile) {
      const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as(undefined, { region: value })));
      expect(c.sql).toBe(["select", `  count(*) as "order_count"`, `from "main"."orders"`, "where (region = $1)"].join("\n"));
      expect(c.params).toEqual([value]);
      expect(await runDuckdb(file, c)).toEqual([{ order_count: "0" }]);
    }
    const list = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("multi", { regions: ["NE", "' or 1=1 --"] })));
    expect(list.sql).toContain("where (region in ($1, $2))");
    expect(await runDuckdb(file, list)).toEqual([{ order_count: "3" }]);
    const id = compiled(compileRequest(root, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: "201 or 1=1" })));
    expect(id.sql).not.toContain("1=1");
    expect(id.params).toEqual(["201 or 1=1", "201 or 1=1"]);
    expect(await runDuckdb(file, id).catch(() => [])).not.toEqual([{ order_count: "5" }]);
  });

  test("a placeholder inside a string or a comment, and an attribute that is an object, are refused", async () => {
    const { root } = await shop((a) => {
      (roleOf(a, "rep").row_filters as Record<string, unknown>[])[0]!.expr = "region = '{{ user.region }}'";
    });
    const r = refused(compileRequest(root, req({ measures: ["orders.order_count"] }), as(undefined, { region: "NE" })));
    expect(r.refusals).toEqual([
      {
        code: "invalid_layer",
        message: "role rep's row filter on shop.orders has a {{ user.<attribute> }} inside a string or a comment, where it cannot be bound as a parameter",
        next: "Write the placeholder outside quotes (region = {{ user.region }}, not '{{ user.region }}'). Fix the row filter in access.yaml, run sl validate, and run sl sql again.",
      },
    ]);
    const { root: r2 } = await shop();
    const obj = refused(compileRequest(r2, req({ measures: ["orders.order_count"] }), as(undefined, { region: { a: 1 } })));
    expect(obj.refusals.map((x) => [x.code, x.message])).toEqual([["invalid_request", "user.region is an object; a row filter binds a text, a number, true or false, or a list of them"]]);
  });

  test("a parameter marker in a row filter is refused by sl sql and sl validate, so a request's filter value never reaches a row filter", async () => {
    for (const [expr, marker] of [
      ["region = $1", "$1"],
      ["region = ?", "?"],
      ["region = $region", "$region"],
      ["region = {{ user.region }} or region = $2", "$2"],
    ] as const) {
      const { root } = await shop((a) => {
        (roleOf(a, "rep").row_filters as Record<string, unknown>[])[0]!.expr = expr;
      });
      const request = req({ measures: ["orders.order_count"], filters: [{ field: "orders.region", op: "eq", value: "WC" }] });
      const r = refused(compileRequest(root, request, as(undefined, { region: "NE" })));
      expect(r.refusals).toEqual([
        {
          code: "invalid_layer",
          message: `role rep's row filter on shop.orders has the query parameter marker ${marker}; a row filter reads the user's values through {{ user.<attribute> }} only, and only the compiler binds parameters`,
          next: "Fix the row filter in access.yaml, run sl validate, and run sl sql again.",
        },
      ]);
      expect(validateProject(root).filter((i) => i.file === "access.yaml" && i.level === "error").map((i) => [i.path, i.message])).toContainEqual([
        "roles[0].row_filters[0].expr",
        `has the query parameter marker ${marker}; a row filter reads the user's values through {{ user.<attribute> }} only, and only the compiler binds parameters`,
      ]);
    }
    // With the placeholder, the request's WC can only narrow the NE rep's rows, never widen them.
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, req({ measures: ["orders.order_count"], filters: [{ field: "orders.region", op: "eq", value: "WC" }] }), as(undefined, { region: "NE" })));
    expect(c.sql).toContain("where (region = $1)\n  and (region) = $2");
    expect(c.params).toEqual(["NE", "WC"]);
    expect(await runDuckdb(file, c)).toEqual([{ order_count: "0" }]);
    // Markers inside strings, quoted names and comments are text, not markers.
    const { root: r2 } = await shop((a) => {
      (roleOf(a, "rep").row_filters as Record<string, unknown>[])[0]!.expr = `region = {{ user.region }} and status <> '$1?' /* $2 ? */ -- $3`;
    });
    expect(compiled(compileRequest(r2, req({ measures: ["orders.order_count"] }), as(undefined, { region: "NE" }))).params).toEqual(["NE"]);
  });

  test("a row filter that does not balance its parentheses, holds a semicolon, or writes a placeholder against a name is refused by sl sql and sl validate", async () => {
    for (const [expr, problem] of [
      ["region = {{ user.region }}) or (1 = 1", "closes a parenthesis it never opened; a row filter must balance its parentheses"],
      ["(region = {{ user.region }}", "leaves a parenthesis open; a row filter must balance its parentheses"],
      // Block comments nest as Postgres and DuckDB read them, so the ( is inside the comment.
      ["/* /* */ ( */ ) or (1 = 1)", "closes a parenthesis it never opened; a row filter must balance its parentheses"],
      ["region = 'NE", "has an unclosed string, quoted name or comment"],
      ["region = {{ user.region }};", "has a semicolon; a row filter is one SQL predicate"],
      // With eleven parameters, $1 followed by 1 would read the eleventh.
      ["region = {{ user.region }}1", "writes {{ user.region }} against a name or a number; put a space or an operator between them, so it binds as one parameter"],
      ["region = x{{ user.region }}", "writes {{ user.region }} against a name or a number; put a space or an operator between them, so it binds as one parameter"],
    ] as const) {
      const { root } = await shop((a) => {
        (roleOf(a, "rep").row_filters as Record<string, unknown>[])[0]!.expr = expr;
      });
      for (const request of [req({ measures: ["orders.order_count"] }), req({ measures: ["lines.line_count"], dimensions: ["orders.status"] })]) {
        const got = compileRequest(root, request, as(undefined, { region: "NE" }));
        if (got.ok) throw new Error(`compiled ${expr}: ${got.sql}`);
        expect(got.refusals.map((x) => [x.code, x.message])).toEqual([["invalid_layer", `role rep's row filter on shop.orders ${problem}`]]);
      }
      expect(validateProject(root).filter((i) => i.file === "access.yaml" && i.level === "error").map((i) => [i.path, i.message])).toContainEqual([
        "roles[0].row_filters[0].expr",
        problem,
      ]);
    }
  });

  test("a list attribute outside IN, and a hierarchy id that is not a number or a text, are refused in plain words", async () => {
    const { root } = await shop((a) => {
      (roleOf(a, "multi").row_filters as Record<string, unknown>[])[0]!.expr = "region = any({{ user.regions }})";
    });
    const r = refused(compileRequest(root, req({ measures: ["orders.order_count"] }), as("multi", { regions: ["NE", "WC"] })));
    expect(r.refusals.map((x) => [x.code, x.message])).toEqual([
      ["invalid_layer", "role multi's row filter on shop.orders reads the list user.regions outside IN; a list attribute binds one parameter per element, so it is read only as <column> in {{ user.regions }}"],
    ]);
    const { root: r2 } = await shop();
    for (const [id, shown] of [[true, "true"], ["", "empty text"], [" ", "empty text"]] as const) {
      const h = refused(compileRequest(r2, req({ measures: ["orders.order_count"] }), as("manager", { employee_id: id })));
      expect(h.refusals).toEqual([
        {
          code: "invalid_request",
          message: `user.employee_id is ${shown}; role manager's row filter on shop.orders binds one id, a number or a text`,
          next: "Pass the user's id as a number or a text in --user, and run sl sql again.",
        },
      ]);
    }
  });

  test("parameters are numbered in reading order, ON clauses, WHERE, HAVING, and the same input compiles to the same output", async () => {
    const { root, file } = await shop((a) => {
      (roleOf(a, "teamlead").row_filters as unknown[]).push({ model: "shop.orders", expr: "region in {{ user.regions }}" });
    });
    const request = req({
      measures: ["orders.order_count"],
      dimensions: ["customers.home"],
      filters: [
        { field: "orders.order_count", op: "gt", value: 0 },
        { field: "orders.status", op: "eq", value: "done" },
      ],
      order_by: [{ field: "customers.home" }],
    });
    const user = as("teamlead", { team: "a", regions: ["NE"] });
    const c = compiled(compileRequest(root, request, user));
    expect(c.params).toEqual(["a", "NE", "done", 0]);
    expect(c.sql).toContain(`and ("orders.customer".team = $1)\nwhere ("orders".region in ($2))\n  and ("orders".status) = $3\ngroup by 1\nhaving (count(*)) > $4`);
    expect(c.row_filters.map((r) => `${r.in}:${r.alias}`)).toEqual(["on:orders.customer", "where:orders"]);
    expect(compileRequest(root, request, user)).toEqual(c);
    expect(await runDuckdb(file, c)).toEqual([
      { home: "NE", order_count: "2" },
      { home: null, order_count: "1" },
    ]);
  });

  test("sl sql names the row filters it applies, and a model of which the user sees no rows", async () => {
    const { root } = await shop();
    const r = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["orders.order_count"], dimensions: ["customers.home"] })), "--role", "teamlead"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This user sees no rows of customers (role teamlead), so the SQL reads false in the ON clause of its join orders.customer; sl access --user '{}' --roles teamlead says why.");
    const rep = await sl(root, ["sql", "--request", JSON.stringify(req({ measures: ["orders.order_count"] })), "--user", '{"region":"NE"}']);
    expect(rep.out).toContain("Row filters of role rep limit orders in WHERE, with the user's attributes bound as parameters.");
    expect(rep.out).toContain('Parameters, bound in order: $1 = "NE"');
  });
});

// --- Acme: a row-filtered user's query never returns rows outside their filter ---------------

function acmeCopy(dialect: "duckdb" | "postgres", schema: string, database?: string): string {
  const t = tempRoot();
  const outer = cleanup;
  cleanup = () => {
    outer?.();
    t.cleanup();
  };
  cpSync(ACME, t.root, { recursive: true });
  const dir = join(t.root, "models", "warehouse");
  for (const f of readdirSync(dir)) {
    const m = readYaml<Model>(join(dir, f));
    m.table = m.table.replace(/^acme\./, `${schema}.`);
    writeYaml(join(dir, f), m);
  }
  const conn = dialect === "duckdb" ? `connection:\n  database: ${JSON.stringify(database)}\n` : "connection:\n  env: PG_URL\n";
  writeFileSync(join(t.root, "sources", "warehouse.yaml"), `source: warehouse\ndialect: ${dialect}\n${conn}`);
  return t.root;
}

// The Acme warehouse as a DuckDB file: the CSVs and fixtures/acme/evolve.sql in DuckDB's dialect.
async function acmeDuckdb(): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  const file = join(t.dir, "warehouse.duckdb");
  const instance = await DuckDBInstance.create(file);
  const cx = await instance.connect();
  await cx.run("create schema acme");
  for (const tb of WAREHOUSE_TABLES) await cx.run(`create table acme.${tb.name} as select * from ${readCsvSql(join(DATA, "warehouse", `${tb.name}.csv`), tb)}`);
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
  return file;
}

// For every sales person, a manager with no reports below them and users with no or an unknown id:
// the reps their compiled orders and order-line queries return are only those their hierarchy allows
// (themselves and everyone below them in the closure), and every row they allow is returned.
async function onlyOwnRows(root: string, schema: string, run: (c: { sql: string; params: unknown[] }) => Promise<Row[]>): Promise<void> {
  const closure = await run({ sql: `select manager_id, member_id from ${schema}.sales_team_closure`, params: [] });
  const repOf = new Map((await run({ sql: `select order_id, sales_rep_id from ${schema}.fct_orders`, params: [] })).map((r) => [Number(r.order_id), Number(r.sales_rep_id)]));
  const people = [...new Set([...repOf.values()])].sort((a, b) => a - b);
  expect(people.length).toBeGreaterThan(10);
  const byRep = req({ source: "warehouse", measures: ["orders.order_count"], dimensions: ["orders.sales_rep_id"] } as never);
  const lines = req({ source: "warehouse", dimensions: ["order_items.order_id"] } as never);
  for (const id of [...people, 999, undefined]) {
    const user = { department: "sales", ...(id === undefined ? {} : { employee_id: id }) };
    const allowed = new Set(id === undefined ? [] : [id, ...closure.filter((r) => Number(r.manager_id) === id).map((r) => Number(r.member_id))]);
    const reps = (await run(compiled(compileRequest(root, byRep, as(undefined, user))))).map((r) => Number(r.sales_rep_id));
    expect({ id, reps: reps.filter((r) => !allowed.has(r)) }).toEqual({ id, reps: [] });
    expect(new Set(reps)).toEqual(new Set(people.filter((p) => allowed.has(p))));
    const orders = (await run(compiled(compileRequest(root, lines, as(undefined, user))))).map((r) => Number(r.order_id));
    expect({ id, outside: orders.filter((o) => !allowed.has(repOf.get(o)!)) }).toEqual({ id, outside: [] });
    expect(orders.length).toBe([...repOf].filter(([, rep]) => allowed.has(rep)).length);
  }
  // The analyst holds no row filter and sees every rep.
  const analyst = (await run(compiled(compileRequest(root, byRep, as(undefined, { department: "analytics" }))))).map((r) => Number(r.sales_rep_id));
  expect(analyst.sort((a, b) => a - b)).toEqual(people);
}

describe("Acme's sales row filters (invariant: a row-filtered user sees only their rows)", () => {
  test("on duckdb, every sales user's orders and order lines stay inside their hierarchy", async () => {
    const file = await acmeDuckdb();
    const root = acmeCopy("duckdb", "acme", file);
    await onlyOwnRows(root, "acme", (c) => runDuckdb(file, c));
  }, 60_000);

  test.skipIf(!PG_URL)(
    "on postgres, every sales user's orders and order lines stay inside their hierarchy",
    async () => {
      assertLocalPg(PG_URL);
      const schema = uniqueSchema("sl_access");
      const db = new SQL({ url: PG_URL!, max: 1 });
      try {
        await loadPostgres(PG_URL!, DATA, schema);
        await db.unsafe(readFileSync(join(DATA, "..", "evolve.sql"), "utf8").replace(/(?<!@)\bacme\./g, `${schema}.`));
        const root = acmeCopy("postgres", schema);
        // The copy reads the test schema, which changes approved models; the owner approves them again.
        await reapprove(root);
        await onlyOwnRows(root, schema, runPg);
      } finally {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await db.close();
      }
    },
    120_000,
  );
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { evaluateJoin, nounForms } from "../skills/semantic-layer/scripts/lib/joins.ts";
import { joinCheckPlan, joinCheckSql } from "../skills/semantic-layer/scripts/lib/sql/join-check.ts";
import type { JoinEvidence, Model, QueryPlan, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { FIXED_NOW, PG_URL, duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

interface CheckOut {
  source: string;
  checks: { model: string; join: string; evidence: JoinEvidence; findings: { level: string; message: string }[]; sentence: string }[];
  skipped: { model: string; join: string; reason: string }[];
}

const DATA = [
  "create table customers as select range + 1 as customer_id, 'c' || range as name from range(10)",
  // 20 orders: 17 point at customers 1..10, two at a missing customer 99, one has no customer.
  "create table orders as select range + 1 as order_id, case when range < 17 then (range % 10) + 1 when range < 19 then 99 else null end as customer_id from range(20)",
  // customer 1 appears three times.
  "create table dup_customers as select * from customers union all select 1, 'again' union all select 1, 'and again'",
  "create table customer_profiles as select range + 1 as customer_id, 'tier' as tier from range(10)",
  "create table order_lines as select o.range + 1 as order_id, l.range + 1 as line_no from range(5) o, range(2) l",
  "create table shipments (shipment_id integer, order_id integer, line_no integer)",
  "insert into shipments values (1, 1, 1), (2, 1, 2), (3, 2, 1), (4, 2, 1), (5, 9, 1), (6, 3, null), (7, 5, 3)",
  "create table empty_orders (order_id integer, customer_id integer)",
  "create table keyless_orders as select range + 1 as order_id, null::integer as customer_id from range(4)",
  // Employee 1 manages 2 and 3, employee 2 manages 4; employee 1 has no manager.
  "create table employees (employee_id integer, manager_id integer)",
  "insert into employees values (1, null), (2, 1), (3, 1), (4, 2)",
];

function snapshot(source: string, tables: Record<string, string[]>): Snapshot {
  return {
    snapshot_version: 1,
    source,
    dialect: "duckdb",
    captured_at: FIXED_NOW,
    method: "live",
    tables: Object.entries(tables).map(([name, cols]) => ({
      schema: "main",
      name,
      kind: "table" as const,
      columns: cols.map((c) => ({ name: c, type: "integer" })),
    })),
  };
}

const ORDERS_YAML = `# Orders, hand-written by the owner.
model: orders
source: wh
table: main.orders   # the raw table
status: draft
dimensions: []
measures: []
joins:
  # Every order has one customer.
  - name: customer
    to: customers
    keys:
      - { from: customer_id, to: customer_id }
    relationship: many_to_one   # owner says so
    status: approved
    approved_by: Dana Ruiz
    approved_at: 2026-01-01
    evidence:
      checked_at: 2020-01-01T00:00:00.000Z
      left_rows: 1
      left_null_keys: 0
      matched_rows: 1
      match_rate: 1
      right_rows: 1
      right_key_unique: true
      left_key_unique: true
      max_fanout: 1
      suggested_relationship: one_to_one
  - name: dup_customer
    to: dup_customers
    keys:
      - { from: customer_id, to: customer_id }
    relationship: many_to_one
    status: draft
`;

const CUSTOMERS_YAML = `model: customers
source: wh
table: customers
status: draft
dimensions: []
measures: []
joins:
  - name: profile   # one profile per customer
    to: customer_profiles
    keys:
      - { from: customer_id, to: customer_id }
    relationship: one_to_one
    status: draft
  - name: orders
    to: orders
    keys:
      - { from: customer_id, to: customer_id }
    relationship: one_to_many
    status: draft
`;

const SHIPMENTS_YAML = `model: shipments
source: wh
table: main.shipments
status: draft
dimensions: []
measures: []
joins:
  - name: line
    to: order_lines
    keys: # composite
      - { from: order_id, to: order_id }
      - { from: line_no, to: line_no }
    relationship: many_to_one
    status: draft
`;

function bare(model: string, table: string): string {
  return `model: ${model}\nsource: wh\ntable: ${table}\nstatus: draft\ndimensions: []\nmeasures: []\n`;
}

async function setup(withSnapshot = true) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", DATA);
  const dir = join(t.root, "models", "wh");
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    orders: ORDERS_YAML,
    customers: CUSTOMERS_YAML,
    shipments: SHIPMENTS_YAML,
    dup_customers: bare("dup_customers", "dup_customers"),
    customer_profiles: bare("customer_profiles", "customer_profiles"),
    order_lines: bare("order_lines", "main.order_lines"),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.yaml`), text);
  if (withSnapshot) {
    writeJson(
      join(t.root, "snapshots", "wh.json"),
      snapshot("wh", {
        customer_profiles: ["customer_id", "tier"],
        customers: ["customer_id", "name"],
        dup_customers: ["customer_id", "name"],
        order_lines: ["order_id", "line_no"],
        orders: ["order_id", "customer_id"],
        shipments: ["shipment_id", "order_id", "line_no"],
        empty_orders: ["order_id", "customer_id"],
        keyless_orders: ["order_id", "customer_id"],
        employees: ["employee_id", "manager_id"],
      }),
    );
  }
  const modelPath = (m: string) => join(dir, `${m}.yaml`);
  const read = (m: string) => readFileSync(modelPath(m), "utf8");
  const model = (m: string) => readYaml<Model>(modelPath(m));
  return { ...t, modelPath, read, model };
}

describe("evaluateJoin", () => {
  const row = (o: Partial<Record<string, number>>) => ({
    left_rows: 100,
    left_null_keys: 0,
    matched_rows: 100,
    right_rows: 50,
    right_distinct_keys: 50,
    right_max_dup: 1,
    left_distinct_keys: 50,
    left_max_dup: 2,
    ...o,
  });

  test("classifies relationships from key uniqueness", () => {
    expect(evaluateJoin(row({}), "many_to_one").evidence.suggested_relationship).toBe("many_to_one");
    expect(evaluateJoin(row({ left_max_dup: 1 }), "one_to_one").evidence.suggested_relationship).toBe("one_to_one");
    expect(evaluateJoin(row({ left_max_dup: 1, right_max_dup: 4 }), "one_to_many").evidence.suggested_relationship).toBe("one_to_many");
    expect(evaluateJoin(row({ right_max_dup: 3 }), "many_to_one").evidence.suggested_relationship).toBe("many_to_many");
  });

  test("rounds the match rate, handles empty tables and string counts", () => {
    const e = evaluateJoin({ ...row({ left_rows: 3, matched_rows: 2, left_distinct_keys: 2, left_max_dup: 2 }) }, "many_to_one", { checkedAt: FIXED_NOW }).evidence;
    expect(e.match_rate).toBe(0.6667);
    expect(e.checked_at).toBe(FIXED_NOW);
    const empty = evaluateJoin(row({ left_rows: 0, matched_rows: 0, left_distinct_keys: 0, left_max_dup: 0 }), "many_to_one", {
      left: "orders",
      right: "customers",
    });
    expect(empty.evidence.match_rate).toBe(0);
    expect(empty.measured).toBe(false);
    expect(empty.sentence).toBe("There are no orders to check, so this join could not be measured.");
    expect(empty.findings).toEqual([{ level: "warn", message: "The orders table has no rows, so this join could not be measured." }]);
    const keyless = evaluateJoin(row({ left_null_keys: 100, matched_rows: 0, left_distinct_keys: 0, left_max_dup: 0 }), "many_to_one", {
      left: "orders",
      right: "customers",
    });
    expect(keyless.measured).toBe(false);
    expect(keyless.findings.map((f) => f.message).join("\n")).not.toContain("declared");
    const noRight = evaluateJoin(row({ matched_rows: 0, right_rows: 0, right_distinct_keys: 0, right_max_dup: 0 }), "many_to_one", {
      left: "orders",
      right: "customers",
    });
    expect(noRight.measured).toBe(false);
    expect(noRight.findings[0]!.message).toContain("customers table has no rows");
    expect(evaluateJoin(row({}), "many_to_one").measured).toBe(true);
    const strings = evaluateJoin({ ...row({}), left_rows: "100", matched_rows: "99" }, "many_to_one");
    expect(strings.evidence.match_rate).toBe(0.99);
    expect(() => evaluateJoin({ ...row({}), left_rows: "lots" }, "many_to_one")).toThrow("invalid left_rows");
  });

  test("rejects missing, null, fractional and inconsistent counts", () => {
    const { right_max_dup: _drop, ...partial } = row({});
    expect(() => evaluateJoin(partial, "many_to_one")).toThrow("missing right_max_dup");
    expect(() => evaluateJoin({ ...row({}), left_rows: null }, "many_to_one")).toThrow("missing left_rows");
    expect(() => evaluateJoin({ ...row({}), left_distinct_keys: undefined }, "many_to_one")).toThrow("missing left_distinct_keys");
    expect(() => evaluateJoin(row({ matched_rows: 2.5 }), "many_to_one")).toThrow("invalid matched_rows");
    expect(() => evaluateJoin({ ...row({}), right_rows: "" }, "many_to_one")).toThrow("invalid right_rows");
    expect(() => evaluateJoin(row({ matched_rows: 105 }), "many_to_one")).toThrow("inconsistent");
    expect(() => evaluateJoin(row({ left_null_keys: 101, matched_rows: 0 }), "many_to_one")).toThrow("inconsistent");
    expect(() => evaluateJoin(row({ right_max_dup: 0 }), "many_to_one")).toThrow("inconsistent");
    expect(() => evaluateJoin(row({ right_max_dup: 51 }), "many_to_one")).toThrow("inconsistent");
  });

  test("fan-out follows the data, not the declaration; a missing relationship reads plainly", () => {
    const declaredFan = evaluateJoin(row({}), "one_to_many", { left: "orders", right: "customers" });
    const messages = declaredFan.findings.map((f) => f.message);
    expect(messages.some((m) => m.includes("fans out"))).toBe(false);
    expect(messages).toContain("The join is declared one_to_many, but the data says many_to_one.");
    const none = evaluateJoin(row({}), undefined, { left: "orders", right: "customers" });
    expect(none.findings.map((f) => f.message)).toContain("The join has no declared relationship; the data says many_to_one.");
    expect(none.findings.map((f) => f.message).join("\n")).not.toContain("undefined");
  });

  test("writes the owner's sentence", () => {
    const r = evaluateJoin(row({ left_rows: 5000, matched_rows: 4960, left_max_dup: 3 }), "many_to_one", { left: "orders", right: "customers" });
    expect(r.sentence).toBe("Each order points to at most one customer, and 99.2% of orders find their customer (40 do not).");
    expect(r.findings).toEqual([{ level: "warn", message: "Match rate is 99.2%: 40 of 5,000 orders find no customer." }]);
    const fan = evaluateJoin(row({ left_max_dup: 1, right_max_dup: 7 }), "many_to_one", { left: "orders", right: "order_items" });
    expect(fan.sentence).toContain("Each order can match up to 7 order items");
    expect(fan.findings.map((f) => f.message).join("\n")).toContain("declared many_to_one, but the data says one_to_many");
    expect(fan.findings.some((f) => f.message.includes("fans out"))).toBe(true);
  });

  test("noun forms", () => {
    expect(nounForms("orders")).toEqual({ one: "order", many: "orders" });
    expect(nounForms("order_items")).toEqual({ one: "order item", many: "order items" });
    expect(nounForms("categories")).toEqual({ one: "category", many: "categories" });
    expect(nounForms("customer")).toEqual({ one: "customer", many: "customers" });
    expect(nounForms("addresses")).toEqual({ one: "address", many: "addresses" });
    expect(nounForms("status")).toEqual({ one: "status", many: "statuses" });
    expect(nounForms("people")).toEqual({ one: "person", many: "people" });
    expect(nounForms("person")).toEqual({ one: "person", many: "people" });
    expect(nounForms("sales_people")).toEqual({ one: "sales person", many: "sales people" });
    expect(nounForms("children")).toEqual({ one: "child", many: "children" });
  });
});

describe("joinCheckSql", () => {
  test("quotes identifiers per dialect and joins every key", () => {
    const keys = [
      { from: "Order ID", to: "order_id" },
      { from: "line", to: "line_no" },
    ];
    const pg = joinCheckSql("postgres", { left: { schema: "sales", name: "Ship" }, right: { schema: null, name: "lines" }, keys });
    expect(pg).toContain(`from "sales"."Ship"`);
    expect(pg).toContain(`"Order ID" as "k0"`);
    expect(pg).toContain(`lk."k0" = rk."k0" and lk."k1" = rk."k1"`);
    const bq = joinCheckSql("bigquery", { left: { schema: "proj.ds", name: "ship" }, right: { name: "lines" }, keys });
    expect(bq).toContain("from `proj`.`ds`.`ship`");
    expect(() => joinCheckSql("duckdb", { left: { name: "a" }, right: { name: "b" }, keys: [] })).toThrow();
  });

  test("one query per check", () => {
    const plan = joinCheckPlan({ source: "wh", dialect: "snowflake" }, [
      { id: "orders.customer", left: { name: "orders" }, right: { name: "customers" }, keys: [{ from: "a", to: "b" }] },
    ]);
    expect(plan.command).toBe("check-join");
    expect(plan.queries.map((q) => q.id)).toEqual(["join:orders.customer"]);
  });
});

describe("check-join on duckdb", () => {
  test("measures orphans and null keys, writes evidence, keeps comments and status", async () => {
    const s = await setup();
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "customer", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<CheckOut>();
    expect(out.source).toBe("wh");
    expect(out.checks).toHaveLength(1);
    const c = out.checks[0]!;
    expect(c.evidence).toEqual({
      checked_at: FIXED_NOW,
      left_rows: 20,
      left_null_keys: 1,
      matched_rows: 17,
      match_rate: 0.85,
      right_rows: 10,
      right_key_unique: true,
      left_key_unique: false,
      max_fanout: 1,
      suggested_relationship: "many_to_one",
    });
    expect(c.sentence).toBe("Each order points to at most one customer, and 85% of orders find their customer (3 do not).");
    const messages = c.findings.map((f) => f.message);
    expect(messages).toContain("Match rate is 85%: 3 of 20 orders find no customer.");
    expect(messages).toContain("1 order has an empty join key, so it never joins.");

    const text = s.read("orders");
    expect(text).toContain("# Orders, hand-written by the owner.");
    expect(text).toContain("# the raw table");
    expect(text).toContain("# Every order has one customer.");
    expect(text).toContain("# owner says so");
    const m = s.model("orders");
    const j = m.joins![0]!;
    expect(j.evidence).toEqual(c.evidence);
    expect(j.status).toBe("approved");
    expect(j.approved_by).toBe("Dana Ruiz");
    expect(j.relationship).toBe("many_to_one");
    expect(Object.keys(j)).toEqual(["name", "to", "keys", "relationship", "status", "approved_by", "approved_at", "evidence"]);
    expect(m.joins![1]!.evidence).toBeUndefined();
  });

  test("many-to-many and a declared relationship that the data contradicts", async () => {
    const s = await setup();
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "dup_customer", "--json"]);
    expect(r.code).toBe(0);
    const c = r.json<CheckOut>().checks[0]!;
    expect(c.evidence.suggested_relationship).toBe("many_to_many");
    expect(c.evidence.right_key_unique).toBe(false);
    expect(c.evidence.max_fanout).toBe(3);
    // Orders for customer 1 match all three of its rows but count once.
    expect(c.evidence.matched_rows).toBe(17);
    const messages = c.findings.map((f) => f.message).join("\n");
    expect(messages).toContain("declared many_to_one, but the data says many_to_many");
    expect(messages).toContain("bridge table");
    expect(s.model("orders").joins![1]!.relationship).toBe("many_to_one");
    expect(s.model("orders").joins![1]!.status).toBe("draft");
  });

  test("--model --all covers one-to-one and one-to-many", async () => {
    const s = await setup();
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "customers", "--all", "--json"]);
    expect(r.code).toBe(0);
    const checks = r.json<CheckOut>().checks;
    expect(checks.map((c) => c.join)).toEqual(["profile", "orders"]);
    const [profile, orders] = checks;
    expect(profile!.evidence.suggested_relationship).toBe("one_to_one");
    expect(profile!.evidence.match_rate).toBe(1);
    expect(profile!.findings).toEqual([]);
    expect(profile!.sentence).toBe(
      "Each customer matches at most one customer profile and each customer profile at most one customer, and every customer finds its customer profile.",
    );
    expect(orders!.evidence.suggested_relationship).toBe("one_to_many");
    expect(orders!.evidence.max_fanout).toBe(2);
    expect(orders!.evidence.left_key_unique).toBe(true);
    expect(orders!.findings.some((f) => f.level === "warn" && f.message.includes("fans out"))).toBe(true);
    expect(orders!.sentence).toContain("every customer finds at least one order");
    const text = s.read("customers");
    expect(text).toContain("# one profile per customer");
    expect(s.model("customers").joins!.every((j) => j.evidence?.checked_at === FIXED_NOW)).toBe(true);
  });

  test("composite keys: a partial key match does not count", async () => {
    const s = await setup();
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "shipments", "--join", "line", "--json"]);
    expect(r.code).toBe(0);
    const e = r.json<CheckOut>().checks[0]!.evidence;
    expect(e).toMatchObject({
      left_rows: 7,
      left_null_keys: 1,
      matched_rows: 4,
      match_rate: 0.5714,
      right_rows: 10,
      right_key_unique: true,
      left_key_unique: false,
      max_fanout: 1,
      suggested_relationship: "many_to_one",
    });
    expect(s.read("shipments")).toContain("# composite");
  });

  test("--all checks every join in the source; --no-write leaves files alone", async () => {
    const s = await setup();
    const before = ["orders", "customers", "shipments"].map((m) => s.read(m));
    const dry = await sl(s.root, ["check-join", "--source", "wh", "--all", "--no-write", "--json"]);
    expect(dry.code).toBe(0);
    const ids = dry.json<CheckOut>().checks.map((c) => `${c.model}.${c.join}`);
    expect(ids.sort()).toEqual(["customers.orders", "customers.profile", "orders.customer", "orders.dup_customer", "shipments.line"]);
    expect(["orders", "customers", "shipments"].map((m) => s.read(m))).toEqual(before);

    const human = await sl(s.root, ["check-join", "--source", "wh", "--all"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("orders.customer -> customers  (declared many_to_one, data says many_to_one)");
    expect(human.out).toContain("Each order points to at most one customer");
    expect(human.out).toContain("warn: ");
    expect(human.out).toContain("Wrote evidence to 5 joins.");
    expect(s.model("shipments").joins![0]!.evidence?.matched_rows).toBe(4);
  });

  test("works without a snapshot", async () => {
    const s = await setup(false);
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "shipments", "--join", "line", "--json", "--no-write"]);
    expect(r.err).toBe("");
    expect(r.json<CheckOut>().checks[0]!.evidence.matched_rows).toBe(4);
  });

  test("--emit-sql then --results gives the same evidence as a live run", async () => {
    const s = await setup();
    const emitted = await sl(s.root, ["check-join", "--source", "wh", "--all", "--emit-sql"]);
    expect(emitted.code).toBe(0);
    const plan = JSON.parse(emitted.out) as QueryPlan;
    expect(plan.command).toBe("check-join");
    expect(plan.queries).toHaveLength(5);
    expect(s.model("orders").joins![1]!.evidence).toBeUndefined();

    const instance = await DuckDBInstance.create(join(s.dir, "wh.duckdb"));
    const conn = await instance.connect();
    const results: Record<string, Record<string, unknown>[]> = {};
    for (const q of plan.queries) {
      const rows = (await conn.runAndReadAll(q.sql)).getRowObjectsJson();
      // Upper-case keys and string numbers, as a warehouse tool might return them.
      results[q.id] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toUpperCase(), String(v)])));
    }
    conn.closeSync();
    instance.closeSync();
    const file = join(s.dir, "results.json");
    writeFileSync(file, JSON.stringify(results));

    const fromFile = await sl(s.root, ["check-join", "--source", "wh", "--all", "--results", file, "--no-write", "--json"]);
    expect(fromFile.err).toBe("");
    const live = await sl(s.root, ["check-join", "--source", "wh", "--all", "--no-write", "--json"]);
    expect(fromFile.json()).toEqual(live.json());

    writeFileSync(file, JSON.stringify({ "join:orders.customer": results["join:orders.customer"] }));
    const missing = await sl(s.root, ["check-join", "--source", "wh", "--all", "--results", file]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("missing results");
  });

  test("errors for unknown models, joins, targets and columns", async () => {
    const s = await setup();
    const cases: [string[], string][] = [
      [["--model", "nope", "--join", "customer"], 'No model "nope"'],
      [["--model", "orders", "--join", "nope"], 'has no join "nope". Joins: customer, dup_customer'],
      [["--join", "customer"], "--join needs --model"],
      [["--model", "orders"], "Pass --join <j> or --all"],
      [[], "Pass --model <m> --join <j>"],
      [["--model", "orders", "--join", "customer", "--all"], "either --join or --all"],
    ];
    for (const [args, message] of cases) {
      const r = await sl(s.root, ["check-join", "--source", "wh", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
    }
    const noSource = await sl(s.root, ["check-join", "--model", "orders", "--join", "customer"]);
    expect(noSource.err).toContain("--source is required");

    writeFileSync(s.modelPath("orders"), ORDERS_YAML.replace("to: dup_customers", "to: ghosts"));
    const ghost = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "dup_customer"]);
    expect(ghost.code).toBe(1);
    expect(ghost.err).toContain('points to "ghosts", which is not a model in source "wh"');

    writeFileSync(s.modelPath("orders"), ORDERS_YAML.replace("{ from: customer_id, to: customer_id }", "{ from: cust, to: customer_id }"));
    const col = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "customer"]);
    expect(col.code).toBe(1);
    expect(col.err).toContain('left key column "cust" is not a column of main.orders');

    writeFileSync(s.modelPath("order_lines"), bare("order_lines", "main.not_there"));
    const table = await sl(s.root, ["check-join", "--source", "wh", "--model", "shipments", "--join", "line"]);
    expect(table.code).toBe(1);
    expect(table.err).toContain("not in the snapshot");
  });
});

describe("check-join edge cases", () => {
  test("rejects names that are not model names, and never writes outside the root", async () => {
    const s = await setup();
    const outside = join(s.dir, "outside");
    mkdirSync(outside, { recursive: true });
    const evil = join(outside, "evil.yaml");
    writeFileSync(evil, ORDERS_YAML);
    const cases: [string[], string][] = [
      [["--source", "wh", "--model", "../../outside/evil", "--join", "customer"], "--model must match"],
      [["--source", "wh", "--model", "orders", "--join", "../x"], "--join must match"],
      [["--source", "../wh", "--all"], "--source must match"],
      [["--source", "wh", "--model", "Orders", "--all"], "--model must match"],
    ];
    for (const [args, message] of cases) {
      const r = await sl(s.root, ["check-join", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(message);
    }
    expect(readFileSync(evil, "utf8")).toBe(ORDERS_YAML);
  });

  test("an empty left table or all-null keys are not measured and write no evidence", async () => {
    const s = await setup();
    const yaml = (model: string, table: string) =>
      `model: ${model}\nsource: wh\ntable: ${table}\nstatus: draft\ndimensions: []\nmeasures: []\njoins:\n  - name: customer\n    to: customers\n    keys:\n      - { from: customer_id, to: customer_id }\n    relationship: many_to_one\n    status: draft\n`;
    writeFileSync(s.modelPath("empty_orders"), yaml("empty_orders", "empty_orders"));
    writeFileSync(s.modelPath("keyless_orders"), yaml("keyless_orders", "keyless_orders"));
    const before = [s.read("empty_orders"), s.read("keyless_orders")];

    const empty = await sl(s.root, ["check-join", "--source", "wh", "--model", "empty_orders", "--join", "customer", "--json"]);
    expect(empty.err).toBe("");
    const e = empty.json<CheckOut>().checks[0]!;
    expect(e.evidence).toBeNull();
    expect(e.sentence).toBe("There are no empty orders to check, so this join could not be measured.");
    expect(e.findings.map((f) => f.message).join("\n")).not.toContain("declared");

    const keyless = await sl(s.root, ["check-join", "--source", "wh", "--model", "keyless_orders", "--join", "customer"]);
    expect(keyless.code).toBe(0);
    expect(keyless.out).toContain("not measured");
    expect(keyless.out).toContain("Every keyless order has an empty join key");
    expect(keyless.out).toContain("Wrote evidence to 0 joins.");
    expect(keyless.out).toContain("1 join was not measured, so no evidence was written for it.");
    expect(keyless.out).not.toContain("one_to_one");
    expect([s.read("empty_orders"), s.read("keyless_orders")]).toEqual(before);
  });

  test("--all skips a join whose target is not modeled yet and measures the rest", async () => {
    const s = await setup();
    writeFileSync(
      s.modelPath("orders"),
      ORDERS_YAML.replace(
        "joins:\n",
        "joins:\n  - name: store\n    to: stores\n    keys:\n      - { from: store_id, to: store_id }\n    relationship: many_to_one\n    status: draft\n",
      ),
    );
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--all", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<CheckOut>();
    expect(out.checks.map((c) => c.join)).toEqual(["customer", "dup_customer"]);
    expect(out.skipped).toEqual([
      { model: "orders", join: "store", reason: 'Join "store" on model "orders" points to "stores", which is not a model in source "wh".' },
    ]);
    expect(s.model("orders").joins!.find((j) => j.name === "customer")!.evidence?.checked_at).toBe(FIXED_NOW);
    expect(s.model("orders").joins!.find((j) => j.name === "store")!.evidence).toBeUndefined();

    const human = await sl(s.root, ["check-join", "--source", "wh", "--all", "--no-write"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain('orders.store: skipped: Join "store" on model "orders" points to "stores"');

    const single = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "store"]);
    expect(single.code).toBe(1);
    expect(single.err).toContain('points to "stores"');
  });

  test("a self-join names the other side by the join, and a draft without a relationship reads plainly", async () => {
    const s = await setup();
    writeFileSync(
      s.modelPath("employees"),
      "model: employees\nsource: wh\ntable: employees\nstatus: draft\ndimensions: []\nmeasures: []\njoins:\n  - name: manager\n    to: employees\n    keys:\n      - { from: manager_id, to: employee_id }\n    status: draft\n",
    );
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "employees", "--join", "manager", "--json", "--no-write"]);
    expect(r.err).toBe("");
    const c = r.json<CheckOut>().checks[0]!;
    expect(c.evidence.suggested_relationship).toBe("many_to_one");
    expect(c.sentence).toBe("Each employee points to at most one manager, and 75% of employees find their manager (1 does not).");
    expect(c.findings.map((f) => f.message)).toContain("The join has no declared relationship; the data says many_to_one.");
    const human = await sl(s.root, ["check-join", "--source", "wh", "--model", "employees", "--join", "manager", "--no-write"]);
    expect(human.out).toContain("(declared none, data says many_to_one)");
    expect(human.out).toContain("matched 3 (75%), unmatched 1");
  });

  test("a malformed results row is refused and nothing is written", async () => {
    const s = await setup();
    const before = s.read("orders");
    const file = join(s.dir, "partial.json");
    writeFileSync(
      file,
      JSON.stringify({ "join:orders.customer": [{ left_rows: 20, left_null_keys: 1, matched_rows: 17, right_rows: 10, left_max_dup: 3 }] }),
    );
    const r = await sl(s.root, ["check-join", "--source", "wh", "--model", "orders", "--join", "customer", "--results", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("join:orders.customer: Join check result is missing right_distinct_keys");
    expect(s.read("orders")).toBe(before);
    expect(existsSync(file)).toBe(true);
  });
});

describe("check-join on a warehouse it cannot run", () => {
  test("emits quoted SQL, refuses to run, and finishes from results", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "snow.yaml"), { source: "snow", dialect: "snowflake", connection: { env: "SNOW_URL" } });
    const dir = join(t.root, "models", "snow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "orders.yaml"),
      "model: orders\nsource: snow\ntable: ANALYTICS.FCT_ORDERS\nstatus: draft\ndimensions: []\nmeasures: []\njoins:\n  - name: customer\n    to: customers\n    keys:\n      - { from: CUSTOMER_ID, to: CUSTOMER_ID }\n    relationship: many_to_one\n    status: draft\n",
    );
    writeFileSync(join(dir, "customers.yaml"), "model: customers\nsource: snow\ntable: ANALYTICS.DIM_CUSTOMERS\nstatus: draft\ndimensions: []\nmeasures: []\n");
    const emitted = await sl(t.root, ["check-join", "--source", "snow", "--all", "--emit-sql"]);
    const plan = JSON.parse(emitted.out) as QueryPlan;
    expect(plan.dialect).toBe("snowflake");
    expect(plan.queries[0]!.sql).toContain(`from "ANALYTICS"."FCT_ORDERS"`);
    expect(plan.queries[0]!.sql).toContain(`"CUSTOMER_ID" as "k0"`);

    const refused = await sl(t.root, ["check-join", "--source", "snow", "--all"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--emit-sql");

    const file = join(t.dir, "res.json");
    writeFileSync(
      file,
      JSON.stringify({
        "join:orders.customer": [
          { LEFT_ROWS: 1000, LEFT_NULL_KEYS: 0, MATCHED_ROWS: 1000, RIGHT_ROWS: 200, RIGHT_DISTINCT_KEYS: 200, RIGHT_MAX_DUP: 1, LEFT_DISTINCT_KEYS: 200, LEFT_MAX_DUP: 9 },
        ],
      }),
    );
    const done = await sl(t.root, ["check-join", "--source", "snow", "--all", "--results", file, "--json"]);
    expect(done.err).toBe("");
    const c = done.json<CheckOut>().checks[0]!;
    expect(c.sentence).toBe("Each order points to at most one customer, and every order finds its customer.");
    expect(readYaml<Model>(join(dir, "orders.yaml")).joins![0]!.evidence?.match_rate).toBe(1);
  });
});

describe("check-join on postgres", () => {
  const schema = "t_check_join";
  let db: SQL | undefined;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = new SQL(PG_URL);
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.unsafe(`create schema ${schema}`);
    await db.unsafe(`create table ${schema}.customers (customer_id int primary key)`);
    await db.unsafe(`insert into ${schema}.customers select g from generate_series(1, 10) g`);
    await db.unsafe(`create table ${schema}."Orders" ("Order Id" int, customer_id int)`);
    await db.unsafe(`insert into ${schema}."Orders" select g, case when g <= 18 then (g % 10) + 1 when g = 19 then 77 else null end from generate_series(1, 20) g`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.close();
  });

  test.skipIf(!PG_URL)("measures a join live", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), { source: "pg", dialect: "postgres", connection: { env: "CJ_PG_URL" } });
    const dir = join(t.root, "models", "pg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "orders.yaml"),
      `model: orders\nsource: pg\ntable: ${schema}.Orders\nstatus: draft\ndimensions: []\nmeasures: []\njoins:\n  - name: customer # pg\n    to: customers\n    keys:\n      - { from: customer_id, to: customer_id }\n    relationship: one_to_one\n    status: draft\n`,
    );
    writeFileSync(join(dir, "customers.yaml"), `model: customers\nsource: pg\ntable: ${schema}.customers\nstatus: draft\ndimensions: []\nmeasures: []\n`);
    const r = await sl(t.root, ["check-join", "--source", "pg", "--model", "orders", "--join", "customer", "--json"], { CJ_PG_URL: PG_URL });
    expect(r.err).toBe("");
    const c = r.json<CheckOut>().checks[0]!;
    expect(c.evidence).toMatchObject({
      left_rows: 20,
      left_null_keys: 1,
      matched_rows: 18,
      match_rate: 0.9,
      right_rows: 10,
      right_key_unique: true,
      left_key_unique: false,
      max_fanout: 1,
      suggested_relationship: "many_to_one",
    });
    expect(c.findings.map((f) => f.message).join("\n")).toContain("declared one_to_one, but the data says many_to_one");
    const text = readFileSync(join(dir, "orders.yaml"), "utf8");
    expect(text).toContain("# pg");
    expect(readYaml<Model>(join(dir, "orders.yaml")).joins![0]!.relationship).toBe("one_to_one");
  });
});

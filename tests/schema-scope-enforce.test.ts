// Schema pairs enforced (spec: Schema scope): add-join, check-join, the compiler, goldens check and
// draft cross schemas only on an approved pair's keys, and an approved join across an undeclared
// pair compiles with a warning until the grace ends.
//
// On tests/fixtures/two-schemas/snapshot.json, sales.orders joins crm.customers through
// orders_customer_fk. The pair's approval is stamped by hand, as semlayer approve writes it, hash included.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { parse } from "yaml";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import type { Model, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "two-schemas", "snapshot.json");
const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-10" };
const PAIR_DRAFT = "cross_schema:\n  - from: sales\n    to: crm\n    status: draft\n    keys:\n      - from: orders.customer_id\n        to: customers.customer_id\n        constraint: orders_customer_fk\n";
// What semlayer approve writes into the first pair of a source's text on the owner's yes: the stamp and
// the hash of the pair as it stands.
function approved(text: string): string {
  const pair = (parse(text) as { cross_schema: Record<string, unknown>[] }).cross_schema[0]!;
  return text.replace("status: draft", `status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15\n    approved_hash: ${itemHash("schema-pair", pair)}`);
}
const PAIR_APPROVED = approved(PAIR_DRAFT);
const sourceText = (schemas: [string, string], pair = "") =>
  `source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [${schemas.join(", ")}]\n  primary: ${schemas[0]}\n${pair}`;
const REQUEST = JSON.stringify({ source: "warehouse", measures: ["orders.revenue"], dimensions: ["customers.segment"] });
const UNDECLARED = "joins sales.orders to crm.customers across schemas, and no approved schema pair declares these keys";

// Approved models of orders and customers, with a join from orders to customers in the given state
// (none leaves it out), so the compiler sees every field.
function models(root: string, joinStatus: "draft" | "approved" | "none", schemas: [string, string] = ["sales", "crm"]): void {
  const dir = join(root, "models", "warehouse");
  mkdirSync(dir, { recursive: true });
  const joinStamp = joinStatus === "approved" ? ok : { status: "draft" };
  const orders: Model = {
    model: "orders",
    source: "warehouse",
    table: `${schemas[0]}.orders`,
    primary_key: ["order_id"],
    ...ok,
    dimensions: [{ name: "order_id", expr: "order_id", type: "number", ...ok }],
    measures: [{ name: "revenue", agg: "sum", expr: "amount_cents", ...ok }],
    ...(joinStatus === "none" ? {} : { joins: [{ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", ...joinStamp }] }),
  } as Model;
  const customers: Model = {
    model: "customers",
    source: "warehouse",
    table: `${schemas[1]}.customers`,
    primary_key: ["customer_id"],
    ...ok,
    dimensions: [
      { name: "customer_id", expr: "customer_id", type: "number", ...ok },
      { name: "segment", expr: "segment", type: "string", ...ok },
    ],
  } as Model;
  writeYaml(join(dir, "orders.yaml"), orders);
  writeYaml(join(dir, "customers.yaml"), customers);
}

async function project(pair = "", joinStatus: "draft" | "approved" | "none" = "draft"): Promise<string> {
  const { root } = tempRoot();
  await initProject(root, "two");
  writeFileSync(join(root, "sources", "warehouse.yaml"), sourceText(["sales", "crm"], pair));
  mkdirSync(join(root, "snapshots"), { recursive: true });
  writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
  models(root, joinStatus);
  return root;
}

const sql = (root: string, json = true) => semlayer(root, ["sql", "--request", REQUEST, ...(json ? ["--json"] : [])]);
const ordersFile = (root: string) => join(root, "models", "warehouse", "orders.yaml");

describe("add-join and check-join", () => {
  test("add-join refuses a join across an undeclared or draft pair, naming add-cross-schema, and adds it once the pair is approved", async () => {
    for (const pair of ["", PAIR_DRAFT]) {
      const root = await project(pair, "none");
      const before = readFileSync(ordersFile(root), "utf8");
      const r = await semlayer(root, ["add-join", "--source", "warehouse", "--model", "orders", "--name", "customer", "--to", "customers", "--keys", "customer_id=customer_id"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        `The join warehouse.orders.customer ${UNDECLARED}. Nothing was written. Ask the owner whether the layer joins these schemas; ` +
          "if yes, record the pair with semlayer add-cross-schema --source warehouse --from sales --to crm --keys orders.customer_id=customers.customer_id, " +
          "read it back and approve it on their yes (semlayer approve --target schema-pair:warehouse:sales:crm), then run this semlayer add-join again.",
      );
      expect(readFileSync(ordersFile(root), "utf8")).toBe(before);
      // With --json the refusal is one object carrying the code validate and the compiler use.
      const j = await semlayer(root, ["add-join", "--source", "warehouse", "--model", "orders", "--name", "customer", "--to", "customers", "--keys", "customer_id=customer_id", "--json"]);
      expect(j.code).toBe(1);
      expect(j.json<{ code: string; next: string }>()).toMatchObject({
        code: "scope.cross_schema_undeclared",
        next: "semlayer add-cross-schema --source warehouse --from sales --to crm --keys orders.customer_id=customers.customer_id",
      });
    }
    const root = await project(PAIR_APPROVED, "none");
    const add = (keys: string, name = "customer") => semlayer(root, ["add-join", "--source", "warehouse", "--model", "orders", "--name", name, "--to", "customers", "--keys", keys]);
    // The approved pair lists customer_id only: another key is still refused.
    expect((await add("region_id=customer_id", "by_region")).err).toContain(UNDECLARED);
    const r = await add("customer_id=customer_id");
    expect(r.code).toBe(0);
    expect(readYaml<Model>(ordersFile(root)).joins?.map((j) => j.name)).toEqual(["customer"]);
  });

  test("check-join refuses a draft join across an undeclared pair, skips it under --all, and plans it once the pair is approved", async () => {
    const root = await project();
    const one = await semlayer(root, ["check-join", "--source", "warehouse", "--model", "orders", "--join", "customer"]);
    expect(one.code).toBe(1);
    expect(one.err).toContain(`Join "customer" on model "orders" ${UNDECLARED}. Nothing was written.`);
    expect(one.err).toContain("semlayer add-cross-schema --source warehouse --from sales --to crm --keys orders.customer_id=customers.customer_id");
    expect(one.err).toContain("then run semlayer check-join --source warehouse --model orders --join customer again.");
    const all = await semlayer(root, ["check-join", "--source", "warehouse", "--all", "--json"]);
    expect(all.json<{ skipped: { join: string; reason: string }[] }>().skipped).toMatchObject([{ join: "customer", reason: expect.stringContaining(UNDECLARED) }]);
    writeFileSync(join(root, "sources", "warehouse.yaml"), sourceText(["sales", "crm"], PAIR_APPROVED));
    const planned = await semlayer(root, ["check-join", "--source", "warehouse", "--model", "orders", "--join", "customer", "--emit-sql"]);
    expect(planned.code).toBe(0);
    expect(planned.json<{ queries: { sql: string }[] }>().queries[0]!.sql).toContain('from "crm"."customers"');
  });

  test("check-join measures an approved join across an undeclared pair while the grace lasts", async () => {
    const root = await project("", "approved");
    const planned = await semlayer(root, ["check-join", "--source", "warehouse", "--model", "orders", "--join", "customer", "--emit-sql"]);
    expect(planned.code).toBe(0);
  });
});

describe("the compiler", () => {
  test("semlayer sql refuses a draft join across an undeclared pair with scope.cross_schema_undeclared, and a draft pair does not help", async () => {
    for (const pair of ["", PAIR_DRAFT]) {
      const root = await project(pair);
      const r = await sql(root);
      expect(r.code).toBe(1);
      const out = r.json<{ refusals: { code: string; ref: string; message: string; next: string }[]; next: string }>();
      expect(out.refusals).toEqual([
        {
          code: "scope.cross_schema_undeclared",
          ref: "customers.segment",
          message: `customers.segment reads through join orders.customer, which ${UNDECLARED}`,
          next:
            "Ask the owner whether the layer joins these schemas; if yes, record the pair with semlayer add-cross-schema --source warehouse --from sales --to crm " +
            "--keys orders.customer_id=customers.customer_id, read it back and approve it on their yes, then run semlayer sql again.",
        },
      ]);
      expect(out.next).toBe(out.refusals[0]!.next);
      const human = await sql(root, false);
      expect(human.err).toContain(`semlayer sql refused the request: customers.segment reads through join orders.customer, which ${UNDECLARED}`);
    }
  });

  test("semlayer sql prints schema-qualified SQL for a join on an approved pair's keys, with no warning", async () => {
    const root = await project(PAIR_APPROVED);
    const r = await sql(root);
    expect(r.code).toBe(0);
    const c = r.json<{ sql: string; warnings?: unknown }>();
    expect(c.sql).toContain('from "sales"."orders" as "orders"');
    expect(c.sql).toContain('left join "crm"."customers" as "orders.customer" on "orders"."customer_id" = "orders.customer"."customer_id"');
    expect(c.warnings).toBeUndefined();
  });

  test("an approved join across an undeclared pair compiles with the warning, and goldens check prints it", async () => {
    const root = await project("", "approved");
    const r = await sql(root);
    expect(r.code).toBe(0);
    const c = r.json<{ sql: string; warnings: { code: string; message: string }[] }>();
    expect(c.sql).toContain('"crm"."customers"');
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]!.code).toBe("scope.cross_schema_undeclared");
    expect(c.warnings[0]!.message).toStartWith(`join orders.customer ${UNDECLARED}; it compiles only because it was approved before schema pairs were checked, and from semlayer 0.2.0 it is refused.`);
    expect(c.warnings[0]!.message).toContain("semlayer add-cross-schema --source warehouse --from sales --to crm --keys orders.customer_id=customers.customer_id");
    const human = await sql(root, false);
    expect(human.out).toContain(`Warning: join orders.customer ${UNDECLARED}`);

    const golden = {
      name: "revenue_by_segment",
      question: "What was revenue by customer segment?",
      request: JSON.parse(REQUEST),
      sql: "select 1",
      ...ok,
      expected: { rows: [{ segment: "smb", revenue: 100 }], tolerance: 0 },
    };
    mkdirSync(join(root, "goldens"), { recursive: true });
    writeYaml(join(root, "goldens", "revenue_by_segment.yaml"), golden);
    const results = join(root, "..", "rows.json");
    writeFileSync(results, JSON.stringify({ "golden:revenue_by_segment": [{ segment: "smb", revenue: 100 }] }));
    const emitted = await semlayer(root, ["goldens", "check", "--emit-sql", "--source", "warehouse", "--json"]);
    const ids = emitted.json<{ queries: { id: string }[] }>().queries.map((q) => q.id);
    writeFileSync(results, JSON.stringify(Object.fromEntries(ids.map((id) => [id, [{ segment: "smb", revenue: 100 }]]))));
    const check = await semlayer(root, ["goldens", "check", "--results", results, "--json"]);
    expect(check.code).toBe(0);
    expect(check.json<{ results: { name: string; ok: boolean; warnings: { code: string }[] }[] }>().results).toMatchObject([
      { name: "revenue_by_segment", ok: true, warnings: [{ code: "scope.cross_schema_undeclared" }] },
    ]);
    const printed = await semlayer(root, ["goldens", "check", "--results", results]);
    expect(printed.out).toContain(`pass  revenue_by_segment\n      warning: join orders.customer ${UNDECLARED}`);
  });

  test("a draft golden previews its request with the join's real status: a draft join across an undeclared pair is refused", async () => {
    const root = await project("", "draft");
    const args = ["goldens", "new", "--name", "g", "--question", "q", "--request", REQUEST];
    const refused = await semlayer(root, args);
    expect(refused.out + refused.err).not.toContain('left join "crm"."customers"');
    expect(refused.out + refused.err).toContain(UNDECLARED);
    writeFileSync(join(root, "sources", "warehouse.yaml"), sourceText(["sales", "crm"], PAIR_APPROVED));
    const allowed = await semlayer(root, args);
    expect(allowed.out + allowed.err).not.toContain(UNDECLARED);
  });

  test("a metric over an approved join across an undeclared pair carries its parts' warning", async () => {
    const root = await project("", "approved");
    const file = ordersFile(root);
    const orders = readYaml<Model>(file);
    orders.measures!.push({ name: "order_count", agg: "count", ...ok } as never);
    writeYaml(file, orders);
    writeYaml(join(root, "metrics.yaml"), {
      metrics: [{ name: "avg_order", source: "warehouse", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", ...ok, description: "Revenue per order." }],
    });
    const r = await semlayer(root, ["sql", "--request", JSON.stringify({ source: "warehouse", measures: ["avg_order"], dimensions: ["customers.segment"] }), "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ warnings: { code: string; message: string }[] }>().warnings.map((w) => w.code)).toEqual(["scope.cross_schema_undeclared"]);
  });
});

describe("draft", () => {
  test("an approved pair drafts the join from its listed keys and asks nothing about them", async () => {
    const { root } = tempRoot();
    await initProject(root, "two");
    writeFileSync(join(root, "sources", "warehouse.yaml"), sourceText(["sales", "crm"], PAIR_APPROVED));
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    const d = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(d.code).toBe(0);
    expect(d.json<{ cross_schema_keys: unknown[] }>().cross_schema_keys).toEqual([]);
    const orders = readYaml<Model>(ordersFile(root));
    expect(orders.joins?.find((j) => j.to === "customers")).toMatchObject({ keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", status: "draft" });
    // Only the listed key: region_id and sku, which match keys in crm by name, draft no join.
    expect((orders.joins ?? []).map((j) => j.to).sort()).toEqual(["channels", "customers", "stores"]);
    expect((orders.open_questions ?? []).filter((q) => q.includes("crm."))).toEqual([]);
    const v = await semlayer(root, ["validate", "--json"]);
    expect((v.json<{ issues: { code: string }[] }>().issues ?? []).filter((i) => i.code === "scope.cross_schema_undeclared")).toEqual([]);
  });

  test("an approved pair listing a key no foreign key carries drafts that join too", async () => {
    const { root } = tempRoot();
    await initProject(root, "two");
    const pair = approved(PAIR_DRAFT.replace("        constraint: orders_customer_fk\n", "        constraint: orders_customer_fk\n      - from: orders.region_id\n        to: regions.region_id\n"));
    writeFileSync(join(root, "sources", "warehouse.yaml"), sourceText(["sales", "crm"], pair));
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    expect((await semlayer(root, ["draft", "--source", "warehouse"])).code).toBe(0);
    const orders = readYaml<Model>(ordersFile(root));
    expect((orders.joins ?? []).map((j) => `${j.keys.map((k) => k.from).join(",")}->${j.to}`).sort()).toEqual([
      "channel_id->channels",
      "customer_id->customers",
      "region_id->regions",
      "store_id->stores",
    ]);
  });
});

// The compiler path on PostgreSQL: the two-schema fixture's tables loaded into two unique schemas,
// introspected, and the compiled SQL run read-only.
describe("schema pairs on postgres", () => {
  let pg: SQL | undefined;
  let a = "";
  let b = "";

  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    a = uniqueSchema("g2c_sales");
    b = uniqueSchema("g2c_crm");
    pg = new SQL(PG_URL);
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
    await pg.unsafe(`create schema ${a}`);
    await pg.unsafe(`create schema ${b}`);
    const into = (schema: string | null) => (schema === "sales" ? a : b);
    // Referenced tables first, so each foreign key finds its target.
    for (const t of [...snap.tables].sort((x, y) => (x.foreign_keys?.length ?? 0) - (y.foreign_keys?.length ?? 0))) {
      const cols = t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " not null"}`);
      const pk = t.primary_key?.length ? [`primary key (${t.primary_key.join(", ")})`] : [];
      const fks = (t.foreign_keys ?? []).map(
        (fk) => `constraint ${fk.constraint} foreign key (${fk.columns.join(", ")}) references ${into(fk.references.schema ?? t.schema)}.${fk.references.table} (${fk.references.columns.join(", ")})`,
      );
      await pg.unsafe(`create table ${into(t.schema)}.${t.name} (${[...cols, ...pk, ...fks].join(", ")})`);
    }
    await pg.unsafe(`insert into ${b}.customers values (1, 'smb'), (2, 'enterprise'), (3, 'smb')`);
    await pg.unsafe(`insert into ${a}.stores values (1, 'north')`);
    await pg.unsafe(
      `insert into ${a}.orders (order_id, customer_id, store_id, sku, amount_cents, ordered_at) values ` +
        "(1, 1, 1, 'a', 100, '2026-01-01'), (2, 2, 1, 'a', 250, '2026-01-02'), (3, 3, 1, 'b', 50, '2026-01-03')",
    );
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${a} cascade`);
    await pg.unsafe(`drop schema if exists ${b} cascade`);
    await pg.close();
  });

  test.skipIf(!PG_URL)("refuses the join before the pair, and runs schema-qualified SQL once it is approved", async () => {
    const { root } = tempRoot();
    const env = { SEMLAYER_TEST_PG: PG_URL };
    const setup = await semlayer(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", `${a},${b}`, "--primary", a], env);
    expect(setup.code).toBe(0);
    models(root, "draft", [a, b]);
    const refused = await semlayer(root, ["sql", "--request", REQUEST, "--json"], env);
    expect(refused.code).toBe(1);
    expect(refused.json<{ refusals: { code: string }[] }>().refusals.map((r) => r.code)).toEqual(["scope.cross_schema_undeclared"]);
    const added = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", a, "--to", b, "--constraint", "orders_customer_fk"], env);
    expect(added.code).toBe(0);
    const file = join(root, "sources", "warehouse.yaml");
    writeFileSync(file, approved(readFileSync(file, "utf8")));
    const r = await semlayer(root, ["sql", "--request", REQUEST, "--json"], env);
    expect(r.code).toBe(0);
    const c = r.json<{ sql: string; params: unknown[]; warnings?: unknown }>();
    expect(c.sql).toContain(`"${b}"."customers"`);
    expect(c.warnings).toBeUndefined();
    const rows = await pg!.begin("read only", (tx) => tx.unsafe(c.sql, c.params as never[]));
    const bySegment = Object.fromEntries([...rows].map((row: Record<string, unknown>) => [row.segment, Number(row.revenue)]));
    expect(bySegment).toEqual({ smb: 150, enterprise: 250 });
  });
});

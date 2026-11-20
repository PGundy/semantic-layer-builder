// Draft within one schema (spec: Schema scope): a name never joins across schemas, and a declared
// foreign key into another schema is one question that quotes its constraint, never a join.
//
// tests/fixtures/two-schemas/snapshot.json is a synthetic postgres snapshot of two schemas, sales and
// crm. sales.orders has a declared key into crm (orders_customer_fk), one within sales (orders_store_fk),
// a column joined by name within sales (channel_id), and two whose names match keys in crm only
// (region_id, sku).
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { draftModels } from "../skills/semantic-layer/scripts/lib/draft.ts";
import type { Model, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, semlayer, tempRoot } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "two-schemas", "snapshot.json");
const twoSchemas = (): Snapshot => JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;

function draftAll(snap: Snapshot): Map<string, Model> {
  const { models } = draftModels(snap, snap.tables, [], { source: snap.source, stripPrefixes: [], knownTables: snap.tables });
  return new Map(models.map((m) => [m.model, m]));
}

const CROSS_QUESTION =
  "customer_id references crm.customers through the foreign key orders_customer_fk, across schemas: sales.orders is in sales and customers in crm. " +
  "A join across schemas is drafted only after you say which schemas the layer joins. Do your questions need crm.customers? " +
  "If yes, record the pair with semlayer add-cross-schema --source warehouse --from sales --to crm --constraint orders_customer_fk; " +
  'if no, with semlayer add-cross-schema --source warehouse --from sales --to crm --decline --reply "<the owner\'s words>".';

describe("draft on a two-schema snapshot", () => {
  test("drafts no join across schemas from matching names, and keeps the joins within the schema", () => {
    const orders = draftAll(twoSchemas()).get("orders")!;
    const joins = (orders.joins ?? []).map((j) => `${j.keys.map((k) => k.from).join(",")}->${j.to}`);
    expect(joins.sort()).toEqual(["channel_id->channels", "store_id->stores"]);
    // region_id and sku match keys in crm only, so they draft as plain columns and no question names crm by them.
    const text = (orders.open_questions ?? []).join("\n");
    expect(text).not.toContain("crm.regions");
    expect(text).not.toContain("crm.products");
  });

  test("a cross-schema foreign key yields one question quoting its constraint name, and no join", () => {
    const orders = draftAll(twoSchemas()).get("orders")!;
    const about = (orders.open_questions ?? []).filter((q) => q.includes("crm.customers"));
    expect(about).toEqual([CROSS_QUESTION]);
    expect((orders.joins ?? []).some((j) => j.to === "customers")).toBe(false);
  });

  test("a cross-schema key without a recorded name says so", () => {
    const snap = twoSchemas();
    const orders = snap.tables.find((t) => t.name === "orders")!;
    delete orders.foreign_keys![0]!.constraint;
    const questions = draftAll(snap).get("orders")!.open_questions ?? [];
    expect(questions.filter((q) => q.includes("crm.customers"))).toEqual([
      CROSS_QUESTION.replace("the foreign key orders_customer_fk", "a foreign key whose name the snapshot does not record").replace(
        "--constraint orders_customer_fk",
        "--keys orders.customer_id=customers.customer_id",
      ),
    ]);
  });

  test("semlayer draft --source warehouse writes the same-schema joins and the question", async () => {
    const { root } = tempRoot();
    await initProject(root, "two");
    writeFileSync(join(root, "sources", "warehouse.yaml"), "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n");
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    const orders = readYaml<Model>(join(root, "models", "warehouse", "orders.yaml"));
    expect((orders.joins ?? []).map((j) => j.to).sort()).toEqual(["channels", "stores"]);
    expect(orders.open_questions).toContain(CROSS_QUESTION);
    expect(r.json<{ cross_schema_keys: unknown[] }>().cross_schema_keys).toEqual([
      { table: "sales.orders", columns: ["customer_id"], references: "crm.customers", constraint: "orders_customer_fk" },
    ]);
    // Without --json, the output names the key; a second run drafts nothing new and lists none.
    const { root: again } = tempRoot();
    await initProject(again, "two");
    writeFileSync(join(again, "sources", "warehouse.yaml"), readFileSync(join(root, "sources", "warehouse.yaml"), "utf8"));
    mkdirSync(join(again, "snapshots"), { recursive: true });
    writeFileSync(join(again, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    const text = await semlayer(again, ["draft", "--source", "warehouse"]);
    expect(text.out).toContain("Keys across schemas, drafted as open questions and not as joins:\n  sales.orders (customer_id) -> crm.customers, foreign key orders_customer_fk");
    const rerun = await semlayer(again, ["draft", "--source", "warehouse", "--json"]);
    expect(rerun.json<{ cross_schema_keys: unknown[] }>().cross_schema_keys).toEqual([]);
  });
});

describe("a single-schema snapshot drafts as before", () => {
  test("the Acme DuckDB demo's snapshot drafts its joins, and none of its keys crosses a schema", async () => {
    const { dir } = tempRoot();
    const demo = join(dir, "demo");
    expect((await semlayer(dir, ["demo", "--dir", demo])).code).toBe(0);
    expect((await semlayer(join(demo, "semantic"), ["profile", "--source", "acme"])).code).toBe(0);
    const snap = JSON.parse(readFileSync(join(demo, "semantic", "snapshots", "acme.json"), "utf8")) as Snapshot;
    expect(new Set(snap.tables.map((t) => t.schema))).toEqual(new Set(["main"]));
    const joins = [...draftAll(snap).values()].flatMap((m) => (m.joins ?? []).map((j) => `${m.model}.${j.keys.map((k) => k.from).join(",")}->${j.to}`));
    expect(joins.sort()).toEqual(DEMO_JOINS);
  });
});

// The demo's drafted joins after a profile, the same as draft gave them before it kept joins within a schema.
const DEMO_JOINS = [
  "customers_tmp.customer_id->dim_customers",
  "dim_customers_archive.customer_id->dim_customers",
  "fct_order_items.order_id->fct_orders",
  "fct_order_items.product_id->dim_products",
  "fct_orders.customer_id->dim_customers",
  "fct_orders_v2_test.customer_id->dim_customers",
  "fct_orders_v2_test.order_id->fct_orders",
  "fct_refunds.order_id->fct_orders",
  "orders_backup_2024.customer_id->dim_customers",
  "orders_backup_2024.order_id->fct_orders",
  "sessions.customer_id->dim_customers",
  "stg_orders.customer_id->dim_customers",
  "tmp_session_dedupe.session_id->sessions",
  "web_events.session_id->sessions",
  "web_events_2024_archive.session_id->sessions",
];

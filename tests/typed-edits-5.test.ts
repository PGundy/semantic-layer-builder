import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { applyEntryRefusal, applyFileRefusals, ROLES } from "../skills/semantic-layer/scripts/lib/roles.ts";
import type { Model, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, semlayer, tempRoot } from "./helpers.ts";

// The commands the exit walkthrough lacked (docs/PRD-hardening.md HR-15): semlayer add-join and semlayer
// remove-join, semlayer ignore-column --remove, one ignored-column check for every typed edit that takes
// an expression, adding to a saved scope, and semlayer goldens new inside semlayer apply. On copies of
// examples/acme and its synthetic fixture data.

const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(async () => {
  ({ root, dir, cleanup } = tempRoot());
  cpSync(ACME, root, { recursive: true });
  // A locked command that changes nothing, so the lock's own .gitignore line is there before any tree is read.
  expect((await semlayer(root, ["set", "warehouse.orders", "grain", "One row per order."])).code).toBe(0);
});
afterEach(() => cleanup?.());

const ORDERS = "models/warehouse/orders.yaml";
const CUSTOMERS = "models/warehouse/customers.yaml";
const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const model = (rel: string) => readYaml<Model>(join(root, rel));

function tree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(root, p), "utf8"));
    }
  };
  walk("");
  return out;
}

// Runs a command that must refuse: exit 1, each phrase in its message, and no file changed.
async function refused(args: string[], ...phrases: string[]): Promise<string> {
  const before = tree();
  const r = await semlayer(root, args);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  for (const p of phrases) expect(r.err).toContain(p);
  expect(tree()).toEqual(before);
  return r.err;
}

// The warehouse source as a DuckDB database holding Acme's orders and regions from the fixture CSVs,
// in schema acme as the snapshot names them.
async function duckWarehouse(): Promise<void> {
  const db = join(dir, "warehouse.duckdb");
  const instance = await DuckDBInstance.create(db);
  const c = await instance.connect();
  await c.run("create schema acme");
  for (const t of ["fct_orders", "dim_regions"]) await c.run(`create table acme.${t} as select * from read_csv_auto('${join(REPO, "fixtures", "acme", "data", "warehouse", `${t}.csv`)}')`);
  c.closeSync();
  instance.closeSync();
  const file = join(root, "sources", "warehouse.yaml");
  const src = readYaml<SourceConfig>(file);
  writeFileSync(file, `source: warehouse\ndialect: duckdb\nconnection:\n  database: ${JSON.stringify(db)}\nscope:\n  include: ${JSON.stringify(src.scope!.include)}\n`);
}

const ADD_JOIN = ["add-join", "--source", "warehouse", "--model", "orders", "--name", "shipping_region", "--to", "regions", "--keys", "ship_region=region_code"];

describe("semlayer add-join", () => {
  test("the Acme orders to regions join is added, checked with semlayer check-join and approved after a readback", async () => {
    await duckWarehouse();
    // The owner's comment on the model stays where it is.
    writeFileSync(join(root, ORDERS), text(ORDERS).replace("joins:\n", "# Joins the owner named.\njoins:\n"));
    const before = text(ORDERS);
    const r = await semlayer(root, ADD_JOIN);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added draft join shipping_region from warehouse.orders to regions on ship_region = region_code");
    expect(r.out).toContain("Next: semlayer check-join --source warehouse --model orders --join shipping_region measures it; then read it back to the owner (semlayer readback --targets warehouse.orders.shipping_region)");
    const after = text(ORDERS);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      "  - name: shipping_region\n    to: regions\n    keys:\n      - from: ship_region\n        to: region_code\n    relationship: many_to_one\n    origin: owner\n    status: draft\n",
    );

    const check = await semlayer(root, ["check-join", "--source", "warehouse", "--model", "orders", "--join", "shipping_region"]);
    expect(check.err).toBe("");
    expect(check.code).toBe(0);
    const evidence = model(ORDERS).joins!.find((j) => j.name === "shipping_region")!.evidence!;
    expect(evidence).toMatchObject({ left_rows: 5000, matched_rows: 5000, right_key_unique: true, max_fanout: 1, suggested_relationship: "many_to_one" });

    const approved = await approveWithYes(root, ["--target", "warehouse.orders.shipping_region", "--by", "Dana"]);
    expect(approved.err).toBe("");
    expect(approved.code).toBe(0);
    expect(model(ORDERS).joins!.find((j) => j.name === "shipping_region")).toMatchObject({ status: "approved", approved_by: "Dana" });
    expect(text(ORDERS)).toContain("# Joins the owner named.\njoins:\n");
  }, 60_000);

  test("--relationship, --type, --origin and --description are written; --json names the next command", async () => {
    const r = await semlayer(root, [...ADD_JOIN, "--relationship", "one_to_one", "--type", "inner", "--origin", "inferred", "--description", "The region\nthe order ships to.", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      changed: true,
      file: ORDERS,
      ref: "warehouse.orders.shipping_region",
      join: { name: "shipping_region", to: "regions", keys: [{ from: "ship_region", to: "region_code" }], relationship: "one_to_one", type: "inner", origin: "inferred", description: "The region the order ships to.", status: "draft" },
      warnings: [],
      next: "semlayer check-join --source warehouse --model orders --join shipping_region",
    });
  });

  test("refusals write nothing: a taken name, a missing model or column, an ignored key column, bad keys or flags", async () => {
    const base = ["add-join", "--source", "warehouse", "--model", "orders"];
    await refused([...base, "--name", "ship_to_region", "--to", "regions", "--keys", "ship_region=region_code"], 'already has a join "ship_to_region"', "Nothing was written");
    await refused([...base, "--name", "status", "--to", "regions", "--keys", "ship_region=region_code"], 'already has a dimension "status"');
    await refused([...base, "--name", "warehouse_region", "--to", "warehouses", "--keys", "ship_region=region_code"], 'No model "warehouses" in source warehouse', "semlayer draft --source warehouse --tables <table>");
    await refused([...base, "--name", "shipping_region", "--to", "regions", "--keys", "ship_regoin=region_code"], "ship_regoin is not a column of acme.fct_orders", "semlayer tables --source warehouse");
    await refused([...base, "--name", "shipping_region", "--to", "regions", "--keys", "ship_region=code"], "code is not a column of acme.dim_regions");
    await refused([...base, "--name", "gift", "--to", "regions", "--keys", "gift_message=region_code"], "reads orders.gift_message, which is in ignored_columns", "semlayer ignore-column --source warehouse --model orders --column gift_message --remove");
    await refused([...base, "--name", "shipping_region", "--to", "regions", "--keys", "ship_region"], "--keys takes <left column>=<right column> pairs");
    await refused([...base, "--name", "shipping_region", "--to", "regions", "--keys", "ship_region=region_code", "--relationship", "many_to_many"], "--relationship is many_to_one, one_to_one, one_to_many");
    await refused([...base, "--name", "shipping_region", "--to", "regions", "--keys", "ship_region=region_code", "--type", "outer"], "--type is left or inner");
    await refused([...base, "--name", "Shipping", "--to", "regions", "--keys", "ship_region=region_code"], "is not a name");
    await refused([...base, "--name", "shipping_region", "--to", "regions"], "Usage: semlayer add-join");
  });

  test("an empty flow list becomes a block list, and a repeated key pair is written once", async () => {
    const file = "models/warehouse/test_accounts.yaml";
    expect(text(file)).toContain("joins: []\n");
    const args = ["add-join", "--source", "warehouse", "--model", "test_accounts", "--name", "customer", "--to", "customers", "--keys", "customer_id=customer_id,CUSTOMER_ID=customer_id"];
    const r = await semlayer(root, args);
    expect(r.err).toBe("");
    expect(text(file)).toContain("joins:\n  - name: customer\n    to: customers\n    keys:\n");
    expect(model(file).joins).toEqual([expect.objectContaining({ name: "customer", keys: [{ from: "customer_id", to: "customer_id" }], status: "draft" })]);
    expect((await semlayer(root, ["validate"])).code).toBe(0);
  });
});

describe("semlayer remove-join", () => {
  test("refuses, naming the field, while a field reads through the join; removes a join nothing reads", async () => {
    await refused(
      ["remove-join", "--source", "warehouse", "--model", "orders", "--name", "ship_to_region"],
      "Cannot remove warehouse.orders.ship_to_region",
      "warehouse.orders.ship_region_name (its expr: ship_to_region.region_name)",
      "nothing was written",
    );
    await refused(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "status"], "warehouse.orders.status is a dimension, not a join; semlayer remove-field");
    await refused(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "nope"], 'No dimension, measure or join "nope"');
    const before = text(ORDERS);
    expect((await semlayer(root, ADD_JOIN)).code).toBe(0);
    const r = await semlayer(root, ["remove-join", "--source", "warehouse", "--model", "orders", "--name", "shipping_region"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("Removed join shipping_region from warehouse.orders");
    // ship_region is still read by a dimension, so nothing goes to ignored_columns and the file is as it was.
    expect(text(ORDERS)).toBe(before);
  });

  test("an approved join is removed only with --force, given on the owner's yes", async () => {
    await refused(["remove-join", "--source", "warehouse", "--model", "orders", "--name", "sales_rep"], "is approved", "run semlayer remove-join --source warehouse --model orders --name sales_rep --force");
  });
});

describe("semlayer ignore-column --remove", () => {
  test("un-ignoring customers.email without adding a field makes semlayer validate's warning go away", async () => {
    // As the walkthrough's draft left it: the test-account rule reads email, and email is ignored.
    writeFileSync(join(root, CUSTOMERS), text(CUSTOMERS).replace("dimensions:\n", "ignored_columns:\n  - email # personal\ndimensions:\n"));
    const warning = async () =>
      (await semlayer(root, ["validate", "--json"])).json<{ issues: { level: string; file: string; path: string }[] }>().issues.filter((i) => i.file === CUSTOMERS && i.path.startsWith("ignored_columns"));
    expect((await warning()).length).toBe(1);
    const fields = model(CUSTOMERS).dimensions.map((d) => d.name);
    const before = text(CUSTOMERS);
    const r = await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "customers", "--column", "EMAIL", "--remove"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("Took email out of warehouse.customers's ignored_columns in models/warehouse/customers.yaml; no field was added.");
    expect(r.out).toContain("Next: run the edit the owner asked for");
    expect(await warning()).toEqual([]);
    expect(model(CUSTOMERS).dimensions.map((d) => d.name)).toEqual(fields);
    expect(text(CUSTOMERS)).toBe(before.replace("ignored_columns:\n  - email # personal\n", ""));
    // Again, the column is not listed: nothing changes.
    const again = await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "customers", "--column", "email", "--remove", "--json"]);
    expect(again.json()).toMatchObject({ changed: false, removed: true, ignored_columns: [] });
  });

  test("takes one entry out of a longer list, keeping the others and their comments", async () => {
    const before = text(ORDERS);
    const r = await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "currency", "--remove", "--json"]);
    expect(r.json()).toMatchObject({ changed: true, column: "currency", ignored_columns: ["shipping_cents", "gift_message"], removed: true });
    expect(text(ORDERS)).toBe(before.replace("  - currency\n", ""));
    await refused(["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "gift_message", "--remove", "--reason", "x"], "run it without --reason");
  });
});

describe("a typed edit reading an ignored column is refused the same way everywhere", () => {
  // email is ignored on customers, as the walkthrough's draft left it; orders reads it through its customer join.
  beforeEach(() => {
    writeFileSync(join(root, CUSTOMERS), text(CUSTOMERS).replace("dimensions:\n", "ignored_columns:\n  - email\ndimensions:\n"));
  });
  const RULE = "customer.email like '%@example-test.com'";
  const NEXT = "semlayer ignore-column --source warehouse --model customers --column email --remove";

  test("add-field, set, check-rule and add-row-filter each refuse an expression reading it through a join", async () => {
    await refused(["add-field", "warehouse.orders", "--kind", "measure", "--name", "test_orders", "--agg", "count", "--filter", RULE], "reads customers.email, which is in ignored_columns", NEXT, "Nothing was written");
    await refused(["add-field", "warehouse.orders", "--kind", "measure", "--name", "test_orders", "--agg", "count", "--filter", RULE, "--unignore"], NEXT);
    await refused(["set", "warehouse.orders.revenue", "filter", RULE], "The filter of warehouse.orders.revenue reads customers.email", NEXT);
    await refused(["set", "warehouse.orders.ship_region", "expr", "customer.email"], "The expr of warehouse.orders.ship_region reads customers.email", NEXT);
    await refused(["set", "warehouse.orders.customer", "keys", "[{from: customer_id, to: email}]"], "The keys of warehouse.orders.customer reads customers.email", NEXT);
    const rule = await refused(["check-rule", "--source", "warehouse", "--model", "orders", "--filter", RULE], "The filter reads customers.email, which is in ignored_columns", NEXT);
    expect(rule).not.toContain("Nothing was written");
    await refused(["add-row-filter", "--role", "sales", "--model", "warehouse.orders", "--expr", `not (${RULE})`], "The row filter on warehouse.orders for role sales reads customers.email", NEXT);
  });

  test("an own column is refused the same way, naming ignore-column --remove, and add-field --unignore still takes it back", async () => {
    const own = "semlayer ignore-column --source warehouse --model orders --column gift_message --remove";
    await refused(["add-field", "warehouse.orders", "--kind", "dimension", "--name", "has_gift", "--expr", "gift_message is not null", "--type", "boolean"], own, "or run this again with --unignore");
    await refused(["set", "warehouse.orders.ship_region", "expr", "coalesce(gift_message, ship_region)"], own);
    await refused(["check-rule", "--source", "warehouse", "--model", "orders", "--filter", "gift_message is null"], own);
    await refused(["set", "warehouse.orders.ship_to_region", "keys", "[{from: gift_message, to: region_code}]"], "The keys of warehouse.orders.ship_to_region reads orders.gift_message", own);
    const ok = await semlayer(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "has_gift", "--expr", "gift_message is not null", "--type", "boolean", "--unignore", "--json"]);
    expect(ok.json()).toMatchObject({ changed: true, unignored: ["gift_message"] });
  });

  test("a set that keeps reading a column it already read is not refused, and after --remove the edit goes through", async () => {
    // is_test_account already reads email: changing its expr in other ways stays allowed.
    const kept = await semlayer(root, ["set", "warehouse.customers.is_test_account", "expr", "is_test_account or email like '%@example-test.org'"]);
    expect(kept.err).toBe("");
    expect(kept.code).toBe(0);
    expect((await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "customers", "--column", "email", "--remove"])).code).toBe(0);
    const set = await semlayer(root, ["set", "warehouse.orders.ship_region", "description", "Unchanged rule."]);
    expect(set.code).toBe(0);
    const added = await semlayer(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "test_orders", "--agg", "count", "--filter", RULE]);
    expect(added.err).toBe("");
    expect(added.code).toBe(0);
  });
});

describe("adding to a saved scope", () => {
  test("one exclude with --write keeps every earlier pattern", async () => {
    const file = join(root, "sources", "warehouse.yaml");
    const saved = readYaml<SourceConfig>(file).scope!;
    const r = await semlayer(root, ["scope", "--source", "warehouse", "--exclude", "acme.dim_products", "--write", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ scope: { include: string[]; exclude: string[] }; kept_entries: number; removed: string[] }>();
    expect(out.scope).toEqual({ include: saved.include!, exclude: [...saved.exclude!, "acme.dim_products"] });
    expect(out.kept_entries).toBe(saved.include!.length + saved.exclude!.length);
    expect(out.removed).toEqual(["acme.dim_products"]);
    expect(readYaml<SourceConfig>(file).scope).toEqual({ include: saved.include!, exclude: [...saved.exclude!, "acme.dim_products"] });
    const preview = await semlayer(root, ["scope", "--source", "warehouse", "--exclude", "acme.dim_regions"]);
    expect(preview.out).toContain("This adds to the saved scope, whose 7 entries stay; --remove <pattern> takes one out, --clear starts over.");
  });
});

describe("semlayer apply takes add-join, remove-join and goldens new", () => {
  const golden = (name: string, year: number) => [
    "goldens",
    "new",
    "--name",
    name,
    "--question",
    `Revenue in ${year}?`,
    "--request",
    JSON.stringify({ source: "warehouse", measures: ["orders.revenue"], filters: [{ field: "orders.order_date", op: "gte", value: `${year}-01-01` }, { field: "orders.order_date", op: "lt", value: `${year + 1}-01-01` }] }),
  ];
  const editsFile = (edits: unknown) => {
    const file = join(dir, "edits.json");
    writeFileSync(file, JSON.stringify({ edits }));
    return file;
  };

  test("five goldens and a join in one call; a failing entry leaves every file as it was", async () => {
    const names = ["rev_2021", "rev_2022", "rev_2023", "rev_2024", "rev_2026"];
    const edits = [ADD_JOIN.slice(), ...names.map((n, i) => golden(n, [2021, 2022, 2023, 2024, 2026][i]!))];
    const before = tree();
    const bad = await semlayer(root, ["apply", "--file", editsFile([...edits, golden("rev_bad", 2020).map((w) => w.replace('"op":"gte"', '"op":"after"'))])]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Entry 7");
    expect(tree()).toEqual(before);

    const r = await semlayer(root, ["apply", "--file", editsFile(edits)]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Applied 6 edits.");
    for (const n of names) expect(readYaml<{ status: string }>(join(root, "goldens", `${n}.yaml`)).status).toBe("draft");
    expect(model(ORDERS).joins!.map((j) => j.name)).toContain("shipping_region");
    const rm = await semlayer(root, ["apply", "--file", editsFile([["remove-join", "--source", "warehouse", "--model", "orders", "--name", "shipping_region"]])]);
    expect(rm.code).toBe(0);
    expect(model(ORDERS).joins!.map((j) => j.name)).not.toContain("shipping_region");
  });

  test("a draft golden naming a measure a later entry adds lands with it", async () => {
    const edits = [golden("rev_x", 2024).map((w) => w.replace("orders.revenue", "orders.gifts")), ["add-field", "warehouse.orders", "--kind", "measure", "--name", "gifts", "--agg", "count"]];
    const r = await semlayer(root, ["apply", "--file", editsFile(edits)]);
    // The golden names a measure the next entry adds: a draft golden naming an unknown field only warns, so both land.
    expect(r.err).toBe("");
    expect(existsSync(join(root, "goldens", "rev_x.yaml"))).toBe(true);
  });

  test("each entry is checked against the role that runs the batch", () => {
    expect(applyEntryRefusal(golden("g", 2024), ROLES.golden_builder)).toBeUndefined();
    expect(applyEntryRefusal(ADD_JOIN, ROLES.golden_builder)).toContain("the golden builder may not run semlayer add-join");
    expect(applyEntryRefusal(ADD_JOIN, ROLES.interviewer)).toBeUndefined();
    expect(applyEntryRefusal(["remove-join", "--source", "warehouse"], ROLES.interviewer)).toBeUndefined();
    expect(applyEntryRefusal(["goldens", "run", "--name", "g"])).toContain("is not a typed edit");
    expect(applyEntryRefusal(["goldens", "confirm", "--name", "g"])).toContain("records the owner's answer or approval");
    expect(applyFileRefusals(ROLES.golden_builder, JSON.stringify({ edits: [golden("g", 2024), ADD_JOIN] }))).toEqual([expect.stringContaining("entry 2 of semlayer apply is refused for the golden builder")]);
  });
});

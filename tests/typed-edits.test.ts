import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessFile, MetricsFile, Model, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { parseYamlText, readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl, tempRoot } from "./helpers.ts";

// Typed edits (sl set, sl tag, sl ignore-column, sl question add) on a copy of examples/acme, whose
// models are approved with content hashes.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
  const t = tempRoot();
  ({ root, dir, cleanup } = t);
  cpSync(ACME, root, { recursive: true });
});
afterEach(() => cleanup?.());

const ORDERS = "models/warehouse/orders.yaml";
const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const model = (rel: string) => readYaml<Model>(join(root, rel));

// Asserts that `after` is `before` with exactly the given line edits, so every other byte, comments
// and approved items included, is identical.
function expectOnly(before: string, after: string, edits: [string, string][]): void {
  let expected = before;
  for (const [from, to] of edits) {
    expect(expected.split(from).length).toBe(2);
    expected = expected.replace(from, to);
  }
  expect(after).toBe(expected);
}

describe("sl set", () => {
  test("sets a description, keeping every other byte, and an unhashed key asks for no new approval", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["set", "warehouse.orders.order_date", "description", "When the order was placed: days in UTC. # kept as text", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      changed: true,
      file: ORDERS,
      reapprove: [],
      ref: "warehouse.orders.order_date",
      key: "description",
      value: "When the order was placed: days in UTC. # kept as text",
    });
    const old = before.split("\n").find((l) => l.includes("When the customer placed the order (created_at)"))!;
    expectOnly(before, text(ORDERS), [[old, "    description: \"When the order was placed: days in UTC. # kept as text\""]]);
    expect(model(ORDERS).dimensions[0]!.description).toBe("When the order was placed: days in UTC. # kept as text");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a value is YAML for a list key, and setting an approved item's hashed key names sl approve", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales, gmv]"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warehouse.orders.revenue is approved and changed since its approval");
    expect(r.out).toContain('sl approve --target warehouse.orders.revenue --by "<owner>"');
    expectOnly(before, text(ORDERS), [["    synonyms: [sales]\n", "    synonyms: [sales, gmv]\n"]]);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ issues: { message: string }[] }>().issues.some((i) => i.message.startsWith("warehouse.orders.revenue changed since it was approved"))).toBe(true);
  });

  test("restoring an approved item's approved content asks for no new approval", async () => {
    const before = text(ORDERS);
    expect((await sl(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales, gmv]", "--json"])).json()).toMatchObject({ reapprove: ["warehouse.orders.revenue"] });
    const back = await sl(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales]", "--json"]);
    expect(back.json()).toMatchObject({ changed: true, reapprove: [] });
    expect(text(ORDERS)).toBe(before);
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("an approved item without approved_hash is named as changed too", async () => {
    for (const rel of [ORDERS, "models/warehouse/refunds.yaml"]) writeFileSync(join(root, rel), text(rel).replace(/^ *approved_hash: .*\n/gm, ""));
    const r = await sl(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales, gmv]", "--json"]);
    expect(r.json()).toMatchObject({ changed: true, reapprove: ["warehouse.orders.revenue"] });
  });

  test("a change to a join names every approved field that reads through it, in other models too", async () => {
    const r = await sl(root, ["set", "warehouse.orders.test_account", "type", "inner", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ reapprove: string[] }>().reapprove).toEqual([
      "warehouse.orders.discount",
      "warehouse.orders.order_count",
      "warehouse.orders.revenue",
      "warehouse.orders.test_account",
      // refunds.refund_amount reads order.test_account.<column>, two hops through orders.test_account.
      "warehouse.refunds.refund_amount",
    ]);
  });

  test("keeps a trailing comment on the value it replaces and comments elsewhere", async () => {
    const withComments = text(ORDERS)
      .replace("grain: One row per order.\n", "# Owner: finance.\ngrain: One row per order. # Dana Ruiz\n")
      .replace("    synonyms: [order status]\n", "    synonyms: [order status] # asked in session 2\n");
    writeFileSync(join(root, ORDERS), withComments);
    expect((await sl(root, ["set", "warehouse.orders", "grain", "One row per order, cancelled ones included."])).code).toBe(0);
    expectOnly(withComments, text(ORDERS), [["grain: One row per order. # Dana Ruiz", "grain: One row per order, cancelled ones included. # Dana Ruiz"]]);
    expect(text(ORDERS)).toContain("    synonyms: [order status] # asked in session 2\n");
  });

  test("refuses every approval field, naming sl approve, and writes nothing", async () => {
    const before = text(ORDERS);
    for (const key of ["status", "approved_by", "approved_at", "approved_hash", "last_approved"]) {
      const r = await sl(root, ["set", "warehouse.orders.revenue", key, "x"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("only sl approve writes");
      expect(r.err).toContain("sl approve --target warehouse.orders.revenue");
    }
    const access = await sl(root, ["set", "access", "last_approved", "{ by: x, at: 2026-01-01 }"]);
    expect(access.err).toContain("sl approve --target access");
    expect(text(ORDERS)).toBe(before);
  });

  test("refuses unknown keys and keys another command owns", async () => {
    const unknown = await sl(root, ["set", "warehouse.orders.revenue", "colour", "red"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('A measure has no key "colour". Keys sl set takes on a measure: expr, agg, filter');
    // A key of another kind is unknown here: time_grains belongs to dimensions.
    expect((await sl(root, ["set", "warehouse.orders.revenue", "time_grains", "[day]"])).err).toContain('has no key "time_grains"');
    expect((await sl(root, ["set", "warehouse.orders.revenue", "name", "sales"])).err).toContain("sl rename");
    expect((await sl(root, ["set", "warehouse.orders", "ignored_columns", "[a]"])).err).toContain("sl ignore-column");
    expect((await sl(root, ["set", "warehouse.orders", "open_questions", "[a]"])).err).toContain("sl question add");
    expect((await sl(root, ["set", "warehouse.orders", "dimensions", "[]"])).err).toContain("sl add-field");
    expect((await sl(root, ["set", "warehouse.orders.customer", "evidence", "{}"])).err).toContain("sl check-join");
    expect((await sl(root, ["set", "access", "roles", "[]"])).err).toContain("sl set access takes mode or default_role");
    expect((await sl(root, ["set", "warehouse.orders.revenue", "tags", "pii"])).err).toContain("tags is a list: write it as [a, b]");
    expect((await sl(root, ["set", "warehouse.nope", "grain", "x"])).err).toContain('No model "nope"');
  });

  test("refuses a result that does not validate and leaves the file byte-identical", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["set", "warehouse.orders.revenue", "agg", "median"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the result would not validate, so nothing was written");
    expect(r.err).toContain("measures[1].agg: must be one of");
    expect(r.err).toContain("Fix the value and run it again; sl validate lists the project's errors.");
    expect(text(ORDERS)).toBe(before);
    // A cross-reference error, not only a schema one: a ratio over a measure that does not exist.
    const metrics = text("metrics.yaml");
    const m = await sl(root, ["set", "metric:average_order_value", "numerator", "orders.no_such_measure"]);
    expect(m.code).toBe(1);
    expect(m.err).toContain("no_such_measure");
    expect(text("metrics.yaml")).toBe(metrics);
    // Closed mode needs allow.models on every role (access.yaml is edited as a draft).
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    const access = text("access.yaml");
    expect((await sl(root, ["set", "access", "mode", "closed"])).code).toBe(1);
    expect(text("access.yaml")).toBe(access);
  });

  test("is idempotent: the same value again changes nothing", async () => {
    expect((await sl(root, ["set", "metric:average_order_value", "synonyms", "[aov, basket size]"])).code).toBe(0);
    const once = text("metrics.yaml");
    const again = await sl(root, ["set", "metric:average_order_value", "synonyms", "[aov, basket size]", "--json"]);
    expect(again.json<{ changed: boolean; reapprove: string[] }>()).toMatchObject({ changed: false, reapprove: [] });
    expect(text("metrics.yaml")).toBe(once);
    expect(readYaml<MetricsFile>(join(root, "metrics.yaml")).metrics[0]!.synonyms).toEqual(["aov", "basket size"]);
    const human = await sl(root, ["set", "metric:average_order_value", "synonyms", "[aov, basket size]"]);
    expect(human.out).toBe("metric:average_order_value already has that synonyms; nothing changed. Next: sl status.");
  });

  test("--unset removes a key, and again is a no-op", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["set", "warehouse.orders.status", "synonyms", "--unset", "--json"]);
    expect(r.json()).toMatchObject({ changed: true, value: null, reapprove: ["warehouse.orders.status"] });
    expectOnly(before, text(ORDERS), [["    synonyms: [order status]\n", ""]]);
    expect((await sl(root, ["set", "warehouse.orders.status", "synonyms", "--unset", "--json"])).json()).toMatchObject({ changed: false });
    expect((await sl(root, ["set", "warehouse.orders.status", "synonyms", "x", "--unset"])).code).toBe(1);
  });

  test("a new key goes before the item's status", async () => {
    const r = await sl(root, ["set", "warehouse.orders.ship_region", "tags", "[finance_only]"]);
    expect(r.code).toBe(0);
    expect(text(ORDERS)).toContain("    synonyms: [region, sales region, sales territory]\n    tags: [finance_only]\n    status: approved\n");
  });

  // Invariants 3 and 5: tools apply approved items and an approved access.yaml as they stand.
  test("refuses tags that loosen an approved field and any key of an approved access.yaml, naming the revoke", async () => {
    const customers = text("models/warehouse/customers.yaml");
    const tags = await sl(root, ["set", "warehouse.customers.email", "tags", "[]"]);
    expect(tags.code).toBe(1);
    expect(tags.err).toContain("Cannot remove pii from warehouse.customers.email while it is approved");
    expect(tags.err).toContain("sl approve --target warehouse.customers.email --revoke");
    expect((await sl(root, ["set", "warehouse.customers.email", "tags", "--unset"])).code).toBe(1);
    expect(text("models/warehouse/customers.yaml")).toBe(customers);

    const access = text("access.yaml");
    const r = await sl(root, ["set", "access", "default_role", "finance"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("while access.yaml is approved");
    expect(r.err).toContain("sl approve --target access --revoke");
    expect(text("access.yaml")).toBe(access);
    expect((await sl(root, ["access", "--json"])).json()).toMatchObject({ access_file: "approved" });
    // As a draft, the edit is written and tools serve nothing until it is approved again.
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    expect((await sl(root, ["set", "access", "default_role", "finance"])).code).toBe(0);
    expect((await sl(root, ["access", "--json"])).json()).toMatchObject({ access_file: "draft" });
  });
});

describe("sl tag", () => {
  const CUSTOMERS = "models/warehouse/customers.yaml";

  test("adds to a block list, removes, and says what to do about an approved field", async () => {
    const before = text(CUSTOMERS);
    const r = await sl(root, ["tag", "warehouse.customers.email", "sensitive,pii", "--json"]);
    expect(r.json()).toEqual({
      changed: true,
      file: CUSTOMERS,
      reapprove: ["warehouse.customers.email"],
      ref: "warehouse.customers.email",
      added: ["sensitive"],
      tags: ["pii", "sensitive"],
    });
    const emailTags = "    tags:\n      - pii\n    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:1993";
    expectOnly(before, text(CUSTOMERS), [[emailTags, emailTags.replace("      - pii\n", "      - pii\n      - sensitive\n")]]);
    const human = await sl(root, ["tag", "warehouse.customers.email", "sensitive", "--remove"]);
    expect(human.out).toContain("Removed sensitive from warehouse.customers.email");
    expect(human.out).toContain("confirm that with the owner");
    expect(text(CUSTOMERS)).toBe(before);
  });

  test("a first tag is a flow list after the description, and a protected one names sl profile --redact", async () => {
    const path = "models/warehouse/regions.yaml";
    const before = text(path);
    const r = await sl(root, ["tag", "warehouse.regions.country_code", "sensitive"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sl profile --source warehouse --redact");
    expect(r.out).toContain("sl approve --target warehouse.regions.country_code");
    const desc = "    description: Country of the region. US for the five US regions; ZZ (not a real country code) for International.\n";
    expectOnly(before, text(path), [[desc, `${desc}    tags: [sensitive]\n`]]);
    // Removing the last tag removes the key.
    expect((await sl(root, ["tag", "warehouse.regions.country_code", "sensitive", "--remove"])).code).toBe(0);
    expect(text(path)).toBe(before);
  });

  test("a tag that would hide a field a golden names does not validate and is not written", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["tag", "warehouse.orders.sales_rep_id", "sensitive"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("goldens/analyst_rep_101_by_name_2025.yaml");
    expect(text(ORDERS)).toBe(before);
  });

  // Invariant 3: removing a protected tag from an approved field would expose its values at once.
  test("refuses removing pii or adding public on an approved item until it is revoked", async () => {
    const before = text(CUSTOMERS);
    const r = await sl(root, ["tag", "warehouse.customers.email", "pii", "--remove"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot remove pii from warehouse.customers.email while it is approved");
    expect(r.err).toContain("sl approve --target warehouse.customers.email --revoke");
    expect(text(CUSTOMERS)).toBe(before);
    const shown = (await sl(root, ["access", "--json"])).json() as { sources: { models: { fields: { ref: string; visible: boolean }[] }[] }[] };
    const email = shown.sources.flatMap((s) => s.models.flatMap((m) => m.fields)).find((f) => f.ref === "warehouse.customers.email");
    expect(email).toMatchObject({ visible: false });
    const pub = await sl(root, ["tag", "warehouse.regions", "public"]);
    expect(pub.err).toContain("Cannot add public to warehouse.regions while it is approved");
    // A draft takes the change; tools hide it until it is approved again.
    expect((await sl(root, ["approve", "--target", "warehouse.customers.email", "--revoke"])).code).toBe(0);
    expect((await sl(root, ["tag", "warehouse.customers.email", "pii", "--remove"])).code).toBe(0);
    expect(model(CUSTOMERS).dimensions.find((d) => d.name === "email")!.tags).toBeUndefined();
  });

  test("is idempotent and refuses joins, bad names and approval-free kinds", async () => {
    const before = text(CUSTOMERS);
    const r = await sl(root, ["tag", "warehouse.customers.email", "pii", "--json"]);
    expect(r.json()).toMatchObject({ changed: false, added: [] });
    expect((await sl(root, ["tag", "warehouse.customers.email", "public", "--remove", "--json"])).json()).toMatchObject({ changed: false });
    expect(text(CUSTOMERS)).toBe(before);
    expect((await sl(root, ["tag", "warehouse.orders.customer", "pii"])).err).toContain("A join carries no tags");
    expect((await sl(root, ["tag", "access", "pii"])).err).toContain("access.yaml carries no tags");
    expect((await sl(root, ["tag", "warehouse.customers.email", "PII"])).err).toContain("lowercase name");
  });

  test("tags a model and a metric", async () => {
    expect((await sl(root, ["tag", "warehouse.regions", "geo"])).code).toBe(0);
    expect(model("models/warehouse/regions.yaml").tags).toContain("geo");
    expect((await sl(root, ["tag", "metric:net_revenue", "finance_only", "--json"])).json()).toMatchObject({
      changed: true,
      reapprove: ["metric:net_revenue"],
    });
  });
});

describe("sl ignore-column", () => {
  // Gives fct_orders a column no field reads.
  function addColumn(name: string): void {
    const path = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    snap.tables.find((t) => t.name === "fct_orders")!.columns.push({ name, type: "text", nullable: true } as never);
    writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
  }

  test("adds the column at its sorted place with the reason as a comment, and again is a no-op", async () => {
    addColumn("internal_note");
    const before = text(ORDERS);
    const r = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "INTERNAL_NOTE", "--reason", "staff notes; not for reports", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      changed: true,
      file: ORDERS,
      reapprove: [],
      ref: "warehouse.orders",
      column: "internal_note",
      ignored_columns: ["internal_note", "shipping_cents", "currency", "gift_message"],
      reason: "staff notes; not for reports",
      redact: false,
    });
    expectOnly(before, text(ORDERS), [["ignored_columns:\n", "ignored_columns:\n  - internal_note # staff notes; not for reports\n"]]);
    expect((await sl(root, ["validate"])).code).toBe(0);
    const again = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "internal_note"]);
    expect(again.out).toContain("already in warehouse.orders's ignored_columns; nothing changed");
    expect(text(ORDERS)).toContain("  - internal_note # staff notes; not for reports\n");
  });

  test("a reason with line breaks stays one comment line and adds no key", async () => {
    addColumn("zz_note");
    const r = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "zz_note", "--reason", "old\nstatus: draft\n\x1b[31mred"]);
    expect(r.code).toBe(0);
    expect(text(ORDERS)).toContain("  - gift_message\n  - zz_note # old status: draft red\n");
    expect(model(ORDERS).status).toBe("approved");
  });

  // Invariant 6: the owner's comment on a flow list survives the switch to a block list.
  test("a flow list keeps its trailing comment, with or without a reason", async () => {
    const flow = "ignored_columns: [currency, shipping_cents]   # left out on purpose\n";
    writeFileSync(join(root, ORDERS), text(ORDERS).replace("ignored_columns:\n  - shipping_cents\n  - currency\n  - gift_message\n", flow));
    const before = text(ORDERS);
    expect((await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "gift_message"])).code).toBe(0);
    expectOnly(before, text(ORDERS), [[flow, "ignored_columns: [currency, gift_message, shipping_cents]   # left out on purpose\n"]]);
    writeFileSync(join(root, ORDERS), before);
    const r = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "gift_message", "--reason", "free text"]);
    expect(r.code).toBe(0);
    const block = "ignored_columns:\n  # left out on purpose\n  - currency\n  - gift_message # free text\n  - shipping_cents\n";
    expectOnly(before, text(ORDERS), [[flow, block]]);
    expect(model(ORDERS).ignored_columns).toEqual(["currency", "gift_message", "shipping_cents"]);
  });

  // Invariant 3: an ignored column is protected, so its raw sample values are redacted.
  test("names sl profile --redact when the snapshot holds sample values of the column", async () => {
    const path = join(root, "models/warehouse/products.yaml");
    const products = readFileSync(path, "utf8");
    writeFileSync(path, products.slice(0, products.indexOf("  - name: category")) + products.slice(products.indexOf("  - name: is_active")));
    const r = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "products", "--column", "category"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("run sl profile --source warehouse --redact to keep counts only");
    expect((await sl(root, ["validate"])).out).toContain("dim_products.category is protected but the snapshot holds raw sample values");
  });

  test("creates ignored_columns before the fields when the model has none", async () => {
    const path = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    snap.tables.find((t) => t.name === "fct_refunds")!.columns.push({ name: "memo", type: "text", nullable: true } as never);
    writeFileSync(path, JSON.stringify(snap, null, 2));
    const before = text("models/warehouse/refunds.yaml");
    expect((await sl(root, ["ignore-column", "--source", "warehouse", "--model", "refunds", "--column", "memo"])).code).toBe(0);
    expectOnly(before, text("models/warehouse/refunds.yaml"), [["  - refund_id\ndimensions:\n", "  - refund_id\nignored_columns:\n  - memo\ndimensions:\n"]]);
  });

  test("refuses a column a field reads, naming sl remove-field, and a key column, writing nothing", async () => {
    const before = text(ORDERS);
    const field = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "amount_cents"]);
    expect(field.code).toBe(1);
    expect(field.err).toContain("Cannot ignore amount_cents: in warehouse.orders it is read by measure revenue");
    expect(field.err).toContain("Remove the field first (sl remove-field warehouse.orders.revenue), which also adds the column to ignored_columns");
    const key = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "order_id"]);
    expect(key.err).toContain("the primary key");
    const incoming = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "customers", "--column", "customer_id"]);
    expect(incoming.err).toContain("a join from another model");
    const unknown = await sl(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "nope"]);
    expect(unknown.err).toContain("nope is not a column of acme.fct_orders");
    expect(text(ORDERS)).toBe(before);
  });
});

describe("sl question add", () => {
  test("appends to a model, prefixing a field's question with its name, and again is a no-op", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["question", "add", "warehouse.orders.revenue", "--text", "Does revenue include tax?", "--json"]);
    expect(r.json()).toEqual({
      changed: true,
      file: ORDERS,
      reapprove: [],
      ref: "warehouse.orders.revenue",
      question: "revenue: Does revenue include tax?",
      open_questions: ["revenue: Does revenue include tax?"],
    });
    expectOnly(before, text(ORDERS), [["  - order_id\nignored_columns:", '  - order_id\nopen_questions:\n  - "revenue: Does revenue include tax?"\nignored_columns:']]);
    const second = await sl(root, ["question", "add", "warehouse.orders", "--text", "Is shipping ever charged?"]);
    expect(second.out).toContain("Next: sl status.");
    expect(model(ORDERS).open_questions).toEqual(["revenue: Does revenue include tax?", "Is shipping ever charged?"]);
    const once = text(ORDERS);
    expect((await sl(root, ["question", "add", "warehouse.orders.revenue", "--text", "Does revenue include tax?", "--json"])).json()).toMatchObject({ changed: false });
    expect(text(ORDERS)).toBe(once);
    const status = await sl(root, ["status", "--json"]);
    expect(status.json<{ open_questions: number }>().open_questions).toBeGreaterThan(
      (await sl(ACME, ["status", "--json"])).json<{ open_questions: number }>().open_questions,
    );
  });

  test("appends to an existing list, keeping its folded entries byte-identical", async () => {
    const path = "models/warehouse/customers.yaml";
    const before = text(path);
    expect((await sl(root, ["question", "add", "warehouse.customers", "--text", "Who owns acquisition_channel?"])).code).toBe(0);
    const after = text(path);
    expect(after.replace("  - Who owns acquisition_channel?\n", "")).toBe(before);
    expect(model(path).open_questions!.at(-1)).toBe("Who owns acquisition_channel?");
  });

  test("appends to access.yaml, approved or not, without changing its approval", async () => {
    const before = text("access.yaml");
    const r = await sl(root, ["question", "add", "access", "--text", "Should marketing see refunds?\nstatus: draft"]);
    expect(r.code).toBe(0);
    expectOnly(before, text("access.yaml"), [[before.slice(-40), `${before.slice(-40)}open_questions:\n  - "Should marketing see refunds? status: draft"\n`]]);
    const access = readYaml<AccessFile>(join(root, "access.yaml"));
    expect(access.status).toBe("approved");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("refuses metrics, empty text, a missing access.yaml and unknown subcommands", async () => {
    expect((await sl(root, ["question", "add", "metric:net_revenue", "--text", "x"])).err).toContain("A metric has no open questions");
    expect((await sl(root, ["question", "add", "warehouse.orders", "--text", "  "])).err).toContain("--text is empty");
    expect((await sl(root, ["question", "ask", "warehouse.orders", "--text", "x"])).err).toContain("Usage: sl question add");
    rmSync(join(root, "access.yaml"));
    expect((await sl(root, ["question", "add", "access", "--text", "x"])).err).toContain("No access.yaml");
  });
});

describe("typed edits write only inside the semantic root", () => {
  test("a model file symlinked outside the root is refused and the outside file is unchanged", async () => {
    const outside = join(dir, "outside.yaml");
    const original = text(ORDERS);
    writeFileSync(outside, original);
    rmSync(join(root, ORDERS));
    symlinkSync(outside, join(root, ORDERS));
    const r = await sl(root, ["set", "warehouse.orders", "grain", "Changed."]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("resolves outside the semantic root");
    expect(readFileSync(outside, "utf8")).toBe(original);
    const linkedDir = join(dir, "elsewhere");
    mkdirSync(linkedDir);
    cpSync(join(root, "models", "lake"), linkedDir, { recursive: true });
    rmSync(join(root, "models", "lake"), { recursive: true });
    symlinkSync(linkedDir, join(root, "models", "lake"));
    expect((await sl(root, ["question", "add", "lake.sessions", "--text", "x"])).err).toContain("resolves outside the semantic root");
    expect(parseYamlText(readFileSync(join(linkedDir, "sessions.yaml"), "utf8"))).not.toHaveProperty("open_questions", ["x"]);
  });
});

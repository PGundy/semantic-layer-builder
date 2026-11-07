import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { renameInSql } from "../skills/semantic-layer/scripts/lib/edit.ts";
import type { Model, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { editYamlText, readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl, tempRoot } from "./helpers.ts";

// Typed edits, part 2 (sl add-field, sl remove-field, sl rename) on a copy of examples/acme, whose
// models, metrics and access.yaml are approved with content hashes.

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
const REFUNDS = "models/warehouse/refunds.yaml";
const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const model = (rel: string) => readYaml<Model>(join(root, rel));

// Every file of the semantic root, by relative path, with its text.
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

// Asserts that `after` is `before` with exactly the given edits, each found once, so every other
// byte, comments and approved items included, is identical.
function expectOnly(before: string, after: string, edits: [string, string][]): void {
  let expected = before;
  for (const [from, to] of edits) {
    expect(expected.split(from).length).toBe(2);
    expected = expected.replace(from, to);
  }
  expect(after).toBe(expected);
}

// Asserts that only `changed` files differ from `before`; each listed file is checked by its caller.
function expectUntouched(before: Map<string, string>, changed: string[]): void {
  const now = tree();
  expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [p, t] of before) if (!changed.includes(p)) expect(now.get(p)).toBe(t);
}

function addSnapshotColumn(table: string, name: string, type = "text"): void {
  const path = join(root, "snapshots", "warehouse.json");
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  snap.tables.find((t) => t.name === table)!.columns.push({ name, type, nullable: true } as never);
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
}

describe("sl add-field", () => {
  test("appends a draft dimension after the last one, keeping every other byte, and names the readback", async () => {
    addSnapshotColumn("fct_orders", "channel");
    const withComment = text(ORDERS).replace("measures:\n", "# Measures follow Finance's close.\nmeasures:\n");
    writeFileSync(join(root, ORDERS), withComment);
    const r = await sl(root, [
      "add-field", "warehouse.orders", "--kind", "dimension", "--name", "channel", "--expr", "CHANNEL", "--type", "string",
      "--description", "Where the order\ncame from.", "--set", "synonyms=[sales channel, source]", "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      changed: true,
      file: ORDERS,
      reapprove: [],
      ref: "warehouse.orders.channel",
      kind: "dimension",
      field: { name: "channel", expr: "CHANNEL", type: "string", description: "Where the order came from.", synonyms: ["sales channel", "source"], status: "draft" },
      unignored: [],
      warnings: [],
      redact: false,
    });
    const added = "  - name: channel\n    expr: CHANNEL\n    type: string\n    description: Where the order came from.\n    synonyms: [sales channel, source]\n    status: draft\n";
    expectOnly(withComment, text(ORDERS), [["# Measures follow Finance's close.\nmeasures:\n", `${added}# Measures follow Finance's close.\nmeasures:\n`]]);
    expect((await sl(root, ["validate"])).code).toBe(0);
    const human = await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "orders_any", "--agg", "count"]);
    expect(human.out).toContain("Added draft measure orders_any to warehouse.orders");
    expect(human.out).toContain('Next: read warehouse.orders.orders_any back to the owner, and approve it only on their yes (sl approve --target warehouse.orders.orders_any --by "<owner>").');
  });

  test("a measure takes --agg, --filter and --set, its keys in the schema's order; a computed expr warns", async () => {
    const before = text(REFUNDS);
    const r = await sl(root, [
      "add-field", "warehouse.refunds", "--kind", "measure", "--name", "big_refunds", "--expr", "refunded_cents / 100.0 + bogus_cents",
      "--set", "currency=USD", "--set", "format=currency", "--filter", "refunded_cents > 10000", "--agg", "sum", "--json",
    ]);
    expect(r.code).toBe(0);
    const out = r.json<{ field: Record<string, unknown>; warnings: string[] }>();
    expect(Object.keys(out.field)).toEqual(["name", "expr", "agg", "filter", "format", "currency", "status"]);
    expect(out.warnings).toEqual([
      'bogus_cents is not a column of acme.fct_refunds in the snapshot. The expr is computed, so it was written anyway; if a column is misspelled, fix it with sl set warehouse.refunds.big_refunds expr "<sql>".',
    ]);
    const m = model(REFUNDS);
    expect(m.measures.at(-1)).toEqual(out.field as never);
    // The new measure follows the last one; everything before it is unchanged.
    expect(text(REFUNDS).startsWith(before.slice(0, before.indexOf("joins:\n")))).toBe(true);
  });

  // Invariant 5: a typed edit never writes an approval.
  test("a new field is always a draft: --set of an approval field is refused", async () => {
    const before = text(ORDERS);
    for (const key of ["status", "approved_by", "approved_hash"]) {
      const r = await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "n", "--agg", "count", "--set", `${key}=approved`]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("a new field is always a draft, and only sl approve approves it after the owner's yes");
    }
    expect(text(ORDERS)).toBe(before);
  });

  test("refuses a taken name, a column the snapshot lacks, missing keys and wrong flags, writing nothing", async () => {
    const before = tree();
    const taken = await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "customer", "--expr", "customer_id", "--type", "number"]);
    expect(taken.err).toContain('warehouse.orders already has a join "customer": dimensions, measures and joins share one namespace');
    const missing = await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "coupon", "--expr", "coupon_code", "--type", "string"]);
    expect(missing.err).toContain("coupon_code is not a column of acme.fct_orders in the snapshot. Run sl tables --source warehouse");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "x", "--expr", "status"])).err).toContain("A dimension needs --expr and --type");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "x", "--agg", "sum"])).err).toContain("except with --agg count");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "x", "--agg", "count", "--type", "number"])).err).toContain("A measure has no --type");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "join", "--name", "x"])).err).toContain("--kind is dimension or measure");
    expect((await sl(root, ["add-field", "warehouse.orders.status", "--kind", "measure", "--name", "x", "--agg", "count"])).err).toContain("adds to a model");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "X", "--agg", "count"])).err).toContain("is not a name");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "x", "--agg", "count", "--set", "colour=red"])).err).toContain(
      'A measure has no key "colour"',
    );
    // A value the schema refuses is a validation error, and nothing is written.
    const bad = await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "x", "--agg", "median", "--expr", "amount_cents"]);
    expect(bad.err).toContain("the result would not validate, so nothing was written");
    expectUntouched(before, []);
  });

  // Invariant 3: a protected field's column keeps counts only in the snapshot once redacted.
  test("a protected tag over a column with sample values names sl profile --redact", async () => {
    const r = await sl(root, ["add-field", "warehouse.refunds", "--kind", "dimension", "--name", "refund_reason", "--expr", "reason", "--type", "string", "--set", "tags=[sensitive]"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("run sl profile --source warehouse --redact to keep counts only");
    expect(model(REFUNDS).dimensions.at(-1)).toMatchObject({ name: "refund_reason", tags: ["sensitive"], status: "draft" });
    expect(text(REFUNDS)).toContain("    tags: [sensitive]\n    status: draft\n");
  });

  test("refuses a column in ignored_columns unless --unignore, which removes it in the same edit", async () => {
    const before = text(ORDERS);
    const r = await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "shipping", "--expr", "shipping_cents * 0.01", "--agg", "sum"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("shipping_cents is in warehouse.orders's ignored_columns: left out of the layer on purpose. Nothing was written.");
    expect(r.err).toContain("run this again with --unignore");
    expect(text(ORDERS)).toBe(before);
    const ok = await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "shipping", "--expr", "shipping_cents * 0.01", "--agg", "sum", "--unignore", "--json"]);
    expect(ok.json()).toMatchObject({ changed: true, unignored: ["shipping_cents"], warnings: [] });
    expect(model(ORDERS).ignored_columns).toEqual(["currency", "gift_message"]);
    expect(text(ORDERS)).toContain("ignored_columns:\n  - currency\n  - gift_message\ndimensions:");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a model with measures: [] gets a block list in its place", async () => {
    const path = "models/warehouse/sales_team_closure.yaml";
    const before = text(path);
    expect((await sl(root, ["add-field", "warehouse.sales_team_closure", "--kind", "measure", "--name", "pairs", "--agg", "count", "--set", "format=integer"])).code).toBe(0);
    expectOnly(before, text(path), [["measures: []\n", "measures:\n  - name: pairs\n    agg: count\n    format: integer\n    status: draft\n"]]);
    expect((await sl(root, ["validate"])).code).toBe(0);
    // Removing it again leaves the empty list.
    expect((await sl(root, ["remove-field", "warehouse.sales_team_closure.pairs"])).code).toBe(0);
    expect(text(path)).toBe(before);
  });
});

describe("sl remove-field", () => {
  test("removes a draft field and ignores the column only it read, keeping every other byte", async () => {
    expect((await sl(root, ["approve", "--target", "warehouse.refunds.reason", "--revoke"])).code).toBe(0);
    const before = text(REFUNDS);
    const r = await sl(root, ["remove-field", "warehouse.refunds.reason", "--json"]);
    expect(r.json()).toEqual({
      changed: true,
      file: REFUNDS,
      reapprove: [],
      ref: "warehouse.refunds.reason",
      kind: "dimension",
      ignored_columns_added: ["reason"],
      ignored_columns: ["reason"],
      redact: true,
      was_approved: false,
    });
    const start = before.indexOf("  - name: reason\n");
    const field = before.slice(start, before.indexOf("measures:\n", start));
    expectOnly(before, text(REFUNDS), [
      [field, ""],
      ["  - refund_id\ndimensions:\n", "  - refund_id\nignored_columns:\n  - reason\ndimensions:\n"],
    ]);
    // A removed field again is a plain error.
    const again = await sl(root, ["remove-field", "warehouse.refunds.reason"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('No dimension, measure or join "reason" in warehouse.refunds');
  });

  test("keeps a column another field still reads, and --keep-column ignores nothing", async () => {
    // status is read by the measures' filters too; amount_cents only by revenue (once its references go).
    const status = await sl(root, ["remove-field", "warehouse.orders.status", "--force", "--json"]);
    expect(status.json()).toMatchObject({ changed: true, ignored_columns_added: [], ignored_columns: ["shipping_cents", "currency", "gift_message"], was_approved: true });
    const before = text("models/warehouse/regions.yaml");
    const kept = await sl(root, ["remove-field", "warehouse.regions.country_code", "--force", "--keep-column", "--json"]);
    expect(kept.json()).toMatchObject({ changed: true, ignored_columns_added: [], redact: false });
    expect(text("models/warehouse/regions.yaml")).not.toContain("ignored_columns");
    expect(text("models/warehouse/regions.yaml").length).toBeLessThan(before.length);
  });

  test("a new ignored column goes at its sorted place in an existing list", async () => {
    addSnapshotColumn("fct_orders", "aaa_note");
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "note", "--expr", "aaa_note", "--type", "string"])).code).toBe(0);
    const before = text(ORDERS);
    expect((await sl(root, ["remove-field", "warehouse.orders.note"])).code).toBe(0);
    expect(model(ORDERS).ignored_columns).toEqual(["aaa_note", "shipping_cents", "currency", "gift_message"]);
    const field = "  - name: note\n    expr: aaa_note\n    type: string\n    status: draft\n";
    expectOnly(before, text(ORDERS), [[field, ""], ["ignored_columns:\n", "ignored_columns:\n  - aaa_note\n"]]);
  });

  test("refuses an approved item without --force; with it, says the model changed since its approval", async () => {
    const before = text(REFUNDS);
    const r = await sl(root, ["remove-field", "warehouse.refunds.reason"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("warehouse.refunds.reason is approved: removing it changes warehouse.refunds after the owner signed it off. Nothing was written.");
    expect(r.err).toContain("only on their yes run sl remove-field warehouse.refunds.reason --force");
    expect(text(REFUNDS)).toBe(before);
    const forced = await sl(root, ["remove-field", "warehouse.refunds.reason", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("warehouse.refunds changed since the owner approved it: read warehouse.refunds back to the owner as it now stands");
    expect(forced.out).toContain("sl approve --target warehouse.refunds --revoke");
    // Invariant 3: the column it ignores is protected now, so its sample values are to be redacted.
    expect(forced.out).toContain("run sl profile --source warehouse --redact to keep counts only");
  });

  test("refuses while a metric, golden, access rule or join reference names the item, listing each", async () => {
    const before = tree();
    const measure = await sl(root, ["remove-field", "warehouse.orders.revenue", "--force"]);
    expect(measure.code).toBe(1);
    expect(measure.err).toContain("Cannot remove warehouse.orders.revenue: these name it, so nothing was written:");
    expect(measure.err).toContain("  - metrics.yaml metrics[0].numerator: orders.revenue\n");
    expect(measure.err).toContain("  - metrics.yaml metrics[1].expr: {orders.revenue} - {refunds.refund_amount}\n");
    expect(measure.err).toContain("  - goldens/revenue_by_region_2025.yaml request.measures[0]: orders.revenue\n");
    expect(measure.err).toContain("use sl rename warehouse.orders.revenue <new_name>");
    const filter = await sl(root, ["remove-field", "warehouse.orders.sales_rep_id", "--force"]);
    expect(filter.err).toContain("goldens/analyst_rep_101_by_name_2025.yaml request.filters[0].field: orders.sales_rep_id");
    const viaJoin = await sl(root, ["remove-field", "warehouse.orders.test_account", "--force"]);
    expect(viaJoin.err).toContain("models/warehouse/orders.yaml measures[0].filter: status in");
    expect(viaJoin.err).toContain("models/warehouse/refunds.yaml measures[0].filter: order.status in");
    const rowFilter = await sl(root, ["remove-field", "warehouse.order_items.order", "--force"]);
    expect(rowFilter.err).toContain("this names it, so nothing was written:\n  - access.yaml roles[2].row_filters[1].hierarchy.column: order.sales_rep_id\n");
    expectUntouched(before, []);
    // An access.yaml target or deny.fields entry written out in full names it too; a glob does not.
    writeFileSync(
      join(root, "access.yaml"),
      text("access.yaml")
        .replace('targets: ["warehouse.refunds", "metric:net_revenue"]', 'targets: ["warehouse.refunds", "metric:net_revenue", "warehouse.regions.country_code", "warehouse.regions.*"]')
        .replace("    assign_when: user.department == 'finance'\n", "    assign_when: user.department == 'finance'\n    deny:\n      fields: [warehouse.regions.country_code]\n"),
    );
    const access = await sl(root, ["remove-field", "warehouse.regions.country_code", "--force"]);
    expect(access.err).toContain("  - access.yaml restrictions[0].targets[2]: warehouse.regions.country_code\n  - access.yaml roles[1].deny.fields[0]: warehouse.regions.country_code\n");
    expect(access.err).not.toContain("warehouse.regions.*");
  });

  test("a removal that would not validate writes nothing", async () => {
    // The analyst golden reaches sales_reps.full_name through the sales_rep join.
    const before = text(ORDERS);
    const r = await sl(root, ["remove-field", "warehouse.orders.sales_rep", "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the result would not validate, so nothing was written");
    expect(r.err).toContain("goldens/analyst_rep_101_by_name_2025.yaml");
    expect(text(ORDERS)).toBe(before);
  });
});

describe("sl rename", () => {
  test("renames a measure and every reference across files, keeping comments and untouched bytes", async () => {
    const metricsBefore = text("metrics.yaml").replace("    numerator: orders.revenue\n", "    numerator: orders.revenue # Finance's revenue\n");
    writeFileSync(join(root, "metrics.yaml"), metricsBefore);
    const ordersBefore = text(ORDERS).replace("  - name: revenue\n", "  # The headline figure.\n  - name: revenue # renamed by finance\n");
    writeFileSync(join(root, ORDERS), ordersBefore);
    const golden = "goldens/revenue_by_region_2025.yaml";
    const goldenBefore = text(golden);
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.orders.revenue", "gross_revenue", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ changed: boolean; file: string; files: string[]; reapprove: string[]; ref: string; new_ref: string; references: { file: string; path: string; from: string; to: string }[] }>();
    expect(out).toMatchObject({ changed: true, file: ORDERS, ref: "warehouse.orders.revenue", new_ref: "warehouse.orders.gross_revenue" });
    expect(out.reapprove).toEqual(["metric:average_order_value", "metric:net_revenue", "warehouse.orders.gross_revenue"]);
    expect(out.references).toContainEqual({ file: "metrics.yaml", path: "metrics[1].expr", from: "{orders.revenue} - {refunds.refund_amount}", to: "{orders.gross_revenue} - {refunds.refund_amount}" });
    expect(out.references).toContainEqual({ file: golden, path: "request.measures[0]", from: "orders.revenue", to: "orders.gross_revenue" });
    expect(out.files).toContain("metrics.yaml");
    expect(out.files).toHaveLength(10);
    expectOnly(ordersBefore, text(ORDERS), [["  - name: revenue # renamed by finance\n", "  - name: gross_revenue # renamed by finance\n"]]);
    expectOnly(metricsBefore, text("metrics.yaml"), [
      ["    numerator: orders.revenue # Finance's revenue\n", "    numerator: orders.gross_revenue # Finance's revenue\n"],
      ['    expr: "{orders.revenue} - {refunds.refund_amount}"\n', '    expr: "{orders.gross_revenue} - {refunds.refund_amount}"\n'],
    ]);
    expectOnly(goldenBefore, text(golden), [["  measures: [orders.revenue]\n", "  measures: [orders.gross_revenue]\n"]]);
    expectUntouched(before, out.files);
    const v = await sl(root, ["validate", "--json"]);
    const errors = v.json<{ issues: { level: string; message: string }[] }>().issues.filter((i) => i.level === "error");
    expect(errors.every((e) => out.reapprove.some((ref) => e.message.startsWith(`${ref} changed since it was approved`)))).toBe(true);
    // Renaming back restores every file, and with it every approval.
    const back = await sl(root, ["rename", "warehouse.orders.gross_revenue", "revenue", "--json"]);
    expect(back.json()).toMatchObject({ changed: true, reapprove: [] });
    expectUntouched(before, []);
  });

  test("renames a join and its references in other models and in row filters", async () => {
    const refundsBefore = text(REFUNDS);
    const r = await sl(root, ["rename", "warehouse.orders.test_account", "qa_account", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ reapprove: string[] }>().reapprove).toEqual([
      "warehouse.orders.discount",
      "warehouse.orders.order_count",
      "warehouse.orders.qa_account",
      "warehouse.orders.revenue",
      "warehouse.refunds.refund_amount",
    ]);
    expect(model(ORDERS).measures.every((m) => !m.filter?.includes("test_account.") && m.filter?.includes("coalesce(qa_account.is_test_account, false)"))).toBe(true);
    // Two hops: refunds reads it through its order join. The column test_account.is_test_account keeps its name.
    expectOnly(refundsBefore, text(REFUNDS), [
      [
        "coalesce(order.test_account.is_test_account, false) = false and coalesce(order.test_account.email, '')",
        "coalesce(order.qa_account.is_test_account, false) = false and coalesce(order.qa_account.email, '')",
      ],
    ]);
    const access = text("access.yaml");
    const rf = await sl(root, ["rename", "warehouse.order_items.order", "parent_order", "--json"]);
    expect(rf.json<{ reapprove: string[]; files: string[] }>()).toMatchObject({ files: ["access.yaml", "models/warehouse/order_items.yaml"] });
    expect(rf.json<{ reapprove: string[] }>().reapprove).toContain("access");
    expectOnly(access, text("access.yaml"), [["          column: order.sales_rep_id\n", "          column: parent_order.sales_rep_id\n"]]);
  });

  test("renames a metric in goldens and access.yaml restriction targets", async () => {
    const r = await sl(root, ["rename", "metric:net_revenue", "net_sales", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ reapprove: string[]; references: { file: string; to: string }[] }>();
    expect(out.reapprove).toEqual(["access", "metric:net_sales"]);
    expect(out.references.map((x) => `${x.file}: ${x.to}`).sort()).toEqual([
      "access.yaml: metric:net_sales",
      "goldens/finance_net_revenue_2025.yaml: net_sales",
      "goldens/net_revenue_2025.yaml: net_sales",
    ]);
    expect(text("access.yaml")).toContain('targets: ["warehouse.refunds", "metric:net_sales"]');
    // metric: may be written on the new name, and the current name changes nothing.
    const same = await sl(root, ["rename", "metric:net_sales", "metric:net_sales", "--json"]);
    expect(same.json()).toMatchObject({ changed: false, files: [], reapprove: [], references: [] });
    const human = await sl(root, ["rename", "warehouse.orders.status", "status"]);
    expect(human.out).toBe("warehouse.orders.status is already named status; nothing changed. Next: sl status.");
  });

  test("a grain and a filter keep their place in a golden request", async () => {
    const before = text("goldens/net_revenue_2025.yaml");
    const refundsBefore = text(REFUNDS);
    // net_revenue's refunds part reaches orders.order_date through its order join, so refunds keeps its own order_date.
    const r = await sl(root, ["rename", "warehouse.orders.order_date", "order_day"]);
    expect(r.code).toBe(0);
    expect(text(REFUNDS)).toBe(refundsBefore);
    expectOnly(before, text("goldens/net_revenue_2025.yaml"), [
      ['  dimensions: ["orders.order_date:year"]\n', '  dimensions: ["orders.order_day:year"]\n'],
      ['    - { field: orders.order_date, op: gte, value: "2025-01-01" }\n', '    - { field: orders.order_day, op: gte, value: "2025-01-01" }\n'],
      ['    - { field: orders.order_date, op: lt, value: "2026-01-01" }\n', '    - { field: orders.order_day, op: lt, value: "2026-01-01" }\n'],
    ]);
  });

  test("renaming refunds.order_date alone validates: net_revenue groups refunds through its order join", async () => {
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.refunds.order_date", "order_day"]);
    expect(r.code).toBe(0);
    expectUntouched(before, [REFUNDS, "goldens/refunds_2025.yaml"]);
    const errors = (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; message: string }[] }>().issues.filter((i) => i.level === "error");
    // The only error left is the re-approval the rename asks for.
    expect(errors.map((e) => e.message.split(" changed since")[0])).toEqual(["warehouse.refunds.order_day"]);
  });

  test("writes nothing in any file when the result would not validate", async () => {
    // A golden groups refund_rate, refunds over orders, by refunds.order_date. orders has no to-one path to
    // refunds, so its part groups by its own dimension of the same name, which the rename takes away.
    const metric = "  - { name: refund_rate, source: warehouse, type: ratio, numerator: refunds.refund_amount, denominator: orders.revenue, format: percent, status: draft }\n";
    writeFileSync(join(root, "metrics.yaml"), text("metrics.yaml") + metric);
    const golden = "goldens/refund_rate_by_order_year.yaml";
    const request = '  source: warehouse\n  measures: [refund_rate]\n  dimensions: ["refunds.order_date:year"]\n';
    writeFileSync(join(root, golden), `name: refund_rate_by_order_year\nquestion: What share of revenue was refunded, by order year?\nrequest:\n${request}sql: select 1\nstatus: draft\n`);
    const errorsOn = async (file: string) =>
      (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string }[] }>().issues.filter((i) => i.level === "error" && i.file === file);
    expect(await errorsOn(golden)).toEqual([]);
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.orders.order_date", "order_day"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot rename warehouse.orders.order_date to order_day: the result would not validate, so nothing was written:");
    expect(r.err).toContain(`${golden} request.dimensions[0]: metric refund_rate combines measures of refunds, orders`);
    expect(r.err).toContain('orders has no dimension "order_date" and no such path to refunds');
    expect(r.err).toContain("sl validate lists the project's errors");
    expectUntouched(before, []);
  });

  // Invariant 3: a rename never changes who sees what.
  test("refuses a rename that changes what an access.yaml pattern covers", async () => {
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:net_revenue"]', '"metric:net_revenue", "warehouse.customers.e*"]'));
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.customers.email", "contact"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("a rename never changes who sees what. Nothing was written:");
    expect(r.err).toContain("  - access.yaml restrictions[0].targets[2]: warehouse.customers.e* matches warehouse.customers.email but not warehouse.customers.contact");
    expect((await sl(root, ["rename", "warehouse.customers.phone", "email_address"])).err).toContain("matches warehouse.customers.email_address but not warehouse.customers.phone");
    expectUntouched(before, []);
    // A pattern that covers both names is left as it is.
    expect((await sl(root, ["rename", "warehouse.customers.email", "email_address"])).code).toBe(0);
  });

  test("refuses taken names, models, access and bad names", async () => {
    expect((await sl(root, ["rename", "warehouse.orders.revenue", "customer"])).err).toContain('warehouse.orders already has a join "customer"');
    expect((await sl(root, ["rename", "metric:net_revenue", "average_order_value"])).err).toContain('already has a metric "average_order_value"');
    expect((await sl(root, ["rename", "warehouse.orders", "customers"])).err).toContain('Source warehouse already has a model "customers"');
    expect((await sl(root, ["rename", "access", "x"])).err).toContain("access.yaml has no name to rename");
    expect((await sl(root, ["rename", "warehouse.orders.revenue", "Gross"])).err).toContain("is not a name");
    expect((await sl(root, ["rename", "warehouse.orders.nope", "x"])).err).toContain('No dimension, measure or join "nope"');
  });

  // Invariant 6: every file a rename writes resolves inside the semantic root.
  test("a golden linked outside the root is refused and nothing is written", async () => {
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    cpSync(join(root, "goldens"), outside, { recursive: true });
    rmSync(join(root, "goldens"), { recursive: true });
    symlinkSync(outside, join(root, "goldens"));
    const metrics = text("metrics.yaml");
    const golden = readFileSync(join(outside, "revenue_by_region_2025.yaml"), "utf8");
    const r = await sl(root, ["rename", "warehouse.orders.revenue", "gross_revenue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("resolves outside the semantic root");
    expect(readFileSync(join(outside, "revenue_by_region_2025.yaml"), "utf8")).toBe(golden);
    expect(text("metrics.yaml")).toBe(metrics);
  });
});

describe("sl rename and sl remove-field, edge cases", () => {
  test("rename keeps the spacing of a flow map inside a flow list", async () => {
    const goldens = ["goldens/revenue_by_region_2025.yaml", "goldens/order_count_by_region_2025.yaml"];
    const before = goldens.map(text);
    expect((await sl(root, ["rename", "warehouse.orders.ship_region", "region_code"])).code).toBe(0);
    goldens.forEach((g, i) =>
      expectOnly(before[i]!, text(g), [
        ["dimensions: [orders.ship_region", "dimensions: [orders.region_code"],
        ["order_by: [{ field: orders.ship_region, direction: asc }]", "order_by: [{ field: orders.region_code, direction: asc }]"],
      ]),
    );
  });

  // Invariant 3: a metric: target is matched against the metric's bare name, as sl access reads it.
  test("refuses a rename that moves a metric out of a metric:re: restriction target", async () => {
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:net_revenue"]', '"metric:re:net_.*"]'));
    const before = tree();
    const r = await sl(root, ["rename", "metric:net_revenue", "gross_net"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  - access.yaml restrictions[0].targets[1]: metric:re:net_.* matches metric:net_revenue but not metric:gross_net");
    // A re: pattern with no * or ? is a pattern too.
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:re:net_.*"]', '"metric:re:net_revenue"]'));
    expect((await sl(root, ["rename", "metric:net_revenue", "gross_net"])).err).toContain("metric:re:net_revenue matches metric:net_revenue but not metric:gross_net");
    before.set("access.yaml", text("access.yaml"));
    expectUntouched(before, []);
    // A name the pattern still covers passes, and the pattern stays as it is.
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:re:net_revenue"]', '"metric:re:net_.*"]'));
    const access = text("access.yaml");
    expect((await sl(root, ["rename", "metric:net_revenue", "net_total"])).code).toBe(0);
    expect(text("access.yaml")).toBe(access);
  });

  test("a field re: target that would stop matching refuses the rename", async () => {
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:net_revenue"]', '"metric:net_revenue", "re:warehouse\\\\.orders\\\\.disc.*"]'));
    const r = await sl(root, ["rename", "warehouse.orders.discount", "rebate"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("matches warehouse.orders.discount but not warehouse.orders.rebate");
  });

  test("following the conflict message, adding the new name to the same list, lets the rename through", async () => {
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:net_revenue"]', '"metric:net_revenue", "warehouse.orders.disc*"]'));
    const first = await sl(root, ["rename", "warehouse.orders.discount", "rebate"]);
    expect(first.code).toBe(1);
    expect(first.err).toContain("when a pattern covers warehouse.orders.discount only, add warehouse.orders.rebate to the same list as its own entry");
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"warehouse.orders.disc*"]', '"warehouse.orders.disc*", "warehouse.orders.rebate"]'));
    const access = text("access.yaml");
    expect((await sl(root, ["rename", "warehouse.orders.discount", "rebate"])).code).toBe(0);
    expect(text("access.yaml")).toBe(access);
  });

  test("remove-field --json ignored_columns is the file's order", async () => {
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "cur", "--expr", "currency", "--type", "string", "--unignore"])).code).toBe(0);
    const r = await sl(root, ["remove-field", "warehouse.orders.cur", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ ignored_columns: string[] }>().ignored_columns).toEqual(model(ORDERS).ignored_columns!);
    expect(model(ORDERS).ignored_columns).toEqual(["currency", "shipping_cents", "gift_message"]);
  });

  test("add-field --set description is folded to one line like --description", async () => {
    const r = await sl(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "st5", "--expr", "status", "--type", "string", "--set", "description=line one\nline two"]);
    expect(r.code).toBe(0);
    expect(model(ORDERS).dimensions!.find((d) => d.name === "st5")!.description).toBe("line one line two");
  });

  test("remove-field lists references before asking for --force; a missing field names the next command", async () => {
    const r = await sl(root, ["remove-field", "warehouse.orders.revenue"]);
    expect(r.err).toContain("Cannot remove warehouse.orders.revenue: these name it");
    expect((await sl(root, ["remove-field", "warehouse.orders.nope"])).err).toContain("sl add-field warehouse.orders adds a new one");
  });

  test("rename names the field's open questions it leaves as they are", async () => {
    const r = await sl(root, ["rename", "warehouse.products.launched_on", "launch_date"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 open question in models/warehouse/products.yaml still starts with "launched_on: "');
  });

  test("rename is deterministic", async () => {
    const a = await sl(root, ["rename", "warehouse.orders.revenue", "gross_revenue", "--json"]);
    const after = tree();
    cleanup?.();
    ({ root, dir, cleanup } = tempRoot());
    cpSync(ACME, root, { recursive: true });
    const b = await sl(root, ["rename", "warehouse.orders.revenue", "gross_revenue", "--json"]);
    expect(b.out).toBe(a.out);
    expect(tree()).toEqual(after);
  });
});

describe("edit helpers", () => {
  test("a changed value inside a flow map keeps the map's spacing", () => {
    const before = 'filters:\n  - { field: orders.order_date, op: gte, value: "2025-01-01" }   # from 2025\n  - {field: x, op: lt}\n';
    const after = editYamlText(before, (doc) => {
      (doc.getIn(["filters", 0, "field"], true) as { value: unknown }).value = "orders.order_day";
      (doc.getIn(["filters", 1, "op"], true) as { value: unknown }).value = "lte";
    });
    expect(after).toBe('filters:\n  - { field: orders.order_day, op: gte, value: "2025-01-01" }   # from 2025\n  - {field: x, op: lte}\n');
  });

  test("a changed value inside a flow map inside a flow list keeps both spacings", () => {
    const before = "order_by: [{ field: a.b, direction: asc },  {field: c.d}]  # sorted\n";
    const after = editYamlText(before, (doc) => {
      (doc.getIn(["order_by", 0, "field"], true) as { value: unknown }).value = "a.e";
    });
    expect(after).toBe("order_by: [{ field: a.e, direction: asc },  {field: c.d}]  # sorted\n");
    // A value with a comma is quoted as a flow item, in a flow map or a flow list.
    const set = (path: (string | number)[], v: string) => editYamlText(before, (doc) => void ((doc.getIn(path, true) as { value: unknown }).value = v));
    expect(set(["order_by", 0, "field"], "a, b")).toBe('order_by: [{ field: "a, b", direction: asc },  {field: c.d}]  # sorted\n');
    expect(set(["order_by", 1, "field"], "x]")).toBe('order_by: [{ field: a.b, direction: asc },  {field: "x]"}]  # sorted\n');
  });

  const pick = (parts: { v: string; quoted: boolean }[]) => (parts[0]!.v.toLowerCase() === "customer" ? [0] : []);
  test("rewrites names outside strings and comments, keeping quotes, and leaves calls alone", () => {
    const sql = `"customer".region = 'customer.x' and Customer.email like '%a' -- customer.y\n and customer(1) > 0 and lower(customer.name) = x.customer`;
    expect(renameInSql(sql, "postgres", pick, "buyer")).toEqual({
      text: `"buyer".region = 'customer.x' and buyer.email like '%a' -- customer.y\n and customer(1) > 0 and lower(buyer.name) = x.customer`,
      hits: 3,
    });
    expect(renameInSql("{{ user.customer }} = customer.id", "duckdb", pick, "buyer").text).toBe("{{ user.customer }} = buyer.id");
  });
});

describe("sl help", () => {
  test("pads the command column to the longest command name", async () => {
    const r = await sl(root, ["help"]);
    const rows = r.out.split("\n").filter((l) => /^ {2}[a-z]/.test(l));
    const names = Object.keys(COMMANDS);
    expect(rows).toHaveLength(names.length);
    const width = Math.max(...names.map((n) => n.length));
    expect(width).toBeGreaterThan(12);
    for (const row of rows) {
      const name = row.trim().split(" ")[0]!;
      expect(row.slice(2 + width, 3 + width)).toBe(" ");
      expect(row.slice(2, 2 + width).trimEnd()).toBe(name);
      expect(row[3 + width]).not.toBe(" ");
    }
  });
});

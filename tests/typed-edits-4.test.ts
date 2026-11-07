import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl, tempRoot } from "./helpers.ts";

// Typed edits, part 3 (sl rename <source.model>, sl add-metric, sl remove-metric) on a copy of
// examples/acme, whose models, metrics and access.yaml are approved with content hashes.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const SL = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "sl.ts");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
  const t = tempRoot();
  ({ root, dir, cleanup } = t);
  cpSync(ACME, root, { recursive: true });
});
afterEach(() => cleanup?.());

const REFUNDS = "models/warehouse/refunds.yaml";
const text = (rel: string) => readFileSync(join(root, rel), "utf8");

function tree(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.set(p, "<link>");
      else if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(root, p), "utf8"));
    }
  };
  walk("");
  return out;
}

// `after` is `before` with exactly these edits, each found once.
function expectOnly(before: string, after: string, edits: [string, string][]): void {
  let expected = before;
  for (const [from, to] of edits) {
    expect(expected.split(from).length).toBe(2);
    expected = expected.replace(from, to);
  }
  expect(after).toBe(expected);
}

function expectUntouched(before: Map<string, string>, changed: string[]): void {
  const now = tree();
  for (const [p, t] of before) if (!changed.includes(p)) expect(now.get(p)).toBe(t);
  for (const p of now.keys()) if (!before.has(p)) expect(changed).toContain(p);
}

const errors = async () =>
  (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string; message: string }[] }>().issues.filter((i) => i.level === "error");

describe("sl rename <source.model>", () => {
  test("moves the file, renames its model key and every reference, keeps comments, and routes approved items to re-approval", async () => {
    const commented = text(REFUNDS).replace("model: refunds\n", "# Refunds as Finance books them.\nmodel: refunds # the table's model\n");
    writeFileSync(join(root, REFUNDS), commented);
    const metrics = text("metrics.yaml");
    const access = text("access.yaml");
    const golden = text("goldens/refunds_2025.yaml");
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.refunds", "refund_events", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ changed: boolean; file: string; files: string[]; reapprove: string[]; references: { file: string; path: string; from: string; to: string }[]; renamed_file: unknown; goldens: string[] }>();
    expect(out).toMatchObject({
      changed: true,
      file: "models/warehouse/refund_events.yaml",
      ref: "warehouse.refunds",
      new_ref: "warehouse.refund_events",
      renamed_file: { from: REFUNDS, to: "models/warehouse/refund_events.yaml" },
      goldens: ["refunds_2025"],
    });
    expect(out.files).toEqual(["access.yaml", "goldens/refunds_2025.yaml", "metrics.yaml", "models/warehouse/refund_events.yaml", REFUNDS]);
    // Every approved item of the model, and each approved item whose content names it, goes back to the owner.
    expect(out.reapprove).toEqual([
      "access",
      "metric:net_revenue",
      "warehouse.refund_events",
      "warehouse.refund_events.order",
      "warehouse.refund_events.order_date",
      "warehouse.refund_events.reason",
      "warehouse.refund_events.refund_amount",
      "warehouse.refund_events.refunded_at",
    ]);
    expect(existsSync(join(root, REFUNDS))).toBe(false);
    expectOnly(commented, text("models/warehouse/refund_events.yaml"), [["model: refunds # the table's model\n", "model: refund_events # the table's model\n"]]);
    expectOnly(metrics, text("metrics.yaml"), [['expr: "{orders.revenue} - {refunds.refund_amount}"', 'expr: "{orders.revenue} - {refund_events.refund_amount}"']]);
    expectOnly(access, text("access.yaml"), [['targets: ["warehouse.refunds", "metric:net_revenue"]', 'targets: ["warehouse.refund_events", "metric:net_revenue"]']]);
    expect(text("goldens/refunds_2025.yaml")).toBe(golden.replaceAll("refunds.", "refund_events."));
    expectUntouched(before, out.files);
    // validate passes but for the re-approval the rename asks for.
    expect((await errors()).every((e) => out.reapprove.some((ref) => e.message.startsWith(`${ref} changed since it was approved`)))).toBe(true);
    // Renaming back restores every file byte for byte, and with it every approval.
    const back = await sl(root, ["rename", "warehouse.refund_events", "refunds", "--json"]);
    expect(back.json()).toMatchObject({ changed: true, reapprove: [] });
    expectUntouched(before, []);
    expect(existsSync(join(root, "models/warehouse/refund_events.yaml"))).toBe(false);
  });

  test("renames joins to it with their evidence, and row filters' model and hierarchy via", async () => {
    const r = await sl(root, ["rename", "warehouse.sales_team_closure", "team_closure", "--json"]);
    expect(r.code).toBe(0);
    expect(text("access.yaml").match(/via: warehouse\.team_closure/g)).toHaveLength(2);
    const o = await sl(root, ["rename", "warehouse.orders", "sales", "--json"]);
    expect(o.code).toBe(0);
    const refunds = readYaml<Model>(join(root, REFUNDS));
    const join_ = refunds.joins!.find((j) => j.name === "order")!;
    expect(join_.to).toBe("sales");
    expect((join_ as unknown as { evidence: { to: string } }).evidence.to).toBe("sales");
    expect(text("access.yaml")).toContain("      - model: warehouse.sales\n");
    expect(text("metrics.yaml")).toContain("numerator: sales.revenue\n");
    expect(text("goldens/net_revenue_2025.yaml")).toContain('dimensions: ["sales.order_date:year"]');
    const out = o.json<{ reapprove: string[] }>();
    // Fields of other models that read through a join to it go back too: their join's target changed.
    expect(out.reapprove).toContain("warehouse.refunds.order");
    expect(out.reapprove).toContain("warehouse.refunds.refund_amount");
    expect(out.reapprove).toContain("warehouse.sales.revenue");
    const human = await sl(root, ["rename", "warehouse.sales", "orders"]);
    expect(human.out).toContain("Renamed model warehouse.sales to warehouse.orders: models/warehouse/sales.yaml is now models/warehouse/orders.yaml");
    expect(human.out).toContain("run sl goldens check");
  });

  test("names the items it sends back and one readback for them", async () => {
    const r = await sl(root, ["rename", "warehouse.regions", "geo_regions"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("approved items changed and go back to the owner for re-approval; tools treat them as drafts until then.");
    expect(r.out).toMatch(/Read them back with sl readback --targets [^ ]*warehouse\.geo_regions,warehouse\.geo_regions\.country_code/);
    expect(r.out).toContain("approve each again only on their yes (sl approve --target <ref>)");
    // The approved model is a draft to tools until the owner approves it again: approve refuses without a new yes.
    const a = await sl(root, ["approve", "--target", "warehouse.geo_regions"]);
    expect(a.code).toBe(1);
  });

  test("rewrites access patterns written under the model and refuses one whose coverage would change", async () => {
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    const withPatterns = text("access.yaml").replace("    assign_when: user.department == 'finance'\n", "    assign_when: user.department == 'finance'\n    deny:\n      fields: [warehouse.customers.e*]\n");
    writeFileSync(join(root, "access.yaml"), withPatterns);
    const ok = await sl(root, ["rename", "warehouse.customers", "clients", "--json"]);
    expect(ok.code).toBe(0);
    expect(text("access.yaml")).toContain("fields: [warehouse.clients.e*]");
    // A pattern that names the old model only by a glob would stop covering it.
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"metric:net_revenue"]', '"metric:net_revenue", "warehouse.ref*"]'));
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.refunds", "returns"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("a rename never changes who sees what. Nothing was written:");
    // The model's own entry is renamed with it, but the glob covers its fields under the old name only.
    expect(r.err).toContain("access.yaml restrictions[0].targets[2]: warehouse.ref* matches warehouse.refunds.refund_amount but not warehouse.returns.refund_amount");
    // And one that would start covering it.
    const s = await sl(root, ["rename", "warehouse.products", "refurbished"]);
    expect(s.err).toContain("warehouse.ref* matches warehouse.refurbished but not warehouse.products");
    expectUntouched(before, []);
  });

  test("refuses a taken name, a bad name, and does nothing for the current name", async () => {
    expect((await sl(root, ["rename", "warehouse.orders", "customers"])).err).toContain('Source warehouse already has a model "customers"');
    expect((await sl(root, ["rename", "warehouse.orders", "Sales"])).err).toContain("is not a name");
    expect((await sl(root, ["rename", "warehouse.nope", "x"])).err).toContain('No model "nope"');
    const same = await sl(root, ["rename", "warehouse.orders", "orders", "--json"]);
    expect(same.json()).toMatchObject({ changed: false, files: [], reapprove: [], references: [], renamed_file: null });
  });

  // Invariant 6: a rename writes only inside the root and never over something already there.
  test("refuses when a link is at the new path, writing nothing", async () => {
    symlinkSync(join(dir, "nowhere.yaml"), join(root, "models", "warehouse", "returns.yaml"));
    const before = tree();
    const r = await sl(root, ["rename", "warehouse.refunds", "returns"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("something is already there");
    expect(existsSync(join(dir, "nowhere.yaml"))).toBe(false);
    expectUntouched(before, []);
  });

  test("an error the model file already has does not block the rename", async () => {
    const items = "models/warehouse/order_items.yaml";
    const draft = "  - name: gift_wrap\n    expr: no_such_column\n    type: string\n    status: draft\n";
    writeFileSync(join(root, items), text(items).replace("measures:", `${draft}measures:`));
    const known = (await errors()).filter((e) => e.file === items);
    expect(known.length).toBeGreaterThan(0);
    const r = await sl(root, ["rename", "warehouse.order_items", "order_lines"]);
    expect(r.code).toBe(0);
    const now = (await errors()).filter((e) => e.file === "models/warehouse/order_lines.yaml" && !e.message.includes("changed since it was approved"));
    expect(now.map((e) => e.message)).toEqual(known.map((e) => e.message));
  });

  test("renames a model's join to itself in its moved file", async () => {
    const f = "models/warehouse/customers.yaml";
    const self = "  - name: referrer\n    to: customers\n    keys:\n      - from: customer_id\n        to: customer_id\n    relationship: many_to_one\n    status: draft\n";
    const t = text(f);
    writeFileSync(join(root, f), t.includes("\njoins:\n") ? t.replace("\njoins:\n", `\njoins:\n${self}`) : `${t}joins:\n${self}`);
    const r = await sl(root, ["rename", "warehouse.customers", "clients", "--json"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, f))).toBe(false);
    expect(text("models/warehouse/clients.yaml")).toContain("model: clients");
    expect(text("models/warehouse/clients.yaml")).toContain("    to: clients\n");
  });

  test("renames a join to it in a .yml model file", async () => {
    const copy = "models/warehouse/refunds_copy.yml";
    const draft = text(REFUNDS).replace("model: refunds", "model: refunds_copy").replace(/status: approved\n(\s*approved_by:.*\n\s*approved_at:.*\n(\s*approved_hash:.*\n)?)?/g, "status: draft\n");
    expect(draft).toContain("to: orders");
    writeFileSync(join(root, copy), draft);
    const r = await sl(root, ["rename", "warehouse.orders", "sales"]);
    expect(r.code).toBe(0);
    expect(text(copy)).not.toContain("to: orders");
    expect(text(copy)).toContain("to: sales");
  });

  test("refuses when an access pattern covers the old name only", async () => {
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace('"warehouse.refunds", "metric:net_revenue"]', '"re:^warehouse\\\\.refunds$", "metric:net_revenue"]'));
    expect(text("access.yaml")).toContain("re:^warehouse");
    const before = tree();
    expect((await sl(root, ["rename", "warehouse.refunds", "returns"])).code).toBe(1);
    expectUntouched(before, []);
  });

  test("sl set model names sl rename", async () => {
    const r = await sl(root, ["set", "warehouse.orders", "model", "sales"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl rename <source.model> <new_name>");
    expect(r.err).not.toContain("does not rename models");
  });
});

describe("sl add-metric", () => {
  test("appends a draft ratio, keeping every other byte, and names the readback", async () => {
    const before = text("metrics.yaml").replace("metrics:\n", "# Finance's metrics.\nmetrics:\n");
    writeFileSync(join(root, "metrics.yaml"), before);
    const r = await sl(root, [
      "add-metric", "--name", "revenue_per_line", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count",
      "--format", "currency", "--currency", "USD", "--description", "Revenue per\norder.", "--set", "synonyms=[rpo]", "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      changed: true,
      file: "metrics.yaml",
      reapprove: [],
      ref: "metric:revenue_per_line",
      metric: {
        name: "revenue_per_line", source: "warehouse", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count",
        format: "currency", currency: "USD", description: "Revenue per order.", synonyms: ["rpo"], status: "draft",
      },
      draft_measures: [],
      created: false,
    });
    expect(text("metrics.yaml")).toBe(
      before +
        "  - name: revenue_per_line\n    source: warehouse\n    type: ratio\n    numerator: orders.revenue\n    denominator: orders.order_count\n" +
        "    format: currency\n    currency: USD\n    description: Revenue per order.\n    synonyms: [rpo]\n    status: draft\n",
    );
    const human = await sl(root, ["add-metric", "--name", "gross_less_discount", "--type", "derived", "--expr", "{orders.revenue} - {orders.discount}", "--format", "currency", "--currency", "USD"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Added draft derived metric gross_less_discount to metrics.yaml.");
    expect(human.out).toContain("sl readback --targets metric:gross_less_discount");
    expect(human.out).toContain("approve it only on their yes (sl approve --target metric:gross_less_discount)");
    expect(text("metrics.yaml")).toContain('    expr: "{orders.revenue} - {orders.discount}"\n');
    expect((await errors()).length).toBe(0);
  });

  test("refuses a taken name, a wrong shape, a formula the compiler cannot read and a measure that does not resolve", async () => {
    const before = tree();
    const add = (...args: string[]) => sl(root, ["add-metric", ...args]);
    expect((await add("--name", "net_revenue", "--type", "derived", "--expr", "{orders.revenue}")).err).toContain('metrics.yaml already has a metric "net_revenue"');
    expect((await add("--name", "Bad", "--type", "ratio")).err).toContain("is not a name");
    expect((await add("--name", "x", "--type", "simple")).err).toContain("--type is ratio");
    expect((await add("--name", "x", "--type", "ratio", "--numerator", "orders.revenue")).err).toContain("A ratio needs --numerator and --denominator");
    expect((await add("--name", "x", "--type", "ratio", "--numerator", "revenue", "--denominator", "orders.order_count")).err).toContain("--numerator is model.measure");
    expect((await add("--name", "x", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--expr", "1")).err).toContain("A ratio has no --expr");
    expect((await add("--name", "x", "--type", "derived", "--numerator", "orders.revenue", "--expr", "1")).err).toContain("A derived metric has no --numerator");
    expect((await add("--name", "x", "--type", "derived", "--expr", "({orders.revenue} - 1")).err).toContain("The compiler cannot read --expr");
    expect((await add("--name", "x", "--type", "derived", "--expr", "{orders.revenue}; drop table x")).err).toContain("The compiler cannot read --expr");
    const unresolved = await add("--name", "x", "--type", "derived", "--expr", "{orders.nope} - 1");
    expect(unresolved.code).toBe(1);
    expect(unresolved.err).toContain('orders.nope does not resolve: model orders has no measure "nope"');
    expect((await add("--name", "x", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--set", "status=approved")).err).toContain("status is an approval field");
    expect((await add("--name", "x", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--set", "colour=red")).err).toContain('A metric has no key "colour"');
    expect((await add("--name", "x", "--type", "ratio", "--source", "nope", "--numerator", "orders.revenue", "--denominator", "orders.order_count")).err).toContain('No source "nope"');
    expectUntouched(before, []);
  });

  test("names the draft measures it uses, and creates metrics.yaml when there is none", async () => {
    rmSync(join(root, "metrics.yaml"));
    // Goldens that name the removed metrics already error; the new file adds no error of its own.
    const known = (await errors()).length;
    expect((await sl(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "shipped_count", "--agg", "count"])).code).toBe(0);
    const r = await sl(root, ["add-metric", "--name", "shipped_share", "--type", "ratio", "--numerator", "orders.shipped_count", "--denominator", "orders.order_count", "--format", "percent", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ created: true, draft_measures: ["orders.shipped_count"] });
    expect(text("metrics.yaml")).toBe(
      "metrics:\n  - name: shipped_share\n    source: warehouse\n    type: ratio\n    numerator: orders.shipped_count\n    denominator: orders.order_count\n    format: percent\n    status: draft\n",
    );
    expect((await errors()).length).toBe(known);
    rmSync(join(root, "metrics.yaml"));
    const human = await sl(root, ["add-metric", "--name", "shipped_share", "--type", "ratio", "--numerator", "orders.shipped_count", "--denominator", "orders.order_count"]);
    expect(human.out).toContain("Added draft ratio metric shipped_share to metrics.yaml, which is new.");
    expect(human.out).toContain("It uses draft measure orders.shipped_count: an approved metric may use approved measures only");
  });
  test("keeps the comments of an empty flow list it adds to", async () => {
    writeFileSync(join(root, "metrics.yaml"), "# Finance's metrics.\nmetrics: [] # none yet\n");
    const r = await sl(root, ["add-metric", "--name", "x", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count"]);
    expect(r.code).toBe(0);
    const now = text("metrics.yaml");
    expect(now).toContain("# Finance's metrics.");
    expect(now).toContain("# none yet");
    expect(now).toContain("metrics:\n  - name: x\n");
  });
});

describe("sl remove-metric", () => {
  test("refuses while a golden or access.yaml names it, naming each", async () => {
    const before = tree();
    const r = await sl(root, ["remove-metric", "metric:net_revenue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot remove metric:net_revenue: these name it, so nothing was written:");
    expect(r.err).toContain("  - goldens/net_revenue_2025.yaml request.measures[0]: net_revenue");
    expect(r.err).toContain("  - goldens/finance_net_revenue_2025.yaml request.measures[0]: net_revenue");
    expect(r.err).toContain("  - access.yaml restrictions[0].targets[1]: metric:net_revenue");
    expect((await sl(root, ["remove-metric", "nope"])).err).toContain('No metric "nope"');
    expectUntouched(before, []);
  });

  test("removes a draft metric, leaving the file as it was before it was added", async () => {
    const before = text("metrics.yaml");
    expect((await sl(root, ["add-metric", "--name", "tmp", "--type", "derived", "--expr", "{orders.revenue} * 2"])).code).toBe(0);
    const r = await sl(root, ["remove-metric", "tmp", "--json"]);
    expect(r.json()).toEqual({ changed: true, file: "metrics.yaml", reapprove: [], ref: "metric:tmp", was_approved: false });
    expect(text("metrics.yaml")).toBe(before);
  });

  test("an approved metric needs the owner's yes and --force; the last one leaves an empty list", async () => {
    // revenue_2025 names average_order_value; take it out of that request first.
    const g = "goldens/revenue_2025.yaml";
    writeFileSync(join(root, g), text(g).replace(", average_order_value]", "]"));
    expect(text(g)).toContain("  measures: [orders.revenue, orders.order_count]\n");
    const before = tree();
    const r = await sl(root, ["remove-metric", "average_order_value"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("metric:average_order_value is approved");
    expect(r.err).toContain("only on their yes run sl remove-metric average_order_value --force");
    expectUntouched(before, []);
    const f = await sl(root, ["remove-metric", "average_order_value", "--force"]);
    expect(f.code).toBe(0);
    expect(f.out).toContain("metric:average_order_value was approved: tell the owner it is removed.");
    expect(text("metrics.yaml")).not.toContain("average_order_value");
    expect(text("metrics.yaml")).toContain("approved_hash: sha256:a03b15c0");
    for (const n of ["net_revenue_2025", "finance_net_revenue_2025"]) rmSync(join(root, "goldens", `${n}.yaml`));
    expect((await sl(root, ["approve", "--target", "access", "--revoke"])).code).toBe(0);
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace(', "metric:net_revenue"]', "]"));
    const last = await sl(root, ["remove-metric", "net_revenue", "--force", "--json"]);
    expect(last.json()).toMatchObject({ changed: true, was_approved: true });
    expect(text("metrics.yaml")).toBe("metrics: []\n");
    expect((await errors()).length).toBe(0);
  });
});

describe("the hook lets the interviewer run them", () => {
  const bash = (command: string) =>
    checkToolUse(JSON.stringify({ tool_name: "Bash", cwd: root, agent_type: "semantic-layer-builder:sl-interviewer", agent_id: "a1", tool_input: { command }, hook_event_name: "PreToolUse" }));
  test("sl rename of a model, sl add-metric and sl remove-metric are allowed; a hand rename of the model file is not", () => {
    for (const args of [
      "rename warehouse.orders sales",
      "add-metric --name aov --type ratio --numerator orders.revenue --denominator orders.order_count",
      "remove-metric average_order_value --force",
    ]) {
      const v = bash(`bun ${SL} ${args} --root ${root}`);
      expect(v.message ?? "").toBe("");
      expect(v.allow).toBe(true);
    }
    const mv = bash(`mv ${join(root, "models", "warehouse", "orders.yaml")} ${join(root, "models", "warehouse", "sales.yaml")}`);
    expect(mv.allow).toBe(false);
  });

  test("a hand edit of an approved model's key names sl rename", () => {
    const file = join(root, "models", "warehouse", "orders.yaml");
    const v = checkToolUse(JSON.stringify({ tool_name: "Edit", cwd: root, tool_input: { file_path: file, old_string: "model: orders\n", new_string: "model: sales\n" }, hook_event_name: "PreToolUse" }));
    expect(v.allow).toBe(false);
    expect(v.message).toContain("sl rename warehouse.orders <new_name>");
  });

  test("a hand removal of an approved metric names sl remove-metric", () => {
    const file = join(root, "metrics.yaml");
    const t = readFileSync(file, "utf8");
    const start = t.indexOf("  - name: net_revenue");
    const v = checkToolUse(JSON.stringify({ tool_name: "Write", cwd: root, tool_input: { file_path: file, content: t.slice(0, start) }, hook_event_name: "PreToolUse" }));
    expect(v.allow).toBe(false);
    expect(v.message).toContain("sl remove-metric net_revenue");
  });
});

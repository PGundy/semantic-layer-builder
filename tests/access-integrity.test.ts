import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccessVisibility, checkRequest, evaluateAccess, evaluateLayer, loadAccessLayer, lookup } from "../skills/semantic-layer/scripts/lib/access.ts";
import type { ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import { sl, tempRoot } from "./helpers.ts";

// The access evaluator treats an approved item whose content no longer matches its approved_hash as
// a draft, on a copy of examples/acme, whose items are approved with content hashes. This guards
// invariants 3 and 5: a hand edit to an approved item (removing a pii tag, changing a filter) takes
// effect only after the owner approves it again.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const ORDERS = "models/warehouse/orders.yaml";
const CUSTOMERS = "models/warehouse/customers.yaml";
const REVENUE_FILTER =
  "filter: status in ('completed', 'shipped') and coalesce(test_account.is_test_account, false) = false and coalesce(test_account.email, '') not like '%@example-test.com'";
const NOTE = "changed since approval; treated as draft until it is read back and approved again";
const MISSING = "approved, but its approved_hash is missing while other items carry one; treated as draft until it is read back and approved again";

let root = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
  const t = tempRoot();
  ({ root, cleanup } = t);
  cpSync(ACME, root, { recursive: true });
});
afterEach(() => cleanup?.());

const text = (rel: string) => readFileSync(join(root, rel), "utf8");
// Replaces the first occurrence of `from` in a file, as a hand edit would.
function edit(rel: string, from: string, to: string): void {
  const before = text(rel);
  expect(before.includes(from)).toBe(true);
  writeFileSync(join(root, rel), before.replace(from, to));
}
// Replaces `from` inside the list item `name` of a model file (from "  - name: <name>" to the next
// item or section).
function editItem(rel: string, name: string, from: string, to: string): void {
  const before = text(rel);
  const start = before.indexOf(`  - name: ${name}\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = before.slice(start + 1);
  const next = rest.search(/\n {2}- name: |\n[a-z]/);
  const end = next === -1 ? before.length : start + 1 + next;
  const item = before.slice(start, end);
  expect(item.includes(from)).toBe(true);
  writeFileSync(join(root, rel), before.slice(0, start) + item.replace(from, to) + before.slice(end));
}
const field = (v: AccessVisibility, ref: string) => {
  const [source, ...rest] = ref.split(".");
  return lookup(v, source!, rest.join("."));
};
const metric = (v: AccessVisibility, name: string) => v.sources.find((s) => s.source === "warehouse")!.metrics.find((m) => m.name === name)!;
const revenueRequest = { source: "warehouse", measures: ["orders.revenue"], dimensions: [] };

describe("approved items that changed since approval", () => {
  test("a hand edit to an approved measure's filter hides it as a draft until the content is restored", async () => {
    const before = evaluateAccess(root);
    expect(before.changed_since_approval).toEqual([]);
    expect(field(before, "warehouse.orders.revenue")).toMatchObject({ status: "approved", visible: true, reasons: [] });
    expect(field(before, "warehouse.orders.revenue")).not.toHaveProperty("changed_since_approval");
    expect(checkRequest(before, revenueRequest).ok).toBe(true);
    const original = text(ORDERS);

    editItem(ORDERS, "revenue", REVENUE_FILTER, "filter: status in ('completed', 'shipped', 'refunded')");
    const v = evaluateAccess(root);
    expect(v.changed_since_approval).toEqual(["warehouse.orders.revenue"]);
    expect(field(v, "warehouse.orders.revenue")).toMatchObject({ status: "draft", visible: false, reasons: ["draft"], changed_since_approval: true });
    // A metric combining it is hidden with it; the other measures stay approved.
    expect(metric(v, "average_order_value")).toMatchObject({ visible: false, reasons: ["measure_hidden:orders.revenue"] });
    expect(field(v, "warehouse.orders.discount")).toMatchObject({ status: "approved", visible: true });
    expect(v.summary.fields.visible).toBe(before.summary.fields.visible - 1);

    const check = checkRequest(v, revenueRequest);
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatchObject({ position: "measures", ref: "orders.revenue", reasons: ["draft"] });
    expect(check.problems[0]!.message).toContain(`${NOTE} (sl approve --target warehouse.orders.revenue --by "<owner>" after the owner's yes)`);

    const human = await sl(root, ["access"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("measure warehouse.orders.revenue: hidden (draft: changed since approval)");
    expect(human.out).toContain(
      `Approved items that changed since approval:\n  warehouse.orders.revenue: ${NOTE} (sl approve --target warehouse.orders.revenue --by "<owner>" after the owner's yes)`,
    );
    const json = (await sl(root, ["access", "--json"])).json<AccessVisibility>();
    expect(json.changed_since_approval).toEqual(["warehouse.orders.revenue"]);
    expect(json.access_file).toBe("approved");

    // Restoring the approved definition makes it visible again.
    writeFileSync(join(root, ORDERS), original);
    const restored = evaluateAccess(root);
    expect(restored.changed_since_approval).toEqual([]);
    expect(field(restored, "warehouse.orders.revenue")).toMatchObject({ status: "approved", visible: true });
    expect(checkRequest(restored, revenueRequest).ok).toBe(true);
    expect((await sl(root, ["access"])).out).not.toContain("changed since approval");
  });

  test("a typed edit to an approved measure's expr takes effect only after a new approval", async () => {
    const set = await sl(root, ["set", "warehouse.orders.revenue", "expr", "amount_cents * 10", "--json"]);
    expect(set.code).toBe(0);
    expect(set.json()).toMatchObject({ changed: true, reapprove: ["warehouse.orders.revenue"] });
    const v = evaluateAccess(root);
    expect(field(v, "warehouse.orders.revenue")).toMatchObject({ visible: false, reasons: ["draft"], changed_since_approval: true });
    expect(checkRequest(v, revenueRequest).ok).toBe(false);
    // sl status still routes to reapprove, and says what tools do meanwhile.
    const st = (await sl(root, ["status", "--json"])).json<ProjectStatus>();
    expect(st.next_step.phase).toBe("reapprove");
    expect(st.next_step.message).toContain("Until then tools treat each one as a draft (sl access lists them).");
    // The owner's yes, recorded by sl approve, makes it visible again.
    expect((await sl(root, ["approve", "--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"])).code).toBe(0);
    const after = evaluateAccess(root);
    expect(after.changed_since_approval).toEqual([]);
    expect(field(after, "warehouse.orders.revenue")).toMatchObject({ status: "approved", visible: true });
  });

  test("removing pii from an approved field by hand does not show its values to the default audience", async () => {
    edit(CUSTOMERS, "    tags:\n      - pii\n    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:1993", "    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:1993");
    const v = evaluateAccess(root);
    expect(v.changed_since_approval).toEqual(["warehouse.customers.email"]);
    expect(field(v, "warehouse.customers.email")).toMatchObject({ tags: [], visible: false, reasons: ["draft"], changed_since_approval: true });
    // Counted as a draft, not as an approved item hidden by a protected tag.
    expect(v.summary.hidden_by_protected_tags).toBe(evaluateAccess(ACME).summary.hidden_by_protected_tags - 1);
  });

  test("a changed approved model hides the model and its fields; a changed join, the fields reading through it", async () => {
    edit(ORDERS, "table: ", "table: archive_");
    const m = evaluateAccess(root);
    const orders = m.sources.find((s) => s.source === "warehouse")!.models.find((x) => x.model === "orders")!;
    expect(orders).toMatchObject({ status: "draft", visible: false, reasons: ["draft"], changed_since_approval: true });
    expect(orders.fields.every((f) => !f.visible && f.reasons.includes("model_hidden"))).toBe(true);
    // The table is part of every field's identity, so each approved field changed too.
    expect(m.changed_since_approval).toContain("warehouse.orders");
    expect(m.changed_since_approval).toContain("warehouse.orders.revenue");
    expect((await sl(root, ["access"])).out).toContain("model warehouse.orders: hidden (draft: changed since approval)");

    cpSync(join(ACME, ORDERS), join(root, ORDERS));
    editItem(ORDERS, "test_account", "relationship: many_to_one", "relationship: one_to_one");
    const j = evaluateAccess(root);
    expect(j.changed_since_approval).toEqual(expect.arrayContaining(["warehouse.orders.test_account", "warehouse.orders.revenue", "warehouse.orders.discount"]));
    expect(field(j, "warehouse.orders.revenue")).toMatchObject({ visible: false, reasons: ["draft"] });
    expect(field(j, "warehouse.orders.order_date")).toMatchObject({ visible: true });
  });

  test("a changed approved metric is hidden as a draft", async () => {
    edit("metrics.yaml", "denominator: orders.order_count", "denominator: orders.discount");
    const v = evaluateAccess(root);
    expect(v.changed_since_approval).toEqual(["metric:average_order_value"]);
    expect(metric(v, "average_order_value")).toMatchObject({ status: "draft", visible: false, reasons: ["draft"], changed_since_approval: true });
    const r = checkRequest(v, { source: "warehouse", measures: ["average_order_value"] });
    expect(r.problems[0]!.message).toContain(`${NOTE} (sl approve --target metric:average_order_value --by "<owner>" after the owner's yes)`);
    expect((await sl(root, ["access"])).out).toContain("metric average_order_value: hidden (draft: changed since approval)");
  });

  test("an approved item whose hash was removed in a project with hashes is a draft too", async () => {
    // Removing the pii tag and the hash together does not show the field's values to the default audience.
    edit(CUSTOMERS, "    tags:\n      - pii\n    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:19938e900fededa45d2c3cbadd6ca781076770267087b36fc0a6d646fe925b26\n", "    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n");
    const v = evaluateAccess(root);
    expect(v.changed_since_approval).toEqual([]);
    expect(v.hash_missing).toEqual(["warehouse.customers.email"]);
    expect(field(v, "warehouse.customers.email")).toMatchObject({ status: "draft", visible: false, reasons: ["draft"], hash_missing: true });
    const r = checkRequest(v, { source: "warehouse", measures: ["orders.order_count"], dimensions: ["customers.email"] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]!.message).toContain(`it is ${MISSING} (sl approve --target warehouse.customers.email --by "<owner>" after the owner's yes)`);
    const human = (await sl(root, ["access"])).out;
    expect(human).toContain("dimension warehouse.customers.email: hidden (draft: approved_hash missing)");
    expect(human).toContain(`Approved items without approved_hash:\n  warehouse.customers.email: ${MISSING} (sl approve --target warehouse.customers.email --by "<owner>" after the owner's yes)`);
    expect((await sl(root, ["access", "--json"])).json<AccessVisibility>().hash_missing).toEqual(["warehouse.customers.email"]);
    // sl validate warns on the missing hash and, reading the layer as it would be once approved
    // again, that the field is visible to everyone and looks sensitive.
    const { issues } = (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; message: string }[] }>();
    expect(issues.some((i) => i.level === "warning" && i.message.includes("approved_hash is missing while other approved items carry one"))).toBe(true);
    expect(issues.some((i) => i.level === "warning" && i.message.startsWith("warehouse.customers.email is visible to everyone and looks sensitive"))).toBe(true);

    // A removed access.yaml hash makes the file a draft, with the sign-off that keeps applying.
    cpSync(join(ACME, CUSTOMERS), join(root, CUSTOMERS));
    writeFileSync(join(root, "access.yaml"), text("access.yaml").replace(/^ *approved_hash: .*\n/gm, ""));
    const a = evaluateAccess(root);
    expect(a).toMatchObject({ access_file: "draft", hash_missing: ["access"], last_approved: { by: "Dana Ruiz", at: "2026-10-27" } });
    expect(checkRequest(a, revenueRequest).problems[0]!.message).toBe(`access.yaml ${MISSING} (sl approve --target access --by "<owner>" after the owner's yes); nothing is served until then`);
    expect((await sl(root, ["access"])).out).toContain(`access.yaml ${MISSING} (sl approve --target access --by "<owner>" after the owner's yes). This explains a draft.`);
  });

  test("an approved item in a project approved before content hashes keeps applying as approved", () => {
    for (const f of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".yaml")) continue;
      const p = join(f.parentPath, f.name);
      writeFileSync(p, readFileSync(p, "utf8").replace(/^ *approved_hash: .*\n/gm, ""));
    }
    editItem(ORDERS, "revenue", REVENUE_FILTER, "filter: status in ('completed', 'shipped', 'refunded')");
    edit("metrics.yaml", "denominator: orders.order_count", "denominator: orders.discount");
    const legacy = evaluateAccess(root);
    expect(legacy.changed_since_approval).toEqual([]);
    expect(legacy.hash_missing).toEqual([]);
    expect(field(legacy, "warehouse.orders.revenue")).toMatchObject({ status: "approved", visible: true });
    expect(metric(legacy, "average_order_value")).toMatchObject({ status: "approved" });
    expect(legacy.access_file).toBe("approved");
  });

  test("a changed approved field keeps its sensitivity warning in sl validate", async () => {
    edit(CUSTOMERS, "    tags:\n      - pii\n    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:1993", "    status: approved\n    approved_by: Dana Ruiz\n    approved_at: 2026-10-26\n    approved_hash: sha256:1993");
    const res = await sl(root, ["validate", "--json"]);
    expect(res.code).toBe(1);
    const { issues } = res.json<{ issues: { level: string; message: string }[] }>();
    expect(issues.filter((i) => i.level === "error").map((i) => i.message.split(":")[0])).toEqual(["warehouse.customers.email changed since it was approved by Dana Ruiz on 2026-10-26"]);
    expect(issues.some((i) => i.level === "warning" && i.message.startsWith("warehouse.customers.email is visible to everyone and looks sensitive"))).toBe(true);
  });

  test("layout-only edits are not changes; a draft with a stale hash is a plain draft; hashes can be left uncompared", () => {
    edit(CUSTOMERS, "The customer's phone number.", "The phone number of the customer.");
    writeFileSync(join(root, ORDERS), text(ORDERS).replace(/\n/g, "\r\n"));
    expect(evaluateAccess(root).changed_since_approval).toEqual([]);

    cpSync(join(ACME, ORDERS), join(root, ORDERS));
    editItem(CUSTOMERS, "phone", "expr: phone", "expr: email");
    const layer = loadAccessLayer(root);
    expect(evaluateLayer(layer).changed_since_approval).toEqual(["warehouse.customers.phone"]);
    expect(evaluateLayer({ ...layer, compare_hashes: false }).changed_since_approval).toEqual([]);
    // A role user does not see it either, and checkRequest refuses it in a filter.
    const analyst = evaluateAccess(root, { attributes: { department: "analytics" } });
    expect(field(analyst, "warehouse.customers.phone")).toMatchObject({ visible: false, status: "draft", changed_since_approval: true });
    const r = checkRequest(analyst, { source: "warehouse", measures: ["orders.order_count"], filters: [{ field: "customers.phone", op: "=", value: "x" }] } as never);
    expect(r.problems.some((p) => p.ref === "customers.phone" && p.reasons.includes("draft") && p.message.includes(NOTE))).toBe(true);

    editItem(CUSTOMERS, "phone", "status: approved", "status: draft");
    const draft = evaluateAccess(root);
    expect(draft.changed_since_approval).toEqual([]);
    expect(field(draft, "warehouse.customers.phone")).toMatchObject({ status: "draft", visible: false });
    expect(field(draft, "warehouse.customers.phone")).not.toHaveProperty("changed_since_approval");
  });

  test("an approved access.yaml that changed is a draft: nothing is served, with the sign-off that keeps applying", async () => {
    edit("access.yaml", "assign_when: user.department == 'finance'", "assign_when: user.department in ['finance', 'marketing']");
    const v = evaluateAccess(root);
    expect(v.access_file).toBe("draft");
    expect(v.changed_since_approval).toEqual(["access"]);
    expect(v.last_approved).toEqual({ by: "Dana Ruiz", at: "2026-10-27" });
    // The models stay approved; the file's draft state is what stops every request.
    expect(field(v, "warehouse.orders.revenue")).toMatchObject({ status: "approved", visible: true });
    const r = checkRequest(v, revenueRequest);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      {
        position: "access",
        index: 0,
        ref: "access.yaml",
        reasons: ["access_draft"],
        message: `access.yaml ${NOTE} (sl approve --target access --by "<owner>" after the owner's yes); nothing is served until then`,
      },
    ]);
    const human = await sl(root, ["access"]);
    expect(human.out).toContain("Access mode open (access.yaml draft)");
    expect(human.out).toContain(
      `access.yaml ${NOTE} (sl approve --target access --by "<owner>" after the owner's yes). This explains a draft. ` +
        "The version approved by Dana Ruiz on 2026-10-27 keeps applying where it is deployed; tools that load this draft serve nothing.",
    );
    expect(human.out).not.toContain("Approved items that changed since approval:");
    // sl validate reports the change once and checks goldens against the file as written, not as a draft.
    const { issues } = (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string; message: string }[] }>();
    const errors = issues.filter((i) => i.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toStartWith("access changed since it was approved by Dana Ruiz on 2026-10-27");
    expect(issues.some((i) => i.message.includes("access_draft"))).toBe(false);

    // Approving it again after the owner's yes serves it again.
    expect((await sl(root, ["approve", "--target", "access", "--by", "Dana Ruiz", "--date", "2026-11-01"])).code).toBe(0);
    const after = evaluateAccess(root);
    expect(after.access_file).toBe("approved");
    expect(after.changed_since_approval).toEqual([]);
    expect(after).not.toHaveProperty("last_approved");
    expect(checkRequest(after, revenueRequest).ok).toBe(true);
  });
});

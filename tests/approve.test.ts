import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { AccessFile, MetricsFile, Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const ORDERS = `# Orders, owned by finance.
model: orders
source: wh
table: main.fct_orders
status: draft # waiting on Dana
description: Customer orders.
grain: One row per order.
primary_key: [order_id]
dimensions:
  - name: order_status
    expr: status
    type: string
    status: draft # confirm the values
measures:
  # Gross revenue before refunds.
  - name: revenue
    expr: amount
    agg: sum
    description: Order value.
    status: draft
  - name: order_count
    agg: count
    description: Number of orders.
    status: draft
joins:
  - name: customer
    to: customers
    keys:
      - { from: customer_id, to: customer_id }
    relationship: many_to_one
    status: draft
`;

const CUSTOMERS = `model: customers
source: wh
table: main.dim_customers
status: draft
dimensions:
  - name: region
    expr: region
    type: string
    status: draft
measures:
  - name: customer_count
    agg: count
    status: draft
`;

const METRICS = `# Company metrics.
metrics:
  - name: aov
    source: wh
    type: ratio
    numerator: orders.revenue
    denominator: orders.order_count
    description: Revenue per order.
    status: draft # pending finance
  - name: net
    source: wh
    type: derived
    expr: "{orders.revenue} - {customers.customer_count}"
    description: Not a real metric.
    status: draft
  - name: vague
    source: wh
    type: derived
    expr: "{orders.revenue}"
    status: draft
  - name: broken
    source: wh
    type: derived
    expr: "{orders.nope}"
    description: References a missing measure.
    status: draft
`;

const ACCESS = `# Who sees what.
status: draft
roles:
  - name: analyst
    allow:
      models:
        - wh.*
`;

async function project(): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  mkdirSync(join(t.root, "models", "wh"), { recursive: true });
  writeFileSync(join(t.root, "models", "wh", "orders.yaml"), ORDERS);
  writeFileSync(join(t.root, "models", "wh", "customers.yaml"), CUSTOMERS);
  writeFileSync(join(t.root, "metrics.yaml"), METRICS);
  writeFileSync(join(t.root, "access.yaml"), ACCESS);
  return t.root;
}

const text = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const orders = (root: string) => readYaml<Model>(join(root, "models/wh/orders.yaml"));

interface Result {
  changed: { target: string; from: string; to: string }[];
  warnings: string[];
}

async function approve(root: string, args: string[]) {
  return sl(root, ["approve", ...args]);
}

describe("approve targets", () => {
  test("a model: sets status, approver and date, keeps comments", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.orders", "--by", "Dana Ruiz", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<Result>()).toEqual({ changed: [{ target: "wh.orders", from: "draft", to: "approved" }], warnings: [] });
    const m = orders(root);
    expect(m.status).toBe("approved");
    expect(m.approved_by).toBe("Dana Ruiz");
    expect(m.approved_at).toBe("2026-01-15");
    expect(m.measures[0]!.status).toBe("draft");
    const raw = text(root, "models/wh/orders.yaml");
    expect(raw).toContain("# Orders, owned by finance.");
    expect(raw).toContain("status: approved # waiting on Dana\napproved_by: Dana Ruiz\napproved_at: 2026-01-15\n");
    expect(raw).toContain("# Gross revenue before refunds.");
    expect(raw).toContain("status: draft # confirm the values");
  });

  test("--date overrides today and a bad date is refused", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.orders", "--by", "Dana", "--date", "2026-03-01"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Approved wh.orders (draft -> approved) by Dana on 2026-03-01.");
    expect(orders(root).approved_at).toBe("2026-03-01");
    const bad = await approve(root, ["--target", "wh.orders", "--by", "Dana", "--date", "2026-02-30"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--date");
  });

  test("a dimension, a measure and a join", async () => {
    const root = await project();
    const d = await approve(root, ["--target", "wh.orders.order_status", "--by", "Dana", "--json"]);
    expect(d.json<Result>().changed).toEqual([{ target: "wh.orders.order_status", from: "draft", to: "approved" }]);
    const m = await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana", "--json"]);
    expect(m.json<Result>().changed[0]!.target).toBe("wh.orders.revenue");
    const j = await approve(root, ["--target", "wh.orders.customer", "--by", "Dana", "--json"]);
    expect(j.code).toBe(0);
    const jr = j.json<Result>();
    expect(jr.changed).toEqual([{ target: "wh.orders.customer", from: "draft", to: "approved" }]);
    expect(jr.warnings[0]).toContain("sl check-join --source wh --model orders --join customer");
    const o = orders(root);
    expect(o.dimensions[0]).toMatchObject({ status: "approved", approved_by: "Dana", approved_at: "2026-01-15" });
    expect(o.measures[0]).toMatchObject({ status: "approved", approved_by: "Dana" });
    expect(o.measures[1]!.status).toBe("draft");
    expect(o.joins![0]).toMatchObject({ status: "approved", approved_by: "Dana" });
    expect(o.status).toBe("draft");
    expect(text(root, "models/wh/orders.yaml")).toContain("status: approved # confirm the values");
  });

  test("a metric whose measures are approved, keeping comments", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana"]);
    await approve(root, ["--target", "wh.orders.order_count", "--by", "Dana"]);
    const r = await approve(root, ["--target", "metric:aov", "--by", "Dana", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<Result>().changed).toEqual([{ target: "metric:aov", from: "draft", to: "approved" }]);
    const metrics = readYaml<MetricsFile>(join(root, "metrics.yaml")).metrics;
    expect(metrics[0]).toMatchObject({ status: "approved", approved_by: "Dana", approved_at: "2026-01-15" });
    expect(metrics[1]!.status).toBe("draft");
    expect(text(root, "metrics.yaml")).toContain("# Company metrics.");
    expect(text(root, "metrics.yaml")).toContain("status: approved # pending finance");
  });

  test("the access file", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "access", "--by", "Dana", "--json"]);
    expect(r.json<Result>().changed).toEqual([{ target: "access", from: "draft", to: "approved" }]);
    const a = readYaml<AccessFile>(join(root, "access.yaml"));
    expect(a).toMatchObject({ status: "approved", approved_by: "Dana", approved_at: "2026-01-15" });
    expect(text(root, "access.yaml")).toStartWith("# Who sees what.\nstatus: approved\napproved_by: Dana\n");
  });

  test("a join with evidence is approved without a warning", async () => {
    const root = await project();
    const withEvidence = ORDERS.replace(
      "    relationship: many_to_one\n    status: draft\n",
      "    relationship: many_to_one\n    status: draft\n    evidence:\n      checked_at: 2026-01-15T12:00:00.000Z\n      match_rate: 1\n",
    );
    writeFileSync(join(root, "models", "wh", "orders.yaml"), withEvidence);
    const j = await approve(root, ["--target", "wh.orders.customer", "--by", "Dana", "--json"]);
    expect(j.code).toBe(0);
    expect(j.json<Result>()).toEqual({ changed: [{ target: "wh.orders.customer", from: "draft", to: "approved" }], warnings: [] });
  });

  test("an item without a status gets one near its name, not at the end", async () => {
    const root = await project();
    const bare = `# Customers.
model: customers
source: wh
table: main.dim_customers
grain: One row per customer.
primary_key: [customer_id]
measures:
  - name: customer_count
    agg: count
    description: Customers.
`;
    writeFileSync(join(root, "models", "wh", "customers.yaml"), bare);
    expect((await approve(root, ["--target", "wh.customers", "--by", "Dana"])).code).toBe(0);
    expect((await approve(root, ["--target", "wh.customers.customer_count", "--by", "Dana"])).code).toBe(0);
    const raw = text(root, "models/wh/customers.yaml");
    expect(raw).toStartWith("# Customers.\nmodel: customers\nsource: wh\ntable: main.dim_customers\nstatus: approved\napproved_by: Dana\napproved_at: 2026-01-15\ngrain:");
    expect(raw).toContain("  - name: customer_count\n    status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15\n    agg: count\n");

    writeFileSync(join(root, "access.yaml"), "# Who sees what.\nroles:\n  - name: analyst\n    allow:\n      models: [wh.*]\n");
    expect((await approve(root, ["--target", "access", "--by", "Dana"])).code).toBe(0);
    expect(text(root, "access.yaml")).toStartWith("# Who sees what.\nstatus: approved\napproved_by: Dana\napproved_at: 2026-01-15\nroles:");
  });

  test("the --target error names every target kind, golden included", async () => {
    const root = await project();
    const r = await approve(root, ["--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl goldens confirm");
  });

  test("already approved is a no-op", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders", "--by", "Dana"]);
    const before = text(root, "models/wh/orders.yaml");
    const r = await approve(root, ["--target", "wh.orders", "--by", "Someone Else"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("wh.orders is already approved");
    expect(text(root, "models/wh/orders.yaml")).toBe(before);
    const j = await approve(root, ["--target", "wh.orders", "--by", "Someone Else", "--json"]);
    expect(j.json<Result>()).toEqual({ changed: [], warnings: [] });
  });
});

describe("approve refusals", () => {
  test("empty --by", async () => {
    const root = await project();
    for (const args of [["--target", "wh.orders"], ["--target", "wh.orders", "--by", "  "]]) {
      const r = await approve(root, args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--by is required");
    }
    expect(orders(root).status).toBe("draft");
  });

  test("a model without grain or primary_key", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.customers", "--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("wh.customers has no grain");
    expect(r.err).toContain("wh.customers has no primary_key");
    expect(text(root, "models/wh/customers.yaml")).toBe(CUSTOMERS);
  });

  test("a measure without description", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.customers.customer_count", "--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Measure wh.customers.customer_count has no description");
    expect(text(root, "models/wh/customers.yaml")).toBe(CUSTOMERS);
  });

  test("a metric without description, with draft measures, or with a missing measure", async () => {
    const root = await project();
    const vague = await approve(root, ["--target", "metric:vague", "--by", "Dana"]);
    expect(vague.code).toBe(1);
    expect(vague.err).toContain("Metric metric:vague has no description");
    const drafts = await approve(root, ["--target", "metric:net", "--by", "Dana"]);
    expect(drafts.code).toBe(1);
    expect(drafts.err).toContain("draft measures: wh.orders.revenue, wh.customers.customer_count");
    const broken = await approve(root, ["--target", "metric:broken", "--by", "Dana"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("wh.orders.nope does not exist");
    const unknown = await approve(root, ["--target", "metric:nope", "--by", "Dana"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Known metrics: aov, net, vague, broken");
    expect(text(root, "metrics.yaml")).toBe(METRICS);
  });

  test("a metric with placeholders sl validate rejects, or none at all", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana"]);
    const odd = `metrics:
  - name: upper
    source: wh
    type: derived
    expr: "{Orders.Revenue} * 2"
    description: Upper case.
    status: draft
  - name: spaced
    source: wh
    type: derived
    expr: "{ orders.revenue } * 2"
    description: Spaces inside braces.
    status: draft
  - name: constant
    source: wh
    type: derived
    expr: "42"
    description: No placeholder.
    status: draft
  - name: mixed
    source: wh
    type: derived
    expr: "{orders.revenue} / {orders.Order_Count}"
    description: One good, one bad.
    status: draft
`;
    writeFileSync(join(root, "metrics.yaml"), odd);
    const upper = await approve(root, ["--target", "metric:upper", "--by", "Dana"]);
    expect(upper.code).toBe(1);
    expect(upper.err).toContain("placeholder {Orders.Revenue} is not {model.measure}");
    const spaced = await approve(root, ["--target", "metric:spaced", "--by", "Dana"]);
    expect(spaced.code).toBe(1);
    expect(spaced.err).toContain("placeholder { orders.revenue } is not {model.measure}");
    const constant = await approve(root, ["--target", "metric:constant", "--by", "Dana"]);
    expect(constant.code).toBe(1);
    expect(constant.err).toContain("has no {model.measure} placeholder");
    const mixed = await approve(root, ["--target", "metric:mixed", "--by", "Dana"]);
    expect(mixed.code).toBe(1);
    expect(mixed.err).toContain("{orders.Order_Count}");
    expect(text(root, "metrics.yaml")).toBe(odd);
  });

  test("an already approved metric is a no-op even when a measure became a draft", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana"]);
    await approve(root, ["--target", "wh.orders.order_count", "--by", "Dana"]);
    await approve(root, ["--target", "metric:aov", "--by", "Dana"]);
    await approve(root, ["--target", "wh.orders.revenue", "--revoke"]);
    const before = text(root, "metrics.yaml");
    const r = await approve(root, ["--target", "metric:aov", "--by", "Dana"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("metric:aov is already approved");
    expect(text(root, "metrics.yaml")).toBe(before);
  });

  test("a golden points to sl goldens confirm", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "golden:revenue_2025", "--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl goldens confirm --name revenue_2025");
  });

  test("unknown targets and fields", async () => {
    const root = await project();
    const field = await approve(root, ["--target", "wh.orders.nope", "--by", "Dana"]);
    expect(field.code).toBe(1);
    expect(field.err).toContain("Known: order_status, revenue, order_count, customer");
    const model = await approve(root, ["--target", "wh.nope", "--by", "Dana"]);
    expect(model.code).toBe(1);
    expect(model.err).toContain('No model "nope"');
    const shape = await approve(root, ["--target", "a.b.c.d", "--by", "Dana"]);
    expect(shape.code).toBe(1);
    expect(shape.err).toContain("Cannot read target");
  });

  test("a missing access file, and one holding only comments", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const r = await approve(t.root, ["--target", "access", "--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No access.yaml");
    writeFileSync(join(t.root, "access.yaml"), "# todo\n");
    const empty = await approve(t.root, ["--target", "access", "--by", "Dana"]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("access.yaml has no roles yet");
    expect(text(t.root, "access.yaml")).toBe("# todo\n");
  });
});

describe("approve --recursive and --revoke", () => {
  test("--recursive approves the model and every child, warning on joins without evidence", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana"]);
    const r = await approve(root, ["--target", "wh.orders", "--by", "Dana", "--recursive", "--json"]);
    expect(r.code).toBe(0);
    const res = r.json<Result>();
    expect(res.changed.map((c) => c.target)).toEqual(["wh.orders", "wh.orders.order_status", "wh.orders.order_count", "wh.orders.customer"]);
    expect(res.warnings).toHaveLength(1);
    const o = orders(root);
    expect([o.status, ...o.dimensions.map((d) => d.status), ...o.measures.map((m) => m.status), ...o.joins!.map((j) => j.status)]).toEqual(
      Array(5).fill("approved"),
    );
    expect(text(root, "models/wh/orders.yaml")).toContain("# Gross revenue before refunds.");
  });

  test("--recursive lists every child that cannot be approved and approves nothing", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.customers", "--by", "Dana", "--recursive"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing was approved");
    expect(r.err).toContain("wh.customers has no grain");
    expect(r.err).toContain("wh.customers has no primary_key");
    expect(r.err).toContain("Measure wh.customers.customer_count has no description");
    expect(text(root, "models/wh/customers.yaml")).toBe(CUSTOMERS);
  });

  test("--recursive applies only to a model", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "metric:aov", "--by", "Dana", "--recursive"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--recursive applies only");
  });

  test("--revoke returns an item to draft and drops the approver", async () => {
    const root = await project();
    await approve(root, ["--target", "wh.orders", "--by", "Dana", "--recursive"]);
    const r = await approve(root, ["--target", "wh.orders.revenue", "--revoke", "--json"]);
    expect(r.json<Result>().changed).toEqual([{ target: "wh.orders.revenue", from: "approved", to: "draft" }]);
    const o = orders(root);
    expect(o.measures[0]!.status).toBe("draft");
    expect(o.measures[0]!.approved_by).toBeUndefined();
    expect(o.measures[0]!.approved_at).toBeUndefined();
    expect(o.status).toBe("approved");

    const all = await approve(root, ["--target", "wh.orders", "--revoke", "--recursive", "--json"]);
    expect(all.json<Result>().changed.map((c) => c.target)).toEqual(["wh.orders", "wh.orders.order_status", "wh.orders.order_count", "wh.orders.customer"]);
    const raw = text(root, "models/wh/orders.yaml");
    expect(raw).not.toContain("approved");
    expect(raw).toContain("status: draft # waiting on Dana");
    expect(raw).toContain("status: draft # confirm the values");

    const again = await approve(root, ["--target", "wh.orders", "--revoke"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already a draft");
  });

  test("--revoke on the access file and a metric", async () => {
    const root = await project();
    await approve(root, ["--target", "access", "--by", "Dana"]);
    const a = await approve(root, ["--target", "access", "--revoke", "--json"]);
    expect(a.json<Result>().changed).toEqual([{ target: "access", from: "approved", to: "draft" }]);
    expect(text(root, "access.yaml")).toBe(ACCESS);
    // A draft metric that fails approval checks can still be revoked (a no-op here).
    const m = await approve(root, ["--target", "metric:vague", "--revoke", "--json"]);
    expect(m.code).toBe(0);
    expect(m.json<Result>().changed).toEqual([]);
  });
});

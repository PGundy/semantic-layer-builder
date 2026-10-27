import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AccessUser,
  type AccessVisibility,
  checkRequest,
  evaluateAccess,
  type FieldVisibility,
  type HierarchyFilterResult,
  type MetricVisibility,
  type ModelVisibility,
  type ExprFilterResult,
} from "../skills/semantic-layer/scripts/lib/access.ts";
import type { AccessFile, Join, Metric, Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const OK = { status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" };
const DRAFT = { status: "draft" as const };

function dim(name: string, extra: Record<string, unknown> = {}) {
  return { name, expr: name, type: "string" as const, ...OK, ...extra };
}
function measure(name: string, extra: Record<string, unknown> = {}) {
  return { name, expr: name, agg: "sum" as const, ...OK, ...extra };
}
function model(name: string, dims: ReturnType<typeof dim>[], measures: ReturnType<typeof measure>[], extra: Partial<Model> = {}): Model {
  return { model: name, source: "wh", table: `main.${name}`, ...OK, grain: "one row", primary_key: ["id"], dimensions: dims, measures, ...extra };
}

const MODELS: Model[] = [
  model(
    "orders",
    [dim("order_status"), dim("region"), dim("internal_note", DRAFT), dim("created_at", { type: "time" })],
    [measure("revenue"), measure("cost", { tags: ["sensitive"] }), measure("order_count", { agg: "count", expr: undefined })],
  ),
  model("customers", [dim("email", { tags: ["pii"] }), dim("full_name", { tags: ["pii", "public"] }), dim("segment", { tags: ["public"] })], [measure("customer_count")]),
  model("payroll", [dim("employee_id")], [measure("total_salary")], { tags: ["sensitive"] }),
  model("staging", [dim("x")], [], DRAFT),
  model("reporting_lines", [dim("manager_id"), dim("member_id")], []),
  model("tickets", [dim("assignee_id")], [measure("ticket_count")]),
];

const METRICS: Metric[] = [
  { name: "aov", source: "wh", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", ...OK },
  { name: "margin", source: "wh", type: "derived", expr: "{orders.revenue} - {orders.cost}", ...OK },
  { name: "draft_metric", source: "wh", type: "derived", expr: "{orders.revenue} * 2", ...DRAFT },
  { name: "tickets_per_order", source: "wh", type: "ratio", numerator: "tickets.ticket_count", denominator: "orders.order_count", ...OK },
];

async function setup(access?: Partial<AccessFile> | string): Promise<string> {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  await initProject(t.root);
  writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb" });
  for (const m of MODELS) writeYaml(join(t.root, "models", "wh", `${m.model}.yaml`), m);
  writeYaml(join(t.root, "metrics.yaml"), { metrics: METRICS });
  if (typeof access === "string") writeFileSync(join(t.root, "access.yaml"), access);
  else if (access) writeYaml(join(t.root, "access.yaml"), { ...OK, ...access });
  return t.root;
}

function modelOf(v: AccessVisibility, name: string): ModelVisibility {
  const m = v.sources.find((s) => s.source === "wh")!.models.find((x) => x.model === name);
  if (!m) throw new Error(`no model ${name}`);
  return m;
}
function fieldOf(v: AccessVisibility, ref: string): FieldVisibility {
  const [m, f] = ref.split(".") as [string, string];
  const hit = modelOf(v, m).fields.find((x) => x.name === f);
  if (!hit) throw new Error(`no field ${ref}`);
  return hit;
}
function metricOf(v: AccessVisibility, name: string): MetricVisibility {
  const hit = v.sources.find((s) => s.source === "wh")!.metrics.find((x) => x.name === name);
  if (!hit) throw new Error(`no metric ${name}`);
  return hit;
}
const eva = (root: string, user: AccessUser = {}) => evaluateAccess(root, user);

const ATTRS = [
  { name: "region", type: "string" as const },
  { name: "level", type: "number" as const },
  { name: "employee_id", type: "number" as const },
  { name: "teams", type: "string_list" as const },
];

describe("open mode with no access.yaml", () => {
  test("the default audience sees every approved item except protected tags", async () => {
    const root = await setup();
    const v = eva(root);
    expect(v.mode).toBe("open");
    expect(v.access_file).toBe("missing");
    expect(v.roles).toEqual([]);
    expect(v.user.default_audience).toBe(true);
    expect(modelOf(v, "orders").visible).toBe(true);
    expect(modelOf(v, "orders").row_filters).toEqual({ rows: "all", branches: [] });
    expect(fieldOf(v, "orders.revenue").visible).toBe(true);
    expect(fieldOf(v, "orders.cost").reasons).toEqual(["protected_tag:sensitive"]);
    expect(fieldOf(v, "customers.email").reasons).toEqual(["protected_tag:pii"]);
    // public never overrides pii on the same field.
    expect(fieldOf(v, "customers.full_name").reasons).toEqual(["protected_tag:pii"]);
    expect(fieldOf(v, "customers.segment").visible).toBe(true);
    // A model's protected tag covers its fields.
    expect(modelOf(v, "payroll").reasons).toEqual(["protected_tag:sensitive"]);
    expect(fieldOf(v, "payroll.employee_id").reasons).toEqual(["protected_tag:sensitive", "model_hidden"]);
    expect(modelOf(v, "payroll").row_filters).toBeUndefined();
    expect(metricOf(v, "aov").visible).toBe(true);
    expect(metricOf(v, "margin").reasons).toEqual(["measure_hidden:orders.cost"]);
    // payroll, its two fields, cost, email, full_name.
    expect(v.summary.hidden_by_protected_tags).toBe(6);
  });

  test("draft items are hidden with reason draft", async () => {
    const root = await setup();
    const v = eva(root);
    expect(modelOf(v, "staging").reasons).toEqual(["draft"]);
    expect(fieldOf(v, "staging.x").reasons).toEqual(["model_hidden"]);
    expect(fieldOf(v, "orders.internal_note").reasons).toEqual(["draft"]);
    expect(metricOf(v, "draft_metric").reasons).toEqual(["draft"]);
    expect(v.summary.models).toEqual({ visible: 4, hidden: 2 });
  });

  test("roles passed with no access.yaml are unknown", async () => {
    const root = await setup();
    const v = eva(root, { roles: ["admin"] });
    expect(v.roles).toEqual([]);
    expect(v.unknown_roles).toEqual(["admin"]);
  });
});

describe("protected tags", () => {
  test("a role granting pii shows pii fields but not sensitive ones", async () => {
    const root = await setup({ user_attributes: ATTRS, roles: [{ name: "support", allow: { tags: ["pii"] } }] });
    const plain = eva(root);
    expect(fieldOf(plain, "customers.email").visible).toBe(false);
    const v = eva(root, { roles: ["support"] });
    expect(v.roles).toEqual([{ name: "support", how: "assigned" }]);
    expect(fieldOf(v, "customers.email").visible).toBe(true);
    expect(fieldOf(v, "customers.full_name").visible).toBe(true);
    expect(fieldOf(v, "orders.cost").reasons).toEqual(["protected_tag:sensitive"]);
    expect(modelOf(v, "payroll").visible).toBe(false);
  });

  test("one held role's tag grant combines with another role's visibility", async () => {
    const root = await setup({
      mode: "closed",
      roles: [
        { name: "analyst", allow: { models: ["wh.customers"] } },
        { name: "privacy", allow: { models: ["wh.orders"], tags: ["pii"] } },
      ],
    });
    const v = eva(root, { roles: ["analyst", "privacy"] });
    expect(fieldOf(v, "customers.email").visible).toBe(true);
    // cost and payroll with its two fields stay hidden by sensitive.
    expect(v.summary.hidden_by_protected_tags).toBe(4);
    expect(eva(root, { roles: ["analyst"] }).summary.hidden_by_protected_tags).toBe(6);
  });

  test("protected tags on a metric hide it", async () => {
    const t = await setup();
    writeYaml(join(t, "metrics.yaml"), { metrics: [{ ...METRICS[0]!, tags: ["sensitive"] }] });
    expect(metricOf(eva(t), "aov").reasons).toEqual(["protected_tag:sensitive"]);
  });
});

describe("closed mode", () => {
  const access: Partial<AccessFile> = {
    mode: "closed",
    roles: [
      { name: "analyst", allow: { models: ["wh.orders", "wh.cust*"] } },
      { name: "nothing" },
    ],
  };

  test("a role sees only what allow.models matches", async () => {
    const root = await setup(access);
    const v = eva(root, { roles: ["analyst"] });
    expect(v.mode).toBe("closed");
    expect(modelOf(v, "orders").visible).toBe(true);
    expect(modelOf(v, "customers").visible).toBe(true);
    expect(modelOf(v, "tickets").reasons).toEqual(["not_allowed"]);
    expect(fieldOf(v, "tickets.ticket_count").reasons).toEqual(["not_allowed", "model_hidden"]);
    expect(metricOf(v, "aov").visible).toBe(true);
    expect(metricOf(v, "tickets_per_order").reasons).toEqual(["measure_hidden:tickets.ticket_count"]);
  });

  test("a user holding no role sees nothing", async () => {
    const root = await setup(access);
    const v = eva(root);
    expect(v.summary.models.visible).toBe(0);
    expect(modelOf(v, "orders").reasons).toEqual(["not_allowed"]);
  });

  test("a role without allow.models allows nothing and is reported", async () => {
    const root = await setup(access);
    const v = eva(root, { roles: ["nothing"] });
    expect(v.summary.models.visible).toBe(0);
    expect(v.skipped).toContainEqual({ path: "roles[1].allow.models", message: "is missing; in closed mode the role allows no model" });
  });

  test("allow.models has no effect in open mode", async () => {
    const root = await setup({ roles: [{ name: "analyst", allow: { models: ["wh.orders"] } }] });
    expect(modelOf(eva(root, { roles: ["analyst"] }), "tickets").visible).toBe(true);
  });
});

describe("multiple roles", () => {
  const access: Partial<AccessFile> = {
    user_attributes: ATTRS,
    roles: [
      {
        name: "rep",
        deny: { models: ["wh.tickets"] },
        row_filters: [
          { model: "wh.orders", expr: "region = {{ user.region }}" },
          { model: "wh.orders", expr: "order_status <> 'void'" },
        ],
      },
      { name: "team", deny: { fields: ["wh.orders.region"] }, row_filters: [{ model: "wh.orders", expr: "team in {{ user.teams }}" }] },
      { name: "auditor", deny: { fields: ["wh.orders.region"], tags: ["public"] } },
    ],
  };

  test("an item is visible when any held role shows it", async () => {
    const root = await setup(access);
    const rep = eva(root, { roles: ["rep"] });
    expect(modelOf(rep, "tickets").reasons).toEqual(["denied:rep"]);
    const team = eva(root, { roles: ["team"] });
    expect(fieldOf(team, "orders.region").reasons).toEqual(["denied:team"]);
    const both = eva(root, { roles: ["rep", "team"] });
    expect(modelOf(both, "tickets").visible).toBe(true);
    expect(fieldOf(both, "orders.region").visible).toBe(true);
    const two = eva(root, { roles: ["team", "auditor"] });
    expect(fieldOf(two, "orders.region").reasons).toEqual(["denied:team", "denied:auditor"]);
    // A tag denial on a field.
    expect(fieldOf(eva(root, { roles: ["auditor"] }), "customers.segment").reasons).toEqual(["denied:auditor"]);
  });

  test("row filters: AND within a role, OR across roles", async () => {
    const root = await setup(access);
    const v = eva(root, { roles: ["rep", "team"], attributes: { region: "emea", teams: ["a", "b"] } });
    const rows = modelOf(v, "orders").row_filters!;
    expect(rows.rows).toBe("filtered");
    expect(rows.branches).toEqual([
      {
        role: "rep",
        no_rows: false,
        problems: [],
        filters: [
          { kind: "expr", expr: "region = {{ user.region }}", params: { region: "emea" }, missing: [] },
          { kind: "expr", expr: "order_status <> 'void'", params: {}, missing: [] },
        ],
      },
      { role: "team", no_rows: false, problems: [], filters: [{ kind: "expr", expr: "team in {{ user.teams }}", params: { teams: ["a", "b"] }, missing: [] }] },
    ]);
  });

  test("a held role with no filter on the model contributes every row", async () => {
    const root = await setup(access);
    const v = eva(root, { roles: ["rep", "auditor"], attributes: { region: "emea" } });
    expect(modelOf(v, "orders").row_filters).toEqual({ rows: "all", branches: [] });
  });

  test("a missing attribute empties only its role's branch", async () => {
    const root = await setup(access);
    const v = eva(root, { roles: ["rep", "team"], attributes: { teams: ["a"] } });
    const rows = modelOf(v, "orders").row_filters!;
    expect(rows.rows).toBe("filtered");
    expect(rows.branches[0]!.no_rows).toBe(true);
    expect(rows.branches[0]!.filters[0]!.missing).toEqual(["region"]);
    expect(rows.branches[1]!.no_rows).toBe(false);
    const none = eva(root, { roles: ["rep"] });
    expect(modelOf(none, "orders").row_filters!.rows).toBe("none");
  });

  test("in closed mode only roles that allow the model contribute rows", async () => {
    const root = await setup({
      mode: "closed",
      user_attributes: ATTRS,
      roles: [
        { name: "rep", allow: { models: ["wh.orders"] }, row_filters: [{ model: "wh.orders", expr: "region = {{ user.region }}" }] },
        { name: "helpdesk", allow: { models: ["wh.tickets"] } },
      ],
    });
    const v = eva(root, { roles: ["rep", "helpdesk"], attributes: { region: "us" } });
    expect(modelOf(v, "orders").row_filters!.branches.map((b) => b.role)).toEqual(["rep"]);
    expect(modelOf(v, "tickets").row_filters!.rows).toBe("all");
  });

  test("a user holding no role in open mode has no row filters", async () => {
    const root = await setup(access);
    expect(modelOf(eva(root), "orders").row_filters!.rows).toBe("all");
  });
});

describe("role assignment", () => {
  const access: Partial<AccessFile> = {
    user_attributes: ATTRS,
    default_role: "viewer",
    roles: [
      { name: "viewer", deny: { models: ["wh.tickets"] } },
      { name: "emea", assign_when: "user.region == 'emea'" },
      { name: "senior", assign_when: "user.level >= 5 and user.teams contains 'core'" },
      { name: "admin" },
    ],
  };

  test("assign_when holds a role by condition", async () => {
    const root = await setup(access);
    const v = eva(root, { attributes: { region: "emea", level: 7, teams: ["core"] } });
    expect(v.roles).toEqual([
      { name: "emea", how: "condition", condition: "user.region == 'emea'" },
      { name: "senior", how: "condition", condition: "user.level >= 5 and user.teams contains 'core'" },
    ]);
    expect(eva(root, { attributes: { region: "us" } }).roles.map((r) => r.name)).toEqual(["viewer"]);
  });

  test("an assigned role that also matches its condition is reported as assigned", async () => {
    const root = await setup(access);
    expect(eva(root, { roles: ["emea"], attributes: { region: "emea" } }).roles).toEqual([{ name: "emea", how: "assigned" }]);
  });

  test("default_role applies only when the user holds no other role", async () => {
    const root = await setup(access);
    const def = eva(root);
    expect(def.roles).toEqual([{ name: "viewer", how: "default" }]);
    expect(modelOf(def, "tickets").reasons).toEqual(["denied:viewer"]);
    const admin = eva(root, { roles: ["admin"] });
    expect(admin.roles).toEqual([{ name: "admin", how: "assigned" }]);
    expect(modelOf(admin, "tickets").visible).toBe(true);
    expect(eva(root, { attributes: { region: "emea" } }).roles.map((r) => r.name)).toEqual(["emea"]);
  });

  test("attributes not declared are listed", async () => {
    const root = await setup(access);
    expect(eva(root, { attributes: { region: "emea", shoe_size: 9 } }).undeclared_attributes).toEqual(["shoe_size"]);
  });
});

describe("restrictions", () => {
  const access: Partial<AccessFile> = {
    user_attributes: ATTRS,
    roles: [{ name: "finance" }, { name: "support", allow: { tags: ["sensitive"] } }],
    restrictions: [
      { name: "finance_only", targets: ["metric:a*", "wh.orders.rev*"], allow: { roles: ["finance"] } },
      { name: "managers", targets: ["wh.tickets"], allow: { when: "user.level >= 5" } },
      { name: "either", targets: ["wh.customers.segment"], allow: { roles: ["support"], when: "user.region == 'emea'" } },
    ],
  };

  test("restricted by role on metrics and fields with globs", async () => {
    const root = await setup(access);
    const v = eva(root);
    expect(metricOf(v, "aov").reasons).toEqual(["restricted:finance_only", "measure_hidden:orders.revenue"]);
    expect(fieldOf(v, "orders.revenue").reasons).toEqual(["restricted:finance_only"]);
    expect(fieldOf(v, "orders.order_status").visible).toBe(true);
    // The metric is hidden through its measure as well.
    expect(metricOf(v, "draft_metric").reasons).toContain("measure_hidden:orders.revenue");
    const fin = eva(root, { roles: ["finance"] });
    expect(metricOf(fin, "aov").visible).toBe(true);
    expect(fieldOf(fin, "orders.revenue").visible).toBe(true);
  });

  test("restricted by condition on a model", async () => {
    const root = await setup(access);
    expect(modelOf(eva(root, { attributes: { level: 3 } }), "tickets").reasons).toEqual(["restricted:managers"]);
    expect(fieldOf(eva(root), "tickets.assignee_id").reasons).toEqual(["model_hidden"]);
    expect(modelOf(eva(root, { attributes: { level: 5 } }), "tickets").visible).toBe(true);
  });

  test("roles or when, either suffices", async () => {
    const root = await setup(access);
    expect(fieldOf(eva(root), "customers.segment").reasons).toEqual(["restricted:either"]);
    expect(fieldOf(eva(root, { roles: ["support"] }), "customers.segment").visible).toBe(true);
    expect(fieldOf(eva(root, { attributes: { region: "emea" } }), "customers.segment").visible).toBe(true);
  });

  test("restrictions apply in closed mode after role visibility", async () => {
    const root = await setup({ ...access, mode: "closed", roles: [{ name: "finance", allow: { models: ["wh.*"] } }, { name: "analyst", allow: { models: ["wh.*"] } }] });
    expect(fieldOf(eva(root, { roles: ["analyst"] }), "orders.revenue").reasons).toEqual(["restricted:finance_only"]);
    expect(fieldOf(eva(root, { roles: ["finance"] }), "orders.revenue").visible).toBe(true);
  });

  test("a restriction with neither roles nor when hides its targets from everyone", async () => {
    const root = await setup({ roles: [{ name: "finance" }], restrictions: [{ name: "locked", targets: ["metric:aov"], allow: {} }] });
    const v = eva(root, { roles: ["finance"] });
    expect(metricOf(v, "aov").reasons).toEqual(["restricted:locked"]);
    expect(v.skipped.map((s) => s.path)).toContain("restrictions[0].allow");
  });
});

describe("metrics", () => {
  test("a metric is hidden when one of its measures is denied", async () => {
    const root = await setup({ roles: [{ name: "r", deny: { fields: ["wh.orders.order_count"] } }] });
    const v = eva(root, { roles: ["r"] });
    expect(metricOf(v, "aov").reasons).toEqual(["measure_hidden:orders.order_count"]);
  });

  test("a metric naming an unknown measure is hidden", async () => {
    const root = await setup();
    writeYaml(join(root, "metrics.yaml"), { metrics: [{ ...METRICS[0]!, numerator: "orders.nope" }] });
    expect(metricOf(eva(root), "aov").reasons).toEqual(["unknown_measure:orders.nope"]);
  });
});

describe("span of control", () => {
  const hierarchy = { column: "assignee_id", via: "wh.reporting_lines", manager: "manager_id", member: "member_id", user: "user.employee_id" };
  const access = (h: Record<string, unknown>): Partial<AccessFile> => ({
    user_attributes: ATTRS,
    roles: [{ name: "manager", row_filters: [{ model: "wh.tickets", hierarchy: h } as never] }],
  });

  test("a hierarchy filter is returned structurally with the bound user id", async () => {
    const root = await setup(access(hierarchy));
    const rows = modelOf(eva(root, { roles: ["manager"], attributes: { employee_id: 42 } }), "tickets").row_filters!;
    expect(rows.rows).toBe("filtered");
    const f = rows.branches[0]!.filters[0] as HierarchyFilterResult;
    expect(f).toEqual({
      kind: "hierarchy",
      column: "assignee_id",
      via: "wh.reporting_lines",
      manager: "manager_id",
      member: "member_id",
      user: "employee_id",
      include_self: true,
      user_value: 42,
      missing: [],
    });
  });

  test("include_self false is carried", async () => {
    const root = await setup(access({ ...hierarchy, include_self: false, user: "employee_id" }));
    const f = modelOf(eva(root, { roles: ["manager"], attributes: { employee_id: 1 } }), "tickets").row_filters!.branches[0]!.filters[0] as HierarchyFilterResult;
    expect(f.include_self).toBe(false);
    expect(f.user).toBe("employee_id");
  });

  test("a user lacking the user attribute sees no rows", async () => {
    const root = await setup(access(hierarchy));
    const rows = modelOf(eva(root, { roles: ["manager"] }), "tickets").row_filters!;
    expect(rows.rows).toBe("none");
    expect(rows.branches[0]!.filters[0]!.missing).toEqual(["employee_id"]);
  });

  test("a hierarchy filter that cannot be read means no rows", async () => {
    const root = await setup(access({ ...hierarchy, via: "wh.nowhere" }));
    const rows = modelOf(eva(root, { roles: ["manager"], attributes: { employee_id: 1 } }), "tickets").row_filters!;
    expect(rows.rows).toBe("none");
    expect(rows.branches[0]!.problems[0]).toContain('"wh.nowhere" is not a model');
    const root2 = await setup(access({ column: "assignee_id" }));
    const rows2 = modelOf(eva(root2, { roles: ["manager"], attributes: { employee_id: 1 } }), "tickets").row_filters!;
    expect(rows2.rows).toBe("none");
    expect(rows2.branches[0]!.problems[0]).toContain("lacks via, manager, member, user");
  });
});

describe("checkRequest", () => {
  test("refuses a hidden field in every position", async () => {
    const root = await setup();
    const v = eva(root);
    const ok = checkRequest(v, {
      source: "wh",
      measures: ["orders.revenue", "aov"],
      dimensions: ["orders.created_at:month"],
      filters: [{ field: "orders.order_status", op: "eq", value: "paid" }],
      order_by: [{ field: "orders.revenue" }],
    });
    expect(ok).toEqual({ ok: true, problems: [] });

    const bad = checkRequest(v, {
      source: "wh",
      measures: ["orders.cost", "margin"],
      dimensions: ["customers.email"],
      filters: [{ field: "orders.internal_note", op: "is_null" }],
      order_by: [{ field: "payroll.total_salary", direction: "desc" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems.map((p) => [p.position, p.index, p.ref, p.reasons])).toEqual([
      ["measures", 0, "orders.cost", ["protected_tag:sensitive"]],
      ["measures", 1, "margin", ["measure_hidden:orders.cost"]],
      ["dimensions", 0, "customers.email", ["protected_tag:pii"]],
      ["filters", 0, "orders.internal_note", ["draft"]],
      ["order_by", 0, "payroll.total_salary", ["protected_tag:sensitive", "model_hidden"]],
    ]);
    expect(bad.problems[2]!.message).toBe("dimensions[0] names customers.email, which this user may not see (protected_tag:pii)");
  });

  test("refuses unknown references and unknown sources", async () => {
    const root = await setup();
    const v = eva(root);
    const r = checkRequest(v, { source: "wh", measures: ["orders.nope", "Bad Ref"], dimensions: [] });
    expect(r.problems.map((p) => p.reasons)).toEqual([["unknown"], ["unknown"]]);
    expect(checkRequest(v, { source: "lake", measures: ["orders.revenue"] }).ok).toBe(false);
  });

  test("refuses every request while access.yaml is a draft", async () => {
    const root = await setup();
    const v = { ...eva(root), access_file: "draft" as const };
    const r = checkRequest(v, { source: "wh", measures: ["orders.revenue"] });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.position, p.reasons])).toEqual([["access", ["access_draft"]]]);
  });
});

describe("defensive reading of access.yaml", () => {
  test("unreadable grants are ignored and the rest still applies", async () => {
    const root = await setup(`status: draft
mode: open
user_attributes:
  - name: region
    type: string
roles:
  - name: viewer
    allow: { tags: pii }
    deny: { models: [wh.tickets] }
    row_filters:
      - model: wh.orders
  - name: rep
    allow: "everything"
restrictions:
  - name: r1
    targets: ["metric:aov"]
    allow: { when: "user.region ==" }
`);
    const v = eva(root, { roles: ["viewer", "rep"] });
    expect(v.access_file).toBe("draft");
    expect(v.broken_roles).toEqual([]);
    expect(v.skipped).toEqual(
      expect.arrayContaining([
        { path: "roles[0].allow.tags", message: "is not a list; ignored" },
        { path: "roles[1].allow", message: "is not a mapping; ignored" },
        expect.objectContaining({ path: "restrictions[0].allow.when" }),
      ]),
    );
    // rep sees tickets, so the union shows it; the unreadable pii grant grants nothing.
    expect(modelOf(v, "tickets").visible).toBe(true);
    expect(fieldOf(v, "customers.email").reasons).toEqual(["protected_tag:pii"]);
    // viewer's filter on orders has neither expr nor hierarchy, so no rows from viewer; rep has none.
    expect(modelOf(v, "orders").row_filters!.rows).toBe("all");
    const viewer = eva(root, { roles: ["viewer"] });
    expect(modelOf(viewer, "orders").row_filters!.rows).toBe("none");
    expect(modelOf(viewer, "orders").row_filters!.branches[0]!.problems).toEqual([
      "roles[0].row_filters[0] has neither expr nor hierarchy; treated as no rows",
    ]);
    // An unreadable condition is false: the restriction hides aov.
    expect(metricOf(v, "aov").reasons).toEqual(["restricted:r1"]);
  });

  test("an unknown mode is treated as closed", async () => {
    const root = await setup({ mode: "half" as never });
    const v = eva(root);
    expect(v.mode).toBe("closed");
    expect(v.skipped[0]).toEqual({ path: "mode", message: '"half" is not open or closed; treated as closed' });
  });

  test("an unparsable access.yaml is treated as closed", async () => {
    const root = await setup("roles: [unclosed\n");
    const v = eva(root);
    expect(v.mode).toBe("closed");
    expect(v.access_file).toBe("invalid");
    expect(v.summary.models.visible).toBe(0);
    expect(v.skipped.some((s) => s.path === "access.yaml")).toBe(true);
  });

  test("an unreadable model file is skipped", async () => {
    const root = await setup();
    writeFileSync(join(root, "models", "wh", "broken.yaml"), "model: [\n");
    const v = eva(root);
    expect(v.skipped.map((s) => s.path)).toContain("models/wh/broken.yaml");
    expect(modelOf(v, "orders").visible).toBe(true);
  });
});

const contractor = (extra: Record<string, unknown>): Partial<AccessFile> => ({ user_attributes: ATTRS, roles: [{ name: "contractor", ...extra } as never] });
const allHidden = (v: AccessVisibility) => v.summary.models.visible + v.summary.fields.visible + v.summary.metrics.visible === 0;

describe("restrictions that cannot be read fail closed", () => {
  test("a bare string target is one target", async () => {
    const root = await setup({ restrictions: [{ name: "regional", targets: "wh.orders.region" as never, allow: { roles: ["rep"] } }] });
    const v = eva(root);
    expect(v.access_file).toBe("approved");
    expect(fieldOf(v, "orders.region").reasons).toEqual(["restricted:regional"]);
    expect(fieldOf(v, "orders.revenue").visible).toBe(true);
    expect(v.skipped).toEqual([]);
  });

  const invalid = async (restrictions: unknown, path: string) => {
    const root = await setup({ roles: [{ name: "rep" }], restrictions: restrictions as never });
    for (const user of [{}, { roles: ["rep"] }]) {
      const v = eva(root, user);
      expect(v.access_file).toBe("invalid");
      expect(v.mode).toBe("closed");
      expect(v.roles).toEqual([]);
      expect(allHidden(v)).toBe(true);
      expect(fieldOf(v, "orders.region").reasons).toContain("not_allowed");
      expect(v.skipped.map((s) => s.path)).toContain(path);
      expect(v.skipped.at(-1)).toEqual({
        path: "restrictions",
        message: "a restriction cannot be read, so what it protects is unknown; nothing in access.yaml applies and access is treated as closed",
      });
    }
  };

  test("an entry that is not a mapping", async () => {
    await invalid(["wh.orders.region"], "restrictions[0]");
  });
  test("a target that is not a valid pattern", async () => {
    await invalid([{ name: "r", targets: ["wh.orders.revenue", "re:(wh.orders.region"], allow: { roles: ["rep"] } }], "restrictions[0].targets[1]");
  });
  test("a target that is not text", async () => {
    await invalid([{ name: "r", targets: [7], allow: { roles: ["rep"] } }], "restrictions[0].targets[0]");
  });
  test("missing or empty targets", async () => {
    await invalid([{ name: "r", allow: { roles: ["rep"] } }], "restrictions[0].targets");
    await invalid([{ name: "r", targets: [], allow: { roles: ["rep"] } }], "restrictions[0].targets");
    await invalid([{ name: "r", targets: ["  "], allow: { roles: ["rep"] } }], "restrictions[0].targets[0]");
  });
  test("restrictions that are not a list", async () => {
    await invalid({ name: "r", targets: ["wh.orders.region"] }, "restrictions");
  });

  test("a target that matches nothing is a warning", async () => {
    const root = await setup({
      restrictions: [{ name: "r", targets: ["aov", "metric:nope", "wh.orders.region"], allow: { roles: ["finance"] } }],
    });
    const v = eva(root);
    expect(metricOf(v, "aov").visible).toBe(true);
    expect(fieldOf(v, "orders.region").reasons).toEqual(["restricted:r"]);
    expect(v.warnings).toEqual([
      { path: "restrictions[0].targets[0]", message: '"aov" matches no model or field, so it hides nothing; write metric:aov to name a metric' },
      { path: "restrictions[0].targets[1]", message: '"metric:nope" matches no metric, so it hides nothing' },
    ]);
  });
});

describe("roles that cannot be read fail closed", () => {
  const expectBroken = (v: AccessVisibility, name: string) => {
    expect(v.broken_roles).toContain(name);
    expect(allHidden(v)).toBe(true);
    expect(modelOf(v, "orders").reasons).toContain(`broken_role:${name}`);
    expect(modelOf(v, "orders").row_filters).toBeUndefined();
    expect(fieldOf(v, "orders.region").reasons).toContain(`broken_role:${name}`);
    expect(metricOf(v, "aov").reasons).toContain(`broken_role:${name}`);
  };
  const expectFine = (v: AccessVisibility) => {
    expect(v.broken_roles).toEqual([]);
    expect(modelOf(v, "orders").visible).toBe(true);
  };

  for (const [label, extra, path] of [
    ["deny.fields is not a list", { deny: { fields: "wh.orders.region" } }, "roles[0].deny.fields"],
    ["deny is not a mapping", { deny: "everything" }, "roles[0].deny"],
    ["deny.models holds an invalid pattern", { deny: { models: ["re:("] } }, "roles[0].deny.models[0]"],
    ["deny.tags holds a non-text item", { deny: { tags: [3] } }, "roles[0].deny.tags[0]"],
    ["a row filter has no model", { row_filters: [{ modl: "wh.orders", expr: "region = {{ user.region }}" }] }, "roles[0].row_filters[0]"],
    ["a row filter names an unknown model", { row_filters: [{ model: "wh.order", expr: "region = {{ user.region }}" }] }, "roles[0].row_filters[0].model"],
    ["a row filter is not a mapping", { row_filters: ["wh.orders"] }, "roles[0].row_filters[0]"],
    ["row_filters is a mapping", { row_filters: { model: "wh.orders", expr: "region = {{ user.region }}" } }, "roles[0].row_filters"],
  ] as const) {
    test(`${label}: the holder sees nothing`, async () => {
      const root = await setup(contractor(extra));
      const v = eva(root, { roles: ["contractor"], attributes: { region: "emea" } });
      expectBroken(v, "contractor");
      const s = v.skipped.find((x) => x.path === path);
      expect(s?.message).toEndWith("; the role is broken and a user holding it sees nothing");
      // A user not holding it keeps the open baseline.
      expectFine(eva(root));
    });
  }

  test("an unreadable assign_when might hold for anyone, so every user sees nothing", async () => {
    const root = await setup(contractor({ assign_when: "user.org = 'x'", row_filters: [{ model: "wh.orders", expr: "region = {{ user.region }}" }] }));
    for (const user of [{}, { attributes: { region: "emea" } }, { roles: ["contractor"] }]) expectBroken(eva(root, user), "contractor");
    expect(eva(root, { attributes: { org: "x" } }).roles).toEqual([]);
    const v = eva(root);
    expect(v.skipped.find((x) => x.path === "roles[0].assign_when")?.message).toEndWith(
      "; the role is broken and, since the condition might hold for anyone, every user sees nothing",
    );
  });

  test("a role entry with an invalid name breaks a user assigned that name, in any letter case", async () => {
    const root = await setup({ roles: [{ name: "Contractor", deny: { fields: ["wh.orders.region"] } }] });
    for (const roles of [["Contractor"], ["contractor"], [" CONTRACTOR "]]) expectBroken(eva(root, { roles }), "Contractor");
    expectFine(eva(root));
    expectFine(eva(root, { roles: ["other"] }));
    expect(eva(root).skipped[0]!.path).toBe("roles[0]");
  });

  test("a skipped role entry whose assign_when holds, or cannot be read, breaks the user", async () => {
    const root = await setup({ user_attributes: ATTRS, roles: [{ name: "Ext", assign_when: "user.region == 'emea'" }] });
    expectBroken(eva(root, { attributes: { region: "emea" } }), "Ext");
    expectFine(eva(root, { attributes: { region: "apac" } }));
    const root2 = await setup({ roles: [{ assign_when: "user.region ==" } as never] });
    expectBroken(eva(root2), "unnamed");
  });

  test("a repeated role name breaks a user holding it", async () => {
    const root = await setup({ roles: [{ name: "rep" }, { name: "rep", deny: { models: ["wh.orders"] } }] });
    expectBroken(eva(root, { roles: ["rep"] }), "rep");
    expectFine(eva(root));
  });

  test("an unknown or unreadable default_role breaks a user holding no other role", async () => {
    const root = await setup({ default_role: "viewer", roles: [{ name: "rep" }] });
    expectBroken(eva(root), "viewer");
    expectFine(eva(root, { roles: ["rep"] }));
    const root2 = await setup({ default_role: 7 as never, roles: [{ name: "rep" }] });
    expectBroken(eva(root2), "default_role");
    expectFine(eva(root2, { roles: ["rep"] }));
  });

  test("an assigned role name matches without letter case", async () => {
    const root = await setup({ roles: [{ name: "rep", deny: { fields: ["wh.orders.region"] } }] });
    const v = eva(root, { roles: ["Rep"] });
    expect(v.roles).toEqual([{ name: "rep", how: "assigned" }]);
    expect(v.unknown_roles).toEqual([]);
    expect(fieldOf(v, "orders.region").reasons).toEqual(["denied:rep"]);
  });
});

describe("letter case and row filter shapes", () => {
  test("protected tags, grants and deny tags match without letter case", async () => {
    const root = await setup({ roles: [{ name: "hr", allow: { tags: ["PII"] } }, { name: "ops", deny: { tags: ["Internal"] } }] });
    writeYaml(join(root, "models", "wh", "people.yaml"), model("people", [dim("email", { tags: ["Pii"] }), dim("team", { tags: ["internal"] })], [], { tags: ["SENSITIVE"] }));
    const v = eva(root);
    expect(modelOf(v, "people").reasons).toEqual(["protected_tag:sensitive"]);
    expect(fieldOf(v, "people.email").reasons).toEqual(["protected_tag:pii", "protected_tag:sensitive", "model_hidden"]);
    const hr = eva(root, { roles: ["hr"] });
    expect(fieldOf(hr, "people.email").reasons).toEqual(["protected_tag:sensitive", "model_hidden"]);
    writeYaml(join(root, "models", "wh", "people.yaml"), model("people", [dim("email", { tags: ["Pii"] }), dim("team", { tags: ["internal"] })], []));
    expect(fieldOf(eva(root, { roles: ["hr"] }), "people.email").visible).toBe(true);
    expect(fieldOf(eva(root, { roles: ["ops"] }), "people.team").reasons).toEqual(["denied:ops"]);
  });

  const filtered = (rf: Record<string, unknown>) => ({ user_attributes: ATTRS, roles: [{ name: "rep", row_filters: [{ model: "wh.orders", ...rf } as never] }] });
  const rowsOf = async (rf: Record<string, unknown>, attributes: Record<string, unknown> = { region: "emea", employee_id: 1 }) =>
    modelOf(eva(await setup(filtered(rf)), { roles: ["rep"], attributes }), "orders").row_filters!;
  const hierarchy = { column: "id", via: "wh.reporting_lines", manager: "manager_id", member: "member_id", user: "user.employee_id" };

  test("both expr and hierarchy, a hierarchy that is not a mapping, or an expr that is not text means no rows", async () => {
    for (const [rf, problem] of [
      [{ expr: "1 = 1", hierarchy: "x" }, "roles[0].row_filters[0] has both expr and hierarchy; treated as no rows"],
      [{ expr: "1 = 1", hierarchy }, "roles[0].row_filters[0] has both expr and hierarchy; treated as no rows"],
      [{ hierarchy: "x" }, "roles[0].row_filters[0].hierarchy is not a mapping; treated as no rows"],
      [{ expr: 5 }, "roles[0].row_filters[0].expr is not text; treated as no rows"],
    ] as const) {
      const rows = await rowsOf(rf);
      expect(rows.rows).toBe("none");
      expect(rows.branches[0]!.problems).toEqual([problem]);
    }
  });

  test("a hierarchy user attribute that is a list means no rows", async () => {
    const rows = await rowsOf({ hierarchy }, { employee_id: [1, 2] });
    expect(rows.rows).toBe("none");
    expect(rows.branches[0]!.problems).toEqual(["user.employee_id is a list; a hierarchy filter needs one id; treated as no rows"]);
  });

  test("an empty list attribute counts as missing", async () => {
    const rows = await rowsOf({ expr: "team IN {{ user.teams }}" }, { teams: [] });
    expect(rows.rows).toBe("none");
    expect((rows.branches[0]!.filters[0]! as { missing: string[] }).missing).toEqual(["teams"]);
    const ok = await rowsOf({ expr: "team IN {{ user.teams }}" }, { teams: ["a"] });
    expect(ok.rows).toBe("filtered");
  });
});

describe("sl access", () => {
  test("default audience in human output lists hidden items", async () => {
    const root = await setup();
    const r = await sl(root, ["access"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Access mode open (no access.yaml)");
    expect(r.out).toContain("User: the default audience (no attributes, no assigned roles)");
    expect(r.out).toContain("Roles held: none (the open baseline, no row filters)");
    expect(r.out).toContain("Visible across 1 source: 4/6 models, 11/18 fields, 2/4 metrics; 6 approved item(s) hidden by protected tags");
    expect(r.out).toContain("Source wh: visible 4/6 models, 11/18 fields, 2/4 metrics");
    expect(r.out).toContain("    measure wh.orders.cost: hidden (protected_tag:sensitive)");
    expect(r.out).toContain("    model wh.payroll: hidden (protected_tag:sensitive), with its 2 field(s)");
    expect(r.out).toContain("    metric margin: hidden (measure_hidden:orders.cost)");
    expect(r.out).not.toContain("payroll.employee_id");
    expect(r.out).not.toContain("metric aov");
  });

  test("--show visible and all", async () => {
    const root = await setup();
    const vis = await sl(root, ["access", "--show", "visible"]);
    expect(vis.out).toContain("    model wh.orders");
    expect(vis.out).toContain("      measure revenue");
    expect(vis.out).toContain("    metric aov");
    expect(vis.out).not.toContain("hidden (");
    const all = await sl(root, ["access", "--show", "all"]);
    expect(all.out).toContain("    metric aov");
    expect(all.out).toContain("hidden (protected_tag:sensitive)");
    const bad = await sl(root, ["access", "--show", "some"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--show must be visible, hidden or all");
  });

  test("roles, attributes and row filters in human output", async () => {
    const root = await setup({
      user_attributes: ATTRS,
      roles: [
        {
          name: "rep",
          assign_when: "user.region is set",
          deny: { models: ["wh.tickets"] },
          row_filters: [{ model: "wh.orders", expr: "region = {{ user.region }}" }],
        },
        {
          name: "manager",
          deny: { models: ["wh.orders"] },
          row_filters: [
            { model: "wh.tickets", hierarchy: { column: "assignee_id", via: "wh.reporting_lines", manager: "manager_id", member: "member_id", user: "user.employee_id" } },
          ],
        },
      ],
    });
    const r = await sl(root, ["access", "--user", '{"region":"emea"}', "--roles", "manager,ghost"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('User: region="emea"; assigned roles: manager, ghost');
    expect(r.out).toContain("Roles held: manager (assigned), rep (condition: user.region is set)");
    expect(r.out).toContain("Unknown roles, not held: ghost");
    expect(r.out).toContain("  row filters:");
    expect(r.out).toContain("    wh.orders: rows matching any of");
    expect(r.out).toContain('      rep: region = {{ user.region }} (user.region = "emea")');
    expect(r.out).toContain("    wh.tickets: no rows (manager needs user.employee_id)");
    const r2 = await sl(root, ["access", "--user", '{"region":"emea","employee_id":42}', "--roles", "manager"]);
    expect(r2.out).toContain(
      "      manager: assignee_id is the user or anyone below them in wh.reporting_lines (manager_id -> member_id; user.employee_id = 42)",
    );
  });

  test("--json carries everything and --user-file reads attributes", async () => {
    const root = await setup({ user_attributes: ATTRS, roles: [{ name: "emea", assign_when: "user.region == 'emea'" }] });
    const file = join(root, "..", "user.json");
    writeFileSync(file, JSON.stringify({ region: "emea" }));
    const r = await sl(root, ["access", "--user-file", file, "--json"]);
    expect(r.code).toBe(0);
    const v = r.json<AccessVisibility>();
    expect(v.mode).toBe("open");
    expect(v.access_file).toBe("approved");
    expect(v.roles).toEqual([{ name: "emea", how: "condition", condition: "user.region == 'emea'" }]);
    expect(v.user.attributes).toEqual({ region: "emea" });
    expect(modelOf(v, "orders").fields.map((f) => f.name)).toEqual(["order_status", "region", "internal_note", "created_at", "revenue", "cost", "order_count"]);
    expect(v.summary.metrics).toEqual({ visible: 2, hidden: 2 });
  });

  test("bad --user input is refused", async () => {
    const root = await setup();
    const a = await sl(root, ["access", "--user", "[1]"]);
    expect(a.code).toBe(1);
    expect(a.err).toContain("must be a JSON object of user attributes");
    const b = await sl(root, ["access", "--user", "{nope"]);
    expect(b.err).toContain("--user is not valid JSON");
    const c = await sl(root, ["access", "--user", "{}", "--user-file", "x.json"]);
    expect(c.err).toContain("Pass --user or --user-file, not both.");
    const d = await sl(root, ["access", "--user-file", "missing.json"]);
    expect(d.err).toContain("does not exist");
  });

  test("skipped entries are shown", async () => {
    const root = await setup({ mode: "closed", roles: [{ name: "a" }] });
    const r = await sl(root, ["access", "--roles", "a"]);
    expect(r.out).toContain("Access mode closed (access.yaml approved)");
    expect(r.out).toContain("Skipped entries:\n  roles[0].allow.models: is missing; in closed mode the role allows no model");
    expect(r.out).toContain("    model wh.orders: hidden (not_allowed), with its 7 field(s)");
  });

  test("broken roles, an invalid access.yaml and warnings are shown", async () => {
    const root = await setup({ roles: [{ name: "contractor", deny: "everything" as never }], restrictions: [{ name: "r", targets: ["aov"], allow: { roles: ["contractor"] } }] });
    const r = await sl(root, ["access", "--roles", "contractor"]);
    expect(r.out).toContain("Broken roles that might apply, so this user sees nothing: contractor (see skipped entries)");
    expect(r.out).toContain("  roles[0].deny: is not a mapping; the role is broken and a user holding it sees nothing");
    expect(r.out).toContain('Warnings:\n  restrictions[0].targets[0]: "aov" matches no model or field, so it hides nothing; write metric:aov to name a metric');
    expect(r.out).toContain("    model wh.orders: hidden (broken_role:contractor), with its 7 field(s)");
    const j = (await sl(root, ["access", "--roles", "contractor", "--json"])).json<AccessVisibility>();
    expect(j.broken_roles).toEqual(["contractor"]);
    expect(j.warnings).toHaveLength(1);
    const root2 = await setup({ restrictions: ["wh.orders"] as never });
    const r2 = await sl(root2, ["access"]);
    expect(r2.out).toContain("Access mode closed (access.yaml invalid)");
    expect(r2.out).toContain("access.yaml cannot be applied, so access is closed and nothing is visible (see skipped entries)");
    expect(r2.out).toContain("Visible across 1 source: 0/6 models, 0/18 fields, 0/4 metrics");
  });

  test("no semantic layer is an error", async () => {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    const r = await sl(t.root, ["access"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No semantic layer");
  });
});

describe("row filters through joins", () => {
  const joinTo = (name: string, to: string, extra: Partial<Join> = {}): Join => ({
    name,
    to,
    keys: [{ from: `${to}_id`, to: "id" }],
    relationship: "many_to_one",
    ...OK,
    ...extra,
  });
  // order_items -> orders -> customers, and orders -> region (one_to_many, for the refusal).
  const CHAIN: Model[] = [
    model("customers", [dim("segment")], [], { joins: [joinTo("home", "regions")] }),
    model("regions", [dim("name")], []),
    model("orders", [dim("region")], [measure("revenue")], {
      joins: [joinTo("customer", "customers", { type: "inner" }), joinTo("lines", "order_items", { relationship: "one_to_many" })],
    }),
    model("order_items", [dim("sku")], [measure("quantity")], { joins: [joinTo("order", "orders"), joinTo("Odd", "orders")] }),
    model("reporting_lines", [dim("manager_id"), dim("member_id")], []),
  ];
  const hierarchy = { column: "order.sales_rep_id", via: "wh.reporting_lines", manager: "manager_id", member: "member_id", user: "user.employee_id" };

  async function chainRoot(rf: Record<string, unknown>, models: Model[] = CHAIN): Promise<string> {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb" });
    for (const m of models) writeYaml(join(t.root, "models", "wh", `${m.model}.yaml`), m);
    writeYaml(join(t.root, "access.yaml"), {
      ...OK,
      user_attributes: ATTRS,
      roles: [{ name: "sales", row_filters: [{ model: "wh.order_items", ...rf }] }],
    });
    return t.root;
  }
  const itemRows = async (rf: Record<string, unknown>, models?: Model[]) =>
    modelOf(eva(await chainRoot(rf, models), { roles: ["sales"], attributes: { employee_id: 7, region: "emea" } }), "order_items").row_filters!;

  test("a hierarchy column read through one join carries the join path", async () => {
    const rows = await itemRows({ hierarchy });
    expect(rows.rows).toBe("filtered");
    const f = rows.branches[0]!.filters[0] as HierarchyFilterResult;
    expect(f.column).toBe("order.sales_rep_id");
    expect(f.user_value).toBe(7);
    expect(f.join_refs).toEqual([
      {
        text: "order.sales_rep_id",
        column: "sales_rep_id",
        hops: [{ join: "order", from: "wh.order_items", to: "wh.orders", relationship: "many_to_one", type: "left", keys: [{ from: "orders_id", to: "id" }] }],
      },
    ]);
  });

  test("an expr read through two joins carries both hops in order, each with its type", async () => {
    const rows = await itemRows({ expr: "order.customer.segment = 'smb' and order.region = {{ user.region }} and sku is not null" });
    expect(rows.rows).toBe("filtered");
    const f = rows.branches[0]!.filters[0] as ExprFilterResult;
    expect(f.params).toEqual({ region: "emea" });
    expect(f.join_refs!.map((r) => [r.text, r.column, r.hops.map((h) => `${h.from}.${h.join}->${h.to}:${h.type}`)])).toEqual([
      ["order.customer.segment", "segment", ["wh.order_items.order->wh.orders:left", "wh.orders.customer->wh.customers:inner"]],
      ["order.region", "region", ["wh.order_items.order->wh.orders:left"]],
    ]);
  });

  test("a filter over the model's own columns carries no join_refs; a repeated reference is listed once", async () => {
    const own = (await itemRows({ expr: "sku = 'a'" })).branches[0]!.filters[0]!;
    expect(own).not.toHaveProperty("join_refs");
    // The same unquoted reference in another letter case resolves to the same path: listed once,
    // with the text first written.
    const twice = (await itemRows({ expr: "ORDER.region = 'x' or order.REGION is null or order.region <> 'y'" })).branches[0]!.filters[0] as ExprFilterResult;
    expect(twice.join_refs!.map((r) => r.text)).toEqual(["ORDER.region"]);
    // A quoted column is its own reference, and so is a different struct field of the column.
    const distinct = (await itemRows({ expr: `order.region = 'x' or order."Region" = 'x' or order.region.a = 1` })).branches[0]!.filters[0] as ExprFilterResult;
    expect(distinct.join_refs!.map((r) => r.text)).toEqual(["order.region", "order.Region", "order.region.a"]);
    // An unquoted name matches the join in any case; a quoted one exactly, so "Odd" is its own join.
    const quoted = (await itemRows({ expr: '"Odd".region = \'x\'' })).branches[0]!.filters[0] as ExprFilterResult;
    expect(quoted.join_refs![0]!.hops[0]!.join).toBe("Odd");
    // A placeholder or a string is never read as a reference.
    const lit = (await itemRows({ expr: "sku = 'order.region' and sku <> {{ user.region }}" })).branches[0]!.filters[0]!;
    expect(lit).not.toHaveProperty("join_refs");
  });

  test("a reference that cannot be followed means no rows", async () => {
    const broken = CHAIN.map((m) =>
      m.model === "order_items"
        ? { ...m, joins: [joinTo("order", "orders"), joinTo("ghost", "nowhere"), joinTo("nokeys", "orders", { keys: [] }), joinTo("weird", "orders", { type: "outer" as never })] }
        : m,
    );
    for (const [rf, problem, models] of [
      [{ expr: "order.lines.sku = 'a'" }, "roles[0].row_filters[0].expr reads order.lines.sku through join lines of model orders, which is one_to_many; a row filter reads only through many_to_one or one_to_one joins; treated as no rows"],
      [{ expr: "order.customer.home.name = 'a'" }, "roles[0].row_filters[0].expr reads order.customer.home.name through more than two joins; a join reference is <join>.<column> or <join>.<join>.<column>; treated as no rows"],
      [{ hierarchy: { ...hierarchy, column: "order.lines.rep" } }, "roles[0].row_filters[0].hierarchy.column reads order.lines.rep through join lines of model orders, which is one_to_many"],
      [{ expr: "sku in (select sku from wh.order_items)" }, "roles[0].row_filters[0].expr has a subquery; treated as no rows"],
      [{ expr: "ghost.x = 1" }, "reads ghost.x through join ghost of model order_items, which reaches no model; treated as no rows", broken],
      [{ expr: "nokeys.x = 1" }, "reads nokeys.x through join nokeys of model order_items, whose keys cannot be read; treated as no rows", broken],
      [{ expr: "weird.x = 1" }, "reads weird.x through join weird of model order_items, whose type is not left or inner; treated as no rows", broken],
    ] as [Record<string, unknown>, string, Model[] | undefined][]) {
      const rows = await itemRows(rf, models);
      expect(rows.rows).toBe("none");
      expect(rows.branches[0]!.problems).toHaveLength(1);
      expect(rows.branches[0]!.problems[0]).toContain(problem);
      expect(rows.branches[0]!.filters).toEqual([]);
    }
  });

  test("a hierarchy column that is not one name, or not a whole join reference, means no rows", async () => {
    const neither = "roles[0].row_filters[0].hierarchy.column is neither a column nor a join reference; treated as no rows";
    for (const column of ["true or x", "order.x or 1=1", "order.x is not null or order.x", "sales_rep_id = 1", "order.sales_rep_id.part", "attrs.rep", `order."unclosed`, "order..x", "`order`.x"]) {
      const rows = await itemRows({ hierarchy: { ...hierarchy, column } });
      expect(rows.rows).toBe("none");
      expect(rows.branches[0]!.problems).toEqual([neither]);
      expect(rows.branches[0]!.filters).toEqual([]);
    }
    // One bare or quoted column, or a whole join reference, is read; whitespace around it is trimmed.
    for (const [column, refs] of [
      ["sales_rep_id", undefined],
      [`"Sales Rep"`, undefined],
      [" order.sales_rep_id ", ["sales_rep_id"]],
      [`order."Rep ""Id"""`, [`Rep "Id"`]],
      ["order.customer.segment", ["segment"]],
    ] as [string, string[] | undefined][]) {
      const rows = await itemRows({ hierarchy: { ...hierarchy, column } });
      expect(rows.rows).toBe("filtered");
      const f = rows.branches[0]!.filters[0] as HierarchyFilterResult;
      expect(f.join_refs?.map((r) => r.column)).toEqual(refs);
    }
  });

  test("a hierarchy column is read in the source's dialect: backticks on BigQuery", async () => {
    const root = await chainRoot({ hierarchy: { ...hierarchy, column: "`order`.sales_rep_id" } });
    writeYaml(join(root, "sources", "wh.yaml"), { source: "wh", dialect: "bigquery" });
    const user = { roles: ["sales"], attributes: { employee_id: 7 } };
    const rows = modelOf(eva(root, user), "order_items").row_filters!;
    expect(rows.rows).toBe("filtered");
    expect((rows.branches[0]!.filters[0] as HierarchyFilterResult).join_refs![0]!.hops[0]!.join).toBe("order");
    // On BigQuery "order" is a string, not a name.
    writeYaml(join(root, "access.yaml"), {
      ...OK,
      user_attributes: ATTRS,
      roles: [{ name: "sales", row_filters: [{ model: "wh.order_items", hierarchy: { ...hierarchy, column: `"order".sales_rep_id` } }] }],
    });
    expect(modelOf(eva(root, user), "order_items").row_filters!.rows).toBe("none");
  });

  test("a model whose joins cannot all be read fails closed for a dotted name that matches no readable join", async () => {
    const withJoins = (joins: unknown) => CHAIN.map((m) => (m.model === "order_items" ? ({ ...m, joins } as unknown as Model) : m));
    const cannot = "but model order_items's joins cannot be read; treated as no rows";
    for (const [joins, expr] of [
      [{ order: joinTo("order", "orders") }, "order.x = 1"],
      [[{ to: "orders", keys: [{ from: "orders_id", to: "id" }], relationship: "many_to_one" }], "order.x = 1"],
      [[joinTo("order", "orders"), "garbage"], "ordr.x = 1"],
    ] as [unknown, string][]) {
      const rows = await itemRows({ expr }, withJoins(joins));
      expect(rows.rows).toBe("none");
      expect(rows.branches[0]!.problems).toHaveLength(1);
      expect(rows.branches[0]!.problems[0]).toContain(cannot);
    }
    // A readable join is still followed, and a filter with no dotted name is unaffected.
    const ok = await itemRows({ expr: "order.region = 'x'" }, withJoins([joinTo("order", "orders"), "garbage"]));
    expect(ok.rows).toBe("filtered");
    const own = await itemRows({ expr: "sku = 'a'" }, withJoins({ order: 1 }));
    expect(own.rows).toBe("filtered");
    // The second hop's model is read the same way.
    const deep = CHAIN.map((m) => (m.model === "orders" ? ({ ...m, joins: [joinTo("customer", "customers"), 7] } as unknown as Model) : m));
    const rows = await itemRows({ expr: "order.custmer.segment = 'a'" }, deep);
    expect(rows.rows).toBe("none");
    expect(rows.branches[0]!.problems[0]).toContain("but model orders's joins cannot be read");
  });

  test("a join type of null, or a join name two joins share, means no rows; an absent type is left", async () => {
    const withJoins = (joins: Join[]) => CHAIN.map((m) => (m.model === "order_items" ? { ...m, joins } : m));
    const nul = await itemRows({ expr: "order.region = 'x'" }, withJoins([joinTo("order", "orders", { type: null as never })]));
    expect(nul.rows).toBe("none");
    expect(nul.branches[0]!.problems[0]).toContain("through join order of model order_items, whose type is not left or inner; treated as no rows");
    const absent = await itemRows({ expr: "order.region = 'x'" }, withJoins([joinTo("order", "orders")]));
    expect((absent.branches[0]!.filters[0] as ExprFilterResult).join_refs![0]!.hops[0]!.type).toBe("left");
    const dup = await itemRows({ expr: "order.region = 'x'" }, withJoins([joinTo("order", "orders"), joinTo("order", "order_items", { relationship: "one_to_many" })]));
    expect(dup.rows).toBe("none");
    expect(dup.branches[0]!.problems).toEqual([
      "roles[0].row_filters[0].expr reads order.region, but model order_items has more than one join named order; treated as no rows",
    ]);
    const dupHier = await itemRows({ hierarchy }, withJoins([joinTo("order", "orders"), joinTo("order", "orders")]));
    expect(dupHier.rows).toBe("none");
  });

  test("a dotted name whose first part is no join is left as a struct field of the model's own column", async () => {
    const f = (await itemRows({ expr: "attrs.kind = 'a'" })).branches[0]!.filters[0]!;
    expect(f).not.toHaveProperty("join_refs");
  });

  test("sl access shows where a row filter reads through joins", async () => {
    const root = await chainRoot({ hierarchy });
    const r = await sl(root, ["access", "--user", '{"employee_id":7}', "--roles", "sales"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "      sales: order.sales_rep_id is the user or anyone below them in wh.reporting_lines (manager_id -> member_id; user.employee_id = 7; order.sales_rep_id reads wh.orders through join order, without its row filters)",
    );
    const root2 = await chainRoot({ expr: "order.customer.segment = {{ user.region }}" });
    const r2 = await sl(root2, ["access", "--user", '{"region":"emea"}', "--roles", "sales"]);
    expect(r2.out).toContain(
      '      sales: order.customer.segment = {{ user.region }} (user.region = "emea"; order.customer.segment reads wh.customers through joins order, customer, without its row filters)',
    );
    const j = (await sl(root, ["access", "--user", '{"employee_id":7}', "--roles", "sales", "--json"])).json<AccessVisibility>();
    const f = modelOf(j, "order_items").row_filters!.branches[0]!.filters[0] as HierarchyFilterResult;
    expect(f.join_refs![0]!.hops[0]!.to).toBe("wh.orders");
  });
});

describe("sl access per-source counts and draft label", () => {
  test("each source line carries its own visible counts and the total names the number of sources", async () => {
    const root = await setup();
    writeYaml(join(root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    writeYaml(join(root, "models", "lake", "events.yaml"), { ...model("events", [dim("kind"), dim("email", { tags: ["pii"] })], [measure("event_count")]), source: "lake" });
    const r = await sl(root, ["access"]);
    expect(r.out).toContain("Visible across 2 sources: 5/7 models, 13/21 fields, 2/4 metrics; 7 approved item(s) hidden by protected tags");
    expect(r.out).toContain("Source lake: visible 1/1 models, 2/3 fields, 0/0 metrics");
    expect(r.out).toContain("Source wh: visible 4/6 models, 11/18 fields, 2/4 metrics");
    const j = (await sl(root, ["access", "--json"])).json<AccessVisibility>();
    expect(j.sources.map((s) => [s.source, s.summary])).toEqual([
      ["lake", { models: { visible: 1, hidden: 0 }, fields: { visible: 2, hidden: 1 }, metrics: { visible: 0, hidden: 0 } }],
      ["wh", { models: { visible: 4, hidden: 2 }, fields: { visible: 11, hidden: 7 }, metrics: { visible: 2, hidden: 2 } }],
    ]);
  });

  test("a configured source with no models is counted and listed", async () => {
    const root = await setup();
    writeYaml(join(root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    const r = await sl(root, ["access"]);
    expect(r.out).toContain("Visible across 2 sources: 4/6 models, 11/18 fields, 2/4 metrics");
    expect(r.out).toContain("Source lake: visible 0/0 models, 0/0 fields, 0/0 metrics");
    expect(r.out).not.toContain("No models or metrics.");
    const j = (await sl(root, ["access", "--json"])).json<AccessVisibility>();
    expect(j.sources.map((s) => s.source)).toEqual(["lake", "wh"]);
    const empty = tempRoot();
    cleanups.push(empty.cleanup);
    await initProject(empty.root);
    writeYaml(join(empty.root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb" });
    const e = await sl(empty.root, ["access"]);
    expect(e.out).toContain("Visible across 1 source: 0/0 models");
    expect(e.out).toContain("No models or metrics.");
  });

  test("a draft access.yaml is explained, labelled as awaiting sign-off", async () => {
    const root = await setup({ ...DRAFT, roles: [{ name: "a" }] });
    const r = await sl(root, ["access"]);
    expect(r.out).toContain("Access mode open (access.yaml draft)");
    expect(r.out).toContain("This explains the draft access.yaml, which is awaiting sign-off: tools serve nothing under it until it is approved.");
    const ok = await sl(await setup({ roles: [{ name: "a" }] }), ["access"]);
    expect(ok.out).not.toContain("awaiting sign-off");
  });
});

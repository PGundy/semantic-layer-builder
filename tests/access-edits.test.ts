import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { acquireLock } from "../skills/semantic-layer/scripts/lib/lock.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { WHO_SEES_STATED } from "../skills/semantic-layer/scripts/lib/readback.ts";
import type { AccessFile, Golden } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, FIXED_NOW, sl, tempDir } from "./helpers.ts";

// Typed commands for every access rule (docs/PRD-hardening.md HR-9), on copies of examples/acme
// (synthetic data): sl add-attribute, add-role, add-restriction, add-row-filter, their remove-*
// commands, sl set access <kind>:<name> <key>, and who-sees decided once, in the access phase.

const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");
const SL = join(REPO, "skills", "semantic-layer", "scripts", "sl.ts");
const CLOSURE = ["--via", "warehouse.sales_team_closure", "--manager", "manager_id", "--member", "member_id", "--user", "employee_id"];

// The commands that rebuild the example's access.yaml: its attributes, roles, row filters and restriction.
const REBUILD: string[][] = [
  ["set", "access", "mode", "open"],
  ["add-attribute", "--name", "department", "--type", "string", "--description", "The user's department in the login system."],
  ["add-attribute", "--name", "employee_id", "--type", "number"],
  ["add-role", "--name", "analyst", "--description", "Analysts: everyone whose department is analytics.", "--assign-when", "user.department == 'analytics'", "--allow-tags", "pii"],
  ["add-role", "--name", "finance", "--assign-when", "user.department == 'finance'"],
  ["add-role", "--name", "sales", "--assign-when", "user.department == 'sales'"],
  ["add-row-filter", "--role", "sales", "--model", "warehouse.orders", "--column", "sales_rep_id", ...CLOSURE],
  ["add-row-filter", "--role", "sales", "--model", "warehouse.order_items", "--column", "order.sales_rep_id", ...CLOSURE],
  ["add-restriction", "--name", "refunds_and_net_revenue", "--targets", "warehouse.refunds,metric:net_revenue", "--roles", "analyst,finance"],
];

const text = (root: string, rel = "access.yaml") => readFileSync(join(root, rel), "utf8");
const access = (root: string) => readYaml<AccessFile>(join(root, "access.yaml"));

// A copy of the Acme example, its access.yaml approved.
function acme(): string {
  const root = join(tempDir(), "semantic");
  cpSync(ACME, root, { recursive: true });
  return root;
}

// A copy with no access.yaml, and no golden: the example's name roles and users, which wait for the file.
function bare(): string {
  const root = acme();
  rmSync(join(root, "access.yaml"));
  rmSync(join(root, "goldens"), { recursive: true });
  return root;
}

// A copy whose access.yaml is the draft the commands rebuild.
async function rebuilt(): Promise<string> {
  const root = bare();
  for (const args of REBUILD) {
    const r = await sl(root, args);
    if (r.code !== 0) throw new Error(`sl ${args.join(" ")}: ${r.err}`);
  }
  return root;
}

async function ok(root: string, args: string[]): Promise<string> {
  const r = await sl(root, args);
  expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 0, err: "" });
  return r.out;
}

// A refused edit: exit 1, the phrases in its message, and the file as it was.
async function refused(root: string, args: string[], ...phrases: string[]): Promise<void> {
  const before = existsSync(join(root, "access.yaml")) ? text(root) : null;
  const r = await sl(root, args);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  for (const p of phrases) expect(r.err).toContain(p);
  expect(existsSync(join(root, "access.yaml")) ? text(root) : null).toBe(before);
}

describe("the Acme access.yaml rebuilt from nothing with the access commands", () => {
  test("gives the same sl access answers as the example for the example's test users", async () => {
    // The users the example tests: each golden's role and user, the default audience, and two it describes.
    const goldens = readdirSync(join(ACME, "goldens")).map((f) => readYaml<Golden>(join(ACME, "goldens", f)));
    const users = new Map<string, string[]>([["default audience", []]]);
    for (const g of goldens) {
      if (!g.role && !g.user) continue;
      const args = [...(g.role ? ["--roles", g.role] : []), ...(g.user ? ["--user", JSON.stringify(g.user)] : [])];
      users.set(args.join(" "), args);
    }
    users.set("marketing", ["--user", '{"department": "marketing"}']);
    users.set("sales without an id", ["--user", '{"department": "sales"}']);
    expect(users.size).toBeGreaterThanOrEqual(9);

    const root = await rebuilt();
    expect((await sl(root, ["validate"])).code).toBe(0);
    expect(access(root)).toMatchObject({ status: "draft", mode: "open" });
    // The owner's yes to the whole file, then both are approved files a tool applies.
    expect((await approveWithYes(root, ["--target", "access"])).code).toBe(0);
    const answer = async (r: string, args: string[]) => {
      const { last_approved: _last, ...v } = (await sl(r, ["access", "--show", "all", "--json", ...args])).json<Record<string, unknown>>();
      return v;
    };
    for (const [who, args] of users) {
      const [mine, theirs] = [await answer(root, args), await answer(ACME, args)];
      expect({ who, access_file: mine.access_file }).toEqual({ who, access_file: "approved" });
      expect({ who, ...mine }).toEqual({ who, ...theirs });
    }
    // The answers differ by user, so the comparison is not of empty results.
    const hidden = async (args: string[]) => ((await answer(root, args)).summary as { fields: { hidden: number } }).fields.hidden;
    expect(await hidden([])).toBeGreaterThan(await hidden(["--user", '{"department": "analytics"}']));
    const rep = (await sl(root, ["access", "--user", '{"department": "sales", "employee_id": 101}'])).out;
    expect(rep).toContain("warehouse.orders: rows matching any of");
    expect(rep).toContain("warehouse.order_items: rows matching any of");
  });

  test("writes a file a person can read: sections in order, short lists on one line", async () => {
    const root = await rebuilt();
    expect(text(root)).toBe(
      [
        "mode: open",
        "user_attributes:",
        "  - name: department",
        "    type: string",
        "    description: The user's department in the login system.",
        "  - name: employee_id",
        "    type: number",
        "roles:",
        "  - name: analyst",
        '    description: "Analysts: everyone whose department is analytics."',
        "    assign_when: user.department == 'analytics'",
        "    allow:",
        "      tags: [pii]",
        "  - name: finance",
        "    assign_when: user.department == 'finance'",
        "  - name: sales",
        "    assign_when: user.department == 'sales'",
        "    row_filters:",
        "      - model: warehouse.orders",
        "        hierarchy:",
        "          column: sales_rep_id",
        "          via: warehouse.sales_team_closure",
        "          manager: manager_id",
        "          member: member_id",
        "          user: user.employee_id",
        "          include_self: true",
        "      - model: warehouse.order_items",
        "        hierarchy:",
        "          column: order.sales_rep_id",
        "          via: warehouse.sales_team_closure",
        "          manager: manager_id",
        "          member: member_id",
        "          user: user.employee_id",
        "          include_self: true",
        "restrictions:",
        "  - name: refunds_and_net_revenue",
        "    targets: [warehouse.refunds, metric:net_revenue]",
        "    allow:",
        "      roles: [analyst, finance]",
        "status: draft",
        "",
      ].join("\n"),
    );
  });
});

describe("each access command and its refusals", () => {
  test("without access.yaml every one names sl set access mode, and writes nothing", async () => {
    const root = bare();
    for (const args of [...REBUILD.slice(1), ["remove-role", "sales"], ["remove-attribute", "department"], ["remove-restriction", "r"], ["remove-row-filter", "--role", "sales", "--model", "warehouse.orders"], ["set", "access", "role:sales", "description", "x"]]) {
      await refused(root, args, "No access.yaml", "sl set access mode open");
      expect(existsSync(join(root, "access.yaml"))).toBe(false);
    }
  });

  test("add-attribute and remove-attribute", async () => {
    const root = await rebuilt();
    const r = await sl(root, ["add-attribute", "--name", "teams", "--type", "string_list", "--description", "Teams the user\nbelongs to.", "--json"]);
    expect(r.json()).toEqual({ changed: true, file: "access.yaml", reapprove: [], warnings: [], entry: { name: "teams", type: "string_list", description: "Teams the user belongs to." }, attribute: "teams" });
    expect(access(root).user_attributes!.map((a) => a.name)).toEqual(["department", "employee_id", "teams"]);
    await refused(root, ["add-attribute", "--name", "teams", "--type", "string"], 'already has a user attribute "teams"', "sl set access attribute:teams");
    await refused(root, ["add-attribute", "--name", "Level", "--type", "number"], "lowercase name");
    await refused(root, ["add-attribute", "--name", "level", "--type", "integer"], "type is string, number, string_list or number_list");
    await refused(root, ["add-attribute", "--name", "level"], "needs --type");
    // One key of an attribute is set in place; a required one cannot be removed.
    expect(await ok(root, ["set", "access", "attribute:teams", "type", "number_list"])).toContain("Set type on attribute teams");
    await refused(root, ["set", "access", "attribute:teams", "type", "--unset"], "needs type", "sl remove-attribute teams");
    // Removing one a condition, a row filter or a golden reads is refused, naming each and its command.
    await refused(root, ["remove-attribute", "department"], "role analyst reads it in assign_when", "role finance reads it in assign_when", 'sl set access role:sales assign_when "<condition>"');
    await refused(root, ["remove-attribute", "employee_id"], "role sales's row filter on warehouse.orders reads it", "sl remove-row-filter --role sales --model warehouse.order_items");
    await ok(root, ["add-row-filter", "--role", "finance", "--model", "warehouse.orders", "--expr", "sales_rep_id = {{ user.employee_id }} or sales_rep_id in ({{ user.teams }})"]);
    await refused(root, ["remove-attribute", "teams"], "role finance's row filter on warehouse.orders reads it");
    await ok(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders"]);
    await refused(root, ["remove-attribute", "nope"], 'No user attribute "nope"', "Known: department, employee_id, teams");
    expect(await ok(root, ["remove-attribute", "teams"])).toContain("Removed user attribute teams from access.yaml.");
    expect(access(root).user_attributes!.map((a) => a.name)).toEqual(["department", "employee_id"]);
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a golden that runs as a role or sets an attribute holds it too", async () => {
    const root = acme();
    await refused(root, ["remove-role", "finance"], "restriction refunds_and_net_revenue names it in allow.roles (sl set access restriction:refunds_and_net_revenue allow.roles analyst)", "golden finance_net_revenue_2025 runs as it");
    await refused(root, ["remove-attribute", "employee_id"], "golden sales_head_301_2025 sets it in user");
  });

  test("add-role, sl set access role:<name> and remove-role", async () => {
    const root = await rebuilt();
    const out = await ok(root, ["add-role", "--name", "support", "--assign-when", "user.department in ['support', 'success']", "--deny-models", "warehouse.refunds", "--deny-fields", "warehouse.orders.discount", "--deny-tags", "pii"]);
    expect(out).toContain("Added role support to access.yaml.");
    expect(out).toContain("sl access --roles support");
    expect(out).toContain("sl readback --targets access");
    expect(access(root).roles![3]).toEqual({ name: "support", assign_when: "user.department in ['support', 'success']", deny: { models: ["warehouse.refunds"], fields: ["warehouse.orders.discount"], tags: ["pii"] } });
    await refused(root, ["add-role", "--name", "support"], 'already has a role "support"');
    await refused(root, ["add-role", "--name", "x", "--assign-when", "department = 'a'"], "not a condition the layer can read", "user.department == 'finance'");
    await refused(root, ["add-role", "--name", "x", "--assign-when", "user.level >= 3"], "roles[4].assign_when: reads user.level, which is not a declared user attribute");
    await refused(root, ["add-role", "--name", "x", "--deny-fields", "warehouse.orders.customer"], '"warehouse.orders.customer" is a join');
    await refused(root, ["add-role", "--name", "x", "--allow-tags", "secret_sauce"], '"secret_sauce" is not a protected tag', "nothing was written");

    // One key at a time: set, the same again, unset; the last key of allow takes the map with it.
    expect(await ok(root, ["set", "access", "role:support", "allow.tags", "[pii, sensitive]"])).toContain("Set allow.tags on role support in access.yaml.");
    expect(access(root).roles![3]!.allow).toEqual({ tags: ["pii", "sensitive"] });
    expect((await sl(root, ["set", "access", "role:support", "allow.tags", "pii,sensitive", "--json"])).json()).toMatchObject({ changed: false, role: "support", key: "allow.tags" });
    await ok(root, ["set", "access", "role:support", "allow.tags", "--unset"]);
    expect("allow" in access(root).roles![3]!).toBe(false);
    await ok(root, ["set", "access", "role:support", "assign_when", "user.department == 'support'"]);
    await ok(root, ["set", "access", "role:support", "description", "Support: no refunds."]);
    await ok(root, ["set", "access", "role:support", "deny.tags", "--unset"]);
    expect(access(root).roles![3]).toEqual({ name: "support", description: "Support: no refunds.", assign_when: "user.department == 'support'", deny: { models: ["warehouse.refunds"], fields: ["warehouse.orders.discount"] } });
    await refused(root, ["set", "access", "role:support", "assign_when", "user.department is"], "not a condition the layer can read");
    await refused(root, ["set", "access", "role:support", "tags", "pii"], 'A role has no key "tags"', "allow.tags");
    await refused(root, ["set", "access", "role:support", "name", "helpdesk"], "does not rename a role");
    await refused(root, ["set", "access", "role:support", "row_filters", "x"], "sl add-row-filter --role support");
    await refused(root, ["set", "access", "role:nope", "description", "x"], 'No role "nope"', "Known: analyst, finance, sales, support");
    await refused(root, ["set", "access", "role:support", "description"], "Usage: sl set access role:<name> <key> <value>");
    await refused(root, ["set", "access", "roles", "[]"], "sl set access takes mode or default_role at the top level", "sl add-role", "sl set access role:<name>");

    // A role a restriction or default_role names is not removed from under them.
    await refused(root, ["remove-role", "analyst"], "restriction refunds_and_net_revenue names it in allow.roles (sl set access restriction:refunds_and_net_revenue allow.roles finance)");
    await ok(root, ["set", "access", "default_role", "support"]);
    await refused(root, ["remove-role", "support"], "default_role names it (sl set access default_role --unset)");
    await ok(root, ["set", "access", "default_role", "--unset"]);
    expect(await ok(root, ["remove-role", "support"])).toContain("Removed role support from access.yaml.");
    expect(access(root).roles!.map((r) => r.name)).toEqual(["analyst", "finance", "sales"]);
    await refused(root, ["remove-role", "support"], 'No role "support"');
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("add-restriction, sl set access restriction:<name> and remove-restriction", async () => {
    const root = await rebuilt();
    const r = await sl(root, ["add-restriction", "--name", "discounts", "--targets", "warehouse.orders.discount", "--when", "user.department in ['finance', 'analytics']", "--description", "Discounts are for finance and analytics.", "--json"]);
    expect(r.json()).toMatchObject({
      changed: true,
      restriction: "discounts",
      entry: { name: "discounts", description: "Discounts are for finance and analytics.", targets: ["warehouse.orders.discount"], allow: { when: "user.department in ['finance', 'analytics']" } },
    });
    await refused(root, ["add-restriction", "--name", "discounts", "--targets", "warehouse.orders.revenue", "--roles", "finance"], 'already has a restriction "discounts"');
    await refused(root, ["add-restriction", "--name", "x", "--targets", "warehouse.orders.revenue"], "needs --roles or --when");
    await refused(root, ["add-restriction", "--name", "x", "--roles", "finance"], "needs --targets");
    // A target that matches nothing would hide nothing: refused, though sl validate only warns on one in a file.
    await refused(root, ["add-restriction", "--name", "x", "--targets", "warehouse.orders.revenu", "--roles", "finance"], '"warehouse.orders.revenu" matches no model or field');
    await refused(root, ["add-restriction", "--name", "x", "--targets", "metric:nope", "--roles", "finance"], '"metric:nope" matches no metric');
    await refused(root, ["add-restriction", "--name", "x", "--targets", "warehouse.orders.revenue", "--roles", "nobody"], 'names unknown role "nobody"');
    await refused(root, ["add-restriction", "--name", "x", "--targets", "warehouse.orders.revenue", "--when", "user.grade == 1"], "reads user.grade, which is not a declared user attribute");

    await ok(root, ["set", "access", "restriction:discounts", "targets", "warehouse.orders.discount,metric:net_revenue"]);
    await ok(root, ["set", "access", "restriction:discounts", "allow.roles", "finance"]);
    await ok(root, ["set", "access", "restriction:discounts", "allow.when", "--unset"]);
    expect(access(root).restrictions![1]).toEqual({ name: "discounts", description: "Discounts are for finance and analytics.", targets: ["warehouse.orders.discount", "metric:net_revenue"], allow: { roles: ["finance"] } });
    await refused(root, ["set", "access", "restriction:discounts", "targets", "warehouse.nope.*"], "matches no model or field");
    await refused(root, ["set", "access", "restriction:discounts", "targets", "--unset"], "needs targets", "sl remove-restriction discounts");
    await refused(root, ["set", "access", "restriction:discounts", "allow.roles", "--unset"], "needs allow.roles or allow.when", "Set allow.when first");
    expect(await ok(root, ["remove-restriction", "discounts"])).toContain("Removed restriction discounts from access.yaml.");
    await ok(root, ["remove-restriction", "refunds_and_net_revenue"]);
    // The last entry takes its section with it, and the file still validates.
    expect("restrictions" in access(root)).toBe(false);
    await refused(root, ["remove-restriction", "discounts"], 'No restriction "discounts"', "Known: none");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("add-row-filter in both forms, and remove-row-filter", async () => {
    const root = await rebuilt();
    const expr = await sl(root, ["add-row-filter", "--role", "finance", "--model", "warehouse.refunds", "--expr", " order.sales_rep_id = {{ user.employee_id }} "]);
    expect(expr.code).toBe(0);
    expect(expr.out).toContain("Added a row filter on warehouse.refunds to role finance in access.yaml.");
    expect(access(root).roles![1]!.row_filters).toEqual([{ model: "warehouse.refunds", expr: "order.sales_rep_id = {{ user.employee_id }}" }]);
    // The same filter again changes nothing; a hierarchy without include_self is the same as with it.
    expect((await sl(root, ["add-row-filter", "--role", "finance", "--model", "warehouse.refunds", "--expr", "order.sales_rep_id = {{ user.employee_id }}", "--json"])).json()).toMatchObject({ changed: false });
    expect((await sl(root, ["add-row-filter", "--role", "sales", "--model", "warehouse.orders", "--column", "sales_rep_id", ...CLOSURE, "--json"])).json()).toMatchObject({ changed: false });
    const noSelf = await sl(root, ["add-row-filter", "--role", "finance", "--model", "warehouse.orders", "--column", "sales_rep_id", ...CLOSURE.slice(0, -1), "user.employee_id", "--exclude-self", "--json"]);
    expect(noSelf.json<{ filter: unknown }>().filter).toEqual({ model: "warehouse.orders", hierarchy: { column: "sales_rep_id", via: "warehouse.sales_team_closure", manager: "manager_id", member: "member_id", user: "user.employee_id", include_self: false } });
    // The warning sl validate gives about rows of child tables arrives with the edit that causes it.
    expect(noSelf.json<{ warnings: string[] }>().warnings.join("\n")).toContain("rows of warehouse.order_items that belong to warehouse.orders are not limited by warehouse.orders's row filter for role finance");

    // What the compiler could not read is refused: the model, a column, a join reference, the closure and its columns, the attribute.
    const add = ["add-row-filter", "--role", "finance"];
    await refused(root, [...add, "--model", "warehouse.nope", "--expr", "x = 1"], '"warehouse.nope" is not a model');
    await refused(root, [...add, "--model", "orders", "--expr", "x = 1"], "--model is a model as source.model");
    await refused(root, [...add, "--model", "warehouse.orders", "--expr", "sales_rep = {{ user.employee_id }}"], '"sales_rep" is not a column of acme.fct_orders', "sales_rep_id", "Nothing was written");
    await refused(root, [...add, "--model", "warehouse.orders", "--expr", "customer.nope = 1"], '"nope" is not a column');
    await refused(root, [...add, "--model", "warehouse.orders", "--expr", "sales_rep_id = {{ user.badge }}"], "{{ user.badge }} names an undeclared user attribute");
    await refused(root, [...add, "--model", "warehouse.orders", "--expr", "sales_rep_id in (select rep_id from acme.dim_sales_reps)"], "subquery");
    await refused(root, [...add, "--model", "warehouse.orders", "--column", "nope", ...CLOSURE], '"nope" is not a column of acme.fct_orders');
    await refused(root, [...add, "--model", "warehouse.orders", "--column", "sales_rep_id", "--via", "warehouse.nope", "--manager", "manager_id", "--member", "member_id", "--user", "employee_id"], '"warehouse.nope" is not a model');
    await refused(root, [...add, "--model", "warehouse.orders", "--column", "sales_rep_id", "--via", "warehouse.sales_team_closure", "--manager", "boss", "--member", "member_id", "--user", "employee_id"], '"boss" is not a column');
    await refused(root, [...add, "--model", "warehouse.orders", "--column", "sales_rep_id", "--via", "warehouse.sales_team_closure", "--manager", "manager_id", "--member", "member_id", "--user", "badge"], "user.badge is not a declared user attribute");
    await refused(root, [...add, "--model", "warehouse.orders", "--column", "sales_rep_id", "--via", "warehouse.sales_team_closure"], "missing --manager, --member, --user");
    await refused(root, [...add, "--model", "warehouse.orders"], "missing --expr");
    await refused(root, [...add, "--model", "warehouse.orders", "--expr", "sales_rep_id = 1", "--via", "warehouse.sales_team_closure"], "not both");
    await refused(root, ["add-row-filter", "--role", "nope", "--model", "warehouse.orders", "--expr", "sales_rep_id = 1"], 'No role "nope"', "sl add-role --name nope");
    await refused(root, ["add-row-filter", "--model", "warehouse.orders", "--expr", "sales_rep_id = 1"], "Usage: sl add-row-filter");

    // Removing: none there, several there, and the one --index picks.
    await ok(root, [...add, "--model", "warehouse.orders", "--expr", "sales_rep_id = {{ user.employee_id }}"]);
    await refused(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.products"], "Role finance has no row filter on warehouse.products", "its row filters are on warehouse.refunds, warehouse.orders", "Next: sl access --roles finance");
    await refused(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders"], "has 2 row filters on warehouse.orders", "1. hierarchy: sales_rep_id under user.employee_id", "2. expr: sales_rep_id = {{ user.employee_id }}");
    await refused(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders", "--index", "3"], "pass --index 1 to 2");
    expect(await ok(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders", "--index", "1"])).toContain("Removed a row filter on warehouse.orders from role finance");
    expect(access(root).roles![1]!.row_filters).toEqual([{ model: "warehouse.refunds", expr: "order.sales_rep_id = {{ user.employee_id }}" }, { model: "warehouse.orders", expr: "sales_rep_id = {{ user.employee_id }}" }]);
    await ok(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders"]);
    await ok(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.refunds"]);
    expect("row_filters" in access(root).roles![1]!).toBe(false);
    await refused(root, ["remove-row-filter", "--role", "finance", "--model", "warehouse.orders"], "Role finance has no row filter on warehouse.orders; it has no row filters.", "Next: sl access --roles finance");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });

  test("a role's open questions are added and resolved with sl question, outside the approval", async () => {
    const root = acme();
    const before = text(root);
    const q = "refunds: reps see every refund until finance decides";
    expect(await ok(root, ["question", "add", "access.roles.sales", "--text", q])).toContain("Added an open question to access.roles.sales in access.yaml");
    expect(access(root).roles![2]!.open_questions).toEqual([q]);
    // open_questions are outside the approval hash, so the file stays approved.
    expect(access(root).status).toBe("approved");
    expect((await sl(root, ["status", "--json"])).json<{ access: { open_questions: number } }>().access.open_questions).toBe(1);
    await refused(root, ["question", "add", "access.roles.nope", "--text", "x"], 'No role "nope"');
    await ok(root, ["question", "resolve", "access.roles.sales", "--index", "1", "--text", "Reps see no refunds.", "--by", "Dana"]);
    expect(text(root)).toBe(before);
    expect(text(root, ".sl/ledger.jsonl")).toContain('"target":"access.roles.sales"');
    expect((await sl(root, ["validate"])).code).toBe(0);
  });
});

describe("an access edit keeps the rest of the file", () => {
  test("comments and every untouched byte survive each kind of edit", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    const only = async (args: string[], edits: [string, string][]) => {
      const before = text(root);
      await ok(root, args);
      let expected = before;
      for (const [from, to] of edits) {
        expect({ args, found: expected.split(from).length - 1 }).toEqual({ args, found: 1 });
        expected = expected.replace(from, to);
      }
      expect(text(root)).toBe(expected);
    };
    expect(text(root)).toContain("# Coverage gap: the sales goldens read orders directly");
    await only(["add-attribute", "--name", "region", "--type", "string"], [["roles:\n", "  - name: region\n    type: string\nroles:\n"]]);
    await only(["add-role", "--name", "marketing", "--deny-tags", "finance_only"], [["restrictions:\n", "  - name: marketing\n    deny:\n      tags: [finance_only]\nrestrictions:\n"]]);
    await only(["set", "access", "role:finance", "assign_when", "user.department in ['finance', 'treasury']"], [["assign_when: user.department == 'finance'", "assign_when: user.department in ['finance', 'treasury']"]]);
    await only(["set", "access", "role:analyst", "allow.tags", "pii,sensitive"], [["tags: [pii]", "tags: [pii, sensitive]"]]);
    await only(["add-row-filter", "--role", "sales", "--model", "warehouse.refunds", "--expr", "order.sales_rep_id = {{ user.employee_id }}"], [
      ["          include_self: true\n  - name: marketing", "          include_self: true\n      - model: warehouse.refunds\n        expr: order.sales_rep_id = {{ user.employee_id }}\n  - name: marketing"],
    ]);
    await only(["remove-row-filter", "--role", "sales", "--model", "warehouse.refunds"], [["      - model: warehouse.refunds\n        expr: order.sales_rep_id = {{ user.employee_id }}\n", ""]]);
    await only(["set", "access", "restriction:refunds_and_net_revenue", "allow.when", "user.department == 'audit'"], [["      roles: [analyst, finance]\n", "      roles: [analyst, finance]\n      when: user.department == 'audit'\n"]]);
    await only(["remove-role", "marketing"], [["  - name: marketing\n    deny:\n      tags: [finance_only]\n", ""]]);
    await only(["remove-attribute", "region"], [["  - name: region\n    type: string\n", ""]]);
    expect(text(root)).toContain("# Lines follow their order (Dana Ruiz, session 4)");
    expect((await sl(root, ["validate"])).code).toBe(0);
  });
});

// Invariant 5 (nothing is approved without a recorded owner yes): tools apply an approved access.yaml
// as it stands, so no typed edit leaves changed rules under an approval the owner gave to other rules.
describe("an edit to an approved access.yaml makes it a draft again", () => {
  const EDITS: string[][] = [
    ["add-attribute", "--name", "region", "--type", "string"],
    ["remove-attribute", "employee_id"],
    ["add-role", "--name", "marketing", "--assign-when", "user.department == 'marketing'"],
    ["remove-role", "sales"],
    ["set", "access", "role:sales", "description", "Sales."],
    ["set", "access", "role:analyst", "allow.tags", "--unset"],
    ["add-restriction", "--name", "discounts", "--targets", "warehouse.orders.discount", "--roles", "finance"],
    ["remove-restriction", "refunds_and_net_revenue"],
    ["set", "access", "restriction:refunds_and_net_revenue", "targets", "warehouse.refunds"],
    ["add-row-filter", "--role", "finance", "--model", "warehouse.orders", "--expr", "sales_rep_id = {{ user.employee_id }}"],
    ["remove-row-filter", "--role", "sales", "--model", "warehouse.order_items"],
    ["set", "access", "default_role", "finance"],
    ["set", "access", "mode", "closed"],
  ];
  // What the edit needs out of the way first, in both copies: referrers, and a closed mode's allowlists.
  const BEFORE: Record<string, string[][]> = {
    "remove-attribute employee_id": [["remove-row-filter", "--role", "sales", "--model", "warehouse.orders"], ["remove-row-filter", "--role", "sales", "--model", "warehouse.order_items"]],
    "set access mode": ["analyst", "finance", "sales"].map((r) => ["set", "access", `role:${r}`, "allow.models", "warehouse.*"]),
  };

  for (const edit of EDITS) {
    test(`sl ${edit.join(" ")}`, async () => {
      const prepare = async (root: string) => {
        // Goldens that run as a role or set an attribute hold both; they are not what this test is about.
        rmSync(join(root, "goldens"), { recursive: true });
        const first = Object.entries(BEFORE).find(([k]) => edit.join(" ").startsWith(k))?.[1] ?? [];
        if (!first.length) return;
        for (const args of first) await ok(root, args);
        expect((await approveWithYes(root, ["--target", "access"])).code).toBe(0);
      };
      const [root, revokedFirst] = [acme(), acme()];
      await prepare(root);
      await prepare(revokedFirst);
      expect(access(root)).toMatchObject({ status: "approved" });
      const approved = access(root);
      const r = await sl(root, edit);
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      // The file is a draft that keeps the approval it set aside, exactly as sl approve --revoke and then the edit write it.
      expect(access(root)).toMatchObject({ status: "draft", last_approved: { by: approved.approved_by, at: approved.approved_at } });
      for (const key of ["approved_by", "approved_at", "approved_hash"]) expect(key in access(root)).toBe(false);
      await ok(revokedFirst, ["approve", "--target", "access", "--revoke"]);
      await ok(revokedFirst, edit);
      expect(text(root)).toBe(text(revokedFirst));
      // It says so, and names the readback; tools that load it serve nothing until it is approved again.
      expect(r.out).toContain(`access.yaml was approved, so this edit made it a draft again: the version approved by ${approved.approved_by} on ${approved.approved_at} keeps applying where it is deployed`);
      expect(r.out).toContain("sl readback --targets access");
      const v = (await sl(root, ["access", "--json"])).json<{ access_file: string; last_approved: unknown; changed_since_approval: string[] }>();
      expect(v).toMatchObject({ access_file: "draft", last_approved: { by: approved.approved_by, at: approved.approved_at } });
      expect(v.changed_since_approval).not.toContain("access");
      const next = (await sl(root, ["next", "--json"])).json<NextAction>();
      expect(next).toMatchObject({ kind: "run", phase: "access", run: { command: "sl readback --targets access" } });
      // Approving again takes a new yes: the old one was to other rules.
      const again = await sl(root, ["approve", "--target", "access"]);
      expect(again.code).toBe(1);
      expect(again.err).toContain("sl readback --targets access");
      expect(access(root).status).toBe("draft");
    });
  }

  test("--json says so, a refused edit and an edit that changes nothing leave the approval alone", async () => {
    const root = acme();
    const before = text(root);
    expect((await sl(root, ["set", "access", "role:analyst", "allow.tags", "pii", "--json"])).json()).toMatchObject({ changed: false });
    expect((await sl(root, ["add-row-filter", "--role", "sales", "--model", "warehouse.orders", "--column", "sales_rep_id", ...CLOSURE, "--json"])).json()).toMatchObject({ changed: false });
    await refused(root, ["add-role", "--name", "sales"], "already has a role");
    await refused(root, ["add-restriction", "--name", "x", "--targets", "warehouse.nope", "--roles", "finance"], "matches no model or field");
    expect(text(root)).toBe(before);
    const r = await sl(root, ["add-role", "--name", "marketing", "--json"]);
    expect(r.json()).toMatchObject({ changed: true, reapprove: [], returned_to_draft: true, last_approved: { by: "Dana Ruiz", at: "2026-10-27" }, role: "marketing" });
    // A second edit of the draft keeps the approval the first set aside.
    expect((await sl(root, ["set", "access", "role:marketing", "description", "Marketing.", "--json"])).json()).not.toHaveProperty("returned_to_draft");
    expect(access(root)).toMatchObject({ status: "draft", last_approved: { by: "Dana Ruiz", at: "2026-10-27" } });
  });
});

describe("the access commands hold the write lock", () => {
  const WRITERS = ["add-attribute", "remove-attribute", "add-role", "remove-role", "add-restriction", "remove-restriction", "add-row-filter", "remove-row-filter"];

  test("each declares that it reads, changes and writes", async () => {
    for (const name of WRITERS) expect({ name, writes: (await COMMANDS[name]!()).default.writes }).toEqual({ name, writes: "whole" });
  });

  test(
    "while another writer holds the lock each waits, then fails naming it, with nothing written",
    async () => {
      const root = acme();
      const before = text(root);
      const release = await acquireLock(root, { command: "profile", started: FIXED_NOW });
      try {
        const runs = [...WRITERS.map((w) => [w]), ["set", "access", "role:sales", "description", "x"]].map(async (args) => {
          const p = Bun.spawn(["bun", SL, ...args, "--root", root], { env: { ...process.env, SL_LOCK_WAIT_MS: "0" }, stdout: "pipe", stderr: "pipe" });
          return { args, code: await p.exited, err: await new Response(p.stderr).text() };
        });
        for (const r of await Promise.all(runs)) expect({ args: r.args, code: r.code, busy: r.err.includes("sl profile (process") && r.err.includes("is writing to this semantic layer") }).toEqual({ args: r.args, code: 1, busy: true });
      } finally {
        release();
      }
      expect(text(root)).toBe(before);
    },
    60_000,
  );
});

describe("who sees an item is decided once, in the access phase", () => {
  const REGIONS = "warehouse.regions";
  const next = async (root: string) => (await sl(root, ["next", "--json"])).json<NextAction>();
  const reply = (root: string, words: string, ...flags: string[]) => sl(root, ["reply", "--readback", "rb_0001", "--item", "1", "--text", words, ...flags, "--by", "Dana"]);

  // A table whose sign-off is open: the Acme regions model as a draft, read back as rb_0001.
  async function regionsReadBack(): Promise<{ root: string; readback: string }> {
    const root = acme();
    await ok(root, ["approve", "--target", REGIONS, "--revoke"]);
    expect(await next(root)).toMatchObject({ kind: "run", phase: "interview", run: { command: `sl readback --targets ${REGIONS}` } });
    return { root, readback: await ok(root, ["readback", "--targets", REGIONS]) };
  }

  test("a table, field or metric readback states who sees it and does not ask", async () => {
    const { root, readback } = await regionsReadBack();
    const block = readback.slice(readback.indexOf("Who sees it once approved"), readback.indexOf("Measured from the data"));
    expect(block).toContain("- Default audience (a user with no role): sees it.");
    expect(block).toContain("- Stated, not asked: who sees what is decided once, in the access step, and a change to it does not hold this approval.");
    expect(block).not.toContain("?");
    const others = (await sl(root, ["readback", "--targets", "warehouse.orders.revenue,metric:net_revenue,access", "--json"])).json<{ items: { target: string; text: string }[] }>().items;
    for (const item of others) expect({ target: item.target, stated: item.text.includes(WHO_SEES_STATED) }).toEqual({ target: item.target, stated: item.target !== "access" });
  });

  test("the stall: a plain change about visibility holds the table, whatever the access file then says", async () => {
    const { root } = await regionsReadBack();
    const r = await reply(root, "Only finance should see regions.", "--verdict", "change");
    expect(r.code).toBe(0);
    // The table's content has nothing to change, and an access edit does not change the table.
    await ok(root, ["add-restriction", "--name", "regions_finance_only", "--targets", REGIONS, "--roles", "finance"]);
    const stuck = await next(root);
    expect(stuck).toMatchObject({ kind: "ask_owner", phase: "interview", action: { command: "set", args: [REGIONS, "<key>", "<value>"], kind: "ask_owner" } });
    // Both the reply and sl next now name the way out: the change is about access, and the table takes its own answer.
    expect(r.out).toContain(`If the change is only to who sees ${REGIONS}, record that as well with --verdict change --about access`);
    expect(stuck.why).toContain('record it with sl reply --readback rb_0001 --item 1 --text "<owner\'s words>" --verdict change --about access --by "<owner>"');
    expect(stuck.why).toContain("then ask whether the rest of the item is right");
    // Following it: the visibility change is recorded as such, and the owner's yes to the table approves it.
    expect((await reply(root, "Only finance should see regions.", "--about", "access")).code).toBe(0);
    expect((await reply(root, "Yes, the table itself is right.", "--verdict", "yes")).code).toBe(0);
    expect(await next(root)).toMatchObject({ kind: "run", phase: "interview", run: { command: `sl approve --target ${REGIONS}` } });
    expect((await sl(root, ["approve", "--target", REGIONS])).code).toBe(0);
  });

  test("a change recorded as about access does not hold the table: it proceeds on a yes to its content, and sl next routes the change to the access phase", async () => {
    const { root } = await regionsReadBack();
    const change = await sl(root, ["reply", "--readback", "rb_0001", "--item", "1", "--text", "Only finance should see regions.", "--verdict", "change", "--about", "access", "--by", "Dana", "--json"]);
    expect(change.json()).toMatchObject({ entry: { target: REGIONS, verdict: "change", about: "access" }, next: 'sl reply --readback rb_0001 --item 1 --text "<owner\'s words>" --verdict yes|no|change --by "Dana"' });
    expect((await sl(root, ["validate"])).code).toBe(0);

    // The table still waits for the owner's answer to the table itself, and says the change is kept.
    const ask = await next(root);
    expect(ask).toMatchObject({ kind: "ask_owner", phase: "interview", ask_owner: { readback_id: "rb_0001", items: [{ n: 1, target: REGIONS }] } });
    expect(ask.why).toContain(`The owner's change to who sees ${REGIONS} (ans_0001) is kept for the access phase and does not hold the item`);
    expect(ask).not.toHaveProperty("access_changes");
    // A change to who sees it is not a yes: nothing is approved on it.
    const early = await sl(root, ["approve", "--target", REGIONS]);
    expect(early.code).toBe(1);
    expect(early.err).toContain("nothing was approved");

    const yes = await reply(root, "Yes, that is the regions table.", "--verdict", "yes");
    expect(yes.out).toContain(`Next: sl approve --target ${REGIONS}`);
    expect(await next(root)).toMatchObject({ kind: "run", phase: "interview", run: { command: `sl approve --target ${REGIONS}` } });
    expect(await ok(root, ["approve", "--target", REGIONS])).toContain(`Approved ${REGIONS}`);

    // Nothing else is open, so the change reopens the access phase, though access.yaml is approved.
    const routed = await next(root);
    expect(routed).toMatchObject({ kind: "run", phase: "access", run: { command: "sl access" }, access_changes: [{ id: "ans_0001", target: REGIONS, text: "Only finance should see regions.", by: "Dana" }] });
    expect(routed.why).toContain(`${REGIONS} (ans_0001, Dana): "Only finance should see regions."`);
    for (const command of ["sl add-role", "sl add-restriction", "sl add-row-filter", "sl add-attribute", "sl set access role:<name> <key> <value>", "sl remove-restriction", "sl readback --targets access"]) expect(routed.why).toContain(command);
    expect((await sl(root, ["next"])).out).toContain("Next (access):");

    // The change is made with an access command, read back with the whole file, and the owner's yes settles it.
    await ok(root, ["add-restriction", "--name", "regions_finance_only", "--targets", REGIONS, "--roles", "finance"]);
    const draft = await next(root);
    expect(draft).toMatchObject({ kind: "run", phase: "access", run: { command: "sl readback --targets access" }, access_changes: [{ id: "ans_0001" }] });
    expect(draft.why).toContain("Only finance should see regions.");
    expect((await approveWithYes(root, ["--target", "access"])).code).toBe(0);
    const after = await next(root);
    expect(after.phase).not.toBe("access");
    expect(after).not.toHaveProperty("access_changes");
    expect(after.why).not.toContain("Only finance should see regions.");
    expect((await sl(root, ["access", "--show", "hidden"])).out).toContain(`model ${REGIONS}: hidden (restricted:regions_finance_only)`);
  });

  test("a yes already given stands when a change to who sees the item follows it", async () => {
    const { root } = await regionsReadBack();
    await reply(root, "Yes.", "--verdict", "yes");
    const change = await reply(root, "But hide it from marketing.", "--about", "access");
    expect(change.out).toContain(`The owner's yes to ${REGIONS} itself stands. Next: sl approve --target ${REGIONS}`);
    expect((await sl(root, ["approve", "--target", REGIONS])).code).toBe(0);
  });

  // Invariant 5: an about-access reply is never the owner's verdict on the item, in either direction.
  test("a change to who sees an item never approves it and never hides a later no", async () => {
    const { root } = await regionsReadBack();
    await reply(root, "Yes.", "--verdict", "yes");
    await reply(root, "No, the key is wrong.", "--verdict", "no");
    await reply(root, "And hide it from marketing.", "--about", "access");
    const r = await sl(root, ["approve", "--target", REGIONS]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing was approved");
    // --about access goes with a change only, is refused on access.yaml's own readback, and takes no other word.
    expect((await reply(root, "Yes.", "--verdict", "yes", "--about", "access")).err).toContain("it goes with --verdict change");
    expect((await reply(root, "Hide it.", "--about", "goldens")).err).toContain("--about is access");
    const rb = (await sl(root, ["readback", "--targets", "access", "--json"])).json<{ readback_id: string }>().readback_id;
    const own = await sl(root, ["reply", "--readback", rb, "--item", "1", "--text", "Hide regions.", "--about", "access", "--by", "Dana"]);
    expect(own.code).toBe(1);
    expect(own.err).toContain("record it with --verdict change, without --about");
    // A ledger line that claims a yes about access is not a reply an approval can read.
    const ledger = join(root, ".sl", "ledger.jsonl");
    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n");
    const forged = { ...(JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>), id: "ans_0004", verdict: "yes" };
    writeFileSync(ledger, `${lines.join("\n")}\n${JSON.stringify(forged)}\n`);
    const refusedApprove = await sl(root, ["approve", "--target", REGIONS]);
    expect(refusedApprove.code).toBe(1);
    expect(refusedApprove.err).toContain("line 4 is a reply line without the fields an approval needs");
    expect((await sl(root, ["validate"])).code).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Issue, type SchemaKind, schemaIssues, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "valid");
const SPEC = join(import.meta.dir, "..", "skills", "semantic-layer", "references", "spec.md");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// A copy of the valid fixture in a temp directory.
function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sl-validate-"));
  temps.push(dir);
  const root = join(dir, "semantic");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

type Doc = Record<string, any>;

// Parses a YAML or JSON file under root, lets edit change it, and writes it back.
function mutate(root: string, file: string, edit: (doc: Doc) => void): void {
  const p = join(root, file);
  const json = file.endsWith(".json");
  const doc = json ? (JSON.parse(readFileSync(p, "utf8")) as Doc) : readYaml<Doc>(p);
  edit(doc);
  if (json) writeFileSync(p, JSON.stringify(doc, null, 2));
  else writeYaml(p, doc);
}

function find(issues: Issue[], level: Issue["level"], file: string, path: string, message: string): Issue | undefined {
  return issues.find((i) => i.level === level && i.file === file && i.path === path && i.message.includes(message));
}

function expectIssue(issues: Issue[], level: Issue["level"], file: string, path: string, message: string): void {
  const hit = find(issues, level, file, path, message);
  if (!hit) throw new Error(`expected ${level} ${file} ${path} "${message}", got:\n${JSON.stringify(issues, null, 2)}`);
}

// Parses YAML text through the project's reader, which takes a path.
function parseYamlText(text: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "sl-spec-"));
  temps.push(dir);
  const p = join(dir, "block.yaml");
  writeFileSync(p, text);
  return readYaml<unknown>(p);
}

const errors = (issues: Issue[]) => issues.filter((i) => i.level === "error");

describe("valid fixture", () => {
  test("validates with no errors and no warnings", () => {
    expect(validateProject(FIXTURE)).toEqual([]);
  });

  test("sl validate exits 0 and reports ok", async () => {
    const r = await sl(FIXTURE, ["validate", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ ok: true, errors: 0, warnings: 0, issues: [] });
    const human = await sl(FIXTURE, ["validate"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Valid");
  });
});

type Expected = [Issue["level"], string, string, string]; // level, file, path, message substring

interface Case {
  name: string;
  file: string;
  edit?: (doc: Doc) => void;
  setup?: (root: string) => void;
  // One expected issue, or the full list; the case produces exactly these issues and no others.
  expect: Expected | Expected[];
}

// Asserts that issues are exactly the expected ones, each matched once.
function expectExactly(issues: Issue[], expected: Expected[]): void {
  const left = [...issues];
  for (const [level, file, path, message] of expected) {
    const at = left.findIndex((i) => i.level === level && i.file === file && i.path === path && i.message.includes(message));
    if (at < 0) throw new Error(`expected ${level} ${file} ${path} "${message}", got:\n${JSON.stringify(issues, null, 2)}`);
    left.splice(at, 1);
  }
  if (left.length) throw new Error(`unexpected issues:\n${JSON.stringify(left, null, 2)}`);
}

const SNAP_WH = "snapshots/warehouse.json";
const MIXED_CASE_COLUMN = { name: "MixedCase", type: "text", nullable: true, description: null };

// Adds a MixedCase column to the fct_orders snapshot table and a dimension whose expr is exprText.
function mixedCase(root: string, exprText: string, method = "live"): void {
  mutate(root, SNAP_WH, (d) => {
    d.method = method;
    d.tables.find((t: Doc) => t.name === "fct_orders").columns.push(MIXED_CASE_COLUMN);
  });
  mutate(root, ORDERS, (d) => d.dimensions.push({ name: "mixed", expr: exprText, type: "string", status: "draft" }));
}

const ORDERS = "models/warehouse/orders.yaml";
const CUSTOMERS = "models/warehouse/customers.yaml";
const GOLDEN = "goldens/revenue_by_month_2025.yaml";
const GOLDEN2 = "goldens/aov_by_region.yaml";

const CASES: Case[] = [
  // Structure
  { name: "unknown property", file: ORDERS, edit: (d) => (d.measures[0].aggregate = "sum"), expect: ["error", ORDERS, "measures[0].aggregate", "not a known property"] },
  {
    name: "bad enum",
    file: ORDERS,
    edit: (d) => (d.measures[1].agg = "total"),
    expect: [
      ["error", ORDERS, "measures[1].agg", "must be one of"],
      ["error", ORDERS, "measures[1].expr", "is required"],
    ],
  },
  {
    name: "bad name pattern",
    file: ORDERS,
    edit: (d) => (d.dimensions[1].name = "Status"),
    expect: [
      ["error", ORDERS, "dimensions[1].name", "must match"],
      ["error", GOLDEN2, "request.filters[0].field", 'no dimension or measure "status"'],
    ],
  },
  { name: "approved without approved_by", file: ORDERS, edit: (d) => delete d.measures[0].approved_by, expect: ["error", ORDERS, "measures[0].approved_by", "is required"] },
  { name: "approved model without approved_at", file: ORDERS, edit: (d) => delete d.approved_at, expect: ["error", ORDERS, "approved_at", "is required"] },
  { name: "measure without expr", file: CUSTOMERS, edit: (d) => delete d.measures[0].expr, expect: ["error", CUSTOMERS, "measures[0].expr", "is required"] },
  { name: "connection url in source", file: "sources/warehouse.yaml", edit: (d) => (d.connection.url = "postgres://x"), expect: ["error", "sources/warehouse.yaml", "connection.url", "not a known property"] },
  { name: "env holding a url", file: "sources/warehouse.yaml", edit: (d) => (d.connection.env = "postgres://u@h/db"), expect: ["error", "sources/warehouse.yaml", "connection.env", "must match"] },
  { name: "snapshot bad method", file: "snapshots/lake.json", edit: (d) => (d.method = "guess"), expect: ["error", "snapshots/lake.json", "method", "must be one of"] },
  { name: "ratio metric with expr", file: "metrics.yaml", edit: (d) => (d.metrics[0].expr = "{orders.revenue}"), expect: ["error", "metrics.yaml", "metrics[0].expr", "not allowed"] },
  { name: "filter between needs a pair", file: GOLDEN, edit: (d) => (d.request.filters[0] = { field: "orders.order_date", op: "between", value: ["2025-01-01"] }), expect: ["error", GOLDEN, "request.filters[0].value", "must NOT have fewer than 2 items"] },
  { name: "approved golden needs confirmed_by", file: GOLDEN, edit: (d) => delete d.confirmed_by, expect: ["error", GOLDEN, "confirmed_by", "is required"] },
  {
    name: "invalid yaml",
    file: "",
    setup: (r) => writeFileSync(join(r, "models/lake/web_events.yaml"), "model: [unclosed\n"),
    expect: [
      ["error", "models/lake/web_events.yaml", "", "invalid YAML"],
      ["warning", "access.yaml", "roles[0].allow.models[1]", '"lake.*" matches no model'],
    ],
  },
  { name: "project version", file: "semantic.yaml", edit: (d) => (d.version = 2), expect: ["error", "semantic.yaml", "version", "must be 1"] },

  // Project and sources
  { name: "default_source unknown", file: "semantic.yaml", edit: (d) => (d.default_source = "nope"), expect: ["error", "semantic.yaml", "default_source", "unknown source"] },
  { name: "source name differs from file", file: "sources/lake.yaml", edit: (d) => (d.source = "lakehouse"), expect: ["error", "sources/lake.yaml", "source", "file is named lake.yaml"] },
  { name: "invalid scope regex", file: "sources/lake.yaml", edit: (d) => (d.scope.include = ["re:web_(.*"]), expect: ["error", "sources/lake.yaml", "scope.include[0]", "Invalid regex"] },
  { name: "duckdb settings on postgres", file: "sources/warehouse.yaml", edit: (d) => (d.connection.views = { v: "x" }), expect: ["warning", "sources/warehouse.yaml", "connection.views", "only by duckdb"] },

  // Models
  { name: "model name differs from file", file: ORDERS, edit: (d) => (d.model = "order"), expect: ["error", ORDERS, "model", "file is named orders.yaml"] },
  {
    name: "model source differs from dir",
    file: "models/lake/web_events.yaml",
    edit: (d) => (d.source = "warehouse"),
    expect: [
      ["error", "models/lake/web_events.yaml", "source", "lives in models/lake/"],
      ["warning", "models/lake/web_events.yaml", "table", '"web_events" is not in snapshots/warehouse.json'],
    ],
  },
  {
    name: "model directory without a source",
    file: "",
    setup: (r) => renameSync(join(r, "sources", "lake.yaml"), join(r, "sources", "lake.bak")),
    expect: [
      ["error", "models/lake/web_events.yaml", "source", "unknown source"],
      ["warning", "snapshots/lake.json", "", "no source file sources/lake.yaml"],
    ],
  },
  { name: "table missing from snapshot", file: ORDERS, edit: (d) => (d.table = "public.fct_orderz"), expect: ["warning", ORDERS, "table", "not in snapshots/warehouse.json"] },
  { name: "dimension expr names a missing column", file: ORDERS, edit: (d) => (d.dimensions[1].expr = "order_status"), expect: ["error", ORDERS, "dimensions[1].expr", "not a column of public.fct_orders"] },
  { name: "join key from missing", file: ORDERS, edit: (d) => (d.joins[0].keys[0].from = "cust_id"), expect: ["error", ORDERS, "joins[0].keys[0].from", "not a column"] },
  { name: "join key to missing", file: ORDERS, edit: (d) => (d.joins[0].keys[0].to = "id"), expect: ["error", ORDERS, "joins[0].keys[0].to", "not a column of public.dim_customers"] },
  { name: "primary key missing column", file: CUSTOMERS, edit: (d) => (d.primary_key = ["id"]), expect: ["error", CUSTOMERS, "primary_key[0]", "not a column"] },
  { name: "hyphenated primary key", file: ORDERS, edit: (d) => (d.primary_key = ["order-id"]), expect: ["error", ORDERS, "primary_key[0]", '"order-id" is not a column of public.fct_orders'] },
  { name: "primary key in another case", file: ORDERS, edit: (d) => (d.primary_key = ["ORDER_ID"]), expect: [] },
  { name: "quoted join key", file: ORDERS, edit: (d) => (d.joins[0].keys[0].from = '"customer_id"'), expect: ["error", ORDERS, "joins[0].keys[0].from", "without quotes"] },
  { name: "spaced join key", file: ORDERS, edit: (d) => (d.joins[0].keys[0].to = "customer id"), expect: ["error", ORDERS, "joins[0].keys[0].to", '"customer id" is not a column of public.dim_customers'] },
  {
    name: "join key with a space that exists",
    file: "",
    setup: (r) => {
      mutate(r, SNAP_WH, (d) => d.tables.find((t: Doc) => t.name === "fct_orders").columns.push({ name: "Customer Ref", type: "integer", nullable: true, description: null }));
      mutate(r, ORDERS, (d) => (d.joins[0].keys[0].from = "customer ref"));
    },
    expect: [],
  },
  { name: "postgres: bare mixed-case expr folds to lower case", file: "", setup: (r) => mixedCase(r, "MixedCase"), expect: ["error", ORDERS, "dimensions[3].expr", 'resolves to mixedcase in postgres, but the column is "MixedCase"; write "MixedCase"'] },
  { name: "postgres: quoted mixed-case expr resolves", file: "", setup: (r) => mixedCase(r, '"MixedCase"'), expect: [] },
  { name: "postgres: quoted expr is case-sensitive", file: "", setup: (r) => mixedCase(r, '"mixedcase"'), expect: ["error", ORDERS, "dimensions[3].expr", 'write "MixedCase"'] },
  { name: "postgres: bare expr matching a lower-case column", file: ORDERS, edit: (d) => (d.dimensions[1].expr = "STATUS"), expect: [] },
  { name: "postgres: case is not enforced on a manual snapshot", file: "", setup: (r) => mixedCase(r, "MixedCase", "manual"), expect: [] },
  { name: "duckdb: bare expr is case-insensitive", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = "Event_Type"), expect: [] },
  { name: "duckdb: quoted expr is case-insensitive", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = '"EVENT_TYPE"'), expect: [] },
  {
    name: "duplicate name across kinds",
    file: ORDERS,
    edit: (d) => (d.measures[1].name = "status"),
    expect: [
      ["error", ORDERS, "measures[1].name", "already used by dimensions[1]"],
      ["error", "metrics.yaml", "metrics[0].denominator", 'has no measure "order_count"'],
      ["error", GOLDEN2, "request.measures[1]", 'has no measure "order_count"'],
    ],
  },
  { name: "join to unknown model", file: ORDERS, edit: (d) => (d.joins[0].to = "clients"), expect: ["error", ORDERS, "joins[0].to", "not a model of source warehouse"] },
  { name: "join across sources", file: ORDERS, edit: (d) => (d.joins[0].to = "web_events"), expect: ["error", ORDERS, "joins[0].to", "not a model of source warehouse"] },
  {
    name: "one_to_many warns about fan-out",
    file: CUSTOMERS,
    edit: (d) => (d.joins = [{ name: "orders", to: "orders", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "one_to_many", status: "draft" }]),
    expect: ["warning", CUSTOMERS, "joins[0].relationship", "fans out"],
  },
  { name: "many_to_many evidence on approved join", file: ORDERS, edit: (d) => (d.joins[0].evidence.suggested_relationship = "many_to_many"), expect: ["error", ORDERS, "joins[0].evidence.suggested_relationship", "bridge table"] },
  { name: "approved join without evidence", file: ORDERS, edit: (d) => delete d.joins[0].evidence, expect: ["warning", ORDERS, "joins[0]", "without evidence"] },
  { name: "relationship disagrees with evidence", file: ORDERS, edit: (d) => (d.joins[0].relationship = "one_to_one"), expect: ["warning", ORDERS, "joins[0].relationship", "evidence suggests many_to_one"] },
  { name: "approved model without grain", file: ORDERS, edit: (d) => delete d.grain, expect: ["error", ORDERS, "grain", "approved model"] },
  { name: "approved model without primary_key", file: ORDERS, edit: (d) => delete d.primary_key, expect: ["error", ORDERS, "primary_key", "approved model"] },
  { name: "approved measure without description", file: ORDERS, edit: (d) => delete d.measures[1].description, expect: ["error", ORDERS, "measures[1].description", "approved measure"] },
  { name: "time_grains on a string dimension", file: ORDERS, edit: (d) => (d.dimensions[1].time_grains = ["day"]), expect: ["error", ORDERS, "dimensions[1].time_grains", "only allowed on time"] },
  { name: "currency without format currency", file: ORDERS, edit: (d) => (d.measures[1].currency = "USD"), expect: ["error", ORDERS, "measures[1].currency", "only allowed with format currency"] },
  { name: "format currency without a code", file: ORDERS, edit: (d) => delete d.measures[0].currency, expect: [] },
  { name: "impossible approval date", file: ORDERS, edit: (d) => (d.approved_at = "2026-13-45"), expect: ["error", ORDERS, "approved_at", "real calendar date"] },
  { name: "malformed approval date", file: ORDERS, edit: (d) => (d.approved_at = "15/01/2026"), expect: ["error", ORDERS, "approved_at", "must match"] },

  // Metrics
  { name: "duplicate metric", file: "metrics.yaml", edit: (d) => (d.metrics[1].name = "average_order_value"), expect: ["error", "metrics.yaml", "metrics[1].name", "already defined"] },
  { name: "metric source unknown", file: "metrics.yaml", edit: (d) => (d.metrics[1].source = "crm"), expect: ["error", "metrics.yaml", "metrics[1].source", "unknown source"] },
  { name: "numerator unresolved", file: "metrics.yaml", edit: (d) => (d.metrics[0].numerator = "orders.gmv"), expect: ["error", "metrics.yaml", "metrics[0].numerator", "has no measure \"gmv\""] },
  { name: "denominator in another source", file: "metrics.yaml", edit: (d) => (d.metrics[0].denominator = "web_events.event_count"), expect: ["error", "metrics.yaml", "metrics[0].denominator", "not a model of source warehouse"] },
  { name: "derived placeholder unresolved", file: "metrics.yaml", edit: (d) => (d.metrics[1].expr = "{orders.revenue} - {refunds.refund_amount}"), expect: ["error", "metrics.yaml", "metrics[1].expr", "refunds.refund_amount does not resolve"] },
  { name: "derived expr beyond arithmetic", file: "metrics.yaml", edit: (d) => (d.metrics[1].expr = "coalesce({orders.revenue}, 0)"), expect: ["error", "metrics.yaml", "metrics[1].expr", "only"] },
  { name: "approved metric uses a draft measure", file: "metrics.yaml", edit: (d) => (d.metrics[0].denominator = "customers.customer_count"), expect: ["error", "metrics.yaml", "metrics[0].denominator", "only approved measures"] },
  { name: "approved metric without description", file: "metrics.yaml", edit: (d) => delete d.metrics[0].description, expect: ["error", "metrics.yaml", "metrics[0].description", "approved metric"] },

  // Access
  {
    name: "duplicate role",
    file: "access.yaml",
    edit: (d) => (d.roles[1].name = "analyst"),
    expect: [
      ["error", "access.yaml", "roles[1].name", "already defined"],
      ["error", GOLDEN2, "role", 'unknown role "sales_rep"'],
    ],
  },
  { name: "default_role unknown", file: "access.yaml", edit: (d) => (d.default_role = "admin"), expect: ["error", "access.yaml", "default_role", "unknown role"] },
  { name: "allow pattern invalid", file: "access.yaml", edit: (d) => (d.roles[0].allow.models = ["re:ware(house"]), expect: ["error", "access.yaml", "roles[0].allow.models[0]", "Invalid regex"] },
  { name: "allow pattern matches nothing", file: "access.yaml", edit: (d) => d.roles[0].allow.models.push("crm.*"), expect: ["warning", "access.yaml", "roles[0].allow.models[2]", "matches no model"] },
  { name: "deny field unknown", file: "access.yaml", edit: (d) => (d.roles[1].deny.fields = ["warehouse.customers.phone"]), expect: ["error", "access.yaml", "roles[1].deny.fields[0]", "not a dimension or measure"] },
  { name: "row filter model unknown", file: "access.yaml", edit: (d) => (d.roles[1].row_filters[0].model = "warehouse.shipments"), expect: ["error", "access.yaml", "roles[1].row_filters[0].model", "not a model"] },
  {
    name: "row filter placeholder without user.",
    file: "access.yaml",
    edit: (d) => (d.roles[1].row_filters[0].expr = "ship_region = {{ user.region }} and team = {{ region }}"),
    expect: ["error", "access.yaml", "roles[1].row_filters[0].expr", "{{ region }} is not a placeholder"],
  },
  { name: "row filter placeholder unclosed", file: "access.yaml", edit: (d) => (d.roles[1].row_filters[0].expr = "ship_region = {{ user.region"), expect: ["error", "access.yaml", "roles[1].row_filters[0].expr", "unclosed"] },
  { name: "row filter placeholder undeclared", file: "access.yaml", edit: (d) => (d.roles[1].row_filters[0].expr = "ship_region = {{ user.territory }}"), expect: ["error", "access.yaml", "roles[1].row_filters[0].expr", "user.territory"] },
  { name: "denied tag used nowhere", file: "access.yaml", edit: (d) => d.roles[0].deny.tags.push("finance"), expect: ["warning", "access.yaml", "roles[0].deny.tags[1]", "not used"] },
  {
    name: "access approved without approver",
    file: "access.yaml",
    edit: (d) => (d.status = "approved"),
    expect: [
      ["error", "access.yaml", "approved_by", "is required"],
      ["error", "access.yaml", "approved_at", "is required"],
    ],
  },

  // Goldens
  { name: "golden name differs from file", file: GOLDEN, edit: (d) => (d.name = "revenue_2025"), expect: ["error", GOLDEN, "name", "file is named revenue_by_month_2025.yaml"] },
  { name: "golden source unknown", file: GOLDEN, edit: (d) => (d.request.source = "crm"), expect: ["error", GOLDEN, "request.source", "unknown source"] },
  { name: "golden measure unresolved", file: GOLDEN, edit: (d) => (d.request.measures = ["orders.gmv"]), expect: ["error", GOLDEN, "request.measures[0]", "no measure \"gmv\""] },
  { name: "golden metric unknown", file: GOLDEN2, edit: (d) => (d.request.measures[0] = "aov"), expect: ["error", GOLDEN2, "request.measures[0]", "not a metric"] },
  { name: "golden dimension used as measure", file: GOLDEN, edit: (d) => (d.request.measures = ["orders.status"]), expect: ["error", GOLDEN, "request.measures[0]", "no measure \"status\""] },
  { name: "golden dimension unresolved", file: GOLDEN2, edit: (d) => (d.request.dimensions = ["orders.region"]), expect: ["error", GOLDEN2, "request.dimensions[0]", "no dimension \"region\""] },
  { name: "golden grain not allowed", file: GOLDEN, edit: (d) => (d.request.dimensions = ["orders.order_date:hour"]), expect: ["error", GOLDEN, "request.dimensions[0]", "grain hour is not in"] },
  { name: "golden grain on non-time", file: GOLDEN2, edit: (d) => (d.request.dimensions = ["orders.ship_region:month"]), expect: ["error", GOLDEN2, "request.dimensions[0]", "only to time dimensions"] },
  { name: "golden filter field unresolved", file: GOLDEN, edit: (d) => (d.request.filters[0].field = "orders.placed_at"), expect: ["error", GOLDEN, "request.filters[0].field", "placed_at"] },
  { name: "golden order_by unresolved", file: GOLDEN, edit: (d) => (d.request.order_by[0].field = "customers.nope"), expect: ["error", GOLDEN, "request.order_by[0].field", "nope"] },
  { name: "golden role unknown", file: GOLDEN, edit: (d) => (d.role = "admin"), expect: ["error", GOLDEN, "role", "unknown role"] },
  { name: "golden user attribute undeclared", file: GOLDEN2, edit: (d) => (d.user = { team: "x" }), expect: ["error", GOLDEN2, "user.team", "not a declared user attribute"] },
  { name: "eq filter with a list", file: GOLDEN, edit: (d) => (d.request.filters[0].value = ["2025-01-01"]), expect: ["error", GOLDEN, "request.filters[0].value", "must be a single value, not a list or object"] },
  { name: "approved golden without rows", file: GOLDEN, edit: (d) => (d.expected.rows = []), expect: ["error", GOLDEN, "expected.rows", "at least one expected row"] },

  // Shapes that fail the schema but are still read for references
  { name: "null dimension item", file: CUSTOMERS, edit: (d) => d.dimensions.unshift(null), expect: ["error", CUSTOMERS, "dimensions[0]", "must be object"] },
  { name: "null measure item", file: ORDERS, edit: (d) => d.measures.unshift(null), expect: ["error", ORDERS, "measures[0]", "must be object"] },
  { name: "null metric item", file: "metrics.yaml", edit: (d) => d.metrics.unshift(null), expect: ["error", "metrics.yaml", "metrics[0]", "must be object"] },
  { name: "null role item", file: "access.yaml", edit: (d) => d.roles.unshift(null), expect: ["error", "access.yaml", "roles[0]", "must be object"] },
  { name: "null user attribute", file: "access.yaml", edit: (d) => d.user_attributes.unshift(null), expect: ["error", "access.yaml", "user_attributes[0]", "must be object"] },
  { name: "null snapshot table", file: SNAP_WH, edit: (d) => d.tables.unshift(null), expect: ["error", SNAP_WH, "tables[0]", "must be object"] },
  { name: "snapshot table without columns", file: SNAP_WH, edit: (d) => delete d.tables[0].columns, expect: ["error", SNAP_WH, "tables[0].columns", "is required"] },
  {
    name: "null snapshot column",
    file: SNAP_WH,
    edit: (d) => (d.tables[1].columns[0] = null),
    expect: [
      ["error", SNAP_WH, "tables[1].columns[0]", "must be object"],
      ["error", ORDERS, "primary_key[0]", '"order_id" is not a column of public.fct_orders'],
    ],
  },
  {
    name: "dimension list is a string",
    file: "",
    setup: (r) => writeFileSync(join(r, CUSTOMERS), readFileSync(join(r, CUSTOMERS), "utf8").replace("dimensions:\n", "dimensions: oops\nxdims:\n")),
    expect: [
      ["error", CUSTOMERS, "dimensions", "must be array"],
      ["error", CUSTOMERS, "xdims", "not a known property"],
      ["warning", "access.yaml", "roles[0].deny.tags[0]", "not used"],
      ["error", "access.yaml", "roles[1].deny.fields[0]", "not a dimension or measure"],
    ],
  },

  // File names
  {
    name: "model defined by .yaml and .yml",
    file: "",
    setup: (r) => cpSync(join(r, ORDERS), join(r, "models/warehouse/orders.yml")),
    expect: ["error", "models/warehouse/orders.yml", "", "orders is defined twice (orders.yaml and orders.yml)"],
  },
  {
    name: "lone .yml model",
    file: "",
    setup: (r) => renameSync(join(r, CUSTOMERS), join(r, "models/warehouse/customers.yml")),
    expect: ["warning", "models/warehouse/customers.yml", "", "rename this file"],
  },

  // Snapshots
  { name: "snapshot source differs from file", file: "snapshots/lake.json", edit: (d) => (d.source = "lakehouse"), expect: ["error", "snapshots/lake.json", "source", "file is named lake.json"] },
];

describe("mutations of the valid fixture", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const root = copyFixture();
      if (c.setup) c.setup(root);
      if (c.edit) mutate(root, c.file, c.edit);
      const issues = validateProject(root);
      const expected = c.expect.length && Array.isArray(c.expect[0]) ? (c.expect as Expected[]) : c.expect.length ? [c.expect as Expected] : [];
      expectExactly(issues, expected);
    });
  }

  test("a warning alone keeps the project valid; an error exits 1", async () => {
    const warnRoot = copyFixture();
    mutate(warnRoot, ORDERS, (d) => delete d.joins[0].evidence);
    const w = await sl(warnRoot, ["validate", "--json"]);
    expect(w.code).toBe(0);
    expect(w.json<{ ok: boolean; warnings: number }>()).toMatchObject({ ok: true, warnings: 1 });

    const errRoot = copyFixture();
    mutate(errRoot, ORDERS, (d) => (d.measures[1].agg = "total"));
    const e = await sl(errRoot, ["validate", "--json"]);
    expect(e.code).toBe(1);
    const body = e.json<{ ok: boolean; errors: number; issues: Issue[] }>();
    expect(body.ok).toBe(false);
    expect(body.errors).toBeGreaterThan(0);
    const human = await sl(errRoot, ["validate"]);
    expect(human.code).toBe(1);
    expect(human.out).toContain(ORDERS);
    expect(human.out).toContain("measures[1].agg");
    expect(human.out).toMatch(/Invalid: \d+ errors?/);
  });

  test("missing semantic.yaml is an error", () => {
    const root = copyFixture();
    rmSync(join(root, "semantic.yaml"));
    expectIssue(validateProject(root), "error", "semantic.yaml", "", "missing");
  });

  test("a structurally invalid file still resolves for references elsewhere", () => {
    const root = copyFixture();
    mutate(root, CUSTOMERS, (d) => (d.owner = "x"));
    const errs = errors(validateProject(root));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ file: CUSTOMERS, path: "owner" });
  });

  test("an unreadable access.yaml is reported once, not as missing roles in goldens", () => {
    const root = copyFixture();
    writeFileSync(join(root, "access.yaml"), "roles: [unclosed\n");
    const issues = validateProject(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "error", file: "access.yaml", path: "" });
    expect(issues[0]!.message).toStartWith("invalid YAML");
    expect(issues[0]!.message).not.toContain("\n");
  });

  test("a missing root is a user error", async () => {
    const r = await sl(join(tmpdir(), "sl-validate-does-not-exist"), ["validate"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No semantic layer");
  });
});

// The validator's verdict on a bare or quoted identifier agrees with how Postgres resolves it.
const PG_URL = process.env.PG_URL;
describe.skipIf(!PG_URL)("postgres identifier resolution", () => {
  const SCHEMA = "t_validate";
  let sql: SQL;
  beforeAll(async () => {
    sql = new SQL(PG_URL!);
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}; create table ${SCHEMA}.c ("MixedCase" text, status text)`);
  });
  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql.close();
  });

  for (const exprText of ["MixedCase", "mixedcase", '"MixedCase"', '"mixedcase"', "STATUS", '"status"', '"STATUS"']) {
    test(exprText, async () => {
      const root = copyFixture();
      mixedCase(root, exprText);
      const flagged = validateProject(root).some((i) => i.level === "error" && i.path === "dimensions[3].expr");
      let runs = true;
      try {
        await sql.unsafe(`select ${exprText} from ${SCHEMA}.c`);
      } catch {
        runs = false;
      }
      expect(flagged).toBe(!runs);
    });
  }
});

// Every complete file example in references/spec.md passes its schema, so the spec and schemas cannot drift.
describe("spec examples", () => {
  const HEADING_KIND: Record<string, SchemaKind> = {
    "semantic.yaml": "project",
    "sources/<source>.yaml": "source",
    "snapshots/<source>.json": "snapshot",
    "models/<source>/<model>.yaml": "model",
    "metrics.yaml": "metrics",
    "access.yaml": "access",
    "goldens/<name>.yaml": "golden",
  };
  const blocks: { kind: SchemaKind; lang: string; text: string; line: number }[] = [];
  let heading = "";
  const lines = readFileSync(SPEC, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = line.match(/^## (.+)$/);
    if (h) heading = h[1]!.trim();
    const fence = line.match(/^```(\w+)\s*$/);
    if (!fence) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
    const kind = HEADING_KIND[heading];
    if (kind && (fence[1] === "yaml" || fence[1] === "json")) blocks.push({ kind, lang: fence[1]!, text: body.join("\n"), line: start + 1 });
  }

  test("every file kind has at least one example", () => {
    const kinds = new Set(blocks.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(["access", "golden", "metrics", "model", "project", "snapshot", "source"]);
    expect(blocks.filter((b) => b.kind === "source")).toHaveLength(2);
  });

  for (const b of blocks) {
    test(`${b.kind} example at spec.md:${b.line} passes its schema`, () => {
      const data = b.lang === "json" ? JSON.parse(b.text) : parseYamlText(b.text);
      expect(schemaIssues(b.kind, data, `spec.md:${b.line}`)).toEqual([]);
    });
  }
});

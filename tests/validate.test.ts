import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Issue, type SchemaKind, schemaIssues, sqlNames, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
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
  // Text every issue of the case must contain.
  hint?: string;
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
const GOLDEN3 = "goldens/revenue_by_customer_region.yaml";
const UNREACHABLE = "model customers is not reachable from orders";
const ACCESS = "access.yaml";
const SHIPMENTS = "models/warehouse/shipments.yaml";
// The fixture's orders.customer evidence records the keys it measured, so editing them makes it stale.
const STALE_KEYS: Expected = ["warning", ORDERS, "joins[0].evidence.keys", "the evidence was measured on keys customer_id = customer_id"];

// Adds a model of the warehouse source over a new snapshot table.
function addModel(root: string, model: string, table: string, columns: string[], body: Doc): void {
  mutate(root, SNAP_WH, (d) =>
    d.tables.push({
      schema: "public",
      name: table,
      kind: "table",
      row_count: 6,
      description: null,
      primary_key: [columns[0]],
      unique_keys: [],
      foreign_keys: [],
      columns: columns.map((name) => ({ name, type: "text", nullable: false, description: null })),
    }),
  );
  writeYaml(join(root, `models/warehouse/${model}.yaml`), { model, source: "warehouse", table: `public.${table}`, status: "draft", dimensions: [], measures: [], ...body });
}

// Adds a regions model reached from customers by a home_region join, two hops from orders.
function addRegions(root: string): void {
  addModel(root, "regions", "dim_regions", ["region", "region_name"], {
    dimensions: [{ name: "region_name", expr: "region_name", type: "string", status: "draft" }],
  });
  mutate(root, CUSTOMERS, (d) => (d.joins = [{ name: "home_region", to: "regions", keys: [{ from: "region", to: "region" }], relationship: "many_to_one", status: "draft" }]));
}

// Adds a shipments model joined to orders, so regions is three hops from shipments.
function addShipments(root: string): void {
  addModel(root, "shipments", "fct_shipments", ["shipment_id", "order_id"], {
    dimensions: [{ name: "order_date", expr: "order.created_at", type: "time", status: "draft" }],
    measures: [{ name: "shipment_count", agg: "count", status: "draft" }],
    joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "order_id" }], relationship: "many_to_one", status: "draft" }],
  });
}

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
      ["warning", GOLDEN2, "request.filters[0].field", 'no dimension or measure "status"; a draft golden may name a field before it exists'],
    ],
  },
  { name: "approved without approved_by", file: ORDERS, edit: (d) => delete d.measures[0].approved_by, expect: ["error", ORDERS, "measures[0].approved_by", "is required"] },
  { name: "approved model without approved_at", file: ORDERS, edit: (d) => delete d.approved_at, expect: ["error", ORDERS, "approved_at", "is required"] },
  ...(["dimensions", "measures"] as const).map(
    (key): Case => ({
      name: `model without ${key}`,
      file: "",
      setup: (r) => (addModel(r, "notes", "dim_notes", ["note_id"], {}), mutate(r, "models/warehouse/notes.yaml", (d) => delete d[key])),
      expect: ["error", "models/warehouse/notes.yaml", key, `is required; write ${key}: [] when the model has none`],
    }),
  ),
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
  { name: "join key from missing", file: ORDERS, edit: (d) => (d.joins[0].keys[0].from = "cust_id"), expect: [["error", ORDERS, "joins[0].keys[0].from", "not a column"], STALE_KEYS] },
  { name: "join key to missing", file: ORDERS, edit: (d) => (d.joins[0].keys[0].to = "id"), expect: [["error", ORDERS, "joins[0].keys[0].to", "not a column of public.dim_customers"], STALE_KEYS] },
  { name: "primary key missing column", file: CUSTOMERS, edit: (d) => (d.primary_key = ["id"]), expect: ["error", CUSTOMERS, "primary_key[0]", "not a column"] },
  { name: "hyphenated primary key", file: ORDERS, edit: (d) => (d.primary_key = ["order-id"]), expect: ["error", ORDERS, "primary_key[0]", '"order-id" is not a column of public.fct_orders'] },
  { name: "primary key in another case", file: ORDERS, edit: (d) => (d.primary_key = ["ORDER_ID"]), expect: [] },
  { name: "quoted join key", file: ORDERS, edit: (d) => (d.joins[0].keys[0].from = '"customer_id"'), expect: [["error", ORDERS, "joins[0].keys[0].from", "without quotes"], STALE_KEYS] },
  { name: "spaced join key", file: ORDERS, edit: (d) => (d.joins[0].keys[0].to = "customer id"), expect: [["error", ORDERS, "joins[0].keys[0].to", '"customer id" is not a column of public.dim_customers'], STALE_KEYS] },
  {
    name: "join key with a space that exists",
    file: "",
    setup: (r) => {
      mutate(r, SNAP_WH, (d) => d.tables.find((t: Doc) => t.name === "fct_orders").columns.push({ name: "Customer Ref", type: "integer", nullable: true, description: null }));
      mutate(r, ORDERS, (d) => (d.joins[0].keys[0].from = "customer ref"));
    },
    expect: [STALE_KEYS],
  },
  { name: "postgres: bare mixed-case expr folds to lower case", file: "", setup: (r) => mixedCase(r, "MixedCase"), expect: ["error", ORDERS, "dimensions[4].expr", 'resolves to mixedcase in postgres, but the column is "MixedCase"; write "MixedCase"'] },
  { name: "postgres: quoted mixed-case expr resolves", file: "", setup: (r) => mixedCase(r, '"MixedCase"'), expect: [] },
  { name: "postgres: quoted expr is case-sensitive", file: "", setup: (r) => mixedCase(r, '"mixedcase"'), expect: ["error", ORDERS, "dimensions[4].expr", 'write "MixedCase"'] },
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
      ["warning", GOLDEN2, "request.measures[1]", 'has no measure "order_count"'],
    ],
  },
  {
    name: "join to unknown model",
    file: ORDERS,
    edit: (d) => (d.joins[0].to = "clients"),
    expect: [
      ["error", ORDERS, "joins[0].to", "not a model of source warehouse"],
      ["warning", ORDERS, "joins[0].evidence.to", "measured for a join to customers"],
      ["error", GOLDEN3, "request.dimensions[0]", UNREACHABLE],
    ],
  },
  {
    name: "join across sources",
    file: ORDERS,
    edit: (d) => (d.joins[0].to = "web_events"),
    expect: [
      ["error", ORDERS, "joins[0].to", "not a model of source warehouse"],
      ["warning", ORDERS, "joins[0].evidence.to", "measured for a join to customers"],
      ["error", GOLDEN3, "request.dimensions[0]", UNREACHABLE],
    ],
  },
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
  { name: "approved currency measure without a code", file: ORDERS, edit: (d) => delete d.measures[0].currency, expect: ["warning", ORDERS, "measures[0].currency", "is missing on an approved item with format currency"] },
  {
    name: "draft currency measure without a code",
    file: ORDERS,
    edit: (d) => {
      delete d.measures[0].currency;
      d.measures[0].status = "draft";
      delete d.measures[0].approved_by;
      delete d.measures[0].approved_at;
    },
    expect: [
      ["error", "metrics.yaml", "metrics[0].numerator", "only approved measures"],
      ["warning", GOLDEN, "request.measures[0]", "an approved golden uses draft measure orders.revenue"],
    ],
  },
  { name: "approved currency metric without a code", file: "metrics.yaml", edit: (d) => delete d.metrics[0].currency, expect: ["warning", "metrics.yaml", "metrics[0].currency", "is missing on an approved item"] },
  { name: "draft currency metric without a code", file: "metrics.yaml", edit: (d) => delete d.metrics[1].currency, expect: [] },
  { name: "impossible approval date", file: ORDERS, edit: (d) => (d.approved_at = "2026-13-45"), expect: ["error", ORDERS, "approved_at", "real calendar date"] },
  { name: "malformed approval date", file: ORDERS, edit: (d) => (d.approved_at = "15/01/2026"), expect: ["error", ORDERS, "approved_at", "must match"] },

  // Metrics
  { name: "duplicate metric", file: "metrics.yaml", edit: (d) => (d.metrics[1].name = "average_order_value"), expect: ["error", "metrics.yaml", "metrics[1].name", "already defined"] },
  { name: "metric source unknown", file: "metrics.yaml", edit: (d) => (d.metrics[1].source = "crm"), expect: ["error", "metrics.yaml", "metrics[1].source", "unknown source"] },
  { name: "numerator unresolved", file: "metrics.yaml", edit: (d) => (d.metrics[0].numerator = "orders.gmv"), expect: ["error", "metrics.yaml", "metrics[0].numerator", "has no measure \"gmv\""] },
  { name: "denominator in another source", file: "metrics.yaml", edit: (d) => (d.metrics[0].denominator = "web_events.event_count"), expect: ["error", "metrics.yaml", "metrics[0].denominator", "not a model of source warehouse"] },
  { name: "derived placeholder unresolved", file: "metrics.yaml", edit: (d) => (d.metrics[1].expr = "{orders.revenue} - {refunds.refund_amount}"), expect: ["error", "metrics.yaml", "metrics[1].expr", "refunds.refund_amount does not resolve"] },
  { name: "derived expr beyond arithmetic", file: "metrics.yaml", edit: (d) => (d.metrics[1].expr = "coalesce({orders.revenue}, 0)"), expect: ["error", "metrics.yaml", "metrics[1].expr", "only"] },
  {
    name: "approved metric uses a draft measure",
    file: "metrics.yaml",
    edit: (d) => (d.metrics[0].denominator = "customers.customer_count"),
    expect: [
      ["error", "metrics.yaml", "metrics[0].denominator", "only approved measures"],
      ["error", GOLDEN2, "request.dimensions[0]", 'customers has no dimension "ship_region"'],
    ],
  },
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
  { name: "golden metric unknown", file: GOLDEN, edit: (d) => (d.request.measures[0] = "aov"), expect: ["error", GOLDEN, "request.measures[0]", "not a metric"] },
  { name: "draft golden metric unknown", file: GOLDEN2, edit: (d) => (d.request.measures[0] = "aov"), expect: ["warning", GOLDEN2, "request.measures[0]", '"aov" is not a metric; a draft golden may name a field before it exists; add the field before confirming the golden, because sl validate errors on it once the golden is approved'] },
  { name: "draft golden model unknown", file: GOLDEN3, edit: (d) => (d.request.measures = ["new_customers.new_customer_count"]), expect: ["warning", GOLDEN3, "request.measures[0]", '"new_customers" is not a model of source warehouse; a draft golden'] },
  { name: "draft golden measure in a dimension slot stays an error", file: GOLDEN3, edit: (d) => (d.request.dimensions = ["orders.revenue"]), expect: ["error", GOLDEN3, "request.dimensions[0]", 'model orders has no dimension "revenue"'] },
  { name: "draft golden malformed field stays an error", file: GOLDEN3, edit: (d) => (d.request.dimensions = ["orders"]), expect: ["error", GOLDEN3, "request.dimensions[0]", '"orders" must be model.field'] },
  { name: "draft golden grain problem stays an error", file: GOLDEN2, edit: (d) => (d.request.dimensions = ["orders.ship_region:month"]), expect: ["error", GOLDEN2, "request.dimensions[0]", "only to time dimensions"] },
  { name: "golden dimension used as measure", file: GOLDEN, edit: (d) => (d.request.measures = ["orders.status"]), expect: ["error", GOLDEN, "request.measures[0]", "no measure \"status\""] },
  { name: "golden dimension unresolved", file: GOLDEN, edit: (d) => (d.request.dimensions = ["orders.region"]), expect: ["error", GOLDEN, "request.dimensions[0]", "no dimension \"region\""] },
  { name: "draft golden dimension unresolved", file: GOLDEN2, edit: (d) => (d.request.dimensions = ["orders.region"]), expect: ["warning", GOLDEN2, "request.dimensions[0]", "no dimension \"region\""] },
  {
    name: "golden request with a metrics key",
    file: GOLDEN2,
    edit: (d) => (d.request.metrics = ["average_order_value"]),
    expect: ["error", GOLDEN2, "request.metrics", "is not a known property; there is no metrics key: request.measures lists measures as model.measure and metrics by bare name"],
  },
  { name: "golden grain not allowed", file: GOLDEN, edit: (d) => (d.request.dimensions = ["orders.order_date:hour"]), expect: ["error", GOLDEN, "request.dimensions[0]", "grain hour is not in"] },
  { name: "golden grain on non-time", file: GOLDEN2, edit: (d) => (d.request.dimensions = ["orders.ship_region:month"]), expect: ["error", GOLDEN2, "request.dimensions[0]", "only to time dimensions"] },
  { name: "golden filter field unresolved", file: GOLDEN, edit: (d) => (d.request.filters[0].field = "orders.placed_at"), expect: ["error", GOLDEN, "request.filters[0].field", "placed_at"] },
  { name: "golden order_by unresolved", file: GOLDEN, edit: (d) => (d.request.order_by[0].field = "customers.nope"), expect: ["error", GOLDEN, "request.order_by[0].field", "nope"] },
  { name: "golden role unknown", file: GOLDEN, edit: (d) => (d.role = "admin"), expect: ["error", GOLDEN, "role", "unknown role"] },
  { name: "golden user attribute undeclared", file: GOLDEN2, edit: (d) => (d.user = { team: "x" }), expect: ["error", GOLDEN2, "user.team", "not a declared user attribute"] },
  { name: "eq filter with a list", file: GOLDEN, edit: (d) => (d.request.filters[0].value = ["2025-01-01"]), expect: ["error", GOLDEN, "request.filters[0].value", "must be a single value, not a list or object"] },
  { name: "approved golden without rows", file: GOLDEN, edit: (d) => (d.expected.rows = []), expect: ["error", GOLDEN, "expected.rows", "at least one expected row"] },

  // Join references in exprs and filters
  { name: "join reference to a missing column", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "customer.home_region"), expect: ["error", ORDERS, "dimensions[3].expr", '"home_region" is not a column of public.dim_customers, the table of model customers that join customer reaches'] },
  { name: "join reference to a column in another case", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "customer.REGION"), expect: [] },
  { name: "join reference through an unknown join", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "buyer.region"), expect: ["error", ORDERS, "dimensions[3].expr", '"buyer" is neither a column nor a join of model orders (its joins are customer)'] },
  {
    name: "join reference through a one_to_many join",
    file: ORDERS,
    edit: (d) => (d.joins[0].relationship = "one_to_many"),
    expect: [
      ["error", ORDERS, "dimensions[3].expr", "goes through join customer, which is one_to_many"],
      ["error", ORDERS, "measures[0].filter", "goes through join customer, which is one_to_many"],
      ["warning", ORDERS, "joins[0].relationship", "fans out"],
      ["warning", ORDERS, "joins[0].relationship", "evidence suggests many_to_one"],
      ["error", GOLDEN3, "request.dimensions[0]", UNREACHABLE],
    ],
  },
  { name: "join reference through a one_to_one join", file: ORDERS, edit: (d) => ((d.joins[0].relationship = "one_to_one"), (d.joins[0].evidence.suggested_relationship = "one_to_one")), expect: [] },
  { name: "join reference with two hops", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "customer.home.region_name"), expect: ["error", ORDERS, "dimensions[3].expr", '"home" is not a column of public.dim_customers'] },
  {
    name: "join reference when the target table is not in the snapshot",
    file: CUSTOMERS,
    edit: (d) => (d.table = "public.dim_customer"),
    expect: ["warning", CUSTOMERS, "table", "not in snapshots/warehouse.json"],
  },
  { name: "join reference named after a reserved word", file: "", setup: (r) => addShipments(r), expect: [] },
  {
    name: "join reference beyond one hop when the target table is unknown",
    file: "",
    setup: (r) => {
      mutate(r, CUSTOMERS, (d) => (d.table = "public.dim_customer"));
      mutate(r, ORDERS, (d) => (d.dimensions[3].expr = "customer.home.region_name"));
    },
    expect: [
      ["warning", CUSTOMERS, "table", "not in snapshots/warehouse.json"],
      ["error", ORDERS, "dimensions[3].expr", '"home" is not a join of model customers, and the table of customers is not in the snapshot'],
    ],
  },
  { name: "join reference in a measure expr", file: ORDERS, edit: (d) => (d.measures[1] = { ...d.measures[1], agg: "sum", expr: "customer.is_test_account::int" }), expect: ["error", ORDERS, "measures[1].expr", "a measure expr is over the model's own columns"] },
  {
    name: "subquery in a measure filter",
    file: ORDERS,
    edit: (d) => (d.measures[0].filter = "status <> 'cancelled' and customer_id not in (select customer_id from public.dim_customers where is_test_account)"),
    expect: ["error", ORDERS, "measures[0].filter", "has a subquery; a measure filter may name only this model's columns and <join>.<column> or <join>.<join>.<column> join references"],
  },
  { name: "subquery in a dimension expr", file: ORDERS, edit: (d) => (d.dimensions[1].expr = "(SELECT max(status) FROM public.fct_orders)"), expect: ["error", ORDERS, "dimensions[1].expr", "has a subquery"] },
  { name: "subquery in a measure expr", file: CUSTOMERS, edit: (d) => (d.measures[0].expr = "(select 1)"), expect: ["error", CUSTOMERS, "measures[0].expr", "has a subquery; a measure expr may name only this model's columns; put a joined column in the measure's filter or in a dimension, or ask the owner for a view"] },
  { name: "schema-qualified table in a dimension expr", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "public.dim_customers.region"), expect: ["error", ORDERS, "dimensions[3].expr", "public.dim_customers.region names a table or schema directly"] },
  { name: "table name in a measure filter", file: ORDERS, edit: (d) => (d.measures[0].filter = "dim_customers.is_test_account = false"), expect: ["error", ORDERS, "measures[0].filter", "dim_customers.is_test_account names a table or schema directly"] },
  { name: "model's own name as a qualifier", file: ORDERS, edit: (d) => (d.measures[0].filter = "orders.status <> 'cancelled'"), expect: ["error", ORDERS, "measures[0].filter", "orders.status names a table or schema directly"] },
  {
    name: "dots inside literals, comments, casts and function calls are not references",
    file: ORDERS,
    edit: (d) => (d.dimensions[1].expr = "case when status = 'a.b' then pg_catalog.lower(status) /* x.y */ else status::text end -- p.q"),
    expect: [],
  },
  { name: "select inside a string literal is not a subquery", file: ORDERS, edit: (d) => (d.measures[0].filter = "status <> 'select'"), expect: [] },
  { name: "struct field on an own column", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = "event_type.kind"), expect: [] },
  { name: "lambda parameter fields are not references", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = "list_filter(event_type, x -> x.kind = 'a')"), expect: [] },
  { name: "two-parameter lambda fields are not references", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = "list_transform(event_type, (x, i) -> x.a + i)"), expect: [] },
  { name: "lambda keyword parameter fields are not references", file: "models/lake/web_events.yaml", edit: (d) => (d.dimensions[1].expr = "list_filter(event_type, lambda x: x.kind = 'a')"), expect: [] },
  {
    name: "a qualifier that is not a lambda parameter still errors next to a lambda",
    file: "models/lake/web_events.yaml",
    edit: (d) => (d.dimensions[1].expr = "list_filter(event_type, x -> y.kind = 'a')"),
    expect: ["error", "models/lake/web_events.yaml", "dimensions[1].expr", '"y" is neither a column nor a join of model web_events'],
  },
  { name: "unquoted join name in another case", file: ORDERS, edit: (d) => (d.dimensions[3].expr = "Customer.region"), expect: [] },
  { name: "quoted join name in another case", file: ORDERS, edit: (d) => (d.dimensions[3].expr = '"Customer".region'), expect: ["error", ORDERS, "dimensions[3].expr", '"Customer" is neither a column nor a join of model orders'] },
  {
    name: "quoted join reference column in another case on a live postgres snapshot",
    file: ORDERS,
    edit: (d) => (d.dimensions[3].expr = 'customer."REGION"'),
    expect: ["error", ORDERS, "dimensions[3].expr", 'customer.REGION: "REGION" is not a column of public.dim_customers, the table of model customers that join customer reaches; quoted names are case-sensitive, write \"region\"'],
  },
  {
    name: "quoted join reference column in another case on a DDL snapshot",
    file: "",
    setup: (r) => {
      mutate(r, SNAP_WH, (d) => (d.method = "ddl"));
      mutate(r, ORDERS, (d) => (d.dimensions[3].expr = 'customer."REGION"'));
    },
    expect: [],
  },
  {
    name: "a reference after an escape string is still read",
    file: ORDERS,
    edit: (d) => (d.measures[0].filter = "status <> E'it\\'s' and orders.status = 'x'"),
    expect: ["error", ORDERS, "measures[0].filter", "orders.status names a table or schema directly"],
  },
  { name: "FROM-first subquery", file: ORDERS, edit: (d) => (d.measures[0].filter = "customer_id in (from customers_tmp select customer_id)"), expect: ["error", ORDERS, "measures[0].filter", "has a subquery"] },
  { name: "FROM-first subquery without select", file: ORDERS, edit: (d) => (d.measures[0].filter = "customer_id in (from customers_tmp)"), expect: ["error", ORDERS, "measures[0].filter", "has a subquery"] },
  { name: "TABLE subquery", file: ORDERS, edit: (d) => (d.measures[0].filter = "customer_id in (table customers_tmp)"), expect: ["error", ORDERS, "measures[0].filter", "has a subquery"] },
  { name: "trim(from x) is not a subquery", file: ORDERS, edit: (d) => (d.dimensions[1].expr = "trim(from status)"), expect: [] },
  {
    name: "table name in a measure expr gets the measure expr hint",
    file: ORDERS,
    edit: (d) => (d.measures[0].expr = "dim_customers.is_test_account::int"),
    expect: ["error", ORDERS, "measures[0].expr", "a measure expr may name only this model's columns; put a joined column in the measure's filter or in a dimension, or ask the owner for a view"],
  },
  {
    name: "join reference in a row filter",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "customer.region = {{ user.region }}"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", "a row filter is over its model's own columns"],
  },
  {
    name: "subquery in a row filter",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "customer_id in (select customer_id from public.dim_customers where region = {{ user.region }})"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", "has a subquery; a row filter may name only its model's columns; write a row filter on the joined model, or ask the owner for a view"],
  },
  {
    name: "table name in a row filter gets the row filter hint",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "dim_customers.region = {{ user.region }}"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", "dim_customers.region names a table or schema directly; a row filter may name only its model's columns; write a row filter on the joined model, or ask the owner for a view"],
  },
  { name: "row filter on a joined model's own columns", file: ACCESS, edit: (d) => d.roles[1].row_filters.push({ model: "warehouse.customers", expr: "region = {{ user.region }}" }), expect: [] },

  // Request fields on other models
  { name: "golden dimension on an unreachable model", file: GOLDEN3, edit: (d) => ((d.request.measures = ["customers.customer_count"]), (d.request.dimensions = ["orders.status"])), expect: ["error", GOLDEN3, "request.dimensions[0]", "model orders is not reachable from customers"] },
  {
    name: "golden dimension reached by two join paths",
    file: ORDERS,
    edit: (d) => d.joins.push({ name: "buyer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one", status: "draft" }),
    expect: ["error", GOLDEN3, "request.dimensions[0]", "more than one shortest join path (orders.customer; orders.buyer)"],
  },
  { name: "golden dimension two hops away", file: "", setup: (r) => (addRegions(r), mutate(r, GOLDEN3, (d) => (d.request.dimensions = ["regions.region_name"]))), expect: [] },
  {
    name: "a direct join wins over a two-hop route to the same model",
    file: "",
    setup: (r) => (
      addRegions(r),
      mutate(r, ORDERS, (d) => d.joins.push({ name: "shipped_to", to: "regions", keys: [{ from: "ship_region", to: "region" }], relationship: "many_to_one", status: "draft" })),
      mutate(r, GOLDEN3, (d) => (d.request.dimensions = ["regions.region_name"]))
    ),
    expect: [],
  },
  {
    name: "golden dimension three hops away",
    file: "",
    setup: (r) => {
      addRegions(r);
      addShipments(r);
      mutate(r, GOLDEN3, (d) => ((d.request.measures = ["shipments.shipment_count"]), (d.request.dimensions = ["regions.region_name"])));
    },
    expect: ["error", GOLDEN3, "request.dimensions[0]", "model regions is not reachable from shipments"],
  },
  {
    name: "golden dimension two hops from a model with a join reference",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, GOLDEN3, (d) => ((d.request.measures = ["shipments.shipment_count"]), (d.request.dimensions = ["customers.region", "shipments.order_date:month"])));
    },
    expect: [],
  },
  {
    name: "golden filter on another model's dimension",
    file: GOLDEN3,
    edit: (d) => ((d.request.measures = ["customers.customer_count"]), (d.request.dimensions = []), (d.request.filters = [{ field: "orders.status", op: "eq", value: "shipped" }])),
    expect: ["error", GOLDEN3, "request.filters[0].field", "model orders is not reachable from customers"],
  },
  {
    name: "golden filter on another model's measure",
    file: GOLDEN3,
    edit: (d) => ((d.request.measures = ["customers.customer_count"]), (d.request.dimensions = []), (d.request.filters = [{ field: "orders.order_count", op: "gt", value: 1 }])),
    expect: ["error", GOLDEN3, "request.filters[0].field", "model orders is not reachable from customers, the model of the request's first measure,"],
  },
  { name: "golden filter on a reachable model's measure", file: GOLDEN3, edit: (d) => (d.request.filters = [{ field: "customers.customer_count", op: "gt", value: 1 }]), expect: [] },
  {
    name: "golden with no measures names its first dimension as the base",
    file: GOLDEN3,
    edit: (d) => ((d.request.measures = []), (d.request.dimensions = ["customers.region", "orders.status"])),
    expect: ["error", GOLDEN3, "request.dimensions[1]", "model orders is not reachable from customers, the model of the request's first dimension, as it has no measures,"],
  },
  { name: "golden with no measures starts from its first dimension", file: GOLDEN3, edit: (d) => ((d.request.measures = []), (d.request.dimensions = ["orders.status", "customers.region"])), expect: [] },

  // Metrics across models
  {
    name: "metric across models grouped by a dimension one model lacks",
    file: GOLDEN3,
    edit: (d) => (d.request.measures = ["revenue_per_customer"]),
    expect: ["error", GOLDEN3, "request.dimensions[0]", 'metric revenue_per_customer combines measures of orders, customers, so it groups by dimensions that exist with the same name in each; orders has no dimension "region"'],
  },
  {
    name: "metric across models grouped by a dimension both models carry",
    file: "",
    setup: (r) => {
      mutate(r, ORDERS, (d) => (d.dimensions[3].name = "region"));
      mutate(r, GOLDEN3, (d) => (d.request.measures = ["revenue_per_customer"]));
    },
    expect: [],
  },

  // deny.fields and joins
  {
    name: "deny field naming a join",
    file: ACCESS,
    edit: (d) => d.roles[1].deny.fields.push("warehouse.orders.customer"),
    expect: ["error", ACCESS, "roles[1].deny.fields[1]", '"warehouse.orders.customer" is a join; deny.fields names dimensions and measures only; a join is hidden from a role when its target model is not allowed or is denied for that role, so deny warehouse.customers to hide it'],
  },

  // Goldens before access, and approved goldens over draft fields
  {
    name: "golden role and user before access.yaml exists",
    file: "",
    setup: (r) => rmSync(join(r, ACCESS)),
    expect: [
      ["warning", GOLDEN, "role", 'names role "analyst" but there is no access.yaml yet'],
      ["warning", GOLDEN2, "role", 'names role "sales_rep" but there is no access.yaml yet'],
      ["warning", GOLDEN2, "user.region", "there is no access.yaml yet"],
    ],
  },
  {
    name: "approved golden uses a draft dimension",
    file: GOLDEN,
    edit: (d) => d.request.filters.push({ field: "customers.region", op: "eq", value: "west" }),
    expect: ["warning", GOLDEN, "request.filters[2].field", "an approved golden uses draft dimension customers.region"],
  },
  {
    name: "approved golden uses a draft metric",
    file: "",
    setup: (r) => {
      mutate(r, "metrics.yaml", (d) => ((d.metrics[0].status = "draft"), delete d.metrics[0].approved_by, delete d.metrics[0].approved_at));
      mutate(r, GOLDEN, (d) => (d.request.measures = ["average_order_value"]));
    },
    expect: ["warning", GOLDEN, "request.measures[0]", "an approved golden uses draft metric average_order_value"],
  },
  { name: "draft golden over draft fields", file: GOLDEN2, edit: (d) => d.request.dimensions.push("orders.status"), expect: [] },
  { name: "draft field named twice warns once", file: GOLDEN, edit: (d) => ((d.request.dimensions = ["orders.status"]), (d.request.order_by = [{ field: "orders.status" }])), expect: ["warning", GOLDEN, "request.dimensions[0]", "draft dimension orders.status"] },

  // Access open questions
  {
    name: "access open questions",
    file: ACCESS,
    edit: (d) => ((d.open_questions = ["Who may see refunds?"]), (d.roles[1].open_questions = ["Do reps see other regions' totals?"])),
    expect: [],
  },
  { name: "access open questions must be strings", file: ACCESS, edit: (d) => (d.roles[0].open_questions = [3]), expect: ["error", ACCESS, "roles[0].open_questions[0]", "must be string"] },

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
      ["warning", GOLDEN3, "request.dimensions[0]", 'model customers has no dimension "region"'],
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

  // Two-hop join references
  { name: "two-hop join reference in a dimension expr", file: "", setup: (r) => (addShipments(r), mutate(r, SHIPMENTS, (d) => d.dimensions.push({ name: "customer_region", expr: "order.customer.region", type: "string", status: "draft" }))), expect: [] },
  {
    name: "two-hop join reference in a measure filter",
    file: "",
    setup: (r) => (addShipments(r), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "coalesce(order.customer.is_test_account, false) = false and order.status <> 'cancelled'"))),
    expect: [],
  },
  {
    name: "two-hop join reference to a missing column",
    file: "",
    setup: (r) => (addShipments(r), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.customer.home_region = 'x'"))),
    expect: ["error", SHIPMENTS, "measures[0].filter", 'order.customer.home_region: "home_region" is not a column of public.dim_customers, the table of model customers that join customer of model orders reaches'],
  },
  {
    name: "two-hop join reference through a name that is neither a column nor a join",
    file: "",
    setup: (r) => (addShipments(r), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.buyer.region = 'x'"))),
    expect: ["error", SHIPMENTS, "measures[0].filter", '"buyer" is not a column of public.fct_orders, the table of model orders that join order reaches, nor a join of model orders'],
  },
  {
    name: "two-hop join reference whose second join is one_to_many",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, ORDERS, (d) => d.joins.push({ name: "shipments", to: "shipments", keys: [{ from: "order_id", to: "order_id" }], relationship: "one_to_many", status: "draft" }));
      mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.shipments.shipment_id is not null"));
    },
    expect: [
      ["warning", ORDERS, "joins[1].relationship", "fans out"],
      ["error", SHIPMENTS, "measures[0].filter", "order.shipments.shipment_id goes through join shipments of model orders, which is one_to_many"],
    ],
  },
  {
    name: "join reference of three hops",
    file: "",
    setup: (r) => (addRegions(r), addShipments(r), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.customer.home_region.region_name = 'West'"))),
    expect: ["error", SHIPMENTS, "measures[0].filter", "order.customer.home_region.region_name goes more than two hops"],
  },
  { name: "two-hop join reference ending in a struct field", file: "", setup: (r) => (addShipments(r), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.customer.region.code = 'x'"))), expect: [] },
  {
    name: "two-hop join reference when the last table is not in the snapshot",
    file: "",
    setup: (r) => (addShipments(r), mutate(r, CUSTOMERS, (d) => (d.table = "public.dim_customer")), mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.customer.anything = 1"))),
    expect: ["warning", CUSTOMERS, "table", "not in snapshots/warehouse.json"],
  },

  // A join reference reads a column, not a same-named dimension of the target
  {
    name: "join reference to a column that a target dimension redefines",
    file: CUSTOMERS,
    edit: (d) => (d.dimensions[2].expr = "is_test_account or email like '%@example-test.com'"),
    expect: [
      "warning",
      ORDERS,
      "measures[0].filter",
      "customer.is_test_account reads the column is_test_account of public.dim_customers, not dimension is_test_account of model customers (expr: is_test_account or email like '%@example-test.com')",
    ],
  },
  { name: "join reference to a column that a target dimension quotes", file: CUSTOMERS, edit: (d) => (d.dimensions[2].expr = ' "is_test_account" '), expect: [] },
  {
    name: "two-hop join reference to a column that a target dimension redefines",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, CUSTOMERS, (d) => (d.dimensions[1].expr = "upper(region)"));
      mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "order.customer.region = 'WEST'"));
    },
    expect: [
      ["warning", ORDERS, "dimensions[3].expr", "customer.region reads the column region of public.dim_customers, not dimension region of model customers (expr: upper(region))"],
      ["warning", SHIPMENTS, "measures[0].filter", "order.customer.region reads the column region of public.dim_customers, not dimension region of model customers"],
    ],
  },

  // Definition joins and what a role may see
  {
    name: "a role allowed a dimension that reads through a join to a model it is not allowed",
    file: ACCESS,
    edit: (d) => d.roles.push({ name: "marketing", allow: { models: ["warehouse.orders"] } }),
    expect: [
      "warning",
      ACCESS,
      "roles[2]",
      "may see dimension warehouse.orders.customer_region, whose expr reads customer.region through join customer to model warehouse.customers, which the role is not allowed; the dimension would show the values of warehouse.customers to this role",
    ],
  },
  {
    name: "a role that denies the joined model",
    file: ACCESS,
    edit: (d) => (d.roles[1].deny.models = ["warehouse.customers"]),
    expect: ["warning", ACCESS, "roles[1]", "to model warehouse.customers, which the role denies;"],
  },
  {
    name: "a role that denies the joined model by tag",
    file: "",
    setup: (r) => mutate(r, CUSTOMERS, (d) => (d.tags = ["pii"])),
    expect: ["warning", ACCESS, "roles[0]", "to model warehouse.customers, which the role denies by tag;"],
  },
  { name: "a role that denies the dimension itself", file: ACCESS, edit: (d) => d.roles.push({ name: "marketing", allow: { models: ["warehouse.orders"] }, deny: { fields: ["warehouse.orders.customer_region"] } }), expect: [] },
  { name: "a role that cannot see the dimension's own model", file: ACCESS, edit: (d) => d.roles.push({ name: "finance", allow: { models: ["warehouse.customers"] } }), expect: [] },
  {
    name: "a measure filter through a join the role cannot see does not warn",
    file: "",
    setup: (r) => {
      mutate(r, ORDERS, (d) => d.dimensions.splice(3, 1));
      mutate(r, ACCESS, (d) => d.roles.push({ name: "marketing", allow: { models: ["warehouse.orders"] } }));
    },
    expect: [],
  },
  {
    name: "a two-hop dimension through a model the role cannot see",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, SHIPMENTS, (d) => d.dimensions.push({ name: "customer_region", expr: "order.customer.region", type: "string", status: "draft" }));
      mutate(r, ACCESS, (d) => d.roles.push({ name: "ops", allow: { models: ["warehouse.shipments", "warehouse.orders"] }, deny: { fields: ["warehouse.orders.customer_region"] } }));
    },
    expect: ["warning", ACCESS, "roles[2]", "may see dimension warehouse.shipments.customer_region, whose expr reads order.customer.region through joins order.customer to model warehouse.customers, which the role is not allowed"],
  },
  {
    name: "a two-hop dimension through a middle model the role cannot see",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, SHIPMENTS, (d) => d.dimensions.push({ name: "customer_region", expr: "order.customer.region", type: "string", status: "draft" }));
      mutate(r, ACCESS, (d) => d.roles.push({ name: "ops", allow: { models: ["warehouse.shipments", "warehouse.customers"] }, deny: { fields: ["warehouse.shipments.order_date"] } }));
    },
    expect: [
      "warning",
      ACCESS,
      "roles[2]",
      "may see dimension warehouse.shipments.customer_region, whose expr reads order.customer.region through join order to model warehouse.orders, which the role is not allowed; the dimension would show the values of warehouse.orders to this role",
    ],
  },
  {
    name: "a two-hop dimension through two models the role cannot see warns for each",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, SHIPMENTS, (d) => d.dimensions.push({ name: "customer_region", expr: "order.customer.region", type: "string", status: "draft" }));
      mutate(r, ACCESS, (d) => d.roles.push({ name: "ops", allow: { models: ["warehouse.shipments"] }, deny: { fields: ["warehouse.shipments.order_date"] } }));
    },
    expect: [
      ["warning", ACCESS, "roles[2]", "warehouse.shipments.customer_region, whose expr reads order.customer.region through join order to model warehouse.orders, which the role is not allowed"],
      ["warning", ACCESS, "roles[2]", "warehouse.shipments.customer_region, whose expr reads order.customer.region through joins order.customer to model warehouse.customers, which the role is not allowed"],
    ],
  },

  // Credentials in a source file
  ...(
    [
      ["setup", (d: Doc) => (d.connection.setup = ["SET threads=2", "SET s3_secret_access_key='wJalrXUtnFEMI'"]), "connection.setup[1]", "secret provider"],
      ["views", (d: Doc) => (d.connection.views.web_events = "read_parquet('https://a.blob.core.windows.net/c/x.parquet?sv=1&sig=abcSECRET')"), "connection.views.web_events", "secret provider"],
      ["database", (d: Doc) => (d.connection.database = "md:analytics?motherduck_token=eyJsecret"), "connection.database", "MOTHERDUCK_TOKEN"],
      ["database url", (d: Doc) => (d.connection.database = "postgres://admin:hunter2@db/prod"), "connection.database", "environment variable"],
    ] as [string, (d: Doc) => void, string, string][]
  ).map(
    ([what, edit, path, hint]): Case => ({
      name: `credential in a duckdb source's ${what}`,
      file: "sources/lake.yaml",
      edit,
      expect: ["error", "sources/lake.yaml", path, `contains a credential; credentials never go in source files, so`],
      hint,
    }),
  ),
  {
    name: "credential in a source file that fails its schema",
    file: "sources/lake.yaml",
    edit: (d) => ((d.connection.setup = ["CREATE SECRET (TYPE s3, KEY_ID 'AKIA123', SECRET 'abcSECRET')"]), (d.owner = "x")),
    expect: [
      ["error", "sources/lake.yaml", "owner", "not a known property"],
      ["error", "sources/lake.yaml", "connection.setup[0]", "contains a credential"],
    ],
  },
  {
    name: "credential in a duckdb source's setup written as one string",
    file: "sources/lake.yaml",
    edit: (d) => (d.connection.setup = "SET s3_secret_access_key='wJalrXUtnFEMI'"),
    expect: [
      ["error", "sources/lake.yaml", "connection.setup", "must be array"],
      ["error", "sources/lake.yaml", "connection.setup", "contains a credential; credentials never go in source files, so"],
    ],
  },
  { name: "secret provider settings in a duckdb source", file: "sources/lake.yaml", edit: (d) => (d.connection.setup = ["SET secret_directory='/tmp/s'", "CREATE SECRET (TYPE s3, PROVIDER credential_chain)"]), expect: [] },

  // Join evidence measured for other keys or another target
  { name: "evidence keys in another order and case", file: ORDERS, edit: (d) => (d.joins[0].evidence.keys = [{ from: "CUSTOMER_ID", to: "customer_id" }]), expect: [] },
  {
    name: "evidence measured on other keys",
    file: ORDERS,
    edit: (d) => (d.joins[0].keys = [{ from: "order_id", to: "customer_id" }]),
    expect: ["warning", ORDERS, "joins[0].evidence.keys", "the evidence was measured on keys customer_id = customer_id, but the join's keys are now order_id = customer_id; run `sl check-join` again"],
  },
  {
    name: "evidence measured for another target",
    file: ORDERS,
    edit: (d) => (d.joins[0].evidence.to = "clients"),
    expect: ["warning", ORDERS, "joins[0].evidence.to", "measured for a join to clients, but the join now goes to customers"],
  },
  { name: "evidence without keys or to predates them", file: ORDERS, edit: (d) => (delete d.joins[0].evidence.keys, delete d.joins[0].evidence.to, (d.joins[0].keys[0].to = "CUSTOMER_ID")), expect: [] },
  {
    name: "renaming a join keeps its evidence",
    file: "",
    setup: (r) => {
      mutate(r, ORDERS, (d) => {
        d.joins[0].name = "buyer";
        d.dimensions[3].expr = "buyer.region";
        d.measures[0].filter = "status <> 'cancelled' and coalesce(buyer.is_test_account, false) = false";
      });
    },
    expect: [],
  },
  { name: "evidence keys that are not key pairs", file: ORDERS, edit: (d) => (d.joins[0].evidence.keys = [{ from: "customer_id" }]), expect: ["error", ORDERS, "joins[0].evidence.keys[0].to", "is required"] },

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
      if (c.hint) for (const i of issues) expect(i.message).toContain(c.hint);
      // A value that holds a secret is never echoed.
      for (const secret of ["wJalrXUtnFEMI", "abcSECRET", "eyJsecret", "hunter2", "AKIA123"]) expect(JSON.stringify(issues)).not.toContain(secret);
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

describe("sqlNames", () => {
  test("reads dotted names outside literals, comments and placeholders", () => {
    expect(sqlNames("coalesce(customer.is_test_account, false) = false and 'x.y' <> \"t\".\"c\" -- a.b\n /* c.d */ {{ user.region }}")).toEqual({
      subquery: false,
      chains: [
        { parts: ["customer", "is_test_account"], quoted: [false, false], text: "customer.is_test_account" },
        { parts: ["t", "c"], quoted: [true, true], text: "t.c" },
      ],
    });
  });

  test("skips function calls, casts, numbers and semi-structured paths", () => {
    expect(sqlNames("pg_catalog.lower(x)::pg_catalog.text + 1.5e3 + payload:customer.id + $$a.b$$").chains).toEqual([]);
  });

  test("splits a backtick path and finds select in any case", () => {
    expect(sqlNames("x in (SeLeCt id from `proj.ds.tbl`)")).toEqual({
      subquery: true,
      chains: [{ parts: ["proj", "ds", "tbl"], quoted: [true, true, true], text: "proj.ds.tbl" }],
    });
    expect(sqlNames("'select'").subquery).toBe(false);
  });

  test("skips the fields of lambda parameters", () => {
    expect(sqlNames("list_filter(a, x -> x.k = 1) + transform(b, (y, i) -> y.k) + list_apply(c, lambda z, w: z.k) + q.k").chains.map((c) => c.text)).toEqual(["q.k"]);
    expect(sqlNames("customer.payload -> 'k' = payload.k").chains.map((c) => c.text)).toEqual(["customer.payload", "payload.k"]);
  });

  test("reads strings the way the dialect does", () => {
    expect(sqlNames("E'it\\'s' || t.c").chains.map((c) => c.text)).toEqual(["t.c"]);
    expect(sqlNames("'it\\'s' || t.c", "snowflake").chains.map((c) => c.text)).toEqual(["t.c"]);
    expect(sqlNames("'a\\\\' || t.c", "databricks").chains.map((c) => c.text)).toEqual(["t.c"]);
    expect(sqlNames('"a" = t.c and "select"', "bigquery")).toEqual({ subquery: false, chains: [{ parts: ["t", "c"], quoted: [false, false], text: "t.c" }] });
    expect(sqlNames("x in (from t) or y in (TABLE u)").subquery).toBe(true);
    expect(sqlNames("trim(from x)").subquery).toBe(false);
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
      const flagged = validateProject(root).some((i) => i.level === "error" && i.path === "dimensions[4].expr");
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callsRound,
  carriesZone,
  dividesByLiteral,
  type Issue,
  type SchemaKind,
  schemaIssues,
  sqlNames,
  validateProject,
} from "../skills/semantic-layer/scripts/lib/validate.ts";
import { conditionAttributes, parseCondition } from "../skills/semantic-layer/scripts/lib/conditions.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, recordReply, sl } from "./helpers.ts";

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

// The issues without those about approval hashes: the case tables edit approved items and write
// approved items by hand, and the approval-hash tests cover those issues on their own.
const withoutApprovalHashes = (issues: Issue[]) =>
  issues.filter(
    (i) =>
      !i.message.includes("changed since it was approved") &&
      !i.message.includes("approved before content hashes") &&
      !i.message.includes("approved_hash is missing while other approved items carry one") &&
      !i.message.includes("no recorded owner yes in .sl/ledger.jsonl"),
  );

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
// The fixture's goldens, each of whose SQL applies orders.revenue's rule.
const GOLDEN_FILES_ORDERED = [GOLDEN, GOLDEN2, GOLDEN3];
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
      // The metric now spans orders and customers, so it and orders.order_count no longer share one model.
      ["error", GOLDEN2, "request.measures[1]", "a request's measures must share one model, or be one metric"],
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
      ["error", "access.yaml", "restrictions[0].allow.roles[1]", 'names unknown role "sales_rep"'],
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
  { name: "join reference in a row filter", file: ACCESS, edit: (d) => (d.roles[1].row_filters[0].expr = "customer.region = {{ user.region }}"), expect: [] },
  {
    name: "a row filter's join reference through an unknown join",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "buyer.region = {{ user.region }}"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", 'buyer.region: "buyer" is neither a column nor a join of model orders'],
  },
  {
    name: "a row filter's join reference to a column the target lacks",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "customer.territory = {{ user.region }}"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", '"territory" is not a column of public.dim_customers'],
  },
  {
    name: "subquery in a row filter",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "customer_id in (select customer_id from public.dim_customers where region = {{ user.region }})"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", "has a subquery; a row filter may name only its model's columns and <join>.<column> or <join>.<join>.<column> join references through many_to_one or one_to_one joins; for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it"],
  },
  {
    name: "table name in a row filter gets the row filter hint",
    file: ACCESS,
    edit: (d) => (d.roles[1].row_filters[0].expr = "dim_customers.region = {{ user.region }}"),
    expect: ["error", ACCESS, "roles[1].row_filters[0].expr", "dim_customers.region names a table or schema directly; a row filter may name only its model's columns and <join>.<column> or <join>.<join>.<column> join references through many_to_one or one_to_one joins; for a rule that needs anything else, add a join to the model or ask the owner for a view that holds it"],
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
  { name: "metric across models grouped by a dimension the other model reaches through a join", file: GOLDEN3, edit: (d) => (d.request.measures = ["revenue_per_customer"]), expect: [] },
  {
    name: "metric across models grouped by a dimension one model neither has nor reaches",
    file: GOLDEN3,
    edit: (d) => ((d.request.measures = ["revenue_per_customer"]), (d.request.dimensions = ["orders.status"])),
    expect: [
      "error",
      GOLDEN3,
      "request.dimensions[0]",
      'metric revenue_per_customer combines measures of orders, customers, so it groups by dimensions that exist with the same name in each, or that each reaches through one path of to-one joins; customers has no dimension "status" and no such path to orders',
    ],
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

  {
    name: "a field that writes a redefining dimension's whole rule out through the same join",
    file: "",
    setup: (r) => {
      mutate(r, CUSTOMERS, (d) => (d.dimensions[2].expr = "is_test_account or email like '%@example-test.com'"));
      mutate(r, ORDERS, (d) => (d.measures[0].filter = "status <> 'cancelled' and not coalesce(customer.is_test_account or customer.email like '%@example-test.com', false)"));
    },
    // revenue's filter now reads customer.email, which no golden's hand-written SQL names.
    expect: GOLDEN_FILES_ORDERED.map((g): Expected => ["warning", g, "cross_check_sql", "this hand-written SQL may not apply orders.revenue's rule: it never names email"]),
  },
  {
    name: "a field that writes only part of a redefining dimension's rule out keeps the warning",
    file: "",
    setup: (r) => {
      mutate(r, CUSTOMERS, (d) => (d.dimensions[2].expr = "is_test_account or email like '%@example-test.com' or region = 'internal'"));
      mutate(r, ORDERS, (d) => (d.measures[0].filter = "not coalesce(customer.is_test_account or customer.email like '%@example-test.com', false)"));
    },
    expect: [
      ["warning", ORDERS, "measures[0].filter", "customer.is_test_account reads the column is_test_account of public.dim_customers, not dimension is_test_account"],
      ...GOLDEN_FILES_ORDERED.map((g): Expected => ["warning", g, "cross_check_sql", "this hand-written SQL may not apply orders.revenue's rule: it never names email"]),
    ],
  },
  {
    name: "a redefining dimension's rule written out through two hops; the one-hop field that reads only the column keeps the warning",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, CUSTOMERS, (d) => (d.dimensions[2].expr = "is_test_account or email like '%@example-test.com'"));
      mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "not coalesce(order.customer.is_test_account or order.customer.email like '%@example-test.com', false)"));
    },
    expect: ["warning", ORDERS, "measures[0].filter", "customer.is_test_account reads the column is_test_account"],
  },
  {
    name: "the other columns written through another join chain do not count",
    file: "",
    setup: (r) => {
      addShipments(r);
      mutate(r, CUSTOMERS, (d) => (d.dimensions[2].expr = "is_test_account or email like '%@example-test.com'"));
      mutate(r, ORDERS, (d) => (d.measures[0].filter = "not coalesce(customer.is_test_account or customer.email like '%@example-test.com', false)"));
      mutate(r, SHIPMENTS, (d) => (d.measures[0].filter = "not coalesce(order.customer.is_test_account, false) and order.status <> 'x'"));
    },
    expect: [
      ["warning", SHIPMENTS, "measures[0].filter", "order.customer.is_test_account reads the column is_test_account"],
      ...GOLDEN_FILES_ORDERED.map((g): Expected => ["warning", g, "cross_check_sql", "this hand-written SQL may not apply orders.revenue's rule: it never names email"]),
    ],
  },

  // Exact amounts on duckdb and goldens that apply a measure exactly
  {
    name: "a duckdb measure expr that divides by a numeric literal",
    file: "models/lake/web_events.yaml",
    edit: (d) => d.measures.push({ name: "amount", expr: "event_id / 100.0", agg: "sum", status: "draft" }),
    expect: ["warning", "models/lake/web_events.yaml", "measures[2].expr", 'divides by a numeric literal; on duckdb "/ 100.0" gives a DOUBLE, so write <col> * 0.01 for an exact amount; this warning never stands'],
  },
  {
    name: "a duckdb measure expr that divides by an integer literal",
    file: "models/lake/web_events.yaml",
    edit: (d) => d.measures.push({ name: "amount", expr: "event_id / 100", agg: "sum", status: "draft" }),
    expect: ["warning", "models/lake/web_events.yaml", "measures[2].expr", "divides by a numeric literal"],
  },
  {
    name: "a duckdb measure expr written as an exact amount or by integer division",
    file: "models/lake/web_events.yaml",
    edit: (d) =>
      d.measures.push(
        { name: "amount", expr: "event_id * 0.01", agg: "sum", status: "draft" },
        { name: "hundreds", expr: "event_id // 100", agg: "sum", status: "draft" },
        { name: "ratio", expr: "event_id / session_id", agg: "sum", status: "draft" },
      ),
    expect: [],
  },
  {
    name: "a duckdb measure expr that divides by a cast, parenthesized or negative literal",
    file: "models/lake/web_events.yaml",
    edit: (d) =>
      d.measures.push(
        { name: "cast_amount", expr: "event_id / 100::decimal(18, 2)", agg: "sum", status: "draft" },
        { name: "paren_amount", expr: "event_id / (100.0)", agg: "sum", status: "draft" },
        { name: "negative_amount", expr: "event_id / -100", agg: "sum", status: "draft" },
      ),
    expect: [
      ["warning", "models/lake/web_events.yaml", "measures[2].expr", "divides by a numeric literal"],
      ["warning", "models/lake/web_events.yaml", "measures[3].expr", "divides by a numeric literal"],
      ["warning", "models/lake/web_events.yaml", "measures[4].expr", "divides by a numeric literal"],
    ],
  },
  { name: "a postgres measure expr may divide by a numeric literal", file: ORDERS, edit: (d) => (d.measures[0].expr = "amount_cents / 100"), expect: [] },
  {
    name: "a golden's sql that calls round()",
    file: GOLDEN,
    edit: (d) => (d.cross_check_sql = "select round(sum(o.amount_cents / 100.0) filter (where o.status <> 'cancelled' and not c.is_test_account), 2) as revenue from public.fct_orders o"),
    expect: [
      "warning",
      GOLDEN,
      "cross_check_sql",
      "calls round(); a golden's SQL applies the measure exactly as written; round() hides float noise, so remove it. This warning never stands, whatever the golden's reference says; " +
        "once round() is removed, sl goldens check --name revenue_by_month_2025 fails on rows recorded rounded until the owner says yes to the unrounded figure and it is confirmed again",
    ],
  },
  {
    name: "round in a golden's string literal or comment",
    file: GOLDEN,
    edit: (d) => (d.cross_check_sql = "select 'round(x)' as label, sum(amount_cents) filter (where status <> 'x' and not is_test_account) -- round(y)\nfrom public.fct_orders"),
    expect: [],
  },
  {
    name: "an approved golden using a draft field says how to keep its rows",
    file: "",
    setup: (r) =>
      mutate(r, ORDERS, (d) => {
        d.measures[0].status = "draft";
        delete d.measures[0].approved_by;
        delete d.measures[0].approved_at;
      }),
    expect: [
      ["error", "metrics.yaml", "metrics[0].numerator", "only approved measures"],
      [
        "warning",
        GOLDEN,
        "request.measures[0]",
        "an approved golden uses draft measure orders.revenue; approve it after its readback, then run sl goldens check --name revenue_by_month_2025; " +
          "if it passes the recorded rows stand, and only changed rows need a new confirm",
      ],
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
    expect: [
      ["warning", ACCESS, "roles[0]", "to model warehouse.customers, which the role denies by tag;"],
      // pii is protected: sales_rep, which does not grant it, does not see customers either.
      ["warning", ACCESS, "roles[1]", "which the role does not see, since it carries the protected tag pii; the dimension would show the values of warehouse.customers to this role, so grant pii in the role's allow.tags"],
      ["warning", GOLDEN3, "request.dimensions[0]", "names customers.region, which the default role analyst may not see (denied:analyst, protected_tag:pii, model_hidden); a golden with no role runs as the default role"],
    ],
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
    name: "credential in a duckdb source's setup",
    file: "sources/lake.yaml",
    edit: (d) => (d.connection.setup = ["SET threads=2", "SET s3_secret_access_key='wJalrXUtnFEMI'"]),
    expect: [
      ["error", "sources/lake.yaml", "connection.setup[1]", "contains a credential; credentials never go in source files, so"],
      // The statement is also outside the setup allowlist (lib/source-safety.ts).
      ["error", "sources/lake.yaml", "connection.setup[1]", "is not an allowed setup statement: "],
    ],
  },
  {
    name: "credential in a source file that fails its schema",
    file: "sources/lake.yaml",
    edit: (d) => ((d.connection.setup = ["CREATE SECRET (TYPE s3, KEY_ID 'AKIA123', SECRET 'abcSECRET')"]), (d.owner = "x")),
    expect: [
      ["error", "sources/lake.yaml", "owner", "not a known property"],
      ["error", "sources/lake.yaml", "connection.setup[0]", "contains a credential"],
      // The statement is also outside the setup allowlist (lib/source-safety.ts).
      ["error", "sources/lake.yaml", "connection.setup[0]", "is not an allowed setup statement: "],
    ],
  },
  {
    name: "credential in a duckdb source's setup written as one string",
    file: "sources/lake.yaml",
    edit: (d) => (d.connection.setup = "SET s3_secret_access_key='wJalrXUtnFEMI'"),
    expect: [
      ["error", "sources/lake.yaml", "connection.setup", "must be array"],
      ["error", "sources/lake.yaml", "connection.setup", "contains a credential; credentials never go in source files, so"],
      // The statement is also outside the setup allowlist (lib/source-safety.ts).
      ["error", "sources/lake.yaml", "connection.setup", "is not an allowed setup statement: "],
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

// ---------------------------------------------------------------------------
// Access modes, conditions, restrictions, hierarchy filters, ignored columns and sensitivity.

const APPROVED = { status: "approved", approved_by: "Dana Ruiz", approved_at: "2026-01-15" };
const GOLDEN_FILES = [GOLDEN, GOLDEN2, GOLDEN3];

// Leaves role and user out of every golden, so access.yaml can drop the fixture's roles.
function noGoldenRoles(root: string): void {
  for (const g of GOLDEN_FILES)
    mutate(root, g, (d) => {
      delete d.role;
      delete d.user;
    });
}

// Adds a column to the fct_orders snapshot table.
function addOrdersColumn(root: string, column: Doc): void {
  mutate(root, SNAP_WH, (d) => d.tables.find((t: Doc) => t.name === "fct_orders").columns.push({ nullable: true, description: null, ...column }));
}

// Adds a reporting_lines closure model to the warehouse, one row per manager and member pair.
function addReportingLines(root: string): void {
  addModel(root, "reporting_lines", "reporting_lines", ["manager_id", "member_id"], {});
}

const HIERARCHY = { column: "customer_id", via: "warehouse.reporting_lines", manager: "manager_id", member: "member_id", user: "user.employee_id" };

// Adds a manager role whose row filter on orders is the given hierarchy, and the employee_id attribute.
function managerRole(root: string, hierarchy: Doc = HIERARCHY, attrType = "number"): void {
  addReportingLines(root);
  mutate(root, ACCESS, (d) => {
    d.user_attributes.push({ name: "employee_id", type: attrType });
    d.roles.push({ name: "manager", allow: { models: ["warehouse.*"] }, row_filters: [{ model: "warehouse.orders", hierarchy }] });
  });
}

// Adds an approved dimension to the approved orders model.
function approvedDimension(root: string, dim: Doc): void {
  mutate(root, ORDERS, (d) => d.dimensions.push({ type: "string", description: "x", ...dim, ...APPROVED }));
}

const OPEN_NO_EFFECT = "has no effect in open mode";
// The draft golden revenue_by_customer_region, with no role, names customers.region; once customers is
// hidden from whoever it runs as, the golden access check warns.
const GOLDEN3_REGION_HIDDEN: Expected = ["warning", GOLDEN3, "request.dimensions[0]", "names customers.region, which"];
const LOOKS_SENSITIVE = "is visible to everyone and looks sensitive";

const ACCESS_CASES: Case[] = [
  // Modes
  {
    name: "open mode: allow.models has no effect",
    file: ACCESS,
    edit: (d) => delete d.mode,
    expect: [
      ["warning", ACCESS, "roles[0].allow.models", OPEN_NO_EFFECT],
      ["warning", ACCESS, "roles[1].allow.models", OPEN_NO_EFFECT],
    ],
  },
  { name: "explicit open mode warns the same way", file: ACCESS, edit: (d) => ((d.mode = "open"), delete d.roles[1].allow), expect: ["warning", ACCESS, "roles[0].allow.models", OPEN_NO_EFFECT] },
  {
    name: "open mode without roles is valid",
    file: "",
    setup: (r) => (noGoldenRoles(r), writeYaml(join(r, ACCESS), { status: "draft", mode: "open" })),
    expect: [],
  },
  { name: "open mode roles without allow are valid", file: ACCESS, edit: (d) => ((d.mode = "open"), delete d.roles[0].allow, delete d.roles[1].allow), expect: [] },
  {
    name: "access.yaml with only a status is open with no roles",
    file: "",
    setup: (r) => (noGoldenRoles(r), writeYaml(join(r, ACCESS), { status: "draft" })),
    expect: [],
  },
  { name: "closed mode: a role needs allow.models", file: ACCESS, edit: (d) => delete d.roles[1].allow, expect: ["error", ACCESS, "roles[1].allow.models", "is required in closed mode"] },
  { name: "closed mode: allow with tags only still needs models", file: ACCESS, edit: (d) => (d.roles[1].allow = { tags: ["pii"] }), expect: ["error", ACCESS, "roles[1].allow.models", "is required in closed mode"] },
  {
    name: "closed mode without roles sees nothing",
    file: "",
    setup: (r) => (rmSync(join(r, "goldens"), { recursive: true }), writeYaml(join(r, ACCESS), { status: "draft", mode: "closed" })),
    expect: ["warning", ACCESS, "mode", "is closed but there are no roles, so no one sees anything"],
  },
  { name: "unknown mode", file: ACCESS, edit: (d) => (d.mode = "strict"), expect: ["error", ACCESS, "mode", "must be one of: open, closed"] },
  {
    name: "open mode: a pattern that matches nothing is not reported, an invalid one is",
    file: ACCESS,
    edit: (d) => ((d.mode = "open"), (d.roles[0].allow.models = ["crm.*", "re:ware(house"]), delete d.roles[1].allow),
    expect: [
      ["warning", ACCESS, "roles[0].allow.models", OPEN_NO_EFFECT],
      ["error", ACCESS, "roles[0].allow.models[1]", "Invalid regex"],
    ],
  },

  // Protected-tag grants
  { name: "allow.tags grants a protected tag", file: ACCESS, edit: (d) => (d.roles[1].allow.tags = ["pii", "sensitive"]), expect: [] },
  {
    name: "allow.tags names a tag that is not protected",
    file: ACCESS,
    edit: (d) => (d.roles[1].allow.tags = ["finance"]),
    expect: ["warning", ACCESS, "roles[1].allow.tags[0]", '"finance" is not a protected tag; allow.tags grants pii or sensitive'],
  },
  { name: "allow.tags must be names", file: ACCESS, edit: (d) => (d.roles[1].allow.tags = ["PII"]), expect: ["error", ACCESS, "roles[1].allow.tags[0]", "must match"] },

  // assign_when
  { name: "assign_when that does not parse", file: ACCESS, edit: (d) => (d.roles[1].assign_when = "user.department = 'sales'"), expect: ["error", ACCESS, "roles[1].assign_when", "Invalid condition"] },
  { name: "assign_when with SQL in it", file: ACCESS, edit: (d) => (d.roles[1].assign_when = "department in (select 1)"), expect: ["error", ACCESS, "roles[1].assign_when", "expected user.<attribute>"] },
  {
    name: "assign_when reads an undeclared attribute",
    file: ACCESS,
    edit: (d) => (d.roles[1].assign_when = "user.title == 'rep' or user.department == 'sales'"),
    expect: ["error", ACCESS, "roles[1].assign_when", "reads user.title, which is not a declared user attribute"],
  },
  { name: "assign_when must be text", file: ACCESS, edit: (d) => (d.roles[1].assign_when = 3), expect: ["error", ACCESS, "roles[1].assign_when", "must be string"] },
  {
    name: "assign_when tests that are false for every user",
    file: ACCESS,
    edit: (d) => {
      d.user_attributes.push({ name: "teams", type: "string_list" }, { name: "level", type: "number" });
      d.roles[1].assign_when = "user.department contains 'x' or user.teams == 'a' or user.level == 'senior' or user.teams contains 3 or user.level in ['a', 'b']";
    },
    expect: [
      ["warning", ACCESS, "roles[1].assign_when", "user.department is a string, and contains needs a list attribute"],
      ["warning", ACCESS, "roles[1].assign_when", "user.teams is a string_list, and == compares one value"],
      ["warning", ACCESS, "roles[1].assign_when", 'user.level is a number, and "senior" is not a number'],
      ["warning", ACCESS, "roles[1].assign_when", "user.teams holds strings, and 3 is not a string"],
      ["warning", ACCESS, "roles[1].assign_when", "user.level holds numbers, and the list holds none"],
    ],
    hint: "false for every user",
  },
  {
    name: "assign_when tests that fit their attributes' types",
    file: ACCESS,
    edit: (d) => {
      d.user_attributes.push({ name: "teams", type: "string_list" }, { name: "level", type: "number" });
      d.roles[1].assign_when =
        "user.teams contains 'west' or user.teams in ['a'] or user.level >= 3 or not (user.region is not set) or user.department != 'x' or user.region >= 'm' or user.region < 'n'";
    },
    expect: [],
  },
  {
    name: "a not in list that holds no value of the attribute's type",
    file: ACCESS,
    edit: (d) => {
      d.user_attributes.push({ name: "level", type: "number" });
      d.roles[1].assign_when = "user.level not in ['a', 'b']";
    },
    expect: [
      "warning",
      ACCESS,
      "roles[1].assign_when",
      "user.level holds numbers, and the list holds none, so that test is true for every user who has user.level; write user.level is set if that is meant",
    ],
  },
  {
    name: "a restriction's allow.when with a not in list that grants everyone who has the attribute",
    file: ACCESS,
    edit: (d) => {
      d.user_attributes.push({ name: "level", type: "number" });
      d.restrictions[0].allow.when = "user.level not in ['a', 'b']";
    },
    expect: ["warning", ACCESS, "restrictions[0].allow.when", "so that test is true for every user who has user.level"],
  },
  {
    name: "a not around a test whose outcome the type fixes",
    file: ACCESS,
    edit: (d) => {
      d.user_attributes.push({ name: "level", type: "number" });
      d.roles[1].assign_when = "not (user.level == 'senior') or not (user.department == 'x' and user.level not in ['a']) or not not (user.level in ['b'])";
    },
    expect: [
      ["warning", ACCESS, "roles[1].assign_when", 'user.level is a number, and "senior" is not a number, so that test is false for every user, and the not around it makes it true for every user'],
      ["warning", ACCESS, "roles[1].assign_when", "and the not around it makes it true exactly for users who lack user.level"],
      ["warning", ACCESS, "roles[1].assign_when", "user.level holds numbers, and the list holds none, so that test is false for every user"],
    ],
  },

  // Restrictions
  {
    name: "a restriction on a field and a model glob",
    file: ACCESS,
    edit: (d) => d.restrictions.push({ name: "revenue_detail", targets: ["warehouse.orders.revenue", "warehouse.cust*"], allow: { roles: ["analyst"] } }),
    // The draft golden aov_by_region runs as sales_rep, whom the restriction keeps from revenue.
    expect: ["warning", GOLDEN2, "request.measures[0]", "names average_order_value, which role sales_rep with user {\"region\":\"west\"} may not see (measure_hidden:orders.revenue)"],
  },
  {
    name: "a restriction allowed by a condition alone",
    file: ACCESS,
    edit: (d) => d.restrictions.push({ name: "finance_only", targets: ["metric:*"], allow: { when: "user.department == 'finance'" } }),
    expect: ["warning", GOLDEN2, "request.measures[0]", "names average_order_value, which role sales_rep with user {\"region\":\"west\"} may not see (restricted:finance_only)"],
  },
  {
    name: "a restriction target that matches nothing",
    file: ACCESS,
    edit: (d) => (d.restrictions[0].targets = ["metric:payroll_*", "warehouse.payroll", "average_order_value"]),
    expect: [
      ["warning", ACCESS, "restrictions[0].targets[0]", '"metric:payroll_*" matches no metric, so it hides nothing'],
      ["warning", ACCESS, "restrictions[0].targets[1]", '"warehouse.payroll" matches no model or field, so it hides nothing'],
      ["warning", ACCESS, "restrictions[0].targets[2]", "write metric:average_order_value to name a metric"],
    ],
  },
  { name: "a restriction target with an invalid regex", file: ACCESS, edit: (d) => (d.restrictions[0].targets = ["re:ware(house"]), expect: ["error", ACCESS, "restrictions[0].targets[0]", "Invalid regex"] },
  { name: "a restriction target metric: with no name", file: ACCESS, edit: (d) => (d.restrictions[0].targets = ["metric:"]), expect: ["error", ACCESS, "restrictions[0].targets[0]", "names no metric"] },
  { name: "a restriction with no targets", file: ACCESS, edit: (d) => (d.restrictions[0].targets = []), expect: ["error", ACCESS, "restrictions[0].targets", "must NOT have fewer than 1 items"] },
  { name: "a restriction allow.roles names an unknown role", file: ACCESS, edit: (d) => (d.restrictions[0].allow.roles = ["analyst", "cfo"]), expect: ["error", ACCESS, "restrictions[0].allow.roles[1]", 'names unknown role "cfo"'] },
  {
    name: "a restriction that allows nobody",
    file: ACCESS,
    edit: (d) => (d.restrictions[0].allow = { roles: [] }),
    expect: ["error", ACCESS, "restrictions[0].allow", "names neither roles nor when, so its targets are hidden from everyone"],
  },
  { name: "a restriction without allow", file: ACCESS, edit: (d) => delete d.restrictions[0].allow, expect: ["error", ACCESS, "restrictions[0].allow", "is required"] },
  {
    name: "a restriction's when reads an undeclared attribute",
    file: ACCESS,
    edit: (d) => (d.restrictions[0].allow.when = "user.cost_center == 'fin'"),
    expect: ["error", ACCESS, "restrictions[0].allow.when", "reads user.cost_center, which is not a declared user attribute"],
  },
  { name: "a restriction's when that does not parse", file: ACCESS, edit: (d) => (d.restrictions[0].allow.when = "user.department =="), expect: ["error", ACCESS, "restrictions[0].allow.when", "Invalid condition"] },
  {
    name: "two restrictions with one name",
    file: ACCESS,
    edit: (d) => d.restrictions.push({ ...d.restrictions[0] }),
    expect: ["error", ACCESS, "restrictions[1].name", '"unit_economics" is already defined at restrictions[0]'],
  },
  { name: "a restriction with an unknown key", file: ACCESS, edit: (d) => (d.restrictions[0].deny = {}), expect: ["error", ACCESS, "restrictions[0].deny", "not a known property"] },

  // Hierarchy row filters
  { name: "a hierarchy row filter", file: "", setup: (r) => managerRole(r), expect: [] },
  { name: "a hierarchy row filter with a bare user attribute and include_self", file: "", setup: (r) => managerRole(r, { ...HIERARCHY, user: "employee_id", include_self: false }), expect: [] },
  {
    name: "a hierarchy row filter through a model of another source",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, via: "lake.web_events" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.via", '"lake.web_events" is in source lake, but warehouse.orders is in warehouse'],
  },
  {
    name: "a hierarchy row filter through an unknown model",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, via: "warehouse.org_chart" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.via", '"warehouse.org_chart" is not a model; model the closure table'],
  },
  {
    name: "a hierarchy row filter with missing columns",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, column: "rep_id", manager: "boss_id", member: "report_id" }),
    expect: [
      ["error", ACCESS, "roles[2].row_filters[0].hierarchy.column", '"rep_id" is not a column of public.fct_orders'],
      ["error", ACCESS, "roles[2].row_filters[0].hierarchy.manager", '"boss_id" is not a column of public.reporting_lines'],
      ["error", ACCESS, "roles[2].row_filters[0].hierarchy.member", '"report_id" is not a column of public.reporting_lines'],
    ],
  },
  {
    name: "a hierarchy row filter with an undeclared user attribute",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, user: "user.staff_id" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.user", "user.staff_id is not a declared user attribute"],
  },
  {
    name: "a hierarchy row filter over a list attribute",
    file: "",
    setup: (r) => managerRole(r, HIERARCHY, "number_list"),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.user", "user.employee_id is a number_list; a hierarchy filter needs the user's own id"],
  },
  {
    name: "a hierarchy row filter on an unknown model",
    file: "",
    setup: (r) => (managerRole(r), mutate(r, ACCESS, (d) => (d.roles[2].row_filters[0].model = "warehouse.tickets"))),
    expect: ["error", ACCESS, "roles[2].row_filters[0].model", '"warehouse.tickets" is not a model'],
  },
  {
    name: "a hierarchy without via",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, via: undefined }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.via", "is required"],
  },
  {
    name: "a hierarchy user that is not an attribute name",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, user: "{{ user.employee_id }}" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.user", "must match"],
  },
  {
    name: "a row filter with both expr and hierarchy",
    file: "",
    setup: (r) => (managerRole(r), mutate(r, ACCESS, (d) => (d.roles[2].row_filters[0].expr = "1 = 1"))),
    expect: ["error", ACCESS, "roles[2].row_filters[0]", "has more than one of expr, hierarchy; give exactly one"],
  },
  {
    name: "a row filter with neither expr nor hierarchy",
    file: ACCESS,
    edit: (d) => delete d.roles[1].row_filters[0].expr,
    expect: ["error", ACCESS, "roles[1].row_filters[0]", "needs one of expr, hierarchy"],
  },

  // Definition joins in open mode and with protected tags
  {
    name: "open mode: a role that denies the joined model",
    file: ACCESS,
    edit: (d) => ((d.mode = "open"), delete d.roles[0].allow, delete d.roles[1].allow, (d.roles[1].deny.models = ["warehouse.customers"])),
    expect: ["warning", ACCESS, "roles[1]", "to model warehouse.customers, which the role denies;"],
  },
  {
    name: "a role that grants the joined model's protected tag",
    file: "",
    setup: (r) => (mutate(r, CUSTOMERS, (d) => (d.tags = ["sensitive"])), mutate(r, ACCESS, (d) => (d.roles[1].allow.tags = ["sensitive"]))),
    expect: [
      ["warning", ACCESS, "roles[0]", "which the role does not see, since it carries the protected tag sensitive; the dimension would show the values of warehouse.customers to this role, so grant sensitive in the role's allow.tags"],
      GOLDEN3_REGION_HIDDEN,
    ],
  },

  // Definition joins seen by the default audience
  {
    name: "no access.yaml: everyone sees a dimension that reads a protected model through a join",
    file: "",
    setup: (r) => (
      rmSync(join(r, ACCESS)),
      noGoldenRoles(r),
      mutate(r, CUSTOMERS, (d) => (d.tags = ["sensitive"])),
      mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))
    ),
    expect: [
      [
        "warning",
        ORDERS,
        "dimensions[3]",
        "warehouse.orders.customer_region is visible to the default audience (a user with no attributes and no assigned roles), and its expr reads customer.region through join customer to model warehouse.customers, which that audience does not see (it carries the protected tag sensitive); the dimension would show the values of warehouse.customers to that audience, so tag warehouse.orders.customer_region sensitive, or confirm with the owner that everyone may see them",
      ],
      [
        "warning",
        GOLDEN3,
        "request.dimensions[0]",
        "names customers.region, which the default audience (a user with no attributes and no assigned roles) may not see (protected_tag:sensitive, model_hidden); a golden with no role and no default role runs as the default audience",
      ],
    ],
  },
  {
    name: "open mode with no roles: everyone sees a dimension that reads a protected model through a join",
    file: "",
    setup: (r) => (
      noGoldenRoles(r),
      mutate(r, ACCESS, (d) => {
        d.mode = "open";
        delete d.roles;
        delete d.default_role;
        delete d.restrictions;
      }),
      mutate(r, CUSTOMERS, (d) => (d.tags = ["pii"])),
      mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))
    ),
    expect: [
      ["warning", ORDERS, "dimensions[3]", "which that audience does not see (it carries the protected tag pii); the dimension would show the values of warehouse.customers to that audience, so tag warehouse.orders.customer_region pii"],
      GOLDEN3_REGION_HIDDEN,
    ],
  },
  {
    name: "open mode with a role no one is assigned: the default audience and the role are both warned about",
    file: "",
    setup: (r) => (
      noGoldenRoles(r),
      mutate(r, ACCESS, (d) => {
        d.mode = "open";
        d.roles = [{ name: "everyone" }];
        delete d.default_role;
        delete d.restrictions;
      }),
      mutate(r, CUSTOMERS, (d) => (d.tags = ["sensitive"])),
      mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))
    ),
    expect: [
      ["warning", ORDERS, "dimensions[3]", "which that audience does not see (it carries the protected tag sensitive)"],
      ["warning", ACCESS, "roles[0]", "which the role does not see, since it carries the protected tag sensitive"],
      GOLDEN3_REGION_HIDDEN,
    ],
  },
  {
    name: "the default role is warned about once for a protected joined model",
    file: "",
    setup: (r) => (mutate(r, CUSTOMERS, (d) => (d.tags = ["sensitive"])), mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))),
    expect: [
      ["warning", ACCESS, "roles[0]", "which the role does not see, since it carries the protected tag sensitive"],
      ["warning", ACCESS, "roles[1]", "which the role does not see, since it carries the protected tag sensitive"],
      GOLDEN3_REGION_HIDDEN,
    ],
  },
  {
    name: "a restriction hides the joined model from the default audience",
    file: "",
    setup: (r) => (
      mutate(r, ACCESS, (d) => d.restrictions.push({ name: "customer_detail", targets: ["warehouse.customers"], allow: { roles: ["sales_rep"] } })),
      mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))
    ),
    expect: [
      [
        "warning",
        ORDERS,
        "dimensions[3]",
        "which that audience does not see (restriction customer_detail hides it); the dimension would show the values of warehouse.customers to that audience, so add warehouse.orders.customer_region to the targets of restriction customer_detail",
      ],
      ["warning", GOLDEN3, "request.dimensions[0]", "names customers.region, which the default role analyst may not see (model_hidden)"],
    ],
  },
  {
    name: "a restriction that covers the dimension too",
    file: "",
    setup: (r) => (
      mutate(r, ACCESS, (d) => d.restrictions.push({ name: "customer_detail", targets: ["warehouse.customers", "warehouse.orders.customer_region"], allow: { roles: ["sales_rep"] } })),
      mutate(r, ORDERS, (d) => Object.assign(d.dimensions[3], APPROVED))
    ),
    expect: [GOLDEN3_REGION_HIDDEN],
  },
  {
    name: "a draft dimension that reads a protected model is not exposed",
    file: "",
    setup: (r) => (rmSync(join(r, ACCESS)), noGoldenRoles(r), mutate(r, CUSTOMERS, (d) => (d.tags = ["sensitive"]))),
    expect: [GOLDEN3_REGION_HIDDEN],
  },

  // ignored_columns
  {
    name: "an ignored column another model joins on",
    file: "",
    setup: (r) => mutate(r, CUSTOMERS, (d) => (delete d.primary_key, (d.measures[0].expr = "email"), (d.ignored_columns = ["customer_id"]))),
    expect: ["warning", CUSTOMERS, "ignored_columns[0]", '"customer_id" is read by a field, a join key, the primary key of model customers or a join from another model'],
  },
  {
    name: "ignored columns the model does not read",
    file: ORDERS,
    setup: (r) => addOrdersColumn(r, { name: "raw_payload", type: "json" }),
    edit: (d) => (d.ignored_columns = ["raw_payload"]),
    expect: [],
  },
  {
    name: "an ignored column the table lacks",
    file: ORDERS,
    edit: (d) => (d.ignored_columns = ["raw_payload"]),
    expect: ["warning", ORDERS, "ignored_columns[0]", '"raw_payload" is not a column of public.fct_orders; remove it from ignored_columns'],
  },
  {
    name: "ignored columns a field, a join key or the primary key reads",
    file: ORDERS,
    edit: (d) => (d.ignored_columns = ["status", "customer_id", "order_id", "AMOUNT_CENTS"]),
    expect: [
      // status is ignored but an untagged field reads it openly, so it is not protected and its raw top values may stay.
      ["warning", ORDERS, "ignored_columns[0]", '"status" is read by a field, a join key, the primary key of model orders or a join from another model'],
      ["warning", ORDERS, "ignored_columns[1]", '"customer_id" is read by a field'],
      ["warning", ORDERS, "ignored_columns[2]", '"order_id" is read by a field'],
      ["warning", ORDERS, "ignored_columns[3]", '"AMOUNT_CENTS" is read by a field'],
    ],
  },
  {
    name: "ignored columns read by a field, without a snapshot",
    file: "",
    setup: (r) => (rmSync(join(r, SNAP_WH)), mutate(r, ORDERS, (d) => (d.ignored_columns = ["ship_region", "raw_payload"]))),
    expect: ["warning", ORDERS, "ignored_columns[0]", '"ship_region" is read by a field'],
  },
  { name: "ignored_columns must be unique", file: ORDERS, edit: (d) => (d.ignored_columns = ["x", "x"]), expect: ["error", ORDERS, "ignored_columns", "must NOT have duplicate items"] },

  // Sensitivity of what everyone sees
  {
    name: "an approved dimension everyone sees reads a free-text column",
    file: "",
    setup: (r) => (addOrdersColumn(r, { name: "internal_notes", type: "text" }), approvedDimension(r, { name: "notes", expr: "internal_notes" })),
    expect: ["warning", ORDERS, "dimensions[4]", "warehouse.orders.notes is visible to everyone and looks sensitive (it reads column internal_notes; the name internal_notes looks like a credential or free text); tag it pii or sensitive, or tag it public if everyone may see it"],
  },
  {
    name: "an approved dimension reads personal data through a join",
    file: "",
    setup: (r) => approvedDimension(r, { name: "buyer_contact", expr: "lower(customer.email)" }),
    expect: ["warning", ORDERS, "dimensions[4]", "warehouse.orders.buyer_contact is visible to everyone and looks sensitive (it reads column customer.email; the name email looks like personal data)"],
  },
  {
    name: "an approved dimension over a near-unique string",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "shipping_label", type: "text", profile: { null_fraction: 0, distinct_count: 9990 } }),
      approvedDimension(r, { name: "label", expr: "shipping_label" })
    ),
    expect: ["warning", ORDERS, "dimensions[4]", "(it reads column shipping_label; shipping_label has a different value on nearly every row)"],
  },
  {
    name: "an approved dimension whose name alone looks personal",
    file: "",
    setup: (r) => (rmSync(join(r, SNAP_WH)), approvedDimension(r, { name: "phone_number", expr: "ship_region" })),
    expect: ["warning", ORDERS, "dimensions[4]", "(the name phone_number looks like personal data)"],
  },
  {
    name: "an approved measure that sums pay",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "bonus_cents", type: "bigint" }),
      mutate(r, ORDERS, (d) => d.measures.push({ name: "payouts", expr: "bonus_cents / 100.0", agg: "sum", description: "x", ...APPROVED }))
    ),
    expect: ["warning", ORDERS, "measures[2]", "warehouse.orders.payouts is visible to everyone and looks sensitive (it reads column bonus_cents; the name bonus_cents looks like pay, banking or health data)"],
  },
  {
    name: "a count of a sensitive column shows no values",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "internal_notes", type: "text" }),
      mutate(r, ORDERS, (d) => d.measures.push({ name: "noted_orders", expr: "internal_notes", agg: "count_distinct", description: "x", ...APPROVED }))
    ),
    expect: [],
  },
  ...(["pii", "sensitive", "public", "Public"] as const).map(
    (tag): Case => ({
      name: `a sensitive-looking field tagged ${tag}`,
      file: "",
      setup: (r) => (
        addOrdersColumn(r, { name: "internal_notes", type: "text" }),
        approvedDimension(r, { name: "notes", expr: "internal_notes", tags: [tag.toLowerCase()] })
      ),
      expect: [],
    }),
  ),
  {
    name: "a sensitive-looking field in a model tagged public",
    file: "",
    setup: (r) => (addOrdersColumn(r, { name: "internal_notes", type: "text" }), approvedDimension(r, { name: "notes", expr: "internal_notes" }), mutate(r, ORDERS, (d) => (d.tags = ["public"]))),
    expect: [],
  },
  {
    name: "a draft sensitive-looking field is not exposed",
    file: "",
    setup: (r) => (addOrdersColumn(r, { name: "internal_notes", type: "text" }), mutate(r, ORDERS, (d) => d.dimensions.push({ name: "notes", expr: "internal_notes", type: "string", status: "draft" }))),
    expect: [],
  },
  {
    name: "a restricted sensitive-looking field is not visible to everyone",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "internal_notes", type: "text" }),
      approvedDimension(r, { name: "notes", expr: "internal_notes" }),
      mutate(r, ACCESS, (d) => d.restrictions.push({ name: "notes_for_reps", targets: ["warehouse.orders.notes"], allow: { roles: ["sales_rep"] } }))
    ),
    expect: [],
  },
  {
    name: "a sensitive-looking field the default role denies",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "internal_notes", type: "text" }),
      approvedDimension(r, { name: "notes", expr: "internal_notes" }),
      mutate(r, ACCESS, (d) => (d.roles[0].deny.fields = ["warehouse.orders.notes"]))
    ),
    expect: [],
  },
  {
    name: "closed mode: no default role means everyone sees nothing",
    file: "",
    setup: (r) => (
      addOrdersColumn(r, { name: "internal_notes", type: "text" }),
      approvedDimension(r, { name: "notes", expr: "internal_notes" }),
      mutate(r, ACCESS, (d) => delete d.default_role)
    ),
    // The draft golden with no role runs as the default audience, which sees nothing in closed mode.
    expect: [
      ["warning", GOLDEN3, "request.measures[0]", "names orders.revenue, which the default audience (a user with no attributes and no assigned roles) may not see (not_allowed, model_hidden)"],
      ["warning", GOLDEN3, "request.dimensions[0]", "names customers.region, which the default audience"],
    ],
  },
  {
    name: "open mode with no access.yaml: everyone sees every approved field",
    file: "",
    setup: (r) => (
      rmSync(join(r, ACCESS)),
      noGoldenRoles(r),
      addOrdersColumn(r, { name: "internal_notes", type: "text" }),
      approvedDimension(r, { name: "notes", expr: "internal_notes" })
    ),
    expect: ["warning", ORDERS, "dimensions[4]", LOOKS_SENSITIVE],
  },
];

describe("access modes, conditions, restrictions, hierarchy filters, ignored columns and sensitivity", () => {
  for (const c of ACCESS_CASES) {
    test(c.name, () => {
      const root = copyFixture();
      if (c.setup) c.setup(root);
      if (c.edit) mutate(root, c.file, c.edit);
      const issues = withoutApprovalHashes(validateProject(root));
      const expected = c.expect.length && Array.isArray(c.expect[0]) ? (c.expect as Expected[]) : c.expect.length ? [c.expect as Expected] : [];
      expectExactly(issues, expected);
      if (c.hint) for (const i of issues) expect(i.message).toContain(c.hint);
    });
  }

  test("sl validate --json reports the sensitivity warning and stays ok", async () => {
    const root = copyFixture();
    addOrdersColumn(root, { name: "internal_notes", type: "text" });
    approvedDimension(root, { name: "notes", expr: "internal_notes" });
    // The fixture's other items carry hashes, so the hand-approved dimension is stamped only on
    // --confirm-unchanged.
    expect((await sl(root, ["approve", "--stamp-hashes", "--confirm-unchanged"])).code).toBe(0);
    // With the owner's yes recorded, validate does not warn that it has none.
    await recordReply(root, "warehouse.orders.notes", { by: "Dana Ruiz" });
    const r = await sl(root, ["validate", "--json"]);
    expect(r.code).toBe(0);
    const body = r.json<{ ok: boolean; warnings: number; issues: Issue[] }>();
    expect(body).toMatchObject({ ok: true, errors: 0, warnings: 1 });
    expect(body.issues[0]!.message).toContain(LOOKS_SENSITIVE);
  });
});

// Lets sales_rep see shipments, a model with a to-one join into the row-filtered orders.
function repSeesShipments(root: string): void {
  addShipments(root);
  mutate(root, ACCESS, (d) => d.roles[1].allow.models.push("warehouse.shipments"));
}

// Adds parcels, joined to shipments, so orders is two hops from parcels.
function addParcels(root: string): void {
  addModel(root, "parcels", "fct_parcels", ["parcel_id", "shipment_id"], {
    joins: [{ name: "shipment", to: "shipments", keys: [{ from: "shipment_id", to: "shipment_id" }], relationship: "many_to_one", status: "draft" }],
  });
}

const SHIPMENTS_UNLIMITED =
  "rows of warehouse.shipments that belong to warehouse.orders are not limited by warehouse.orders's row filter for role sales_rep; " +
  "add a row filter on warehouse.shipments (it may read order.ship_region), deny warehouse.shipments to sales_rep, or record why in the role's open_questions";

// Gives dim_customers.email (read by the pii-tagged customers.email) a profiled top value.
function emailTopValue(root: string, value = "dana@example.com"): void {
  mutate(root, SNAP_WH, (d) => {
    const email = d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "email");
    email.profile = { null_fraction: 0, distinct_count: 2000, top_values: [{ value, count: 1 }, { value: "ab", count: 1 }] };
  });
}

// Gives dim_customers.email a profile with a column's profile fields, written as given.
function emailProfile(root: string, profile: Doc): void {
  mutate(root, SNAP_WH, (d) => {
    d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "email").profile = profile;
  });
}

// Gives dim_customers.email a redacted profile whose top values are the hashes of `values`.
// A value as earlier versions of sl profile stored a protected column's top values: "sha256:" and
// the first 16 hex characters of the SHA-256 of its text, lowercased and trimmed.
const oldHash = (v: string) => `sha256:${createHash("sha256").update(v.toLowerCase().trim()).digest("hex").slice(0, 16)}`;

function emailHashedValues(root: string, values: string[]): void {
  emailProfile(root, { null_fraction: 0, distinct_count: 2000, top_values: values.map((v) => ({ value: oldHash(v), count: 1 })), sampled: false, redacted: true });
}

// The snapshot holds dim_customers.email's hashed top values, which emailHashedValues writes.
const HASHED_EMAIL: Expected = [
  "warning",
  SNAP_WH,
  "tables[0].columns[1].profile",
  "public.dim_customers.email is protected but the snapshot holds hashed top values, which a list of likely values reverses; run sl profile --source warehouse --redact to remove them",
];

// The snapshot holds dim_customers.email's raw top values, which emailTopValue writes.
const RAW_EMAIL: Expected = [
  "warning",
  SNAP_WH,
  "tables[0].columns[1].profile",
  "public.dim_customers.email is protected but the snapshot holds raw sample values; run sl profile --source warehouse --redact",
];

const QUOTES_EMAIL =
  'quotes "dana@example.com", a value of column email of public.dim_customers, which warehouse.customers.email reads and tags pii; ' +
  "this text is shown to people the tag hides that column from, so write an id or a count instead";

const JOIN_ACCESS_CASES: Case[] = [
  // Row filters through joins
  { name: "a row filter's expr reads two hops through joins", file: "", setup: (r) => (addRegions(r), mutate(r, ACCESS, (d) => (d.roles[1].row_filters[0].expr = "customer.home_region.region_name = {{ user.region }}"))), expect: [] },
  {
    name: "a row filter's join reference through a one_to_many join",
    file: "",
    setup: (r) => (
      addShipments(r),
      mutate(r, ORDERS, (d) => d.joins.push({ name: "shipment", to: "shipments", keys: [{ from: "order_id", to: "order_id" }], relationship: "one_to_many", status: "draft" })),
      mutate(r, ACCESS, (d) => (d.roles[1].row_filters[0].expr = "shipment.shipment_id = {{ user.region }}"))
    ),
    expect: [
      ["warning", ORDERS, "joins[1].relationship", "one_to_many fans out"],
      ["error", ACCESS, "roles[1].row_filters[0].expr", "goes through join shipment, which is one_to_many"],
    ],
  },
  { name: "a hierarchy column through a join", file: "", setup: (r) => managerRole(r, { ...HIERARCHY, column: "customer.customer_id" }), expect: [] },
  {
    name: "a hierarchy column through an unknown join",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, column: "buyer.customer_id" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.column", 'buyer.customer_id: "buyer" is neither a column nor a join of model orders'],
  },
  {
    name: "a hierarchy column that is an expression",
    file: "",
    setup: (r) => managerRole(r, { ...HIERARCHY, column: "customer.customer_id + 1" }),
    expect: ["error", ACCESS, "roles[2].row_filters[0].hierarchy.column", '"customer.customer_id + 1" is neither a column nor a join reference'],
  },

  // Child tables of a row-filtered model
  { name: "a role sees a model that joins into its row-filtered model", file: "", setup: repSeesShipments, expect: ["warning", ACCESS, "roles[1].row_filters[0]", SHIPMENTS_UNLIMITED] },
  {
    name: "two hops into the row-filtered model",
    file: "",
    setup: (r) => (repSeesShipments(r), addParcels(r), mutate(r, ACCESS, (d) => d.roles[1].allow.models.push("warehouse.parcels"))),
    expect: [
      ["warning", ACCESS, "roles[1].row_filters[0]", SHIPMENTS_UNLIMITED],
      ["warning", ACCESS, "roles[1].row_filters[0]", "rows of warehouse.parcels that belong to warehouse.orders are not limited by warehouse.orders's row filter for role sales_rep; add a row filter on warehouse.parcels (it may read shipment.order.ship_region)"],
    ],
  },
  {
    name: "the child model has its own row filter, through a join",
    file: "",
    setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => d.roles[1].row_filters.push({ model: "warehouse.shipments", expr: "order.ship_region = {{ user.region }}" }))),
    expect: [],
  },
  { name: "the child model is denied to the role", file: "", setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => (d.roles[1].deny.models = ["warehouse.shipments"]))), expect: [] },
  {
    name: "a restriction keeps the child model from the role",
    file: "",
    setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => d.restrictions.push({ name: "shipping", targets: ["warehouse.ship*"], allow: { roles: ["analyst"] } }))),
    expect: [],
  },
  {
    name: "a restriction with allow.when may still let the role's users see the child model",
    file: "",
    setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => d.restrictions.push({ name: "shipping", targets: ["warehouse.shipments"], allow: { roles: ["analyst"], when: "user.department == 'ops'" } }))),
    expect: ["warning", ACCESS, "roles[1].row_filters[0]", SHIPMENTS_UNLIMITED],
  },
  { name: "a role's open question names the child model", file: "", setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => (d.roles[1].open_questions = ["Reps see all shipments; Dana is checking whether that is meant."]))), expect: [] },
  { name: "an open question that only contains the name in a longer word", file: "", setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => (d.roles[1].open_questions = ["Ask about shipments_archive."]))), expect: ["warning", ACCESS, "roles[1].row_filters[0]", SHIPMENTS_UNLIMITED] },
  {
    name: "a hierarchy filter names its column in the hint",
    file: "",
    setup: (r) => (managerRole(r), addShipments(r)),
    expect: ["warning", ACCESS, "roles[2].row_filters[0]", "rows of warehouse.shipments that belong to warehouse.orders are not limited by warehouse.orders's row filter for role manager; add a row filter on warehouse.shipments (it may read order.customer_id)"],
  },

  {
    name: "the hint reads the filtered model's join reference through the child's join",
    file: "",
    setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => (d.roles[1].row_filters[0].expr = "customer.region = {{ user.region }}"))),
    expect: ["warning", ACCESS, "roles[1].row_filters[0]", "add a row filter on warehouse.shipments (it may read order.customer.region), deny warehouse.shipments to sales_rep"],
  },
  {
    name: "the hint leaves out a reference past two hops",
    file: "",
    setup: (r) => (
      repSeesShipments(r),
      addParcels(r),
      mutate(r, ACCESS, (d) => (d.roles[1].allow.models.push("warehouse.parcels"), (d.roles[1].row_filters[0].expr = "customer.region = {{ user.region }}")))
    ),
    expect: [
      ["warning", ACCESS, "roles[1].row_filters[0]", "add a row filter on warehouse.shipments (it may read order.customer.region), deny"],
      ["warning", ACCESS, "roles[1].row_filters[0]", "add a row filter on warehouse.parcels, deny warehouse.parcels to sales_rep, or record why"],
    ],
  },
  {
    name: "the hint names the column the user attribute limits",
    file: "",
    setup: (r) => (repSeesShipments(r), mutate(r, ACCESS, (d) => (d.roles[1].row_filters[0].expr = "status <> 'cancelled' and ship_region = {{ user.region }}"))),
    expect: ["warning", ACCESS, "roles[1].row_filters[0]", SHIPMENTS_UNLIMITED],
  },

  // Goldens checked against access
  {
    name: "an approved golden names a field its role may not see",
    file: ACCESS,
    edit: (d) => d.restrictions.push({ name: "revenue_detail", targets: ["warehouse.orders.revenue"], allow: { roles: ["sales_rep"] } }),
    expect: [
      ["error", GOLDEN, "request.measures[0]", "names orders.revenue, which role analyst may not see (restricted:revenue_detail); give the golden a role and user who may see every field it names, or change access.yaml after the owner's yes"],
      ["warning", GOLDEN3, "request.measures[0]", "names orders.revenue, which the default role analyst may not see (restricted:revenue_detail); a golden with no role runs as the default role"],
    ],
  },
  {
    name: "a draft golden filters on a field its role may not see",
    file: ACCESS,
    edit: (d) => d.restrictions.push({ name: "status_detail", targets: ["warehouse.orders.status"], allow: { roles: ["analyst"] } }),
    expect: ["warning", GOLDEN2, "request.filters[0].field", 'names orders.status, which role sales_rep with user {"region":"west"} may not see (restricted:status_detail)'],
  },
  {
    name: "a golden's user satisfies a restriction's allow.when",
    file: "",
    setup: (r) => (
      mutate(r, ACCESS, (d) => d.restrictions.push({ name: "west_only", targets: ["metric:average_order_value"], allow: { when: "user.region == 'west'" } }))
    ),
    expect: [],
  },
  {
    name: "no access.yaml: a golden runs as the default audience, which a protected tag hides from",
    file: "",
    setup: (r) => (rmSync(join(r, ACCESS)), noGoldenRoles(r), mutate(r, ORDERS, (d) => (d.dimensions[0].tags = ["pii"]))),
    expect: [
      ["error", GOLDEN, "request.dimensions[0]", "names orders.order_date:month, which the default audience (a user with no attributes and no assigned roles) may not see (protected_tag:pii)"],
      ["error", GOLDEN, "request.filters[0].field", "names orders.order_date, which the default audience"],
      ["error", GOLDEN, "request.filters[1].field", "names orders.order_date, which the default audience"],
      ["error", GOLDEN, "request.order_by[0].field", "names orders.order_date:month, which the default audience"],
    ],
  },
  {
    name: "a golden is not checked against an access.yaml with errors",
    file: ACCESS,
    edit: (d) => ((d.restrictions[0].allow.roles = ["nobody"]), d.restrictions.push({ name: "all", targets: ["warehouse.*"], allow: { roles: ["nobody"] } })),
    expect: [
      ["error", ACCESS, "restrictions[0].allow.roles[0]", 'names unknown role "nobody"'],
      ["error", ACCESS, "restrictions[1].allow.roles[0]", 'names unknown role "nobody"'],
    ],
  },

  // confirmed_as
  { name: "confirmed_as matches the golden's role and user", file: GOLDEN, edit: (d) => (d.confirmed_as = { role: "analyst" }), expect: [] },
  {
    name: "the golden's role changed after it was confirmed",
    file: GOLDEN,
    edit: (d) => (d.confirmed_as = { role: "sales_rep", user: { region: "west" } }),
    expect: [
      "warning",
      GOLDEN,
      "confirmed_as",
      'the golden was confirmed as role sales_rep with user {"region":"west"} but now runs as role analyst; run sl goldens check --name revenue_by_month_2025, read the change back and confirm again on the owner\'s yes',
    ],
  },
  { name: "the golden's user changed after it was confirmed", file: GOLDEN, edit: (d) => ((d.user = { region: "east" }), (d.confirmed_as = { role: "analyst", user: {} })), expect: ["warning", GOLDEN, "confirmed_as", 'but now runs as role analyst with user {"region":"east"}'] },
  { name: "confirmed_as with an unknown key", file: GOLDEN, edit: (d) => (d.confirmed_as = { role: "analyst", roles: ["analyst"] }), expect: ["error", GOLDEN, "confirmed_as.roles", "is not a known property"] },

  {
    name: "a hidden field filtered on and sorted by is reported at each place",
    file: GOLDEN,
    edit: (d) => (d.request.filters.push({ field: "customers.email", op: "eq", value: "x" }), d.request.order_by.push({ field: "customers.email" })),
    expect: [
      ["error", GOLDEN, "request.filters[2].field", "names customers.email, which role analyst may not see"],
      ["error", GOLDEN, "request.order_by[1].field", "names customers.email, which role analyst may not see"],
      ["warning", GOLDEN, "request.filters[2].field", "an approved golden uses draft dimension customers.email"],
    ],
  },
  {
    name: "a golden with no role runs as the roles its user holds by condition",
    file: GOLDEN3,
    edit: (d) => ((d.user = { department: "sales", region: "west" }), (d.request.dimensions = ["customers.email"])),
    expect: ["warning", GOLDEN3, "request.dimensions[0]", 'names customers.email, which a user with user {"department":"sales","region":"west"}, who holds role sales_rep by condition may not see'],
  },

  // Personal values in text
  {
    name: "descriptions, synonyms and golden text quote a value of a pii column",
    file: "",
    setup: (r) => (
      emailTopValue(r),
      mutate(r, ORDERS, (d) => ((d.measures[0].synonyms = ["sales", "Dana@Example.com sales"]), (d.joins[0].description = "The customer, as dana@example.com."))),
      mutate(r, CUSTOMERS, (d) => (d.description = "One row per customer, such as dana@example.com.")),
      mutate(r, ACCESS, (d) => (d.roles[0].description = "Analysts like dana@example.com.")),
      mutate(r, "metrics.yaml", (d) => (d.metrics[0].description = "Revenue per order (dana@example.com checks it).")),
      mutate(r, GOLDEN3, (d) => ((d.question = "What did dana@example.com buy?"), (d.reference = "Asked by dana@example.com")))
    ),
    expect: [
      ["warning", ORDERS, "measures[0].synonyms[1]", QUOTES_EMAIL],
      ["warning", ORDERS, "joins[0].description", QUOTES_EMAIL],
      ["warning", CUSTOMERS, "description", QUOTES_EMAIL],
      ["warning", ACCESS, "roles[0].description", QUOTES_EMAIL],
      ["warning", "metrics.yaml", "metrics[0].description", QUOTES_EMAIL],
      ["warning", GOLDEN3, "question", QUOTES_EMAIL],
      ["warning", GOLDEN3, "reference", QUOTES_EMAIL],
      RAW_EMAIL,
    ],
  },
  {
    name: "a short value, or one inside a longer word, is not flagged",
    file: "",
    setup: (r) => (emailTopValue(r, "west"), mutate(r, CUSTOMERS, (d) => (d.description = "One row per customer; ab is short, and midwest or westerly are other words."))),
    expect: [RAW_EMAIL],
  },
  {
    name: "a dimension that reads a pii column through a join flags its values",
    file: "",
    setup: (r) => (
      emailTopValue(r),
      mutate(r, CUSTOMERS, (d) => delete d.dimensions[0].tags),
      mutate(r, ORDERS, (d) => (d.dimensions.push({ name: "buyer_email", expr: "customer.email", type: "string", tags: ["pii"], status: "draft" }), (d.description = "Orders, such as those of dana@example.com.")))
    ),
    expect: [["warning", ORDERS, "description", 'quotes "dana@example.com", a value of column email of public.dim_customers, which warehouse.orders.buyer_email reads and tags pii'], RAW_EMAIL],
  },
  {
    name: "a model's tag flags values only of the columns that look personal",
    file: "",
    setup: (r) => (
      emailTopValue(r),
      mutate(r, SNAP_WH, (d) => {
        const region = d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "region");
        region.profile = { null_fraction: 0, distinct_count: 4, top_values: [{ value: "Northwind", count: 900 }] };
      }),
      mutate(r, CUSTOMERS, (d) => ((d.tags = ["pii"]), delete d.dimensions[0].tags, (d.description = "Customers in Northwind, such as dana@example.com.")))
    ),
    expect: [
      ["warning", CUSTOMERS, "description", QUOTES_EMAIL],
      ["warning", ACCESS, "roles[0]", "may see dimension warehouse.orders.customer_region"],
      ["warning", ACCESS, "roles[1]", "may see dimension warehouse.orders.customer_region"],
      GOLDEN3_REGION_HIDDEN,
      RAW_EMAIL,
      // The model's tag protects every column of its table, so region's raw top value is reported too.
      ["warning", SNAP_WH, "tables[0].columns[2].profile", "public.dim_customers.region is protected but the snapshot holds raw sample values"],
    ],
  },
  {
    name: "values of an untagged column are not flagged",
    file: "",
    setup: (r) => (emailTopValue(r), mutate(r, CUSTOMERS, (d) => (delete d.dimensions[0].tags, (d.description = "Customers, such as dana@example.com.")))),
    // email stays protected by its name, so its raw top values are still reported.
    expect: [["warning", ACCESS, "roles[0].deny.tags[0]", 'tag "pii" is not used'], RAW_EMAIL],
  },
  {
    // Hashes of personal values are reversible by a list of likely values, so text is no longer
    // matched against them; the snapshot is asked to drop them instead.
    name: "hashed top values are not matched in text, and the snapshot is asked to remove them",
    file: "",
    setup: (r) => (
      emailHashedValues(r, ["Dana Ruiz", "dana@example.com"]),
      mutate(r, CUSTOMERS, (d) => (d.description = "Customers such as DANA RUIZ.")),
      mutate(r, GOLDEN3, (d) => ((d.question = 'What did "Dana Ruiz" buy?'), (d.reference = "Checked with dana@example.com.")))
    ),
    expect: HASHED_EMAIL,
  },
  {
    name: "a protected text column whose min and max an earlier sl profile hashed holds hashed values, not raw ones",
    file: "",
    setup: (r) => emailProfile(r, { null_fraction: 0, distinct_count: 2000, min: oldHash("a@example.com"), max: oldHash("z@example.com"), sampled: false, redacted: true }),
    expect: HASHED_EMAIL,
  },
  {
    name: "a protected text column with a text min and max holds raw values",
    file: "",
    setup: (r) => emailProfile(r, { null_fraction: 0, distinct_count: 2000, min: "a@example.com", max: "z@example.com", sampled: false }),
    expect: RAW_EMAIL,
  },
  {
    name: "a profile of counts only, and a protected number column's min and max, hold no sample values",
    file: "",
    setup: (r) => (
      emailProfile(r, { null_fraction: 0, distinct_count: 2000, sampled: false, redacted: true }),
      mutate(r, SNAP_WH, (d) => {
        // The pii tag on the customers model protects customer_id, which keeps its min and max.
        d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "customer_id").profile = {
          null_fraction: 0,
          distinct_count: 2000,
          min: 1,
          max: 2000,
          redacted: true,
        };
      }),
      mutate(r, CUSTOMERS, (d) => (d.tags = ["pii"]))
    ),
    expect: [
      ["warning", ACCESS, "roles[0]", "may see dimension warehouse.orders.customer_region"],
      ["warning", ACCESS, "roles[1]", "may see dimension warehouse.orders.customer_region"],
      GOLDEN3_REGION_HIDDEN,
    ],
  },
  {
    name: "a redacted boolean column read by a sensitive field quotes nothing when a text says true or false",
    file: "",
    setup: (r) => (
      mutate(r, SNAP_WH, (d) => {
        d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "is_test_account").profile = {
          null_fraction: 0,
          distinct_count: 2,
          sampled: false,
          redacted: true,
        };
      }),
      mutate(r, CUSTOMERS, (d) => {
        d.dimensions[2].tags = ["sensitive"];
        d.dimensions[2].description = "True for an internal test account, false otherwise.";
      })
    ),
    expect: [],
  },
  {
    name: "a protected boolean column keeps no min or max",
    file: "",
    setup: (r) => (
      mutate(r, SNAP_WH, (d) => {
        d.tables.find((t: Doc) => t.name === "dim_customers").columns.find((c: Doc) => c.name === "is_test_account").profile = {
          null_fraction: 0,
          distinct_count: 2,
          min: false,
          max: true,
          redacted: true,
        };
      }),
      mutate(r, CUSTOMERS, (d) => (d.dimensions[2].tags = ["sensitive"]))
    ),
    expect: [
      "warning",
      SNAP_WH,
      "tables[0].columns[3].profile",
      "public.dim_customers.is_test_account is protected but the snapshot holds raw sample values; run sl profile --source warehouse --redact",
    ],
  },
  {
    name: "an ignored column's raw top values are reported",
    file: "",
    setup: (r) => (
      mutate(r, SNAP_WH, (d) => d.tables.find((t: Doc) => t.name === "fct_orders").columns.push({ name: "gift_message", type: "text", nullable: true, description: null, profile: { null_fraction: 0.5, distinct_count: 3, top_values: [{ value: "Happy birthday", count: 2 }] } })),
      mutate(r, ORDERS, (d) => (d.ignored_columns = ["gift_message"]))
    ),
    expect: ["warning", SNAP_WH, "tables[1].columns[6].profile", "public.fct_orders.gift_message is protected but the snapshot holds raw sample values; run sl profile --source warehouse --redact"],
  },
];

describe("row filters through joins, child tables, goldens against access and personal values in text", () => {
  for (const c of JOIN_ACCESS_CASES) {
    test(c.name, () => {
      const root = copyFixture();
      if (c.setup) c.setup(root);
      if (c.edit) mutate(root, c.file, c.edit);
      const issues = withoutApprovalHashes(validateProject(root));
      const expected = c.expect.length && Array.isArray(c.expect[0]) ? (c.expect as Expected[]) : c.expect.length ? [c.expect as Expected] : [];
      expectExactly(issues, expected);
    });
  }

  test("sl validate exits 1 when an approved golden names a field its role may not see", async () => {
    const root = copyFixture();
    mutate(root, ACCESS, (d) => d.restrictions.push({ name: "revenue_detail", targets: ["warehouse.orders.revenue"], allow: { roles: ["sales_rep"] } }));
    const r = await sl(root, ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("request.measures[0]: names orders.revenue, which role analyst may not see (restricted:revenue_detail)");
  });
});

describe("mutations of the valid fixture", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const root = copyFixture();
      if (c.setup) c.setup(root);
      if (c.edit) mutate(root, c.file, c.edit);
      const issues = withoutApprovalHashes(validateProject(root));
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

describe("dividesByLiteral and callsRound", () => {
  test("a division by a numeric literal, outside literals and comments", () => {
    expect(dividesByLiteral("amount_cents / 100.0")).toBe(true);
    expect(dividesByLiteral("amount_cents/100")).toBe(true);
    expect(dividesByLiteral("amount_cents / .5")).toBe(true);
    expect(dividesByLiteral("amount_cents * 0.01")).toBe(false);
    expect(dividesByLiteral("amount_cents // 100")).toBe(false);
    expect(dividesByLiteral("amount_cents / 100::decimal(18, 2)")).toBe(true);
    expect(dividesByLiteral("amount_cents / 100.0::double")).toBe(true);
    expect(dividesByLiteral("amount_cents / (100.0)")).toBe(true);
    expect(dividesByLiteral("amount_cents / -100")).toBe(true);
    expect(dividesByLiteral("amount_cents / +(100)")).toBe(true);
    expect(dividesByLiteral("amount_cents / (quantity - 1)")).toBe(false);
    expect(dividesByLiteral("amount_cents / quantity")).toBe(false);
    expect(dividesByLiteral("'a / 100' || amount /* x / 2 */")).toBe(false);
  });

  test("a call to round(), in any case, outside literals and comments", () => {
    expect(callsRound("select ROUND (sum(x), 2)")).toBe(true);
    expect(callsRound("select round(x)")).toBe(true);
    expect(callsRound("select pg_catalog.round(x, 2)")).toBe(true);
    expect(callsRound("select main.round(x, 2)")).toBe(true);
    expect(callsRound("select rounded, 'round(x)' -- round(y)")).toBe(false);
    expect(callsRound('select "round"(x)')).toBe(false);
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

  test("access examples' conditions parse and read only declared attributes", () => {
    const examples = blocks.filter((b) => b.kind === "access");
    expect(examples.length).toBeGreaterThanOrEqual(3);
    let conditions = 0;
    for (const b of examples) {
      const doc = parseYamlText(b.text) as Doc;
      const declared = new Set((doc.user_attributes ?? []).map((u: Doc) => u.name));
      const sources = [...(doc.roles ?? []).map((r: Doc) => r.assign_when), ...(doc.restrictions ?? []).map((x: Doc) => x.allow?.when)];
      for (const src of sources.filter((x): x is string => typeof x === "string")) {
        conditions++;
        for (const attr of conditionAttributes(parseCondition(src))) expect(declared.has(attr)).toBe(true);
      }
      const roles = new Set((doc.roles ?? []).map((r: Doc) => r.name));
      for (const x of doc.restrictions ?? []) for (const r of x.allow?.roles ?? []) expect(roles.has(r)).toBe(true);
      for (const r of doc.roles ?? [])
        for (const rf of r.row_filters ?? []) if (rf.hierarchy) expect(declared.has(String(rf.hierarchy.user).replace(/^user\./, ""))).toBe(true);
      if (doc.mode === "closed") for (const r of doc.roles ?? []) expect(r.allow?.models).toBeDefined();
      else for (const r of doc.roles ?? []) expect(r.allow?.models).toBeUndefined();
    }
    expect(conditions).toBeGreaterThan(0);
  });

  for (const b of blocks) {
    test(`${b.kind} example at spec.md:${b.line} passes its schema`, () => {
      const data = b.lang === "json" ? JSON.parse(b.text) : parseYamlText(b.text);
      expect(schemaIssues(b.kind, data, `spec.md:${b.line}`)).toEqual([]);
    });
  }
});

const CHANGED = "changed since it was approved";
const UNHASHED = "approved before content hashes; run sl approve --stamp-hashes to record them";
const MISSING = "approved_hash is missing while other approved items carry one; it may have been removed";
const atIssues = (issues: Issue[], text: string) => issues.filter((i) => i.message.includes(text)).map((i) => [i.level, i.file, i.path]);

describe("approval hashes", () => {
  test("the analytics review's edit of the approved revenue measure is an error, and sl validate exits 1", async () => {
    // The reviewer summed cancelled orders times 1000 while revenue stayed approved by Dana Ruiz;
    // validate used to pass it and every golden still passed.
    const root = copyFixture();
    mutate(root, ORDERS, (d) => {
      d.measures[0].expr = "amount_cents * 1000";
      d.measures[0].filter = "status = 'cancelled' and coalesce(customer.is_test_account, false) = false";
    });
    const issues = validateProject(root);
    expect(atIssues(issues, CHANGED)).toEqual([["error", ORDERS, "measures[0]"]]);
    expect(issues.find((i) => i.message.includes(CHANGED))!.message).toBe(
      "warehouse.orders.revenue changed since it was approved by Dana Ruiz on 2026-01-15: its definition, or a join it reads through, no longer matches approved_hash. " +
        'Read it back to the owner as it now stands and approve it again only after they confirm (sl approve --target warehouse.orders.revenue --by "<owner>"), ' +
        "or restore the approved definition",
    );
    const r = await sl(root, ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("measures[0]: warehouse.orders.revenue changed since it was approved");
  });

  test("a changed join is an error on the join and on every approved field that reads through it", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => (d.joins[0].type = "inner"));
    expect(atIssues(validateProject(root), CHANGED)).toEqual([
      ["error", ORDERS, "measures[0]"],
      ["error", ORDERS, "joins[0]"],
    ]);
  });

  test("model, metric and access changes are errors; descriptions, open questions and formatting are not", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => (d.grain = "One row per order line."));
    mutate(root, "metrics.yaml", (d) => (d.metrics[0].denominator = "orders.revenue"));
    expect(atIssues(validateProject(root), CHANGED)).toEqual([
      ["error", ORDERS, ""],
      ["error", "metrics.yaml", "metrics[0]"],
    ]);

    const quiet = copyFixture();
    mutate(quiet, ORDERS, (d) => {
      d.description = "Orders, reworded.";
      d.measures[0].description = "Reworded.";
      d.measures[0].synonyms = [" sales "];
      d.measures[0].filter = `  ${d.measures[0].filter}\n`;
      d.open_questions = ["A new question."];
      d.joins[0].type = "left";
    });
    expect(atIssues(validateProject(quiet), CHANGED)).toEqual([]);
  });

  test("the approved access file: a role change is an error, an open question is not", async () => {
    const root = copyFixture();
    const t = join(root, ACCESS);
    writeFileSync(t, readFileSync(t, "utf8").replace(/^status: draft$/m, "status: approved\napproved_by: Dana Ruiz\napproved_at: 2026-01-15"));
    // The fixture's models and metrics carry hashes, so an approved access file without one may have
    // had it removed: a warning of its own, and --stamp-hashes needs --confirm-unchanged.
    expect(atIssues(validateProject(root), MISSING)).toEqual([["warning", ACCESS, ""]]);
    expect(atIssues(validateProject(root), UNHASHED)).toEqual([]);
    expect((await sl(root, ["approve", "--stamp-hashes", "--target", "access"])).code).toBe(1);
    expect((await sl(root, ["approve", "--stamp-hashes", "--target", "access", "--confirm-unchanged"])).code).toBe(0);
    expect(atIssues(validateProject(root), MISSING)).toEqual([]);
    mutate(root, ACCESS, (d) => {
      d.open_questions = ["Does finance need its own role?"];
      d.roles[0].open_questions = ["Who else is an analyst?"];
    });
    expect(atIssues(validateProject(root), CHANGED)).toEqual([]);
    mutate(root, ACCESS, (d) => (d.roles[1].row_filters = []));
    expect(atIssues(validateProject(root), CHANGED)).toEqual([["error", ACCESS, ""]]);
  });

  test("approved items without a hash get one warning per file, and --stamp-hashes clears it without changing who approved them", async () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => {
      for (const x of [d, ...d.dimensions, ...d.measures, ...d.joins]) delete x.approved_hash;
    });
    mutate(root, "metrics.yaml", (d) => delete d.metrics[0].approved_hash);
    const before = validateProject(root);
    expect(before.filter((i) => i.message.includes(UNHASHED)).map((i) => [i.level, i.file, i.path, i.message])).toEqual([
      ["warning", ORDERS, "", `5 approved items were ${UNHASHED}, after checking in version control that none changed since approved_at`],
      ["warning", "metrics.yaml", "", `1 approved item was ${UNHASHED}, after checking in version control that none changed since approved_at`],
    ]);
    expect(atIssues(before, MISSING)).toEqual([]);
    const r = await sl(root, ["approve", "--stamp-hashes", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ stamped: string[] }>().stamped).toEqual([
      "warehouse.orders",
      "warehouse.orders.order_date",
      "warehouse.orders.revenue",
      "warehouse.orders.order_count",
      "warehouse.orders.customer",
      "metric:average_order_value",
    ]);
    expect(validateProject(root)).toEqual([]);
    const m = readYaml<Doc>(join(root, ORDERS));
    expect(m).toMatchObject({ approved_by: "Dana Ruiz", approved_at: "2026-01-15" });
    expect(m.measures[0].approved_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Once stamped, the same edit the review made is caught.
    mutate(root, ORDERS, (d) => (d.measures[0].expr = "amount_cents * 1000"));
    expect(atIssues(validateProject(root), CHANGED)).toEqual([["error", ORDERS, "measures[0]"]]);
  });

  test("swapping the names of two approved measures is an error on both", () => {
    // revenue would read order_count's definition and order_count revenue's, while every hash of
    // their content alone still matched.
    const root = copyFixture();
    mutate(root, ORDERS, (d) => {
      d.measures[0].name = "order_count";
      d.measures[1].name = "revenue";
    });
    const changed = atIssues(validateProject(root), CHANGED);
    expect(changed).toContainEqual(["error", ORDERS, "measures[0]"]);
    expect(changed).toContainEqual(["error", ORDERS, "measures[1]"]);
  });

  test("pointing a model at another table is an error on the model and every approved field under it", async () => {
    const root = copyFixture();
    // Revoking only the model, then editing table, leaves the approved fields to catch it.
    expect((await sl(root, ["approve", "--target", "warehouse.orders", "--revoke"])).code).toBe(0);
    mutate(root, ORDERS, (d) => (d.table = "public.fct_orders_lookalike"));
    expect(atIssues(validateProject(root), CHANGED)).toEqual([
      ["error", ORDERS, "dimensions[0]"],
      ["error", ORDERS, "measures[0]"],
      ["error", ORDERS, "measures[1]"],
      ["error", ORDERS, "joins[0]"],
    ]);
  });

  test("an approved measure copied with its hash into another model is an error there", () => {
    const root = copyFixture();
    const revenue = readYaml<Doc>(join(root, ORDERS)).measures[0];
    mutate(root, CUSTOMERS, (d) => (d.measures = [...(d.measures ?? []), revenue]));
    const changed = atIssues(validateProject(root), CHANGED);
    expect(changed.filter(([, file]) => file === CUSTOMERS)).toHaveLength(1);
  });

  test("a removed approved_hash is warned about on its own, kept from --stamp-hashes, and listed by status", async () => {
    // The pre-publication review: the edited revenue errors; deleting its approved_hash line turned
    // the error into the "approved before content hashes" warning, and --stamp-hashes then recorded
    // the edit as approved by Dana Ruiz.
    const root = copyFixture();
    mutate(root, ORDERS, (d) => {
      d.measures[0].expr = "amount_cents * 1000";
      d.measures[0].filter = "status = 'cancelled'";
      delete d.measures[0].approved_hash;
    });
    const issues = validateProject(root);
    expect(atIssues(issues, MISSING)).toEqual([["warning", ORDERS, "measures[0]"]]);
    expect(atIssues(issues, UNHASHED)).toEqual([]);
    expect(issues.find((i) => i.message.includes(MISSING))!.message).toBe(
      "warehouse.orders.revenue is approved, but approved_hash is missing while other approved items carry one; it may have been removed. " +
        'Read it back to the owner as it now stands and approve it again only after they confirm (sl approve --target warehouse.orders.revenue --by "<owner>")',
    );
    const stamp = await sl(root, ["approve", "--stamp-hashes"]);
    expect(stamp.code).toBe(1);
    expect(stamp.err).toContain("may have had theirs removed after an edit: warehouse.orders.revenue");
    expect(readYaml<Doc>(join(root, ORDERS)).measures[0].approved_hash).toBeUndefined();
    const st = (await sl(root, ["status", "--json"])).json<{ hash_missing: string[]; next_step: { phase: string; command: string } }>();
    expect(st.hash_missing).toEqual(["warehouse.orders.revenue"]);
    expect(st.next_step).toMatchObject({ phase: "reapprove", command: 'sl approve --target warehouse.orders.revenue --by "<owner>"' });
    // Approving it again on the owner's yes records the hash; it is not "already approved".
    const again = await approveWithYes(root, ["--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"], { now: "2026-02-01T12:00:00.000Z" });
    expect(again.code).toBe(0);
    expect(again.out).toContain("Approved warehouse.orders.revenue again (its approved_hash was missing) by Dana Ruiz on 2026-02-01 (reply ans_0008).");
    expect(atIssues(validateProject(root), MISSING)).toEqual([]);
  });

  test("--stamp-hashes --target that names nothing is refused", async () => {
    const root = copyFixture();
    const r = await sl(root, ["approve", "--stamp-hashes", "--target", "warehouse.orders.revnue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--target warehouse.orders.revnue names no model, field, metric or access file of this project.");
    expect((await sl(root, ["approve", "--stamp-hashes", "--target", "warehouse.orders.revenue"])).out).toContain("nothing changed");
  });

  test("--confirm-unchanged is only for --stamp-hashes", async () => {
    const r = await sl(copyFixture(), ["approve", "--target", "warehouse.orders", "--by", "Dana", "--confirm-unchanged"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--confirm-unchanged applies only to sl approve --stamp-hashes.");
  });

  test("a malformed approved_hash is a schema error", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => (d.measures[0].approved_hash = "md5:abc"));
    expectIssue(validateProject(root), "error", ORDERS, "measures[0].approved_hash", "must match");
  });
});

describe("joins whose evidence shows fan-out", () => {
  const fanOut = (root: string, extra: Doc = {}) =>
    mutate(root, ORDERS, (d) => Object.assign(d.joins[0], { ...extra, evidence: { ...d.joins[0].evidence, right_key_unique: false, max_fanout: 5, suggested_relationship: "many_to_many" === extra.rel ? "many_to_many" : "one_to_many" } }));

  test("an approved to-one join with fan-out evidence is an error", () => {
    // The review approved orders.line as many_to_one while check-join measured a fan-out of 5.
    const root = copyFixture();
    fanOut(root);
    const issues = withoutApprovalHashes(validateProject(root));
    expectExactly(issues, [
      ["warning", ORDERS, "joins[0].relationship", "is many_to_one but the evidence suggests one_to_many"],
      [
        "error",
        ORDERS,
        "joins[0].evidence",
        "is approved as many_to_one, but its evidence contradicts that: the key of customers is not unique, and a row of orders matches up to 5 rows of customers, " +
          'so the join fans out and multiplies the measures of orders; fix the keys or the relationship and run sl check-join again, or record why the owner accepts the data in fanout_override: "<reason>"',
      ],
    ]);
  });

  test("max_fanout alone is enough", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => (d.joins[0].evidence.max_fanout = 2));
    expectIssue(validateProject(root), "error", ORDERS, "joins[0].evidence", "a row of orders matches up to 2 rows of customers");
  });

  test("fanout_override records why it stands; a draft join and stale evidence only warn", () => {
    const withOverride = copyFixture();
    fanOut(withOverride, { fanout_override: "Duplicate customer rows from the 2019 migration; the owner accepts them." });
    expect(errors(withoutApprovalHashes(validateProject(withOverride)))).toEqual([]);

    const draft = copyFixture();
    fanOut(draft, { status: "draft", approved_by: undefined, approved_at: undefined, approved_hash: undefined });
    expect(errors(validateProject(draft))).toEqual([]);

    const stale = copyFixture();
    mutate(stale, ORDERS, (d) => Object.assign(d.joins[0], { evidence: { ...d.joins[0].evidence, to: "regions", max_fanout: 5 } }));
    expect(errors(withoutApprovalHashes(validateProject(stale)))).toEqual([]);
  });

  test("sl approve warns that validate will error on such a join", async () => {
    const root = copyFixture();
    fanOut(root, { status: "draft", approved_by: undefined, approved_at: undefined, approved_hash: undefined });
    const r = await approveWithYes(root, ["--target", "warehouse.orders.customer", "--by", "Dana Ruiz", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ warnings: string[] }>().warnings).toEqual([
      'Join warehouse.orders.customer is many_to_one, but its evidence shows fan-out (the key of customers is not unique, and a row matches up to 5 rows of customers); sl validate errors on it until the keys or the relationship are fixed, or fanout_override: "<reason>" records why the owner accepts it.',
    ]);
  });

  test("sl approve words the fan-out from the evidence it has, names many_to_many's bridge table and skips stale evidence", async () => {
    const draft = { status: "draft", approved_by: undefined, approved_at: undefined, approved_hash: undefined };
    const approveWarnings = async (root: string) => {
      const r = await approveWithYes(root, ["--target", "warehouse.orders.customer", "--by", "Dana Ruiz", "--json"]);
      expect(r.code).toBe(0);
      return r.json<{ warnings: string[] }>().warnings;
    };

    const keyOnly = copyFixture();
    mutate(keyOnly, ORDERS, (d) => Object.assign(d.joins[0], draft, { evidence: { ...d.joins[0].evidence, right_key_unique: false, max_fanout: undefined } }));
    const w = await approveWarnings(keyOnly);
    expect(w).toEqual([
      'Join warehouse.orders.customer is many_to_one, but its evidence shows fan-out (the key of customers is not unique); sl validate errors on it until the keys or the relationship are fixed, or fanout_override: "<reason>" records why the owner accepts it.',
    ]);
    expect(w[0]).not.toContain("undefined");

    const m2m = copyFixture();
    fanOut(m2m, { ...draft, fanout_override: "The owner accepts it." });
    mutate(m2m, ORDERS, (d) => (d.joins[0].evidence.suggested_relationship = "many_to_many"));
    expect(await approveWarnings(m2m)).toEqual([
      "Join warehouse.orders.customer's evidence shows many_to_many: neither key is unique, so sl validate errors on it once approved, whatever fanout_override says; the join needs a bridge table or a pre-aggregated model.",
    ]);

    const stale = copyFixture();
    mutate(stale, ORDERS, (d) => Object.assign(d.joins[0], draft, { evidence: { ...d.joins[0].evidence, to: "regions", max_fanout: 5 } }));
    expect(await approveWarnings(stale)).toEqual([]);
  });
});

describe("golden requests and their hand-written SQL", () => {
  const MUST_SHARE = "a request's measures must share one model, or be one metric";

  test("measures from two models that are not one metric are an error, in a draft golden too", () => {
    // The review's t6: refunds and orders measures side by side validated cleanly.
    const root = copyFixture();
    mutate(root, GOLDEN3, (d) => (d.request.measures = ["orders.revenue", "customers.customer_count"]));
    expectIssue(validateProject(root), "error", GOLDEN3, "request.measures[1]", `customers.customer_count aggregates over customers, and orders.revenue over orders; ${MUST_SHARE}`);
  });

  test("one metric over two models, and several measures of one model, are fine", () => {
    const root = copyFixture();
    mutate(root, "metrics.yaml", (d) => d.metrics.push({ name: "orders_per_customer", source: "warehouse", type: "ratio", numerator: "orders.order_count", denominator: "customers.customer_count", status: "draft" }));
    mutate(root, GOLDEN3, (d) => (d.request.measures = ["orders_per_customer"]));
    mutate(root, GOLDEN, (d) => (d.request.measures = ["orders.revenue", "orders.order_count"]));
    expect(validateProject(root).filter((i) => i.message.includes(MUST_SHARE))).toEqual([]);
    // A spanning metric next to another measure is more than one model again.
    mutate(root, GOLDEN3, (d) => (d.request.measures = ["orders_per_customer", "orders.revenue"]));
    expectIssue(validateProject(root), "error", GOLDEN3, "request.measures[1]", MUST_SHARE);
  });

  test("SQL that leaves out a requested measure's filter gets a warning", () => {
    // The analyst's goldens/wrong.yaml: revenue is approved with a status filter, and the golden's
    // SQL summed every sale. It validated, confirmed and passed.
    const root = copyFixture();
    mutate(root, GOLDEN, (d) => (d.cross_check_sql = "select date_trunc('month', created_at) as m, sum(amount_cents / 100.0) as revenue\nfrom public.fct_orders group by 1"));
    expectExactly(validateProject(root), [
      [
        "warning",
        GOLDEN,
        "cross_check_sql",
        "this hand-written SQL may not apply orders.revenue's rule: it never names status, is_test_account, which the measure's expr or filter reads. " +
          "Write the measure's expr and filter into the SQL as the model defines them, then run sl goldens check --name revenue_by_month_2025 and read any change back to the owner",
      ],
      // The owner's yes was to the golden with its old SQL.
      ["warning", GOLDEN, "", "golden:revenue_by_month_2025 is confirmed, but no recorded owner yes in .sl/ledger.jsonl matches it as it stands"],
    ]);
  });

  test("without the model's table in the snapshot, SQL words such as extract, year and to are not taken for columns", () => {
    const root = copyFixture();
    mutate(root, SNAP_WH, (d) => (d.tables = d.tables.filter((t: Doc) => t.name !== "fct_orders")));
    mutate(root, ORDERS, (d) => {
      d.measures[0].filter = "extract(year from created_at) >= 2020 and status not similar to 'cancel%' and coalesce(customer.is_test_account, false) = false";
    });
    mutate(root, GOLDEN, (d) => (d.cross_check_sql = "select date_trunc('month', created_at) as m, sum(amount_cents / 100.0) as revenue\nfrom public.fct_orders group by 1"));
    const warned = validateProject(root).filter((i) => i.file === GOLDEN && i.path === "cross_check_sql").map((i) => i.message);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("it never names status, is_test_account, which");
  });

  test("a metric's measures are checked, names in comments and strings do not count, and a count of rows needs nothing", () => {
    const root = copyFixture();
    mutate(root, GOLDEN2, (d) => (d.cross_check_sql = "select ship_region, sum(amount_cents) / count(*) -- status, is_test_account\nfrom public.fct_orders where 'status' <> '' group by 1"));
    const warned = validateProject(root).filter((i) => i.file === GOLDEN2 && i.path === "cross_check_sql").map((i) => i.message);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("this hand-written SQL may not apply orders.revenue's rule: it never names status, is_test_account");
  });
});

describe("time zones on time dimensions", () => {
  test("a known IANA zone on a timestamp without a time zone is fine", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => (d.dimensions[0].time_zone = "America/New_York"));
    mutate(root, CUSTOMERS, (d) => (d.dimensions[3].time_zone = "UTC"));
    expect(withoutApprovalHashes(validateProject(root))).toEqual([]);
  });

  test("an unknown zone, an offset and a zone on another type are errors", () => {
    const root = copyFixture();
    mutate(root, ORDERS, (d) => {
      d.dimensions[0].time_zone = "Mars/Olympus";
      d.dimensions[1].time_zone = "UTC";
    });
    // An offset fails the schema, so the customers file gets no other checks.
    mutate(root, CUSTOMERS, (d) => (d.dimensions[3].time_zone = "+02:00"));
    const issues = withoutApprovalHashes(validateProject(root));
    expectExactly(issues, [
      ["error", ORDERS, "dimensions[0].time_zone", '"Mars/Olympus" is not an IANA time zone, such as UTC or America/New_York'],
      ["error", ORDERS, "dimensions[1].time_zone", "is only allowed on time dimensions, not string"],
      ["error", CUSTOMERS, "dimensions[3].time_zone", "must match"],
    ]);
  });

  test("a zone on a column that carries its own is a warning; TIMESTAMP carries one on BigQuery", () => {
    const root = copyFixture();
    mutate(root, SNAP_WH, (d) => (d.tables.find((t: Doc) => t.name === "fct_orders").columns.find((c: Doc) => c.name === "created_at").type = "timestamp with time zone"));
    mutate(root, ORDERS, (d) => (d.dimensions[0].time_zone = "America/New_York"));
    expectExactly(withoutApprovalHashes(validateProject(root)), [
      [
        "warning",
        ORDERS,
        "dimensions[0].time_zone",
        "names the zone timestamps without a time zone are stored in, but column created_at is timestamp with time zone, which carries its own; remove time_zone, and convert in expr to bucket days in another zone",
      ],
    ]);
  });
});

describe("time zones by type and dialect", () => {
  test("carriesZone", () => {
    expect(carriesZone("timestamptz", "postgres")).toBe(true);
    expect(carriesZone("timestamp", "postgres")).toBe(false);
    expect(carriesZone("TIMESTAMP_NTZ", "snowflake")).toBe(false);
    expect(carriesZone("timestamp_ltz", "snowflake")).toBe(true);
    expect(carriesZone("TIMESTAMP", "bigquery")).toBe(true);
    expect(carriesZone("DATETIME", "bigquery")).toBe(false);
    expect(carriesZone("timestamp", "databricks")).toBe(true);
    expect(carriesZone("timestamp_ntz", "databricks")).toBe(false);
    expect(carriesZone("TIMESTAMP WITH TIME ZONE", "duckdb")).toBe(true);
    expect(carriesZone("date", "duckdb")).toBeUndefined();
  });
});

describe("DuckDB source setup and views", () => {
  test("setup outside the allowlist and a view that is not one table expression are errors", async () => {
    const root = copyFixture();
    mutate(root, "sources/lake.yaml", (d) => {
      d.connection.setup = ["INSTALL httpfs", "ATTACH 'other.duckdb'", "SET enable_external_access = true"];
      d.connection.views.events = "(select * from read_csv('/etc/passwd'))";
    });
    const issues = validateProject(root).filter((i) => i.file === "sources/lake.yaml");
    expect(issues.map((i) => [i.level, i.path])).toEqual([
      ["error", "connection.setup[1]"],
      ["error", "connection.setup[2]"],
      ["error", "connection.views.events"],
    ]);
    expect(issues[0]!.message).toStartWith("is not an allowed setup statement: ");
    expect(issues[2]!.message).toStartWith("is not one table expression: ");
    const r = await sl(root, ["validate"]);
    expect(r.code).toBe(1);
  });

  test("the allowed forms validate", () => {
    const root = copyFixture();
    mutate(root, "sources/lake.yaml", (d) => {
      d.connection.setup = ["INSTALL httpfs", "LOAD httpfs", "SET threads = 2", "CREATE SECRET (TYPE s3, PROVIDER credential_chain)"];
      d.connection.views.sessions = "read_parquet('../data/lake/sessions.parquet')";
    });
    expect(validateProject(root)).toEqual([]);
  });
});

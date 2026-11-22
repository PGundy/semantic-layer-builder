// Conformed dimensions (spec: Bridges and multi-fact requests): a dimension's conforms_to says it is the
// same as a dimension of another model, so a request over both models groups each by its own one, under
// the name the request uses. On fixtures/semantics/conformed.sql in DuckDB (the totals are in its header),
// with the layer written here: the compiler, validation and its codes, the approval hash, the readback,
// semlayer conform and the edits that follow a reference, access, and the time views on PostgreSQL.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { type Compiled, type CompileResult, compileRequest, type Refused } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import type { Dimension, Model, QueryRequest } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

type Row = Record<string, unknown>;
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const compiled = (r: CompileResult): Compiled => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const refused = (r: CompileResult): Refused => {
  if (r.ok) throw new Error(`compiled: ${r.sql}`);
  return r;
};

const FIXTURE = readFileSync(join(import.meta.dir, "..", "fixtures", "semantics", "conformed.sql"), "utf8");
const statements = FIXTURE.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);

const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
const day = { type: "time", time_grains: ["day", "month", "year"] };

function layer(schema: string): Model[] {
  return [
    {
      model: "orders",
      source: "shop",
      table: `${schema}.orders`,
      ...ok,
      primary_key: ["order_id"],
      grain: "One row per order.",
      dimensions: [
        { name: "order_date", expr: "order_date", ...day, ...ok },
        { name: "ship_region", expr: "ship_region", type: "string", ...ok },
      ],
      measures: [{ name: "amount", expr: "amount_cents * 0.01", agg: "sum", description: "Order value in dollars.", ...ok }],
    },
    {
      model: "refunds",
      source: "shop",
      table: `${schema}.refunds`,
      ...ok,
      primary_key: ["refund_id"],
      grain: "One row per refund.",
      dimensions: [
        { name: "refunded_on", expr: "refunded_on", ...day, conforms_to: "orders.order_date", ...ok },
        { name: "region_code", expr: "region_code", type: "string", conforms_to: "orders.ship_region", ...ok },
      ],
      measures: [
        { name: "refunded", expr: "refunded_cents * 0.01", agg: "sum", description: "Refunded value in dollars.", ...ok },
        { name: "refund_count", agg: "count", description: "Number of refunds.", ...ok },
      ],
    },
  ] as Model[];
}

async function shop(): Promise<{ root: string; file: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const src = await duckdbSource(t.root, t.dir, "shop", statements);
  for (const m of layer("main")) writeYaml(join(t.root, "models", "shop", `${m.model}.yaml`), m);
  return { root: t.root, file: src.connection!.database!, dir: t.dir };
}

async function runDuckdb(file: string, c: { sql: string; params: unknown[] }): Promise<Row[]> {
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const cx = await instance.connect();
  try {
    const p = await cx.prepare(c.sql);
    if (c.params.length) p.bind(c.params as never[]);
    return (await p.runAndReadAll()).getRowObjectsJson() as Row[];
  } finally {
    cx.closeSync();
    instance.closeSync();
  }
}

const plain = (rows: Row[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v])));

const req = (r: Partial<QueryRequest>): QueryRequest => ({ source: "shop", ...r }) as QueryRequest;
const BY_MONTH = req({ measures: ["orders.amount", "refunds.refunded"], dimensions: ["orders.order_date:month"], order_by: [{ field: "orders.order_date:month" }] });
const BY_REGION = req({ measures: ["refunds.refunded", "orders.amount"], dimensions: ["orders.ship_region"], order_by: [{ field: "orders.ship_region" }] });
// From the fixture's header.
const MONTH_ROWS = [
  { order_date_month: "2025-01-01", amount: 30, refunded: 2 },
  { order_date_month: "2025-02-01", amount: 30, refunded: 4 },
  { order_date_month: "2025-03-01", amount: 5, refunded: null },
  { order_date_month: "2025-04-01", amount: null, refunded: 4 },
];
const REGION_ROWS = [
  { ship_region: "east", refunded: 3, amount: 40 },
  { ship_region: "north", refunded: null, amount: 5 },
  { ship_region: "south", refunded: 4, amount: null },
  { ship_region: "west", refunded: 3, amount: 20 },
];

const edit = (root: string, model: string, change: (m: Model) => void) => {
  const path = join(root, "models", "shop", `${model}.yaml`);
  const m = readYaml<Model>(path);
  change(m);
  writeYaml(path, m);
};
const dim = (m: Model, name: string) => m.dimensions.find((d) => d.name === name)! as Dimension & Record<string, unknown>;

describe("renamed dimensions group on one name", () => {
  test("by month: each part groups by its own day, the refunds CTE names its column as the request does, and a month only one side has appears once", async () => {
    const { root, file } = await shop();
    const c = compiled(compileRequest(root, BY_MONTH));
    expect(c.sql).toContain(`"refunds measures" ("order_date_month", "refunded") as (\nselect\n  cast(date_trunc('month', refunded_on) as date) as "refunded_on_month",`);
    expect(c.sql).toContain(`"orders measures" as (`);
    expect(c.columns[0]).toEqual({ name: "order_date_month", ref: "orders.order_date:month", kind: "dimension" });
    expect(plain(await runDuckdb(file, c))).toEqual(MONTH_ROWS);
  });

  test("by region from either side: conforms_to holds both ways, and the column takes the name the request gives it", async () => {
    const { root, file } = await shop();
    expect(plain(await runDuckdb(file, compiled(compileRequest(root, BY_REGION))))).toEqual(REGION_ROWS);
    const other = compiled(compileRequest(root, req({ measures: ["orders.amount", "refunds.refunded"], dimensions: ["refunds.region_code"], order_by: [{ field: "refunds.region_code" }] })));
    expect(other.sql).toContain(`"orders measures" ("region_code", "amount") as (`);
    expect(plain(await runDuckdb(file, other)).map((r) => [r.region_code, r.amount, r.refunded])).toEqual(REGION_ROWS.map((r) => [r.ship_region, r.amount, r.refunded]));
    // A filter on the dimension applies to each part through its conformed dimension.
    const f = compiled(compileRequest(root, { ...BY_REGION, filters: [{ field: "orders.ship_region", op: "in", value: ["east", "south"] }] }));
    expect(plain(await runDuckdb(file, f))).toEqual([REGION_ROWS[0]!, REGION_ROWS[2]!]);
    // semlayer validate accepts a golden grouped and filtered by a conformed dimension the first measure's model lacks.
    const made = await semlayer(root, ["goldens", "new", "--name", "by_region", "--question", "Refunds and orders by region?", "--request", JSON.stringify({ ...BY_REGION, filters: [{ field: "orders.ship_region", op: "eq", value: "east" }] })]);
    expect(made.err).toBe("");
    expect(validateProject(root).filter((i) => i.file === "goldens/by_region.yaml" && i.level === "error")).toEqual([]);
  });

  test("a to-one join path applies before a conformed dimension, so a measure's figure does not change with the measures beside it", async () => {
    const { root } = await shop();
    edit(root, "refunds", (m) => {
      (m as Model & { joins?: unknown[] }).joins = [{ name: "order", to: "orders", keys: [{ from: "refund_id", to: "order_id" }], relationship: "many_to_one", type: "left", ...ok } as never];
    });
    const alone = compiled(compileRequest(root, req({ measures: ["refunds.refunded"], dimensions: ["orders.order_date:month"] })));
    const both = compiled(compileRequest(root, BY_MONTH));
    expect(alone.sql).toContain("order_date");
    expect(alone.sql).not.toContain("refunded_on");
    expect(both.sql).not.toContain("refunded_on");
  });

  test("a draft conforms_to is not used: the request is refused as before, naming the readback that would let it", async () => {
    const { root } = await shop();
    edit(root, "refunds", (m) => {
      const d = dim(m, "region_code");
      d.status = "draft";
      delete d.approved_by;
      delete d.approved_at;
    });
    const r = refused(compileRequest(root, BY_REGION));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["no_shared_dimension", "orders.ship_region"]]);
    expect(r.refusals[0]!.next).toBe(
      "shop.refunds.region_code declares conforms_to between refunds and orders but awaits approval: read it back with semlayer readback --targets shop.refunds.region_code and approve it on the owner's yes, then run semlayer sql again.",
    );
    // With no conforms_to at all, the next step names semlayer conform among the ways to share it.
    edit(root, "refunds", (m) => void delete dim(m, "region_code").conforms_to);
    expect(refused(compileRequest(root, BY_REGION)).refusals[0]!.next).toContain("with semlayer conform");
  });

  test("two time zones are refused at compile time, join.conformed_time_zone, and warned by validate naming both", async () => {
    const { root } = await shop();
    edit(root, "orders", (m) => void (dim(m, "order_date").time_zone = "UTC"));
    edit(root, "refunds", (m) => void (dim(m, "refunded_on").time_zone = "America/New_York"));
    const r = refused(compileRequest(root, BY_MONTH));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["join.conformed_time_zone", "orders.order_date:month"]]);
    expect(r.refusals[0]!.message).toContain("orders.order_date is stored in time zone UTC and refunds.refunded_on in America/New_York");
    const w = validateProject(root).filter((i) => i.code === "join.conformed_time_zone");
    expect(w.map((i) => [i.level, i.file, i.path])).toEqual([["warning", "models/shop/refunds.yaml", "dimensions[0].conforms_to"]]);
    expect(w[0]!.message).toContain("time zone America/New_York and orders.order_date in UTC");
  });
});

describe("a time zone declared on one side only", () => {
  const unset = (root: string) => validateProject(root).filter((i) => i.code === "join.conformed_time_zone_unset");

  test("one side America/New_York and the other unset warns, naming both and the command; equal, both unset and UTC against unset are silent", async () => {
    const { root } = await shop();
    expect(unset(root)).toEqual([]);
    edit(root, "orders", (m) => void (dim(m, "order_date").time_zone = "America/New_York"));
    const w = unset(root);
    expect(w.map((i) => [i.level, i.file, i.path])).toEqual([["warning", "models/shop/refunds.yaml", "dimensions[0].conforms_to"]]);
    expect(w[0]!.message).toContain("shop.refunds.refunded_on and shop.orders.order_date are conformed");
    expect(w[0]!.message).toContain("shop.orders.order_date counts days in America/New_York and shop.refunds.refunded_on declares no time_zone");
    expect(w[0]!.message).toContain("semlayer set shop.refunds.refunded_on time_zone <zone>");
    // The other way round names the other side as the one without a zone.
    edit(root, "orders", (m) => void delete dim(m, "order_date").time_zone);
    edit(root, "refunds", (m) => void (dim(m, "refunded_on").time_zone = "America/New_York"));
    expect(unset(root)[0]!.message).toContain("semlayer set shop.orders.order_date time_zone <zone>");
    // Both set and equal, or an unset zone against UTC (an unset zone counts days in UTC), is silent.
    edit(root, "orders", (m) => void (dim(m, "order_date").time_zone = "America/New_York"));
    expect(unset(root)).toEqual([]);
    edit(root, "orders", (m) => void (dim(m, "order_date").time_zone = "UTC"));
    edit(root, "refunds", (m) => void delete dim(m, "refunded_on").time_zone);
    expect(unset(root)).toEqual([]);
  });
});

describe("grouping by both sides of a conformed pair", () => {
  const BOTH = req({ measures: ["orders.amount", "refunds.refunded"], dimensions: ["orders.order_date:month", "refunds.refunded_on:month"], order_by: [{ field: "refunds.refunded_on:month" }] });

  test("is refused with join.conformed_both_sides and the request to send instead; one grouped and the other filtered still compiles as before", async () => {
    const { root } = await shop();
    const r = refused(compileRequest(root, BOTH));
    expect(r.refusals.map((x) => [x.code, x.ref])).toEqual([["join.conformed_both_sides", "refunds.refunded_on:month"]]);
    const fixed = { ...BOTH, dimensions: ["orders.order_date:month"], order_by: [{ field: "orders.order_date:month" }] };
    expect(r.refusals[0]!.next).toBe(`Keep orders.order_date:month and drop refunds.refunded_on:month; run semlayer sql --request '${JSON.stringify(fixed)}'`);
    // The request it names compiles.
    expect(compileRequest(root, fixed as QueryRequest).ok).toBe(true);
    // Under --json: one refusal with its code and the next step.
    const j = await semlayer(root, ["sql", "--request", JSON.stringify(BOTH), "--json"]);
    expect(j.code).toBe(1);
    const out = j.json<{ ok: boolean; refusals: { code: string }[]; next: string }>();
    expect(out.ok).toBe(false);
    expect(out.refusals.map((x) => x.code)).toEqual(["join.conformed_both_sides"]);
    expect(out.next).toContain("semlayer sql --request");
    // A grouping by one and a filter on the other is legitimate.
    const f = compileRequest(root, { ...BY_MONTH, filters: [{ field: "refunds.refunded_on", op: "gte", value: "2025-01-01" }] });
    expect(f.ok).toBe(true);
    // Its SQL is the one the request compiled to before: the filter binds once in each part.
    const fsql = compiled(f);
    expect(fsql.params).toEqual(["2025-01-01", "2025-01-01"]);
    expect(fsql.columns.map((c) => c.name)).toEqual(["order_date_month", "amount", "refunded"]);
    // The suggested order_by holds the kept field once.
    const twice = refused(compileRequest(root, { ...BOTH, order_by: [{ field: "orders.order_date:month" }, { field: "refunds.refunded_on:month" }] }));
    expect(twice.refusals[0]!.next).toContain(`"order_by":[{"field":"orders.order_date:month"}]`);
    // Different grains are two columns, not one twice.
    expect(compileRequest(root, { ...BOTH, dimensions: ["orders.order_date:month", "refunds.refunded_on:year"], order_by: [] }).ok).toBe(true);
  });
});

describe("the corrected request of a both-sides refusal", () => {
  test("keeps the window and the comparison the user asked for", async () => {
    // A window and a comparison compile for a postgres source; nothing here connects to it.
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const root = t.root;
    writeYaml(join(root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "PG_URL" } });
    for (const m of layer("public")) writeYaml(join(root, "models", "shop", `${m.model}.yaml`), m);
    const base = { ...BY_MONTH, dimensions: ["orders.order_date:month", "refunds.refunded_on:month"], order_by: [] };
    const withWindow = { ...base, window: { dimension: "orders.order_date", days: 30, as_of: "2025-04-30" } } as QueryRequest;
    const w = refused(compileRequest(root, withWindow));
    expect(w.refusals.map((x) => x.code)).toEqual(["join.conformed_both_sides"]);
    expect(w.refusals[0]!.next).toContain(`"window":{"dimension":"orders.order_date","days":30,"as_of":"2025-04-30"}`);
    expect(w.refusals[0]!.next).not.toContain(`"filters"`);
    const withCompare = { ...base, dimensions: ["orders.order_date:month", "orders.ship_region", "refunds.region_code"], compare: { over: "orders.order_date:month", with: ["prior"] } } as QueryRequest;
    const c = refused(compileRequest(root, withCompare));
    expect(c.refusals[0]!.next).toContain(`"compare":{"over":"orders.order_date:month","with":["prior"]}`);
  });
});

describe("access through a conformed dimension", () => {
  test("a role that may not see the conformed dimension is refused it, and a row filter on refunds limits the refunds part", async () => {
    const { root, file } = await shop();
    writeYaml(join(root, "access.yaml"), {
      ...ok,
      mode: "open",
      roles: [
        { name: "finance", description: "Finance." },
        { name: "east_desk", description: "The east desk.", row_filters: [{ model: "shop.refunds", expr: "region_code = 'east'" }] },
      ],
      restrictions: [{ name: "regions_for_finance", description: "Refund regions are for finance only.", targets: ["shop.refunds.region_code"], allow: { roles: ["finance", "east_desk"] } }],
    });
    const nv = refused(compileRequest(root, BY_REGION, {}));
    expect([...new Set(nv.refusals.map((x) => `${x.code} ${x.ref}`))]).toEqual(["not_visible refunds.region_code"]);
    expect(compileRequest(root, BY_REGION, { role: "finance" }).ok).toBe(true);
    const east = compiled(compileRequest(root, BY_REGION, { role: "east_desk" }));
    expect(east.row_filters.map((x) => [x.part, x.model, x.in])).toEqual([["refunds", "refunds", "where"]]);
    expect(plain(await runDuckdb(file, east))).toEqual([
      { ship_region: "east", refunded: 3, amount: 40 },
      { ship_region: "north", refunded: null, amount: 5 },
      { ship_region: "west", refunded: null, amount: 20 },
    ]);
  });
});

describe("validation of conforms_to", () => {
  const codes = (root: string) => validateProject(root).filter((i) => i.code?.startsWith("join.conformed")).map((i) => [i.code, i.path]);

  test("the shop layer is valid; a type mismatch, a missing grain in common, an unknown target, a chain and two dimensions on one target each error with their code", async () => {
    const { root } = await shop();
    expect(codes(root)).toEqual([]);
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    edit(root, "refunds", (m) => void (dim(m, "region_code").conforms_to = "orders.order_date"));
    expect(codes(root)).toEqual([
      ["join.conformed_type_mismatch", "dimensions[1].conforms_to"],
      ["join.conformed_ambiguous", "dimensions[1].conforms_to"],
    ]);
    expect(validateProject(root).find((i) => i.code === "join.conformed_type_mismatch")!.message).toContain(
      "shop.refunds.region_code is a string dimension and conforms to orders.order_date, a time one, so the two cannot group as one column",
    );
    edit(root, "refunds", (m) => {
      dim(m, "region_code").conforms_to = "orders.nowhere";
      dim(m, "refunded_on").time_grains = ["hour"];
    });
    expect(codes(root)).toEqual([
      ["join.conformed_type_mismatch", "dimensions[0].conforms_to"],
      ["join.conformed_target_unknown", "dimensions[1].conforms_to"],
    ]);
    edit(root, "refunds", (m) => {
      dim(m, "region_code").conforms_to = "orders.ship_region";
      dim(m, "refunded_on").time_grains = ["day", "month"];
    });
    edit(root, "orders", (m) => void (dim(m, "ship_region").conforms_to = "refunds.region_code"));
    expect(codes(root)).toEqual([
      ["join.conformed_chain", "dimensions[1].conforms_to"],
      ["join.conformed_chain", "dimensions[1].conforms_to"],
    ]);
  });

  test("a type mismatch is refused by semlayer conform with its code, and nothing is written", async () => {
    const { root } = await shop();
    edit(root, "refunds", (m) => void delete dim(m, "region_code").conforms_to);
    const before = readFileSync(join(root, "models", "shop", "refunds.yaml"), "utf8");
    const r = await semlayer(root, ["conform", "--source", "shop", "--dimension", "refunds.region_code", "--to", "orders.order_date", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json<{ code: string }>().code).toBe("join.conformed_type_mismatch");
    expect(readFileSync(join(root, "models", "shop", "refunds.yaml"), "utf8")).toBe(before);
  });

  test("models in two schemas conform only across an approved schema pair, join.conformed_cross_schema; the compiler refuses too", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root, "two");
    const source = "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n  primary: sales\n";
    writeFileSync(join(t.root, "sources", "warehouse.yaml"), source);
    mkdirSync(join(t.root, "snapshots"), { recursive: true });
    writeFileSync(join(t.root, "snapshots", "warehouse.json"), readFileSync(join(import.meta.dir, "fixtures", "two-schemas", "snapshot.json"), "utf8"));
    const dir = join(t.root, "models", "warehouse");
    writeYaml(join(dir, "orders.yaml"), {
      model: "orders", source: "warehouse", table: "sales.orders", primary_key: ["order_id"], ...ok,
      dimensions: [{ name: "sku", expr: "sku", type: "string", conforms_to: "products.sku", ...ok }],
      measures: [{ name: "revenue", agg: "sum", expr: "amount_cents", ...ok }],
    });
    writeYaml(join(dir, "products.yaml"), {
      model: "products", source: "warehouse", table: "crm.products", primary_key: ["sku"], ...ok,
      dimensions: [{ name: "sku", expr: "sku", type: "string", ...ok }],
      measures: [{ name: "product_count", agg: "count", ...ok }],
    });
    const issue = validateProject(t.root).find((i) => i.code === "join.conformed_cross_schema")!;
    expect([issue.level, issue.path]).toEqual(["error", "dimensions[0].conforms_to"]);
    expect(issue.message).toContain("orders is in schema sales and products in crm, and no approved schema pair joins them");
    const r = refused(compileRequest(t.root, { source: "warehouse", measures: ["products.product_count", "orders.revenue"], dimensions: ["products.sku"] }));
    expect(r.refusals.map((x) => x.code)).toEqual(["scope.cross_schema_undeclared"]);
    // An approved pair between the two schemas allows it.
    const pair = { from: "sales", to: "crm", keys: [{ from: "orders.sku", to: "products.sku" }] };
    const stamp = { status: "approved", approved_by: "Dana", approved_at: "2026-01-15", approved_hash: itemHash("schema-pair", { ...pair, status: "draft" }) };
    writeYaml(join(t.root, "sources", "warehouse.yaml"), { source: "warehouse", dialect: "postgres", connection: { env: "WAREHOUSE_URL" }, intake: { schemas: ["sales", "crm"], primary: "sales" }, cross_schema: [{ ...pair, ...stamp }] });
    expect(validateProject(t.root).filter((i) => i.code === "join.conformed_cross_schema")).toEqual([]);
    expect(compileRequest(t.root, { source: "warehouse", measures: ["products.product_count", "orders.revenue"], dimensions: ["products.sku"] }).ok).toBe(true);
  });
});

describe("approval", () => {
  test("the approval hash changes with conforms_to, and is unchanged for a dimension without it", () => {
    const d = { name: "refunded_on", expr: "refunded_on", type: "time", time_grains: ["day"], status: "draft" };
    const scope = { source: "shop", model: { model: "refunds", table: "main.refunds" } };
    const plainHash = itemHash("dimension", d, scope);
    expect(itemHash("dimension", { ...d, conforms_to: "orders.order_date" }, scope)).not.toBe(plainHash);
    expect(itemHash("dimension", { ...d, conforms_to: "orders.order_date" }, scope)).not.toBe(itemHash("dimension", { ...d, conforms_to: "orders.ship_date" }, scope));
    // A layer approved before conforms_to existed keeps its hashes.
    expect(plainHash).toBe(itemHash("dimension", { ...d }, scope));
  });

  test("semlayer conform writes conforms_to as a draft edit, sends an approved dimension back for the owner's yes, and its readback states it; set --unset removes it", async () => {
    const { root } = await shop();
    edit(root, "refunds", (m) => void delete dim(m, "refunded_on").conforms_to);
    const file = join(root, "models", "shop", "refunds.yaml");
    // The layer records approval hashes, so an edit to an approved dimension shows.
    expect((await semlayer(root, ["approve", "--stamp-hashes"])).code).toBe(0);
    const before = readFileSync(file, "utf8");
    const r = await semlayer(root, ["conform", "--source", "shop", "--dimension", "refunds.refunded_on", "--to", "orders.order_date"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("Set conforms_to orders.order_date on shop.refunds.refunded_on in models/shop/refunds.yaml.");
    expect(r.out).toContain("shop.refunds.refunded_on is approved and changed since its approval");
    expect(r.out).toContain("Next: semlayer readback --targets shop.refunds.refunded_on");
    expect(dim(readYaml<Model>(file), "refunded_on").conforms_to).toBe("orders.order_date");
    expect(validateProject(root).filter((i) => i.code === "approval.hash_changed").map((i) => [i.file, i.path])).toEqual([["models/shop/refunds.yaml", "dimensions[0]"]]);
    // Until the owner approves it again, the compiler does not use it.
    expect(refused(compileRequest(root, BY_MONTH)).refusals[0]!.next).toContain("awaits approval: read it back with semlayer readback --targets shop.refunds.refunded_on");
    // Running it again changes nothing.
    expect((await semlayer(root, ["conform", "--source", "shop", "--dimension", "refunds.refunded_on", "--to", "orders.order_date"])).out).toContain("nothing changed");
    const rb = await semlayer(root, ["readback", "--targets", "shop.refunds.refunded_on"]);
    expect(rb.out).toContain(
      "- Treated as the same as orders.order_date when a question combines refunds with orders: a request grouped by either groups refunds by this dimension.",
    );
    const off = await semlayer(root, ["set", "shop.refunds.refunded_on", "conforms_to", "--unset"]);
    expect(off.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("semlayer apply runs conform; it refuses a target that is not a dimension of another model", async () => {
    const { root, dir } = await shop();
    const edits = join(dir, "edits.json");
    writeFileSync(edits, JSON.stringify({ edits: [["conform", "--source", "shop", "--dimension", "refunds.refunded_on", "--to", "refunds.region_code"]] }));
    const r = await semlayer(root, ["apply", "--file", edits]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("both dimensions of model refunds");
    const missing = await semlayer(root, ["conform", "--source", "shop", "--dimension", "refunds.refunded_on", "--to", "orders.amount"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("shop.orders.amount is a measure, not a dimension");
  });
});

describe("edits that follow the reference", () => {
  test("renaming the target dimension or its model rewrites conforms_to; removing it is refused, naming the dimension that conforms to it", async () => {
    const { root } = await shop();
    const refunds = () => readYaml<Model>(join(root, "models", "shop", "refunds.yaml"));
    const rn = await semlayer(root, ["rename", "shop.orders.order_date", "ordered_on"]);
    expect(rn.code).toBe(0);
    expect(dim(refunds(), "refunded_on").conforms_to).toBe("orders.ordered_on");
    const rm = await semlayer(root, ["rename", "shop.orders", "sales"]);
    expect(rm.err).toBe("");
    expect([dim(refunds(), "refunded_on").conforms_to, dim(refunds(), "region_code").conforms_to]).toEqual(["sales.ordered_on", "sales.ship_region"]);
    const gone = await semlayer(root, ["remove-field", "shop.sales.ship_region", "--force"]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain("models/shop/refunds.yaml dimensions[1].conforms_to: sales.ship_region");
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("time views over a conformed time dimension (postgres)", () => {
  test.skipIf(!PG_URL)("a running total by month compiles over both parts; a conformed dimension at another grain is refused as the same field would be", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("t_conformed");
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      await db.unsafe(`create schema ${schema}`);
      await db.unsafe(`set search_path to ${schema}`);
      await db.unsafe(FIXTURE);
      await db.unsafe("set search_path to default");
      const t = tempRoot();
      cleanup = t.cleanup;
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "PG_URL" } });
      for (const m of layer(schema)) writeYaml(join(t.root, "models", "shop", `${m.model}.yaml`), m);
      const running = compiled(compileRequest(t.root, { ...BY_MONTH, running: { over: "orders.order_date:month" } }));
      expect(running.columns.map((c) => c.name)).toEqual(["order_date_month", "amount", "refunded", "amount_running", "refunded_running"]);
      const rows = plain(
        (await db.begin("read only", async (tx) => [...((await tx.unsafe(running.sql, running.params as never[])) as Row[])])).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])),
        ),
      );
      // January to April, the running totals of the fixture's monthly figures.
      expect(rows.map((r) => [r.order_date_month, r.amount_running, r.refunded_running])).toEqual([
        ["2025-01-01", 30, 2],
        ["2025-02-01", 60, 6],
        ["2025-03-01", 65, 6],
        ["2025-04-01", 65, 10],
      ]);
      const mixed = refused(compileRequest(t.root, { ...BY_MONTH, dimensions: ["orders.order_date:month", "refunds.refunded_on:day"], running: { over: "orders.order_date:month" } }));
      expect(mixed.refusals.map((x) => [x.code, x.ref])).toEqual([["invalid_request", "refunds.refunded_on:day"]]);
      expect(mixed.refusals[0]!.message).toContain("the same field as running.over at another grain");
    } finally {
      await db.unsafe(`drop schema if exists ${schema} cascade`);
      await db.close();
    }
  });
});

// The drift record (spec: Iterating a layer, The drift record): semlayer introspect keeps the last change
// and each retyped column an approved field reads in .semlayer/drift.json, semlayer validate warns
// release.column_retyped on the field until it is edited or approved again, and a failed introspect
// leaves the record as it was.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { type DriftInput, nextEntry } from "../skills/semantic-layer/scripts/lib/drift-record.ts";
import { approveWithYes, duckdbSource, initProject, semlayer, tempDir, tempRoot } from "./helpers.ts";

const SCHEMA = JSON.parse(readFileSync(join(import.meta.dir, "..", "skills", "semantic-layer", "schemas", "drift.schema.json"), "utf8")) as object;
const validRecord = new Ajv2020({ allErrors: true, strictTypes: false }).compile(SCHEMA);
const DRIFT = join(".semlayer", "drift.json");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const ORDERS = `model: orders
source: wh
table: main.orders
status: draft
grain: One row per order.
primary_key: [order_id]
dimensions:
  - name: order_status
    expr: status
    type: string
    status: draft
measures:
  - name: revenue
    expr: amount_cents / 100.0
    agg: sum
    description: Order value in dollars.
    status: draft
  - name: order_count
    agg: count
    description: Number of orders.
    status: draft
`;

interface Issue {
  level: string;
  file: string;
  path: string;
  message: string;
  code: string;
  next?: string;
}

async function run(db: string, statements: string[]): Promise<void> {
  const instance = await DuckDBInstance.create(db);
  const c = await instance.connect();
  for (const s of statements) await c.run(s);
  c.closeSync();
  instance.closeSync();
}

// A layer over one DuckDB table, introspected, with revenue (reads amount_cents) and order_count approved.
async function layer(): Promise<{ root: string; db: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", [
    "create table orders (order_id integer primary key, status varchar, amount_cents integer, shipping_cents integer, note varchar)",
    "insert into orders values (1, 'paid', 1250, 300, 'a'), (2, 'paid', 4000, 0, 'b')",
  ]);
  expect((await semlayer(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
  mkdirSync(join(t.root, "models", "wh"), { recursive: true });
  writeFileSync(join(t.root, "models", "wh", "orders.yaml"), ORDERS);
  for (const ref of ["wh.orders.revenue", "wh.orders.order_count"]) expect((await approveWithYes(t.root, ["--target", ref, "--by", "Dana"])).code).toBe(0);
  return { root: t.root, db: join(t.dir, "wh.duckdb") };
}

// amount_cents (read by revenue) and shipping_cents (read by nothing) retyped, note dropped, gift added.
const CHANGE = [
  "alter table orders alter amount_cents type decimal(12,2)",
  "alter table orders alter shipping_cents type bigint",
  "alter table orders drop column note",
  "alter table orders add column gift varchar",
];

const retypedIssues = async (root: string) =>
  (await semlayer(root, ["validate", "--json"])).json<{ issues: Issue[] }>().issues.filter((i) => i.code === "release.column_retyped");
const record = (root: string) => JSON.parse(readFileSync(join(root, DRIFT), "utf8")) as { sources: { source: string; diff: unknown; retyped: { column: string; reads: { ref: string }[] }[] }[] };

describe("the drift record", () => {
  test("introspect records added, removed and retyped columns; a second run keeps the retype; re-approving the field clears it", async () => {
    const { root, db } = await layer();
    // The first introspect had no previous snapshot, so there was nothing to record.
    expect(existsSync(join(root, DRIFT))).toBe(false);
    expect(await retypedIssues(root)).toEqual([]);

    await run(db, CHANGE);
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    const first = readFileSync(join(root, DRIFT), "utf8");
    const data = JSON.parse(first) as unknown;
    expect(validRecord(data)).toBe(true);
    expect(data).toMatchObject({
      version: 1,
      sources: [
        {
          source: "wh",
          at: "2026-01-15T12:00:00.000Z",
          diff: {
            tables_added: [],
            tables_removed: [],
            columns: [
              {
                table: "main.orders",
                added: [{ name: "gift", type: "VARCHAR" }],
                removed: ["note"],
                retyped: [
                  { name: "amount_cents", from: "INTEGER", to: "DECIMAL(12,2)" },
                  { name: "shipping_cents", from: "INTEGER", to: "BIGINT" },
                ],
              },
            ],
          },
          // Only the column an approved field reads stays open.
          retyped: [{ table: "main.orders", column: "amount_cents", from: "INTEGER", to: "DECIMAL(12,2)", at: "2026-01-15T12:00:00.000Z", reads: [{ ref: "wh.orders.revenue" }] }],
        },
      ],
    });
    // Names and types only: no row value of the table.
    for (const value of ["1250", "4000", "paid"]) expect(first).not.toContain(value);

    const issues = await retypedIssues(root);
    expect(issues).toEqual([
      {
        level: "warning",
        file: "models/wh/orders.yaml",
        path: "measures[0]",
        message: expect.stringContaining("wh.orders.revenue reads main.orders.amount_cents, which changed from INTEGER to DECIMAL(12,2)"),
        code: "release.column_retyped",
        next: "semlayer readback --targets wh.orders.revenue",
      },
    ]);

    // A second identical run changes nothing and keeps the warning.
    expect((await semlayer(root, ["introspect", "--source", "wh"], { SEMLAYER_NOW: "2026-01-16T12:00:00.000Z" })).code).toBe(0);
    expect(readFileSync(join(root, DRIFT), "utf8")).toBe(first);
    expect(await retypedIssues(root)).toHaveLength(1);

    // The owner's yes to the field as it stands approves it again: the warning goes, and the next
    // introspect closes the retype in the record while keeping the last change.
    expect((await approveWithYes(root, ["--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(0);
    expect(await retypedIssues(root)).toEqual([]);
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    const after = record(root);
    expect(after.sources[0]!.retyped).toEqual([]);
    expect(after.sources[0]!.diff).toEqual((JSON.parse(first) as { sources: { diff: unknown }[] }).sources[0]!.diff);
  });

  test("editing the field clears its warning", async () => {
    const { root, db } = await layer();
    await run(db, CHANGE);
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    expect(await retypedIssues(root)).toHaveLength(1);
    const file = join(root, "models", "wh", "orders.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("expr: amount_cents / 100.0", "expr: amount_cents"));
    expect(await retypedIssues(root)).toEqual([]);
  });

  test("a failed introspect leaves the record as it was", async () => {
    const { root, db } = await layer();
    await run(db, CHANGE);
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    const before = readFileSync(join(root, DRIFT), "utf8");
    const snapshot = readFileSync(join(root, "snapshots", "wh.json"), "utf8");
    const bad = join(tempDir("drift-bad"), "results.json");
    writeFileSync(bad, "{ not json");
    const r = await semlayer(root, ["introspect", "--source", "wh", "--results", bad]);
    expect(r.code).toBe(1);
    expect(readFileSync(join(root, DRIFT), "utf8")).toBe(before);
    expect(readFileSync(join(root, "snapshots", "wh.json"), "utf8")).toBe(snapshot);
  });

  test("a .semlayer link outside the root is refused, and neither the record nor the snapshot is written", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const db = join(t.dir, "wh.duckdb");
    await duckdbSource(t.root, t.dir, "wh", ["create table orders (order_id integer, amount_cents integer)"]);
    expect((await semlayer(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
    const snapshot = readFileSync(join(t.root, "snapshots", "wh.json"), "utf8");
    await run(db, ["alter table orders add column note varchar"]);
    const outside = tempDir("drift-outside");
    symlinkSync(outside, join(t.root, ".semlayer"));
    const r = await semlayer(t.root, ["introspect", "--source", "wh"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Refusing to write .semlayer/drift.json: .semlayer resolves outside the semantic root");
    expect(existsSync(join(outside, "drift.json"))).toBe(false);
    expect(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")).toBe(snapshot);
  });
});

describe("nextEntry", () => {
  const input = (over: Partial<DriftInput>): DriftInput => ({
    source: "pg",
    dialect: "postgres",
    snapshot: { source: "pg", dialect: "postgres", captured_at: "x", tables: [] } as unknown as DriftInput["snapshot"],
    diff: { tables_added: [], tables_removed: ["s.gone", "s.hidden"], columns: [] },
    at: "2026-01-15T12:00:00.000Z",
    unreadable: ["s.hidden", "s.other"],
    models: () => [],
    ...over,
  });

  test("a removed table the role cannot read is listed as unreadable, apart from a dropped one", () => {
    const e = nextEntry(undefined, input({}), new Map(), []);
    expect(e).toMatchObject({ source: "pg", diff: { tables_removed: ["s.gone", "s.hidden"] }, unreadable: ["s.hidden"], retyped: [] });
  });

  test("a run with no change and no record writes nothing; one with a record keeps its change", () => {
    const none = input({ diff: { tables_added: [], tables_removed: [], columns: [] } });
    expect(nextEntry(undefined, none, new Map(), [])).toBeUndefined();
    const prior = nextEntry(undefined, input({}), new Map(), [])!;
    expect(nextEntry(prior, { ...none, at: "later" }, new Map(), [])).toEqual(prior);
  });
});

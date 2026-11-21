// semlayer import records the drift record when it replaces a snapshot, and a plain import never replaces a
// snapshot read from the database (spec: The drift record; the CLI table, import).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { sameTypeFamily } from "../skills/semantic-layer/scripts/lib/column-types.ts";
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
`;

interface Issue {
  code: string;
}

// A DuckDB source introspected once, with revenue (reads amount_cents) approved.
async function layer(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", [
    "create table orders (order_id integer primary key, status varchar, amount_cents decimal(10,2))",
    "insert into orders values (1, 'paid', 12.50)",
  ]);
  expect((await semlayer(t.root, ["introspect", "--source", "wh"])).code).toBe(0);
  mkdirSync(join(t.root, "models", "wh"), { recursive: true });
  writeFileSync(join(t.root, "models", "wh", "orders.yaml"), ORDERS);
  expect((await approveWithYes(t.root, ["--target", "wh.orders.revenue", "--by", "Dana"])).code).toBe(0);
  return { root: t.root, dir: t.dir };
}

const csv = (dir: string, name: string, rows: [string, string][]): string => {
  const file = join(dir, name);
  const head = "table_schema,table_name,column_name,data_type,is_nullable,ordinal_position";
  writeFileSync(file, [head, ...rows.map(([c, t], i) => `main,orders,${c},${t},YES,${i + 1}`)].join("\n") + "\n");
  return file;
};

// A manifest of the same table, with no catalog: no column has a type.
const manifestFile = (dir: string, withTypes: string | null): string => {
  const file = join(dir, "manifest.json");
  const col = (name: string) => ({ name, ...(withTypes && name === "amount_cents" ? { data_type: withTypes } : {}) });
  writeFileSync(
    file,
    JSON.stringify({
      metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json", adapter_type: "duckdb" },
      nodes: {
        "model.p.orders": {
          unique_id: "model.p.orders",
          resource_type: "model",
          name: "orders",
          database: "wh",
          schema: "main",
          alias: "orders",
          relation_name: '"wh"."main"."orders"',
          config: { materialized: "table" },
          columns: { order_id: col("order_id"), status: col("status"), amount_cents: col("amount_cents") },
        },
      },
    }),
  );
  return file;
};

const retypedIssues = async (root: string) => (await semlayer(root, ["validate", "--json"])).json<{ issues: Issue[] }>().issues.filter((i) => i.code === "release.column_retyped");
const record = (root: string) => JSON.parse(readFileSync(join(root, DRIFT), "utf8")) as { sources: { methods?: { from: string; to: string }; retyped: { column: string; from: string; to: string }[]; diff: { columns: { retyped: unknown[] }[] } }[] };
const snap = (root: string) => readFileSync(join(root, "snapshots", "wh.json"), "utf8");

describe("semlayer import records the drift record", () => {
  test("a retyped column in an export is recorded, with where each snapshot came from, and validate warns", async () => {
    const { root, dir } = await layer();
    expect(existsSync(join(root, DRIFT))).toBe(false);
    const file = csv(dir, "schema.csv", [["order_id", "integer"], ["status", "varchar"], ["amount_cents", "double"]]);
    const r = await semlayer(root, ["import", "--source", "wh", "--file", file, "--replace-snapshot"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("retyped amount_cents");
    const data = record(root);
    expect(validRecord(JSON.parse(readFileSync(join(root, DRIFT), "utf8")))).toBe(true);
    expect(data.sources[0]!.methods).toEqual({ from: "live", to: "information_schema" });
    expect(data.sources[0]!.retyped).toMatchObject([{ column: "amount_cents", from: "DECIMAL(10,2)", to: "double" }]);
    expect(await retypedIssues(root)).toHaveLength(1);
    // The same file again changes nothing.
    const before = readFileSync(join(root, DRIFT), "utf8");
    expect((await semlayer(root, ["import", "--source", "wh", "--file", file])).code).toBe(0);
    expect(readFileSync(join(root, DRIFT), "utf8")).toBe(before);
  });

  test("a manifest that knows no types, and a spelling-only difference, record no retyped column", async () => {
    const { root, dir } = await layer();
    const r = await semlayer(root, ["import", "--source", "wh", "--file", manifestFile(dir, null), "--replace-snapshot"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("retyped");
    expect(existsSync(join(root, DRIFT)) ? record(root).sources[0]!.diff.columns.flatMap((c) => c.retyped) : []).toEqual([]);
    expect(await retypedIssues(root)).toEqual([]);

    // Back from the database, then a file that spells every type differently.
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    const spelled = csv(dir, "spelled.csv", [["order_id", "int4"], ["status", "character varying"], ["amount_cents", "numeric"]]);
    const s = await semlayer(root, ["import", "--source", "wh", "--file", spelled, "--replace-snapshot"]);
    expect(s.code).toBe(0);
    expect(s.out).not.toContain("retyped");
    expect(await retypedIssues(root)).toEqual([]);
  });

  test("a manifest with a catalog type that really differs records one", async () => {
    const { root, dir } = await layer();
    const file = manifestFile(dir, "text");
    const r = await semlayer(root, ["import", "--source", "wh", "--file", file, "--replace-snapshot"]);
    expect(r.code).toBe(0);
    expect(record(root).sources[0]!.retyped).toMatchObject([{ column: "amount_cents" }]);
    expect(record(root).sources[0]!.methods).toEqual({ from: "live", to: "dbt_manifest" });
    expect(await retypedIssues(root)).toHaveLength(1);
  });

  test("a catalog passed with --catalog and a type that really differs records one", async () => {
    const { root, dir } = await layer();
    const catalog = join(dir, "catalog.json");
    const col = (name: string, index: number, type: string) => ({ type, index, name });
    writeFileSync(
      catalog,
      JSON.stringify({
        nodes: {
          "model.p.orders": {
            metadata: { type: "table", schema: "main", name: "orders", database: "wh" },
            columns: { order_id: col("order_id", 1, "INTEGER"), status: col("status", 2, "VARCHAR"), amount_cents: col("amount_cents", 3, "VARCHAR") },
          },
        },
      }),
    );
    const r = await semlayer(root, ["import", "--source", "wh", "--file", manifestFile(dir, null), "--catalog", catalog, "--replace-snapshot"]);
    expect(r.code).toBe(0);
    expect(record(root).sources[0]!.retyped).toMatchObject([{ column: "amount_cents", to: "VARCHAR" }]);
    expect(await retypedIssues(root)).toHaveLength(1);
  });

  test("going back to the database after a file import records no spelling-only retype", async () => {
    const { root, dir } = await layer();
    const spelled = csv(dir, "spelled.csv", [["order_id", "int4"], ["status", "character varying"], ["amount_cents", "numeric"]]);
    expect((await semlayer(root, ["import", "--source", "wh", "--file", spelled, "--replace-snapshot"])).code).toBe(0);
    const back = await semlayer(root, ["introspect", "--source", "wh"]);
    expect(back.code).toBe(0);
    expect(back.out).not.toContain("retyped");
    expect(await retypedIssues(root)).toEqual([]);
  });

  test("two exports of one kind compare exactly: varchar to text is a retype", async () => {
    const { root, dir } = await layer();
    const a = csv(dir, "a.csv", [["order_id", "integer"], ["status", "character varying"], ["amount_cents", "numeric"]]);
    expect((await semlayer(root, ["import", "--source", "wh", "--file", a, "--replace-snapshot"])).code).toBe(0);
    const b = csv(dir, "b.csv", [["order_id", "integer"], ["status", "text"], ["amount_cents", "numeric"]]);
    const r = await semlayer(root, ["import", "--source", "wh", "--file", b]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("retyped status");
  });

  test("the type comparison: unknown, spelling, family and stated precision", () => {
    expect(sameTypeFamily("numeric(10,2)", "numeric")).toBe(true);
    expect(sameTypeFamily("NUMBER(38,0)", "numeric")).toBe(true);
    expect(sameTypeFamily("character varying", "varchar(20)")).toBe(true);
    expect(sameTypeFamily("integer", "unknown")).toBe(true);
    expect(sameTypeFamily("integer", "bigint")).toBe(false);
    expect(sameTypeFamily("numeric(10,2)", "numeric(12,2)")).toBe(false);
  });
});

describe("a plain import does not replace a snapshot read from the database", () => {
  test("it is refused with nothing written, names the three ways on, and carries a code and next under --json", async () => {
    const { root, dir } = await layer();
    const file = csv(dir, "schema.csv", [["order_id", "integer"], ["status", "varchar"], ["amount_cents", "double"]]);
    const before = snap(root);
    const r = await semlayer(root, ["import", "--source", "wh", "--file", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nothing was written");
    expect(r.err).toContain("1 with a primary key");
    expect(r.err).toContain("semlayer introspect --source wh");
    expect(r.err).not.toContain("--semantic");
    expect(r.err).toContain("rerun the same command with --replace-snapshot");
    expect(snap(root)).toBe(before);
    expect(existsSync(join(root, DRIFT))).toBe(false);
    const j = await semlayer(root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(j.code).toBe(1);
    expect(j.json<{ code: string; next: string }>()).toMatchObject({ code: "snapshot_from_database", next: "semlayer introspect --source wh" });
    expect(snap(root)).toBe(before);

    // With the flag it replaces, and the record is written.
    expect((await semlayer(root, ["import", "--source", "wh", "--file", file, "--replace-snapshot"])).code).toBe(0);
    expect(snap(root)).not.toBe(before);
    expect(JSON.parse(snap(root)).method).toBe("information_schema");
    expect(existsSync(join(root, DRIFT))).toBe(true);
    // A snapshot made from a file is then refreshed by a plain import.
    expect((await semlayer(root, ["import", "--source", "wh", "--file", file])).code).toBe(0);
  });

  test("--semantic keeps the database snapshot without the flag and writes no record", async () => {
    const { root, dir } = await layer();
    const before = snap(root);
    const r = await semlayer(root, ["import", "--source", "wh", "--file", manifestFile(dir, null), "--semantic"]);
    expect(r.code).toBe(0);
    expect(snap(root)).toBe(before);
    expect(existsSync(join(root, DRIFT))).toBe(false);
    const both = await semlayer(root, ["import", "--source", "wh", "--file", manifestFile(dir, null), "--semantic", "--replace-snapshot"]);
    expect(both.code).toBe(0);
    expect(both.out).toContain("--replace-snapshot was not used");
    expect(snap(root)).toBe(before);
  });

  test("an export source and a source with no snapshot import as before", async () => {
    const { root, dir } = await layer();
    appendFileSync(join(root, "sources", "wh.yaml"), "intake:\n  mode: export\n  reason: test\n");
    const file = csv(dir, "schema.csv", [["order_id", "integer"], ["status", "varchar"], ["amount_cents", "double"]]);
    expect((await semlayer(root, ["import", "--source", "wh", "--file", file])).code).toBe(0);

    const t = tempRoot();
    const old = cleanup;
    cleanup = () => {
      old?.();
      t.cleanup();
    };
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders (order_id integer)"]);
    const first = await semlayer(t.root, ["import", "--source", "wh", "--file", csv(tempDir("imp"), "s.csv", [["order_id", "integer"]])]);
    expect(first.code).toBe(0);
    expect(existsSync(join(t.root, DRIFT))).toBe(false);
  });
});

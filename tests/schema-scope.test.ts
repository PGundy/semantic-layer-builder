// The primary schema and kept constraint names (spec: Schema scope).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { buildSnapshot } from "../skills/semantic-layer/scripts/lib/introspect.ts";
import { crossSchemaFks, primarySchema } from "../skills/semantic-layer/scripts/lib/schema-scope.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "two-schemas", "snapshot.json");
const twoSchemas = (): Snapshot => JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
const table = (schema: string | null, name = "t"): SnapshotTable => ({ schema, name, kind: "table", columns: [] });

describe("primarySchema", () => {
  const src = (intake?: SourceConfig["intake"]): SourceConfig => ({ source: "wh", dialect: "postgres", ...(intake ? { intake } : {}) });

  test("is intake.primary when set, else the only schema read, and never a guess", () => {
    expect(primarySchema(src({ schemas: ["sales", "crm"], primary: "sales" }))).toBe("sales");
    expect(primarySchema(src({ schemas: ["sales"] }))).toBe("sales");
    expect(primarySchema(src({ schemas: ["sales", "crm"] }), twoSchemas())).toBeUndefined();
  });

  test("with no schema list, is the snapshot's only schema", () => {
    expect(primarySchema(src(), { tables: [table("main", "a"), table("main", "b")] })).toBe("main");
    expect(primarySchema(src({ schemas: [] }), { tables: [table("main")] })).toBe("main");
    expect(primarySchema(src(), twoSchemas())).toBeUndefined();
    expect(primarySchema(src(), { tables: [table(null)] })).toBeUndefined();
    expect(primarySchema(src())).toBeUndefined();
  });
});

describe("crossSchemaFks", () => {
  test("lists the declared keys that leave their table's schema, with the constraint", () => {
    const found = crossSchemaFks(twoSchemas());
    expect(found.map((x) => ({ table: `${x.table.schema}.${x.table.name}`, from: x.from_schema, to: x.to_schema, constraint: x.fk.constraint }))).toEqual([
      { table: "sales.orders", from: "sales", to: "crm", constraint: "orders_customer_fk" },
    ]);
  });

  test("a key with no referenced schema stays in its table's schema", () => {
    const t: SnapshotTable = { ...table("sales", "orders"), foreign_keys: [{ columns: ["c"], references: { table: "customers", columns: ["id"] } }] };
    expect(crossSchemaFks({ tables: [t] })).toEqual([]);
  });
});

describe("snapshots keep the constraint name", () => {
  const row = (constraint_name: string | null, column_name: string, ordinal_position = 1) => ({
    constraint_name,
    table_schema: "sales",
    table_name: "orders",
    column_name,
    ref_schema: "crm",
    ref_table: "customers",
    ref_column: "id",
    ordinal_position,
  });
  const results = (fks: Record<string, unknown>[]) => ({
    tables: [
      { table_schema: "sales", table_name: "orders", table_type: "BASE TABLE" },
      { table_schema: "crm", table_name: "customers", table_type: "BASE TABLE" },
    ],
    columns: [],
    primary_keys: [],
    foreign_keys: fks,
  });
  const src: SourceConfig = { source: "wh", dialect: "postgres" };
  const fksOf = (s: Snapshot) => s.tables.find((t) => t.name === "orders")!.foreign_keys;

  test("a named key keeps its name; an unnamed one has none", () => {
    const named = buildSnapshot(src, results([row("orders_customer_fk", "customer_id")]), "2026-01-15T12:00:00.000Z", null);
    expect(fksOf(named)).toEqual([{ columns: ["customer_id"], references: { schema: "crm", table: "customers", columns: ["id"] }, constraint: "orders_customer_fk" }]);
    const unnamed = buildSnapshot(src, results([row(null, "customer_id")]), "2026-01-15T12:00:00.000Z", null);
    expect(fksOf(unnamed)).toEqual([{ columns: ["customer_id"], references: { schema: "crm", table: "customers", columns: ["id"] } }]);
  });

  test("two keys of the same columns and target are one, under the first name", () => {
    const s = buildSnapshot(src, results([row("b_fk", "customer_id"), row("a_fk", "customer_id")]), "2026-01-15T12:00:00.000Z", null);
    expect(fksOf(s)!.map((fk) => fk.constraint)).toEqual(["a_fk"]);
  });

  test("a named key wins over an unnamed one of the same columns and target", () => {
    const s = buildSnapshot(src, results([row(null, "customer_id"), row("named_fk", "customer_id")]), "2026-01-15T12:00:00.000Z", null);
    expect(fksOf(s)!.map((fk) => fk.constraint)).toEqual(["named_fk"]);
  });

  test("a snapshot without constraint names, and one with them, both validate", async () => {
    const { root } = tempRoot();
    await initProject(root, "two");
    writeFileSync(join(root, "sources", "warehouse.yaml"), "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n");
    mkdirSync(join(root, "snapshots"), { recursive: true });
    const snap = twoSchemas();
    for (const withNames of [true, false]) {
      if (!withNames) for (const t of snap.tables) for (const fk of t.foreign_keys ?? []) delete fk.constraint;
      writeFileSync(join(root, "snapshots", "warehouse.json"), JSON.stringify(snap));
      const r = await semlayer(root, ["validate", "--json"]);
      const issues = r.json<{ issues: { path?: string; file?: string; message: string }[] }>().issues ?? [];
      expect(issues.filter((i) => JSON.stringify(i).includes("snapshots/"))).toEqual([]);
    }
    const bad = twoSchemas();
    bad.tables.find((t) => t.name === "orders")!.foreign_keys![0]!.constraint = "";
    writeFileSync(join(root, "snapshots", "warehouse.json"), JSON.stringify(bad));
    const r = await semlayer(root, ["validate", "--json"]);
    expect(JSON.stringify(r.json())).toContain("snapshots/warehouse.json");
  });
});

describe("setup --primary", () => {
  const lake = async () => {
    const { root, dir } = tempRoot();
    mkdirSync(root, { recursive: true });
    await duckdbSource(root, dir, "lake", [
      "create schema sales",
      "create table sales.orders (order_id integer primary key, amount integer)",
      "create schema crm",
      "create table crm.customers (customer_id integer primary key)",
    ]);
    return { root, db: join(dir, "lake.duckdb") };
  };

  test("writes intake.primary, prints it and names it in --json; the same arguments again change nothing", async () => {
    const { root, db } = await lake();
    const args = ["setup", "--source", "lake", "--dialect", "duckdb", "--database", db, "--schemas", "sales,crm"];
    const r = await semlayer(root, [...args, "--primary", "sales"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Primary schema: sales.");
    expect(readYaml<SourceConfig>(join(root, "sources", "lake.yaml")).intake).toMatchObject({ schemas: ["sales", "crm"], primary: "sales" });
    const again = await semlayer(root, [...args, "--primary", "sales", "--json"]);
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({ changed: false, intake: { primary: "sales" }, source: { changes: { primary: false } } });
    // Left out, the file's primary stays.
    const kept = await semlayer(root, [...args, "--json"]);
    expect(kept.json()).toMatchObject({ changed: false, intake: { primary: "sales" } });
    const moved = await semlayer(root, [...args, "--primary", "crm"]);
    expect(moved.out).toContain("  intake.primary: crm");
  });

  test("without --primary, the only schema read is the primary, and two schemas have none", async () => {
    const { root, db } = await lake();
    const one = await semlayer(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--database", db, "--schemas", "sales"]);
    expect(one.out).toContain("Primary schema: sales (the only schema read).");
    const two = await semlayer(root, ["setup", "--source", "lake", "--dialect", "duckdb", "--database", db, "--schemas", "sales,crm", "--json"]);
    expect(two.json()).toMatchObject({ intake: { schemas: ["sales", "crm"], primary: null } });
    expect(readYaml<SourceConfig>(join(root, "sources", "lake.yaml")).intake?.primary).toBeUndefined();
  });

  test("refuses a name that is not a schema name, and one missing from the schemas read, naming the fix and writing nothing", async () => {
    const { root, db } = await lake();
    const base = ["setup", "--source", "lake", "--dialect", "duckdb", "--database", db, "--schemas", "sales"];
    const bad = await semlayer(root, [...base, "--primary", "no such"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--primary needs one schema name; write a plain identifier such as analytics");
    const missing = await semlayer(root, [...base, "--primary", "crm"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(
      "The primary schema crm is not among the schemas read (sales), so the layer could not read it. Run semlayer setup again with --schemas sales,crm, or with --primary set to one of them.",
    );
    expect(readFileSync(join(root, "sources", "lake.yaml"), "utf8")).not.toContain("primary");
  });

  test("keeps the owner's comments in the source file", async () => {
    const { root, db } = await lake();
    const args = ["setup", "--source", "lake", "--dialect", "duckdb", "--database", db, "--schemas", "sales,crm"];
    expect((await semlayer(root, args)).code).toBe(0);
    const file = join(root, "sources", "lake.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("intake:", "# Agreed with the owner.\nintake:"));
    expect((await semlayer(root, [...args, "--primary", "sales"])).code).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# Agreed with the owner.\nintake:");
    expect(text).toMatch(/schemas:[\s\S]*primary: sales/);
  });
});

describe("introspect keeps constraint names: postgres", () => {
  let pg: SQL | undefined;
  let a = "";
  let b = "";

  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    a = uniqueSchema("g1_sales");
    b = uniqueSchema("g1_crm");
    pg = new SQL(PG_URL);
    await pg.unsafe(`create schema ${a}`);
    await pg.unsafe(`create schema ${b}`);
    await pg.unsafe(`create table ${b}.customers (customer_id integer primary key)`);
    await pg.unsafe(`create table ${a}.stores (store_id integer primary key)`);
    await pg.unsafe(
      `create table ${a}.orders (order_id integer primary key, customer_id integer, store_id integer, ` +
        `constraint orders_customer_fk foreign key (customer_id) references ${b}.customers, ` +
        `constraint orders_store_fk foreign key (store_id) references ${a}.stores)`,
    );
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${a} cascade`);
    await pg.unsafe(`drop schema if exists ${b} cascade`);
    await pg.close();
  });

  test.skipIf(!PG_URL)("names each key, and draft asks about the one across schemas", async () => {
    const { root } = tempRoot();
    const r = await semlayer(root, ["setup", "--source", "warehouse", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG", "--schemas", `${a},${b}`, "--primary", a], {
      SEMLAYER_TEST_PG: PG_URL,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Primary schema: ${a}.`);
    const snap = JSON.parse(readFileSync(join(root, "snapshots", "warehouse.json"), "utf8")) as Snapshot;
    expect(snap.tables.find((t) => t.name === "orders")!.foreign_keys).toEqual([
      { columns: ["customer_id"], references: { schema: b, table: "customers", columns: ["customer_id"] }, constraint: "orders_customer_fk" },
      { columns: ["store_id"], references: { schema: a, table: "stores", columns: ["store_id"] }, constraint: "orders_store_fk" },
    ]);
    const d = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(d.code).toBe(0);
    expect(d.json()).toMatchObject({ cross_schema_keys: [{ table: `${a}.orders`, columns: ["customer_id"], references: `${b}.customers`, constraint: "orders_customer_fk" }] });
  });
});

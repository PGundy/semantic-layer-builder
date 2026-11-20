// The primary schema and kept constraint names (spec: Schema scope).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { buildSnapshot } from "../skills/semantic-layer/scripts/lib/introspect.ts";
import { type CrossSchemaPair, crossSchemaFks, pairAllowed, primarySchema, toolVersion, UNDECLARED_GRACE_ENDS, undeclaredApprovedLevel } from "../skills/semantic-layer/scripts/lib/schema-scope.ts";
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

// Schema pairs (spec: Schema scope, Schema pairs): on the two-schema fixture, sales.orders joins
// crm.customers through orders_customer_fk.
describe("schema pairs", () => {
  const SOURCE = "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n";
  const sourceFile = (root: string) => join(root, "sources", "warehouse.yaml");
  const pairsOf = (root: string) => readYaml<SourceConfig>(sourceFile(root)).cross_schema;

  async function project(source = SOURCE): Promise<string> {
    const { root } = tempRoot();
    await initProject(root, "two");
    writeFileSync(sourceFile(root), source);
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    return root;
  }

  // The project drafted, with a draft join from orders to customers written by hand, as one could be
  // before pairs existed.
  async function crossJoin(status: "draft" | "approved" = "draft"): Promise<string> {
    const root = await project();
    expect((await semlayer(root, ["draft", "--source", "warehouse"])).code).toBe(0);
    const file = join(root, "models", "warehouse", "orders.yaml");
    const approval = status === "approved" ? "    approved_by: Dana\n    approved_at: '2026-01-10'\n" : "";
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /^joins:\n/m,
        `joins:\n  - name: customer\n    to: customers\n    keys:\n      - from: customer_id\n        to: customer_id\n    relationship: many_to_one\n    status: ${status}\n${approval}`,
      ),
    );
    return root;
  }

  const scopeIssues = async (root: string) => {
    const r = await semlayer(root, ["validate", "--json"]);
    return (r.json<{ issues: { level: string; code: string; file: string; path: string; message: string }[] }>().issues ?? []).filter((i) => i.code.startsWith("scope."));
  };

  // What semlayer approve --target schema-pair:... writes once the owner says yes.
  const stampApproval = (root: string) =>
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("status: draft", "status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15"));

  test("add-cross-schema writes a draft pair from a constraint or from columns, and the same keys again change nothing", async () => {
    const root = await project();
    const r = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk", "--json"]);
    expect(r.code).toBe(0);
    const pair: CrossSchemaPair = { from: "sales", to: "crm", status: "draft", keys: [{ from: "orders.customer_id", to: "customers.customer_id", constraint: "orders_customer_fk" }] };
    expect(r.json()).toMatchObject({ changed: true, file: "sources/warehouse.yaml", ref: "schema-pair:warehouse:sales:crm", pair, next: 'semlayer approve --target schema-pair:warehouse:sales:crm --by "<owner>"' });
    expect(pairsOf(root)).toEqual([pair]);
    const again = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--keys", "Orders.Customer_ID=customers.customer_id", "--json"]);
    expect(again.json()).toMatchObject({ changed: false });
    const more = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--keys", "orders.region_id=regions.region_id"]);
    expect(more.code).toBe(0);
    expect(more.out).toContain("Recorded the draft pair sales -> crm in sources/warehouse.yaml, on orders.customer_id = customers.customer_id and orders.region_id = regions.region_id.");
    expect(pairsOf(root)![0]!.keys).toHaveLength(2);
    expect(readFileSync(sourceFile(root), "utf8")).toStartWith(SOURCE);
  });

  test("add-cross-schema refuses a key, a constraint or a schema the snapshot or the source lacks, writing nothing", async () => {
    const root = await project();
    const add = (...args: string[]) => semlayer(root, ["add-cross-schema", "--source", "warehouse", ...args]);
    const missing = await add("--from", "sales", "--to", "crm", "--keys", "orders.customer_id=customers.no_such");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("orders.customer_id=customers.no_such: crm.customers has no column no_such in the snapshot. Nothing was written.");
    const wrongWay = await add("--from", "sales", "--to", "crm", "--keys", "customers.customer_id=orders.customer_id");
    expect(wrongWay.err).toContain("the snapshot has no table sales.customers");
    const constraint = await add("--from", "sales", "--to", "crm", "--constraint", "orders_store_fk");
    expect(constraint.err).toContain("The snapshot of warehouse has no foreign key orders_store_fk from a table of sales into crm.");
    const unread = await add("--from", "sales", "--to", "finance", "--keys", "orders.order_id=ledger.order_id");
    expect(unread.code).toBe(1);
    expect(unread.err).toContain(
      "finance is not among the schemas source warehouse reads (sales, crm). Nothing was written. Read it first with semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL --schemas sales,crm,finance, which reads the catalog again",
    );
    expect((await add("--from", "sales", "--to", "sales", "--keys", "orders.store_id=stores.store_id")).err).toContain("a pair joins two schemas");
    expect((await add("--from", "sales", "--to", "crm")).err).toContain("give --keys or --constraint, or --decline");
    expect(readFileSync(sourceFile(root), "utf8")).toBe(SOURCE);
  });

  test("--decline writes a declined pair with the owner's words, and draft then asks nothing about keys between the two schemas", async () => {
    const root = await project();
    const refused = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--decline"]);
    expect(refused.err).toContain("--decline needs --reply with the owner's words");
    const r = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--decline", "--reply", "No, keep to sales", "--json"]);
    expect(r.code).toBe(0);
    const pair: CrossSchemaPair = { from: "sales", to: "crm", status: "declined", reply: "No, keep to sales", declined_at: "2026-01-15" };
    expect(r.json()).toMatchObject({ changed: true, pair, next: "semlayer next" });
    expect(pairsOf(root)).toEqual([pair]);
    const d = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(d.json<{ cross_schema_keys: unknown[] }>().cross_schema_keys).toEqual([]);
    const orders = readYaml<{ open_questions?: string[] }>(join(root, "models", "warehouse", "orders.yaml"));
    expect((orders.open_questions ?? []).filter((q) => q.includes("crm.customers"))).toEqual([]);
    // A no over an approved pair says the approval is gone.
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("status: declined", "status: approved"));
    const over = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--decline", "--reply", "No again"]);
    expect(over.out).toContain("This replaced the approved pair, whose approval is gone");
    // A yes later replaces the no with a draft pair.
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk"])).code).toBe(0);
    expect(pairsOf(root)).toMatchObject([{ status: "draft", keys: [{ constraint: "orders_customer_fk" }] }]);
    expect(pairsOf(root)![0]).not.toHaveProperty("reply");
  });

  test("validate errors on a draft join across an undeclared pair, still errors on a draft pair, and passes once the pair is approved", async () => {
    const root = await crossJoin();
    const before = await scopeIssues(root);
    expect(before).toEqual([
      {
        level: "error",
        code: "scope.cross_schema_undeclared",
        file: "models/warehouse/orders.yaml",
        path: "joins[0]",
        message:
          "joins sales.orders to crm.customers across schemas, and no approved schema pair declares these keys. Ask the owner whether the layer joins these schemas: " +
          "record the pair with semlayer add-cross-schema --source warehouse --from sales --to crm --keys orders.customer_id=customers.customer_id, read it back and approve it on their yes, " +
          "or remove the join with semlayer remove-join --source warehouse --model orders --name customer",
      },
    ]);
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk"])).code).toBe(0);
    expect(await scopeIssues(root)).toEqual(before);
    stampApproval(root);
    expect(await scopeIssues(root)).toEqual([]);
    const v = await semlayer(root, ["validate", "--json"]);
    expect(JSON.stringify(v.json())).not.toContain("cross_schema");
  });

  test("an approved join across an undeclared pair is a warning until the next minor version, then an error", async () => {
    const root = await crossJoin("approved");
    expect((await scopeIssues(root)).map((i) => [i.level, i.code])).toEqual([["warning", "scope.cross_schema_undeclared"]]);
    expect(UNDECLARED_GRACE_ENDS).toBe("0.2.0");
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(toolVersion()).toBe(manifest.version);
    expect(undeclaredApprovedLevel("0.1.0")).toBe("warning");
    expect(undeclaredApprovedLevel("0.1.9")).toBe("warning");
    expect(undeclaredApprovedLevel("0.2.0")).toBe("error");
    expect(undeclaredApprovedLevel("1.0.0")).toBe("error");
    expect(undeclaredApprovedLevel(undefined)).toBe("error");
  });

  test("an approved pair allows a join either way on its keys only", () => {
    const pair = { from: "sales", to: "crm", status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15", keys: [{ from: "orders.customer_id", to: "customers.customer_id" }] };
    const forward = { fromSchema: "sales", fromTable: "orders", toSchema: "crm", toTable: "customers", keys: [{ from: "customer_id", to: "customer_id" }] };
    const back = { fromSchema: "crm", fromTable: "customers", toSchema: "sales", toTable: "orders", keys: [{ from: "customer_id", to: "customer_id" }] };
    expect(pairAllowed([pair], forward)).toBe(true);
    expect(pairAllowed([pair], back)).toBe(true);
    expect(pairAllowed([pair], { ...forward, keys: [{ from: "region_id", to: "customer_id" }] })).toBe(false);
    expect(pairAllowed([{ ...pair, status: "draft" }], forward)).toBe(false);
    expect(pairAllowed([{ ...pair, status: "declined" }], forward)).toBe(false);
    expect(pairAllowed([], forward)).toBe(false);
    expect(pairAllowed([], { ...forward, toSchema: "sales" })).toBe(true);
  });

  test("validate names a pair key missing from the snapshot, a primary outside the schemas read, and an approved pair no join crosses", async () => {
    const root = await project(SOURCE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: finance\n"));
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk"])).code).toBe(0);
    stampApproval(root);
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8")) as Snapshot;
    const customers = snap.tables.find((t) => t.name === "customers")!;
    customers.columns = customers.columns.filter((c) => c.name !== "customer_id");
    writeFileSync(join(root, "snapshots", "warehouse.json"), JSON.stringify(snap));
    expect((await scopeIssues(root)).map((i) => [i.level, i.code, i.path])).toEqual([
      ["error", "scope.primary_not_in_schemas", "intake.primary"],
      ["error", "scope.key_not_in_snapshot", "cross_schema[0].keys[0]"],
      ["warning", "scope.pair_unused", "cross_schema[0]"],
    ]);
  });

  test("remove-cross-schema removes keys the pair lists, sending it back to draft, then the pair", async () => {
    const root = await project();
    const add = ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--keys", "orders.customer_id=customers.customer_id,orders.region_id=regions.region_id"];
    expect((await semlayer(root, add)).code).toBe(0);
    stampApproval(root);
    const rm = (...args: string[]) => semlayer(root, ["remove-cross-schema", "--source", "warehouse", ...args]);
    expect((await rm("--from", "crm", "--to", "sales")).err).toContain("It declares sales -> crm: run semlayer remove-cross-schema --source warehouse --from sales --to crm.");
    expect((await rm("--from", "sales", "--to", "crm", "--keys", "orders.sku=products.sku")).err).toContain("The pair sales -> crm lists no key orders.sku=products.sku. Nothing was written.");
    const one = await rm("--from", "sales", "--to", "crm", "--keys", "orders.region_id=regions.region_id", "--json");
    expect(one.json()).toMatchObject({ changed: true, removed_pair: false, removed_keys: [{ from: "orders.region_id", to: "regions.region_id" }] });
    expect(pairsOf(root)).toEqual([{ from: "sales", to: "crm", status: "draft", keys: [{ from: "orders.customer_id", to: "customers.customer_id" }] }]);
    const all = await rm("--from", "sales", "--to", "crm");
    expect(all.out).toContain("Removed the pair sales -> crm from sources/warehouse.yaml.");
    expect(readFileSync(sourceFile(root), "utf8")).toBe(SOURCE);
  });
});

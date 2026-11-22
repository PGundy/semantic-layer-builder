// The primary schema and kept constraint names (spec: Schema scope).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { buildSnapshot } from "../skills/semantic-layer/scripts/lib/introspect.ts";
import { type CrossSchemaPair, crossSchemaFks, pairAllowed, primarySchema, toolVersion, UNDECLARED_GRACE_ENDS, undeclaredApprovedLevel } from "../skills/semantic-layer/scripts/lib/schema-scope.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { parseTarget } from "../skills/semantic-layer/scripts/lib/refs.ts";
import { approveWithYes, assertLocalPg, duckdbSource, initProject, PG_URL, recordReply, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

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
  const SOURCE = "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n  primary: sales\n";
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
    // The primary schema's tables are drafted by default; crm.customers is named.
    expect((await semlayer(root, ["draft", "--source", "warehouse", "--tables", "crm.customers"])).code).toBe(0);
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

  // What semlayer approve --target schema-pair:... writes once the owner says yes: the stamp and the
  // hash of the pair as it stands.
  const stampApproval = (root: string) => {
    const hash = itemHash("schema-pair", pairsOf(root)![0] as unknown as Record<string, unknown>);
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("status: draft", `status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15\n    approved_hash: ${hash}`));
  };

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
    expect((await approveWithYes(root, ["--target", "schema-pair:warehouse:sales:crm"])).code).toBe(0);
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
    const keys = [{ from: "orders.customer_id", to: "customers.customer_id" }];
    const approved_hash = itemHash("schema-pair", { from: "sales", to: "crm", keys });
    const pair = { from: "sales", to: "crm", status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15", approved_hash, keys };
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
    const root = await project(SOURCE.replace("  primary: sales\n", "  primary: finance\n"));
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
  // Approving a pair (spec: Schema scope, Approving a schema pair): semlayer approve on the owner's yes.
  const PAIR = "schema-pair:warehouse:sales:crm";
  const addPair = (root: string) => semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk"]);

  test("readback prints the pair, its keys and their constraints", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--keys", "orders.region_id=regions.region_id"])).code).toBe(0);
    const r = await semlayer(root, ["readback", "--targets", PAIR, "--json"]);
    expect(r.code).toBe(0);
    const item = r.json<{ items: { target: string; text: string; content_hash: string }[] }>().items[0]!;
    expect(item.target).toBe(PAIR);
    expect(item.content_hash).toBe(itemHash("schema-pair", pairsOf(root)![0] as unknown as Record<string, unknown>));
    expect(item.text.split("\n")).toEqual([
      `${PAIR} (schema pair of source warehouse, from sales to crm)`,
      "- A join may cross between schemas sales and crm, either way, only on these keys:",
      "  - sales.orders.customer_id = crm.customers.customer_id, from the foreign key orders_customer_fk",
      "  - sales.orders.region_id = crm.regions.region_id, named by hand (no foreign key recorded)",
      "- A join between the two schemas on any other columns stays refused until a pair listing it is approved; every other join stays within one schema.",
      "- Saying yes lets semlayer add-join add joins on these keys and semlayer draft draft them, so a question can read tables of sales and crm together.",
    ]);
    expect((await semlayer(root, ["readback", "--targets", "schema-pair:warehouse:sales:finance"])).err).toContain("sources/warehouse.yaml declares no schema pair sales -> finance");
  });

  test("approve without a recorded yes is refused; with one it records approver, date and hash in the pair entry", async () => {
    const root = await crossJoin();
    expect((await addPair(root)).code).toBe(0);
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("    keys:\n", "    keys: # read from the catalog\n"));
    const before = readFileSync(sourceFile(root), "utf8");
    const refused = await semlayer(root, ["approve", "--target", PAIR, "--json"]);
    expect(refused.code).toBe(1);
    const envelope = refused.json<{ error: string; code: string }>();
    expect(envelope.code).toBe("approval.no_ledger_yes");
    expect(envelope.error).toContain(`Cannot approve ${PAIR}: no owner reply to its readback is recorded; nothing was approved.`);
    expect(readFileSync(sourceFile(root), "utf8")).toBe(before);

    await recordReply(root, PAIR, { verdict: "no" });
    expect((await semlayer(root, ["approve", "--target", PAIR])).err).toContain('is "no", not yes');
    await recordReply(root, PAIR);
    expect((await semlayer(root, ["approve", "--target", PAIR, "--by", "Lee"])).err).toContain("is not the owner who said yes");
    const ok = await semlayer(root, ["approve", "--target", PAIR, "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json()).toMatchObject({ changed: [{ target: PAIR, from: "draft", to: "approved" }] });
    const pair = pairsOf(root)![0]!;
    expect(pair).toMatchObject({ from: "sales", to: "crm", status: "approved", approved_by: "Dana", approved_at: "2026-01-15" });
    expect(pair.approved_hash).toBe(itemHash("schema-pair", pair as unknown as Record<string, unknown>));
    expect(readFileSync(sourceFile(root), "utf8")).toStartWith(SOURCE);
    expect(readFileSync(sourceFile(root), "utf8")).toContain("    keys: # read from the catalog\n");
    // The join across the pair now passes validate, and approving again changes nothing.
    expect(await scopeIssues(root)).toEqual([]);
    expect((await semlayer(root, ["approve", "--target", PAIR])).out).toContain(`${PAIR} is already approved; nothing changed.`);
  });

  test("editing an approved pair marks it changed since approval, and it counts as a draft until approved again", async () => {
    const root = await crossJoin();
    expect((await addPair(root)).code).toBe(0);
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    // A key added by hand, outside add-cross-schema.
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("        constraint: orders_customer_fk\n", "        constraint: orders_customer_fk\n      - from: orders.region_id\n        to: regions.region_id\n"));
    const v = await semlayer(root, ["validate", "--json"]);
    const issues = v.json<{ issues: { level: string; code: string; file: string; path: string; message: string }[] }>().issues;
    expect(issues.find((i) => i.code === "approval.hash_changed")).toMatchObject({
      level: "error",
      file: "sources/warehouse.yaml",
      path: "cross_schema[0]",
      message: expect.stringContaining(`${PAIR} changed since it was approved by Dana on 2026-01-15`),
    });
    // The join across it is refused again, by validate and by the compiler's rule.
    expect((await scopeIssues(root)).map((i) => [i.level, i.code])).toEqual([["error", "scope.cross_schema_undeclared"]]);
    expect(pairAllowed(pairsOf(root)!, { fromSchema: "sales", fromTable: "orders", toSchema: "crm", toTable: "customers", keys: [{ from: "customer_id", to: "customer_id" }] })).toBe(false);
    // Approving it again needs a yes to it as it now stands.
    expect((await semlayer(root, ["approve", "--target", PAIR])).code).toBe(1);
    const again = await approveWithYes(root, ["--target", PAIR]);
    expect(again.out).toContain(`Approved ${PAIR} again (it changed since its last approval) by Dana on 2026-01-15`);
    expect(await scopeIssues(root)).toEqual([]);
  });

  test("a stamp written by hand without semlayer approve leaves the pair a draft", async () => {
    const root = await crossJoin();
    expect((await addPair(root)).code).toBe(0);
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("status: draft", "status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15"));
    const issues = (await semlayer(root, ["validate", "--json"])).json<{ issues: { level: string; code: string; message: string }[] }>().issues;
    expect(issues.find((i) => i.code === "approval.hash_missing")).toMatchObject({ level: "warning", message: expect.stringContaining(`${PAIR} is marked approved but records no approved_hash, so it counts as a draft`) });
    expect(issues.filter((i) => i.code.startsWith("scope.")).map((i) => [i.level, i.code])).toEqual([["error", "scope.cross_schema_undeclared"]]);
    // add-join refuses on it, as on a draft pair.
    const add = await semlayer(root, ["add-join", "--source", "warehouse", "--model", "orders", "--to", "customers", "--keys", "customer_id=customer_id", "--name", "customer2"]);
    expect(add.err).toContain("no approved schema pair declares these keys");
    // A hash that is not the pair's own does not approve it either.
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("approved_at: 2026-01-15", `approved_at: 2026-01-15\n    approved_hash: sha256:${"0".repeat(64)}`));
    expect((await scopeIssues(root)).map((i) => i.code)).toEqual(["scope.cross_schema_undeclared"]);
  });

  test("a pair stamped with a correct hash and no recorded yes is a draft to the join commands and validate", async () => {
    const root = await crossJoin();
    expect((await addPair(root)).code).toBe(0);
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    expect((await semlayer(root, ["approve", "--target", PAIR, "--revoke"])).code).toBe(0);
    // The ledger exists and holds the earlier yes to a pair that is now a draft; stamp it again by hand.
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("        constraint: orders_customer_fk\n", "        constraint: orders_customer_fk\n      - from: orders.region_id\n        to: regions.region_id\n"));
    const pair = pairsOf(root)![0]!;
    const hash = itemHash("schema-pair", pair as unknown as Record<string, unknown>);
    writeFileSync(sourceFile(root), readFileSync(sourceFile(root), "utf8").replace("status: draft", `status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15\n    approved_hash: ${hash}`));
    const issues = (await semlayer(root, ["validate", "--json"])).json<{ issues: { code: string }[] }>().issues;
    expect(issues.some((i) => i.code === "approval.no_recorded_yes")).toBe(true);
    const add = await semlayer(root, ["add-join", "--source", "warehouse", "--model", "orders", "--to", "customers", "--keys", "customer_id=customer_id", "--name", "customer2"]);
    expect(add.err).toContain("no approved schema pair declares these keys");
  });

  test("revoke makes an approved pair a draft and clears its stamp; a declined pair and --stamp-hashes are refused", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    const r = await semlayer(root, ["approve", "--target", PAIR, "--revoke"]);
    expect(r.out).toContain(`Revoked ${PAIR} (approved -> draft).`);
    expect(pairsOf(root)).toEqual([{ from: "sales", to: "crm", status: "draft", keys: [{ from: "orders.customer_id", to: "customers.customer_id", constraint: "orders_customer_fk" }] }]);
    expect((await semlayer(root, ["approve", "--stamp-hashes", "--target", PAIR])).err).toContain("A schema pair is approved only with its hash, so there is none to stamp.");
    // Keys added to an approved pair send it back to draft, with no stamp left behind.
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    const more = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--keys", "orders.region_id=regions.region_id"]);
    expect(more.out).toContain("The pair was approved; with these keys it is a draft again, and its approval is gone");
    expect(more.out).toContain(`Next: read the pair to the owner with semlayer readback --targets ${PAIR}`);
    expect(Object.keys(pairsOf(root)![0]!).sort()).toEqual(["from", "keys", "status", "to"]);
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--decline", "--reply", "No"])).code).toBe(0);
    const declined = await semlayer(root, ["approve", "--target", PAIR]);
    expect(declined.err).toContain(`Cannot approve ${PAIR}: the owner declined joining sales to crm, so it has no keys to approve; nothing was approved.`);
    expect((await semlayer(root, ["readback", "--targets", PAIR])).err).toContain("the owner declined joining sales to crm");
  });

  test("the edit hook refuses a hand edit of a pair's approval fields or of an approved pair's keys", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    const file = sourceFile(root);
    const hook = (tool: string, input: Record<string, unknown>) =>
      checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file, ...input }, cwd: root }));
    const edit = (from: string, to: string) => {
      expect(readFileSync(file, "utf8")).toContain(from);
      return hook("Edit", { old_string: from, new_string: to });
    };
    // A draft pair: its keys may be edited, but a stamp written by hand is refused.
    expect(edit("constraint: orders_customer_fk", "constraint: orders_customer_fk2").allow).toBe(true);
    const stamp = edit("status: draft", "status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15");
    expect(stamp.allow).toBe(false);
    expect(stamp.message).toContain(`this edit changes the approval fields of ${PAIR} (approved_at, approved_by, status). Only semlayer approve writes them`);
    // A source file without approval fields takes a shell write; once a pair is approved it does not.
    const shell = () => checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo "description: x" >> ${file}` }, cwd: root }));
    expect(shell().allow).toBe(true);
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    expect(shell().allow).toBe(false);
    const hash = edit("approved_hash: sha256:", "approved_hash: sha256:0");
    expect(hash.allow).toBe(false);
    expect(hash.message).toContain(`this edit changes the approval fields of ${PAIR} (approved_hash)`);
    const keys = edit("        constraint: orders_customer_fk\n", "        constraint: orders_customer_fk\n      - from: orders.region_id\n        to: regions.region_id\n");
    expect(keys.allow).toBe(false);
    expect(keys.message).toContain(
      `${PAIR} is approved, and this edit changes the keys the owner approved. Change its keys with semlayer add-cross-schema --source warehouse --from sales --to crm --keys ... or semlayer remove-cross-schema --source warehouse --from sales --to crm, which send it back to draft for the owner, or make it a draft first with semlayer approve --target ${PAIR} --revoke.`,
    );
    const removed = hook("Write", { content: SOURCE });
    expect(removed.allow).toBe(false);
    expect(removed.message).toContain(`this edit removes or renames approved ${PAIR}.`);
    // Outside the pairs, the source file is edited as before.
    expect(edit("dialect: postgres\n", "dialect: postgres\ndescription: The warehouse\n").allow).toBe(true);
  });

  test("a pair takes no typed edit, and its target keeps its case", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    const set = await semlayer(root, ["set", PAIR, "status", "approved"]);
    expect(set.code).toBe(1);
    const tag = await semlayer(root, ["tag", PAIR, "pii"]);
    expect(tag.err).toContain(`${PAIR} is a schema pair, which takes no typed edit: change its keys with semlayer add-cross-schema or semlayer remove-cross-schema`);
    expect(parseTarget("schema-pair:wh:Sales:CRM_2")).toEqual({ kind: "schema-pair", source: "wh", from: "Sales", to: "CRM_2" });
    expect(() => parseTarget("schema-pair:wh:sales")).toThrow("Cannot read target");
    expect(() => parseTarget("schema-pair:wh:sales:crm.x")).toThrow("Cannot read target");
  });
  const hashedStamp = (root: string) => {
    const pair = readYaml<SourceConfig>(sourceFile(root)).cross_schema![0] as unknown as Record<string, unknown>;
    return readFileSync(sourceFile(root), "utf8").replace("status: draft", `status: approved\n    approved_by: Dana\n    approved_at: 2026-01-15\n    approved_hash: ${itemHash("schema-pair", pair)}`);
  };

  test("a pair stamped with a correct hash but no recorded yes is reported by validate and status", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    writeFileSync(sourceFile(root), hashedStamp(root));
    const codes = async () => (await semlayer(root, ["validate", "--json"])).json<{ issues: { code: string; level: string }[] }>().issues.map((i) => `${i.level} ${i.code}`);
    // With no ledger at all, it counts under the rule for approvals given before the ledger, and the project is told once.
    expect(await codes()).toContain("warning approval.no_ledger");
    const status = (await semlayer(root, ["status", "--json"])).json<{ approved_without_yes: string[]; stamped_without_yes: string[] }>();
    expect(status.approved_without_yes).toContain(PAIR);
    // Once the ledger holds any answer, a stamp no yes backs is a draft, and an error.
    mkdirSync(join(root, ".semlayer"), { recursive: true });
    writeFileSync(join(root, ".semlayer", "ledger.jsonl"), `${JSON.stringify({ at: "2026-01-15T12:00:00.000Z", by: "Dana", id: "ans_0001", kind: "question", question: "q?", target: "access", text: "a" })}\n`);
    expect(await codes()).toContain("error approval.no_recorded_yes");
    const after = (await semlayer(root, ["status", "--json"])).json<{ approved_without_yes: string[]; stamped_without_yes: string[] }>();
    expect(after.stamped_without_yes).toContain(PAIR);
    expect(after.approved_without_yes).not.toContain(PAIR);
  });

  test("a pair approved with the owner's yes is clean, and status lists it once its keys are edited by hand", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    expect((await approveWithYes(root, ["--target", PAIR])).code).toBe(0);
    const clean = (await semlayer(root, ["status", "--json"])).json<{ approved_without_yes: string[]; changed_since_approval: string[] }>();
    expect(clean.approved_without_yes).not.toContain(PAIR);
    expect(clean.changed_since_approval).not.toContain(PAIR);
    const text = readFileSync(sourceFile(root), "utf8");
    writeFileSync(sourceFile(root), text.replace("        constraint: orders_customer_fk\n", "        constraint: orders_customer_fk\n      - from: orders.region_id\n        to: regions.region_id\n"));
    const changed = (await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[] }>();
    expect(changed.changed_since_approval).toContain(PAIR);
  });

  test("the readback of a pair names the pair commands for a no or a change", async () => {
    const root = await project();
    expect((await addPair(root)).code).toBe(0);
    const r = await semlayer(root, ["readback", "--targets", PAIR]);
    expect(r.out).toContain("semlayer add-cross-schema or semlayer remove-cross-schema");
  });
});

// The schema question (spec: Schema scope, The schema question): semlayer next asks it before draft
// on the two-schema fixture, draft refuses until a primary is set, and an answer clears it.
describe("the schema question", () => {
  const BARE = "source: warehouse\ndialect: postgres\nconnection:\n  env: WAREHOUSE_URL\nintake:\n  schemas: [sales, crm]\n";
  const sourceFile = (root: string) => join(root, "sources", "warehouse.yaml");
  const SETUP = "semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL";
  const QUESTION =
    "Your data sits in more than one schema (sales, crm). Is sales enough for your questions? If you also need crm, tell me which sales tables relate to which crm tables, and by which columns.";
  const DECLINE = 'semlayer add-cross-schema --source warehouse --from sales --to crm --decline --reply "<the owner\'s words>"';

  interface Next {
    kind: string;
    phase: string;
    why: string;
    action: { command: string; args: string[]; kind: string };
    ask_owner?: { text: string; items: unknown[]; options?: { answer: string; commands: string[] }[] };
  }

  async function project(source = BARE): Promise<string> {
    const { root } = tempRoot();
    await initProject(root, "two");
    writeFileSync(sourceFile(root), source);
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(join(root, "snapshots", "warehouse.json"), readFileSync(FIXTURE, "utf8"));
    return root;
  }
  const next = async (root: string) => (await semlayer(root, ["next", "--json"])).json<Next>();
  // A command of ask_owner.options as semlayer takes it: the words after "semlayer", with the
  // owner's words in place of the placeholder.
  const words = (command: string) =>
    [...command.replaceAll("<the owner's words>", "No, keep to sales").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(1);
  const runAll = async (root: string, commands: string[]) => {
    for (const c of commands) expect({ c, code: (await semlayer(root, words(c))).code }).toEqual({ c, code: 0 });
  };

  test("with two schemas and no primary, next asks the question with the commands for each answer", async () => {
    const root = await project();
    const n = await next(root);
    expect(n).toMatchObject({ kind: "ask_owner", phase: "scope", action: { command: "setup", args: [...SETUP.split(" ").slice(2), "--primary", "sales"], kind: "ask_owner" } });
    expect(n.ask_owner).toEqual({
      text: QUESTION,
      items: [],
      options: [
        { answer: "No, keep to sales", commands: [`${SETUP} --primary sales`, DECLINE] },
        {
          answer: "Yes, I also need crm",
          commands: [`${SETUP} --primary sales`, "semlayer add-cross-schema --source warehouse --from sales --to crm --constraint orders_customer_fk", "semlayer readback --targets schema-pair:warehouse:sales:crm"],
        },
        { answer: "Another schema holds what my questions are about", commands: [`${SETUP} --primary <schema>`] },
      ],
    });
    expect(n.why).toContain(`Ask: "${QUESTION}"`);
    const status = (await semlayer(root, ["status", "--json"])).json<{ next_step: { phase: string; source: string; command: string } }>().next_step;
    expect(status).toMatchObject({ phase: "scope", source: "warehouse", command: `${SETUP} --primary sales` });
    const plain = await semlayer(root, ["next"]);
    expect(plain.out).toContain(`Ask the owner, then: ${SETUP} --primary sales`);
  });

  test("draft before the answer refuses with scope.primary_unset and the setup command, writing nothing", async () => {
    const root = await project();
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({
      error:
        'Source "warehouse" reads more than one schema (sales, crm) and names no primary schema, so draft does not know which one the layer is about. Nothing was written. ' +
        `Ask the owner the schema question semlayer next gives, then record the schema their questions are about with ${SETUP} --primary <schema>.`,
      code: "scope.primary_unset",
      next: `${SETUP} --primary <schema>`,
    });
    expect((await semlayer(root, ["draft", "--source", "warehouse", "--new-columns"])).err).toContain("names no primary schema");
    expect(existsSync(join(root, "models", "warehouse"))).toBe(false);
    expect(readFileSync(sourceFile(root), "utf8")).toBe(BARE);
  });

  test('"No, keep to sales" sets the primary and declines the pair, and the step clears', async () => {
    const root = await project();
    const keep = (await next(root)).ask_owner!.options![0]!;
    // semlayer setup reads the catalog through the connection, which this test has none of (the live
    // test runs it): its write of intake.primary is made by hand.
    expect(keep.commands[0]).toBe(`${SETUP} --primary sales`);
    writeFileSync(sourceFile(root), BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: sales\n"));
    // With the primary set, the foreign key into crm still waits for an answer.
    const half = await next(root);
    expect(half).toMatchObject({ phase: "scope", action: { command: "add-cross-schema", args: ["--source", "warehouse", "--from", "sales", "--to", "crm", "--decline", "--reply", "<the owner's words>"] }, ask_owner: { text: QUESTION } });
    expect(half.ask_owner!.options!.map((o) => o.commands)).toEqual([[DECLINE], ["semlayer add-cross-schema --source warehouse --from sales --to crm --constraint orders_customer_fk", "semlayer readback --targets schema-pair:warehouse:sales:crm"]]);
    await runAll(root, keep.commands.slice(1));
    expect(readYaml<SourceConfig>(sourceFile(root))).toMatchObject({ intake: { primary: "sales" }, cross_schema: [{ from: "sales", to: "crm", status: "declined", reply: "No, keep to sales" }] });
    const after = await next(root);
    expect(after.phase).not.toBe("scope");
    expect(after.ask_owner?.options).toBeUndefined();
  });

  test("the step clears once the pair is approved on the owner's yes, and not before", async () => {
    const root = await project(BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: sales\n"));
    expect((await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "crm", "--constraint", "orders_customer_fk"])).code).toBe(0);
    // The owner has said yes and the draft pair is recorded: the step is its readback, not the question again.
    const pending = await next(root);
    expect(pending.ask_owner).toBeUndefined();
    expect(pending.action).toMatchObject({ command: "readback", args: ["--targets", "schema-pair:warehouse:sales:crm"] });
    expect(JSON.stringify(pending)).not.toContain("--decline");
    expect((await approveWithYes(root, ["--target", "schema-pair:warehouse:sales:crm"])).code).toBe(0);
    const after = await next(root);
    expect(after.ask_owner?.options).toBeUndefined();
    expect(after.phase).not.toBe("scope");
  });

  test("with the primary set, draft keeps to it, lists the other schema as left out, and --tables brings it in", async () => {
    const root = await project(BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: sales\n"));
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ drafted: { table: string }[]; left_out_schemas: unknown[] }>();
    expect(out.drafted.map((d) => d.table).sort()).toEqual(["sales.channels", "sales.orders", "sales.stores"]);
    expect(out.left_out_schemas).toEqual([{ schema: "crm", tables: 3, command: "semlayer draft --source warehouse --tables crm.*" }]);
    const more = await semlayer(root, ["draft", "--source", "warehouse", "--tables", "crm.*", "--json"]);
    expect(more.json<{ drafted: { table: string }[] }>().drafted.map((d) => d.table).sort()).toEqual(["crm.customers", "crm.products", "crm.regions"]);
    const again = await semlayer(root, ["draft", "--source", "warehouse"]);
    expect(again.out).not.toContain("Left out");
  });

  test("a primary that is not among the schemas read refuses draft with a code and the setup command", async () => {
    const root = await project(BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: archive\n"));
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ code: "scope.primary_not_in_schemas", next: `${SETUP} --primary <schema>`.replace(/^semlayer setup .*?--primary/, "semlayer setup --source warehouse --primary") });
    expect(existsSync(join(root, "models", "warehouse"))).toBe(false);
  });

  test("the plain draft output names the left-out schema and its command", async () => {
    const root = await project(BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: sales\n"));
    const r = await semlayer(root, ["draft", "--source", "warehouse"]);
    expect(r.out).toContain("Left out, outside the primary schema sales:\n  crm: 3 tables; semlayer draft --source warehouse --tables crm.* drafts them");
  });

  test("a scope that selects one schema asks nothing, and draft drafts as before", async () => {
    const root = await project(`${BARE}scope:\n  include: [sales.*]\n`);
    expect((await next(root)).ask_owner?.options).toBeUndefined();
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).not.toHaveProperty("left_out_schemas");
  });

  test("add-cross-schema with a --to outside the schemas read refuses and names the setup --schemas command", async () => {
    const root = await project(BARE.replace("  schemas: [sales, crm]\n", "  schemas: [sales, crm]\n  primary: sales\n"));
    const r = await semlayer(root, ["add-cross-schema", "--source", "warehouse", "--from", "sales", "--to", "finance", "--decline", "--reply", "No"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${SETUP} --schemas sales,crm,finance, which reads the catalog again`);
  });

  test("a DuckDB source of two schemas asks nothing and drafts as before", async () => {
    const root = await project(BARE.replace("dialect: postgres\nconnection:\n  env: WAREHOUSE_URL", 'dialect: duckdb\nconnection:\n  database: ":memory:"'));
    expect((await next(root)).ask_owner?.options).toBeUndefined();
    const r = await semlayer(root, ["draft", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).not.toHaveProperty("left_out_schemas");
    expect(r.json<{ drafted: unknown[] }>().drafted).toHaveLength(6);
  });

  test("the demo project never sees the question", async () => {
    const { dir } = tempRoot();
    const demo = join(dir, "demo");
    expect((await semlayer(dir, ["demo", "--dir", demo])).code).toBe(0);
    const n = (await semlayer(join(demo, "semantic"), ["next", "--json"])).json<Next>();
    expect(n.ask_owner?.options).toBeUndefined();
    expect(n.why).not.toContain("more than one schema");
  });
});

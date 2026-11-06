// introspect and import read intake.schemas (docs/PRD.md FR-1.1): introspect without --schemas reads
// them (and its --emit-sql plan carries the filter), --schemas overrides them with a note, import
// keeps only their tables in every format and counts the rest, and an export source imports its
// intake.export.file when --file is left out.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { schemasToRead } from "../skills/semantic-layer/scripts/commands/introspect.ts";
import { droppedText, intakeSchemas, schemaFilter } from "../skills/semantic-layer/scripts/lib/intake.ts";
import type { Snapshot, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function setup(): Promise<{ root: string; dir: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  return t;
}

function names(root: string, source: string): string[] {
  const s = JSON.parse(readFileSync(join(root, "snapshots", `${source}.json`), "utf8")) as Snapshot;
  return s.tables.map((t) => `${t.schema}.${t.name}`).sort();
}

// Merges `patch` into sources/<name>.yaml.
function patchSource(root: string, name: string, patch: Partial<SourceConfig>): void {
  const file = join(root, "sources", `${name}.yaml`);
  writeYaml(file, { ...readYaml<SourceConfig>(file), ...patch });
}

const TWO_SCHEMAS = [
  "create schema acme",
  "create schema other",
  "create table acme.orders (order_id integer primary key, amount_cents bigint)",
  "create table acme.customers (customer_id integer primary key)",
  "create table other.events (event_id integer)",
  "create table main.scratch (x integer)",
];

describe("schemaFilter", () => {
  test("follows each dialect's schema names", () => {
    const bq = schemaFilter({ dialect: "bigquery" }, ["analytics", "proj.marts"]);
    expect(["analytics", "proj.analytics", "example.com:p.analytics", "marts", "proj.marts"].map(bq)).toEqual([true, true, true, true, true]);
    expect(["other.marts", "Analytics", "raw", null].map(bq)).toEqual([false, false, false, false]);
    const duck = schemaFilter({ dialect: "duckdb", connection: { database: "wh.duckdb" } }, ["acme", "lake.raw"]);
    expect(["acme", "wh.acme", "WH.acme", "lake.raw", "other.acme", "raw", "wh.raw"].map(duck)).toEqual([true, true, true, true, false, false, false]);
    expect(schemaFilter({ dialect: "duckdb" }, ["acme"])("memory.acme")).toBe(true);
    const sf = schemaFilter({ dialect: "snowflake" }, ["analytics", "MixedCase"]);
    expect(["ANALYTICS", "analytics", "MixedCase", "MIXEDCASE"].map(sf)).toEqual([true, true, true, false]);
    const pg = schemaFilter({ dialect: "postgres" }, ["acme"]);
    expect(["acme", "ACME", "db.acme", null, ""].map(pg)).toEqual([true, false, false, false, false]);
  });
});

describe("intake.schemas helpers", () => {
  test("a list that is not names is refused with the fix", () => {
    const bad = { source: "wh", dialect: "duckdb", intake: { schemas: "acme" } } as unknown as SourceConfig;
    expect(() => intakeSchemas(bad)).toThrow("intake.schemas in sources/wh.yaml must be a list of schema names, such as [analytics, marts]; fix it and run sl validate.");
    expect(intakeSchemas({ source: "wh", intake: { schemas: [" acme", "acme", ""] } } as SourceConfig)).toEqual(["acme"]);
  });

  test("--schemas naming the same schemas as the dialect compares names is no override", () => {
    const sf = { source: "wh", dialect: "snowflake", intake: { schemas: ["analytics"] } } as SourceConfig;
    expect(schemasToRead(sf, ["ANALYTICS"], "sources/wh.yaml", {}).note).toBeUndefined();
    expect(schemasToRead(sf, ["ANALYTICS", "marts"], "sources/wh.yaml", {}).note).toContain("differs from intake.schemas");
    const pg = { source: "wh", dialect: "postgres", intake: { schemas: ["analytics"] } } as SourceConfig;
    expect(schemasToRead(pg, ["ANALYTICS"], "sources/wh.yaml", {}).note).toContain("differs from intake.schemas");
  });

  test("a BigQuery source reads intake.schemas first, else the datasets its effective scope names", () => {
    const bq = { source: "bq", dialect: "bigquery", scope: { include: ["saved.*"] } } as SourceConfig;
    // The effective scope (scope.include joined with the table-list file's entries) is passed in.
    expect(schemasToRead(bq, [], "sources/bq.yaml", { include: ["saved.*", "listed.orders"] })).toEqual({ schemas: ["saved", "listed"], from: "scope" });
    expect(schemasToRead(bq, [], "sources/bq.yaml", { include: ["saved.*"] })).toEqual({ schemas: ["saved"], from: "scope" });
    expect(schemasToRead(bq, [], "sources/bq.yaml", {})).toEqual({ schemas: [], from: "all" });
    const withIntake = { ...bq, intake: { schemas: ["analytics"] } } as SourceConfig;
    expect(schemasToRead(withIntake, [], "sources/bq.yaml", { include: ["listed.orders"] })).toEqual({ schemas: ["analytics"], from: "intake" });
  });

  test("a BigQuery --emit-sql plan reads the table-list file's datasets unless intake.schemas lists some", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "bq", "--dialect", "bigquery"])).code).toBe(0);
    mkdirSync(join(t.root, "scope"), { recursive: true });
    writeFileSync(join(t.root, "scope", "bq.txt"), "listed.orders\n");
    patchSource(t.root, "bq", { scope: { include: ["saved.*"], tables_file: "scope/bq.txt" } });
    const emit = await sl(t.root, ["introspect", "--source", "bq", "--emit-sql"]);
    expect(emit.code).toBe(0);
    expect(emit.out).toContain("`saved`");
    expect(emit.out).toContain("`listed`");
    patchSource(t.root, "bq", { intake: { schemas: ["analytics"] } });
    const withIntake = await sl(t.root, ["introspect", "--source", "bq", "--emit-sql"]);
    expect(withIntake.code).toBe(0);
    expect(withIntake.out).toContain("`analytics`");
    expect(withIntake.out).not.toContain("`listed`");
  });

  test("dropped counts name tables with no schema", () => {
    expect(droppedText({ tables: 12, schemas: ["a", "b"] })).toBe("12 tables in 2 schemas");
    expect(droppedText({ tables: 3, schemas: ["a", null] })).toBe("3 tables in 1 schema or with no schema");
    expect(droppedText({ tables: 1, schemas: [null] })).toBe("1 table with no schema");
  });
});

describe("introspect reads intake.schemas: duckdb", () => {
  test("reads only intake.schemas, and an empty or absent list reads every schema", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", TWO_SCHEMAS);
    const all = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(all.code).toBe(0);
    expect(all.json()).toMatchObject({ tables: 4, schemas: [], schemas_from: "all" });

    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const r = await sl(t.root, ["introspect", "--source", "wh", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<{ tables: number; schemas: string[]; schemas_from: string; schemas_note?: string; changes: { tables_removed: string[] } }>();
    expect(out).toMatchObject({ tables: 2, schemas: ["acme"], schemas_from: "intake" });
    expect(out.schemas_note).toBeUndefined();
    // Tables of schemas intake.schemas leaves out leave the snapshot.
    expect(out.changes.tables_removed.sort()).toEqual(["main.scratch", "other.events"]);
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders"]);

    patchSource(t.root, "wh", { intake: { schemas: [] } });
    expect((await sl(t.root, ["introspect", "--source", "wh", "--json"])).json()).toMatchObject({ tables: 4, schemas_from: "all" });
  });

  test("--schemas overrides intake.schemas and says how to save them", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", TWO_SCHEMAS);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    expect((await sl(t.root, ["introspect", "--source", "wh"])).code).toBe(0);

    const text = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "other"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("--schemas (other) differs from intake.schemas in sources/wh.yaml (acme); this run reads other.");
    expect(text.out).toContain("set intake.schemas in sources/wh.yaml to [other] and run sl validate");
    expect(text.out).toContain("run sl introspect --source wh without --schemas");
    // A --schemas run refreshes those schemas and keeps the others' tables, as before.
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders", "other.events"]);

    const json = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "other", "--json"]);
    expect(json.json()).toMatchObject({ schemas: ["other"], schemas_from: "flag" });
    expect(json.json<{ schemas_note: string }>().schemas_note).toContain("differs from intake.schemas");

    // The same list, in any order, is no override.
    patchSource(t.root, "wh", { intake: { schemas: ["acme", "other"] } });
    const same = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "other,acme", "--json"]);
    expect(same.json<{ schemas_note?: string }>().schemas_note).toBeUndefined();
  });

  test("--emit-sql plans carry the intake.schemas filter, and --results and --plan finish them", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", TWO_SCHEMAS);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const emit = await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
    expect(emit.code).toBe(0);
    const plan = emit.json<{ plan_id: string; queries: { id: string; sql: string }[] }>();
    for (const q of plan.queries) expect(q.sql).toContain("where table_schema in ('acme')");
    expect(emit.err).not.toContain("differs");

    // Run the plan's queries against the database and finish with --results, then with --plan.
    const db = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await db.connect();
    const rows: Record<string, unknown[]> = {};
    for (const q of plan.queries) rows[q.id] = (await c.runAndReadAll(q.sql)).getRowObjectsJson();
    c.closeSync();
    db.closeSync();
    const results = join(t.dir, "results.json");
    writeFileSync(results, JSON.stringify(rows));
    const fin = await sl(t.root, ["introspect", "--source", "wh", "--results", results, "--json"]);
    expect(fin.code).toBe(0);
    expect(fin.json()).toMatchObject({ tables: 2, schemas: ["acme"] });
    for (const q of plan.queries) {
      const f = join(t.dir, `${q.id}.json`);
      writeFileSync(f, JSON.stringify(rows[q.id]));
      expect((await sl(t.root, ["results", "add", "--plan", plan.plan_id, "--query", q.id, "--file", f])).code).toBe(0);
    }
    const byPlan = await sl(t.root, ["introspect", "--source", "wh", "--plan", plan.plan_id, "--json"]);
    expect(byPlan.code).toBe(0);
    expect(byPlan.json()).toMatchObject({ tables: 2, schemas_from: "intake" });

    const override = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "other", "--emit-sql"]);
    expect(override.code).toBe(0);
    expect(override.err).toContain("--schemas (other) differs from intake.schemas");
    for (const q of override.json<{ queries: { sql: string }[] }>().queries) expect(q.sql).toContain("where table_schema in ('other')");
  });

  test("--results keeps only the schemas read, though the results file holds more", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", TWO_SCHEMAS);
    // A plan emitted before intake.schemas was set reads every schema.
    const plan = (await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"])).json<{ queries: { id: string; sql: string }[] }>();
    const db = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await db.connect();
    const rows: Record<string, unknown[]> = {};
    for (const q of plan.queries) rows[q.id] = (await c.runAndReadAll(q.sql)).getRowObjectsJson();
    c.closeSync();
    db.closeSync();
    const results = join(t.dir, "results.json");
    writeFileSync(results, JSON.stringify(rows));

    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const r = await sl(t.root, ["introspect", "--source", "wh", "--results", results, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, schemas: ["acme"], schemas_from: "intake", dropped: { tables: 2, schemas: ["main", "other"] } });
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders"]);
    const text = await sl(t.root, ["introspect", "--source", "wh", "--results", results]);
    expect(text.out).toContain("Left out 2 tables in 2 schemas that this run does not read: main, other.");
    expect(text.out).toContain("add them to intake.schemas in sources/wh.yaml and run sl validate, or pass them in --schemas");

    // --schemas keeps its own list from the same file, and the other schemas' tables from before.
    const flag = await sl(t.root, ["introspect", "--source", "wh", "--schemas", "other", "--results", results, "--json"]);
    expect(flag.json()).toMatchObject({ tables: 3, schemas_from: "flag", dropped: { tables: 3, schemas: ["acme", "main"] } });
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders", "other.events"]);
    // A live run reads only the listed schemas, so nothing is left out.
    expect((await sl(t.root, ["introspect", "--source", "wh", "--json"])).json()).toMatchObject({ dropped: { tables: 0, schemas: [] } });
  });

  test("an attached database's schema is read as database.schema", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "lake", ["create schema raw", "create table raw.hits (id integer)", "create table main.junk (id integer)"]);
    await duckdbSource(t.root, t.dir, "wh", TWO_SCHEMAS);
    patchSource(t.root, "wh", { intake: { schemas: ["acme", "lake.raw"] } });
    const emit = await sl(t.root, ["introspect", "--source", "wh", "--emit-sql"]);
    const plan = emit.json<{ queries: { id: string; sql: string }[] }>();
    for (const q of plan.queries) expect(q.sql).toContain("where table_schema in ('acme', 'lake.raw')");
    // The agent runs the plan in a session with lake attached and finishes with --results.
    const db = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await db.connect();
    await c.run(`attach '${join(t.dir, "lake.duckdb")}' as lake (read_only)`);
    const rows: Record<string, unknown[]> = {};
    for (const q of plan.queries) rows[q.id] = (await c.runAndReadAll(q.sql)).getRowObjectsJson();
    c.closeSync();
    db.closeSync();
    const results = join(t.dir, "results.json");
    writeFileSync(results, JSON.stringify(rows));
    expect((await sl(t.root, ["introspect", "--source", "wh", "--results", results])).code).toBe(0);
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders", "lake.raw.hits"]);
  });
});

describe("introspect reads intake.schemas: postgres", () => {
  const a = uniqueSchema("t_intake_a");
  const b = uniqueSchema("t_intake_b");
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    pg = new SQL(PG_URL);
    for (const s of [a, b]) {
      await pg.unsafe(`drop schema if exists ${s} cascade`);
      await pg.unsafe(`create schema ${s}`);
    }
    await pg.unsafe(`create table ${a}.orders (order_id integer primary key, customer_id integer)`);
    await pg.unsafe(`create table ${a}.customers (customer_id integer primary key)`);
    await pg.unsafe(`create table ${b}.events (event_id integer, order_id integer references ${a}.orders)`);
  });

  afterAll(async () => {
    if (!pg) return;
    for (const s of [a, b]) await pg.unsafe(`drop schema if exists ${s} cascade`);
    await pg.close();
  });

  test.skipIf(!PG_URL)("a source with intake.schemas introspects only those schemas", async () => {
    const t = await setup();
    expect((await sl(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SL_TEST_PG", "--schemas", a])).code).toBe(0);
    const r = await sl(t.root, ["introspect", "--source", "pg", "--json"], { SL_TEST_PG: PG_URL });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, primary_keys: 2, schemas: [a], schemas_from: "intake" });
    expect(names(t.root, "pg")).toEqual([`${a}.customers`, `${a}.orders`]);

    const both = await sl(t.root, ["introspect", "--source", "pg", "--schemas", `${a},${b}`], { SL_TEST_PG: PG_URL });
    expect(both.code).toBe(0);
    expect(both.out).toContain(`--schemas (${a}, ${b}) differs from intake.schemas in sources/pg.yaml (${a})`);
    expect(names(t.root, "pg")).toEqual([`${a}.customers`, `${a}.orders`, `${b}.events`]);
  });

  test.skipIf(!PG_URL)("an export with three schemas imports only the listed one", async () => {
    const t = await setup();
    const exp = await sl(t.root, ["export-sql", "--dialect", "postgres", "--schemas", `${a},${b}`, "--json"]);
    const rows = await pg!.unsafe(exp.json<{ sql: string }>().sql);
    // A third schema in the same export, as an owner's wider export would hold.
    const third = (rows as Record<string, unknown>[]).filter((r) => r.table_schema === a).map((r) => ({ ...r, table_schema: "third" }));
    const file = join(t.dir, "schema.json");
    writeFileSync(file, JSON.stringify([...rows, ...third]));
    expect((await sl(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SL_TEST_PG", "--schemas", a])).code).toBe(0);
    const r = await sl(t.root, ["import", "--source", "pg", "--file", file, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, dropped: { tables: 3, schemas: [b, "third"].sort() } });
    expect(names(t.root, "pg")).toEqual([`${a}.customers`, `${a}.orders`]);
  });
});

// One information_schema export with three schemas, as CSV.
const CSV = [
  "table_schema,table_name,column_name,data_type,is_nullable,ordinal_position",
  "acme,orders,order_id,integer,NO,1",
  "acme,orders,amount_cents,bigint,YES,2",
  "acme,customers,customer_id,integer,NO,1",
  "marts,daily,day,date,NO,1",
  "marts,weekly,week,date,NO,1",
  "raw,events,event_id,integer,NO,1",
].join("\n");

describe("import keeps only intake.schemas", () => {
  test("information_schema CSV: drops and counts the other schemas' tables, in text and --json", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    const text = await sl(t.root, ["import", "--source", "wh", "--file", file]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Imported 2 tables and 3 columns");
    expect(text.out).toContain("Dropped 3 tables in 2 schemas not in intake.schemas: marts, raw.");
    expect(text.out).toContain("add the schema to intake.schemas in sources/wh.yaml, run sl validate and rerun sl import --source wh");
    const json = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(json.json()).toMatchObject({ tables: 2, dropped: { tables: 3, schemas: ["marts", "raw"] } });
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders"]);
  });

  test("without intake.schemas every table is kept and dropped is empty", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(r.json()).toMatchObject({ tables: 5, dropped: { tables: 0, schemas: [] } });
    expect(r.json<{ warnings: string[] }>().warnings.some((w) => w.includes("intake.schemas"))).toBe(false);
  });

  test("information_schema JSON, a dbt manifest and DDL are filtered too", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    patchSource(t.root, "wh", { dialect: "postgres", connection: { env: "WH_URL" }, intake: { schemas: ["acme", "marts"] } });

    const rows = CSV.split("\n").slice(1).map((l) => {
      const [table_schema, table_name, column_name, data_type, is_nullable, ordinal_position] = l.split(",");
      return { table_schema, table_name, column_name, data_type, is_nullable, ordinal_position: Number(ordinal_position) };
    });
    const json = join(t.dir, "schema.json");
    writeFileSync(json, JSON.stringify(rows));
    expect((await sl(t.root, ["import", "--source", "wh", "--file", json, "--json"])).json()).toMatchObject({ tables: 4, dropped: { tables: 1, schemas: ["raw"] } });

    const node = (schema: string, name: string) => ({
      resource_type: "model", name, package_name: "p", schema, alias: name, database: "d", config: { materialized: "table" },
      columns: { id: { name: "id", data_type: "int" } },
    });
    const manifest = {
      metadata: { dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v12.json" },
      nodes: { "model.p.orders": node("acme", "orders"), "model.p.events": node("raw", "events"), "model.p.stage": node("staging", "stage") },
      sources: {},
    };
    const dbt = join(t.dir, "manifest.json");
    writeFileSync(dbt, JSON.stringify(manifest));
    const d = await sl(t.root, ["import", "--source", "wh", "--file", dbt, "--json"]);
    expect(d.code).toBe(0);
    expect(d.json()).toMatchObject({ method: "dbt_manifest", tables: 1, dropped: { tables: 2, schemas: ["raw", "staging"] } });

    const ddl = join(t.dir, "schema.sql");
    writeFileSync(ddl, "create table acme.orders (id int);\ncreate table marts.daily (day date);\ncreate table raw.events (id int);\ncreate table loose (id int);\n");
    const s = await sl(t.root, ["import", "--source", "wh", "--file", ddl, "--json"]);
    expect(s.code).toBe(0);
    // An unqualified Postgres table lands in public, which intake.schemas leaves out.
    expect(s.json()).toMatchObject({ method: "ddl", tables: 2, dropped: { tables: 2, schemas: ["public", "raw"] } });
    expect(names(t.root, "wh")).toEqual(["acme.orders", "marts.daily"]);
  });

  test("tables with no schema are dropped and named as such; none left is an error naming the file's schemas", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const mixed = join(t.dir, "mixed.json");
    writeFileSync(mixed, JSON.stringify([
      { table_schema: "acme", table_name: "orders", column_name: "id", data_type: "int" },
      { table_name: "loose", column_name: "id", data_type: "int" },
    ]));
    const m = await sl(t.root, ["import", "--source", "wh", "--file", mixed, "--json"]);
    expect(m.json()).toMatchObject({ tables: 1, dropped: { tables: 1, schemas: [null] } });
    expect((await sl(t.root, ["import", "--source", "wh", "--file", mixed])).out).toContain("Dropped 1 table with no schema not in intake.schemas: (no schema).");

    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV.split("\n").filter((l) => !l.startsWith("acme")).join("\n"));
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("None of the 3 tables in");
    expect(r.err).toContain("is in intake.schemas (acme); the file holds marts, raw.");
    expect(r.err).toContain("rerun sl import --source wh");
  });

  test("a previous table the file holds outside intake.schemas is reported once", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    expect((await sl(t.root, ["import", "--source", "wh", "--file", file])).code).toBe(0);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    const warnings = r.json<{ warnings: string[] }>().warnings;
    expect(warnings.some((w) => w.startsWith("Dropped 3 tables in 2 schemas"))).toBe(true);
    expect(warnings.some((w) => w.includes("in the previous snapshot"))).toBe(false);
    // A previous table the file no longer holds is still reported.
    writeFileSync(file, CSV.split("\n").filter((l) => !l.includes("customers")).join("\n"));
    const again = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(again.json<{ warnings: string[] }>().warnings.join(" ")).toContain("1 table in the previous snapshot is not in this import and was dropped: acme.customers.");
  });

  test("a previous table dropped by --include or --exclude is reported once, in the filter line", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    expect((await sl(t.root, ["import", "--source", "wh", "--file", file])).code).toBe(0);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--include", "orders"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dropped 3 tables in 2 schemas not in intake.schemas: marts, raw.");
    expect(r.out).toContain("Kept the 1 table matching --include and --exclude; dropped 1 other of the tables intake.schemas keeps.");
    expect(r.out).not.toContain("in the previous snapshot");
    // Without intake.schemas the same holds for a filter drop alone.
    patchSource(t.root, "wh", { intake: { schemas: [] } });
    expect((await sl(t.root, ["import", "--source", "wh", "--file", file])).code).toBe(0);
    const ex = await sl(t.root, ["import", "--source", "wh", "--file", file, "--exclude", "marts.weekly", "--json"]);
    const j = ex.json<{ dropped: unknown; filters: unknown; warnings: string[] }>();
    expect(j.dropped).toEqual({ tables: 0, schemas: [] });
    expect(j.filters).toEqual({ include: [], exclude: ["marts.weekly"], kept: 4, dropped: 1 });
    expect(j.warnings.some((w) => w.includes("in the previous snapshot"))).toBe(false);
    expect((await sl(t.root, ["import", "--source", "wh", "--file", file, "--exclude", "marts.weekly"])).out).toContain("dropped 1 other from the file.");
  });

  test("with scope.tables_file, the in-scope tables are those intake.schemas keeps and the file lists", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    mkdirSync(join(t.root, "scope"), { recursive: true });
    writeFileSync(join(t.root, "scope", "wh.txt"), "acme.orders\n");
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] }, scope: { tables_file: "scope/wh.txt" } });
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, dropped: { tables: 3, schemas: ["marts", "raw"] } });
    const tables = JSON.stringify((await sl(t.root, ["tables", "--source", "wh", "--json"])).json());
    expect(tables).toContain("orders");
    expect(tables).not.toContain("customers");
  });

  test("--include and --exclude apply to the tables intake.schemas keeps, and both drops are reported", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    patchSource(t.root, "wh", { intake: { schemas: ["acme", "marts"] } });
    const file = join(t.dir, "schema.csv");
    writeFileSync(file, CSV);
    const args = ["import", "--source", "wh", "--file", file, "--include", "orders,daily,events", "--exclude", "weekly"];
    const text = await sl(t.root, args);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Imported 2 tables");
    expect(text.out).toContain("Dropped 1 table in 1 schema not in intake.schemas: raw.");
    expect(text.out).toContain("Kept the 2 tables matching --include and --exclude; dropped 2 others of the tables intake.schemas keeps.");
    // events is only in raw, which intake.schemas leaves out.
    expect(text.out).toContain(`Pattern "events" matches no table in ${file} within intake.schemas.`);
    expect(names(t.root, "wh")).toEqual(["acme.orders", "marts.daily"]);
    const json = await sl(t.root, [...args, "--json"]);
    expect(json.json()).toMatchObject({
      tables: 2,
      dropped: { tables: 1, schemas: ["raw"] },
      filters: { include: ["orders", "daily", "events"], exclude: ["weekly"], kept: 2, dropped: 2 },
    });
    const none = await sl(t.root, ["import", "--source", "wh", "--file", file, "--include", "raw.*"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain(`No table in ${file} within intake.schemas matches --include and --exclude, so nothing was imported.`);
    expect(none.err).toContain("and the schemas in intake.schemas and run sl import again.");
  });

  test("an export source imports intake.export.file with --include", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    writeFileSync(join(t.root, "schema.csv"), CSV);
    patchSource(t.root, "wh", { intake: { mode: "export", reason: "No outside connections.", schemas: ["acme"], export: { file: "schema.csv" } } });
    const r = await sl(t.root, ["import", "--source", "wh", "--include", "orders", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 1, dropped: { tables: 3, schemas: ["marts", "raw"] }, filters: { kept: 1, dropped: 1 } });
    expect(names(t.root, "wh")).toEqual(["acme.orders"]);
  });

  test("a DuckDB export spanning databases matches the opened database's schemas by name", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    patchSource(t.root, "wh", { connection: { database: "wh.duckdb" }, intake: { schemas: ["acme", "lake.raw"] } });
    const file = join(t.dir, "schema.json");
    writeFileSync(file, JSON.stringify([
      { table_catalog: "wh", table_schema: "acme", table_name: "orders", column_name: "id", data_type: "int" },
      { table_catalog: "wh", table_schema: "other", table_name: "x", column_name: "id", data_type: "int" },
      { table_catalog: "lake", table_schema: "raw", table_name: "hits", column_name: "id", data_type: "int" },
    ]));
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(r.json()).toMatchObject({ tables: 2, dropped: { tables: 1, schemas: ["wh.other"] } });
    expect(names(t.root, "wh")).toEqual(["lake.raw.hits", "wh.acme.orders"]);
  });

  test("a DuckDB schema export, live, imports only intake.schemas", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", [...TWO_SCHEMAS, "create schema third", "create table third.t (id integer)"]);
    patchSource(t.root, "wh", { intake: { schemas: ["acme"] } });
    const exp = await sl(t.root, ["export-sql", "--dialect", "duckdb", "--json"]);
    const db = await DuckDBInstance.create(join(t.dir, "wh.duckdb"));
    const c = await db.connect();
    const rows = (await c.runAndReadAll(exp.json<{ sql: string }>().sql)).getRowObjectsJson();
    c.closeSync();
    db.closeSync();
    const file = join(t.dir, "schema.json");
    writeFileSync(file, JSON.stringify(rows));
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, primary_keys: 2, dropped: { tables: 3, schemas: ["main", "other", "third"] } });
    expect(names(t.root, "wh")).toEqual(["acme.customers", "acme.orders"]);
  });
});

describe("import in export mode reads intake.export.file", () => {
  test("no --file imports intake.export.file from the semantic root", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    mkdirSync(join(t.root, "exports"), { recursive: true });
    writeFileSync(join(t.root, "exports", "warehouse.csv"), CSV);
    patchSource(t.root, "wh", { intake: { mode: "export", reason: "No outside connections.", schemas: ["marts"], export: { file: "exports/warehouse.csv" } } });
    // The working directory is elsewhere: the file resolves from the root.
    const r = await sl(t.root, ["import", "--source", "wh", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tables: 2, dropped: { tables: 3, schemas: ["acme", "raw"] } });
    expect(names(t.root, "wh")).toEqual(["marts.daily", "marts.weekly"]);
  });

  test("an export.file outside the root is refused, and a connection source still needs --file", async () => {
    const t = await setup();
    await duckdbSource(t.root, t.dir, "wh", []);
    writeFileSync(join(t.dir, "outside.csv"), CSV);
    patchSource(t.root, "wh", { intake: { mode: "export", reason: "No outside connections.", export: { file: "../outside.csv" } } });
    const out = await sl(t.root, ["import", "--source", "wh"]);
    expect(out.code).toBe(1);
    expect(out.err).toContain("intake.export.file in sources/wh.yaml must be a path inside the semantic root");
    expect(existsSnapshot(t.root)).toBe(false);

    patchSource(t.root, "wh", { intake: { mode: "export", reason: "No outside connections.", export: { file: "exports/none.csv" } } });
    const gone = await sl(t.root, ["import", "--source", "wh"]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain("intake.export.file in sources/wh.yaml names exports/none.csv, which does not exist under the semantic root");
    expect(gone.err).toContain("or pass --file");

    patchSource(t.root, "wh", { intake: { mode: "connection" } });
    const conn = await sl(t.root, ["import", "--source", "wh"]);
    expect(conn.code).toBe(1);
    expect(conn.err).toContain("--file is required: pass the export to import, as in sl import --source wh --file schema.csv");
  });
});

function existsSnapshot(root: string): boolean {
  try {
    readFileSync(join(root, "snapshots", "wh.json"));
    return true;
  } catch {
    return false;
  }
}

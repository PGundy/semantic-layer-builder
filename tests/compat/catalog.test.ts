// Introspection on the catalog's odder objects, on whatever server PG_URL names (scripts/compat-pg.sh
// runs it per major version): a partitioned table, a view, a materialized view, a foreign table, a name
// in mixed case, and a role that can read only part of a schema.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { EXPORTS_DIR } from "../../skills/semantic-layer/scripts/commands/export-sql.ts";
import { compileRequest } from "../../skills/semantic-layer/scripts/lib/compiler/index.ts";
import type { Model, Snapshot, SnapshotTable } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, initProject, PG_URL, reapprove, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const PASSWORD = "test-only-password";
const schema = uniqueSchema("t_compat_catalog");
const restricted = uniqueSchema("t_compat_ro");
const mixed = `Sales_${schema}`;
const role = `r_${restricted}`;
const server = `fdw_${schema}`;
let pg: SQL | undefined;
let versionNum = 0;
let fdw = false;
let madeExtension = false;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const url = (user?: string) => {
  const u = new URL(PG_URL!);
  if (user) {
    u.username = user;
    u.password = PASSWORD;
  }
  return u.toString();
};

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  pg = new SQL({ url: PG_URL, max: 1 });
  versionNum = Number(((await pg.unsafe("show server_version_num")) as { server_version_num: string }[])[0]!.server_version_num);
  for (const s of [
    `create schema ${schema}`,
    `create table ${schema}.events (event_id bigint, happened_at date not null, primary key (event_id, happened_at)) partition by range (happened_at)`,
    `create table ${schema}.events_2025 partition of ${schema}.events for values from ('2025-01-01') to ('2026-01-01')`,
    `create table ${schema}.events_2026 partition of ${schema}.events for values from ('2026-01-01') to ('2027-01-01')`,
    `create table ${schema}.plain (id integer primary key, label text)`,
    `create view ${schema}.plain_view as select id, label from ${schema}.plain`,
    `create materialized view ${schema}.plain_matview as select id, label from ${schema}.plain`,
    `insert into ${schema}.plain select g, 'l' || g from generate_series(1, 5) g`,
    `refresh materialized view ${schema}.plain_matview`,
    `analyze ${schema}.plain`,
    `create schema "${mixed}"`,
    `create table "${mixed}"."Orders" ("OrderId" integer primary key, "AmountCents" bigint not null, "Region" text)`,
    `insert into "${mixed}"."Orders" values (1, 1250, 'north'), (2, 4000, 'south'), (3, 800, 'north')`,
    // Four tables, two of which the restricted role reads. The key from a to c points at a table it cannot read.
    `create table ${schema}.a (id integer primary key, c_id integer)`,
    `create table ${schema}.b (id integer primary key, a_id integer references ${schema}.a)`,
    `create table ${schema}.c (id integer primary key)`,
    `create table ${schema}.d (id integer primary key, c_id integer references ${schema}.c)`,
    `alter table ${schema}.a add foreign key (c_id) references ${schema}.c`,
    `create role ${role} login password '${PASSWORD}'`,
    `grant usage on schema ${schema} to ${role}`,
    `grant select on ${schema}.a, ${schema}.b to ${role}`,
  ]) await pg.unsafe(s);

  // A foreign table needs postgres_fdw, which the server may not have installed.
  try {
    const have = (await pg.unsafe("select 1 as x from pg_extension where extname = 'postgres_fdw'")) as unknown[];
    if (!have.length) {
      await pg.unsafe("create extension postgres_fdw");
      madeExtension = true;
    }
    const u = new URL(PG_URL);
    const opts = [`host '${u.hostname}'`, `port '${u.port || "5432"}'`, `dbname '${decodeURIComponent(u.pathname.slice(1)) || "postgres"}'`];
    await pg.unsafe(`create server ${server} foreign data wrapper postgres_fdw options (${opts.join(", ")})`);
    await pg.unsafe(
      `create user mapping for current_user server ${server} options (user '${decodeURIComponent(u.username)}', password '${decodeURIComponent(u.password)}')`,
    );
    await pg.unsafe(`create foreign table ${schema}.remote_plain (id integer, label text) server ${server} options (schema_name '${schema}', table_name 'plain')`);
    fdw = true;
  } catch (e) {
    console.log(`compat: skip foreign table, postgres_fdw is not usable on server_version_num ${versionNum}: ${(e as Error).message}`);
  }
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.unsafe(`drop schema if exists "${mixed}" cascade`);
  await pg.unsafe(`drop owned by ${role}`).catch(() => {});
  await pg.unsafe(`drop role if exists ${role}`);
  await pg.unsafe(`drop server if exists ${server} cascade`).catch(() => {});
  if (madeExtension) await pg.unsafe("drop extension if exists postgres_fdw cascade").catch(() => {});
  await pg.close();
});

const byName = (s: Snapshot, name: string): SnapshotTable => {
  const t = s.tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name} in ${s.tables.map((x) => x.name).join(", ")}`);
  return t;
};

// A project with a postgres source `pg` that reads `schemas`, as the role `user` (default the admin).
async function project(user?: string) {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const add = await semlayer(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG"]);
  expect(add.code).toBe(0);
  return { ...t, env: { SEMLAYER_TEST_PG: url(user) } };
}

const snapshotOf = (root: string) => JSON.parse(readFileSync(join(root, "snapshots", "pg.json"), "utf8")) as Snapshot;

describe("catalog objects", () => {
  test.skipIf(!PG_URL)("a partitioned table appears once, a foreign table is external, views have no row count", async () => {
    const t = await project();
    const r = await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", schema, "--json"], t.env);
    expect(r.code).toBe(0);
    const snap = snapshotOf(t.root);
    const names = snap.tables.map((x) => x.name);
    expect(names.filter((n) => n === "events")).toEqual(["events"]);
    expect(names).not.toContain("events_2025");
    expect(names).not.toContain("events_2026");
    expect(byName(snap, "events").kind).toBe("table");
    expect(byName(snap, "events").primary_key).toEqual(["event_id", "happened_at"]);
    for (const v of ["plain_view", "plain_matview"]) expect(byName(snap, v)).toMatchObject({ kind: "view", row_count: null });
    if (fdw) expect(byName(snap, "remote_plain")).toMatchObject({ kind: "external" });
    else console.log("compat: foreign table assertions skipped");
  });

  test.skipIf(!PG_URL)("a role with SELECT on two of four tables gets two, and the output names the other two", async () => {
    const t = await project(role);
    const r = await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", schema], t.env);
    expect(r.code).toBe(0);
    const snap = snapshotOf(t.root);
    expect(snap.tables.map((x) => x.name)).toEqual(["a", "b"]);
    // The unreadable relations are the other two tables, the views, the foreign table and the partitioned table.
    for (const name of [`${schema}.c`, `${schema}.d`]) expect(r.out).toContain(name);
    expect(r.out).toMatch(/Skipped \d+ relations this role cannot read: /);
    expect(r.out).toContain("grant SELECT");
    const j = await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", schema, "--json"], t.env);
    const skipped = j.json<{ skipped_unreadable: { schema: string; name: string }[] }>().skipped_unreadable.map((x) => `${x.schema}.${x.name}`);
    const expected = ["c", "d", "events", "plain", "plain_view", "plain_matview", ...(fdw ? ["remote_plain"] : [])].map((n) => `${schema}.${n}`);
    expect([...skipped].sort()).toEqual(expected.sort());
  });

  test.skipIf(!PG_URL)("the restricted role's snapshot has no entry, column or key for the unreadable tables", async () => {
    const t = await project(role);
    expect((await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", schema], t.env)).code).toBe(0);
    const snap = snapshotOf(t.root);
    for (const gone of ["c", "d"]) expect(snap.tables.some((x) => x.name === gone)).toBe(false);
    // a points at c, which the role cannot read, so that key is not kept; b's key into a is.
    expect(byName(snap, "a").foreign_keys).toEqual([]);
    expect(byName(snap, "b").foreign_keys).toMatchObject([{ columns: ["a_id"], references: { table: "a", columns: ["id"] } }]);
    expect(snap.tables.flatMap((x) => x.columns.map((c) => `${x.name}.${c.name}`)).filter((n) => n.startsWith("c.") || n.startsWith("d."))).toEqual([]);
  });

  test.skipIf(!PG_URL)("the export query leaves out the same relations", async () => {
    const t = await project();
    const exp = await semlayer(t.root, ["export-sql", "--dialect", "postgres", "--schemas", schema]);
    expect(exp.code).toBe(0);
    expect(readFileSync(join(EXPORTS_DIR, "postgres.sql"), "utf8")).toContain("has_any_column_privilege");
    const ro = new SQL({ url: url(role), max: 1 });
    try {
      const rows = (await ro.unsafe(exp.out)) as { table_name: string; references_table: string | null }[];
      expect([...new Set(rows.map((r) => r.table_name))].sort()).toEqual(["a", "b"]);
      expect(rows.map((r) => r.references_table).filter((n) => n === "c" || n === "d")).toEqual([]);
    } finally {
      await ro.close();
    }
  });

  test.skipIf(!PG_URL)("a mixed-case schema and table is introspected, drafted and compiled with quoted names", async () => {
    const t = await project();
    expect((await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", mixed, "--json"], t.env)).code).toBe(0);
    const snap = snapshotOf(t.root);
    expect(snap.tables.map((x) => [x.schema, x.name])).toEqual([[mixed, "Orders"]]);
    expect(snap.tables[0]!.columns.map((c) => c.name)).toEqual(["OrderId", "AmountCents", "Region"]);

    const d = await semlayer(t.root, ["draft", "--source", "pg", "--json"]);
    expect(d.code).toBe(0);
    const file = readdirModels(t.root);
    const model = readYaml<Model>(file);
    expect(model.table).toBe(`${mixed}.Orders`);
    expect(model.primary_key).toEqual(["OrderId"]);

    // Approve a measure and a dimension over the quoted names, then compile.
    const ok = { status: "approved", approved_by: "Test Owner", approved_at: "2026-01-01" };
    writeYaml(file, {
      ...model,
      ...ok,
      dimensions: [{ name: "region", expr: '"Region"', type: "string", ...ok }],
      measures: [{ name: "amount", expr: '"AmountCents"', agg: "sum", ...ok }],
    });
    await reapprove(t.root);
    const c = compileRequest(t.root, { source: "pg", measures: [`${model.model}.amount`], dimensions: [`${model.model}.region`] });
    if (!c.ok) throw new Error(`refused: ${c.reason}`);
    expect(c.sql).toContain(`from "${mixed}"."Orders"`);
    const db = new SQL({ url: PG_URL!, max: 1 });
    try {
      const rows = (await db.unsafe(c.sql, c.params as never[])) as { region: string; amount: unknown }[];
      expect(rows.map((r) => [r.region, Number(r.amount)]).sort()).toEqual([["north", 2050], ["south", 4000]]);
    } finally {
      await db.close();
    }
  });

  test.skipIf(!PG_URL)("two-schemas.sql loads: a key across schemas and a table of the same name in both", async () => {
    // The fixture's schema names are fixed, so it loads only where neither exists.
    const taken = (await pg!.unsafe("select 1 as x from pg_namespace where nspname in ('sales', 'crm')")) as unknown[];
    if (taken.length) return console.log("compat: skip two-schemas.sql, sales or crm exists on this server");
    await pg!.unsafe(readFileSync(join(import.meta.dir, "two-schemas.sql"), "utf8"));
    try {
      const t = await project();
      expect((await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", "sales,crm", "--json"], t.env)).code).toBe(0);
      const snap = snapshotOf(t.root);
      expect(snap.tables.filter((x) => x.name === "customers").map((x) => x.schema).sort()).toEqual(["crm", "sales"]);
      expect(byName(snap, "orders").foreign_keys).toEqual([
        { columns: ["customer_id"], references: { schema: "crm", table: "customers", columns: ["customer_id"] }, constraint: "orders_customer_fk" },
        { columns: ["store_id"], references: { schema: "sales", table: "stores", columns: ["store_id"] }, constraint: "orders_store_fk" },
      ]);
    } finally {
      await pg!.unsafe("drop schema sales, crm cascade");
    }
  });
});

function readdirModels(root: string): string {
  const dir = join(root, "models", "pg");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  if (files.length !== 1) throw new Error(`expected one model, found ${files.join(", ")}`);
  return join(dir, files[0]!);
}

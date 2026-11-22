// Runs on whatever server PG_URL names; scripts/compat-pg.sh <major> and the CI `compat` job run it
// once per supported major version (13 to 17). It records the server version, then checks that
// introspection and the schema export read the same small schema the same way.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { EXPORTS_DIR } from "../../skills/semantic-layer/scripts/commands/export-sql.ts";
import { buildSnapshot } from "../../skills/semantic-layer/scripts/lib/introspect.ts";
import { executePlan } from "../../skills/semantic-layer/scripts/lib/plan.ts";
import { introspectionPlan } from "../../skills/semantic-layer/scripts/lib/sql/introspection.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { assertLocalPg, FIXED_NOW, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const schema = uniqueSchema("t_compat_version");
const source: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "SEMLAYER_TEST_PG" } };
let pg: SQL | undefined;
let versionNum = 0;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!PG_URL) return;
  assertLocalPg(PG_URL);
  pg = new SQL(PG_URL);
  versionNum = Number(((await pg.unsafe("show server_version_num")) as { server_version_num: string }[])[0]!.server_version_num);
  for (const s of [
    `create schema ${schema}`,
    `create table ${schema}.customers (customer_id integer primary key, email text not null, region text)`,
    `comment on table ${schema}.customers is 'People who buy.'`,
    `create table ${schema}.orders (order_id integer primary key, customer_id integer references ${schema}.customers, amount_cents bigint not null)`,
    `create table ${schema}.order_lines (order_id integer references ${schema}.orders, line_no integer, qty numeric(10,2), primary key (line_no, order_id))`,
    `create table ${schema}.events (event_id bigint, happened_at date not null, primary key (event_id, happened_at)) partition by range (happened_at)`,
    `create table ${schema}.events_2025 partition of ${schema}.events for values from ('2025-01-01') to ('2026-01-01')`,
    `create table ${schema}.events_2026 partition of ${schema}.events for values from ('2026-01-01') to ('2027-01-01')`,
    `create view ${schema}.v_orders as select order_id, amount_cents from ${schema}.orders`,
    `insert into ${schema}.customers select g, 'c' || g || '@example.com', null from generate_series(1, 25) g`,
    `insert into ${schema}.events select g, date '2025-06-01' + (g % 400) from generate_series(1, 40) g`,
    `analyze ${schema}.customers`,
    `analyze ${schema}.events`,
    `create table ${schema}.empty_analyzed (id integer)`,
    `analyze ${schema}.empty_analyzed`,
  ]) await pg.unsafe(s);
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

const byName = (s: Snapshot, name: string): SnapshotTable => {
  const t = s.tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name} in ${s.tables.map((x) => x.name).join(", ")}`);
  return t;
};

// What the two paths must agree on. The foreign-key copies a partitioned table's partitions keep are not compared.
// The export file carries no constraint names, so a key is compared by its columns and target.
const shape = (s: Snapshot) =>
  s.tables.map((t) => ({
    name: t.name,
    kind: t.kind,
    description: t.description,
    row_count: t.row_count,
    primary_key: t.primary_key,
    foreign_keys: (t.foreign_keys ?? []).map((fk) => ({ columns: fk.columns, references: fk.references })),
    columns: t.columns.map(({ profile: _, ...c }) => c),
  }));

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

describe("postgres version", () => {
  test.skipIf(!PG_URL)("records the server version, and it is a supported major", () => {
    console.log(`compat: server_version_num ${versionNum}`);
    expect(versionNum).toBeGreaterThanOrEqual(130000);
  });

  test.skipIf(!PG_URL)("introspection returns the fixture schema's tables, columns and keys", async () => {
    const plan = introspectionPlan(source, { schemas: [schema] });
    const results = await executePlan(plan, { root: "unused", source, env: { SEMLAYER_TEST_PG: PG_URL } });
    const snap = buildSnapshot(source, results, FIXED_NOW, null);
    expect(snap.tables.map((t) => t.name)).toEqual(["customers", "empty_analyzed", "events", "order_lines", "orders", "v_orders"]);
    expect(byName(snap, "customers")).toMatchObject({ kind: "table", row_count: 25, description: "People who buy.", primary_key: ["customer_id"] });
    expect(byName(snap, "customers").columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["customer_id", "integer", false],
      ["email", "text", false],
      ["region", "text", true],
    ]);
    // A never-analyzed table has no count; an analyzed empty table reads 0 from PostgreSQL 14 and no count before.
    expect(byName(snap, "orders").row_count).toBeNull();
    expect(byName(snap, "empty_analyzed").row_count).toBe(versionNum >= 140000 ? 0 : null);
    expect(byName(snap, "orders").foreign_keys).toEqual([
      { columns: ["customer_id"], references: { schema, table: "customers", columns: ["customer_id"] }, constraint: "orders_customer_id_fkey" },
    ]);
    expect(byName(snap, "order_lines").primary_key).toEqual(["line_no", "order_id"]);
    expect(byName(snap, "order_lines").columns.find((c) => c.name === "qty")!.type).toBe("numeric(10,2)");
    expect(byName(snap, "events").primary_key).toEqual(["event_id", "happened_at"]);
    expect(byName(snap, "v_orders")).toMatchObject({ kind: "view", row_count: null });
  });

  test.skipIf(!PG_URL)("the export query imports to the same snapshot as live introspection", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const exp = await semlayer(t.root, ["export-sql", "--dialect", "postgres", "--schemas", schema]);
    expect(exp.code).toBe(0);
    expect(readFileSync(join(EXPORTS_DIR, "postgres.sql"), "utf8")).toContain("pg_catalog");
    const rows = (await pg!.unsafe(exp.out)) as Record<string, unknown>[];
    const columns = Object.keys(rows[0]!);
    const csv = join(t.dir, "schema.csv");
    writeFileSync(csv, [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");

    expect((await semlayer(t.root, ["add-source", "--name", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_PG"])).code).toBe(0);
    const imp = await semlayer(t.root, ["import", "--source", "pg", "--file", csv, "--json"]);
    expect(imp.err).toBe("");
    expect(imp.code).toBe(0);
    expect(imp.json()).toMatchObject({ tables: 6, primary_keys: 4, warnings: [] });
    const imported = JSON.parse(readFileSync(join(t.root, "snapshots", "pg.json"), "utf8")) as Snapshot;
    expect(byName(imported, "events").row_count).toBe(40);

    const live = await semlayer(t.root, ["introspect", "--source", "pg", "--schemas", schema, "--json"], { SEMLAYER_TEST_PG: PG_URL });
    expect(live.code).toBe(0);
    const liveSnap = JSON.parse(readFileSync(join(t.root, "snapshots", "pg.json"), "utf8")) as Snapshot;
    expect(shape(liveSnap)).toEqual(shape(imported));
  });
});

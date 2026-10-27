import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { duckdbSource, FIXED_NOW, initProject, PG_URL, sl, tempRoot } from "./helpers.ts";
import {
  applyProfile,
  hashValue,
  holdsRawValues,
  isHashedValue,
  LOW_CARDINALITY_MAX,
  protectedColumns,
  redactProfile,
  redactSnapshot,
  summarizeTable,
} from "../skills/semantic-layer/scripts/lib/profile.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { loadSnapshot, saveSnapshot } from "../skills/semantic-layer/scripts/lib/project.ts";
import { buildProfilePlan, MAX_TOP_COLUMNS } from "../skills/semantic-layer/scripts/lib/sql/profile.ts";
import type { Dialect, Model, QueryPlan, Snapshot, SnapshotColumn, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function table(schema: string | null, name: string, columns: [string, string][], rowCount: number | null = null): SnapshotTable {
  return {
    schema,
    name,
    kind: "table",
    row_count: rowCount,
    description: null,
    primary_key: [],
    unique_keys: [],
    foreign_keys: [],
    columns: columns.map(([n, type]): SnapshotColumn => ({ name: n, type, nullable: true, description: null })),
  };
}

function writeSnapshot(root: string, source: string, dialect: Dialect, tables: SnapshotTable[]): void {
  const snapshot: Snapshot = { snapshot_version: 1, source, dialect, captured_at: FIXED_NOW, method: "live", tables };
  saveSnapshot(root, snapshot);
}

function snap(root: string, source: string): Snapshot {
  const s = loadSnapshot(root, source);
  if (!s) throw new Error("no snapshot");
  return s;
}

function col(s: Snapshot, tableName: string, column: string): SnapshotColumn {
  const t = s.tables.find((x) => x.name === tableName);
  const c = t?.columns.find((x) => x.name === column);
  if (!c) throw new Error(`no column ${tableName}.${column}`);
  return c;
}

interface ProfileJson {
  source: string;
  profiled: { table: string; row_count: number; candidate_keys: string[]; low_cardinality: string[] }[];
  skipped: { table: string; reason: string }[];
}

const ORDERS_SQL = `create table orders as select * from (values
  (1, 'k1', 'completed', 'web',   1.50, date '2025-01-01', timestamp '2025-01-01 08:00:00', true,  ['a']),
  (2, 'k2', 'completed', 'web',   20.00, date '2025-01-01', timestamp '2025-01-02 08:00:00', true,  ['a','b']),
  (3, 'k3', 'completed', 'app',   20.00, date '2025-02-01', timestamp '2025-01-03 08:00:00', true,  null),
  (4, 'k4', 'completed', 'app',   5.25, date '2025-02-01', timestamp '2025-01-04 08:00:00', false, null),
  (5, 'k5', 'pending',   'store', 99.00, date '2025-03-31', timestamp '2025-01-05 08:00:00', false, null),
  (6, 'k6', 'pending',   'web',   null, date '2025-03-31', timestamp '2025-01-06 08:00:00', true,  null),
  (7, 'k7', 'cancelled', 'app',   7.00, date '2025-03-01', timestamp '2025-01-07 08:00:00', true,  null),
  (8, 'k8', null,        'store', 7.00, date '2025-03-01', timestamp '2025-01-08 23:59:59', false, null)
) v(id, code, status, channel, amount, order_date, created_at, paid, tags)`;

const ORDERS_COLUMNS: [string, string][] = [
  ["id", "INTEGER"],
  ["code", "VARCHAR"],
  ["status", "VARCHAR"],
  ["channel", "VARCHAR"],
  ["amount", "DECIMAL(10,2)"],
  ["order_date", "DATE"],
  ["created_at", "TIMESTAMP"],
  ["paid", "BOOLEAN"],
  ["tags", "VARCHAR[]"],
];

describe("profile (duckdb)", () => {
  test("measures nulls, distinct counts, ranges, top values and keys", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", [ORDERS_SQL.replace("1.50", "1.50::decimal(10,2)")]);
    writeSnapshot(t.root, "wh", "duckdb", [table("main", "orders", ORDERS_COLUMNS, 8)]);

    const r = await sl(t.root, ["profile", "--source", "wh", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson>();
    expect(out.source).toBe("wh");
    expect(out.profiled).toHaveLength(1);
    const p = out.profiled[0]!;
    expect(p.table).toBe("main.orders");
    expect(p.row_count).toBe(8);
    // created_at is unique here but a timestamp, so it is neither a key nor low-cardinality.
    expect(p.candidate_keys).toEqual(["id", "code"]);
    expect(p.low_cardinality).toEqual(["status", "channel", "amount", "order_date", "paid"]);

    const s = snap(t.root, "wh");
    const orders = s.tables[0]!;
    expect(orders.row_count).toBe(8);
    expect(orders.profiled_at).toBe(FIXED_NOW);

    const status = col(s, "orders", "status").profile!;
    expect(status.null_fraction).toBe(0.125);
    expect(status.distinct_count).toBe(3);
    expect(status.min).toBeNull();
    expect(status.top_values).toEqual([
      { value: "completed", count: 4 },
      { value: "pending", count: 2 },
      { value: "cancelled", count: 1 },
    ]);
    expect(status.sampled).toBe(false);

    // Ties order by value.
    expect(col(s, "orders", "channel").profile!.top_values).toEqual([
      { value: "app", count: 3 },
      { value: "web", count: 3 },
      { value: "store", count: 2 },
    ]);

    const amount = col(s, "orders", "amount").profile!;
    expect(amount.null_fraction).toBe(0.125);
    expect(amount.distinct_count).toBe(5);
    expect(amount.min).toBe(1.5);
    expect(amount.max).toBe(99);
    expect(amount.top_values).toBeUndefined();

    const id = col(s, "orders", "id").profile!;
    expect(id).toMatchObject({ null_fraction: 0, distinct_count: 8, min: 1, max: 8 });

    const day = col(s, "orders", "order_date").profile!;
    expect(day).toMatchObject({ distinct_count: 4, min: "2025-01-01", max: "2025-03-31" });
    expect(col(s, "orders", "created_at").profile).toMatchObject({ min: "2025-01-01 08:00:00", max: "2025-01-08 23:59:59" });

    expect(col(s, "orders", "paid").profile!.top_values).toEqual([
      { value: true, count: 5 },
      { value: false, count: 3 },
    ]);

    const tags = col(s, "orders", "tags").profile!;
    expect(tags.null_fraction).toBe(0.75);
    expect(tags.distinct_count).toBeNull();
    expect(tags.top_values).toBeUndefined();

    const human = await sl(t.root, ["profile", "--source", "wh", "--refresh"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("main.orders: 8 rows; candidate keys: id, code; low-cardinality:");
  });

  test("samples large tables and extrapolates distinct keys", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "lake", [
      "create table events as select range as event_id, range % 5 as kind, case when range % 10 = 0 then null else 'u' || (range % 7)::varchar end as label from range(10000)",
      "create table small as select range as id from range(50)",
    ]);
    writeYaml(join(t.root, "sources", "lake.yaml"), { ...source, profile: { sample_rows: 1000, top_values: 3 } });
    writeSnapshot(t.root, "lake", "duckdb", [
      table("main", "events", [["event_id", "BIGINT"], ["kind", "BIGINT"], ["label", "VARCHAR"]], null),
      table("main", "small", [["id", "BIGINT"]], 50),
    ]);

    const plan = await sl(t.root, ["profile", "--source", "lake", "--emit-sql"]);
    expect(plan.code).toBe(0);
    const queries = plan.json<QueryPlan>().queries;
    const stats = queries.find((q) => q.id === "stats:main.events")!;
    expect(stats.sql).toContain("using sample reservoir(1000 rows)");
    expect(stats.sql).toContain('(select count(*) from "main"."events") as row_count');
    expect(queries.find((q) => q.id === "stats:main.small")!.sql).not.toContain("sample");
    expect(queries.find((q) => q.id === "top:main.events:label")!.sql).toContain("limit 3");

    const r = await sl(t.root, ["profile", "--source", "lake", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson>();
    const events = out.profiled.find((p) => p.table === "main.events")!;
    expect(events.row_count).toBe(10000);
    expect(events.candidate_keys).toEqual(["event_id"]);
    expect(events.low_cardinality).toEqual(["kind", "label"]);
    expect(out.profiled.find((p) => p.table === "main.small")!.candidate_keys).toEqual(["id"]);

    const s = snap(t.root, "lake");
    const eventId = col(s, "events", "event_id").profile!;
    expect(eventId.sampled).toBe(true);
    expect(eventId.distinct_count).toBe(10000);
    const kind = col(s, "events", "kind").profile!;
    expect(kind.distinct_count).toBe(5);
    expect(kind.min).toBe(0);
    expect(kind.max).toBe(4);
    const label = col(s, "events", "label").profile!;
    expect(label.null_fraction).toBeGreaterThan(0.05);
    expect(label.null_fraction).toBeLessThan(0.15);
    expect(label.top_values).toHaveLength(3);
    const counts = label.top_values!.map((v) => v.count);
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThan(1000);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(col(s, "small", "id").profile!.sampled).toBe(false);
  });

  test("defaults to unprofiled in-scope tables; --refresh and --tables", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "wh", [
      "create table fct_a as select range as id from range(3)",
      "create table fct_b as select range as id from range(4)",
      "create table tmp_x as select range as id from range(5)",
      "create table fct_b_backup as select range as id from range(6)",
    ]);
    writeYaml(join(t.root, "sources", "wh.yaml"), { ...source, scope: { include: ["fct_*", "tmp_*"], exclude: ["*_backup", "tmp_*"] } });
    const cols: [string, string][] = [["id", "BIGINT"]];
    writeSnapshot(t.root, "wh", "duckdb", [
      table("main", "fct_a", cols),
      table("main", "fct_b", cols),
      table("main", "fct_b_backup", cols),
      table("main", "tmp_x", cols),
    ]);

    const first = await sl(t.root, ["profile", "--source", "wh", "--json"]);
    expect(first.code).toBe(0);
    expect(first.json<ProfileJson>().profiled.map((p) => [p.table, p.row_count])).toEqual([
      ["main.fct_a", 3],
      ["main.fct_b", 4],
    ]);
    expect(snap(t.root, "wh").tables.find((x) => x.name === "tmp_x")!.profiled_at).toBeUndefined();

    const again = await sl(t.root, ["profile", "--source", "wh"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to profile");
    const againJson = await sl(t.root, ["profile", "--source", "wh", "--json"]);
    expect(againJson.json<ProfileJson>()).toEqual({
      source: "wh",
      profiled: [],
      skipped: [
        { table: "main.fct_a", reason: "already profiled" },
        { table: "main.fct_b", reason: "already profiled" },
      ],
      warnings: [],
    } as ProfileJson);

    const refresh = await sl(t.root, ["profile", "--source", "wh", "--refresh", "--json"]);
    expect(refresh.json<ProfileJson>().profiled).toHaveLength(2);

    const outside = await sl(t.root, ["profile", "--source", "wh", "--tables", "tmp_x,main.fct_a", "--json"]);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("main.tmp_x is out of scope");
    expect(snap(t.root, "wh").tables.find((x) => x.name === "tmp_x")!.profiled_at).toBeUndefined();

    const named = await sl(t.root, ["profile", "--source", "wh", "--tables", "main.fct_a", "--json"]);
    expect(named.code).toBe(0);
    const namedOut = named.json<ProfileJson>();
    expect(namedOut.profiled).toEqual([]);
    expect(namedOut.skipped).toEqual([{ table: "main.fct_a", reason: "already profiled" }]);
    const namedRefresh = await sl(t.root, ["profile", "--source", "wh", "--tables", "fct_b", "--refresh", "--json"]);
    expect(namedRefresh.json<ProfileJson>().profiled.map((p) => p.table)).toEqual(["main.fct_b"]);

    const unknown = await sl(t.root, ["profile", "--source", "wh", "--tables", "fct_a,nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("nope");
  });

  test("sparse columns in a sample keep their own distinct counts", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "lake", [
      "create table wide as select range as id, case when range % 500 = 0 then range % 1000 = 0 end as b, " +
        "case when range % 500 = 0 then 'v' || range::varchar end as rare, 'same' as k from range(20000)",
    ]);
    writeYaml(join(t.root, "sources", "lake.yaml"), { ...source, profile: { sample_rows: 1000 } });
    writeSnapshot(t.root, "lake", "duckdb", [
      table("main", "wide", [["id", "BIGINT"], ["b", "BOOLEAN"], ["rare", "VARCHAR"], ["k", "VARCHAR"]], 20000),
    ]);
    const r = await sl(t.root, ["profile", "--source", "lake", "--json"]);
    expect(r.code).toBe(0);
    const p = r.json<ProfileJson>().profiled[0]!;
    expect(p.candidate_keys).toEqual(["id"]);
    expect(p.low_cardinality).toContain("k");
    const s = snap(t.root, "lake");
    const b = col(s, "wide", "b").profile!;
    expect(b.sampled).toBe(true);
    expect(b.null_fraction).toBeGreaterThan(0.9);
    expect(b.distinct_count!).toBeLessThanOrEqual(2);
    expect(col(s, "wide", "rare").profile!.distinct_count!).toBeLessThanOrEqual(LOW_CARDINALITY_MAX);
    expect(col(s, "wide", "k").profile!.distinct_count).toBe(1);
    expect(col(s, "wide", "id").profile!.distinct_count).toBe(20000);
  });

  test("skips NaN in float bounds and arrays in min and max", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", [
      "create table m as select * from (values (1.5::double, [1, 2]::integer[2]), ('nan'::double, [1, 3]::integer[2]), (2.5::double, null)) v(f, fixed)",
    ]);
    writeSnapshot(t.root, "wh", "duckdb", [table("main", "m", [["f", "DOUBLE"], ["fixed", "INTEGER[2]"]], 3)]);
    const r = await sl(t.root, ["profile", "--source", "wh", "--json"]);
    expect(r.code).toBe(0);
    const s = snap(t.root, "wh");
    expect(col(s, "m", "f").profile).toMatchObject({ min: 1.5, max: 2.5, distinct_count: 3 });
    expect(col(s, "m", "fixed").profile).toMatchObject({ min: null, max: null, distinct_count: null });
  });

  test("checks profile settings and honours top_values 0", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "wh", ["create table a as select 1 as id, 'x' as s"]);
    writeSnapshot(t.root, "wh", "duckdb", [table("main", "a", [["id", "INTEGER"], ["s", "VARCHAR"]], 1)]);
    const yamlPath = join(t.root, "sources", "wh.yaml");

    writeYaml(yamlPath, { ...source, profile: { top_values: "abc" } });
    const bad = await sl(t.root, ["profile", "--source", "wh"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("profile.top_values in sources/wh.yaml");
    writeYaml(yamlPath, { ...source, profile: { sample_rows: -5 } });
    const badSample = await sl(t.root, ["profile", "--source", "wh"]);
    expect(badSample.code).toBe(1);
    expect(badSample.err).toContain("profile.sample_rows in sources/wh.yaml");

    writeYaml(yamlPath, { ...source, profile: { top_values: 0 } });
    const plan = await sl(t.root, ["profile", "--source", "wh", "--emit-sql"]);
    expect(plan.json<QueryPlan>().queries.map((q) => q.id)).toEqual(["stats:main.a"]);
    const r = await sl(t.root, ["profile", "--source", "wh"]);
    expect(r.code).toBe(0);
    expect(col(snap(t.root, "wh"), "a", "s").profile!.top_values).toBeUndefined();
  });

  test("requires a snapshot and a known source", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table a as select 1 as id"]);
    const noSnap = await sl(t.root, ["profile", "--source", "wh"]);
    expect(noSnap.code).toBe(1);
    expect(noSnap.err).toContain("No snapshot");
    const noSource = await sl(t.root, ["profile", "--source", "zz"]);
    expect(noSource.code).toBe(1);
  });
});

describe("profile plan", () => {
  test("caps top-values queries per table and quotes identifiers", () => {
    const cols: [string, string][] = Array.from({ length: 45 }, (_, i) => [`s${i}`, "varchar"]);
    cols.push(['we"ird', "integer"]);
    const source: SourceConfig = { source: "sf", dialect: "snowflake" };
    const { plan, capped, sampled } = buildProfilePlan(source, [table("PUBLIC", "WIDE", cols, 10)], { top_values: 5 });
    expect(plan.queries.filter((q) => q.id.startsWith("top:"))).toHaveLength(MAX_TOP_COLUMNS);
    expect(capped).toEqual([{ table: "PUBLIC.WIDE", columns: ["s40", "s41", "s42", "s43", "s44"] }]);
    expect(sampled).toEqual([]);
    const stats = plan.queries[0]!;
    expect(stats.sql).toContain('from "PUBLIC"."WIDE" as s');
    expect(stats.sql).toContain('cast(min("we""ird") as varchar) as c45_min');
    expect(stats.sql).toContain('approx_count_distinct("s0") as c0_distinct');

    const bq = buildProfilePlan({ source: "bq", dialect: "bigquery" }, [table("ds", "t", [["x", "STRING"]], null)], {
      sample_rows: 100,
      top_values: 3,
    });
    expect(bq.sampled).toEqual(["ds.t"]);
    expect(bq.plan.queries[1]!.sql).toContain("cast(`x` as string) as value");
  });

  test("a few nulls in a large table keep null_fraction above zero", () => {
    const source: SourceConfig = { source: "sf", dialect: "snowflake" };
    const t = table("PUBLIC", "BIG", [["ORDER_ID", "NUMBER(38,0)"]], 25_000_000);
    const snapshot: Snapshot = { snapshot_version: 1, source: "sf", dialect: "snowflake", captured_at: FIXED_NOW, method: "live", tables: [t] };
    const { plan } = buildProfilePlan(source, [t], { top_values: 10 });
    const results = { "stats:PUBLIC.BIG": [{ row_count: 25_000_000, c0_nulls: 2, c0_distinct: 24_990_000 }] };
    const out = applyProfile(snapshot, plan, results, FIXED_NOW, []).tables[0]!;
    expect(out.columns[0]!.profile!.null_fraction).toBeGreaterThan(0);
    expect(out.columns[0]!.profile!.null_fraction).toBe(8e-8);
    expect(summarizeTable(out, "snowflake").candidate_keys).toEqual([]);
  });

  test("a sampled plan needs sample_count in its results", () => {
    const source: SourceConfig = { source: "sf", dialect: "snowflake" };
    const t = table("PUBLIC", "BIG", [["ORDER_ID", "NUMBER(38,0)"]], 25_000_000);
    const snapshot: Snapshot = { snapshot_version: 1, source: "sf", dialect: "snowflake", captured_at: FIXED_NOW, method: "live", tables: [t] };
    const { plan, sampled } = buildProfilePlan(source, [t], { sample_rows: 1000, top_values: 10 });
    expect(sampled).toEqual(["PUBLIC.BIG"]);
    const results = { "stats:PUBLIC.BIG": [{ row_count: 25_000_000, c0_nulls: 500 }] };
    expect(() => applyProfile(snapshot, plan, results, FIXED_NOW, sampled)).toThrow(/sample_count/);
  });

  test("top_values 0 emits no top-values queries", () => {
    const t = table("m", "t", [["s", "varchar"], ["b", "boolean"]], 10);
    const { plan } = buildProfilePlan({ source: "m", dialect: "duckdb" }, [t], { top_values: 0 });
    expect(plan.queries.map((q) => q.id)).toEqual(["stats:m.t"]);
  });

  test("summarizeTable tolerates approximate counts only where they are approximate", () => {
    const t = table(null, "t", [["id", "int"]], 1000);
    t.columns[0]!.profile = { null_fraction: 0, distinct_count: 995, min: 1, max: 1000, sampled: false };
    expect(summarizeTable(t, "postgres").candidate_keys).toEqual([]);
    expect(summarizeTable(t, "snowflake").candidate_keys).toEqual(["id"]);
    t.columns[0]!.profile.null_fraction = 0.001;
    expect(summarizeTable(t, "snowflake").candidate_keys).toEqual([]);
  });
});

describe("profile (snowflake via results file)", () => {
  test("emits the plan, then reads synthetic results", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "sf.yaml"), {
      source: "sf",
      dialect: "snowflake",
      connection: { env: "SF_URL" },
      scope: { include: ["ANALYTICS.*"] },
    });
    writeSnapshot(t.root, "sf", "snowflake", [
      table("ANALYTICS", "FCT_ORDERS", [["ORDER_ID", "NUMBER(38,0)"], ["STATUS", "VARCHAR(16777216)"], ["AMOUNT", "NUMBER(12,2)"], ["CREATED_AT", "TIMESTAMP_NTZ(9)"], ["IS_TEST", "BOOLEAN"]], 25_000_000),
      table("RAW", "STAGE", [["X", "VARCHAR"]], 10),
    ]);

    const emitted = await sl(t.root, ["profile", "--source", "sf", "--emit-sql"]);
    expect(emitted.code).toBe(0);
    expect(emitted.err).toContain("25,000,000 rows");
    expect(emitted.err).toContain("sample_rows");
    const plan = emitted.json<QueryPlan>();
    expect(plan.dialect).toBe("snowflake");
    expect(plan.queries.map((q) => q.id)).toEqual([
      "stats:ANALYTICS.FCT_ORDERS",
      "top:ANALYTICS.FCT_ORDERS:STATUS",
      "top:ANALYTICS.FCT_ORDERS:IS_TEST",
    ]);

    const live = await sl(t.root, ["profile", "--source", "sf"]);
    expect(live.code).toBe(1);
    expect(live.err).toContain("--emit-sql");

    const results = {
      "stats:ANALYTICS.FCT_ORDERS": [
        {
          ROW_COUNT: "25000000",
          C0_NULLS: 0,
          C0_DISTINCT: 24900000,
          C0_MIN: "1",
          C0_MAX: "25000000",
          C1_NULLS: "250000",
          C1_DISTINCT: 4,
          C2_NULLS: 0,
          C2_DISTINCT: 90000,
          C2_MIN: "0.50",
          C2_MAX: "1999.99",
          C3_NULLS: 0,
          C3_DISTINCT: 24000000,
          C3_MIN: "2020-01-01 00:00:00.000",
          C3_MAX: "2026-10-01 12:00:00.000",
          C4_NULLS: 0,
          C4_DISTINCT: 2,
        },
      ],
      "top:ANALYTICS.FCT_ORDERS:STATUS": [
        { VALUE: "completed", N: 22000000 },
        { VALUE: "cancelled", N: "2750000" },
      ],
      "top:ANALYTICS.FCT_ORDERS:IS_TEST": [
        { VALUE: "false", N: 24999000 },
        { VALUE: "true", N: 1000 },
      ],
    };
    const file = join(t.dir, "results.json");
    writeFileSync(file, JSON.stringify(results));
    const r = await sl(t.root, ["profile", "--source", "sf", "--results", file, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson>();
    expect(out.profiled).toEqual([
      expect.objectContaining({
        table: "ANALYTICS.FCT_ORDERS",
        row_count: 25000000,
        candidate_keys: ["ORDER_ID"],
        low_cardinality: ["STATUS", "IS_TEST"],
      }),
    ]);
    const s = snap(t.root, "sf");
    expect(col(s, "FCT_ORDERS", "STATUS").profile).toEqual({
      null_fraction: 0.01,
      distinct_count: 4,
      min: null,
      max: null,
      top_values: [
        { value: "completed", count: 22000000 },
        { value: "cancelled", count: 2750000 },
      ],
      sampled: false,
    });
    expect(col(s, "FCT_ORDERS", "AMOUNT").profile).toMatchObject({ min: 0.5, max: 1999.99 });
    expect(col(s, "FCT_ORDERS", "ORDER_ID").profile).toMatchObject({ min: 1, max: 25000000 });
    expect(col(s, "FCT_ORDERS", "CREATED_AT").profile!.min).toBe("2020-01-01 00:00:00.000");
    expect(col(s, "FCT_ORDERS", "IS_TEST").profile!.top_values![0]).toEqual({ value: false, count: 24999000 });
    expect(s.tables.find((x) => x.name === "STAGE")!.profiled_at).toBeUndefined();

    const missing = join(t.dir, "partial.json");
    writeFileSync(missing, JSON.stringify({ "stats:ANALYTICS.FCT_ORDERS": results["stats:ANALYTICS.FCT_ORDERS"] }));
    const bad = await sl(t.root, ["profile", "--source", "sf", "--refresh", "--results", missing]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("top:ANALYTICS.FCT_ORDERS:STATUS");
  });
});

describe.skipIf(!PG_URL)("profile (postgres live)", () => {
  const schema = "t_profile";
  let db: SQL;

  beforeAll(async () => {
    db = new SQL(PG_URL!);
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.unsafe(`create schema ${schema}`);
    await db.unsafe(`create table ${schema}.customers (
      customer_id integer primary key,
      email text,
      tier text,
      balance numeric(10,2),
      signup date,
      seen_at timestamptz,
      active boolean,
      attrs json,
      loc point,
      area box
    )`);
    await db.unsafe(`insert into ${schema}.customers values
      (1, 'a@x.test', 'gold',   10.50, '2024-01-01', '2024-01-01 10:00:00+00', true,  '{}', '(1,2)', '((0,0),(1,1))'),
      (2, 'b@x.test', 'gold',   20.00, '2024-02-01', '2024-02-01 10:00:00+00', true,  '{}', '(1,2)', null),
      (3, 'c@x.test', 'silver', 30.00, '2024-03-01', '2024-03-01 10:00:00+00', false, null, null, null),
      (4, null,       'bronze', null,  '2024-04-30', '2024-04-30 23:00:00+00', true,  null, '(3,4)', null)`);
  });

  afterAll(async () => {
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    await db.close();
  });

  test("profiles a postgres table live", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), { source: "pg", dialect: "postgres", connection: { env: "PGTEST_URL" } });
    writeSnapshot(t.root, "pg", "postgres", [
      table(
        schema,
        "customers",
        [
          ["customer_id", "integer"],
          ["email", "text"],
          ["tier", "text"],
          ["balance", "numeric(10,2)"],
          ["signup", "date"],
          ["seen_at", "timestamp with time zone"],
          ["active", "boolean"],
          ["attrs", "json"],
          ["loc", "point"],
          ["area", "box"],
        ],
        null,
      ),
    ]);
    const r = await sl(t.root, ["profile", "--source", "pg", "--json"], { PGTEST_URL: PG_URL });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson>();
    expect(out.profiled).toEqual([
      expect.objectContaining({
        table: `${schema}.customers`,
        row_count: 4,
        // signup (a date) and seen_at (a timestamp) are unique here but are not key types.
        candidate_keys: ["customer_id"],
        low_cardinality: ["email", "tier", "balance", "active"],
      }),
    ]);
    const s = snap(t.root, "pg");
    expect(col(s, "customers", "email").profile).toMatchObject({ null_fraction: 0.25, distinct_count: 3 });
    expect(col(s, "customers", "tier").profile!.top_values).toEqual([
      { value: "gold", count: 2 },
      { value: "bronze", count: 1 },
      { value: "silver", count: 1 },
    ]);
    expect(col(s, "customers", "balance").profile).toMatchObject({ min: 10.5, max: 30, null_fraction: 0.25 });
    expect(col(s, "customers", "signup").profile).toMatchObject({ min: "2024-01-01", max: "2024-04-30" });
    expect(String(col(s, "customers", "seen_at").profile!.min)).toStartWith("2024-01-01 10:00:00");
    expect(col(s, "customers", "active").profile!.top_values).toEqual([
      { value: true, count: 3 },
      { value: false, count: 1 },
    ]);
    expect(col(s, "customers", "attrs").profile).toMatchObject({ null_fraction: 0.5, distinct_count: null });
    expect(col(s, "customers", "loc").profile).toMatchObject({ null_fraction: 0.25, distinct_count: null, min: null });
    expect(col(s, "customers", "area").profile).toMatchObject({ null_fraction: 0.75, distinct_count: null });

    writeYaml(join(t.root, "sources", "pg.yaml"), {
      source: "pg",
      dialect: "postgres",
      connection: { env: "PGTEST_URL" },
      profile: { sample_rows: 2 },
    });
    const sampled = await sl(t.root, ["profile", "--source", "pg", "--refresh", "--json"], { PGTEST_URL: PG_URL });
    expect(sampled.code).toBe(0);
    expect(sampled.json<ProfileJson>().profiled[0]!.row_count).toBe(4);
    expect(col(snap(t.root, "pg"), "customers", "tier").profile!.sampled).toBe(true);
  });
});

// Profiles of protected columns ------------------------------------------------

const PEOPLE_SQL = `create table people as select * from (values
  (1, 'Dana@Example.com', 'dana_r', 'Call after 5', 'active',  date '1990-04-01', 'west'),
  (2, 'lee@example.com',  'lee',    'Call after 5', 'active',  date '1985-01-15', 'west'),
  (3, 'kim@example.com',  'kimk',   null,           'churned', date '2001-12-31', 'east')
) v(id, email, handle, notes, status, birth_date, region)`;

const SHOP_SQL = "create table shops as select * from (values (1, 'North'), (2, 'South')) v(shop_id, shop_name)";

// A model over main.people: email and handle are read by pii-tagged dimensions; notes and
// birth_date are protected by their names alone.
function peopleModel(root: string, extra: Partial<Model> = {}): void {
  const model: Model = {
    model: "people",
    source: "shop",
    table: "main.people",
    status: "draft",
    primary_key: ["id"],
    dimensions: [
      { name: "email", expr: "email", type: "string", tags: ["pii"], status: "draft" },
      { name: "handle", expr: "lower(handle)", type: "string", tags: ["pii"], status: "draft" },
      { name: "status", expr: "status", type: "string", status: "draft" },
    ],
    measures: [],
    ...extra,
  };
  writeYaml(join(root, "models", "shop", "people.yaml"), model);
}

const hex16 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

interface RedactJson {
  source: string;
  redacted: string[];
}

describe("profiles of protected columns", () => {
  test("hashValue lowercases and trims, and keeps 16 hex characters", () => {
    expect(hashValue("  Dana@Example.COM ")).toBe(hex16("dana@example.com"));
    expect(hashValue("dana@example.com")).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(isHashedValue(hashValue("x"))).toBe(true);
    expect(isHashedValue("sha256:xyz")).toBe(false);
  });

  test("redactProfile hashes top values, drops text bounds and keeps number, date and boolean bounds", () => {
    const text = redactProfile({ null_fraction: 0, distinct_count: 2, min: "a", max: "b", top_values: [{ value: "Dana", count: 2 }, { value: null, count: 1 }], sampled: false }, { type: "VARCHAR" });
    expect(text).toEqual({ null_fraction: 0, distinct_count: 2, top_values: [{ value: hashValue("Dana"), count: 2 }, { value: null, count: 1 }], sampled: false, redacted: true });
    expect(redactProfile(text, { type: "VARCHAR" })).toEqual(text);
    const flag = redactProfile({ min: false, max: true, top_values: [{ value: true, count: 3 }] }, { type: "BOOLEAN" });
    expect(flag).toEqual({ min: false, max: true, top_values: [{ value: hashValue("true"), count: 3 }], redacted: true });
    const day = redactProfile({ min: "2025-01-01", max: "2025-03-31" }, { type: "DATE" });
    expect(day).toEqual({ min: "2025-01-01", max: "2025-03-31", redacted: true });
    const n = redactProfile({ min: 1, max: 9, top_values: [{ value: 7, count: 1 }] }, { type: "INTEGER" });
    expect(n.top_values).toEqual([{ value: hashValue("7"), count: 1 }]);
    expect(holdsRawValues(n, { type: "INTEGER" })).toBe(false);
    expect(holdsRawValues({ min: "a" }, { type: "VARCHAR" })).toBe(true);
    expect(holdsRawValues({ min: null, max: null }, { type: "VARCHAR" })).toBe(false);
  });

  test("protectedColumns: tags on fields and models, join references, ignored columns and names", () => {
    const people = table("main", "people", [["id", "INTEGER"], ["handle", "VARCHAR"], ["status", "VARCHAR"], ["notes_text", "VARCHAR"]]);
    const orders = table("main", "orders", [["order_id", "INTEGER"], ["person_id", "INTEGER"], ["channel", "VARCHAR"], ["memo", "VARCHAR"], ["phone", "VARCHAR"]]);
    const shops = table("main", "shops", [["shop_id", "INTEGER"], ["shop_name", "VARCHAR"]]);
    const models: unknown[] = [
      { model: "people", table: "main.people", dimensions: [{ name: "status", expr: "status" }], measures: [] },
      {
        model: "orders",
        table: "orders",
        ignored_columns: ["MEMO"],
        dimensions: [{ name: "buyer", expr: "upper(person.handle)", tags: ["PII"] }, { name: "channel", expr: "channel" }],
        measures: [],
        joins: [{ name: "person", to: "people", keys: [{ from: "person_id", to: "id" }], relationship: "many_to_one" }],
      },
      { model: "shops", table: "shops", tags: ["sensitive"], dimensions: [], measures: [] },
      "not a model",
    ];
    const prot = protectedColumns([people, orders, shops], models, "duckdb");
    expect([...(prot.get("main.people") ?? [])].sort()).toEqual(["handle", "notes_text"]);
    expect([...(prot.get("main.orders") ?? [])].sort()).toEqual(["memo", "phone"]);
    expect([...(prot.get("main.shops") ?? [])].sort()).toEqual(["shop_id", "shop_name"]);
  });

  test("sl profile stores hashed values for a pii email column and a notes column (duckdb)", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL]);
    expect((await sl(t.root, ["introspect", "--source", "shop"])).code).toBe(0);
    peopleModel(t.root);

    const r = await sl(t.root, ["profile", "--source", "shop", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson & { redacted: string[] }>();
    expect(out.redacted).toEqual(["main.people.email", "main.people.handle", "main.people.notes", "main.people.birth_date"]);

    const s = snap(t.root, "shop");
    const email = col(s, "people", "email").profile!;
    expect(email).toEqual({
      null_fraction: 0,
      distinct_count: 3,
      top_values: [
        { value: hashValue("Dana@Example.com"), count: 1 },
        { value: hashValue("kim@example.com"), count: 1 },
        { value: hashValue("lee@example.com"), count: 1 },
      ],
      sampled: false,
      redacted: true,
    });
    expect("min" in email).toBe(false);
    const notes = col(s, "people", "notes").profile!;
    expect(notes.top_values).toEqual([{ value: hashValue("call after 5"), count: 2 }]);
    expect(notes.redacted).toBe(true);
    expect("max" in notes).toBe(false);
    expect(col(s, "people", "handle").profile!.redacted).toBe(true);
    // A protected date keeps its range.
    expect(col(s, "people", "birth_date").profile).toMatchObject({ min: "1985-01-15", max: "2001-12-31", redacted: true });
    // Unprotected columns keep their raw values.
    expect(col(s, "people", "status").profile!.top_values).toEqual([{ value: "active", count: 2 }, { value: "churned", count: 1 }]);
    expect(col(s, "people", "region").profile!.redacted).toBeUndefined();
    const text = readFileSync(join(t.root, "snapshots", "shop.json"), "utf8");
    for (const raw of ["Dana@Example.com", "lee@example.com", "Call after 5", "dana_r"]) expect(text).not.toContain(raw);
    expect(validateProject(t.root).filter((i) => i.message.includes("raw sample values"))).toEqual([]);

    const human = await sl(t.root, ["profile", "--source", "shop", "--refresh"]);
    expect(human.out).toContain("Protected columns, stored with hashed top values and no text min or max: main.people.email, main.people.handle");
  });

  test("sl profile --redact rewrites protected profiles without a database, leaving the rest byte-identical", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL, SHOP_SQL]);
    expect((await sl(t.root, ["introspect", "--source", "shop"])).code).toBe(0);
    // Profiled before any model tags handle or ignores region.
    expect((await sl(t.root, ["profile", "--source", "shop"])).code).toBe(0);
    const path = join(t.root, "snapshots", "shop.json");
    const before = readFileSync(path, "utf8");
    expect(JSON.stringify(col(snap(t.root, "shop"), "people", "handle").profile!.top_values)).toContain("dana_r");

    peopleModel(t.root, { ignored_columns: ["region"] });
    expect(validateProject(t.root).filter((i) => i.message.includes("raw sample values")).map((i) => i.message)).toEqual([
      "main.people.handle is protected but the snapshot holds raw sample values; run sl profile --source shop --redact",
      "main.people.region is protected but the snapshot holds raw sample values; run sl profile --source shop --redact",
    ]);

    // --redact reads no database.
    rmSync(source.connection!.database!);
    const r = await sl(t.root, ["profile", "--source", "shop", "--redact", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<RedactJson>()).toEqual({ source: "shop", redacted: ["main.people.handle", "main.people.region"] });

    const old = JSON.parse(before) as Snapshot;
    const now = snap(t.root, "shop");
    const redacted = new Set(["people.handle", "people.region"]);
    for (const [ti, tbl] of old.tables.entries()) {
      const next = now.tables[ti]!;
      if (tbl.name !== "people") expect(JSON.stringify(next)).toBe(JSON.stringify(tbl));
      for (const [ci, c] of tbl.columns.entries()) {
        if (redacted.has(`${tbl.name}.${c.name}`)) continue;
        expect(JSON.stringify(next.columns[ci])).toBe(JSON.stringify(c));
      }
    }
    expect(col(now, "people", "handle").profile!.top_values!.every((v) => isHashedValue(v.value))).toBe(true);
    expect(col(now, "people", "region").profile).toMatchObject({ top_values: [{ value: hashValue("west"), count: 2 }, { value: hashValue("east"), count: 1 }], redacted: true });
    // Outside the two rewritten profiles, the file's text is unchanged.
    const strip = (text: string) => {
      const doc = JSON.parse(text) as Snapshot;
      for (const c of doc.tables.find((x) => x.name === "people")!.columns) if (redacted.has(`people.${c.name}`)) delete c.profile;
      return JSON.stringify(doc, null, 2);
    };
    expect(strip(readFileSync(path, "utf8"))).toBe(strip(before));
    expect(validateProject(t.root).filter((i) => i.message.includes("raw sample values"))).toEqual([]);

    const again = await sl(t.root, ["profile", "--source", "shop", "--redact"]);
    expect(again.out).toContain("Nothing to redact");
    const bad = await sl(t.root, ["profile", "--source", "shop", "--redact", "--refresh"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--redact reads no database and takes no --refresh");
  });

  test("protectedColumns: a two-hop join reference protects the joined column, not same-named columns of the model's own table", () => {
    const people = table("main", "people", [["id", "INTEGER"], ["handle", "VARCHAR"]]);
    const orders = table("main", "orders", [["order_id", "INTEGER"], ["person_id", "INTEGER"]]);
    const items = table("main", "items", [["item_id", "INTEGER"], ["order_id", "INTEGER"], ["person", "VARCHAR"], ["handle", "VARCHAR"]]);
    const models: unknown[] = [
      { model: "people", table: "people", dimensions: [], measures: [] },
      { model: "orders", table: "orders", dimensions: [], measures: [], joins: [{ name: "person", to: "people", keys: [{ from: "person_id", to: "id" }] }] },
      {
        model: "items",
        table: "items",
        dimensions: [{ name: "buyer", expr: "order.person.handle", tags: ["pii"] }],
        measures: [],
        joins: [{ name: "order", to: "orders", keys: [{ from: "order_id", to: "order_id" }] }],
      },
    ];
    const prot = protectedColumns([people, orders, items], models, "duckdb");
    expect([...(prot.get("main.people") ?? [])]).toEqual(["handle"]);
    // items.person and items.handle share names with the chain's parts and stay unprotected.
    expect(prot.get("main.items")).toBeUndefined();
  });

  test("sl profile reads the model files before it queries, so a model that fails to parse stops the run first", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL]);
    expect((await sl(t.root, ["introspect", "--source", "shop"])).code).toBe(0);
    mkdirSync(join(t.root, "models", "shop"), { recursive: true });
    writeFileSync(join(t.root, "models", "shop", "broken.yaml"), "model: [unclosed\n");
    // A results file that does not exist: reading it would fail, so a model error proves no plan ran.
    const r = await sl(t.root, ["profile", "--source", "shop", "--results", join(t.dir, "missing.json")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("broken.yaml");
    expect(r.err).not.toContain("missing.json");
    expect(col(snap(t.root, "shop"), "people", "email").profile).toBeUndefined();
  });

  test("redactSnapshot leaves a snapshot with nothing to redact as it was", () => {
    const s: Snapshot = { snapshot_version: 1, source: "x", dialect: "duckdb", captured_at: FIXED_NOW, method: "live", tables: [table("main", "t", [["status", "VARCHAR"]])] };
    const r = redactSnapshot(s, protectedColumns(s.tables, [], "duckdb"));
    expect(r.redacted).toEqual([]);
    expect(r.snapshot).toBe(s);
  });
});

describe("protected columns, refined", () => {
  const { protectedColumns } = require("../skills/semantic-layer/scripts/lib/profile.ts") as typeof import("../skills/semantic-layer/scripts/lib/profile.ts");
  const table = {
    schema: "s",
    name: "t",
    kind: "table" as const,
    row_count: 100,
    columns: [
      { name: "region_code", type: "varchar", profile: { distinct_count: 6, null_fraction: 0 } },
      { name: "sku", type: "varchar", profile: { distinct_count: 100, null_fraction: 0 } },
      { name: "notes", type: "varchar", profile: { distinct_count: 99, null_fraction: 0 } },
      { name: "secret_code", type: "varchar", profile: { distinct_count: 3, null_fraction: 0 } },
    ],
  };
  const main = {
    model: "main",
    table: "s.t",
    dimensions: [
      { name: "region", expr: "region_code", type: "string" },
      { name: "sku", expr: "sku", type: "string", tags: ["public"] },
    ],
    measures: [],
  };
  const helper = { model: "helper", table: "s.t", ignored_columns: ["region_code", "secret_code"], dimensions: [], measures: [] };

  test("an ignored column another model reads openly, or a column read only by public fields, is not protected", () => {
    const got = protectedColumns([table], [main, helper]).get("s.t") ?? new Set();
    expect(got.has("region_code")).toBe(false);
    expect(got.has("sku")).toBe(false);
    expect(got.has("secret_code")).toBe(true);
    expect(got.has("notes")).toBe(true);
  });

  test("an explicit tag still protects a column another field reads openly", () => {
    const tagged = { ...main, dimensions: [...main.dimensions, { name: "region_pii", expr: "region_code", type: "string", tags: ["pii"] }] };
    expect((protectedColumns([table], [tagged]).get("s.t") ?? new Set()).has("region_code")).toBe(true);
  });
});

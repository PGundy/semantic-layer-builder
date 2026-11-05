import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { duckdbSource, FIXED_NOW, initProject, PG_URL, sl, tempRoot } from "./helpers.ts";
import {
  applyProfile,
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
    expect(stats.sql).toContain("using sample reservoir(1000 rows) repeatable (42)");
    expect(stats.sql).toContain('(select count(*) from "main"."events") as row_count');
    expect(queries.find((q) => q.id === "stats:main.small")!.sql).not.toContain("sample");
    // One top-values query per table, reading one sample for all its columns.
    expect(queries.map((q) => q.id)).toEqual(["stats:main.events", "top:main.events", "stats:main.small"]);
    const top = queries.find((q) => q.id === "top:main.events")!.sql;
    expect(top).toContain("rank_in_column <= 3");
    expect(top).toContain('group by grouping sets (("label"))');
    expect(top.match(/using sample/g)).toHaveLength(1);

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
    const { plan, capped, sampled, top_columns } = buildProfilePlan(source, [table("PUBLIC", "WIDE", cols, 10)], { top_values: 5 });
    expect(plan.queries.map((q) => q.id)).toEqual(["stats:PUBLIC.WIDE", "top:PUBLIC.WIDE"]);
    expect(top_columns.get("PUBLIC.WIDE")).toEqual(Array.from({ length: MAX_TOP_COLUMNS }, (_, i) => i));
    const top = plan.queries[1]!.sql;
    expect(top.match(/when grouping\(/g)).toHaveLength(2 * MAX_TOP_COLUMNS);
    expect(top).toContain('when grouping("s39") = 0 then 39');
    expect(top).not.toContain('"s40"');
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
    expect(bq.plan.queries[1]!.sql).toContain("then cast(`x` as string) end as value");
    // No row estimate: TABLESAMPLE cannot size the sample, so it sorts every row.
    expect(bq.plan.queries[1]!.sql).toContain("order by rand() limit 100");
    expect(bq.sorted_samples).toEqual(["ds.t"]);
  });

  test("postgres and bigquery samples use TABLESAMPLE SYSTEM sized for at least 1000 rows, and postgres takes the row count from the estimate", () => {
    const big = table("s", "events", [["id", "integer"], ["kind", "text"]], 1_000_000);
    const pg = buildProfilePlan({ source: "pg", dialect: "postgres" }, [big], { sample_rows: 50_000, top_values: 3 });
    for (const q of pg.plan.queries) {
      expect(q.sql).toContain('(select * from "s"."events" tablesample system (5) repeatable (42)) as s');
      expect(q.sql).not.toContain("bernoulli");
    }
    // No full count(*) of a Postgres table: the row count is its estimate.
    expect(pg.plan.queries[0]!.sql).toContain("1000000 as row_count");
    expect(pg.plan.queries[0]!.sql).not.toContain("(select count(*)");
    expect(pg.plan.queries[0]!.purpose).toContain("the row count is the table's estimate");
    // A sample of fewer than 1000 rows reads the blocks of 1000 and keeps the first rows of them.
    const small = buildProfilePlan({ source: "pg", dialect: "postgres" }, [big], { sample_rows: 50, top_values: 3 });
    expect(small.plan.queries[0]!.sql).toContain('(select * from "s"."events" tablesample system (0.1) repeatable (42) limit 50) as s');
    const bq = buildProfilePlan({ source: "bq", dialect: "bigquery" }, [table("ds", "events", [["kind", "STRING"]], 1_000_000)], { sample_rows: 50, top_values: 3 });
    expect(bq.plan.queries[0]!.sql).toContain("(select * from `ds`.`events` tablesample system (0.1 percent) limit 50) as s");
    // BigQuery answers count(*) from metadata, so its row count is exact.
    expect(bq.plan.queries[0]!.sql).toContain("(select count(*) from `ds`.`events`) as row_count");
    // A table smaller than the floor reads all of it.
    const tiny = buildProfilePlan({ source: "pg", dialect: "postgres" }, [table("s", "t", [["x", "text"]], 400)], { sample_rows: 100, top_values: 3 });
    expect(tiny.plan.queries[0]!.sql).toContain("tablesample system (100) repeatable (42) limit 100");
  });

  test("a row estimate below the rows a sample read gives way to the sample's count", () => {
    const t = table("s", "events", [["kind", "text"]], 1_000_000);
    const snapshot: Snapshot = { snapshot_version: 1, source: "pg", dialect: "postgres", captured_at: FIXED_NOW, method: "live", tables: [t] };
    const details = buildProfilePlan({ source: "pg", dialect: "postgres" }, [t], { sample_rows: 5000, top_values: 0 });
    const out = applyProfile(snapshot, details, { "stats:s.events": [{ row_count: 1000, sample_count: 1200, c0_nulls: 0, c0_distinct: 3 }] }, FIXED_NOW);
    expect(out.snapshot.tables[0]!.row_count).toBe(1200);
    expect(out.snapshot.tables[0]!.columns[0]!.profile!.sampled).toBe(false);
  });

  test("reviewer reproduction: a sample that read no rows skips its table, keeps its earlier profile and saves the others", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), { source: "pg", dialect: "postgres", connection: { env: "PGTEST_URL" }, profile: { sample_rows: 100 } });
    const a = table("s", "a", [["kind", "text"]], 1_000_000);
    a.profiled_at = "2025-01-01T00:00:00.000Z";
    a.columns[0]!.profile = { null_fraction: 0, distinct_count: 2, top_values: [{ value: "x", count: 5 }], sampled: true };
    const b = table("s", "b", [["kind", "text"]], 1_000_000);
    writeSnapshot(t.root, "pg", "postgres", [a, b]);
    const results = {
      "stats:s.a": [{ row_count: 1_000_000, sample_count: 0, c0_nulls: 0, c0_distinct: 0 }],
      "top:s.a": [],
      "stats:s.b": [{ row_count: 1_000_000, sample_count: 100, c0_nulls: 0, c0_distinct: 2 }],
      "top:s.b": [{ column_index: 0, value: "y", n: 60 }, { column_index: 0, value: "z", n: 40 }],
    };
    const file = join(t.dir, "results.json");
    writeFileSync(file, JSON.stringify(results));
    const r = await sl(t.root, ["profile", "--source", "pg", "--refresh", "--results", file, "--json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("The sample of s.a read no rows of its 1,000,000");
    expect(r.err).toContain("--tables s.a --refresh");
    const out = r.json<ProfileJson>();
    expect(out.profiled.map((p) => p.table)).toEqual(["s.b"]);
    expect(out.skipped).toEqual([{ table: "s.a", reason: "its sample read no rows" }]);
    const s = snap(t.root, "pg");
    expect(s.tables[0]).toEqual(a);
    expect(col(s, "b", "kind").profile!.top_values).toEqual([{ value: "y", count: 60 }, { value: "z", count: 40 }]);
  });

  test("a few nulls in a large table keep null_fraction above zero", () => {
    const source: SourceConfig = { source: "sf", dialect: "snowflake" };
    const t = table("PUBLIC", "BIG", [["ORDER_ID", "NUMBER(38,0)"]], 25_000_000);
    const snapshot: Snapshot = { snapshot_version: 1, source: "sf", dialect: "snowflake", captured_at: FIXED_NOW, method: "live", tables: [t] };
    const details = buildProfilePlan(source, [t], { top_values: 10 });
    const results = { "stats:PUBLIC.BIG": [{ row_count: 25_000_000, c0_nulls: 2, c0_distinct: 24_990_000 }] };
    const out = applyProfile(snapshot, details, results, FIXED_NOW).snapshot.tables[0]!;
    expect(out.columns[0]!.profile!.null_fraction).toBeGreaterThan(0);
    expect(out.columns[0]!.profile!.null_fraction).toBe(8e-8);
    expect(summarizeTable(out, "snowflake").candidate_keys).toEqual([]);
  });

  test("a sampled plan needs sample_count in its results", () => {
    const source: SourceConfig = { source: "sf", dialect: "snowflake" };
    const t = table("PUBLIC", "BIG", [["ORDER_ID", "NUMBER(38,0)"]], 25_000_000);
    const snapshot: Snapshot = { snapshot_version: 1, source: "sf", dialect: "snowflake", captured_at: FIXED_NOW, method: "live", tables: [t] };
    const details = buildProfilePlan(source, [t], { sample_rows: 1000, top_values: 10 });
    expect(details.sampled).toEqual(["PUBLIC.BIG"]);
    const results = { "stats:PUBLIC.BIG": [{ row_count: 25_000_000, c0_nulls: 500 }] };
    expect(() => applyProfile(snapshot, details, results, FIXED_NOW)).toThrow(/sample_count/);
  });

  test("top_values 0 emits no top-values query", () => {
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
    expect(plan.queries.map((q) => q.id)).toEqual(["stats:ANALYTICS.FCT_ORDERS", "top:ANALYTICS.FCT_ORDERS"]);
    expect(plan.queries[1]!.sql).toContain('group by grouping sets (("STATUS"), ("IS_TEST"))');

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
      "top:ANALYTICS.FCT_ORDERS": [
        { COLUMN_INDEX: 1, VALUE: "completed", N: 22000000 },
        { COLUMN_INDEX: "1", VALUE: "cancelled", N: "2750000" },
        { COLUMN_INDEX: 4, VALUE: "false", N: 24999000 },
        { COLUMN_INDEX: 4, VALUE: "true", N: 1000 },
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
    expect(bad.err).toContain("top:ANALYTICS.FCT_ORDERS");

    // A row naming a column the query does not cover is refused.
    const stray = join(t.dir, "stray.json");
    writeFileSync(stray, JSON.stringify({ ...results, "top:ANALYTICS.FCT_ORDERS": [{ COLUMN_INDEX: 2, VALUE: "9.99", N: 1 }] }));
    const strayRun = await sl(t.root, ["profile", "--source", "sf", "--refresh", "--results", stray]);
    expect(strayRun.code).toBe(1);
    expect(strayRun.err).toContain("column_index 2 names no column the query covers");
  });
});

// Whether PG_URL names a server on this machine (localhost, 127.0.0.1, ::1 or a socket path), or
// SL_TEST_ALLOW_REMOTE=1 allows another: the live tests drop the schemas they create.
function localPgUrl(url: string): boolean {
  if (process.env.SL_TEST_ALLOW_REMOTE === "1") return true;
  const u = new URL(url);
  const host = u.searchParams.get("host") ?? decodeURIComponent(u.hostname);
  return host === "" || host.startsWith("/") || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

describe("localPgUrl", () => {
  test("allows local hosts and socket paths only", () => {
    expect(localPgUrl("postgres://postgres@localhost:54329/postgres?host=/tmp/sl-pg")).toBe(true);
    expect(localPgUrl("postgres://u@127.0.0.1/db")).toBe(true);
    expect(localPgUrl("postgres://u@[::1]:5432/db")).toBe(true);
    if (process.env.SL_TEST_ALLOW_REMOTE !== "1") {
      expect(localPgUrl("postgres://u@db.example.com/prod")).toBe(false);
      expect(localPgUrl("postgres://u@localhost/db?host=db.example.com")).toBe(false);
    }
  });
});

describe.skipIf(!PG_URL)("profile (postgres live)", () => {
  // A schema of this run's own in the PG_URL database.
  const schema = `t_profile_${process.pid}_${Date.now().toString(36)}`;
  let db: SQL;

  beforeAll(async () => {
    if (!localPgUrl(PG_URL!)) throw new Error("PG_URL is not on this machine; the live tests drop schemas, so set SL_TEST_ALLOW_REMOTE=1 to run them there.");
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
    await db.unsafe(`create table ${schema}.events as
      select g as event_id, 'k' || (g % 7) as kind, (g % 2 = 0) as flag from generate_series(1, 100000) g`);
    await db.unsafe(`create view ${schema}.events_v as select * from ${schema}.events`);
    await db.unsafe(`analyze ${schema}.events`);
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

  test("samples a large table with TABLESAMPLE SYSTEM and reads all its top values from one sample", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), {
      source: "pg",
      dialect: "postgres",
      connection: { env: "PGTEST_URL" },
      profile: { sample_rows: 10000, top_values: 3 },
    });
    const columns: [string, string][] = [["event_id", "integer"], ["kind", "text"], ["flag", "boolean"]];
    writeSnapshot(t.root, "pg", "postgres", [table(schema, "events", columns, 100000), { ...table(schema, "events_v", columns, null), kind: "view" }]);

    const emitted = await sl(t.root, ["profile", "--source", "pg", "--emit-sql"], { PGTEST_URL: PG_URL });
    expect(emitted.code).toBe(0);
    const queries = emitted.json<QueryPlan>().queries;
    expect(queries.map((q) => q.id)).toEqual([`stats:${schema}.events`, `top:${schema}.events`, `stats:${schema}.events_v`, `top:${schema}.events_v`]);
    for (const q of queries.slice(0, 2)) {
      expect(q.sql).toContain(`(select * from "${schema}"."events" tablesample system (10) repeatable (42)) as s`);
      expect(q.sql).not.toContain("random()");
    }
    expect(queries[1]!.sql).toContain('group by grouping sets (("kind"), ("flag"))');
    // A view cannot be read through TABLESAMPLE: its sample sorts every row, and the run says so.
    expect(queries[2]!.sql).toContain("order by random() limit 10000");
    expect(emitted.err).toContain(`${schema}.events_v is a view, an external table or has no row estimate`);

    const r = await sl(t.root, ["profile", "--source", "pg", "--json"], { PGTEST_URL: PG_URL });
    expect(r.code).toBe(0);
    const s = snap(t.root, "pg");
    const events = s.tables.find((x) => x.name === "events")!;
    expect(events.row_count).toBe(100000);
    const kind = col(s, "events", "kind").profile!;
    expect(kind.sampled).toBe(true);
    expect(kind.distinct_count).toBe(7);
    expect(kind.top_values).toHaveLength(3);
    const flag = col(s, "events", "flag").profile!;
    const total = flag.top_values!.reduce((a, v) => a + v.count, 0);
    // Both columns' counts come from the same sample of a few thousand rows.
    expect(total).toBeGreaterThan(2000);
    expect(total).toBeLessThan(30000);
    expect(col(s, "events", "event_id").profile!.distinct_count).toBe(100000);
  });

  test("a sample of fewer than 1000 rows reads TABLESAMPLE SYSTEM blocks and keeps the rows asked for", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), {
      source: "pg",
      dialect: "postgres",
      connection: { env: "PGTEST_URL" },
      profile: { sample_rows: 50, top_values: 10 },
    });
    writeSnapshot(t.root, "pg", "postgres", [table(schema, "events", [["event_id", "integer"], ["kind", "text"]], 100000)]);
    const emitted = await sl(t.root, ["profile", "--source", "pg", "--emit-sql"], { PGTEST_URL: PG_URL });
    expect(emitted.json<QueryPlan>().queries[0]!.sql).toContain("tablesample system (1) repeatable (42) limit 50");
    const r = await sl(t.root, ["profile", "--source", "pg", "--json"], { PGTEST_URL: PG_URL });
    expect(r.code).toBe(0);
    expect(r.json<ProfileJson>().profiled[0]!.row_count).toBe(100000);
    const kind = col(snap(t.root, "pg"), "events", "kind").profile!;
    expect(kind.sampled).toBe(true);
    // All seven kinds are listed, so their counts add up to the 50 rows read.
    expect(kind.top_values).toHaveLength(7);
    expect(kind.top_values!.reduce((a, v) => a + v.count, 0)).toBe(50);
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
// The hashed form an earlier version of sl profile stored for protected top values.
const hashValue = (text: string) => hex16(text.toLowerCase().trim());

interface RedactJson {
  source: string;
  redacted: string[];
}

describe("profiles of protected columns", () => {
  test("isHashedValue recognizes the hashed form earlier snapshots stored", () => {
    expect(hashValue("  Dana@Example.COM ")).toBe(hex16("dana@example.com"));
    expect(isHashedValue(hashValue("x"))).toBe(true);
    expect(isHashedValue("sha256:xyz")).toBe(false);
    expect(isHashedValue(7)).toBe(false);
  });

  test("redactProfile keeps counts only: no top values, and min and max only for numbers and dates", () => {
    const text = redactProfile({ null_fraction: 0, distinct_count: 2, min: "a", max: "b", top_values: [{ value: "Dana", count: 2 }, { value: null, count: 1 }], sampled: false }, { type: "VARCHAR" });
    expect(text).toEqual({ null_fraction: 0, distinct_count: 2, sampled: false, redacted: true });
    expect(redactProfile(text, { type: "VARCHAR" })).toEqual(text);
    const flag = redactProfile({ min: false, max: true, top_values: [{ value: true, count: 3 }] }, { type: "BOOLEAN" });
    expect(flag).toEqual({ redacted: true });
    const day = redactProfile({ min: "2025-01-01", max: "2025-03-31" }, { type: "DATE" });
    expect(day).toEqual({ min: "2025-01-01", max: "2025-03-31", redacted: true });
    const n = redactProfile({ min: 1, max: 9, top_values: [{ value: 7, count: 1 }] }, { type: "INTEGER" });
    expect(n).toEqual({ min: 1, max: 9, redacted: true });
    // Hashed top values are values too: a dictionary of names or phone numbers reverses them.
    const hashed = redactProfile({ distinct_count: 1, top_values: [{ value: hashValue("avery patel"), count: 4 }] }, { type: "VARCHAR" });
    expect(hashed).toEqual({ distinct_count: 1, redacted: true });
    expect(holdsRawValues(n, { type: "INTEGER" })).toBe(false);
    expect(holdsRawValues({ top_values: [{ value: hashValue("x"), count: 1 }], redacted: true }, { type: "VARCHAR" })).toBe(true);
    expect(holdsRawValues({ top_values: [{ value: 7, count: 1 }] }, { type: "INTEGER" })).toBe(true);
    expect(holdsRawValues({ top_values: [] }, { type: "VARCHAR" })).toBe(false);
    expect(holdsRawValues({ min: "a" }, { type: "VARCHAR" })).toBe(true);
    expect(holdsRawValues({ min: false }, { type: "BOOLEAN" })).toBe(true);
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

  test("sl profile stores counts only for protected columns, and never selects the top values of ones known before it runs (duckdb)", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL]);
    expect((await sl(t.root, ["introspect", "--source", "shop"])).code).toBe(0);
    peopleModel(t.root);

    // email and handle are tagged pii, notes and birth_date are protected by name: the plan's one
    // top-values query covers only status and region.
    const emitted = await sl(t.root, ["profile", "--source", "shop", "--emit-sql"]);
    expect(emitted.code).toBe(0);
    const queries = emitted.json<QueryPlan>().queries;
    expect(queries.map((q) => q.id)).toEqual(["stats:main.people", "top:main.people"]);
    const top = queries[1]!.sql;
    expect(top).toContain('group by grouping sets (("status"), ("region"))');
    for (const name of ["email", "handle", "notes"]) expect(top).not.toContain(`"${name}"`);
    // The statistics query reads no text min or max of any column.
    expect(queries[0]!.sql).not.toMatch(/min\("(email|handle|notes)"\)/);

    const r = await sl(t.root, ["profile", "--source", "shop", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<ProfileJson & { redacted: string[] }>();
    expect(out.redacted).toEqual(["main.people.email", "main.people.handle", "main.people.notes", "main.people.birth_date"]);

    const s = snap(t.root, "shop");
    expect(col(s, "people", "email").profile).toEqual({ null_fraction: 0, distinct_count: 3, sampled: false, redacted: true });
    expect(col(s, "people", "notes").profile).toEqual({ null_fraction: 0.333333, distinct_count: 1, sampled: false, redacted: true });
    expect(col(s, "people", "handle").profile).toEqual({ null_fraction: 0, distinct_count: 3, sampled: false, redacted: true });
    // A protected date keeps its range.
    expect(col(s, "people", "birth_date").profile).toMatchObject({ min: "1985-01-15", max: "2001-12-31", redacted: true });
    expect(col(s, "people", "birth_date").profile!.top_values).toBeUndefined();
    // Unprotected columns keep their raw values.
    expect(col(s, "people", "status").profile!.top_values).toEqual([{ value: "active", count: 2 }, { value: "churned", count: 1 }]);
    expect(col(s, "people", "region").profile!.redacted).toBeUndefined();
    const text = readFileSync(join(t.root, "snapshots", "shop.json"), "utf8");
    for (const raw of ["Dana@Example.com", "lee@example.com", "Call after 5", "dana_r", "sha256:"]) expect(text).not.toContain(raw);
    expect(validateProject(t.root).filter((i) => i.message.includes("raw sample values"))).toEqual([]);

    const human = await sl(t.root, ["profile", "--source", "shop", "--refresh"]);
    expect(human.out).toContain(
      "Protected columns, stored with counts only (no top values, and min and max only for numbers and dates): main.people.email, main.people.handle",
    );
    expect(human.out).toContain("Which columns are protected is a heuristic");
  });

  test("a column flagged only by the profile it is in has its top values stripped after the run (duckdb)", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    // visitor_handle has a different value on every one of 60 rows: protected only once profiled.
    await duckdbSource(t.root, t.dir, "web", [
      "create table visits as select range as visit_id, 'visitor-' || range::varchar as visitor_handle, case when range % 2 = 0 then 'web' else 'app' end as channel from range(60)",
    ]);
    expect((await sl(t.root, ["introspect", "--source", "web"])).code).toBe(0);
    const emitted = await sl(t.root, ["profile", "--source", "web", "--emit-sql"]);
    expect(emitted.json<QueryPlan>().queries[1]!.sql).toContain('"visitor_handle"');
    const r = await sl(t.root, ["profile", "--source", "web", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ redacted: string[] }>().redacted).toEqual(["main.visits.visitor_handle"]);
    const s = snap(t.root, "web");
    expect(col(s, "visits", "visitor_handle").profile).toEqual({ null_fraction: 0, distinct_count: 60, sampled: false, redacted: true });
    expect(col(s, "visits", "channel").profile!.top_values).toEqual([{ value: "app", count: 30 }, { value: "web", count: 30 }]);
    expect(readFileSync(join(t.root, "snapshots", "web.json"), "utf8")).not.toContain("visitor-");
  });

  test("reviewer reproduction: customer_name, username and ip with repeated values keep no values in the snapshot (duckdb)", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    // 100 rows with repeating values, so none is near-unique; city is not personal.
    await duckdbSource(t.root, t.dir, "crm", [
      "create schema sales",
      "create table sales.people as select range as person_id, " +
        "['Alice Johnson', 'Bob Smith', 'Carol White'][1 + range % 3] as customer_name, " +
        "'user' || (range % 5)::varchar as username, ['Lyon', 'Oslo'][1 + range % 2] as city, " +
        "'10.0.0.' || (range % 4)::varchar as ip, 'Mozilla/5.0 (X' || (range % 3)::varchar || ')' as user_agent, " +
        "'SKU-' || range::varchar as sku from range(100)",
    ]);
    expect((await sl(t.root, ["introspect", "--source", "crm"])).code).toBe(0);
    const r = await sl(t.root, ["profile", "--source", "crm", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ redacted: string[] }>().redacted).toEqual([
      "sales.people.customer_name",
      "sales.people.username",
      "sales.people.ip",
      "sales.people.user_agent",
    ]);
    const text = readFileSync(join(t.root, "snapshots", "crm.json"), "utf8");
    for (const raw of ["Alice Johnson", "Bob Smith", "user1", "10.0.0.0", "Mozilla"]) expect(text).not.toContain(raw);
    const s = snap(t.root, "crm");
    expect(col(s, "people", "city").profile!.top_values).toEqual([{ value: "Lyon", count: 50 }, { value: "Oslo", count: 50 }]);
    // A near-unique sku is a business code, not personal: it keeps its values.
    expect(col(s, "people", "sku").profile!.redacted).toBeUndefined();
    expect(col(s, "people", "sku").profile!.top_values!.length).toBe(10);
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
    expect(col(now, "people", "handle").profile).toEqual({ null_fraction: 0, distinct_count: 3, sampled: false, redacted: true });
    expect(col(now, "people", "region").profile).toEqual({ null_fraction: 0, distinct_count: 2, sampled: false, redacted: true });
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

  test("sl profile --redact removes hashed top values a snapshot already holds", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL]);
    const people = table("main", "people", [["id", "INTEGER"], ["email", "VARCHAR"], ["status", "VARCHAR"]], 3);
    people.columns[1]!.profile = {
      null_fraction: 0,
      distinct_count: 3,
      top_values: [{ value: hashValue("dana@example.com"), count: 1 }],
      sampled: false,
      redacted: true,
    };
    people.columns[2]!.profile = { null_fraction: 0, distinct_count: 2, top_values: [{ value: "active", count: 2 }], sampled: false };
    writeSnapshot(t.root, "shop", "duckdb", [people]);
    const r = await sl(t.root, ["profile", "--source", "shop", "--redact", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<RedactJson>()).toEqual({ source: "shop", redacted: ["main.people.email"] });
    const s = snap(t.root, "shop");
    expect(col(s, "people", "email").profile).toEqual({ null_fraction: 0, distinct_count: 3, sampled: false, redacted: true });
    expect(col(s, "people", "status").profile!.top_values).toEqual([{ value: "active", count: 2 }]);
    expect(readFileSync(join(t.root, "snapshots", "shop.json"), "utf8")).not.toContain("sha256:");
  });

  test("reviewer reproduction: --redact removes legacy hashes from a column no longer protected, and reports it", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", [PEOPLE_SQL]);
    const products = table("a", "products", [["sku", "VARCHAR"], ["nickname", "VARCHAR"], ["placed_on", "DATE"], ["status", "VARCHAR"]], 100);
    const hashed = [hashValue("SKU-1"), hashValue("SKU-2"), hashValue("SKU-3")].map((value) => ({ value, count: 1 }));
    products.columns[0]!.profile = { null_fraction: 0, distinct_count: 100, top_values: hashed, sampled: false, redacted: true };
    products.columns[1]!.profile = { null_fraction: 0, distinct_count: 100, top_values: hashed, sampled: false, redacted: true };
    // A hashed bound on a date column goes too, though a date keeps real bounds.
    products.columns[2]!.profile = { null_fraction: 0, distinct_count: 9, min: hashValue("2020-01-01"), max: "2024-12-31", sampled: false };
    products.columns[3]!.profile = { null_fraction: 0, distinct_count: 2, top_values: [{ value: "active", count: 60 }], sampled: false };
    writeSnapshot(t.root, "shop", "duckdb", [products]);
    // No models: sku is code-like and no longer protected, but its hashes still go.
    expect(protectedColumns(snap(t.root, "shop").tables, [], "duckdb").get("a.products")).toEqual(new Set(["nickname"]));
    const r = await sl(t.root, ["profile", "--source", "shop", "--redact", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<RedactJson>()).toEqual({ source: "shop", redacted: ["a.products.sku", "a.products.nickname", "a.products.placed_on"] });
    const s = snap(t.root, "shop");
    expect(col(s, "products", "sku").profile).toEqual({ null_fraction: 0, distinct_count: 100, sampled: false, redacted: true });
    expect(col(s, "products", "placed_on").profile).toEqual({ null_fraction: 0, distinct_count: 9, max: "2024-12-31", sampled: false, redacted: true });
    expect(col(s, "products", "status").profile!.top_values).toEqual([{ value: "active", count: 60 }]);
    expect(readFileSync(join(t.root, "snapshots", "shop.json"), "utf8")).not.toContain("sha256:");
    const again = await sl(t.root, ["profile", "--source", "shop", "--redact"]);
    expect(again.out).toContain("Nothing to redact");
  });

  test("reviewer reproduction: repeated firstname, FIRSTNAME-style and CUSTOMERNAME columns keep no values in the snapshot (duckdb)", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "crm", [
      "create table events as select range as event_id, 'Alice ' || (range % 20)::varchar as firstname, " +
        "'Smith' || (range % 7)::varchar as LASTNAME, 'Acme Buyer ' || (range % 5)::varchar as CUSTOMERNAME, " +
        "'Mozilla ' || (range % 3)::varchar as useragent, 'dev-' || (range % 9)::varchar as deviceid, " +
        "['web', 'app'][1 + range % 2] as channel from range(200)",
    ]);
    expect((await sl(t.root, ["introspect", "--source", "crm"])).code).toBe(0);
    const emitted = await sl(t.root, ["profile", "--source", "crm", "--emit-sql"]);
    expect(emitted.json<QueryPlan>().queries[1]!.sql).toContain('group by grouping sets (("channel"))');
    const r = await sl(t.root, ["profile", "--source", "crm", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ redacted: string[] }>().redacted).toEqual([
      "main.events.firstname",
      "main.events.LASTNAME",
      "main.events.CUSTOMERNAME",
      "main.events.useragent",
      "main.events.deviceid",
    ]);
    const text = readFileSync(join(t.root, "snapshots", "crm.json"), "utf8");
    for (const raw of ["Alice", "Smith", "Acme Buyer", "Mozilla", "dev-"]) expect(text).not.toContain(raw);
    expect(col(snap(t.root, "crm"), "events", "channel").profile!.top_values).toEqual([{ value: "app", count: 100 }, { value: "web", count: 100 }]);
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

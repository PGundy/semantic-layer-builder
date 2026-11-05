import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groupRowsText, scopeCommand } from "../skills/semantic-layer/scripts/commands/tables.ts";
import { DATE_PATTERN, NOISE_PATTERN, groupTables, suggestScope } from "../skills/semantic-layer/scripts/lib/groups.ts";
import { qualifiedName } from "../skills/semantic-layer/scripts/lib/naming.ts";
import { matchesPattern } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import { noiseReason } from "../skills/semantic-layer/scripts/lib/rank.ts";
import type { Snapshot, SnapshotTable, SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeJson, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function table(schema: string, name: string, rows: number, fks: string[] = []): SnapshotTable {
  return {
    schema,
    name,
    kind: "table",
    row_count: rows,
    columns: [
      { name: "id", type: "integer" },
      { name: "created_at", type: "timestamp" },
    ],
    foreign_keys: fks.map((f) => ({ columns: [`${f}_id`], references: { schema, table: f, columns: ["id"] } })),
  };
}

// 25 tables across two schemas.
const TABLES: SnapshotTable[] = [
  { ...table("analytics", "fct_orders", 10000, ["dim_customers", "dim_products"]), profiled_at: "2026-01-15T12:00:00.000Z" },
  table("analytics", "fct_payments", 8000, ["dim_customers"]),
  table("analytics", "fct_sessions", 50000),
  table("analytics", "fct_orders_v2", 10000),
  table("analytics", "dim_customers", 2000),
  table("analytics", "dim_products", 300),
  table("analytics", "dim_dates", 3650),
  table("analytics", "dim_customers_v2", 2000),
  table("analytics", "orders_archive", 5000),
  table("analytics", "customers_archive", 1000),
  table("analytics", "report_daily", 365),
  table("analytics", "revenue_daily", 365),
  table("analytics", "events_2024", 100000),
  table("analytics", "events_2025_01", 9000),
  table("analytics", "schema_migrations", 40),
  table("analytics", "orders_tmp", 10),
  table("analytics", "payments_tmp", 20),
  table("raw", "raw_stripe_charges", 9000),
  table("raw", "raw_stripe_customers", 2100),
  table("raw", "raw_stripe_refunds", 500),
  table("raw", "raw_hubspot_contacts", 4000),
  table("raw", "stg_orders", 10000),
  table("raw", "stg_payments", 8000),
  table("raw", "stg_customers", 2000),
  table("raw", "stg_products", 300),
];

const SOURCE_YAML = `# Warehouse replica. Owner: Dana.
source: wh
dialect: duckdb # local file for tests
connection:
  database: ":memory:"
# Profile settings stay small in CI.
profile:
  top_values: 5
`;

async function setup(): Promise<{ root: string; sourcePath: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  const sourcePath = join(t.root, "sources", "wh.yaml");
  mkdirSync(join(t.root, "sources"), { recursive: true });
  writeFileSync(sourcePath, SOURCE_YAML);
  const snapshot: Snapshot = {
    snapshot_version: 1,
    source: "wh",
    dialect: "duckdb",
    captured_at: "2026-01-15T12:00:00.000Z",
    method: "manual",
    tables: TABLES,
  };
  writeJson(join(t.root, "snapshots", "wh.json"), snapshot);
  writeYaml(join(t.root, "models", "wh", "orders.yaml"), {
    model: "orders",
    source: "wh",
    table: "analytics.fct_orders",
    status: "draft",
    dimensions: [],
    measures: [],
  });
  return { root: t.root, sourcePath };
}

function readSource(path: string): SourceConfig {
  return readYaml<SourceConfig>(path);
}

interface ScopeJson {
  source: string;
  scope: { include?: string[]; exclude?: string[] };
  before_count: number;
  after_count: number;
  added: string[];
  removed: string[];
  unmatched_patterns: string[];
  needs_focus: boolean;
  written: boolean;
  tables: { table: string; rows: number | null }[];
}

describe("groupTables", () => {
  const groups = groupTables(TABLES);
  const find = (kind: string, key: string) => groups.find((g) => g.kind === kind && g.key === key);

  test("schema groups", () => {
    const schemas = groups.filter((g) => g.kind === "schema");
    expect(schemas.map((g) => [g.key, g.pattern, g.tables.length])).toEqual([
      ["analytics", "analytics.*", 17],
      ["raw", "raw.*", 8],
    ]);
    expect(find("schema", "raw")?.suggestion).toBe("exclude");
    expect(find("schema", "analytics")?.suggestion).toBe("neutral");
  });

  test("prefix groups, including a more specific two-token prefix", () => {
    const prefixes = groups.filter((g) => g.kind === "prefix");
    expect(prefixes.map((g) => [g.pattern, g.tables.length, g.suggestion])).toEqual([
      ["dim_*", 4, "include"],
      ["fct_*", 4, "include"],
      ["raw_*", 4, "exclude"],
      ["stg_*", 4, "exclude"],
      ["raw_stripe_*", 3, "exclude"],
      ["events_*", 2, "neutral"],
      ["orders_*", 2, "neutral"],
    ]);
    expect(find("prefix", "fct_")?.tables).toContain("analytics.fct_orders_v2");
    expect(find("prefix", "fct_")?.total_rows).toBe(78000);
    expect(find("prefix", "fct_")?.rows_unknown).toBe(0);
    expect(find("prefix", "raw_hubspot_")).toBeUndefined();
    for (const g of groups) expect(g.reason.length).toBeGreaterThan(10);
  });

  test("suffix groups and one date group", () => {
    const suffixes = groups.filter((g) => g.kind === "suffix");
    const byKey = Object.fromEntries(suffixes.map((g) => [g.key, g]));
    expect(byKey._v2?.pattern).toBe("*_v2");
    expect(byKey._v2?.suggestion).toBe("neutral");
    expect(byKey._archive?.suggestion).toBe("exclude");
    expect(byKey._tmp?.suggestion).toBe("exclude");
    expect(byKey._daily?.suggestion).toBe("neutral");
    expect(byKey._customers?.tables.length).toBe(3);
    expect(byKey["_<date>"]?.pattern).toBe(DATE_PATTERN);
    expect(byKey["_<date>"]?.tables).toEqual(["analytics.events_2024", "analytics.events_2025_01"]);
    expect(byKey["_<date>"]?.suggestion).toBe("exclude");
    expect(byKey._01).toBeUndefined();
    expect(byKey._2024).toBeUndefined();
    expect(byKey._sessions).toBeUndefined();
  });

  test("noise group and ordering", () => {
    const noise = groups.filter((g) => g.kind === "noise");
    expect(noise).toHaveLength(1);
    expect(noise[0]?.tables).toEqual([
      "analytics.customers_archive",
      "analytics.events_2024",
      "analytics.events_2025_01",
      "analytics.orders_archive",
      "analytics.orders_tmp",
      "analytics.payments_tmp",
      "analytics.schema_migrations",
    ]);
    expect(noise[0]?.suggestion).toBe("exclude");
    const kinds = groups.map((g) => g.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => ["schema", "prefix", "suffix", "noise"].indexOf(a) - ["schema", "prefix", "suffix", "noise"].indexOf(b)));
    expect(groupTables([...TABLES].reverse())).toEqual(groups);
  });

  test("in_scope counts follow the scope and a single schema yields no schema groups", () => {
    const scoped = groupTables(TABLES, { include: ["fct_*"], exclude: ["*_v2"] });
    expect(scoped.find((g) => g.key === "fct_")?.in_scope).toBe(3);
    expect(scoped.find((g) => g.key === "dim_")?.in_scope).toBe(0);
    const one = groupTables(TABLES.filter((t) => t.schema === "raw"));
    expect(one.some((g) => g.kind === "schema")).toBe(false);
  });

  test("every suggested pattern selects exactly its group's tables", () => {
    for (const g of groups) {
      const matched = TABLES.filter((t) => matchesPattern(g.pattern, t)).map(qualifiedName).sort();
      expect(matched).toEqual([...g.tables].sort());
    }
  });
});

describe("groupTables edge cases", () => {
  test("unknown row counts stay unknown in group totals", () => {
    const unknown = (name: string): SnapshotTable => ({ ...table("p", name, 0), row_count: null });
    const { row_count: _r, ...noCount } = table("p", "fct_c", 0);
    const tabs = [table("p", "fct_a", 30551), unknown("fct_b"), noCount, unknown("dim_a"), unknown("dim_b")];
    const groups = groupTables(tabs);
    const fct = groups.find((g) => g.key === "fct_");
    expect(fct).toMatchObject({ total_rows: 30551, rows_unknown: 2 });
    expect(groupRowsText(fct!)).toBe("30,551+");
    const dim = groups.find((g) => g.key === "dim_");
    expect(dim).toMatchObject({ total_rows: null, rows_unknown: 2 });
    expect(groupRowsText(dim!)).toBe("?");
    expect(groupRowsText({ total_rows: 0, rows_unknown: 0 })).toBe("0");
    expect(groupRowsText({ total_rows: 1234, rows_unknown: 0 })).toBe("1,234");
  });

  test("the suggested scope includes the include groups and excludes the noise they would select", () => {
    expect(suggestScope(TABLES, groupTables(TABLES))).toEqual({ include: ["dim_*", "fct_*"], exclude: [] });

    const tabs = [
      table("p", "fct_orders", 10),
      table("p", "fct_payments", 10),
      table("p", "fct_orders_backup", 10),
      table("p", "fct_payments_backup", 10),
      table("p", "fct_sessions_tmp", 10),
      table("p", "dim_customers", 10),
      table("p", "dim_products", 10),
      table("p", "orders_backup", 10),
      table("p", "events_2024", 10),
    ];
    const groups = groupTables(tabs);
    const suggested = suggestScope(tabs, groups);
    expect(suggested).toEqual({ include: ["fct_*", "dim_*"], exclude: ["*_backup", "p.fct_sessions_tmp"] });
    const selected = tabs.filter(
      (t) => suggested.include.some((p) => matchesPattern(p, t)) && !suggested.exclude.some((p) => matchesPattern(p, t)),
    );
    expect(selected.map((t) => t.name).sort()).toEqual(["dim_customers", "dim_products", "fct_orders", "fct_payments"]);

    // An include group inside another include group adds nothing.
    const nested = [table("p", "fct_a", 1), table("p", "fct_sales_a", 1), table("p", "fct_sales_b", 1)];
    expect(suggestScope(nested, groupTables(nested)).include).toEqual(["fct_*"]);

    // With no include group every table is selected, so every noise table is excluded.
    const plain = [table("p", "orders", 1), table("p", "orders_tmp", 1), table("p", "payments_tmp", 1), table("p", "schema_migrations", 1)];
    expect(suggestScope(plain, groupTables(plain))).toEqual({ include: [], exclude: ["*_tmp", "p.schema_migrations"] });
    expect(suggestScope([table("p", "orders", 1)], [])).toEqual({ include: [], exclude: [] });
  });

  test("the suggested scope keeps tables whose comments or names use raw, landing, int_ or stitch as business words", () => {
    // The reviewer's probe: at HEAD the suggested scope excluded none of these.
    const mfg = (name: string, description?: string): SnapshotTable => ({ ...table("mfg", name, 1000), ...(description ? { description } : {}) });
    const tabs = [
      mfg("materials", "Inventory of raw materials, one row per lot"),
      mfg("work_orders"),
      mfg("landing_pages", "One row per marketing landing page"),
      mfg("int_shipments", "International shipments"),
      mfg("stitch_counts"),
      mfg("orders", "Orders as loaded; totals are raw sums before discounts"),
      mfg("customers"),
    ];
    const suggested = suggestScope(tabs, groupTables(tabs));
    expect(suggested).toEqual({ include: [], exclude: [] });
    expect(groupTables(tabs).find((g) => g.kind === "noise")).toBeUndefined();
  });

  test("the noise group's reason names every rule its pattern selects by", () => {
    const noise = groupTables([table("s", "orders_tmp", 1), table("s", "_x", 1)]).find((g) => g.kind === "noise")!;
    expect(noise.reason).toContain("pipeline-tool tables");
    expect(noise.reason).toContain("underscore");
  });

  test("the suggested scope excludes the tables sl baseline calls noise or staging", () => {
    const tabs = [
      table("shop", "sales", 3000),
      table("shop", "products", 42),
      table("shop", "stg_sales", 3000),
      table("shop", "sales_bak", 3000),
      table("shop", "tmp_load", 5),
      table("ops", "_migrations", 10),
      table("ops", "etl_job_runs", 100),
      table("ops", "sales_targets", 240),
    ];
    const suggested = suggestScope(tabs, groupTables(tabs));
    expect(suggested.include).toEqual([]);
    for (const t of ["ops._migrations", "ops.etl_job_runs", "shop.stg_sales", "shop.sales_bak", "shop.tmp_load"]) {
      expect(suggested.exclude.some((p) => matchesPattern(p, { schema: t.split(".")[0]!, name: t.split(".")[1]! }))).toBe(true);
    }
    const selected = tabs.filter((t) => !suggested.exclude.some((p) => matchesPattern(p, t))).map(qualifiedName).sort();
    expect(selected).toEqual(["ops.sales_targets", "shop.products", "shop.sales"]);
    // Staging by schema or by the table comment counts too, and an include that selects it excludes it.
    const raw: SnapshotTable[] = [
      table("analytics", "fct_orders", 10),
      table("analytics", "fct_payments", 10),
      table("landing", "fct_orders_feed", 10),
      { ...table("analytics", "fct_imports", 10), description: "Raw export from the shop. Not cleaned." },
    ];
    const s2 = suggestScope(raw, groupTables(raw));
    expect(s2.include).toEqual(["fct_*"]);
    expect(s2.exclude).toEqual(["analytics.fct_imports", "landing.fct_orders_feed"]);
  });

  test("the suggested scope excludes an exclude-suggested schema whose tables an include selects", () => {
    const tabs = [
      table("analytics", "fct_orders", 10),
      table("analytics", "fct_payments", 10),
      table("analytics", "dim_customers", 10),
      table("analytics", "dim_products", 10),
      table("raw", "fct_orders", 10),
      table("raw", "customers", 10),
    ];
    const groups = groupTables(tabs);
    expect(groups.find((g) => g.pattern === "raw.*")?.suggestion).toBe("exclude");
    const suggested = suggestScope(tabs, groups);
    expect(suggested.exclude).toEqual(["raw.*"]);
    const selected = tabs.filter(
      (t) => suggested.include.some((p) => matchesPattern(p, t)) && !suggested.exclude.some((p) => matchesPattern(p, t)),
    );
    expect(selected.map((t) => `${t.schema}.${t.name}`).sort()).toEqual([
      "analytics.dim_customers",
      "analytics.dim_products",
      "analytics.fct_orders",
      "analytics.fct_payments",
    ]);

    // An include that selects none of the schema's tables leaves it out of the excludes.
    const clean = [table("analytics", "fct_orders", 10), table("analytics", "fct_payments", 10), table("raw", "orders", 1), table("raw", "payments", 1)];
    expect(suggestScope(clean, groupTables(clean))).toEqual({ include: ["fct_*"], exclude: [] });
  });

  test("the suggested scope command quotes patterns for the shell", () => {
    expect(scopeCommand("wh", { include: ["fct_*", "dim_*"], exclude: ["p.it's_tmp", "a.b"] })).toBe(
      "sl scope --source wh --include 'fct_*' --include 'dim_*' --exclude 'p.it'\\''s_tmp' --exclude a.b",
    );
  });

  test("the noise pattern is built from rules, stays short and agrees with noiseReason", () => {
    expect(NOISE_PATTERN.length).toBeLessThan(400);
    const names = [
      "orders_tmp", "tmp_orders", "_tmp", "tmp", "a__tmp", "x-backup-1", "Orders_TMP", "my.old.table", "orders_copy",
      "events_2024", "events_202401", "events_2024_01", "events_20240101", "events_2024_01_01", "events_1999",
      "schema_migrations", "_prisma_migrations", "FLYWAY_SCHEMA_HISTORY", "knex_migrations",
      "orders", "fct_orders", "tmpfile", "attempts", "oldest_users", "events_2024x", "events_123", "my_schema_migrations",
      "etl_job_runs", "dbt_runs", "airflow-dags", "fivetran.audit", "stitch_log", "_migrations", "_x", "etlx", "dbtx_models", "airbyte",
    ];
    for (const name of names) {
      expect([name, matchesPattern(NOISE_PATTERN, { schema: "s", name })]).toEqual([name, noiseReason(name) !== null]);
    }
    const many: SnapshotTable[] = [];
    for (let i = 0; i < 400; i++) many.push(table("p", `events_${20200101 + i}`, 1));
    const noise = groupTables(many).find((g) => g.kind === "noise");
    expect(noise?.tables).toHaveLength(400);
    expect(noise?.pattern).toBe(NOISE_PATTERN);
  });

  test("schemas that differ only in case form one group", () => {
    const tabs = [table("Sales", "a_x", 1), table("Sales", "b_y", 1), table("sales", "c_z", 1), table("ops", "d_w", 1), table("ops", "e_v", 1)];
    const schemas = groupTables(tabs).filter((g) => g.kind === "schema");
    expect(schemas.map((g) => [g.key, g.pattern, g.tables.length])).toEqual([
      ["sales", "sales.*", 3],
      ["ops", "ops.*", 2],
    ]);
  });

  test("a group whose pattern would select tables outside it is left out", () => {
    const tabs = [
      table("p", "a?b_x", 1),
      table("p", "a?b_y", 1),
      table("p", "acb_z", 1),
      table("p", "report_01", 1),
      table("p", "summary_01", 1),
      table("p", "events_2024_01", 1),
      table("p", "events_2025_01", 1),
    ];
    const groups = groupTables(tabs);
    expect(groups.find((g) => g.pattern === "a?b_*")).toBeUndefined();
    expect(groups.find((g) => g.pattern === "*_01")).toBeUndefined();
    expect(groups.find((g) => g.key === "_<date>")?.tables).toEqual(["p.events_2024_01", "p.events_2025_01"]);
    for (const g of groups) {
      expect(tabs.filter((t) => matchesPattern(g.pattern, t)).map(qualifiedName).sort()).toEqual([...g.tables].sort());
    }
  });

  test("ordering does not depend on the locale", () => {
    const tabs = [table("p", "b_x", 1), table("p", "b_y", 1), table("p", "B_z", 1), table("p", "a_x", 1), table("p", "a_y", 1), table("p", "a_z", 1)];
    const b = groupTables(tabs).find((g) => g.key === "b_");
    expect(b?.tables).toEqual(["p.B_z", "p.b_x", "p.b_y"]);
  });
});

describe("sl tables", () => {
  test("JSON lists ranked in-scope tables and flags the need to focus", async () => {
    const { root } = await setup();
    const r = await sl(root, ["tables", "--source", "wh", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<{
      total: number;
      in_scope: number;
      focus_threshold: number;
      needs_focus: boolean;
      tables: { table: string; model: string | null; model_status: string | null; profiled: boolean; in_scope: boolean; columns: number; rows: number; score: number; reasons: string[] }[];
      groups?: unknown[];
    }>();
    expect(j.total).toBe(25);
    expect(j.in_scope).toBe(25);
    expect(j.focus_threshold).toBe(12);
    expect(j.needs_focus).toBe(true);
    expect(j.groups).toBeUndefined();
    expect(j.tables).toHaveLength(25);
    expect(j.tables[0]?.table).toBe("analytics.dim_customers");
    const orders = j.tables.find((t) => t.table === "analytics.fct_orders");
    expect(orders).toMatchObject({ model: "orders", model_status: "draft", profiled: true, in_scope: true, columns: 2, rows: 10000 });
    expect(orders?.reasons.length).toBeGreaterThan(0);
    expect(j.tables.find((t) => t.table === "analytics.fct_payments")).toMatchObject({ model: null, model_status: null, profiled: false });
    const last = j.tables.slice(-7).map((t) => t.table);
    expect(last).toContain("analytics.schema_migrations");
  });

  test("profiled is yes, partial or no by the rule sl status applies", async () => {
    const { root } = await setup();
    const path = join(root, "snapshots", "wh.json");
    const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    // A reintrospect that added a column drops profiled_at but keeps the old columns' profiles.
    const payments = snap.tables.find((t) => t.name === "fct_payments")!;
    payments.columns[0]!.profile = { null_fraction: 0, distinct_count: 8000 };
    writeJson(path, snap);
    const j = (await sl(root, ["tables", "--source", "wh", "--json"])).json<{
      tables: { table: string; profiled: boolean; profile_state: string }[];
    }>();
    const row = (name: string) => j.tables.find((t) => t.table === `analytics.${name}`);
    expect(row("fct_orders")).toMatchObject({ profiled: true, profile_state: "yes" });
    expect(row("fct_payments")).toMatchObject({ profiled: false, profile_state: "partial" });
    expect(row("fct_sessions")).toMatchObject({ profiled: false, profile_state: "no" });
    const human = await sl(root, ["tables", "--source", "wh"]);
    const line = (name: string) => human.out.split("\n").find((l) => l.startsWith(`analytics.${name} `))!;
    expect(line("fct_orders").trimEnd().endsWith("yes")).toBe(true);
    expect(line("fct_payments").trimEnd().endsWith("partial")).toBe(true);
    expect(line("fct_sessions").trimEnd().endsWith("no")).toBe(true);
    // sl status counts the partial table as needing a profile.
    const st = (await sl(root, ["status", "--json"])).json<{ sources: { unprofiled_tables: string[]; partially_profiled_tables: string[] }[] }>();
    expect(st.sources[0]!.unprofiled_tables).toContain("analytics.fct_payments");
    expect(st.sources[0]!.unprofiled_tables).not.toContain("analytics.fct_orders");
    expect(st.sources[0]!.partially_profiled_tables).toEqual(["analytics.fct_payments"]);
  });

  test("human output has the focus hint, and --groups adds the groups", async () => {
    const { root } = await setup();
    const r = await sl(root, ["tables", "--source", "wh", "--groups"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("25 tables in wh, 25 in scope.");
    expect(r.out).toContain("focus threshold of 12");
    expect(r.out).toContain("sl tables --source wh --groups");
    expect(r.out).toContain("orders (draft)");
    expect(r.out).toContain("raw_stripe_*");
    expect(r.out).toContain("Suggested scope (the include-suggested groups, less the noise and staging tables they would select):");
    expect(r.out).toContain("  sl scope --source wh --include 'dim_*' --include 'fct_*'\n");
    expect(r.out).toContain("add --write to save it");
    const j = (await sl(root, ["tables", "--source", "wh", "--groups", "--json"])).json<{
      groups: { pattern: string; total_rows: number | null; rows_unknown: number }[];
      suggested_scope: { include: string[]; exclude: string[] };
    }>();
    expect(j.groups.map((g) => g.pattern)).toContain("fct_*");
    expect(j.groups.find((g) => g.pattern === "fct_*")).toMatchObject({ total_rows: 78000, rows_unknown: 0 });
    expect(j.suggested_scope).toEqual({ include: ["dim_*", "fct_*"], exclude: [] });
    const plain = (await sl(root, ["tables", "--source", "wh", "--json"])).json<{ suggested_scope?: unknown }>();
    expect(plain.suggested_scope).toBeUndefined();
  });

  test("scope narrows the list, --all shows every table, and a small scope needs no focus", async () => {
    const { root } = await setup();
    await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "dim_*", "--exclude", "*_v2", "--write"]);
    const j = (await sl(root, ["tables", "--source", "wh", "--json"])).json<{ in_scope: number; needs_focus: boolean; tables: { in_scope: boolean }[] }>();
    expect(j.in_scope).toBe(6);
    expect(j.needs_focus).toBe(false);
    expect(j.tables).toHaveLength(6);
    const all = (await sl(root, ["tables", "--source", "wh", "--all", "--json"])).json<{ tables: { in_scope: boolean }[] }>();
    expect(all.tables).toHaveLength(25);
    expect(all.tables.filter((t) => t.in_scope)).toHaveLength(6);
    const human = await sl(root, ["tables", "--source", "wh"]);
    expect(human.out).not.toContain("focus threshold");
  });

  test("long group patterns are shortened in human output", async () => {
    const { root } = await setup();
    const r = await sl(root, ["tables", "--source", "wh", "--groups"]);
    const groupLines = r.out.slice(r.out.indexOf("Groups")).split("\n");
    expect(Math.max(...groupLines.map((l) => l.length))).toBeLessThan(300);
    expect(r.out).toContain(`${NOISE_PATTERN.slice(0, 60)}…`);
    expect(r.out).toContain("pass --json for the full text");
    const j = (await sl(root, ["tables", "--source", "wh", "--groups", "--json"])).json<{ groups: { kind: string; pattern: string }[] }>();
    expect(j.groups.find((g) => g.kind === "noise")?.pattern).toBe(NOISE_PATTERN);
  });

  test("a --source name that is not a spec name is rejected", async () => {
    const { root } = await setup();
    for (const cmd of [["tables"], ["scope", "--include", "a", "--write"]]) {
      const r = await sl(root, [...cmd, "--source", "../../outside"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("must match");
    }
  });

  test("a missing snapshot is a user error", async () => {
    const { root } = await setup();
    writeYaml(join(root, "sources", "lake.yaml"), { source: "lake", dialect: "duckdb" });
    const r = await sl(root, ["tables", "--source", "lake"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('No snapshot for "lake"');
    const s = await sl(root, ["scope", "--source", "lake", "--include", "x"]);
    expect(s.code).toBe(1);
  });
});

describe("sl scope", () => {
  test("preview writes nothing; --write saves and keeps comments", async () => {
    const { root, sourcePath } = await setup();
    const preview = await sl(root, ["scope", "--source", "wh", "--include", "fct_*,dim_*", "--exclude", "*_v2", "--json"]);
    expect(preview.code).toBe(0);
    const p = preview.json<ScopeJson>();
    expect(p.written).toBe(false);
    expect(p.before_count).toBe(25);
    expect(p.after_count).toBe(6);
    expect(p.scope).toEqual({ include: ["fct_*", "dim_*"], exclude: ["*_v2"] });
    expect(p.removed).toHaveLength(19);
    expect(p.added).toEqual([]);
    expect(p.needs_focus).toBe(false);
    expect(p.tables.find((t) => t.table === "analytics.fct_sessions")?.rows).toBe(50000);
    expect(readFileSync(sourcePath, "utf8")).toBe(SOURCE_YAML);
    const human = await sl(root, ["scope", "--source", "wh", "--include", "fct_*"]);
    expect(human.out).toContain("Preview only; nothing was written.");

    const w = await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "dim_*", "--exclude", "*_v2", "--write", "--json"]);
    expect(w.json<ScopeJson>().written).toBe(true);
    const text = readFileSync(sourcePath, "utf8");
    expect(text).toContain("# Warehouse replica. Owner: Dana.");
    expect(text).toContain("# local file for tests");
    expect(text).toContain("# Profile settings stay small in CI.");
    expect(readSource(sourcePath).scope).toEqual({ include: ["fct_*", "dim_*"], exclude: ["*_v2"] });
    expect(readSource(sourcePath).profile).toEqual({ top_values: 5 });

    const again = (await sl(root, ["scope", "--source", "wh", "--include", "stg_*", "--json"])).json<ScopeJson>();
    expect(again.before_count).toBe(6);
    expect(again.scope.include).toEqual(["fct_*", "dim_*", "stg_*"]);
    expect(again.added).toEqual(["raw.stg_customers", "raw.stg_orders", "raw.stg_payments", "raw.stg_products"]);
    expect(again.removed).toEqual([]);
  });

  test("--remove drops a pattern from either list", async () => {
    const { root, sourcePath } = await setup();
    await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "dim_*", "--exclude", "*_v2", "--write"]);
    const r = (await sl(root, ["scope", "--source", "wh", "--remove", "*_v2", "--remove", "dim_*", "--write", "--json"])).json<ScopeJson>();
    expect(r.scope).toEqual({ include: ["fct_*"] });
    expect(r.after_count).toBe(4);
    expect(r.removed.sort()).toEqual(["analytics.dim_customers", "analytics.dim_dates", "analytics.dim_products"]);
    expect(r.added).toEqual(["analytics.fct_orders_v2"]);
    const text = readFileSync(sourcePath, "utf8");
    expect(text).not.toContain("exclude");
    expect(text).toContain("# Warehouse replica. Owner: Dana.");
    const human = await sl(root, ["scope", "--source", "wh", "--remove", "nope_*"]);
    expect(human.out).toContain('"nope_*" is not in the scope');
  });

  test("--clear starts over and an empty scope removes the key", async () => {
    const { root, sourcePath } = await setup();
    await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--write"]);
    const fresh = (await sl(root, ["scope", "--source", "wh", "--clear", "--include", "dim_*", "--json"])).json<ScopeJson>();
    expect(fresh.scope).toEqual({ include: ["dim_*"] });
    expect(fresh.before_count).toBe(4);
    expect(fresh.after_count).toBe(4);
    const cleared = (await sl(root, ["scope", "--source", "wh", "--clear", "--write", "--json"])).json<ScopeJson>();
    expect(cleared.scope).toEqual({});
    expect(cleared.after_count).toBe(25);
    expect(cleared.needs_focus).toBe(true);
    expect(readSource(sourcePath).scope).toBeUndefined();
    expect(readFileSync(sourcePath, "utf8")).not.toContain("scope");
    expect(readFileSync(sourcePath, "utf8")).toContain("# Profile settings stay small in CI.");
  });

  test("--tables adds exact qualified names and rejects unknown ones", async () => {
    const { root } = await setup();
    const r = (await sl(root, ["scope", "--source", "wh", "--tables", "fct_orders,raw.stg_orders", "--json"])).json<ScopeJson>();
    expect(r.scope.include).toEqual(["analytics.fct_orders", "raw.stg_orders"]);
    expect(r.after_count).toBe(2);
    expect(r.tables.map((t) => t.table)).toEqual(["analytics.fct_orders", "raw.stg_orders"]);
    const bad = await sl(root, ["scope", "--source", "wh", "--tables", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('"nope"');
  });

  test("regex patterns, unmatched warnings and invalid patterns", async () => {
    const { root } = await setup();
    const re = (await sl(root, ["scope", "--source", "wh", "--include", "re:dim_(customer|product)s(_v\\d+)?", "--json"])).json<ScopeJson>();
    expect(re.tables.map((t) => t.table)).toEqual(["analytics.dim_customers", "analytics.dim_customers_v2", "analytics.dim_products"]);
    const comma = (await sl(root, ["scope", "--source", "wh", "--include", "re:events_\\d{4}(_\\d{2}){0,1}", "--json"])).json<ScopeJson>();
    expect(comma.scope.include).toEqual(["re:events_\\d{4}(_\\d{2}){0,1}"]);
    expect(comma.after_count).toBe(2);
    const qualified = (await sl(root, ["scope", "--source", "wh", "--include", "re:raw\\.raw_.*", "--json"])).json<ScopeJson>();
    expect(qualified.after_count).toBe(4);

    const unmatched = await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "mart_*", "--json"]);
    expect(unmatched.json<ScopeJson>().unmatched_patterns).toEqual(["mart_*"]);
    const human = await sl(root, ["scope", "--source", "wh", "--include", "mart_*"]);
    expect(human.out).toContain('Pattern "mart_*" matches no table');
    expect(human.out).toContain("No table is in scope.");

    const invalid = await sl(root, ["scope", "--source", "wh", "--include", "re:(unclosed"]);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("Invalid regex");
  });

  test("--write edits scope lists in place, keeping comments and flow style", async () => {
    const { root, sourcePath } = await setup();
    writeFileSync(
      sourcePath,
      SOURCE_YAML +
        "# Focus agreed with Dana.\nscope:\n  # facts and dims\n  include: [\"fct_*\", \"stg_*\"] # facts\n  # noise\n  exclude:\n    - \"*_tmp\" # temp\n    - \"*_v2\" # versions\n",
    );
    await sl(root, ["scope", "--source", "wh", "--include", "dim_*", "--write"]);
    let text = readFileSync(sourcePath, "utf8");
    for (const c of ["# Focus agreed with Dana.", "# facts and dims", "# facts", "# noise", "# temp", "# versions"]) expect(text).toContain(c);
    expect(text).toContain("include: [\"fct_*\", \"stg_*\", dim_*]");
    expect(text).toContain('- "*_tmp" # temp');
    expect(readSource(sourcePath).scope).toEqual({ include: ["fct_*", "stg_*", "dim_*"], exclude: ["*_tmp", "*_v2"] });

    await sl(root, ["scope", "--source", "wh", "--remove", "*_v2", "--remove", "stg_*", "--write"]);
    text = readFileSync(sourcePath, "utf8");
    expect(text).toContain('- "*_tmp" # temp');
    expect(text).not.toContain("# versions");
    expect(text).toContain("# facts and dims");
    expect(readSource(sourcePath).scope).toEqual({ include: ["fct_*", "dim_*"], exclude: ["*_tmp"] });
  });

  test("an ambiguous bare --tables name asks for the qualified one", async () => {
    const { root } = await setup();
    const snap = JSON.parse(readFileSync(join(root, "snapshots", "wh.json"), "utf8")) as Snapshot;
    snap.tables.push(table("raw", "fct_orders", 1));
    writeJson(join(root, "snapshots", "wh.json"), snap);
    const r = await sl(root, ["scope", "--source", "wh", "--tables", "fct_orders"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"fct_orders" is in several schemas (analytics.fct_orders, raw.fct_orders); pass the qualified name.');
  });

  test("glob patterns dedupe and remove case-insensitively; regex bodies stay exact", async () => {
    const { root } = await setup();
    const d = (await sl(root, ["scope", "--source", "wh", "--include", "fct_*", "--include", "FCT_*", "--include", "re:dim_\\w+", "--include", "re:DIM_\\w+", "--json"])).json<ScopeJson>();
    expect(d.scope.include).toEqual(["fct_*", "re:dim_\\w+", "re:DIM_\\w+"]);
    await sl(root, ["scope", "--source", "wh", "--tables", "analytics.fct_orders", "--write"]);
    const r = (await sl(root, ["scope", "--source", "wh", "--remove", "ANALYTICS.FCT_ORDERS", "--json"])).json<ScopeJson & { warnings: string[] }>();
    expect(r.scope).toEqual({});
    expect(r.warnings.some((w) => w.includes("not in the scope"))).toBe(false);
  });

  test("a scope still above the threshold warns", async () => {
    const { root } = await setup();
    const r = await sl(root, ["scope", "--source", "wh", "--exclude", "*_tmp"]);
    expect(r.out).toContain("23 tables are in scope, more than the focus threshold of 12");
    expect(r.out).toContain("Removed (2): analytics.orders_tmp, analytics.payments_tmp");
  });
});

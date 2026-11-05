import { describe, expect, test } from "bun:test";
import { inScope, matchesDotted, matchesPattern } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import { classifyTable, noiseReason, rankTables, stagingReasons } from "../skills/semantic-layer/scripts/lib/rank.ts";
import type { SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";

const t = (schema: string | null, name: string) => ({ schema, name });

describe("scope patterns", () => {
  test("prefix, suffix, contains, schema, regex", () => {
    expect(matchesPattern("fct_*", t("public", "fct_orders"))).toBe(true);
    expect(matchesPattern("fct_*", t("public", "dim_orders"))).toBe(false);
    expect(matchesPattern("*_daily", t(null, "sales_daily"))).toBe(true);
    expect(matchesPattern("*orders*", t("x", "stg_orders_v2"))).toBe(true);
    expect(matchesPattern("analytics.*", t("analytics", "anything"))).toBe(true);
    expect(matchesPattern("analytics.*", t("public", "anything"))).toBe(false);
    expect(matchesPattern("re:dim_(customer|product)s?", t("p", "dim_customers"))).toBe(true);
    expect(matchesPattern("re:dim_(customer|product)s?", t("p", "dim_regions"))).toBe(false);
    expect(matchesPattern("FCT_?RDERS", t(null, "fct_orders"))).toBe(true);
    expect(matchesPattern("fct.orders", t(null, "fctxorders"))).toBe(false);
  });

  test("exclude wins and empty include means everything", () => {
    expect(inScope(undefined, t(null, "a"))).toBe(true);
    expect(inScope({ exclude: ["*_tmp"] }, t(null, "a_tmp"))).toBe(false);
    expect(inScope({ include: ["fct_*"], exclude: ["*_v2"] }, t(null, "fct_orders_v2"))).toBe(false);
    expect(inScope({ include: ["fct_*"], exclude: ["*_v2"] }, t(null, "fct_orders"))).toBe(true);
  });

  test("dotted access names", () => {
    expect(matchesDotted("warehouse.*", "warehouse.orders")).toBe(true);
    expect(matchesDotted("lake.*", "warehouse.orders")).toBe(false);
  });
});

describe("ranking", () => {
  const table = (name: string, rows: number, fks: string[] = []): SnapshotTable => ({
    schema: "public",
    name,
    kind: "table",
    row_count: rows,
    columns: [],
    foreign_keys: fks.map((f) => ({ columns: [`${f}_id`], references: { schema: "public", table: f, columns: ["id"] } })),
  });

  test("noise sinks and referenced tables rise", () => {
    const ranked = rankTables([table("orders_backup_2024", 100000), table("fct_orders", 10000, ["dim_customers"]), table("dim_customers", 500)]);
    expect(ranked.map((r) => r.table.name)).toEqual(["fct_orders", "dim_customers", "orders_backup_2024"]);
    expect(noiseReason("customers_tmp")).toContain("tmp");
    expect(noiseReason("events_20240101")).toContain("date");
    expect(noiseReason("fct_orders")).toBeNull();
  });

  test("pipeline bookkeeping and leading underscores are noise", () => {
    expect(noiseReason("etl_job_runs")).toBe('name contains "etl": pipeline bookkeeping');
    expect(noiseReason("dbt-run-results")).toContain("pipeline bookkeeping");
    expect(noiseReason("_migrations")).toBe("name starts with an underscore: tool bookkeeping");
    expect(noiseReason("schema_migrations")).toBe("migration bookkeeping table");
    expect(noiseReason("etlx_orders")).toBeNull();
  });

  test("one classifier for noise and staging: by name, schema and comment, noise first", () => {
    expect(classifyTable({ schema: "shop", name: "stg_sales" })).toEqual({ role: "staging", reasons: ["raw or staging naming"], excludable: true });
    expect(classifyTable({ schema: "raw", name: "orders" })).toEqual({ role: "staging", reasons: ["in the raw schema"], excludable: true });
    expect(classifyTable({ schema: "shop", name: "orders_feed", description: "Raw export, not cleaned." })!.role).toBe("staging");
    expect(classifyTable({ schema: "raw", name: "orders_tmp" })).toEqual({ role: "noise", reasons: ['name contains "tmp"'], excludable: true });
    // int_ names staging for the ranking only: a suggested scope keeps it.
    expect(classifyTable({ schema: "mfg", name: "int_shipments" })).toEqual({ role: "staging", reasons: ["intermediate (int_) naming"], excludable: false });
    expect(classifyTable({ schema: "shop", name: "orders" })).toBeNull();
    expect(stagingReasons({ schema: "staging", name: "raw_orders", description: "the landing table for orders" })).toEqual([
      "raw or staging naming",
      "in the staging schema",
      "the table comment says it is raw or uncleaned",
    ]);
  });

  test("raw, landing and stitch as ordinary business words are neither staging nor noise", () => {
    // The reviewer's probe: these were not staging or noise before the classifier was shared with the suggested scope.
    expect(classifyTable({ schema: "mfg", name: "materials", description: "Inventory of raw materials, one row per lot" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "orders", description: "Orders as loaded; totals are raw sums before discounts" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "landing_pages", description: "One row per marketing landing page" })).toBeNull();
    expect(classifyTable({ schema: "mfg", name: "stitch_counts" })).toBeNull();
    // Staging phrases still are.
    for (const description of ["Raw data from the ERP", "staging table for orders", "landing zone copy", "Not yet cleaned", "uncleaned rows"]) {
      expect([description, classifyTable({ schema: "s", name: "orders", description })?.role]).toEqual([description, "staging"]);
    }
    // A landing schema is still staging, and Stitch's own _sdc_ tables are still noise.
    expect(classifyTable({ schema: "landing", name: "orders" })?.role).toBe("staging");
    expect(classifyTable({ schema: "s", name: "_sdc_rejected" })?.role).toBe("noise");
  });

  test("staging by schema ranks below a table of the same size; pipeline tables sink like noise", () => {
    const t = (schema: string, name: string, rows: number): SnapshotTable => ({ schema, name, kind: "table", row_count: rows, columns: [] });
    const ranked = rankTables([t("raw", "orders", 1000), t("shop", "orders", 1000), t("ops", "etl_job_runs", 100000)]);
    expect(ranked.map((r) => r.qualified)).toEqual(["shop.orders", "raw.orders", "ops.etl_job_runs"]);
    expect(ranked[1]!.reasons).toContain("in the raw schema");
    expect(ranked[2]!.reasons).toContain('likely noise: name contains "etl": pipeline bookkeeping');
  });
});

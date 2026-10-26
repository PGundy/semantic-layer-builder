import { describe, expect, test } from "bun:test";
import { inScope, matchesDotted, matchesPattern } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import { noiseReason, rankTables } from "../skills/semantic-layer/scripts/lib/rank.ts";
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
});

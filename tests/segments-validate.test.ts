// Validation of segments (lib/validate-rules/metric.ts; spec: Metric semantics, Segments): a name
// declared twice, a measure or a golden's request naming a segment that does not exist, and a
// segment filter that is not one expression or holds a subquery, each give their code at their path.
import { describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { referencedColumns } from "../skills/semantic-layer/scripts/lib/snapshot-diff.ts";
import type { Model, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { tempDir } from "./helpers.ts";

const VALID = join(import.meta.dir, "fixtures", "valid");

function layer(edit: (orders: Record<string, unknown>, golden: Record<string, unknown>) => void): string {
  const root = join(tempDir("segments"), "semantic");
  cpSync(VALID, root, { recursive: true });
  const ordersPath = join(root, "models", "warehouse", "orders.yaml");
  const goldenPath = join(root, "goldens", "revenue_by_month_2025.yaml");
  const orders = readYaml(ordersPath) as Record<string, unknown>;
  const golden = readYaml(goldenPath) as Record<string, unknown>;
  edit(orders, golden);
  writeYaml(ordersPath, orders);
  writeYaml(goldenPath, golden);
  return root;
}

const segmentIssues = (root: string) =>
  validateProject(root)
    .filter((i) => i.path.includes("segments"))
    .map((i) => [i.level, i.file, i.path, i.code]);

const draftCount = (segments: string[]) => ({ name: "sale_count", agg: "count", segments, description: "Sales.", status: "draft" });

describe("segments in validate", () => {
  test("well-formed segments a draft measure names give no issue", () => {
    const root = layer((orders) => {
      orders.segments = [{ name: "sales", filter: "status in ('completed', 'shipped')", description: "Orders that count as sales." }];
      (orders.measures as unknown[]).push(draftCount(["sales"]));
    });
    expect(segmentIssues(root)).toEqual([]);
  });

  test("a duplicate name, an unknown name and a subquery each give their code", () => {
    const root = layer((orders, golden) => {
      orders.segments = [
        { name: "sales", filter: "status in ('completed', 'shipped')" },
        { name: "sales", filter: "status = 'completed'" },
        { name: "vip", filter: "customer_id in (select customer_id from vips)" },
        { name: "open", filter: "status = 'open" },
      ];
      (orders.measures as unknown[]).push(draftCount(["sales", "returns"]));
      (golden.request as Record<string, unknown>).segments = ["orders.sales", "orders.gone"];
    });
    const n = (orders: Record<string, unknown>) => (orders.measures as unknown[]).length;
    const measures = n(readYaml(join(root, "models", "warehouse", "orders.yaml")) as Record<string, unknown>);
    expect(segmentIssues(root)).toEqual([
      ["error", "models/warehouse/orders.yaml", "segments[1].name", "metric.segment_duplicate"],
      ["error", "models/warehouse/orders.yaml", "segments[2].filter", "expr.subquery"],
      ["error", "models/warehouse/orders.yaml", "segments[3].filter", "expr.not_one_expression"],
      ["error", "models/warehouse/orders.yaml", `measures[${measures - 1}].segments[1]`, "metric.segment_unknown"],
      ["error", "goldens/revenue_by_month_2025.yaml", "request.segments[1]", "metric.segment_unknown"],
    ]);
    const unknown = validateProject(root).find((i) => i.code === "metric.segment_unknown" && i.file.startsWith("models/"))!;
    expect(unknown.message).toBe("names segment returns, which model orders does not declare (its segments are sales, vip, open); add it under segments in this file, or take it out of the measure's segments");
  });

  test("a segment with no filter or an unknown key is a schema issue", () => {
    const root = layer((orders) => {
      orders.segments = [{ name: "sales", where: "status = 'completed'" }];
    });
    expect(validateProject(root).filter((i) => i.path.startsWith("segments")).map((i) => i.code).sort()).toEqual(["schema.required", "schema.unknown_property"]);
  });
});

describe("the columns a segment reads count as read", () => {
  const table: SnapshotTable = { schema: "public", name: "fct_orders", kind: "table", columns: ["order_id", "status", "ship_region"].map((name) => ({ name, type: "VARCHAR" })) };
  const model = (segments?: string[]) =>
    ({ model: "orders", measures: [{ name: "n", agg: "count", ...(segments ? { segments } : {}) }], segments: [{ name: "shipped", filter: "status = 'shipped'" }] }) as unknown as Model;

  test("referencedColumns lists a segment's column only for a measure that names the segment", () => {
    expect(referencedColumns(model(["shipped"]), table)).toEqual(["status"]);
    expect(referencedColumns(model(), table)).toEqual([]);
  });

  test("validate warns when a column a segment reads is listed in ignored_columns", () => {
    const root = layer((orders) => {
      orders.segments = [{ name: "shipped", filter: "status = 'shipped'" }];
      orders.ignored_columns = ["status"];
      // Nothing else reads the column: the dimension and the other measures are gone.
      orders.dimensions = (orders.dimensions as Record<string, unknown>[]).filter((d) => d.name !== "status");
      orders.measures = [draftCount(["shipped"])];
    });
    const hits = validateProject(root).filter((i) => i.code === "ignore.column_read");
    expect(hits.map((i) => i.path)).toEqual(["ignored_columns[0]"]);
    const plain = layer((orders) => {
      orders.ignored_columns = ["status"];
      orders.dimensions = (orders.dimensions as Record<string, unknown>[]).filter((d) => d.name !== "status");
      orders.measures = [draftCount([])];
    });
    expect(validateProject(plain).filter((i) => i.code === "ignore.column_read")).toEqual([]);
  });
});

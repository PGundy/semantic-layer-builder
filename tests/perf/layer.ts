// A synthetic semantic layer over the perf catalog (catalog.ts): one model per table for the first
// `models` tables, each with dimensions on its own columns and on a joined model's, two measures,
// a to-one join to the next model, and a ratio metric for every tenth model. The models are drafts
// that validate with no error. Every name is synthetic.
import { join } from "node:path";
import { writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { catalogTables } from "./catalog.ts";

export function writeLayer(root: string, source: string, models: number, tables: number): void {
  const picked = [...catalogTables(tables)].filter((t) => t.kind === "table").slice(0, models);
  const metrics: Record<string, unknown>[] = [];
  picked.forEach((t, i) => {
    const next = picked[(i + 1) % picked.length]!;
    const attrs = t.columns.slice(3).filter((c) => c.type === "text" || c.type === "integer");
    const dims: Record<string, unknown>[] = [
      { name: "created_at", expr: "created_at", type: "time", time_grains: ["day", "month"], description: "When the row was created.", status: "draft" },
      ...attrs.slice(0, 3).map((c) => ({ name: c.name, expr: c.name, type: c.type === "text" ? "string" : "number", description: `The ${c.name} column.`, status: "draft" })),
      { name: "next_created_at", expr: "next.created_at", type: "time", time_grains: ["day"], description: "When the next row was created.", status: "draft" },
    ];
    const ref = t.columns[1]!.name;
    writeYaml(join(root, "models", source, `${t.name}.yaml`), {
      model: t.name,
      source,
      table: `${t.schema}.${t.name}`,
      description: `Synthetic model ${i} over ${t.schema}.${t.name}.`,
      grain: "One row per id.",
      primary_key: ["id"],
      status: "draft",
      dimensions: dims,
      measures: [
        { name: "row_count", agg: "count", format: "integer", description: "Number of rows.", status: "draft" },
        { name: "ref_total", agg: "sum", expr: ref, filter: "id is not null", format: "integer", description: `Sum of ${ref}.`, status: "draft" },
      ],
      joins: [
        { name: "next", to: next.name, keys: [{ from: ref, to: "id" }], relationship: "many_to_one", type: "left", description: "The next model's row.", status: "draft" },
      ],
    });
    if (i % 10 === 0)
      metrics.push({
        name: `ratio_${String(i).padStart(4, "0")}`,
        source,
        type: "ratio",
        numerator: `${t.name}.ref_total`,
        denominator: `${t.name}.row_count`,
        format: "number",
        description: `Average ${ref} per row of model ${i}.`,
        status: "draft",
      });
  });
  writeYaml(join(root, "metrics.yaml"), { metrics });
}

// The first model the layer writes, for edits to aim at.
export function firstModel(tables: number): string {
  return [...catalogTables(tables)].find((t) => t.kind === "table")!.name;
}

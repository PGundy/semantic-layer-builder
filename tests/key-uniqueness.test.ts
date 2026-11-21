// A primary_key the stored data shows is not unique: semlayer validate warns (model.primary_key_not_unique)
// from the profile's distinct counts for a one-column key and from a bridge join's duplicate-pair count for a
// bridge model's two-column key, and the model's readback states the same fact. No query is run.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, semlayer, tempRoot } from "./helpers.ts";

const col = (name: string, type: string, profile?: Record<string, unknown>) => ({ name, type, nullable: false, description: null, ...(profile ? { profile } : {}) });
const table = (name: string, columns: ReturnType<typeof col>[], row_count: number) => ({ schema: "public", name, kind: "table", row_count, description: null, primary_key: [], unique_keys: [], foreign_keys: [], columns });
const prof = (distinct: number, extra: Record<string, unknown> = {}) => ({ null_fraction: 0, distinct_count: distinct, sampled: false, ...extra });

const ok = { status: "draft" };
const model = (name: string, pk: string[], extra: Partial<Model> = {}): Model =>
  ({ model: name, source: "shop", table: `public.${name}`, primary_key: pk, grain: `One row per ${name}.`, ...ok, dimensions: [], measures: [], ...extra }) as Model;

const BRIDGE_JOIN = (duplicate_rows: number, extra: Record<string, unknown> = {}) => ({
  name: "tag",
  to: "tags",
  keys: [{ from: "order_id", to: "order_id" }],
  relationship: "one_to_many",
  through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], dedupe: "distinct_pairs" },
  status: "draft",
  evidence: {
    checked_at: "2026-01-15T12:00:00.000Z",
    to: "tags",
    keys: [{ from: "order_id", to: "order_id" }],
    left_rows: 5,
    left_null_keys: 0,
    matched_rows: 4,
    match_rate: 0.8,
    right_rows: 8,
    right_key_unique: false,
    left_key_unique: true,
    max_fanout: 3,
    suggested_relationship: "one_to_many",
    through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], fact_rows: 5, bridge_rows: 8, duplicate_rows, rows_without_fact: 0, rows_without_target: 0, facts_unbridged: 0, facts_one_value: 3, facts_many_values: 2, max_values_per_fact: 3, ...extra },
  },
});

async function project(opts: { orderPk?: string[]; bridgePk?: string[]; orderProfile?: Record<string, unknown>; dup?: number; dialect?: string }): Promise<string> {
  const { root } = tempRoot();
  await initProject(root, "shop");
  writeFileSync(join(root, "sources", "shop.yaml"), `source: shop\ndialect: ${opts.dialect ?? "postgres"}\nconnection:\n  env: SHOP_URL\nintake:\n  schemas: [public]\n  primary: public\n`);
  mkdirSync(join(root, "snapshots"), { recursive: true });
  const tables = [
    table("orders", [col("order_id", "integer", opts.orderProfile ?? prof(5)), col("name", "text")], 5),
    table("tags", [col("tag_id", "integer", prof(3)), col("tag_name", "text")], 3),
    table("order_tags", [col("order_id", "integer", prof(4)), col("tag_id", "integer", prof(3))], 8),
  ];
  writeFileSync(join(root, "snapshots", "shop.json"), JSON.stringify({ snapshot_version: 1, source: "shop", dialect: opts.dialect ?? "postgres", captured_at: "2026-01-15T12:00:00.000Z", method: "live", tables }));
  const dir = join(root, "models", "shop");
  mkdirSync(dir, { recursive: true });
  writeYaml(join(dir, "orders.yaml"), model("orders", opts.orderPk ?? ["order_id"], { joins: [BRIDGE_JOIN(opts.dup ?? 1)] } as Partial<Model>));
  writeYaml(join(dir, "tags.yaml"), model("tags", ["tag_id"]));
  writeYaml(join(dir, "order_tags.yaml"), model("order_tags", opts.bridgePk ?? ["order_id", "tag_id"]));
  return root;
}

interface Issue {
  level: string;
  file: string;
  path: string;
  code: string;
  message: string;
}
const CODE = "model.primary_key_not_unique";
async function warned(root: string): Promise<Issue[]> {
  return (await semlayer(root, ["validate", "--json"])).json<{ issues: Issue[] }>().issues.filter((i) => i.code === CODE);
}

describe("model.primary_key_not_unique", () => {
  test("a bridge model whose two-column key repeats a pair in the stored bridge evidence warns, naming the next step", async () => {
    const root = await project({});
    const w = await warned(root);
    expect(w.map((i) => [i.level, i.file, i.path])).toEqual([["warning", "models/shop/order_tags.yaml", "primary_key"]]);
    expect(w[0]!.message).toContain("1 of 8 rows of order_tags repeats a (order_id, tag_id) pair");
    expect(w[0]!.message).toContain("rows cannot be told apart by this key");
    expect(w[0]!.message).toContain("semlayer set shop.order_tags primary_key");
    expect(w[0]!.message).toContain("grain");
  });

  test("a bridge model with no repeated pair, another key, or no evidence says nothing", async () => {
    expect(await warned(await project({ dup: 0 }))).toEqual([]);
    expect(await warned(await project({ bridgePk: ["order_id", "tag_id", "share"] }))).toEqual([]);
  });

  test("a one-column key whose whole-table profile has fewer distinct values than rows warns", async () => {
    const root = await project({ orderProfile: prof(4) });
    const w = (await warned(root)).filter((i) => i.file.endsWith("orders.yaml"));
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("4 distinct values in 5 rows");
    expect(w[0]!.message).toContain("rows cannot be told apart by this key");
    expect(w[0]!.message).toContain("semlayer set shop.orders primary_key");
  });

  test("it says nothing when the profile cannot know: a sample, no sampled flag, an estimate dialect, or distinct equal to rows", async () => {
    expect((await warned(await project({ orderProfile: prof(4, { sampled: true }) }))).filter((i) => i.file.endsWith("orders.yaml"))).toEqual([]);
    expect((await warned(await project({ orderProfile: { null_fraction: 0, distinct_count: 4 } }))).filter((i) => i.file.endsWith("orders.yaml"))).toEqual([]);
    expect((await warned(await project({ orderProfile: prof(4), dialect: "bigquery" }))).filter((i) => i.file.endsWith("orders.yaml"))).toEqual([]);
    expect((await warned(await project({ orderProfile: prof(5) }))).filter((i) => i.file.endsWith("orders.yaml"))).toEqual([]);
  });

  test("the model's readback states the same fact beside its key", async () => {
    const bridge = await project({});
    const b = await semlayer(bridge, ["readback", "--targets", "shop.order_tags"]);
    expect(b.err).toBe("");
    expect(b.out).toContain("- Primary key: order_id, tag_id.");
    expect(b.out).toContain("1 of 8 rows of order_tags repeats a (order_id, tag_id) pair, so rows cannot be told apart by this key");
    const one = await project({ orderProfile: prof(4) });
    const o = await semlayer(one, ["readback", "--targets", "shop.orders"]);
    expect(o.out).toContain("4 distinct values in 5 rows, so rows cannot be told apart by this key");
    const clean = await semlayer(await project({ dup: 0 }), ["readback", "--targets", "shop.order_tags"]);
    expect(clean.out).not.toContain("cannot be told apart");
  });

  test("the code is registered as a warning", async () => {
    const { issueCodes } = await import("../skills/semantic-layer/scripts/lib/issue-codes/index.ts");
    expect(issueCodes().get(CODE)).toMatchObject({ level: "warning" });
  });
});

// A drafted link table proposes the bridge join between the models it links (spec: Bridges and
// multi-fact requests): lib/draft-bridge.ts decides from the snapshot's structure alone, with the
// dedupe rule left unset for the owner. The cases below work each side of the rule on an in-memory
// snapshot; the same fixtures run through the command line on DuckDB.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { draftModels } from "../skills/semantic-layer/scripts/lib/draft.ts";
import type { CrossSchemaPair } from "../skills/semantic-layer/scripts/lib/schema-scope.ts";
import type { Model, Snapshot, SnapshotColumn, SnapshotTable } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { walkToDedupeQuestion } from "./draft-bridge-walk.ts";
import { duckdbSource, initProject, semlayer, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const col = (name: string, type = "integer"): SnapshotColumn => ({ name, type });
const table = (name: string, columns: SnapshotColumn[], row_count: number | null, extra: Partial<SnapshotTable> = {}): SnapshotTable => ({
  schema: "public",
  name,
  kind: "table",
  row_count,
  columns,
  ...extra,
});
const snapshot = (tables: SnapshotTable[]): Snapshot =>
  ({ snapshot_version: 1, source: "shop", dialect: "postgres", captured_at: "2026-01-01T00:00:00.000Z", method: "live", tables }) as Snapshot;

function draft(snap: Snapshot, only?: string[], existing: Model[] = []): Map<string, Model> {
  const tables = only ? snap.tables.filter((t) => only.includes(t.name)) : snap.tables;
  const { models } = draftModels(snap, tables, existing, { source: "shop", stripPrefixes: [], knownTables: snap.tables });
  return new Map(models.map((m) => [m.model, m]));
}
const bridgeJoins = (m: Model | undefined) => (m?.joins ?? []).filter((j) => j.through);

const orders = () => table("orders", [col("order_id"), col("customer_name", "varchar"), col("amount_cents")], 5, { primary_key: ["order_id"] });
const tags = () => table("tags", [col("tag_id"), col("tag_name", "varchar")], 4, { primary_key: ["tag_id"] });
const orderTags = () => table("order_tags", [col("order_id"), col("tag_id"), col("share")], 8);

describe("a drafted link table proposes the bridge join", () => {
  test("orders reach tags through order_tags, as a draft with no dedupe rule and an open question", () => {
    const models = draft(snapshot([orders(), tags(), orderTags()]));
    const [join] = bridgeJoins(models.get("orders"));
    expect(join).toEqual({
      name: "tag",
      to: "tags",
      keys: [{ from: "order_id", to: "order_id" }],
      relationship: "one_to_many",
      origin: "inferred",
      through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }] },
      status: "draft",
    });
    expect(join!.through).not.toHaveProperty("dedupe");
    expect(join!.through).not.toHaveProperty("weight");
    const question = models.get("orders")!.open_questions!.at(-1)!;
    expect(question).toContain("orders carries it because it has more rows");
    expect(question).not.toContain("distinct_pairs");
    expect(question).toContain("semlayer add-bridge --source shop --model tags --name order --to orders --through order_tags --keys tag_id=tag_id --through-keys order_id=order_id");
    // The bridge's own many-to-one joins stay, and the other side carries nothing.
    expect((models.get("order_tags")!.joins ?? []).map((j) => [j.to, j.relationship])).toEqual([["orders", "many_to_one"], ["tags", "many_to_one"]]);
    expect(bridgeJoins(models.get("tags"))).toEqual([]);
    expect(bridgeJoins(models.get("order_tags"))).toEqual([]);
  });

  test("user_roles with only two id columns drafts the join from the side with more rows", () => {
    const snap = snapshot([
      table("users", [col("user_id"), col("email", "varchar")], 100, { primary_key: ["user_id"] }),
      table("roles", [col("role_id"), col("role_name", "varchar")], 4, { primary_key: ["role_id"] }),
      table("user_roles", [col("user_id"), col("role_id")], 150),
    ]);
    const models = draft(snap);
    const [join] = bridgeJoins(models.get("users"));
    expect(join).toMatchObject({ name: "role", to: "roles", keys: [{ from: "user_id", to: "user_id" }], through: { model: "user_roles", keys: [{ from: "role_id", to: "role_id" }] } });
    expect(join!.through).not.toHaveProperty("dedupe");
    expect(bridgeJoins(models.get("roles"))).toEqual([]);
  });

  test("equal row counts fall to the model name, and unknown counts count least", () => {
    const equal = draft(
      snapshot([table("zebras", [col("zebra_id")], 3, { primary_key: ["zebra_id"] }), table("apples", [col("apple_id")], 3, { primary_key: ["apple_id"] }), table("apple_zebras", [col("apple_id"), col("zebra_id")], 1)]),
    );
    expect(bridgeJoins(equal.get("apples")).length).toBe(1);
    expect(bridgeJoins(equal.get("zebras"))).toEqual([]);
    const unknown = draft(snapshot([orders(), table("tags", [col("tag_id")], null, { primary_key: ["tag_id"] }), orderTags()]));
    expect(bridgeJoins(unknown.get("orders")).length).toBe(1);
  });

  test("the same snapshot drafts the same models twice", () => {
    const snap = snapshot([orders(), tags(), orderTags()]);
    expect(JSON.stringify([...draft(snap)])).toBe(JSON.stringify([...draft(snap)]));
  });
});

describe("a table that is not clearly a link proposes nothing", () => {
  const none = (...tables: SnapshotTable[]) => {
    const models = draft(snapshot(tables));
    return [...models.values()].flatMap((m) => bridgeJoins(m));
  };
  const users = () => table("users", [col("user_id")], 10, { primary_key: ["user_id"] });
  const roles = () => table("roles", [col("role_id")], 3, { primary_key: ["role_id"] });
  const teams = () => table("teams", [col("team_id")], 3, { primary_key: ["team_id"] });

  test("a table with a measure beside its two keys is a fact", () => {
    expect(none(orders(), tags(), table("order_items", [col("order_id"), col("tag_id"), col("quantity")], 20))).toEqual([]);
  });
  test("three foreign keys, whether or not the third table is drafted", () => {
    expect(none(users(), roles(), teams(), table("memberships", [col("user_id"), col("role_id"), col("team_id")], 9))).toEqual([]);
    expect(none(users(), roles(), table("memberships", [col("user_id"), col("role_id"), col("team_id")], 9))).toEqual([]);
  });
  test("a self-referencing pair", () => {
    expect(none(users(), table("user_links", [col("user_id"), col("parent_user_id")], 5))).toEqual([]);
  });
  test("a per-line figure or position beside the keys is a fact", () => {
    for (const name of ["discount_pct", "line_number", "position", "seq"]) {
      expect(none(orders(), tags(), table("order_lines", [col("order_id"), col("tag_id"), col(name)], 20))).toEqual([]);
    }
  });
  test("a table with a text column beside its keys", () => {
    expect(none(users(), roles(), table("user_roles", [col("user_id"), col("role_id"), col("note", "varchar")], 5))).toEqual([]);
  });
  test("a side that is not a model", () => {
    expect(none(users(), table("user_roles", [col("user_id"), col("role_id")], 5))).toEqual([]);
  });
  test("a non-bridge table with one foreign key", () => {
    expect(none(users(), table("logins", [col("login_id"), col("user_id"), col("at", "timestamp")], 5, { primary_key: ["login_id"] }))).toEqual([]);
  });
  test("two sides that are both existing models write nothing", () => {
    const existing = draft(snapshot([users(), roles()]));
    const snap = snapshot([users(), roles(), table("user_roles", [col("user_id"), col("role_id")], 5)]);
    const models = draft(snap, ["user_roles"], [...existing.values()]);
    expect([...models.values()].flatMap((m) => bridgeJoins(m))).toEqual([]);
  });
  test("a hop across schemas with an approved pair drafts the join", () => {
    const other = table("roles", [col("role_id")], 3, { schema: "auth", primary_key: ["role_id"] });
    const snap = snapshot([users(), other, table("user_roles", [col("user_id"), col("role_id")], 5)]);
    const pair: CrossSchemaPair = { from: "public", to: "auth", status: "approved", keys: [{ from: "user_roles.role_id", to: "roles.role_id" }], approved_by: "owner", approved_at: "2026-01-01T00:00:00.000Z" };
    const approved: CrossSchemaPair = { ...pair, approved_hash: itemHash("schema-pair", { ...pair }) };
    const { models } = draftModels(snap, snap.tables, [], { source: "shop", stripPrefixes: [], knownTables: snap.tables, crossSchema: [approved] });
    expect(models.flatMap((m) => bridgeJoins(m)).map((j) => j.to)).toEqual(["roles"]);
  });
  test("an existing far model is named as the reason for the direction", () => {
    const products = table("products", [col("product_id")], 50, { primary_key: ["product_id"] });
    const orderProducts = table("order_products", [col("order_id"), col("product_id")], 9);
    const snap = snapshot([orders(), products, orderProducts]);
    const existing = draft(snap, ["products"]);
    const models = draft(snap, ["orders", "order_products"], [...existing.values()]);
    expect(bridgeJoins(models.get("orders")).length).toBe(1);
    expect(models.get("orders")!.open_questions!.at(-1)).toContain("products is already modeled and this draft writes only orders");
  });
  test("a hop across schemas without an approved pair", () => {
    const other = table("roles", [col("role_id")], 3, { schema: "auth", primary_key: ["role_id"] });
    const snap = snapshot([users(), other, table("user_roles", [col("user_id"), col("role_id")], 5)]);
    expect([...draft(snap).values()].flatMap((m) => bridgeJoins(m))).toEqual([]);
  });
});

describe("on DuckDB through the command line", () => {
  async function project(statements: string[]): Promise<string> {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "shop", statements);
    const r = await semlayer(t.root, ["introspect", "--source", "shop"]);
    expect(r.code).toBe(0);
    return t.root;
  }

  test("user_roles drafts users.role with dedupe unset; validate passes; next asks the dedupe question", async () => {
    const root = await project([
      "create table users (user_id integer primary key, email varchar)",
      "create table roles (role_id integer primary key, role_name varchar)",
      "create table user_roles (user_id integer, role_id integer)",
      "insert into users values (1, 'a@example.com'), (2, 'b@example.com'), (3, 'c@example.com')",
      "insert into roles values (1, 'admin'), (2, 'viewer')",
      "insert into user_roles values (1, 1), (1, 2), (2, 2)",
    ]);
    const d = await semlayer(root, ["draft", "--source", "shop", "--tables", "users,roles,user_roles"]);
    expect(d.err).toBe("");
    expect(d.code).toBe(0);
    const users = readYaml<Model>(join(root, "models", "shop", "users.yaml"));
    const join_ = users.joins!.find((j) => j.through);
    expect(join_).toMatchObject({ name: "role", to: "roles", status: "draft", through: { model: "user_roles" } });
    expect(join_!.through).not.toHaveProperty("dedupe");
    const v = (await semlayer(root, ["validate", "--json"])).json<{ issues: { level: string; code: string }[] }>();
    expect(v.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(await walkToDedupeQuestion(root)).toContain("how is its figure shared");
  });

  test("two roots drafted from one database hold the same files byte for byte", async () => {
    const statements = readFileSync(join(import.meta.dir, "..", "fixtures", "semantics", "bridge.sql"), "utf8");
    const files: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const root = await project([statements]);
      const d = await semlayer(root, ["draft", "--source", "shop", "--tables", "orders,tags,order_tags"]);
      expect(d.code).toBe(0);
      files.push(["orders", "tags", "order_tags"].map((m) => readFileSync(join(root, "models", "shop", `${m}.yaml`), "utf8")));
      cleanup?.();
    }
    expect(files[0]).toEqual(files[1]);
    expect(files[0]![0]).toContain("through:");
  });
});

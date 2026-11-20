// Bridge joins (spec: Bridges and multi-fact requests): add-bridge writes a draft join with `through`
// and refuses what would not validate, validation fires one code per mistake, an approved bridge join
// needs its dedupe rule, the approval hash covers the rule, each hop obeys the schema-pair rule, and the
// compiler follows a bridge route (tests/compiler-bridge.test.ts checks its figures).
//
// The layer is the one of fixtures/semantics/bridge.sql: orders, tags and the order_tags bridge.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PENDING_DIR } from "../skills/semantic-layer/scripts/lib/readback.ts";
import { join } from "node:path";
import { parse } from "yaml";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { issueCodes } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
import type { Join, Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, semlayer, tempRoot } from "./helpers.ts";

const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-10" };
const col = (name: string, type: string) => ({ name, type, nullable: false, description: null });
const table = (name: string, columns: ReturnType<typeof col>[], schema = "public") => ({
  schema,
  name,
  kind: "table",
  row_count: 10,
  description: null,
  primary_key: [],
  unique_keys: [],
  foreign_keys: [],
  columns,
});
const TABLES = [
  table("orders", [col("order_id", "integer"), col("customer_name", "text"), col("amount_cents", "integer")]),
  table("tags", [col("tag_id", "integer"), col("tag_name", "text")]),
  table("order_tags", [col("order_id", "integer"), col("tag_id", "integer"), col("share", "integer"), col("note", "text")]),
];
const SOURCE = "source: shop\ndialect: postgres\nconnection:\n  env: SHOP_URL\nintake:\n  schemas: [public]\n  primary: public\n";

function snapshot(root: string, tables: unknown[] = TABLES): void {
  mkdirSync(join(root, "snapshots"), { recursive: true });
  writeFileSync(join(root, "snapshots", "shop.json"), JSON.stringify({ snapshot_version: 1, source: "shop", dialect: "postgres", captured_at: "2026-01-15T12:00:00.000Z", method: "live", tables }));
}

const model = (name: string, tableName: string, dims: string[], extra: Partial<Model> = {}): Model =>
  ({
    model: name,
    source: "shop",
    table: `public.${tableName}`,
    primary_key: [dims[0]!],
    grain: `One row per ${tableName}.`,
    ...ok,
    dimensions: dims.map((d) => ({ name: d, expr: d, type: d.endsWith("_id") ? "number" : "string", ...ok })),
    measures: [],
    ...extra,
  }) as Model;

const orders = (joins?: unknown[]): Model =>
  model("orders", "orders", ["order_id", "customer_name"], { measures: [{ name: "revenue", agg: "sum", expr: "amount_cents", description: "Order value.", ...ok }], ...(joins ? { joins } : {}) } as Partial<Model>);

// A project of the three models, with the orders joins given.
async function project(joins?: unknown[], opts: { tables?: unknown[]; source?: string } = {}): Promise<string> {
  const { root } = tempRoot();
  await initProject(root, "shop");
  writeFileSync(join(root, "sources", "shop.yaml"), opts.source ?? SOURCE);
  snapshot(root, opts.tables);
  const dir = join(root, "models", "shop");
  mkdirSync(dir, { recursive: true });
  writeYaml(join(dir, "orders.yaml"), orders(joins));
  writeYaml(join(dir, "tags.yaml"), model("tags", "tags", ["tag_id", "tag_name"]));
  writeYaml(join(dir, "order_tags.yaml"), model("order_tags", "order_tags", ["order_id", "tag_id"]));
  return root;
}

const ordersFile = (root: string) => join(root, "models", "shop", "orders.yaml");
const BASE = ["add-bridge", "--source", "shop", "--model", "orders", "--name", "tag", "--to", "tags", "--through", "order_tags", "--keys", "order_id=order_id", "--through-keys", "tag_id=tag_id"];

interface Issue {
  level: string;
  file: string;
  path: string;
  code: string;
  message: string;
}
async function issues(root: string): Promise<Issue[]> {
  return (await semlayer(root, ["validate", "--json"])).json<{ issues: Issue[] }>().issues;
}
const joinIssues = (all: Issue[]) => all.filter((i) => i.code.startsWith("join."));

const bridgeJoin = (through: Record<string, unknown>, status: "draft" | "approved" = "draft"): Join =>
  ({
    name: "tag",
    to: "tags",
    keys: [{ from: "order_id", to: "order_id" }],
    relationship: "one_to_many",
    through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], ...through },
    ...(status === "approved" ? ok : { status: "draft" }),
  }) as Join;

// Evidence check-join writes for the bridge of fixtures/semantics/bridge.sql (tests/check-join-bridge.test.ts measures it).
const EVIDENCE = {
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
  through: {
    model: "order_tags",
    keys: [{ from: "tag_id", to: "tag_id" }],
    fact_rows: 5,
    bridge_rows: 8,
    duplicate_rows: 1,
    rows_without_fact: 0,
    rows_without_target: 0,
    facts_unbridged: 1,
    facts_one_value: 2,
    facts_many_values: 2,
    max_values_per_fact: 3,
  },
};
const withEvidence = (j: Join, evidence: unknown = EVIDENCE): Join => ({ ...j, evidence }) as Join;

interface Refusal {
  error: string;
  code: string;
  next?: string;
}

describe("readback of a bridge join", () => {
  test("states the three models, both key pairs, the rule, that totals by tags can exceed the overall total, and the measured counts", async () => {
    const root = await project([withEvidence(bridgeJoin({ dedupe: "distinct_pairs" }))]);
    const r = await semlayer(root, ["readback", "--targets", "shop.orders.tag"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const line of [
      "- Links each row of orders to rows of tags through the bridge order_tags: orders.order_id = order_tags.order_id, then order_tags.tag_id = tags.tag_id.",
      "- An order can have several tags, or none; an order without one is kept, with the tags columns empty.",
      "- Dedupe rule: distinct_pairs. Each (order, tag) pair counts once, however many times order_tags lists it, so an order with several tags adds its whole figure to each of them.",
      "- Totals by tag can add up to more than the overall total: an order with several tags counts in full under each of them, while the overall total counts it once.",
      "- Of 5 orders (rows of orders), 2 have one tag, 2 have several (at most 3), and 1 has none, so a figure grouped by tag shows it under an empty tag.",
      "- order_tags has 8 rows: 1 repeats a pair already listed, and counts once; 0 name no row of orders and 0 no row of tags.",
      "join tag: orders.order_id = order_tags.order_id, then order_tags.tag_id = tags.tag_id (one_to_many through order_tags, dedupe distinct_pairs, left join)",
    ])
      expect(r.out).toContain(line);
    expect(existsSync(join(root, PENDING_DIR))).toBe(true);
  });

  test("equal_split and weight say how a figure is shared and that totals by tags then add up to the overall total", async () => {
    const split = await project([withEvidence(bridgeJoin({ dedupe: "equal_split" }))]);
    const s = await semlayer(split, ["readback", "--targets", "shop.orders.tag"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("- Dedupe rule: equal_split. An order with n tags gives each 1/n of its figure, so its shares add up to its figure once.");
    expect(s.out).toContain("- Totals by tag add up to the overall total of the orders that have a tag; without this rule they could add up to more than it");
    const weight = await project([withEvidence(bridgeJoin({ dedupe: "weight", weight: "share" }))]);
    const w = await semlayer(weight, ["readback", "--targets", "shop.orders.tag"]);
    expect(w.code).toBe(0);
    expect(w.out).toContain("- Dedupe rule: weight, by order_tags.share. An order gives each of its tags a share of its figure in proportion to order_tags.share");
  });

  test("with no bridge evidence it is refused with readback_blocked, naming the one check-join that measures it, and writes nothing", async () => {
    const root = await project([bridgeJoin({ dedupe: "distinct_pairs" })]);
    const r = await semlayer(root, ["readback", "--targets", "shop.orders.tag", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json<Refusal>()).toMatchObject({ code: "readback_blocked", next: "semlayer check-join --source shop --model orders --join tag" });
    expect(r.json<Refusal>().error).toContain("shop.orders.tag: it is a bridge join with no bridge evidence");
    expect(existsSync(join(root, PENDING_DIR))).toBe(false);
    // Evidence of a plain join, without through, is no bridge evidence either; evidence of another bridge is stale.
    const plain = await project([withEvidence(bridgeJoin({ dedupe: "distinct_pairs" }), { ...EVIDENCE, through: undefined })]);
    expect((await semlayer(plain, ["readback", "--targets", "shop.orders.tag", "--json"])).json<Refusal>().next).toBe("semlayer check-join --source shop --model orders --join tag");
    const stale = await project([withEvidence(bridgeJoin({ dedupe: "distinct_pairs" }), { ...EVIDENCE, through: { ...EVIDENCE.through, model: "other_tags" } })]);
    const st = await semlayer(stale, ["readback", "--targets", "shop.orders.tag", "--json"]);
    expect(st.json<Refusal>()).toMatchObject({ code: "readback_blocked", next: "semlayer check-join --source shop --model orders --join tag" });
    expect(st.json<Refusal>().error).toContain("its bridge evidence measured another bridge or other keys");
  });

  test("with no dedupe rule it is refused with readback_blocked, naming the semlayer apply whose set gives the rule; filled in, it reads back", async () => {
    const root = await project([withEvidence(bridgeJoin({}))]);
    const r = await semlayer(root, ["readback", "--targets", "shop.orders.tag", "--json"]);
    expect(r.code).toBe(1);
    const out = r.json<Refusal>();
    expect(out).toMatchObject({ code: "readback_blocked", next: "semlayer apply --file -" });
    expect(out.error).toContain("it is a bridge join with no dedupe rule");
    expect(out.error.match(/no dedupe rule/g)).toHaveLength(1);
    const input = JSON.parse(/standard input: (\{.*\})$/m.exec(out.error)![1]!) as { edits: string[][] };
    expect(input.edits).toEqual([["set", "shop.orders.tag", "through", '{"model":"order_tags","keys":[{"from":"tag_id","to":"tag_id"}],"dedupe":"<distinct_pairs, equal_split or weight, as the owner chose>"}']]);
    expect(existsSync(join(root, PENDING_DIR))).toBe(false);
    // The owner's answer in place of the placeholder gives the rule, and the readback then goes ahead.
    const file = join(root, "..", "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [input.edits[0]!.map((w) => w.replace("<distinct_pairs, equal_split or weight, as the owner chose>", "equal_split"))] }));
    expect((await semlayer(root, ["apply", "--file", file])).code).toBe(0);
    expect(readYaml<Model>(ordersFile(root)).joins![0]!.through).toEqual({ model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], dedupe: "equal_split" });
    expect((await semlayer(root, ["readback", "--targets", "shop.orders.tag"])).code).toBe(0);
    // A plain join of the same model is read back as before.
    const plainJoin = await project([{ name: "tag", to: "tags", keys: [{ from: "order_id", to: "tag_id" }], relationship: "many_to_one", status: "draft" } as Join]);
    expect((await semlayer(plainJoin, ["readback", "--targets", "shop.orders.tag"])).code).toBe(0);
  });
});

describe("semlayer apply", () => {
  test("an add-bridge entry writes the same YAML as the command", async () => {
    const root = await project();
    const file = join(root, "..", "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [[...BASE, "--dedupe", "distinct_pairs", "--description", "Tags an order carries."]] }));
    const r = await semlayer(root, ["apply", "--file", file, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(ordersFile(root), "utf8")).toBe(readFileSync(join(import.meta.dir, "fixtures", "bridge", "orders-with-tag.yaml"), "utf8"));
  });
});

describe("add-bridge", () => {
  test("writes a draft bridge join that equals the golden YAML and validates with no join.* issue and no one_to_many warning", async () => {
    const root = await project();
    const r = await semlayer(root, [...BASE, "--dedupe", "distinct_pairs", "--description", "Tags an order carries."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added draft bridge join tag from shop.orders to tags through order_tags");
    expect(r.out).toContain("Next: semlayer readback --targets shop.orders.tag");
    expect(readFileSync(ordersFile(root), "utf8")).toBe(readFileSync(join(import.meta.dir, "fixtures", "bridge", "orders-with-tag.yaml"), "utf8"));
    const all = await issues(root);
    expect(joinIssues(all)).toEqual([]);
    expect(all.map((i) => i.code)).not.toContain("model.join_one_to_many");
    expect(all.filter((i) => i.level === "error")).toEqual([]);
    // --json carries the join and the next command; running it again is refused, not repeated.
    const again = await semlayer(root, [...BASE, "--json"]);
    expect(again.code).toBe(1);
  });

  test("a weight and a draft with no rule are written, and the no-rule draft says what to ask the owner", async () => {
    const root = await project();
    const r = await semlayer(root, [...BASE, "--dedupe", "weight", "--weight", "share", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ join: Join; next: string }>().join.through).toEqual({ model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], dedupe: "weight", weight: "share" });
    const bare = await project();
    const n = await semlayer(bare, BASE);
    expect(n.code).toBe(0);
    expect(n.out).toContain("with no dedupe rule yet");
    expect(readYaml<Model>(ordersFile(bare)).joins![0]!.through!.dedupe).toBeUndefined();
  });

  test("each refusal is a UserError with a code and, where one exists, a next command, and writes nothing", async () => {
    const root = await project();
    const before = readFileSync(ordersFile(root), "utf8");
    const cases: [string[], string, string, string | undefined][] = [
      [["--through", "nope"], "No model \"nope\" in source shop", "user_error", "semlayer status"],
      [["--to", "nope"], "No model \"nope\" in source shop", "user_error", "semlayer status"],
      [["--through", "tags"], "The bridge must be a third model", "user_error", "semlayer status"],
      [["--through", "orders"], "The bridge must be a third model", "user_error", "semlayer status"],
      [["--keys", "order_id=missing"], "missing is not a column of public.order_tags", "user_error", "semlayer tables --source shop"],
      [["--through-keys", "tag_id=missing"], "missing is not a column of public.tags", "user_error", "semlayer tables --source shop"],
      [["--dedupe", "sometimes"], "--dedupe is distinct_pairs, equal_split, weight", "usage", "semlayer add-bridge --help"],
      [["--dedupe", "weight"], "--dedupe weight needs --weight", "usage", "semlayer add-bridge --help"],
      [["--dedupe", "equal_split", "--weight", "share"], "--weight goes only with --dedupe weight", "usage", "semlayer add-bridge --help"],
      [["--dedupe", "weight", "--weight", "note"], "note is text, not a number", "user_error", "semlayer tables --source shop"],
      [["--dedupe", "weight", "--weight", "gone"], "gone is not a column of public.order_tags", "user_error", "semlayer tables --source shop"],
      [["--name", "revenue"], 'already has a measure "revenue"', "user_error", "semlayer add-bridge --help"],
      [["--name", "Bad Name"], "is not a name", "usage", "semlayer add-bridge --help"],
      [["--keys", "order_id"], "--keys takes <column>=<column> pairs", "usage", "semlayer add-bridge --help"],
    ];
    const withFlags = (extra: string[]) => {
      const args = [...BASE];
      for (let i = 0; i < extra.length; i += 2) {
        const at = args.indexOf(extra[i]!);
        if (at >= 0) args[at + 1] = extra[i + 1]!;
        else args.push(extra[i]!, extra[i + 1]!);
      }
      return args;
    };
    for (const [extra, message, code, next] of cases) {
      const r = await semlayer(root, [...withFlags(extra), "--json"]);
      expect(r.code).toBe(1);
      expect(r.json<{ error: string; code: string; next?: string }>()).toMatchObject({ error: expect.stringContaining(message), code, next });
      expect(readFileSync(ordersFile(root), "utf8")).toBe(before);
    }
    // A missing flag is usage too.
    const missing = await semlayer(root, ["add-bridge", "--source", "shop", "--model", "orders", "--json"]);
    expect(missing.json()).toMatchObject({ code: "usage", next: "semlayer add-bridge --help" });
  });

  test("a column in ignored_columns is refused, naming ignore-column --remove", async () => {
    const root = await project();
    const bridge = readYaml<Model>(join(root, "models", "shop", "order_tags.yaml"));
    bridge.ignored_columns = ["share"];
    writeYaml(join(root, "models", "shop", "order_tags.yaml"), bridge);
    const r = await semlayer(root, [...BASE, "--dedupe", "weight", "--weight", "share"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ignore-column");
  });
});

describe("validation", () => {
  test("join.through_bridge_unknown fires for a bridge that is no model, the model itself or the target", async () => {
    for (const bridge of ["nope", "orders", "tags"]) {
      const root = await project([bridgeJoin({ model: bridge, dedupe: "distinct_pairs" })]);
      expect(joinIssues(await issues(root)).map((i) => [i.code, i.level, i.path])).toEqual([["join.through_bridge_unknown", "error", "joins[0].through.model"]]);
    }
  });

  test("join.through_columns_missing fires for a bridge key, a target key and a weight column the snapshot lacks", async () => {
    const root = await project([bridgeJoin({ keys: [{ from: "tag_ref", to: "tag_id" }], dedupe: "distinct_pairs" })]);
    expect(joinIssues(await issues(root)).map((i) => [i.code, i.path])).toEqual([["join.through_columns_missing", "joins[0].through.keys[0].from"]]);
    const target = await project([bridgeJoin({ keys: [{ from: "tag_id", to: "tag_ref" }], dedupe: "distinct_pairs" })]);
    expect(joinIssues(await issues(target)).map((i) => [i.code, i.path])).toEqual([["join.through_columns_missing", "joins[0].through.keys[0].to"]]);
    const weight = await project([bridgeJoin({ dedupe: "weight", weight: "gone" })]);
    expect(joinIssues(await issues(weight)).map((i) => [i.code, i.path])).toEqual([["join.through_columns_missing", "joins[0].through.weight"]]);
    // The key from the model to the bridge is read against the bridge's table, not the target's.
    const first = await project([{ ...bridgeJoin({ dedupe: "distinct_pairs" }), keys: [{ from: "order_id", to: "tag_id" }] }]);
    expect((await issues(first)).filter((i) => i.code === "ref.unknown_column")).toEqual([]);
    const bad = await project([{ ...bridgeJoin({ dedupe: "distinct_pairs" }), keys: [{ from: "order_id", to: "tag_name" }] }]);
    expect((await issues(bad)).filter((i) => i.code === "ref.unknown_column").map((i) => i.path)).toEqual(["joins[0].keys[0].to"]);
  });

  test("join.through_dedupe_missing is an error on an approved bridge join, and the schema rejects it too; a draft is fine", async () => {
    const draft = await project([bridgeJoin({})]);
    expect(joinIssues(await issues(draft))).toEqual([]);
    const approved = await project([bridgeJoin({}, "approved")]);
    const all = await issues(approved);
    expect(joinIssues(all).map((i) => [i.code, i.level, i.path])).toEqual([["join.through_dedupe_missing", "error", "joins[0].through.dedupe"]]);
    expect(all.some((i) => i.code.startsWith("schema.") && i.file.endsWith("orders.yaml") && i.path.includes("through"))).toBe(true);
    const withRule = await project([bridgeJoin({ dedupe: "equal_split" }, "approved")]);
    expect(joinIssues(await issues(withRule))).toEqual([]);
  });

  test("join.through_weight_invalid fires for a weight without dedupe weight, dedupe weight without one, and a text column", async () => {
    const stray = await project([bridgeJoin({ dedupe: "distinct_pairs", weight: "share" })]);
    expect(joinIssues(await issues(stray)).map((i) => i.code)).toEqual(["join.through_weight_invalid"]);
    const none = await project([bridgeJoin({ dedupe: "weight" })]);
    expect(joinIssues(await issues(none)).map((i) => i.code)).toEqual(["join.through_weight_invalid"]);
    const text = await project([bridgeJoin({ dedupe: "weight", weight: "note" })]);
    expect(joinIssues(await issues(text)).map((i) => [i.code, i.level])).toEqual([["join.through_weight_invalid", "error"]]);
    const fine = await project([bridgeJoin({ dedupe: "weight", weight: "share" })]);
    expect(joinIssues(await issues(fine))).toEqual([]);
  });

  test("join.through_relationship_invalid fires for a bridge join that is not one_to_many, and the schema rejects it too", async () => {
    const root = await project([{ ...bridgeJoin({ dedupe: "distinct_pairs" }), relationship: "many_to_one" }]);
    const all = await issues(root);
    expect(joinIssues(all).map((i) => [i.code, i.level, i.path])).toEqual([["join.through_relationship_invalid", "error", "joins[0].relationship"]]);
    expect(all.some((i) => i.code.startsWith("schema.") && i.file.endsWith("orders.yaml") && i.path.includes("relationship"))).toBe(true);
  });

  test("the codes are registered with a meaning and the level they fire at", () => {
    for (const code of ["join.through_bridge_unknown", "join.through_columns_missing", "join.through_dedupe_missing", "join.through_relationship_invalid", "join.through_weight_invalid"]) {
      expect(issueCodes().get(code)).toMatchObject({ level: "error", file: "join.ts" });
    }
  });
});

describe("approval hash", () => {
  test("changes when the dedupe rule, the weight, the bridge or its keys change, and is unchanged for a join with no through", () => {
    const hash = (through: Record<string, unknown>) => itemHash("join", bridgeJoin(through) as unknown as Record<string, unknown>, { source: "shop", model: { model: "orders", table: "orders" } });
    const base = hash({ dedupe: "distinct_pairs" });
    expect(hash({ dedupe: "equal_split" })).not.toBe(base);
    expect(hash({})).not.toBe(base);
    expect(hash({ dedupe: "weight", weight: "share" })).not.toBe(hash({ dedupe: "weight", weight: "note" }));
    expect(hash({ dedupe: "distinct_pairs", model: "other_tags" })).not.toBe(base);
    expect(hash({ dedupe: "distinct_pairs", keys: [{ from: "tag_id", to: "tag_name" }] })).not.toBe(base);
    expect(hash({ dedupe: "distinct_pairs", keys: [{ to: "tag_id", from: "tag_id" }] })).toBe(base);
    const plain = { name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one" };
    expect(itemHash("join", plain, { source: "shop", model: { model: "orders", table: "orders" } })).toBe(itemHash("join", { ...plain, through: undefined }, { source: "shop", model: { model: "orders", table: "orders" } }));
  });

  test("an approved bridge join edited after its approval is an error: approval.hash_changed", async () => {
    const draft = bridgeJoin({ dedupe: "distinct_pairs" }, "approved") as Join & { approved_hash?: string };
    const root = await project([draft]);
    const m = readYaml<Model>(ordersFile(root));
    const j = m.joins![0] as Join & { approved_hash?: string };
    j.approved_hash = itemHash("join", j as unknown as Record<string, unknown>, { source: "shop", model: m as unknown as Record<string, unknown> });
    writeYaml(ordersFile(root), m);
    expect((await issues(root)).filter((i) => i.code === "approval.hash_changed")).toEqual([]);
    j.through!.dedupe = "equal_split";
    writeYaml(ordersFile(root), m);
    expect((await issues(root)).filter((i) => i.code === "approval.hash_changed").map((i) => i.path)).toEqual(["joins[0]"]);
  });
});

describe("schema pairs", () => {
  // sales.orders, sales.channels and crm.regions: a hop from the bridge to the target crosses schemas.
  const TWO = [
    table("orders", [col("order_id", "integer"), col("customer_name", "text"), col("amount_cents", "integer"), col("channel_id", "integer")], "sales"),
    table("channels", [col("channel_id", "integer"), col("region_id", "integer")], "sales"),
    table("regions", [col("region_id", "integer"), col("region_name", "text")], "crm"),
  ];
  const PAIR = { from: "sales", to: "crm", status: "draft", keys: [{ from: "channels.region_id", to: "regions.region_id" }] };
  const sourceWith = (pair?: Record<string, unknown>) =>
    `source: shop\ndialect: postgres\nconnection:\n  env: SHOP_URL\nintake:\n  schemas: [sales, crm]\n  primary: sales\n${pair ? `cross_schema:\n  - from: ${pair.from}\n    to: ${pair.to}\n    status: ${pair.status}\n${pair.status === "approved" ? `    approved_by: Dana\n    approved_at: 2026-01-15\n    approved_hash: ${itemHash("schema-pair", pair)}\n` : ""}    keys:\n      - from: channels.region_id\n        to: regions.region_id\n` : ""}`;
  const approvedPair = { ...PAIR, status: "approved", approved_by: "Dana", approved_at: "2026-01-15" };

  async function twoSchemas(pair?: Record<string, unknown>): Promise<string> {
    const root = await project(undefined, { tables: TWO, source: sourceWith(pair) });
    const dir = join(root, "models", "shop");
    const at = (name: string, schema: string, tableName: string, dims: string[]): Model => ({ ...model(name, tableName, dims), table: `${schema}.${tableName}` }) as Model;
    writeYaml(join(dir, "orders.yaml"), { ...at("orders", "sales", "orders", ["order_id", "customer_name"]), joins: [{ name: "region", to: "regions", keys: [{ from: "channel_id", to: "channel_id" }], relationship: "one_to_many", through: { model: "channels", keys: [{ from: "region_id", to: "region_id" }], dedupe: "distinct_pairs" }, ...ok }] });
    writeYaml(join(dir, "channels.yaml"), at("channels", "sales", "channels", ["channel_id", "region_id"]));
    writeYaml(join(dir, "regions.yaml"), at("regions", "crm", "regions", ["region_id", "region_name"]));
    return root;
  }

  test("a hop across schemas is a join of its own: undeclared it errors or warns, and an approved pair declaring its keys allows it", async () => {
    const none = await twoSchemas();
    const hit = (await issues(none)).filter((i) => i.code === "scope.cross_schema_undeclared");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message).toContain("joins sales.channels to crm.regions across schemas");
    expect(hit[0]!.path).toBe("joins[0]");
    const allowed = await twoSchemas(approvedPair);
    const after = await issues(allowed);
    expect(after.filter((i) => i.code === "scope.cross_schema_undeclared")).toEqual([]);
    expect(after.filter((i) => i.code === "scope.pair_unused")).toEqual([]);
    const draftPair = await twoSchemas(PAIR);
    expect((await issues(draftPair)).filter((i) => i.code === "scope.cross_schema_undeclared")).toHaveLength(1);
  });

  test("add-bridge refuses a hop across an undeclared pair with scope.cross_schema_undeclared and the command that records it", async () => {
    const root = await twoSchemas();
    const orders = readYaml<Model>(ordersFile(root));
    delete (orders as { joins?: unknown }).joins;
    writeYaml(ordersFile(root), orders);
    const args = ["add-bridge", "--source", "shop", "--model", "orders", "--name", "region", "--to", "regions", "--through", "channels", "--keys", "channel_id=channel_id", "--through-keys", "region_id=region_id", "--json"];
    const r = await semlayer(root, args);
    expect(r.code).toBe(1);
    expect(r.json<{ code: string; next: string; error: string }>()).toMatchObject({
      code: "scope.cross_schema_undeclared",
      next: "semlayer add-cross-schema --source shop --from sales --to crm --keys channels.region_id=regions.region_id",
    });
    expect(r.json<{ error: string }>().error).toContain("(channels to regions)");
    // Once the pair is approved the same command adds the join.
    writeFileSync(join(root, "sources", "shop.yaml"), sourceWith(approvedPair));
    expect((await semlayer(root, args.slice(0, -1))).code).toBe(0);
  });
});

describe("the compiler", () => {
  test("a request on a field the model reaches only through a bridge join compiles through the deduped bridge", async () => {
    const root = await project([bridgeJoin({ dedupe: "distinct_pairs" })]);
    const request = JSON.stringify({ source: "shop", measures: ["orders.revenue"], dimensions: ["tags.tag_name"] });
    const r = await semlayer(root, ["sql", "--request", request, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ sql: string; joins: { alias: string; through?: string }[] }>();
    expect(out.sql).toContain('group by "orders.tag bridge"."order_id", "orders.tag bridge"."tag_id"');
    expect(out.joins.map((j) => [j.alias, j.through])).toEqual([
      ["orders.tag bridge", "bridge"],
      ["orders.tag", "target"],
    ]);
    expect(parse(readFileSync(ordersFile(root), "utf8"))).toBeDefined();
  });
});

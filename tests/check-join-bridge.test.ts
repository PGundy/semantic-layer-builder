// check-join on a bridge join (spec: Bridges and multi-fact requests): it measures the hop from the
// model to the bridge and then the bridge itself, records the bridge's counts under evidence.through,
// and refuses or skips, with a code, a join whose bridge or columns are wrong or whose hop crosses an
// undeclared schema pair. The counts are checked against numbers worked out by hand from
// fixtures/semantics/bridge.sql, on DuckDB and, with PG_URL, on PostgreSQL.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import type { ThroughEvidence } from "../skills/semantic-layer/scripts/lib/sql/through-check.ts";
import type { JoinEvidence, Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { assertLocalPg, duckdbSource, FIXED_NOW, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "..", "fixtures", "semantics", "bridge.sql"), "utf8");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

// Worked out by hand from bridge.sql. Orders 1 and 2 have two and three tags, order 3 one, order 5 one
// tag listed twice (one repeated row), order 4 none: 5 orders, 8 bridge rows, 4 orders with a bridge row
// and at most 3 bridge rows (order 2) for one order.
const FIRST_HOP = {
  checked_at: FIXED_NOW,
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
};
const BRIDGE: ThroughEvidence = {
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
};

const ok = { status: "approved", approved_by: "Dana", approved_at: "2026-01-10" };
const bridgeJoin = (through: Record<string, unknown> = {}) => ({
  name: "tag",
  to: "tags",
  keys: [{ from: "order_id", to: "order_id" }],
  relationship: "one_to_many",
  through: { model: "order_tags", keys: [{ from: "tag_id", to: "tag_id" }], dedupe: "distinct_pairs", ...through },
  status: "draft",
});
const model = (name: string, table: string, pk: string[], joins?: unknown[]) => ({ model: name, source: "shop", table, primary_key: pk, grain: `One row per ${name}.`, ...ok, dimensions: [], measures: [], ...(joins ? { joins } : {}) });

// The three models over `schema`, the orders model holding `joins`.
function models(root: string, schema: string, joins: unknown[]): string {
  const dir = join(root, "models", "shop");
  mkdirSync(dir, { recursive: true });
  writeYaml(join(dir, "orders.yaml"), model("orders", `${schema}.orders`, ["order_id"], joins));
  writeYaml(join(dir, "tags.yaml"), model("tags", `${schema}.tags`, ["tag_id"]));
  writeYaml(join(dir, "order_tags.yaml"), model("order_tags", `${schema}.order_tags`, ["order_id", "tag_id"]));
  return join(dir, "orders.yaml");
}

// A DuckDB project over bridge.sql and the statements after it, with a snapshot of the three tables.
async function duckProject(joins: unknown[] = [bridgeJoin()], extra: string[] = []): Promise<{ root: string; file: string }> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "shop", [FIXTURE, ...extra]);
  const columns: Record<string, [string, string][]> = {
    orders: [["order_id", "INTEGER"], ["customer_name", "VARCHAR"], ["amount_cents", "INTEGER"]],
    tags: [["tag_id", "INTEGER"], ["tag_name", "VARCHAR"]],
    order_tags: [["order_id", "INTEGER"], ["tag_id", "INTEGER"], ["share", "INTEGER"]],
  };
  mkdirSync(join(t.root, "snapshots"), { recursive: true });
  writeFileSync(
    join(t.root, "snapshots", "shop.json"),
    JSON.stringify({
      snapshot_version: 1,
      source: "shop",
      dialect: "duckdb",
      captured_at: FIXED_NOW,
      method: "live",
      tables: Object.entries(columns).map(([name, cols]) => ({ schema: "main", name, kind: "table", columns: cols.map(([n, type]) => ({ name: n, type })) })),
    }),
  );
  return { root: t.root, file: models(t.root, "main", joins) };
}

interface CheckOut {
  checks: { model: string; join: string; evidence: JoinEvidence | null; findings: { level: string; message: string }[] }[];
  skipped: { model: string; join: string; reason: string }[];
}
interface Refusal {
  error: string;
  code: string;
  next?: string;
}
const CHECK = ["check-join", "--source", "shop", "--model", "orders", "--join", "tag"];

describe("check-join on a bridge join, on duckdb", () => {
  test("measures the hop to the bridge and the bridge, and writes the counts worked out by hand under evidence.through", async () => {
    const { root, file } = await duckProject();
    const r = await semlayer(root, [...CHECK, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const c = r.json<CheckOut>().checks[0]!;
    expect(c.evidence).toEqual({ ...FIRST_HOP, through: BRIDGE } as unknown as JoinEvidence);
    expect(readYaml<Model>(file).joins![0]!.evidence).toEqual({ ...FIRST_HOP, through: BRIDGE } as unknown as JoinEvidence);
    // Counts only: no name, key or other value of a table is in the evidence or the findings.
    const said = JSON.stringify(c);
    for (const value of ["Ada Example", "gift", "wholesale", "unused"]) expect(said).not.toContain(value);
    expect(c.findings.map((f) => f.level)).toEqual(["warn", "info"]);
    expect(c.findings[0]!.message).toBe(
      "1 of 5 rows of orders have no tags in order_tags, so a figure grouped by tag shows it under an empty tag; ask the owner whether that is expected, and say why in the join's description.",
    );
    // The written evidence validates against the schema, and the order without a tag is a warning.
    const v = (await semlayer(root, ["validate", "--json"])).json<{ issues: { level: string; code: string; path: string }[] }>().issues;
    expect(v.filter((i) => i.code.startsWith("schema."))).toEqual([]);
    expect(v.filter((i) => i.code === "join.through_facts_unbridged").map((i) => [i.level, i.path])).toEqual([["warning", "joins[0].evidence.through.facts_unbridged"]]);
  });

  test("the plain report names the bridge and its counts; --emit-sql plans both queries; --all measures the bridge too", async () => {
    const { root } = await duckProject();
    const r = await semlayer(root, [...CHECK, "--no-write"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("orders.tag -> tags through order_tags");
    expect(r.out).toContain("  Of 5 orders (rows of orders), 2 have one tag, 2 have several (at most 3), and 1 has none, so a figure grouped by tag shows it under an empty tag.");
    expect(r.out).toContain("  order_tags has 8 rows: 1 repeats a pair already listed, and counts once; 0 name no row of orders and 0 no row of tags.");
    const plan = (await semlayer(root, [...CHECK, "--emit-sql"])).json<{ queries: { id: string; sql: string }[] }>();
    expect(plan.queries.map((q) => q.id)).toEqual(["join:orders.tag", "through:orders.tag"]);
    const all = await semlayer(root, ["check-join", "--source", "shop", "--all", "--json"]);
    expect(all.json<CheckOut>().checks.map((c) => c.evidence?.through)).toEqual([BRIDGE]);
  });

  test("bridge rows that name no order or no tag are counted, and a check-join of them is a warning", async () => {
    // Order 6 and tag 9 do not exist; order 1's second row of tag 2 repeats a pair.
    const { root } = await duckProject([bridgeJoin()], ["insert into order_tags values (6, 1, 1), (1, 9, 1), (1, 2, 1), (4, 9, 1)"]);
    const c = (await semlayer(root, [...CHECK, "--json"])).json<CheckOut>().checks[0]!;
    // Tag 9 matches no tag, so it is no value (order 4 stays unbridged): order 1 keeps its two tags and the pair counts are unchanged.
    expect(c.evidence!.through).toEqual({ ...BRIDGE, bridge_rows: 12, duplicate_rows: 2, rows_without_fact: 1, rows_without_target: 2 });
    expect(c.findings.map((f) => f.message)).toContain("1 order_tags rows name no orders row and 2 name no tags row; ask the owner whether order_tags keeps rows the other tables have lost.");
  });

  test("a bridge that is no model, or a bridge or target column the table lacks, is refused with a join.* code and a next command, and skipped under --all", async () => {
    const cases: [Record<string, unknown>, string, string, string][] = [
      [{ model: "nope" }, "join.through_bridge_unknown", "semlayer status", 'goes through "nope", which is not a third model'],
      [{ model: "tags" }, "join.through_bridge_unknown", "semlayer status", 'goes through "tags", which is not a third model'],
      [{ keys: [{ from: "tag_ref", to: "tag_id" }] }, "join.through_columns_missing", "semlayer tables --source shop", 'The bridge key column "tag_ref" is not a column of main.order_tags'],
      [{ keys: [{ from: "tag_id", to: "tag_ref" }] }, "join.through_columns_missing", "semlayer tables --source shop", 'The target key column "tag_ref" is not a column of main.tags'],
    ];
    for (const [through, code, next, message] of cases) {
      const { root, file } = await duckProject([bridgeJoin(through)]);
      const before = readFileSync(file, "utf8");
      const r = await semlayer(root, [...CHECK, "--json"]);
      expect(r.code).toBe(1);
      expect(r.json<Refusal>()).toMatchObject({ code, next, error: expect.stringContaining(message) });
      const all = (await semlayer(root, ["check-join", "--source", "shop", "--all", "--json"])).json<CheckOut>();
      expect(all.skipped.map((s) => [s.join, s.reason.includes(message)])).toEqual([["tag", true]]);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    // The key from orders to the bridge is read against the bridge's table, not the target's.
    const { root } = await duckProject([{ ...bridgeJoin(), keys: [{ from: "order_id", to: "tag_name" }] }]);
    expect((await semlayer(root, [...CHECK, "--json"])).json<Refusal>()).toMatchObject({ code: "join.through_columns_missing", error: expect.stringContaining('"tag_name" is not a column of main.order_tags') });
  });

  test("a hop across an undeclared schema pair is refused with scope.cross_schema_undeclared, and skipped with that reason under --all", async () => {
    const { root } = await duckProject();
    // The snapshot puts tags in another schema, so the hop from the bridge to the target crosses schemas.
    const snap = JSON.parse(readFileSync(join(root, "snapshots", "shop.json"), "utf8"));
    snap.tables.find((t: { name: string }) => t.name === "tags").schema = "crm";
    writeFileSync(join(root, "snapshots", "shop.json"), JSON.stringify(snap));
    const tags = readYaml<Model>(join(root, "models", "shop", "tags.yaml"));
    writeYaml(join(root, "models", "shop", "tags.yaml"), { ...tags, table: "crm.tags" });
    const r = await semlayer(root, [...CHECK, "--json"]);
    expect(r.code).toBe(1);
    expect(r.json<Refusal>()).toMatchObject({ code: "scope.cross_schema_undeclared", next: "semlayer add-cross-schema --source shop --from main --to crm --keys order_tags.tag_id=tags.tag_id" });
    expect(r.json<Refusal>().error).toContain('Join "tag" on model "orders" (order_tags to tags) joins main.order_tags to crm.tags across schemas');
    const all = (await semlayer(root, ["check-join", "--source", "shop", "--all", "--json"])).json<CheckOut>();
    expect(all.skipped).toHaveLength(1);
    expect(all.skipped[0]!.reason).toContain("across schemas");
  });
});

describe("check-join on a bridge join, on postgres", () => {
  const schema = uniqueSchema("t_bridge_check");
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!PG_URL) return;
    assertLocalPg(PG_URL);
    pg = new SQL({ url: PG_URL, max: 1 });
    await pg.unsafe(`create schema ${schema}; set search_path to ${schema}; ${FIXTURE}; reset search_path;`);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.close();
  });

  test.skipIf(!PG_URL)("writes the same counts worked out by hand", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "BRIDGE_PG_URL" } });
    const file = models(t.root, schema, [bridgeJoin()]);
    const r = await semlayer(t.root, [...CHECK, "--json"], { BRIDGE_PG_URL: PG_URL });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json<CheckOut>().checks[0]!.evidence).toEqual({ ...FIRST_HOP, through: BRIDGE } as unknown as JoinEvidence);
    expect(readYaml<Model>(file).joins![0]!.evidence!.through).toEqual(BRIDGE);
  });

  test.skipIf(!PG_URL)("bridge rows naming a missing order or tag are no value for a fact", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "shop.yaml"), { source: "shop", dialect: "postgres", connection: { env: "BRIDGE_PG_URL" } });
    models(t.root, schema, [bridgeJoin()]);
    // Order 4 has only a row for tag 9, which exists nowhere: it stays unbridged. Order 6 does not exist.
    await pg!.unsafe(`insert into ${schema}.order_tags values (4, 9, 1), (6, 1, 1)`);
    try {
      const r = await semlayer(t.root, [...CHECK, "--json"], { BRIDGE_PG_URL: PG_URL });
      expect(r.code).toBe(0);
      expect(r.json<CheckOut>().checks[0]!.evidence!.through).toEqual({ ...BRIDGE, bridge_rows: 10, rows_without_fact: 1, rows_without_target: 1 });
    } finally {
      await pg!.unsafe(`delete from ${schema}.order_tags where (order_id, tag_id) in ((4, 9), (6, 1))`);
    }
  });
});

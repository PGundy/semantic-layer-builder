import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffItems, itemMap } from "../skills/semantic-layer/scripts/lib/changeset.ts";
import { appendEntry } from "../skills/semantic-layer/scripts/lib/release.ts";
import { parseYamlText, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { releaseFixture } from "./release-fixture.ts";
import { semlayer } from "./helpers.ts";

// semlayer change status (spec: Iterating a layer, Change status), on a copy of the example layer
// released at 1.0.

interface Status {
  released: boolean;
  version: string | null;
  added: string[];
  changed: { ref: string; state: string; affected_goldens: string[] }[];
  removed: string[];
  drift: unknown;
  next: string;
}

// Records the layer as it stands as release 1.0, the way semlayer change close will.
function release(root: string): void {
  appendEntry(root, {
    version: "1.0",
    date: "2026-02-03",
    note: "First release.",
    items: Object.fromEntries([...itemMap(root)].map(([ref, v]) => [ref, v.hash])),
    goldens: {},
    added: [],
    changed: [],
    removed: [],
    goldens_moved: [],
  });
}

const status = async (root: string) => (await semlayer(root, ["change", "status", "--json"])).json<Status>();

describe("change status", () => {
  test("with no edits it lists nothing and exits 0", async () => {
    const root = releaseFixture();
    release(root);
    const r = await semlayer(root, ["change", "status", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<Status>()).toMatchObject({ released: true, version: "1.0", added: [], changed: [], removed: [] });
    const plain = await semlayer(root, ["change", "status"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("No changes since release 1.0");
  });

  test("an edited measure is changed and draft, with the goldens that read it; a new metric is added; a removed field is removed", async () => {
    const root = releaseFixture();
    release(root);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "filter", "status = 'completed'"])).code).toBe(0);
    expect((await semlayer(root, ["add-metric", "--name", "revenue_per_item", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count"])).code).toBe(0);
    const rm = await semlayer(root, ["remove-field", "warehouse.regions.timezone", "--keep-column", "--force"]);
    expect(rm.err).toBe("");
    expect(rm.code).toBe(0);
    const s = await status(root);
    const revenue = s.changed.find((c) => c.ref === "warehouse.orders.revenue")!;
    expect(revenue.state).toBe("draft");
    // revenue_2025 requests it; net_revenue_2025 reads it through the metric net_revenue.
    expect(revenue.affected_goldens).toContain("revenue_2025");
    expect(revenue.affected_goldens).toContain("net_revenue_2025");
    expect(s.added).toContain("metric:revenue_per_item");
    expect(s.removed).toContain("warehouse.regions.timezone");
    expect(s.next).toContain("semlayer readback --targets");
    const plain = await semlayer(root, ["change", "status"]);
    expect(plain.out).toContain("warehouse.orders.revenue: draft");
    expect(plain.out).toContain("read by goldens");
  });

  test("an edit to a segment's filter shows the measures that name it as changed", async () => {
    const root = releaseFixture();
    const orders = join(root, "models", "warehouse", "orders.yaml");
    const doc = parseYamlText(readFileSync(orders, "utf8"), "orders.yaml") as { segments?: unknown[]; measures: { name: string; segments?: string[] }[] };
    doc.segments = [{ name: "sales", filter: "status in ('completed', 'shipped')" }];
    doc.measures.find((m) => m.name === "order_count")!.segments = ["sales"];
    writeYaml(orders, doc);
    release(root);
    expect((await status(root)).changed).toEqual([]);
    doc.segments = [{ name: "sales", filter: "status = 'completed'" }];
    writeYaml(orders, doc);
    const s = await status(root);
    expect(s.changed.map((c) => c.ref)).toEqual(["warehouse.orders.order_count"]);
    expect(s.changed[0]!.affected_goldens).toContain("revenue_2025");
  });

  test("an edited join lists the goldens that read the models on either side of it", async () => {
    const root = releaseFixture();
    release(root);
    expect((await semlayer(root, ["set", "warehouse.orders.customer", "type", "inner"])).code).toBe(0);
    const s = await status(root);
    const join = s.changed.find((c) => c.ref === "warehouse.orders.customer")!;
    expect(join).toBeDefined();
    expect(join.affected_goldens).toContain("revenue_2025");
  });

  test("a cross-schema declaration edit appears as changed", async () => {
    const root = releaseFixture();
    const file = join(root, "sources", "warehouse.yaml");
    const pair = (column: string) => `\ncross_schema:\n  - from: sales\n    to: crm\n    status: draft\n    keys:\n      - { from: orders.${column}, to: customers.customer_id }\n`;
    const base = readFileSync(file, "utf8");
    writeFileSync(file, base + pair("customer_id"));
    release(root);
    expect((await status(root)).changed).toEqual([]);
    writeFileSync(file, base + pair("buyer_id"));
    const s = await status(root);
    expect(s.changed.map((c) => c.ref)).toEqual(["schema-pair:warehouse:sales:crm"]);
  });

  test("a primary schema set after the release is added", async () => {
    const root = releaseFixture();
    release(root);
    const file = join(root, "sources", "warehouse.yaml");
    const doc = parseYamlText(readFileSync(file, "utf8"), "warehouse.yaml") as { intake?: Record<string, unknown> };
    doc.intake = { ...doc.intake, primary: "sales" };
    writeYaml(file, doc);
    expect((await status(root)).added).toEqual(["primary:warehouse"]);
  });

  test("with no changelog it exits 0 and names the first release, under --json too", async () => {
    const root = releaseFixture();
    const r = await semlayer(root, ["change", "status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("semlayer change close --version 1.0");
    const j = await semlayer(root, ["change", "status", "--json"]);
    expect(j.code).toBe(0);
    expect(j.json<Status>()).toMatchObject({ released: false, version: null, next: "semlayer change close --version 1.0" });
  });

  test("a malformed changelog and a bad subcommand are refused with a code and a next command", async () => {
    const root = releaseFixture();
    writeFileSync(join(root, "changelog.yaml"), "version: 1\nentries: nope\n");
    const bad = await semlayer(root, ["change", "status", "--json"]);
    expect(bad.code).toBe(1);
    expect(bad.json<{ error: string; code: string; next: string }>()).toMatchObject({ code: "user_error", next: "semlayer validate" });
    const sub = await semlayer(releaseFixture(), ["change", "frobnicate", "--json"]);
    expect(sub.code).toBe(1);
    expect(sub.json<{ next: string }>().next).toBe("semlayer change status");
  });

  test("it quotes the drift record when there is one", async () => {
    const root = releaseFixture();
    release(root);
    mkdirSync(join(root, ".semlayer"), { recursive: true });
    const record = {
      version: 1,
      sources: [{ source: "warehouse", at: "2026-01-15T12:00:00.000Z", diff: { tables_added: [], tables_removed: [], columns: [{ table: "acme.fct_orders", added: [], removed: [], retyped: [{ name: "amount_cents", from: "integer", to: "numeric(12,2)" }] }] }, retyped: [{ table: "acme.fct_orders", column: "amount_cents", from: "integer", to: "numeric(12,2)", at: "2026-01-15T12:00:00.000Z", reads: [{ ref: "warehouse.orders.revenue", hash: `sha256:${"a".repeat(64)}`, yes: null }] }] }],
    };
    writeFileSync(join(root, ".semlayer", "drift.json"), JSON.stringify(record));
    expect((await status(root)).drift).toEqual(record);
    const plain = await semlayer(root, ["change", "status"]);
    expect(plain.out).toContain("acme.fct_orders.amount_cents retyped integer -> numeric(12,2), read by warehouse.orders.revenue");
  });

  test("the output holds refs, hashes and golden names, never a recorded golden row", async () => {
    const root = releaseFixture();
    appendEntry(root, {
      version: "1.0",
      date: "2026-02-03",
      note: "First release.",
      items: Object.fromEntries([...itemMap(root)].map(([ref, v]) => [ref, v.hash])),
      goldens: { revenue_2025: [{ revenue: 987654321.12 }] },
      added: [],
      changed: [],
      removed: [],
      goldens_moved: [],
    });
    await semlayer(root, ["set", "warehouse.orders.revenue", "filter", "status = 'completed'"]);
    for (const args of [["change", "status"], ["change", "status", "--json"]]) expect((await semlayer(root, args)).out).not.toContain("987654321");
  });
});

describe("diffItems", () => {
  test("separates added, changed and removed, sorted, and marks a changed item by its approval", () => {
    const now = new Map([
      ["b", { hash: "sha256:2", approved: true }],
      ["a", { hash: "sha256:9", approved: false }],
      ["c", { hash: "sha256:3", approved: true }],
    ]);
    expect(diffItems({ a: "sha256:1", b: "sha256:2", z: "sha256:4" }, now)).toEqual({
      added: ["c"],
      changed: [{ ref: "a", state: "draft", affected_goldens: [] }],
      removed: ["z"],
    });
  });
});

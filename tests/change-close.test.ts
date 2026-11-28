import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { itemMap } from "../skills/semantic-layer/scripts/lib/changeset.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { PROTECTED_VALUE } from "../skills/semantic-layer/scripts/lib/output.ts";
import { appendEntry, movedCells, readChangelog } from "../skills/semantic-layer/scripts/lib/release.ts";
import type { Golden } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { reapprove, recordReply, semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// semlayer change close (spec: Iterating a layer, Closing a round), on a copy of the example layer. The lake
// source is DuckDB over the Parquet files of fixtures/acme/data, so its goldens rerun; the warehouse
// source is Postgres with WAREHOUSE_URL unset, so its goldens cannot be queried here.

const DATA = resolve(import.meta.dir, "..", "fixtures", "acme", "data");
const START = ["change", "start", "--note", "Count spend twice", "--by", "Dana Ruiz"];
const SPEND_GOLDENS = ["spend_2025", "spend_by_channel_2025"];

interface Closed {
  closed: boolean;
  version: string;
  items: number;
  changed: string[];
  goldens_moved: { golden: string; before: number; after: number; changed: number }[];
  not_rerun: { golden: string; source: string; reason: string }[];
  drafts_left_out: string[];
  added: string[];
  next: string;
}
interface Refusal {
  error: string;
  code: string;
  next: string;
}

// The example layer keeps one field the owner deferred as a draft, which a release leaves out.
const DEFERRED = "warehouse.products.launched_on";

// The fixture with the lake's views read from absolute paths, so its DuckDB source runs from the copy.
function committed(): string {
  const root = releaseFixture();
  const lake = join(root, "sources", "lake.yaml");
  writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("../../../fixtures/acme/data", DATA));
  return root;
}

// The fixture with its deferred field approved on the owner's yes, so every item is approved.
async function fixture(): Promise<string> {
  const root = committed();
  await reapprove(root, [DEFERRED]);
  return root;
}

// The bytes of the files a close writes, to show a refusal leaves them as they were.
const FILES = ["semantic.yaml", "changelog.yaml", ".semlayer/change.json"];
const bytes = (root: string) => FILES.map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null));

async function close(root: string, version: string, env: Record<string, string> = {}) {
  return semlayer(root, ["change", "close", "--version", version, "--json"], env);
}

async function refused(root: string, args: string[], code: string): Promise<Refusal> {
  const before = bytes(root);
  const r = await semlayer(root, [...args, "--json"]);
  expect(r.code).toBe(1);
  const j = r.json<Refusal>();
  expect(j.code).toBe(code);
  expect(j.next).toStartWith("semlayer ");
  expect(bytes(root)).toEqual(before);
  return j;
}

const golden = (root: string, name: string) => readYaml<Golden>(join(root, "goldens", `${name}.yaml`));

// Doubles the lake's spend measure, so both goldens that read it move; their hand-written cross_check_sql
// would still give the old figures, so the test copies drop it before the first release.
async function doubleSpend(root: string): Promise<void> {
  const r = await semlayer(root, ["set", "lake.marketing_spend.spend", "expr", "spend_cents * 0.02"]);
  expect(r.code).toBe(0);
  await reapprove(root, ["lake.marketing_spend.spend"]);
}
function dropCrossCheck(root: string, names: string[]): void {
  for (const n of names) {
    const path = join(root, "goldens", `${n}.yaml`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/cross_check_sql: \|\n(  .*\n)+/, ""));
  }
}

describe("the first release", () => {
  test("records every item's approval hash and every approved golden's recorded rows, and sets layer_version", async () => {
    const root = await fixture();
    const hashes = Object.fromEntries([...itemMap(root)].map(([ref, v]) => [ref, v.hash]));
    const r = await close(root, "1.0");
    expect(r.code).toBe(0);
    const out = r.json<Closed>();
    expect(out).toMatchObject({ closed: true, version: "1.0", items: Object.keys(hashes).length, goldens_moved: [], not_rerun: [] });
    expect(out.next).toContain("semlayer change start");
    const entry = readChangelog(root)!.entries[0]!;
    expect(entry).toMatchObject({ version: "1.0", date: "2026-01-15", note: "First release.", added: [], changed: [], removed: [], goldens_moved: [] });
    expect(entry.items).toEqual(hashes);
    // Every approved golden: new_customers_2025 is a draft and is left out.
    expect(Object.keys(entry.goldens)).toHaveLength(16);
    expect(entry.goldens.new_customers_2025).toBeUndefined();
    for (const [name, rows] of Object.entries(entry.goldens)) expect(rows).toEqual(golden(root, name).expected!.rows);
    expect(readFileSync(join(root, "semantic.yaml"), "utf8")).toContain('layer_version: "1.0"');
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    // The next step on the released layer is a change round.
    const n = (await semlayer(root, ["next", "--json"])).json<NextAction>();
    expect(n.why).toContain("semlayer change start");
  });

  test("the example layer as committed closes as 1.0 with the deferred field left out, named in the output and under --json", async () => {
    const root = committed();
    const hashes = Object.fromEntries([...itemMap(root)].filter(([, v]) => v.approved).map(([ref, v]) => [ref, v.hash]));
    const plain = await semlayer(root, ["change", "close", "--version", "1.0"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain(`Drafts left out (1): ${DEFERRED}. They are not part of this release and join a later one once the owner approves them.`);
    const entry = readChangelog(root)!.entries[0]!;
    expect(Object.keys(entry.items)).not.toContain(DEFERRED);
    expect(entry.items).toEqual(hashes);
    expect(entry.added).not.toContain(DEFERRED);
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    // Again on a copy, under --json.
    const other = committed();
    const j = (await close(other, "1.0")).json<Closed>();
    expect(j).toMatchObject({ closed: true, version: "1.0", drafts_left_out: [DEFERRED] });
    expect(j.items).toBe(Object.keys(hashes).length);
    expect(Object.keys(readChangelog(other)!.entries[0]!.items)).not.toContain(DEFERRED);
  });

  test("a release never records a draft item's hash", async () => {
    const root = committed();
    expect((await semlayer(root, ["add-metric", "--name", "spend_per_session", "--type", "derived", "--source", "lake", "--expr", "{marketing_spend.spend} / {sessions.session_count}", "--description", "Marketing spend per web session."])).code).toBe(0);
    const drafts = [...itemMap(root)].filter(([, v]) => !v.approved).map(([ref]) => ref).sort();
    expect(drafts).toEqual(["metric:spend_per_session", DEFERRED].sort());
    const r = await close(root, "1.0");
    expect(r.code).toBe(0);
    expect(r.json<Closed>().drafts_left_out).toEqual([...drafts]);
    const items = readChangelog(root)!.entries[0]!.items;
    const now = itemMap(root);
    for (const ref of Object.keys(items)) expect(now.get(ref)!.approved).toBe(true);
    for (const ref of drafts) expect(Object.keys(items)).not.toContain(ref);
  });

  test("a confirmed golden that reads a draft the release would leave out is refused, naming both, and writes nothing", async () => {
    const root = committed();
    expect((await semlayer(root, ["add-metric", "--name", "spend_per_session", "--type", "derived", "--source", "lake", "--expr", "{marketing_spend.spend} / {sessions.session_count}", "--description", "Marketing spend per web session."])).code).toBe(0);
    const path = join(root, "goldens", "spend_2025.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("measures: [marketing_spend.spend]", "measures: [marketing_spend.spend, spend_per_session]"));
    const j = await refused(root, ["change", "close", "--version", "1.0"], "release.close_blocked");
    expect(j.error).toContain("golden spend_2025 is confirmed and reads metric:spend_per_session, a draft the release would leave out");
    expect(j.next).toBe("semlayer readback --targets metric:spend_per_session");
    expect(existsSync(join(root, "changelog.yaml"))).toBe(false);
  });

  // Found by a walkthrough: a table the owner deferred keeps its draft join to an approved table, and every
  // golden on the approved table was held as if it read that join.
  test("a draft join that reaches a golden's model does not hold the release: the golden never follows it", async () => {
    const root = committed();
    const added = await semlayer(root, ["add-join", "--source", "lake", "--model", "sessions", "--name", "channel_spend", "--to", "marketing_spend", "--keys", "utm_channel=channel"]);
    expect(added.err).toBe("");
    expect(added.code).toBe(0);
    const r = await close(root, "1.0");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json<Closed>().drafts_left_out).toContain("lake.sessions.channel_spend");
    const entry = readChangelog(root)!.entries[0]!;
    for (const g of SPEND_GOLDENS) expect(Object.keys(entry.goldens)).toContain(g);
    expect(Object.keys(entry.items)).not.toContain("lake.sessions.channel_spend");
  });

  test("a draft golden blocks nothing and is not recorded", async () => {
    const root = committed();
    expect(golden(root, "new_customers_2025").status).toBe("draft");
    expect((await close(root, "1.0")).code).toBe(0);
    expect(Object.keys(readChangelog(root)!.entries[0]!.goldens)).not.toContain("new_customers_2025");
  });

  test("is refused while an item is edited since its approval", async () => {
    const root = await fixture();
    expect((await semlayer(root, ["set", "lake.marketing_spend.channel", "synonyms", "[paid channel]"])).code).toBe(0);
    const j = await refused(root, ["change", "close", "--version", "1.0"], "release.close_blocked");
    expect(j.error).toContain("lake.marketing_spend.channel");
  });

  test("a missing or malformed version is refused with a code and the command, writing nothing", async () => {
    const root = await fixture();
    expect((await refused(root, ["change", "close"], "release.close_missing_version")).next).toBe("semlayer change close --version 1.0");
    expect((await refused(root, ["change", "close", "--version", "v1"], "release.version_invalid")).next).toBe("semlayer change close --version 1.0");
    await refused(root, ["change", "close", "--version", "01.0"], "release.version_invalid");
    await refused(root, ["change", "close", "--version", "1.0", "--note", "x"], "user_error");
  });
});

describe("closing a round", () => {
  test("a released layer with no round open is refused, naming change start", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    const j = await refused(root, ["change", "close", "--version", "1.1"], "release.close_no_round");
    expect(j.next).toContain("semlayer change start");
  });

  test("the deferred field approved after 1.0 joins release 1.1 under added", async () => {
    const root = committed();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    // Never approved and not in the release: it waits for nothing.
    const n = (await semlayer(root, ["next", "--json"])).json<NextAction>();
    expect(n.action).toMatchObject({ command: "change", args: ["close", "--version", "1.1"] });
    expect(n.why).toContain(`Drafts the owner deferred, which the release leaves out (1): ${DEFERRED}`);
    await reapprove(root, [DEFERRED]);
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    expect(r.json<Closed>()).toMatchObject({ added: [DEFERRED], changed: [], drafts_left_out: [] });
    const [first, second] = readChangelog(root)!.entries;
    expect(Object.keys(first!.items)).not.toContain(DEFERRED);
    expect(Object.keys(second!.items)).toContain(DEFERRED);
    expect(second!.added).toEqual([DEFERRED]);
  });

  test("an approved measure edited after 1.0 and not approved again refuses the close, naming it, and nothing is written", async () => {
    const root = committed();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.order_count", "synonyms", "[orders placed]"])).code).toBe(0);
    const j = await refused(root, ["change", "close", "--version", "1.1"], "release.close_blocked");
    expect(j.error).toContain("warehouse.orders.order_count");
    expect(j.error).not.toContain(DEFERRED);
    expect(j.next).toBe("semlayer readback --targets warehouse.orders.order_count");
    // The plain output refuses the same way, and files stay as they were.
    const before = bytes(root);
    const plain = await semlayer(root, ["change", "close", "--version", "1.1"]);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("warehouse.orders.order_count");
    expect(bytes(root)).toEqual(before);
  });

  test("an item the last release held and the owner revoked blocks the close, though its content is as released", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["approve", "--target", DEFERRED, "--revoke"])).code).toBe(0);
    const j = await refused(root, ["change", "close", "--version", "1.1"], "release.close_blocked");
    expect(j.error).toContain(DEFERRED);
    expect(j.next).toBe(`semlayer readback --targets ${DEFERRED}`);
  });

  test("an item removed since the last release is listed under removed and does not block", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["remove-field", DEFERRED, "--force"])).code).toBe(0);
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    expect(r.json<Closed>()).toMatchObject({ added: [], changed: [], removed: [DEFERRED], drafts_left_out: [] });
    expect(readChangelog(root)!.entries[1]!.removed).toEqual([DEFERRED]);
  });

  test("every refusal under --json is one object with error, code and next", async () => {
    const root = committed();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.order_count", "synonyms", "[orders placed]"])).code).toBe(0);
    for (const args of [["change", "close", "--version", "1.1"], ["change", "close"], ["change", "close", "--version", "1.0"], ["change", "close", "--version", "x"]]) {
      const r = await semlayer(root, [...args, "--json"]);
      expect(r.code).toBe(1);
      const j = r.json<Record<string, unknown>>();
      expect(Object.keys(j).sort()).toEqual(["code", "error", "next"]);
      expect(typeof j.error).toBe("string");
      expect(typeof j.code).toBe("string");
      expect(String(j.next)).toStartWith("semlayer ");
    }
  });

  test("M2 item 1: a metric added in a round is read back and approved on the owner's yes before the close, and 1.1 names it", async () => {
    const root = committed();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    const ledger = () => (existsSync(join(root, ".semlayer", "ledger.jsonl")) ? readFileSync(join(root, ".semlayer", "ledger.jsonl"), "utf8").split("\n").filter(Boolean) : []);
    const before = ledger().length;
    const add = ["add-metric", "--name", "spend_per_session", "--type", "derived", "--source", "lake", "--expr", "{marketing_spend.spend} / {sessions.session_count}", "--description", "Marketing spend per web session."];
    expect((await semlayer(root, add)).code).toBe(0);
    const a = (await semlayer(root, ["next", "--json"])).json<NextAction>();
    expect(a.action).toEqual({ command: "readback", args: ["--targets", "metric:spend_per_session"], kind: "run" });
    await recordReply(root, "metric:spend_per_session", { by: "Dana Ruiz" });
    expect((await semlayer(root, ["approve", "--target", "metric:spend_per_session"])).code).toBe(0);
    const b = (await semlayer(root, ["next", "--json"])).json<NextAction>();
    expect(b.action).toEqual({ command: "change", args: ["close", "--version", "1.1"], kind: "run" });
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    expect(r.json<Closed>()).toMatchObject({ added: ["metric:spend_per_session"], changed: [], removed: [], drafts_left_out: [DEFERRED] });
    const entry = readChangelog(root)!.entries[1]!;
    expect(entry.added).toEqual(["metric:spend_per_session"]);
    expect(Object.keys(entry.items)).toContain("metric:spend_per_session");
    expect(Object.keys(entry.items)).not.toContain(DEFERRED);
    // Nothing but the new metric was read back or approved in the round.
    const lines = ledger().slice(before);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain("spend_per_session");
    expect(lines.join("\n")).not.toContain(DEFERRED);
  });

  test("one added metric closes as 1.1, and closing twice with one version fails", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["add-metric", "--name", "spend_per_session", "--type", "derived", "--source", "lake", "--expr", "{marketing_spend.spend} / {sessions.session_count}", "--description", "Marketing spend per web session."])).code).toBe(0);
    await reapprove(root, ["metric:spend_per_session"]);
    const n = (await semlayer(root, ["next", "--json"])).json<NextAction>();
    expect(n).toMatchObject({ kind: "run", phase: "change", action: { command: "change", args: ["close", "--version", "1.1"], kind: "run" }, run: { command: "semlayer change close --version 1.1" } });
    expect(n.why).toContain("I suggest 1.1");
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    const log = readChangelog(root)!;
    expect(log.entries.map((e) => e.version)).toEqual(["1.0", "1.1"]);
    expect(log.entries[1]).toMatchObject({ note: "Count spend twice", added: ["metric:spend_per_session"], changed: [], removed: [] });
    expect(readFileSync(join(root, "semantic.yaml"), "utf8")).toContain('layer_version: "1.1"');
    expect(existsSync(join(root, ".semlayer", "change.json"))).toBe(false);
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    // A second round closed with the same version is refused by the version check.
    expect((await semlayer(root, START)).code).toBe(0);
    const j = await refused(root, ["change", "close", "--version", "1.1"], "release.version_not_above");
    expect(j.next).toBe("semlayer change close --version 1.2");
    await refused(root, ["change", "close", "--version", "1.0"], "release.version_not_above");
  });

  test("a measure two goldens read: close refuses naming both, and after the owner confirms each the entry lists both with before and after", async () => {
    const root = await fixture();
    dropCrossCheck(root, SPEND_GOLDENS);
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    await doubleSpend(root);
    const j = await refused(root, ["change", "close", "--version", "1.1"], "release.close_blocked");
    for (const g of SPEND_GOLDENS) expect(j.error).toContain(`golden ${g}'s figures moved`);
    expect(j.error).toContain("16502.34");
    expect(j.next).toBe("semlayer readback --targets golden:spend_2025");
    // The close confirms nothing: the goldens keep their recorded rows.
    expect(golden(root, "spend_2025").expected!.rows).toEqual([{ spend: 16502.34 }]);
    for (const g of SPEND_GOLDENS) {
      await recordReply(root, `golden:${g}`, { by: "Dana Ruiz" });
      const c = await semlayer(root, ["goldens", "confirm", "--name", g]);
      expect(c.code).toBe(0);
    }
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    const out = r.json<Closed>();
    expect(out.changed).toEqual(["lake.marketing_spend.spend"]);
    expect(out.goldens_moved).toEqual([
      { golden: "spend_2025", before: 1, after: 1, changed: 1 },
      { golden: "spend_by_channel_2025", before: 10, after: 10, changed: 5 },
    ]);
    const [first, second] = readChangelog(root)!.entries;
    expect(second!.goldens_moved).toEqual(out.goldens_moved);
    expect(first!.goldens.spend_2025).toEqual([{ spend: 16502.34 }]);
    expect(second!.goldens.spend_2025).toEqual([{ spend: 33004.68 }]);
    expect(first!.goldens.spend_by_channel_2025![0]).toEqual({ channel: "affiliate", spend: 1479.93 });
    expect(second!.goldens.spend_by_channel_2025![0]).toEqual({ channel: "affiliate", spend: 2959.86 });
    expect(second!.goldens.sessions_2025).toEqual(first!.goldens.sessions_2025!);
  });

  test("a golden on a source that cannot be queried is listed as not rerun and does not block", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.order_count", "synonyms", "[orders placed]"])).code).toBe(0);
    await reapprove(root, ["warehouse.orders.order_count"]);
    const r = await close(root, "1.1", { WAREHOUSE_URL: "" });
    expect(r.code).toBe(0);
    const out = r.json<Closed>();
    expect(out.not_rerun.length).toBeGreaterThan(0);
    for (const n of out.not_rerun) expect(n).toMatchObject({ source: "warehouse", reason: expect.stringContaining("WAREHOUSE_URL is not set") });
    expect(out.not_rerun.map((n) => n.golden)).toContain("order_count_by_region_2025");
    expect(out.goldens_moved).toEqual([]);
    const plain = await semlayer(await fixture(), ["change", "close", "--version", "1.0"]);
    expect(plain.code).toBe(0);
  });

  test("the plain output of a not-rerun golden says its figures were not compared", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.order_count", "synonyms", "[orders placed]"])).code).toBe(0);
    await reapprove(root, ["warehouse.orders.order_count"]);
    const r = await semlayer(root, ["change", "close", "--version", "1.1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Not rerun (");
    expect(r.out).toContain("their figures were not compared with their recorded rows");
    expect(r.out).toContain('layer_version in semantic.yaml is now 1.1, and the change round is closed.');
  });

  test("nothing it prints shows a protected value of a golden over a protected column", async () => {
    const root = await fixture();
    dropCrossCheck(root, SPEND_GOLDENS);
    // The channel is personal data here, which only the analyst role sees, so the golden runs as an analyst.
    const path = join(root, "goldens", "spend_by_channel_2025.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("question:", "role: analyst\nuser:\n  department: analytics\nquestion:"));
    expect((await semlayer(root, ["tag", "lake.marketing_spend.channel", "pii"])).code).toBe(0);
    await reapprove(root, ["lake.marketing_spend.channel"]);
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    // The channel's values move: every row of the golden differs in the protected column.
    expect((await semlayer(root, ["set", "lake.marketing_spend.channel", "expr", "upper(channel)"])).code).toBe(0);
    await reapprove(root, ["lake.marketing_spend.channel"]);
    const channels = ["affiliate", "display", "email", "paid_search", "paid_social"];
    const shows = (text: string) => channels.filter((c) => text.toLowerCase().includes(c));
    for (const json of [true, false]) {
      const r = await semlayer(root, ["change", "close", "--version", "1.1", ...(json ? ["--json"] : [])]);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain("golden spend_by_channel_2025's figures moved");
      expect(r.out + r.err).toContain(`column channel: expected ${PROTECTED_VALUE}, got ${PROTECTED_VALUE}`);
      expect(shows(r.out + r.err)).toEqual([]);
    }
    await recordReply(root, "golden:spend_by_channel_2025", { by: "Dana Ruiz" });
    expect((await semlayer(root, ["goldens", "confirm", "--name", "spend_by_channel_2025"])).code).toBe(0);
    for (const json of [true, false]) {
      const r = await semlayer(root, ["change", "close", "--version", json ? "1.1" : "1.2", ...(json ? ["--json"] : [])]);
      expect(r.code).toBe(0);
      expect(shows(r.out + r.err)).toEqual([]);
      if (json) {
        expect(r.json<Closed>().goldens_moved).toEqual([{ golden: "spend_by_channel_2025", before: 10, after: 10, changed: 5 }]);
        expect((await semlayer(root, START)).code).toBe(0);
        expect((await semlayer(root, ["set", "lake.marketing_spend.channel", "expr", "channel"])).code).toBe(0);
        await reapprove(root, ["lake.marketing_spend.channel"]);
        await recordReply(root, "golden:spend_by_channel_2025", { by: "Dana Ruiz" });
        expect((await semlayer(root, ["goldens", "confirm", "--name", "spend_by_channel_2025"])).code).toBe(0);
      }
    }
    // The entry copies the rows as the golden file stores them.
    expect(readChangelog(root)!.entries[2]!.goldens.spend_by_channel_2025).toEqual(golden(root, "spend_by_channel_2025").expected!.rows);
  });
});

describe("a close stopped part way", () => {
  test("layer_version written without the entry: validate names the mismatch, and the same close finishes", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    const path = join(root, "semantic.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace('layer_version: "1.0"', 'layer_version: "1.1"'));
    const v = validateProject(root).find((i) => i.code === "release.version_mismatch");
    expect(v?.message).toContain("semlayer change close --version 1.1");
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("a close stopped after its entry", () => {
  test("the next close removes the round's file, says so and writes nothing else", async () => {
    const root = await fixture();
    expect((await close(root, "1.0")).code).toBe(0);
    expect((await semlayer(root, START)).code).toBe(0);
    const first = readChangelog(root)!.entries[0]!;
    appendEntry(root, { ...first, version: "1.1", note: "Count spend twice" });
    const path = join(root, "semantic.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace('layer_version: "1.0"', 'layer_version: "1.1"'));
    const log = readFileSync(join(root, "changelog.yaml"), "utf8");
    const yaml = readFileSync(path, "utf8");
    const r = await close(root, "1.1");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ closed: true, version: "1.1", already_recorded: true, layer_version: "1.1" });
    expect(existsSync(join(root, ".semlayer", "change.json"))).toBe(false);
    expect(readFileSync(join(root, "changelog.yaml"), "utf8")).toBe(log);
    expect(readFileSync(path, "utf8")).toBe(yaml);
  });
});

describe("movedCells", () => {
  test("pairs rows by the grouping columns and counts the cells that differ", () => {
    const before = [{ channel: "a", spend: 1 }, { channel: "b", spend: 2 }];
    expect(movedCells(before, [{ channel: "b", spend: 2 }, { channel: "a", spend: 3 }], ["channel"])).toEqual({ before: 4, after: 4, changed: 1 });
    expect(movedCells(before, [{ channel: "a", spend: 1 }], ["channel"])).toEqual({ before: 4, after: 2, changed: 2 });
    expect(movedCells([{ n: "5" }], [{ n: 5 }], [])).toEqual({ before: 1, after: 1, changed: 0 });
  });
});

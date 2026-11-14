import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { runBefore } from "../skills/semantic-layer/scripts/hooks/integrity.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import type { Golden, PendingReadback } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, sl, tempDir } from "./helpers.ts";

// HR-15 (PR H15b): the first minutes from an empty folder, and the readback gate, as the exit
// walkthrough found them. All data is synthetic.

const REPO = join(import.meta.dir, "..");
const SKILL = join(REPO, "skills", "semantic-layer");
const SL = join(SKILL, "scripts", "sl.ts");
const ACME = join(REPO, "examples", "acme", "semantic");
const SECRET = "This file holds the connection secret. sl reads it itself, and you never need its contents.";
const URL_LINE = "WAREHOUSE_URL=postgres://reader:synthetic@localhost:5432/acme\n";

function acme(): { dir: string; root: string } {
  const dir = tempDir();
  const root = join(dir, "semantic");
  cpSync(ACME, root, { recursive: true });
  return { dir, root };
}

async function ok(root: string, args: string[]): Promise<string> {
  const r = await sl(root, args);
  if (r.code !== 0) throw new Error(`sl ${args.join(" ")}: ${r.err}`);
  return r.out;
}

describe("the env file before a semantic root exists", () => {
  // A folder holding only .env, as the walkthrough began, with the hook's state in its own directory.
  function folder() {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), URL_LINE);
    const env = { CLAUDE_PLUGIN_DATA: tempDir(), CLAUDE_PROJECT_DIR: dir };
    const check = (tool: string, input: Record<string, unknown>) => checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: dir }), dir, env);
    const before = (tool: string, input: Record<string, unknown>) =>
      runBefore(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: dir, session_id: "s", tool_use_id: `t${Math.random()}` }), true, { env });
    const reads = () => [check("Bash", { command: "cat .env" }), check("Bash", { command: "grep -r WAREHOUSE ." }), check("Read", { file_path: join(dir, ".env") }), check("Grep", { pattern: "WAREHOUSE" })];
    return { dir, env, check, before, reads };
  }

  test("with no evidence that the project uses the plugin, .env stays readable", () => {
    const f = folder();
    for (const v of f.reads()) expect(v).toEqual({ allow: true });
    // A command that is not sl, and a read of another file, are no evidence.
    expect(f.before("Bash", { command: "ls -la" })).toEqual({ block: false });
    expect(f.before("Read", { file_path: join(f.dir, "notes.txt") })).toEqual({ block: false });
    for (const v of f.reads()) expect(v).toEqual({ allow: true });
  });

  test("after the first sl command (the SKILL's first step), cat, grep -r, Read and Grep on .env are refused before sl init", () => {
    const f = folder();
    expect(f.before("Bash", { command: `bun ${SL} next --json` })).toEqual({ block: false });
    for (const v of f.reads()) {
      expect(v.allow).toBe(false);
      expect(v.message).toContain(SECRET);
      expect(v.message).not.toContain("synthetic");
    }
    // .env.example and other files stay readable.
    writeFileSync(join(f.dir, ".env.example"), "WAREHOUSE_URL=postgres://<user>:<password>@<host>/<db>\n");
    expect(f.check("Bash", { command: "cat .env.example" })).toEqual({ allow: true });
    // The evidence is one file in the hook's state directory, keyed by the project directory.
    expect(readdirSync(join(f.env.CLAUDE_PLUGIN_DATA, "ledger-guard")).filter((n) => n.startsWith("project-"))).toHaveLength(1);
  });

  test("a command named sl, one of the MCP server's sl tools, or a read of the skill's files is evidence too", () => {
    const forms: [string, Record<string, unknown>][] = [
      ["Bash", { command: "sl status --json" }],
      ["mcp__plugin_semantic-layer-builder_semantic-layer__sl_next", {}],
      ["Read", { file_path: join(SKILL, "SKILL.md") }],
      ["Bash", { command: `cat ${join(SKILL, "references", "phases", "intake.md")}` }],
    ];
    for (const [tool, input] of forms) {
      const f = folder();
      f.before(tool, input);
      expect(`${tool} ${JSON.stringify(input)}: ${f.check("Bash", { command: "cat .env" }).allow}`).toBe(`${tool} ${JSON.stringify(input)}: false`);
    }
  });

  test("a first call that is itself evidence is checked as one: sl then cat .env in one command is refused", () => {
    const f = folder();
    const v = f.check("Bash", { command: `bun ${SL} next --json; cat .env` });
    expect(v.allow).toBe(false);
    expect(v.message).toContain(SECRET);
    // A call that is no evidence still leaves .env readable.
    expect(f.check("Bash", { command: "ls; cat .env" })).toEqual({ allow: true });
  });

  test("evidence in one project does not reach another, and once sl init runs the root's own rule refuses the file", async () => {
    const used = folder();
    used.before("Bash", { command: `bun ${SL} next` });
    const other = folder();
    expect(other.check("Bash", { command: "cat .env" })).toEqual({ allow: true });
    await initProject(join(used.dir, "semantic"));
    rmSync(join(used.env.CLAUDE_PLUGIN_DATA, "ledger-guard"), { recursive: true, force: true });
    expect(used.check("Bash", { command: "cat .env" }).allow).toBe(false);
  });
});

describe("a readback is refused for items sl approve would refuse", () => {
  test("a measure without a description is refused up front, naming it and the one sl apply that fixes it", async () => {
    const { dir, root } = acme();
    await ok(root, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "orders_seen", "--expr", "order_id", "--agg", "count_distinct"]);
    const r = await sl(root, ["readback", "--targets", "warehouse.orders.orders_seen", "--json"]);
    expect(r.code).toBe(1);
    const refusal = r.json<{ error: string; next: string }>();
    expect(refusal.next).toBe("sl apply --file -");
    expect(refusal.error).toContain("sl approve would refuse it after the owner's yes, so nothing was written");
    expect(refusal.error).toContain("  - warehouse.orders.orders_seen: Measure warehouse.orders.orders_seen has no description");
    expect(existsSync(join(root, ".sl", "pending"))).toBe(false);
    // The edit it names runs once its placeholder holds the owner's words, and the readback then goes through.
    const edits = JSON.parse(/standard input: (\{.*\})$/m.exec(refusal.error)![1]!) as { edits: string[][] };
    expect(edits.edits).toEqual([["set", "warehouse.orders.orders_seen", "description", "<what it means, in the owner's words>"]]);
    const file = join(dir, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: edits.edits.map((e) => e.map((w) => (w.startsWith("<") ? "Orders seen, counted once each." : w))) }));
    await ok(root, ["apply", "--file", file]);
    expect((await sl(root, ["readback", "--targets", "warehouse.orders.orders_seen"])).code).toBe(0);
  });

  test("a model without a grain and a metric without a description are each named", async () => {
    const { root } = acme();
    await ok(root, ["approve", "--target", "warehouse.regions", "--revoke"]);
    await ok(root, ["set", "warehouse.regions", "grain", "--unset"]);
    await ok(root, ["approve", "--target", "metric:average_order_value", "--revoke"]);
    await ok(root, ["set", "metric:average_order_value", "description", "--unset"]);
    const r = await sl(root, ["readback", "--targets", "warehouse.regions,metric:average_order_value"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  - warehouse.regions: warehouse.regions has no grain");
    expect(r.err).toContain("  - metric:average_order_value: Metric metric:average_order_value has no description");
    expect(r.err).toContain('["set","warehouse.regions","grain","<what one row is, in the owner\'s words>"]');
    // sl approve refuses the same item for the same lack: one check serves both.
    const approve = await sl(root, ["approve", "--target", "warehouse.regions"]);
    expect(approve.code).toBe(1);
    expect(approve.err).toContain("warehouse.regions has no grain");
  });
});

describe("the gate's edits run once their placeholders are filled in", () => {
  test("a model without a primary_key: the list placeholder, filled in, applies", async () => {
    const { dir, root } = acme();
    await ok(root, ["approve", "--target", "warehouse.regions", "--revoke"]);
    await ok(root, ["set", "warehouse.regions", "primary_key", "--unset"]);
    const r = await sl(root, ["readback", "--targets", "warehouse.regions", "--json"]);
    expect(r.code).toBe(1);
    const edits = JSON.parse(/standard input: (\{.*\})$/m.exec(r.json<{ error: string }>().error)![1]!) as { edits: string[][] };
    expect(edits.edits).toEqual([["set", "warehouse.regions", "primary_key", "[<column>, ...]"]]);
    const file = join(dir, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: edits.edits.map((e) => e.map((w) => (w === "[<column>, ...]" ? "[region_code]" : w))) }));
    await ok(root, ["apply", "--file", file]);
    expect((await sl(root, ["readback", "--targets", "warehouse.regions"])).code).toBe(0);
  });

  test("a ratio metric whose denominator names a missing measure is fixed on the denominator", async () => {
    const { root } = acme();
    await ok(root, ["approve", "--target", "metric:average_order_value", "--revoke"]);
    // sl set refuses the bad reference, so the file is edited as a hand edit would.
    const file = join(root, "metrics.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("denominator: orders.order_count", "denominator: orders.nope"));
    const r = await sl(root, ["readback", "--targets", "metric:average_order_value"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("  - metric:average_order_value: measure warehouse.orders.nope does not exist");
    expect(r.err).toContain('{"edits":[["set","metric:average_order_value","denominator","<model.measure>"]]}');
  });
});

describe("a discarded readback's id is never issued again", () => {
  test("two discards in a row never reissue either id, and a discarded id cannot be discarded again", async () => {
    const { root } = acme();
    await ok(root, ["approve", "--target", "warehouse.orders", "--revoke"]);
    for (const id of ["rb_0001", "rb_0002"]) {
      expect((JSON.parse(await ok(root, ["readback", "--targets", "warehouse.orders", "--json"])) as { readback_id: string }).readback_id).toBe(id);
      await ok(root, ["readback", "--discard", id]);
    }
    expect((JSON.parse(await ok(root, ["readback", "--targets", "warehouse.orders", "--json"])) as { readback_id: string }).readback_id).toBe("rb_0003");
    expect((await sl(root, ["readback", "--discard", "rb_0001"])).code).toBe(1);
  });

  test("a metric whose measures are drafts is still read back: the gate leaves drafts to sl approve", async () => {
    const { root } = acme();
    await ok(root, ["approve", "--target", "warehouse.orders.revenue", "--revoke"]);
    await ok(root, ["approve", "--target", "metric:average_order_value", "--revoke"]);
    expect((await sl(root, ["readback", "--targets", "metric:average_order_value"])).code).toBe(0);
  });

  test("after sl readback --discard rb_0001 with no reply, the next readback is rb_0002", async () => {
    const { root } = acme();
    await ok(root, ["approve", "--target", "warehouse.orders", "--revoke"]);
    const first = JSON.parse(await ok(root, ["readback", "--targets", "warehouse.orders", "--json"])) as { readback_id: string };
    expect(first.readback_id).toBe("rb_0001");
    const out = await ok(root, ["readback", "--discard", "rb_0001"]);
    expect(out).toContain("its id is not given to another readback");
    expect(readdirSync(join(root, ".sl", "pending"))).toEqual(["rb_0001.discarded"]);
    const second = JSON.parse(await ok(root, ["readback", "--targets", "warehouse.orders", "--json"])) as { readback_id: string };
    expect(second.readback_id).toBe("rb_0002");
    // The marker is no readback: sl next and sl validate pass over it.
    const next = (await sl(root, ["next", "--json"])).json<NextAction>();
    expect(next.ask_owner?.readback_id).toBe("rb_0002");
    expect((await sl(root, ["validate", "--json"])).out).not.toContain("rb_0001");
  });
});

describe("a golden's readback shows each figure as confirm records and compares it", () => {
  test("a ratio metric's figure is shown to two decimals with its full figure, and confirm records the full figure under the same hash", async () => {
    const { dir, root } = acme();
    const row = { revenue: 301050.82, order_count: 2239, average_order_value: 134.45771326485038 };
    const results = join(dir, "rows.json");
    writeFileSync(results, JSON.stringify({ "golden:revenue_2025": [row], "golden:revenue_2025:cross_check": [row] }));
    const rb = JSON.parse(await ok(root, ["readback", "--targets", "golden:revenue_2025", "--results", results, "--json"])) as { readback_id: string; items: PendingReadback["items"] };
    const text = rb.items[0]!.text;
    expect(text).toContain("> 301050.82  2239         134.46");
    expect(text).toContain("- Money is shown to two decimals; sl goldens confirm records and later runs compare the full figure: average_order_value 134.46 is 134.45771326485038.");
    expect(text).toContain("sl goldens confirm then records exactly them, with the full figures above.");
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes, $134.46 matches Finance.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    // The confirm's hash check passes: the readback's hash covers the full figures it records.
    await ok(root, ["goldens", "confirm", "--name", "revenue_2025", "--results", results]);
    expect(readYaml<Golden>(join(root, "goldens", "revenue_2025.yaml")).expected!.rows).toEqual([row]);
  });
});

describe("carried from earlier reviews", () => {
  test("sl goldens check --emit-sql --json prints { error, next } when a file it plans from is malformed", async () => {
    const { root } = acme();
    writeFileSync(join(root, "sources", "warehouse.yaml"), "- a\n");
    const r = await sl(root, ["goldens", "check", "--emit-sql", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(1);
    const data = r.json<{ error: string; next: string }>();
    expect(Object.keys(data).sort()).toEqual(["error", "next"]);
    expect(data.error).toStartWith("Cannot plan every golden:");
    expect(data.next).toBe("sl validate");
  });

  test("sl goldens check --emit-sql --json over a malformed golden prints { error, next }", async () => {
    const { root } = acme();
    writeFileSync(join(root, "goldens", "broken.yaml"), "- not a golden\n");
    const r = await sl(root, ["goldens", "check", "--emit-sql", "--source", "warehouse", "--json"]);
    expect(r.code).toBe(1);
    expect(Object.keys(r.json<Record<string, unknown>>()).sort()).toEqual(["error", "next"]);
  });

  test("with goldens that name roles and no access.yaml, the access step is one sl apply that runs", async () => {
    const { dir, root } = acme();
    rmSync(join(root, "access.yaml"));
    expect((await sl(root, ["set", "access", "mode", "open"])).code).toBe(1);
    const a = (await sl(root, ["next", "--json"])).json<NextAction>();
    expect(a).toMatchObject({ kind: "ask_owner", phase: "access", action: { command: "apply", args: ["--file", "-"], kind: "ask_owner" } });
    const edits = JSON.parse(/standard input, <open\|closed> as the owner says: (\{.*?\})\. Then/.exec(a.why)![1]!) as { edits: string[][] };
    expect(edits.edits).toEqual([
      ["set", "access", "mode", "<open|closed>"],
      ["add-attribute", "--name", "department", "--type", "string"],
      ["add-attribute", "--name", "employee_id", "--type", "number"],
      ["add-role", "--name", "analyst"],
      ["add-role", "--name", "finance"],
      ["add-role", "--name", "sales"],
    ]);
    const file = join(dir, "access.json");
    writeFileSync(file, JSON.stringify({ edits: edits.edits.map((e) => e.map((w) => (w === "<open|closed>" ? "open" : w))) }));
    await ok(root, ["apply", "--file", file]);
    expect(readFileSync(join(root, "access.yaml"), "utf8")).toContain("mode: open");
  });

  test("an expr with at time zone warns about no column named at, time or zone", async () => {
    const { root } = acme();
    const out = await ok(root, ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "created_utc", "--expr", "created_at at time zone 'UTC'", "--type", "time"]);
    expect(out).not.toContain("not a column");
  });
});

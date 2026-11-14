import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { APPLY_COMMANDS, applyEntryRefusal, applyFileRefusals, ROLES, type Role } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { FIXED_NOW, sl, tempRoot } from "./helpers.ts";

// sl apply (HR-11): several typed edits under one lock and one validation, all or nothing, on
// copies of examples/acme, whose items are approved with content hashes. All data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const SL = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "sl.ts");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(async () => {
  ({ root, dir, cleanup } = tempRoot());
  cpSync(ACME, root, { recursive: true });
  // A locked command that changes nothing, so the lock's own .gitignore line is there before any hash.
  expect((await sl(root, ["set", "warehouse.orders", "grain", "One row per order."])).code).toBe(0);
});
afterEach(() => cleanup?.());

// Every file under `at`, by path, with its bytes.
function files(at: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(at, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(at, p), "latin1"));
    }
  };
  walk("");
  return out;
}

function treeHash(at: string): string {
  const h = createHash("sha256");
  for (const [p, t] of [...files(at)].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${p}\0${t}\0`);
  return h.digest("hex");
}

function editsFile(edits: unknown, name = "edits.json"): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ edits }));
  return file;
}

// Twelve typed edits of nine kinds, several reading what an earlier one wrote.
const TWELVE: string[][] = [
  ["set", "warehouse.orders", "grain", "One row per order placed."],
  ["set", "warehouse.orders.status", "synonyms", "[order status, state]"],
  ["tag", "warehouse.customers.acquisition_channel", "finance"],
  ["question", "add", "warehouse.orders", "--text", "Do gift orders count?"],
  ["add-field", "warehouse.orders", "--kind", "dimension", "--name", "region_upper", "--expr", "upper(ship_region)", "--type", "string", "--description", "Ship region in capitals."],
  ["set", "warehouse.orders.region_upper", "synonyms", "[region caps]"],
  ["rename", "warehouse.orders.region_upper", "ship_region_caps"],
  ["add-metric", "--name", "revenue_per_order", "--type", "ratio", "--source", "warehouse", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--format", "currency", "--currency", "USD", "--description", "Revenue per counted order."],
  ["set", "metric:revenue_per_order", "synonyms", "[rpo]"],
  ["add-attribute", "--name", "team", "--type", "string", "--description", "The user's team."],
  ["add-role", "--name", "team_analyst", "--description", "Analysts.", "--assign-when", "user.team == 'analytics'"],
  ["remove-field", "warehouse.orders.ship_region_caps"],
];

describe("a batch lands as the same edits run one by one", () => {
  test("twelve entries mixing commands leave every file byte for byte as running them one by one does", async () => {
    const edits = TWELVE;
    const other = tempRoot();
    cpSync(root, other.root, { recursive: true });
    for (const e of edits) {
      const r = await sl(other.root, e);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    }
    const r = await sl(root, ["apply", "--file", editsFile(edits)]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(files(root)).toEqual(files(other.root));
    other.cleanup();
    // Each entry's own result line, numbered, then the approved items it changed, once, with the readback command.
    expect(r.out).toContain("1. Set grain on warehouse.orders in models/warehouse/orders.yaml.");
    expect(r.out).toContain("7. Renamed warehouse.orders.region_upper to warehouse.orders.ship_region_caps");
    expect(r.out).toContain("12. ");
    expect(r.out).toContain("Applied 12 edits.");
    expect(r.out.split("warehouse.orders.status is approved and changed since its approval").length).toBe(2);
    // access.yaml went back to draft, as a single access edit makes it, and is read back with the rest.
    expect(readFileSync(join(root, "access.yaml"), "utf8")).toContain("status: draft");
    expect(r.out).toContain("Next: sl readback --targets warehouse.customers.acquisition_channel,warehouse.orders,warehouse.orders.status,access, then");
    expect(r.out.trimEnd().split("\n").filter((l) => l.includes("Next: "))).toHaveLength(1);
  });

  test("an approved access.yaml the batch makes a draft is listed at the end, and --json says so", async () => {
    const r = await sl(root, ["apply", "--file", editsFile([TWELVE[9]])]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("access.yaml was approved, so this edit made it a draft again");
    expect(r.out).toContain("Next: sl readback --targets access, then sl approve each again only on the owner's yes.");
    const again = tempRoot();
    cpSync(ACME, again.root, { recursive: true });
    const j = (await sl(again.root, ["apply", "--json", "--file", editsFile([TWELVE[9]], "one.json")])).json<Record<string, unknown>>();
    again.cleanup();
    expect(j).toMatchObject({ reapprove: [], returned_to_draft: true, last_approved: { by: expect.any(String), at: expect.any(String) } });
  });

  test("an entry's own next command is cut, leaving the batch's", async () => {
    await sl(root, ["tag", "warehouse.orders.status", "finance"]);
    const r = await sl(root, ["apply", "--file", editsFile([["tag", "warehouse.orders.status", "finance"], TWELVE[0]])]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1. warehouse.orders.status already has finance; nothing changed.\n");
    expect(r.out.split("Next: ")).toHaveLength(2);
  });

  test("--json gives each entry's own result and the approved items the batch changed", async () => {
    const r = await sl(root, ["apply", "--json", "--file", editsFile(TWELVE.slice(0, 3))]);
    expect(r.code).toBe(0);
    const j = r.json<{ applied: { entry: number; command: string[]; result: Record<string, unknown> }[]; reapprove: string[]; warnings: string[] }>();
    expect(j.applied.map((a) => a.entry)).toEqual([1, 2, 3]);
    expect(j.applied[0]!.command).toEqual(TWELVE[0]!);
    expect(j.applied[0]!.result).toMatchObject({ changed: true, ref: "warehouse.orders", key: "grain", file: "models/warehouse/orders.yaml" });
    expect(j.reapprove).toEqual(["warehouse.customers.acquisition_channel", "warehouse.orders", "warehouse.orders.status"]);
    expect(j.warnings).toEqual([]);
  });

  test("an item an entry changes and a later one restores is not listed", async () => {
    const r = await sl(root, ["apply", "--json", "--file", editsFile([TWELVE[0]!, ["set", "warehouse.orders", "grain", "One row per order."]])]);
    expect(r.code).toBe(0);
    expect(r.json<{ reapprove: string[] }>().reapprove).toEqual([]);
  });

  test("stdin with --file -, and a caller with no stdin is told to pass a file", async () => {
    const run = async (stdin?: () => Promise<string>) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(["apply", "--file", "-", "--root", root], { cwd: root, env: { SL_NOW: FIXED_NOW }, out: (t) => out.push(t), err: (t) => err.push(t), stdin });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const none = await run();
    expect(none.code).toBe(1);
    expect(none.err).toContain("pass --file <path>");
    const piped = await run(async () => JSON.stringify({ edits: [TWELVE[0]] }));
    expect(piped.err).toBe("");
    expect(piped.out).toContain("1. Set grain on warehouse.orders");
    expect(readFileSync(join(root, "models/warehouse/orders.yaml"), "utf8")).toContain("grain: One row per order placed.");
  });

  test("the CLI runs it as its own process", async () => {
    const proc = Bun.spawn(["bun", SL, "apply", "--file", "-", "--root", root], { cwd: root, env: { ...process.env, SL_NOW: FIXED_NOW }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify({ edits: [TWELVE[1]] }));
    proc.stdin.end();
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("1. Set synonyms on warehouse.orders.status");
  });
});

describe("a failure changes nothing", () => {
  const failsWith = async (edits: unknown, ...phrases: string[]) => {
    const before = treeHash(root);
    const r = await sl(root, ["apply", "--file", editsFile(edits)]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    for (const p of phrases) expect(r.err).toContain(p);
    expect(treeHash(root)).toBe(before);
    return r;
  };

  test("an entry that refuses in the middle: no file changes, and the error names the entry with its own message", async () => {
    const one = await sl(root, ["add-role", "--name", "analyst", "--description", "Analysts."]);
    const own = one.err.replace(/^sl add-role: /, "");
    expect(own).toContain('access.yaml already has a role "analyst"');
    const edits = [...TWELVE.slice(0, 6), ["add-role", "--name", "analyst", "--description", "Analysts."], ...TWELVE.slice(6, 11)];
    // The single add-role above wrote nothing either.
    await failsWith(edits, "Entry 7 (sl add-role --name analyst --description Analysts.) failed, so nothing was written:", own, "Fix entry 7 and run sl apply again.");
  });

  test("an error only the final validation sees names the entry that adds it, with that entry's own message", async () => {
    const own = (await sl(root, ["set", "warehouse.orders.status", "expr", "no_such_column"])).err.replace(/^sl set: /, "");
    expect(own).toContain("Cannot set expr on warehouse.orders.status: the result would not validate");
    await failsWith([TWELVE[0], TWELVE[4], ["set", "warehouse.orders.status", "expr", "no_such_column"], TWELVE[7]], "Entry 3 (sl set warehouse.orders.status expr no_such_column) failed", own);
  });

  test("an entry whose error a later entry fixes is not named; the entry whose error the batch ends with is", async () => {
    const edits = [
      ["set", "warehouse.orders.status", "expr", "no_such_column"],
      ["set", "warehouse.orders.status", "expr", "status"],
      ["set", "warehouse.customers.acquisition_channel", "expr", "another_missing_column"],
    ];
    const r = await failsWith(edits, "Entry 3 (sl set warehouse.customers.acquisition_channel expr another_missing_column) failed", "another_missing_column", "Fix entry 3");
    expect(r.err).not.toContain("Entry 1");
    expect(r.err).not.toContain("no_such_column");
    // The first two alone land: the second undoes the first.
    expect((await sl(root, ["apply", "--file", editsFile(edits.slice(0, 2))])).code).toBe(0);
  });

  test("a moved model file and a created metrics entry are put back when a later entry fails", async () => {
    await failsWith(
      [["rename", "warehouse.regions", "areas"], TWELVE[7], TWELVE[9], ["set", "warehouse.nope", "grain", "x"]],
      "Entry 4 (sl set warehouse.nope grain x) failed",
      'No model "nope"',
    );
    expect(existsSync(join(root, "models/warehouse/regions.yaml"))).toBe(true);
    expect(existsSync(join(root, "models/warehouse/areas.yaml"))).toBe(false);
  });

  test("an entry whose flags do not parse is refused before any runs", async () => {
    await failsWith([TWELVE[0], ["tag", "warehouse.orders.status", "--add", "x"]], "Entry 2 (sl tag warehouse.orders.status --add x): Unknown option '--add'", "sl tag --help");
  });

  test("malformed files", async () => {
    await failsWith([], 'The "edits" list is empty');
    await failsWith({ set: 1 }, 'has no "edits" list');
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ edits: ");
    const r = await sl(root, ["apply", "--file", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not JSON");
    expect((await sl(root, ["apply"])).err).toContain("Usage: sl apply --file <path>");
    const missing = (await sl(root, ["apply", "--file", join(dir, "missing.json")])).err;
    expect(missing).toContain("there is no such file");
    expect(missing).toContain("pass --file - to read them from stdin");
  });
});

describe("refused entry kinds", () => {
  const refused = async (entry: unknown, ...phrases: string[]) => {
    const before = treeHash(root);
    const r = await sl(root, ["apply", "--file", editsFile([TWELVE[0], entry])]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Entry 2");
    for (const p of phrases) expect(r.err).toContain(p);
    expect(r.err).toContain("Nothing was written.");
    expect(treeHash(root)).toBe(before);
  };

  test("an owner's answer or approval", async () => {
    await refused(["reply", "--readback", "rb_1", "--verdict", "yes", "--text", "yes", "--by", "Owner"], "is sl reply, which records the owner's answer or approval");
    await refused(["approve", "--target", "warehouse.orders", "--by", "Owner"], "is sl approve, which records the owner's answer or approval");
    await refused(["goldens", "confirm", "--name", "x"], "is sl goldens confirm, which records");
    await refused(["question", "resolve", "warehouse.orders", "--index", "1", "--text", "Yes.", "--by", "Owner"], "is sl question resolve, which records");
  });

  test("a command that reads a database or does more than change layer files", async () => {
    for (const entry of [["profile", "--source", "warehouse"], ["readback", "--targets", "warehouse.orders"], ["check-join", "--source", "warehouse"], ["goldens", "run"], ["status"], ["apply", "--file", "x"], ["init", "--name", "x"]])
      await refused(entry, `is sl ${entry[0] === "goldens" ? "goldens run" : entry[0]}, which is not a typed edit`, "run it on its own");
  });

  test("an entry that passes the batch's own flags, or is not a list of words", async () => {
    await refused(["set", "warehouse.orders", "grain", "x", "--json"], "passes --json, which sl apply gives every entry itself");
    await refused(["set", "warehouse.orders", "grain", "x", "--root=/elsewhere"], "passes --root");
    await refused("set warehouse.orders grain x", "is not a list of words");
    await refused([], "is not a list of words");
    await refused(["set", 1], "is not a list of words");
  });
});

describe("the role check holds each entry to the role's commands", () => {
  const limited: Role = { ...ROLES.golden_builder, commands: ["apply", "set"] };

  test("each entry is checked as if the role ran it on its own", () => {
    expect(applyEntryRefusal(["set", "warehouse.orders", "grain", "x"], limited)).toBeUndefined();
    expect(applyEntryRefusal(["tag", "warehouse.orders.status", "pii"], limited)).toContain("the golden builder may not run sl tag");
    expect(applyEntryRefusal(["tag", "warehouse.orders.status", "pii"], ROLES.interviewer)).toBeUndefined();
    const text = JSON.stringify({ edits: [["set", "a.b", "grain", "x"], ["tag", "a.b.c", "pii"], ["approve", "--target", "a.b"]] });
    expect(applyFileRefusals(limited, text)).toEqual([
      expect.stringContaining("entry 2 of sl apply is refused for the golden builder: the golden builder may not run sl tag"),
      expect.stringContaining("entry 3 of sl apply is sl approve, which records the owner's answer or approval"),
    ]);
    expect(applyFileRefusals(ROLES.interviewer, text)).toEqual([expect.stringContaining("entry 3 of sl apply is sl approve")]);
  });

  test("every entry kind sl apply runs is a command", async () => {
    const { COMMANDS } = await import("../skills/semantic-layer/scripts/commands/index.ts");
    for (const c of APPLY_COMMANDS) expect(COMMANDS[c.split(" ")[0]!]).toBeDefined();
  });

  test("the hook lets the interviewer run sl apply and refuses it to a role that may not", () => {
    const call = (agent: string, command: string): Verdict =>
      checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir, agent_type: agent, agent_id: "a1" }));
    const file = editsFile([TWELVE[0]]);
    expect(call("sl-interviewer", `bun ${SL} apply --file ${file} --root ${root}`).allow).toBe(true);
    const v = call("sl-golden-builder", `bun ${SL} apply --file ${file} --root ${root}`);
    expect(v.allow).toBe(false);
    expect(v.message).toContain("may not run sl apply");
  });
});

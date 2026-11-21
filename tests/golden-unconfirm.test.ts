import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { readChangelog } from "../skills/semantic-layer/scripts/lib/release.ts";
import type { Golden } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { reapprove, recordReply, semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// A golden's life in a change round (spec: goldens, Closing a round): a moved golden the owner cannot check
// now is returned to draft with semlayer goldens unconfirm, the close leaves it out and names it, and a later
// round confirms it again. On a copy of the example layer, whose lake source is DuckDB over fixtures/acme/data.

const DATA = resolve(import.meta.dir, "..", "fixtures", "acme", "data");
const SPEND = "lake.marketing_spend.spend";
// The three confirmed goldens that read the spend measure: the example's two and one this file adds.
const READERS = ["spend_2025", "spend_by_channel_2025", "spend_h1_2025"];
const H1 = {
  source: "lake",
  measures: ["marketing_spend.spend"],
  filters: [
    { field: "marketing_spend.spend_date", op: "gte", value: "2025-01-01" },
    { field: "marketing_spend.spend_date", op: "lt", value: "2025-07-01" },
  ],
};

interface Refusal {
  error: string;
  code: string;
  next: string;
}

const golden = (root: string, name: string) => readYaml<Golden>(join(root, "goldens", `${name}.yaml`));
const goldenText = (root: string, name: string) => readFileSync(join(root, "goldens", `${name}.yaml`), "utf8");

async function ok(root: string, args: string[]) {
  const r = await semlayer(root, args);
  if (r.code !== 0) throw new Error(`semlayer ${args.join(" ")}: ${r.err}${r.out}`);
  return r;
}

async function confirm(root: string, name: string): Promise<void> {
  await recordReply(root, `golden:${name}`, { by: "Dana Ruiz" });
  await ok(root, ["goldens", "confirm", "--name", name]);
}

// The example layer released as 1.0 with every item approved and three confirmed goldens reading spend, then a
// round that doubles spend, approved on the owner's yes: the three goldens' figures move.
async function roundMovingSpend(): Promise<string> {
  const root = releaseFixture();
  const lake = join(root, "sources", "lake.yaml");
  writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("../../../fixtures/acme/data", DATA));
  await reapprove(root, ["warehouse.products.launched_on"]);
  // Their hand-written cross_check_sql would keep the old figures, so the copies drop it.
  for (const n of READERS.slice(0, 2)) {
    const path = join(root, "goldens", `${n}.yaml`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/cross_check_sql: \|\n(  .*\n)+/, ""));
  }
  await ok(root, ["goldens", "new", "--name", "spend_h1_2025", "--question", "What was marketing spend in the first half of 2025?", "--request", JSON.stringify(H1)]);
  await recordReply(root, "golden:spend_h1_2025", { by: "Dana Ruiz" });
  await ok(root, ["goldens", "confirm", "--name", "spend_h1_2025"]);
  await ok(root, ["change", "close", "--version", "1.0"]);
  await ok(root, ["change", "start", "--note", "Count spend twice", "--by", "Dana Ruiz"]);
  await ok(root, ["set", SPEND, "expr", "spend_cents * 0.02"]);
  await reapprove(root, [SPEND]);
  return root;
}

const next = async (root: string) => (await semlayer(root, ["next", "--json"])).json<NextAction>();

describe("the walkthrough's round: one moved golden confirmed again, two unconfirmed", () => {
  test("next names the goldens before the close, the close leaves the unconfirmed ones out and names them, and a later round brings one back", async () => {
    const root = await roundMovingSpend();
    // Every item is approved: next offers the close and names the three goldens that read spend, the check to run
    // first and both ways to settle one that moved. The close itself refuses while a moved one is still confirmed.
    const a = await next(root);
    expect(a.phase).toBe("change");
    expect(a.action).toEqual({ command: "change", args: ["close", "--version", "1.1"], kind: "run" });
    for (const g of READERS) expect(a.why).toContain(g);
    expect(a.why).toContain("run semlayer goldens check");
    expect(a.why).toContain("semlayer readback --targets golden:<g>");
    expect(a.why).toContain("semlayer goldens unconfirm --name <g>");
    expect((await semlayer(root, ["change", "close", "--version", "1.1"])).code).not.toBe(0);

    // The owner re-confirms one; the other two she cannot check from memory.
    await confirm(root, "spend_2025");
    const was = golden(root, "spend_by_channel_2025");
    const unconfirm = await semlayer(root, ["goldens", "unconfirm", "--name", "spend_by_channel_2025", "--reason", "can't check that one from memory", "--json"]);
    expect(unconfirm.code).toBe(0);
    expect(unconfirm.json()).toEqual({
      changed: [{ target: "golden:spend_by_channel_2025", from: "approved", to: "draft" }],
      file: "goldens/spend_by_channel_2025.yaml",
      reason: "can't check that one from memory",
      next: "semlayer readback --targets golden:spend_by_channel_2025",
    });
    // One moved golden is still confirmed on the old figures: next names it alone, and the close still refuses.
    const b = await next(root);
    expect(b.why).toContain("1 confirmed golden(s) read an item the round changed and have not been confirmed since (spend_h1_2025)");
    const refused = await semlayer(root, ["change", "close", "--version", "1.1"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("spend_h1_2025");
    expect(refused.err).toContain("semlayer goldens unconfirm --name spend_h1_2025");
    const plain = await ok(root, ["goldens", "unconfirm", "--name", "spend_h1_2025"]);
    expect(plain.out).toContain("Unconfirmed golden:spend_h1_2025 (approved -> draft).");
    expect(plain.out).toContain("Next: when the owner can check its figures, semlayer readback --targets golden:spend_h1_2025");

    // A draft keeps its question, request, reference and tolerance, and nothing that looks confirmed.
    const g = golden(root, "spend_by_channel_2025");
    expect(g.status).toBe("draft");
    expect(g.expected).toEqual({ tolerance: 0, rows: [] });
    for (const k of ["confirmed_by", "confirmed_at", "confirmed_as"]) expect(k in g).toBe(false);
    for (const k of ["name", "question", "request", "reference"] as const) expect(g[k]).toEqual(was[k]);
    expect(golden(root, "spend_h1_2025").expected).toEqual({ tolerance: 0.005, rows: [] });
    // The owner's yes it set aside is named, so next offers no confirm on it; the example's golden has none recorded.
    expect(golden(root, "spend_h1_2025").unconfirmed_yes).toMatch(/^ans_\d{4,}$/);
    expect("unconfirmed_yes" in g).toBe(false);

    const c = await next(root);
    expect(c.action).toEqual({ command: "change", args: ["close", "--version", "1.1"], kind: "run" });
    expect(c.why).not.toContain("have not been confirmed since");
    const r = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ changed: string[]; goldens_moved: { golden: string }[]; goldens_unconfirmed: string[]; goldens_removed: string[] }>();
    expect(out.changed).toEqual([SPEND]);
    expect(out.goldens_moved.map((m) => m.golden)).toEqual(["spend_2025"]);
    expect(out.goldens_unconfirmed).toEqual(["spend_by_channel_2025", "spend_h1_2025"]);
    expect(out.goldens_removed).toEqual([]);
    const entry = readChangelog(root)!.entries[1]!;
    expect(entry.changed).toEqual([SPEND]);
    expect(entry.goldens_moved.map((m) => m.golden)).toEqual(["spend_2025"]);
    expect(entry.goldens_unconfirmed).toEqual(["spend_by_channel_2025", "spend_h1_2025"]);
    expect("goldens_removed" in entry).toBe(false);
    expect(Object.keys(entry.goldens)).not.toContain("spend_by_channel_2025");
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
    const st = (await semlayer(root, ["status", "--json"])).json<{ draft_goldens: string[] }>();
    expect(st.draft_goldens).toEqual(expect.arrayContaining(["spend_by_channel_2025", "spend_h1_2025"]));
    // At rest: phase done (the example's older approvals still ask for their readback), a new round when the owner asks for one.
    const d = await next(root);
    expect(d.phase).toBe("done");
    expect(d.action.command).not.toBe("goldens");
    expect(d.why).toContain("semlayer change start");

    // goldens check passes over the drafts; --name refuses one, as any golden without rows.
    const check = (await semlayer(root, ["goldens", "check", "--source", "lake", "--json"])).json<{ results: { name: string }[] }>();
    expect(check.results.map((x) => x.name)).not.toContain("spend_by_channel_2025");
    expect(check.results.map((x) => x.name)).toContain("spend_2025");
    expect((await semlayer(root, ["goldens", "check", "--name", "spend_h1_2025"])).code).toBe(1);

    // A later round: the owner checks one of them, and the next release holds it again.
    await ok(root, ["change", "start", "--note", "Confirm channel spend", "--by", "Dana Ruiz"]);
    await confirm(root, "spend_by_channel_2025");
    expect((await next(root)).action).toEqual({ command: "change", args: ["close", "--version", "1.2"], kind: "run" });
    await ok(root, ["change", "close", "--version", "1.2"]);
    const third = readChangelog(root)!.entries[2]!;
    expect(third.goldens.spend_by_channel_2025).toEqual(golden(root, "spend_by_channel_2025").expected!.rows);
    // Release 1.1 did not hold the other, so 1.2 neither holds it nor names it again.
    expect(third.goldens.spend_h1_2025).toBeUndefined();
    expect(third.goldens_unconfirmed).toBeUndefined();
    // Confirmed again on a new yes, it no longer names the one set aside.
    await confirm(root, "spend_h1_2025");
    expect("unconfirmed_yes" in golden(root, "spend_h1_2025")).toBe(false);
  });

  test("a moved golden neither confirmed again nor unconfirmed refuses the close, naming both ways to settle it", async () => {
    const root = await roundMovingSpend();
    await confirm(root, "spend_2025");
    await ok(root, ["goldens", "unconfirm", "--name", "spend_by_channel_2025"]);
    const before = existsSync(join(root, "changelog.yaml")) ? readFileSync(join(root, "changelog.yaml"), "utf8") : null;
    const r = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
    expect(r.code).toBe(1);
    const j = r.json<Refusal>();
    expect(j.code).toBe("release.close_blocked");
    expect(j.error).toContain("golden spend_h1_2025's figures moved");
    expect(j.error).toContain("semlayer goldens confirm --name spend_h1_2025");
    expect(j.error).toContain("semlayer goldens unconfirm --name spend_h1_2025");
    expect(j.error).not.toContain("spend_by_channel_2025");
    expect(j.next).toBe("semlayer readback --targets golden:spend_h1_2025");
    expect(readFileSync(join(root, "changelog.yaml"), "utf8")).toBe(before!);
  });
});

describe("goldens unconfirm refusals", () => {
  test("a draft golden or an unknown name is refused with a next step and a code, writing nothing", async () => {
    const root = releaseFixture();
    const text = goldenText(root, "new_customers_2025");
    const draft = await semlayer(root, ["goldens", "unconfirm", "--name", "new_customers_2025", "--json"]);
    expect(draft.code).toBe(1);
    expect(draft.json<Refusal>()).toMatchObject({ code: "golden.not_confirmed", next: "semlayer readback --targets golden:new_customers_2025" });
    expect(goldenText(root, "new_customers_2025")).toBe(text);
    const unknown = await semlayer(root, ["goldens", "unconfirm", "--name", "no_such_golden", "--json"]);
    expect(unknown.code).toBe(1);
    expect(unknown.json<Refusal>()).toMatchObject({ code: "golden.unknown", next: "semlayer status" });
    const plain = await semlayer(root, ["goldens", "unconfirm", "--name", "no_such_golden"]);
    expect(plain.err).toContain("There is no golden \"no_such_golden\"");
    expect(plain.err).toContain("semlayer status");
    const noName = await semlayer(root, ["goldens", "unconfirm", "--json"]);
    expect(noName.json<Refusal>().code).toBe("golden.unknown");
    // --reason goes with unconfirm only.
    expect((await semlayer(root, ["goldens", "run", "--name", "spend_2025", "--reason", "x"])).code).toBe(1);
  });

  test("confirm refuses the yes that unconfirm set aside, writing nothing, until the owner says yes again", async () => {
    const root = releaseFixture();
    const lake = join(root, "sources", "lake.yaml");
    writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("../../../fixtures/acme/data", DATA));
    await recordReply(root, "golden:spend_2025", { by: "Dana Ruiz" });
    await ok(root, ["goldens", "confirm", "--name", "spend_2025"]);
    await ok(root, ["goldens", "unconfirm", "--name", "spend_2025"]);
    const text = goldenText(root, "spend_2025");
    const r = await semlayer(root, ["goldens", "confirm", "--name", "spend_2025", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json<Refusal>().error).toContain("set aside");
    expect(r.json<Refusal>().error).toContain("semlayer readback --targets golden:spend_2025");
    expect(goldenText(root, "spend_2025")).toBe(text);
    await recordReply(root, "golden:spend_2025", { by: "Dana Ruiz" });
    await ok(root, ["goldens", "confirm", "--name", "spend_2025"]);
    expect(golden(root, "spend_2025").status).toBe("approved");
  });

  test("it keeps the file's comments and runs inside semlayer apply", async () => {
    const root = releaseFixture();
    const path = join(root, "goldens", "spend_2025.yaml");
    writeFileSync(path, `# The owner's figure from the 2025 budget.\n${readFileSync(path, "utf8")}`);
    const file = join(root, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [["goldens", "unconfirm", "--name", "spend_2025"]] }));
    expect((await semlayer(root, ["apply", "--file", file])).code).toBe(0);
    expect(readFileSync(path, "utf8")).toStartWith("# The owner's figure from the 2025 budget.\n");
    expect(golden(root, "spend_2025").status).toBe("draft");
  });
});

describe("the guard hook", () => {
  test("a hand edit that returns a confirmed golden to draft is refused, naming goldens unconfirm", () => {
    const root = releaseFixture();
    const file = join(root, "goldens", "spend_2025.yaml");
    const v = checkToolUse(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: "status: approved", new_string: "status: draft" }, cwd: root }),
    );
    expect(v.allow).toBe(false);
    expect(v.message).toContain("semlayer goldens unconfirm --name spend_2025");
  });
});

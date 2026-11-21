import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { itemMap } from "../skills/semantic-layer/scripts/lib/changeset.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { appendEntry } from "../skills/semantic-layer/scripts/lib/release.ts";
import type { ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import { FIXED_NOW, semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// semlayer change start and phase `change` (spec: Iterating a layer, The change round), on a copy of the
// example layer.

const START = ["change", "start", "--note", "Add a revenue per item figure", "--by", "Sam"];

// Records the layer as it stands as release 1.0, as semlayer change close does, without its checks and without the drafts never approved.
function release(root: string): void {
  appendEntry(root, {
    version: "1.0",
    date: "2026-02-03",
    note: "First release.",
    items: Object.fromEntries([...itemMap(root)].filter(([, v]) => !v.plain).map(([ref, v]) => [ref, v.hash])),
    goldens: {},
    added: [],
    changed: [],
    removed: [],
    goldens_moved: [],
  });
  writeFileSync(join(root, "semantic.yaml"), `${readFileSync(join(root, "semantic.yaml"), "utf8").trimEnd()}\nlayer_version: "1.0"\n`);
}

const next = async (root: string) => (await semlayer(root, ["next", "--json"])).json<NextAction>();
const status = async (root: string) => (await semlayer(root, ["status", "--json"])).json<ProjectStatus>();
const mentions = (text: string, phrase: string) => text.split(phrase).length - 1;
const changeFile = (root: string) => join(root, ".semlayer", "change.json");
const changeRecord = (root: string) => JSON.parse(readFileSync(changeFile(root), "utf8")) as { drafts_at_start?: string[] };

describe("change start", () => {
  test("is refused without a note or a name, with a code and the command to run", async () => {
    const root = releaseFixture();
    release(root);
    for (const args of [["change", "start", "--by", "Sam"], ["change", "start", "--note", "x"], ["change", "start", "--note", "  ", "--by", "Sam"]]) {
      const r = await semlayer(root, [...args, "--json"]);
      expect(r.code).toBe(1);
      expect(r.json<{ code: string; next: string }>()).toMatchObject({ code: "release.change_missing_input", next: expect.stringContaining("semlayer change start --note") });
    }
    expect(existsSync(changeFile(root))).toBe(false);
  });

  test("a note over 500 characters or a name over 200 is refused and nothing is written", async () => {
    const root = releaseFixture();
    release(root);
    for (const args of [["--note", "x".repeat(501), "--by", "Sam"], ["--note", "ok", "--by", "y".repeat(201)]]) {
      const r = await semlayer(root, ["change", "start", ...args, "--json"]);
      expect(r.code).toBe(1);
      expect(r.json<{ code: string; next: string }>()).toMatchObject({ code: "release.change_too_long", next: expect.stringContaining("semlayer change start --note") });
      expect(existsSync(changeFile(root))).toBe(false);
    }
  });

  test("is refused on a layer with no release, naming the first release", async () => {
    const root = releaseFixture();
    const r = await semlayer(root, [...START, "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ code: "release.change_unreleased", next: "semlayer change close --version 1.0" });
    expect(existsSync(changeFile(root))).toBe(false);
  });

  test("writes the note, who and when from the clock, and the release it started from", async () => {
    const root = releaseFixture();
    release(root);
    const r = await semlayer(root, [...START, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ started: true, note: "Add a revenue per item figure", started_by: "Sam", started_at: FIXED_NOW, from_version: "1.0", next: "semlayer next" });
    expect(JSON.parse(readFileSync(changeFile(root), "utf8"))).toEqual({ version: 1, note: "Add a revenue per item figure", started_by: "Sam", started_at: FIXED_NOW, from_version: "1.0", drafts_at_start: ["warehouse.products.launched_on"] });
    const plain = await semlayer(root, ["change", "status"]);
    expect(plain.code).toBe(0);
  });

  test("a second start while a round is open is refused and names change status", async () => {
    const root = releaseFixture();
    release(root);
    expect((await semlayer(root, START)).code).toBe(0);
    const before = readFileSync(changeFile(root), "utf8");
    const r = await semlayer(root, ["change", "start", "--note", "Another", "--by", "Kim", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ code: "release.change_open", next: "semlayer change status" });
    expect(readFileSync(changeFile(root), "utf8")).toBe(before);
  });

  test("status takes no start flags, and an unknown subcommand is refused", async () => {
    const root = releaseFixture();
    release(root);
    expect((await semlayer(root, ["change", "status", "--note", "x"])).code).toBe(1);
    expect((await semlayer(root, ["change", "begin"])).code).toBe(1);
  });
});

describe("phase change", () => {
  test("a released layer's next names change start once, and after start it does not", async () => {
    const root = releaseFixture();
    release(root);
    const before = await next(root);
    expect(before.phase).toBe("done");
    expect(mentions(before.why, "semlayer change start")).toBe(1);
    expect(before.why).toContain("release 1.0");
    // The coverage checklist is ticked before the first release's handoff, not again after it.
    expect(before.why).not.toContain("coverage checklist");
    expect((await status(root)).next_step.message).toContain("semlayer change start");
    expect((await status(root)).next_step.message).not.toContain("coverage checklist");
    expect((await semlayer(root, START)).code).toBe(0);
    const after = await next(root);
    expect(after.phase).toBe("change");
    expect(after.why).not.toContain("semlayer change start");
    // The round has nothing pending, so the last step closes it, with the version the owner chooses.
    expect(after.kind).toBe("run");
    expect(after.action).toEqual({ command: "change", args: ["close", "--version", "1.1"], kind: "run" });
    expect(after.run?.command).toBe("semlayer change close --version 1.1");
    expect(after.why).toContain("I suggest 1.1");
    expect(after.why).not.toContain("not available");
  });

  test("a layer with no release is led to the first release, not to change start", async () => {
    const root = releaseFixture();
    const a = await next(root);
    expect(a.phase).toBe("done");
    expect(a.why).toContain("semlayer change close --version 1.0");
    expect(a.why).not.toContain("semlayer change start");
    expect((await status(root)).next_step.message).toContain("record it as release 1.0");
    expect((await status(root)).next_step.message).toContain("Before the handoff, tick the coverage checklist");
  });

  test("status --json shows the layer version and the open round", async () => {
    const root = releaseFixture();
    expect(await status(root)).toMatchObject({ layer_version: null, change: null });
    release(root);
    expect(await status(root)).toMatchObject({ layer_version: "1.0", change: null });
    await semlayer(root, START);
    const s = await status(root);
    expect(s.layer_version).toBe("1.0");
    expect(s.change).toEqual({ version: 1, note: "Add a revenue per item figure", started_by: "Sam", started_at: FIXED_NOW, from_version: "1.0", drafts_at_start: ["warehouse.products.launched_on"] });
    expect(s.next_step.phase).toBe("change");
  });

  test("after start and add-metric, next names the metrics phase, then the readback of the new item", async () => {
    const root = releaseFixture();
    release(root);
    await semlayer(root, START);
    const add = await semlayer(root, ["add-metric", "--name", "revenue_per_item", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count"]);
    expect(add.code).toBe(0);
    const a = await next(root);
    expect(a.phase).toBe("metrics");
    // The new metric lacks a description, so its readback is first the apply that gives it one.
    expect(a.action.command).toBe("apply");
    expect(JSON.stringify(a.action)).toContain("metric:revenue_per_item");
    expect(a.why).toContain("A change round is open");
  });

  test("a described new metric is named for readback in the metrics phase until the owner's yes", async () => {
    const root = releaseFixture();
    release(root);
    await semlayer(root, START);
    await semlayer(root, ["add-metric", "--name", "revenue_per_item", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--description", "Revenue per order."]);
    const a = await next(root);
    expect(a).toMatchObject({ phase: "metrics", action: { command: "readback", args: ["--targets", "metric:revenue_per_item"] } });
    expect(a.why).toContain("wait for the owner's yes");
  });

  test("a draft present before the round is deferred: next offers the close, and the close lists it as left out", async () => {
    const root = releaseFixture();
    release(root);
    expect((await semlayer(root, START)).code).toBe(0);
    expect(changeRecord(root).drafts_at_start).toEqual(["warehouse.products.launched_on"]);
    const a = await next(root);
    expect(a.action).toEqual({ command: "change", args: ["close", "--version", "1.1"], kind: "run" });
    expect(a.why).toContain("Drafts the owner deferred, which the release leaves out (1): warehouse.products.launched_on");
    expect(a.why).not.toContain("wait for the owner's yes");
    const c = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
    expect(c.code).toBe(0);
    expect(c.json<{ drafts_left_out: string[] }>().drafts_left_out).toEqual(["warehouse.products.launched_on"]);
  });

  test("an approved item the round revoked is read back before the close, even in the metrics phase's words", async () => {
    const root = releaseFixture();
    release(root);
    await semlayer(root, START);
    expect((await semlayer(root, ["approve", "--target", "warehouse.orders.revenue", "--revoke"])).code).toBe(0);
    const a = await next(root);
    expect(a.phase).toBe("change");
    expect(a.action).toMatchObject({ command: "readback", args: ["--targets", "warehouse.orders.revenue"] });
    expect(a.why).toContain("wait for the owner's yes");
  });

  test("an edit to an approved item sends it to reapprove, and a new metric is read back, approved, then the round closes", async () => {
    const root = releaseFixture();
    release(root);
    await semlayer(root, START);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "filter", "status = 'completed'"])).code).toBe(0);
    expect((await next(root)).phase).toBe("reapprove");
    expect((await semlayer(root, ["approve", "--target", "warehouse.orders.revenue", "--revoke"])).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "filter", "status = 'completed' and amount_cents > 0"])).code).toBe(0);
    // Only the new metric is left to read back: the change has nothing else pending.
    const add = await semlayer(root, ["add-metric", "--name", "revenue_per_item", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count", "--description", "Revenue per order."]);
    expect(add.code).toBe(0);
    const rb = await semlayer(root, ["readback", "--targets", "warehouse.orders.revenue,metric:revenue_per_item", "--json"]);
    expect(rb.code).toBe(0);
    const id = rb.json<{ readback_id: string }>().readback_id;
    for (const n of [1, 2]) expect((await semlayer(root, ["reply", "--readback", id, "--item", String(n), "--text", "yes", "--verdict", "yes", "--by", "Sam"])).code).toBe(0);
    for (const t of ["warehouse.orders.revenue", "metric:revenue_per_item"]) expect((await semlayer(root, ["approve", "--target", t])).code).toBe(0);
    // Every item is approved: the close is offered, and its why names the confirmed goldens that read revenue.
    const a = await next(root);
    expect(a.phase).toBe("change");
    expect(a.action.command).toBe("change");
    expect(a.why).toContain("run semlayer goldens check");
    expect(a.why).toContain("semlayer readback --targets golden:<g>");
    const st = (await semlayer(root, ["change", "status", "--json"])).json<{ added: string[]; changed: { ref: string; state: string }[] }>();
    expect(st.added).toContain("metric:revenue_per_item");
    expect(st.changed.map((c) => `${c.ref} ${c.state}`)).toContain("warehouse.orders.revenue approved");
  });

  test("a change.json that does not read leaves the phases alone and validate names it", async () => {
    const root = releaseFixture();
    release(root);
    mkdirSync(join(root, ".semlayer"), { recursive: true });
    writeFileSync(changeFile(root), '{"version": 1, "note": ""}');
    const s = await status(root);
    expect(s.change).toBeNull();
    expect(s.next_step.phase).toBe("done");
    const v = await semlayer(root, ["validate", "--json"]);
    expect(JSON.stringify(v.json())).toContain("release.change_malformed");
    const r = await semlayer(root, [...START, "--json"]);
    expect(r.json()).toMatchObject({ code: "release.change_malformed" });
  });
});

describe("the hook guards .semlayer/change.json", () => {
  const call = (tool: string, input: Record<string, unknown>, cwd: string) => checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd }));

  test("a hand edit, write or shell redirect is refused, as the ledger and the changelog are", () => {
    const root = releaseFixture();
    const file = changeFile(root);
    for (const v of [
      call("Write", { file_path: file, content: "{}" }, root),
      call("Edit", { file_path: file, old_string: "a", new_string: "b" }, root),
      call("Bash", { command: `echo '{}' > ${file}` }, root),
      call("Bash", { command: `rm ${file}` }, root),
    ]) {
      expect(v.allow).toBe(false);
      expect(v.message).toContain(".semlayer/change.json");
      expect(v.message).toContain("semlayer change start");
    }
    expect(call("Write", { file_path: join(root, "changelog.yaml"), content: "x" }, root).allow).toBe(false);
  });
});

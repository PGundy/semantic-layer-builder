// A revoke withdraws the owner's recorded answers (spec: Approval requires a recorded yes): semlayer
// approve --revoke records a kind: revoke line, after which a stamp put back by a file write is a
// draft for every reader and approving again takes a new readback and yes. On copies of examples/acme.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalLedger, ledgerReplies, openAccessChanges } from "../skills/semantic-layer/scripts/lib/ledger.ts";
import { semlayer, tempRoot } from "./helpers.ts";

const EXAMPLE = join(import.meta.dir, "..", "examples", "acme", "semantic");
const DISCOUNT = "warehouse.orders.discount";
const ORDERS = (root: string) => join(root, "models", "warehouse", "orders.yaml");
const ledger = (root: string) => readFileSync(join(root, ".semlayer", "ledger.jsonl"), "utf8");
const lines = (root: string) =>
  ledger(root)
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// A copy of the example layer, whose ledger backs every approval with the owner's confirmation.
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function acme(): string {
  const { root, cleanup } = tempRoot();
  cleanups.push(cleanup);
  cpSync(EXAMPLE, root, { recursive: true });
  return root;
}

async function ok(root: string, args: string[]): Promise<string> {
  const r = await semlayer(root, args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.out;
}

describe("semlayer approve --revoke withdraws the owner's recorded answer", () => {
  test("it records one revoke line, and a stamp put back by a file write is a draft for every reader", async () => {
    const root = acme();
    const approved = readFileSync(ORDERS(root), "utf8");
    const out = await ok(root, ["approve", "--target", DISCOUNT, "--revoke"]);
    expect(out).toContain(`Revoked ${DISCOUNT} (approved -> draft).`);
    expect(out).toContain(`Recorded ans_0002 in .semlayer/ledger.jsonl: the owner's recorded yes to ${DISCOUNT} no longer stands`);
    const last = lines(root).at(-1)!;
    expect(Object.keys(last)).toEqual(["at", "id", "kind", "targets"]);
    expect(last).toMatchObject({ id: "ans_0002", kind: "revoke", targets: [{ target: DISCOUNT }] });
    expect((await semlayer(root, ["validate"])).code).toBe(0);

    // The approved file comes back as it was, stamp and hash included, with no readback.
    writeFileSync(ORDERS(root), approved);
    const v = await semlayer(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const issues = v.json<{ issues: { code: string; message: string }[] }>().issues.filter((i) => i.code === "approval.no_recorded_yes");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain(`${DISCOUNT} says it is approved by Dana Ruiz, but no recorded yes`);
    // The one-time confirmation is already in the ledger, so the message does not offer it.
    expect(issues[0]!.message).not.toContain("--confirm-existing");
    const st = (await semlayer(root, ["status", "--json"])).json<{ stamped_without_yes: string[]; next_step: { phase: string; message: string } }>();
    expect(st.stamped_without_yes).toEqual([DISCOUNT]);
    expect(st.next_step.phase).toBe("reapprove");
    expect(st.next_step.message).not.toContain("--confirm-existing");
    const access = await ok(root, ["access"]);
    expect(access).toContain(`measure ${DISCOUNT}: hidden (draft)`);
  });

  test("approving again takes a new readback and yes: the earlier answer no longer counts", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", DISCOUNT, "--revoke"]);
    const refused = await semlayer(root, ["approve", "--target", DISCOUNT]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`Cannot approve ${DISCOUNT}: no owner reply to its readback is recorded; nothing was approved.`);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", DISCOUNT, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes, that is the discount.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(await ok(root, ["approve", "--target", DISCOUNT])).toContain(`Approved ${DISCOUNT} (draft -> approved) by Dana Ruiz`);
    expect(lines(root).map((l) => l.kind)).toEqual(["confirm", "revoke", "reply"]);
    const v = await semlayer(root, ["validate", "--json"]);
    expect(v.json<{ issues: { code: string }[] }>().issues.filter((i) => i.code.startsWith("approval."))).toEqual([]);
  });

  test("a second revoke of the same item writes no second line, and a revoke of a draft withdraws a yes waiting for approve", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", DISCOUNT, "--revoke"]);
    const again = await ok(root, ["approve", "--target", DISCOUNT, "--revoke"]);
    expect(again).toContain("already a draft; nothing changed.");
    expect(lines(root)).toHaveLength(2);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", DISCOUNT, "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    const out = await ok(root, ["approve", "--target", DISCOUNT, "--revoke", "--json"]);
    expect(JSON.parse(out)).toEqual({ changed: [], warnings: [], withdrawn: [DISCOUNT], ledger: "ans_0004" });
    expect((await semlayer(root, ["approve", "--target", DISCOUNT])).code).toBe(1);
  });

  test("--recursive names every item under the model in one line", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "warehouse.refunds", "--revoke", "--recursive"]);
    const all = lines(root);
    expect(all).toHaveLength(2);
    const targets = (all[1]!.targets as { target: string }[]).map((t) => t.target);
    expect(targets[0]).toBe("warehouse.refunds");
    expect(targets.length).toBeGreaterThan(3);
    expect(targets.every((t) => t === "warehouse.refunds" || t.startsWith("warehouse.refunds."))).toBe(true);
  });

  test("a project with no ledger gets none from a revoke, so its other approvals keep counting", async () => {
    const root = acme();
    writeFileSync(join(root, ".semlayer", "ledger.jsonl"), "");
    const out = await ok(root, ["approve", "--target", DISCOUNT, "--revoke"]);
    expect(out).not.toContain("Recorded");
    expect(ledger(root)).toBe("");
    const v = await semlayer(root, ["validate", "--json"]);
    expect(v.code).toBe(0);
    expect(v.json<{ issues: { code: string }[] }>().issues.filter((i) => i.code === "approval.no_recorded_yes")).toEqual([]);
  });
});

describe("the ledger as its readers see it after a revoke", () => {
  const reply = (id: string, target: string, verdict: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ at: "2026-01-15T12:00:00.000Z", by: "Dana", content_hash: "sha256:" + "a".repeat(64), id, item: 1, kind: "reply", readback_id: "rb_0001", target, text: "x", verdict, ...extra });
  const revoke = (id: string, ...targets: string[]) => JSON.stringify({ at: "2026-01-16T12:00:00.000Z", id, kind: "revoke", targets: targets.map((target) => ({ target, content_hash: "sha256:" + "a".repeat(64) })) });
  const confirm = (id: string, ...targets: string[]) =>
    JSON.stringify({ at: "2026-01-14T12:00:00.000Z", by: "Dana", id, kind: "confirm", targets: targets.map((target) => ({ target, content_hash: "sha256:" + "a".repeat(64) })), text: "They stand." });
  const text = (...l: string[]) => l.join("\n") + "\n";
  const entry = (target: string) => ({ ref: target, hash: "sha256:" + "a".repeat(64), definitionHash: "sha256:" + "a".repeat(64) });

  test("earlier replies to a revoked target are left out, later ones and other targets stay", () => {
    const t = text(reply("ans_0001", "s.m.a", "yes"), reply("ans_0002", "s.m.b", "yes"), revoke("ans_0003", "s.m.a"), reply("ans_0004", "s.m.a", "no"));
    expect(ledgerReplies(t, true).map((r) => r.id)).toEqual(["ans_0002", "ans_0004"]);
    const l = approvalLedger(text(reply("ans_0001", "s.m.a", "yes"), reply("ans_0002", "s.m.b", "yes"), revoke("ans_0003", "s.m.a")));
    expect(l.latest.get("s.m.a")).toEqual({ revoked: true });
    expect("reply" in l.latest.get("s.m.b")!).toBe(true);
  });

  test("a revoke takes a target out of an earlier confirmation, which still counts as given", () => {
    const l = approvalLedger(text(confirm("ans_0001", "s.m.a", "s.m.b"), revoke("ans_0002", "s.m.a")));
    expect(l.confirmedBefore).toBe(true);
    expect(l.latest.get("s.m.a")).toEqual({ revoked: true });
    expect(l.latest.get("s.m.b")).toEqual({ confirmed: entry("s.m.b").hash });
  });

  test("revoking access withdraws the access changes its yes had settled, and keeps one recorded after that yes", () => {
    const change = (id: string) => reply(id, "s.m.a", "change", { about: "access" });
    const t = text(change("ans_0001"), reply("ans_0002", "access", "yes"), change("ans_0003"), revoke("ans_0004", "access"));
    const replies = ledgerReplies(t, true);
    expect(replies.map((r) => r.id)).toEqual(["ans_0003"]);
    expect(openAccessChanges(replies).map((r) => r.id)).toEqual(["ans_0003"]);
  });

  test("a revoke line without its fields makes the strict read refuse, and validate reports its schema", async () => {
    const bad = text(JSON.stringify({ at: "2026-01-16T12:00:00.000Z", id: "ans_0001", kind: "revoke", targets: [{ target: "s.m.a" }] }));
    expect(() => ledgerReplies(bad, true)).toThrow("line 1 is a revoke line without the fields an approval needs");
    expect(approvalLedger(bad).unreadable).toBe(true);
  });
});

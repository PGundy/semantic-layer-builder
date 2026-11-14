import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { DEFAULT_TOLERANCE } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import { ledgerLine } from "../skills/semantic-layer/scripts/lib/ledger.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { listGoldens } from "../skills/semantic-layer/scripts/lib/project.ts";
import type { ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Golden, LedgerEntry, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, sl, tempDir, tempRoot } from "./helpers.ts";

// sl next (FR-3.1), walked through copies of the Acme example layer. All data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const ORDERS = "warehouse.orders";

// A copy of the Acme example layer, with its connection variable set (to a synthetic URL nothing
// connects to) in the .env beside the root, as the owner would have it.
function acme(): string {
  const dir = tempDir();
  const root = join(dir, "semantic");
  cpSync(ACME, root, { recursive: true });
  writeFileSync(join(dir, ".env"), "WAREHOUSE_URL=postgres://reader:synthetic@localhost:5432/acme\n");
  return root;
}

// Every file under the root with a hash of its bytes, so a run that writes anything shows up.
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

// sl next --json, checked to write nothing and to print the same bytes twice; plus its plain output.
async function next(root: string): Promise<NextAction & { human: string }> {
  const before = tree(root);
  const a = await sl(root, ["next", "--json"]);
  const b = await sl(root, ["next", "--json"]);
  const human = await sl(root, ["next"]);
  expect(a.code).toBe(0);
  expect(a.err).toBe("");
  expect(b.out).toBe(a.out);
  expect(human.code).toBe(0);
  expect(tree(root)).toEqual(before);
  const action = a.json<NextAction>();
  expect(Object.keys(action).sort()).toEqual(
    ["action", "blocked_on", "kind", "phase", "why", ...(action.kind === "done" ? [] : [action.kind === "dispatch" ? "dispatch" : action.kind === "ask_owner" ? "ask_owner" : "run"]), ...(action.connection ? ["connection"] : [])].sort(),
  );
  // The printed command is the action's.
  if (action.kind === "run") expect(action.run!.command).toBe(["sl", action.action.command, ...action.action.args].join(" "));
  return { ...action, human: human.out };
}

async function status(root: string): Promise<ProjectStatus> {
  return (await sl(root, ["status", "--json"])).json<ProjectStatus>();
}

async function ok(root: string, args: string[]): Promise<string> {
  const r = await sl(root, args);
  if (r.code !== 0) throw new Error(`sl ${args.join(" ")}: ${r.err}`);
  return r.out;
}

async function reply(root: string, id: string, n: number, verdict: "yes" | "no" | "change" | null): Promise<void> {
  const args = ["reply", "--readback", id, "--item", String(n), "--text", "That's how we count it.", "--by", "Dana"];
  await ok(root, verdict === null ? args : [...args, "--verdict", verdict]);
}

// Acme with orders and its fields revoked to drafts, as a fresh interview of the model would see it.
async function ordersDraft(): Promise<string> {
  const root = acme();
  await ok(root, ["approve", "--target", ORDERS, "--revoke", "--recursive"]);
  return root;
}

// The refs status asks to read back for orders: its draft fields, then the model.
function readbackRefs(st: ProjectStatus): string[] {
  const m = /^sl readback --targets (\S+)$/.exec(st.next_step.command);
  expect(m).not.toBeNull();
  return m![1]!.split(",");
}

describe("sl next through the phases", () => {
  test("a fresh project -> ask the owner, then add-source", async () => {
    const root = join(tempDir(), "semantic");
    await initProject(root);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "add-source", blocked_on: null, action: { command: "add-source", args: ["--name", "<source>", "--dialect", "<dialect>"], kind: "ask_owner" } });
    expect(a.why).toContain("Ask the owner which database");
    expect(a.human).toBe(`Next (add-source): ${a.why}\n  Ask the owner, then: sl add-source --name <source> --dialect <dialect>`);
  });

  test("after introspect, with no profiles -> run profile", async () => {
    const root = acme();
    const file = join(root, "snapshots", "warehouse.json");
    const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    for (const t of snap.tables) {
      delete t.profiled_at;
      for (const c of t.columns) delete c.profile;
    }
    writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "profile", run: { command: "sl profile --source warehouse" } });
    expect(a.why).toContain("have no profile");
  });

  test("drafts present -> run the interview readback of the draft fields and the model", async () => {
    const root = await ordersDraft();
    const st = await status(root);
    expect(st.next_step).toMatchObject({ phase: "interview", after_owner_yes: false });
    const refs = readbackRefs(st);
    expect(refs.at(-1)).toBe(ORDERS);
    expect(refs).toContain(`${ORDERS}.revenue`);
    expect(refs.every((r) => r === ORDERS || r.startsWith(`${ORDERS}.`))).toBe(true);
    const a = await next(root);
    // Acme's models hold open questions, which wait on the owner meanwhile.
    expect(a).toMatchObject({ kind: "run", phase: "interview", run: { command: st.next_step.command }, why: st.next_step.message, blocked_on: "open_questions" });
    expect(a.human.split("\n")).toEqual([`Next (interview): ${a.why}`, `  Meanwhile: ${st.next_step.command}`]);
  });

  test("a pending readback -> ask_owner with its text and open items; a reply without a verdict leaves an item open", async () => {
    const root = await ordersDraft();
    const refs = [`${ORDERS}.revenue`, `${ORDERS}.order_count`, ORDERS];
    const rb = JSON.parse(await ok(root, ["readback", "--targets", refs.join(","), "--json"])) as { readback_id: string; items: { n: number; text: string }[] };
    let a = await next(root);
    expect(a.kind).toBe("ask_owner");
    expect(a.phase).toBe("interview");
    expect(a.ask_owner!.readback_id).toBe(rb.readback_id);
    expect(a.ask_owner!.items).toEqual(refs.map((target, i) => ({ n: i + 1, target, kind: "approve" })));
    expect(a.ask_owner!.text.startsWith(`1. ${rb.items[0]!.text.split("\n")[0]}`)).toBe(true);
    expect(a.ask_owner!.text).toContain(`\n\n3. ${ORDERS} (table)`);
    expect(a.why).toContain(`sl reply --readback ${rb.readback_id} --item <n>`);
    expect(a.human).toContain(`sl review export --readback ${rb.readback_id} --format md`);
    expect(a.human.split("\n")).toHaveLength(2);

    // Words without a verdict keep item 2 open; a no on item 3 closes it without approving it.
    await reply(root, rb.readback_id, 2, null);
    await reply(root, rb.readback_id, 3, "no");
    a = await next(root);
    expect(a.ask_owner!.items.map((i) => i.n)).toEqual([1, 2]);
    expect(a.ask_owner!.text).not.toContain(`${ORDERS} (table)`);
  });

  test("a recorded yes -> run sl approve, and status names it with after_owner_yes", async () => {
    const root = await ordersDraft();
    const rb = JSON.parse(await ok(root, ["readback", "--targets", `${ORDERS}.order_count,${ORDERS}.revenue`, "--json"])) as { readback_id: string };
    await reply(root, rb.readback_id, 2, "yes");
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "interview", run: { command: `sl approve --target ${ORDERS}.revenue` }, blocked_on: "open_questions" });
    expect(a.why).toContain("ans_0001");
    const st = await status(root);
    expect(st.next_step).toMatchObject({ phase: "interview", command: `sl approve --target ${ORDERS}.revenue`, after_owner_yes: true });
    expect((await sl(root, ["status"])).out).toContain(`meanwhile, only after the owner says yes to its readback: sl approve --target ${ORDERS}.revenue`);

    // Once approved, the open item 1 is what remains.
    await ok(root, ["approve", "--target", `${ORDERS}.revenue`]);
    const after = await next(root);
    expect(after.kind).toBe("ask_owner");
    expect(after.ask_owner!.items).toEqual([{ n: 1, target: `${ORDERS}.order_count`, kind: "approve" }]);
  });

  test("a yes to an item that changed since its readback approves nothing; status reads it back again", async () => {
    const root = await ordersDraft();
    const rb = JSON.parse(await ok(root, ["readback", "--targets", `${ORDERS}.revenue`, "--json"])) as { readback_id: string };
    await reply(root, rb.readback_id, 1, "yes");
    await ok(root, ["set", `${ORDERS}.revenue`, "expr", "amount_cents / 100.00"]);
    const a = await next(root);
    expect(a.kind).toBe("run");
    expect(a.run!.command).toStartWith("sl readback --targets ");
    expect(a.run!.command).toContain(`${ORDERS}.revenue`);
  });

  test("an owner's no to everything read back -> the typed edit they asked for", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    expect((await status(root)).next_step.command).toBe(`sl readback --targets ${ORDERS}`);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    await reply(root, rb.readback_id, 1, "change");
    const a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "interview", action: { command: "set", args: [ORDERS, "<key>", "<value>"], kind: "ask_owner" } });
    expect(a.why).toContain(`The owner answered no or change to ${ORDERS} as it now stands`);
  });

  test("approved -> the next phase", async () => {
    const root = await ordersDraft();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    const refs = readbackRefs(await status(root));
    const rb = JSON.parse(await ok(root, ["readback", "--targets", refs.join(","), "--json"])) as { readback_id: string; items: { n: number }[] };
    for (const item of rb.items) await reply(root, rb.readback_id, item.n, "yes");
    // One approve per call, in the order of the owner's replies.
    for (const ref of refs) {
      const a = await next(root);
      expect(a.run!.command).toBe(`sl approve --target ${ref}`);
      await ok(root, ["approve", "--target", ref]);
    }
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "access", run: { command: "sl readback --targets access" } });
  });

  test("a plan waiting on results -> dispatch connector_runner; once complete, the plan's finish", async () => {
    const dir = tempDir();
    const root = join(dir, "semantic");
    await initProject(root);
    writeYaml(join(root, "sources", "wh.yaml"), { source: "wh", dialect: "snowflake" });
    expect((await next(root)).run!.command).toBe("sl introspect --source wh --emit-sql");
    const emitted = await sl(root, ["introspect", "--source", "wh", "--emit-sql", "--json"]);
    expect(emitted.code).toBe(0);
    const plan = emitted.json<{ plan_id: string; queries: { id: string; purpose: string; sql: string; max_rows: number }[] }>();
    let a = await next(root);
    expect(a).toMatchObject({ kind: "dispatch", phase: "introspect", blocked_on: null });
    expect(a.dispatch).toEqual({
      role: "connector_runner",
      task: {
        plan_id: plan.plan_id,
        source: "wh",
        dialect: "snowflake",
        queries: plan.queries.map(({ id, purpose, sql, max_rows }) => ({ id, purpose, sql, max_rows })),
        store: `sl results add --plan ${plan.plan_id} --query <query id> --file <rows.json>`,
        finish: `sl introspect --source wh --plan ${plan.plan_id}`,
      },
    });
    expect(a.human).toContain(`Dispatch to a connector runner: plan ${plan.plan_id}, queries ${plan.queries.map((q) => q.id).join(", ")}`);

    // One result stored: the task lists only the queries still to run.
    const rows = join(dir, "rows.json");
    writeFileSync(rows, "[]\n");
    await ok(root, ["results", "add", "--plan", plan.plan_id, "--query", plan.queries[0]!.id, "--file", rows]);
    a = await next(root);
    expect(a.dispatch!.task.queries.map((q) => q.id)).toEqual(plan.queries.slice(1).map((q) => q.id));
    for (const q of plan.queries.slice(1)) await ok(root, ["results", "add", "--plan", plan.plan_id, "--query", q.id, "--file", rows]);
    a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "introspect", run: { command: `sl introspect --source wh --plan ${plan.plan_id}` } });
    expect(a.why).toContain(`Every query of plan ${plan.plan_id} has its result stored`);
  });

  test("done once every approved item has a recorded answer; until then the done phase reads them back", async () => {
    const root = acme();
    const st = await status(root);
    expect(st.next_step.phase).toBe("done");
    expect(st.approved_without_yes.length).toBeGreaterThan(20);
    let a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "done", run: { command: `sl readback --targets ${st.approved_without_yes.slice(0, 8).join(",")}` } });
    expect(a.why).toContain(`${st.approved_without_yes.length} approved item(s) have no recorded owner yes`);

    // The owner's yes to each, as a readback hashes it (a golden over its recorded rows).
    const goldens = new Map(listGoldens(root).map((g) => [`golden:${(g.golden as Golden).name}`, g.golden as Golden]));
    const items = st.approved_without_yes.filter((r) => !goldens.has(r));
    const rb = JSON.parse(await ok(root, ["readback", "--targets", items.join(","), "--json"])) as { readback_id: string; items: { n: number; target: string; content_hash: string }[] };
    const lines = [
      ...rb.items.map((i) => ({ readback_id: rb.readback_id, item: i.n, target: i.target, content_hash: i.content_hash })),
      ...st.approved_without_yes
        .filter((r) => goldens.has(r))
        .map((target, i) => {
          const g = goldens.get(target)!;
          return { readback_id: "rb_0002", item: i + 1, target, content_hash: goldenHash(g as never, g.expected!.rows, g.expected!.tolerance ?? DEFAULT_TOLERANCE) };
        }),
    ].map((x, i) => ledgerLine({ id: `ans_${String(i + 1).padStart(4, "0")}`, kind: "reply", ...x, text: "Yes.", verdict: "yes", by: "Dana", at: "2026-01-15T12:00:00.000Z" } as LedgerEntry));
    mkdirSync(join(root, ".sl"), { recursive: true });
    appendFileSync(join(root, ".sl", "ledger.jsonl"), lines.join(""));
    expect(validateProject(root).filter((i) => i.message.includes("no recorded owner yes"))).toEqual([]);
    expect((await status(root)).approved_without_yes).toEqual([]);

    a = await next(root);
    expect(a).toEqual({ kind: "done", phase: "done", why: st.next_step.message, action: { command: "validate", args: [], kind: "done" }, blocked_on: "open_questions", human: `Done: ${st.next_step.message}` });
  });
});

describe("sl status sign-off steps and approved_without_yes", () => {
  test("approved_without_yes lists approved items and goldens without a matching yes, in JSON and plain output", async () => {
    const root = acme();
    const st = await status(root);
    expect(st.approved_without_yes).toContain(ORDERS);
    expect(st.approved_without_yes).toContain(`${ORDERS}.revenue`);
    expect(st.approved_without_yes).toContain("metric:average_order_value");
    expect(st.approved_without_yes).toContain("access");
    expect(st.approved_without_yes).toContain("golden:revenue_2025");
    expect(st.approved_without_yes).not.toContain("golden:new_customers_2025");
    expect(st.approved_without_yes).not.toContain("warehouse.products.launched_on");
    expect(st.next_step.phase).toBe("done");
    expect((await sl(root, ["status"])).out).toContain(`approved without a recorded owner yes (they stay approved): ${st.approved_without_yes.slice(0, 8).join(", ")} and`);

    // A yes to an item as it stands takes it off the list; a no does not.
    const rb = JSON.parse(await ok(root, ["readback", "--targets", `${ORDERS}.revenue,${ORDERS}.discount`, "--json"])) as { readback_id: string };
    await reply(root, rb.readback_id, 1, "yes");
    await reply(root, rb.readback_id, 2, "no");
    const after = await status(root);
    expect(after.approved_without_yes).not.toContain(`${ORDERS}.revenue`);
    expect(after.approved_without_yes).toContain(`${ORDERS}.discount`);
    // An item changed since its approval is listed in changed_since_approval instead.
    await ok(root, ["set", `${ORDERS}.order_count`, "filter", "status in ('completed', 'shipped')"]);
    const changed = await status(root);
    expect(changed.changed_since_approval).toContain(`${ORDERS}.order_count`);
    expect(changed.approved_without_yes).not.toContain(`${ORDERS}.order_count`);
    expect(changed.next_step).toMatchObject({ phase: "reapprove", command: `sl readback --targets ${ORDERS}.order_count`, after_owner_yes: false });
  });

  test("the done phase leaves out items already answered, and an answered no never holds done", async () => {
    const root = acme();
    const st = await status(root);
    const first = st.approved_without_yes.slice(0, 8);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", first.join(","), "--json"])) as { readback_id: string; items: { n: number }[] };
    // Pending and unanswered: the owner is asked.
    expect((await next(root)).kind).toBe("ask_owner");
    for (const item of rb.items) await reply(root, rb.readback_id, item.n, "no");
    const a = await next(root);
    expect(a.run!.command).toBe(`sl readback --targets ${st.approved_without_yes.slice(8, 16).join(",")}`);
    expect((await status(root)).next_step.phase).toBe("done");
  });

  test("a reapprove step names sl approve once the owner's yes to the item as it stands is recorded", async () => {
    const root = acme();
    await ok(root, ["set", `${ORDERS}.revenue`, "expr", "amount_cents / 100.00"]);
    expect((await status(root)).next_step).toMatchObject({ phase: "reapprove", command: `sl readback --targets ${ORDERS}.revenue`, after_owner_yes: false });
    expect(await next(root)).toMatchObject({ kind: "run", phase: "reapprove", run: { command: `sl readback --targets ${ORDERS}.revenue` } });
    const rb = JSON.parse(await ok(root, ["readback", "--targets", `${ORDERS}.revenue`, "--json"])) as { readback_id: string };
    expect(await next(root)).toMatchObject({ kind: "ask_owner", phase: "reapprove" });
    await reply(root, rb.readback_id, 1, "yes");
    expect((await status(root)).next_step).toMatchObject({ phase: "reapprove", command: `sl approve --target ${ORDERS}.revenue`, after_owner_yes: true });
    expect(await next(root)).toMatchObject({ kind: "run", phase: "reapprove", run: { command: `sl approve --target ${ORDERS}.revenue` } });
  });

  test("open access questions pass through as blocked_on", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    await ok(root, ["question", "add", "access", "--text", "Should sales see refunds?"]);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "run", phase: "access", blocked_on: "open_questions", run: { command: "sl access" } });
    expect(a.human).toContain("\n  Meanwhile: sl access");
  });
});

describe("following sl next makes progress", () => {
  for (const first of ["yes", "no"] as const) {
    test(`a ${first} then a reply without a verdict reopens the item; following each action changes the next`, async () => {
      const root = acme();
      const T = `${ORDERS}.revenue`;
      await ok(root, ["set", T, "expr", "amount_cents / 100.00"]);
      const rb = JSON.parse(await ok(root, ["readback", "--targets", T, "--json"])) as { readback_id: string };
      await reply(root, rb.readback_id, 1, first);
      await reply(root, rb.readback_id, 1, null);
      // The latest reply has no verdict: the item is open again and nothing is approved or edited.
      let a = await next(root);
      expect(a).toMatchObject({ kind: "ask_owner", phase: "reapprove", ask_owner: { readback_id: rb.readback_id, items: [{ n: 1, target: T }] } });
      // With that readback set aside, a fresh one is named; once it is written, its item is put to the owner.
      rmSync(join(root, ".sl", "pending", `${rb.readback_id}.json`));
      a = await next(root);
      expect(a).toMatchObject({ kind: "run", run: { command: `sl readback --targets ${T}` } });
      const rb2 = JSON.parse(await ok(root, ["readback", "--targets", T, "--json"])) as { readback_id: string };
      a = await next(root);
      expect(a).toMatchObject({ kind: "ask_owner", ask_owner: { readback_id: rb2.readback_id } });
      expect(a.why).toContain(`sl readback --discard ${rb2.readback_id}`);
      await reply(root, rb2.readback_id, 1, "yes");
      expect((await next(root)).run!.command).toBe(`sl approve --target ${T}`);
    });
  }

  test("a ledger behind a linked .sl directory, which sl approve refuses, is not read", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", ORDERS, "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", ORDERS, "--json"])) as { readback_id: string };
    await reply(root, rb.readback_id, 1, "yes");
    expect((await next(root)).run!.command).toBe(`sl approve --target ${ORDERS}`);
    const outside = join(root, "..", "outside-sl");
    renameSync(join(root, ".sl"), outside);
    symlinkSync(outside, join(root, ".sl"));
    const st = await status(root);
    expect(st.next_step.command).toBe(`sl readback --targets ${ORDERS}`);
    expect(st.approved_without_yes).toContain(`${ORDERS}.revenue`);
    expect((await sl(root, ["next", "--json"])).json<NextAction>().run?.command ?? "").not.toContain("sl approve");
  });

  test("blocked_on stays open_questions while a pending readback is put to the owner", async () => {
    const root = acme();
    await ok(root, ["approve", "--target", "access", "--revoke"]);
    await ok(root, ["question", "add", "access", "--text", "Should sales see refunds?"]);
    await ok(root, ["readback", "--targets", "access", "--json"]);
    expect(await next(root)).toMatchObject({ kind: "ask_owner", phase: "access", blocked_on: "open_questions" });
  });

  test("a yes to a golden whose source sl cannot run, with no plan of its rows stored, names writing one, never a <plan_id> placeholder", async () => {
    const root = acme();
    writeYaml(join(root, "sources", "sf.yaml"), { source: "sf", dialect: "snowflake" });
    const file = join(root, "goldens", "revenue_2025.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^(\s+source:) warehouse$/m, "$1 sf"));
    const line = { id: "ans_0001", kind: "reply", readback_id: "rb_0001", item: 1, target: "golden:revenue_2025", content_hash: `sha256:${"0".repeat(64)}`, text: "Yes.", verdict: "yes", by: "Dana", at: "2026-01-15T12:00:00.000Z" };
    mkdirSync(join(root, ".sl"), { recursive: true });
    writeFileSync(join(root, ".sl", "ledger.jsonl"), ledgerLine(line as LedgerEntry));
    expect((await next(root)).run!.command).toBe("sl goldens run --name revenue_2025 --emit-sql");
  });

  test("the done phase reads goldens back last, one per readback; an item missing its hash is not listed", async () => {
    const root = acme();
    const st = await status(root);
    const items = st.approved_without_yes.filter((r) => !r.startsWith("golden:"));
    const lines = items.map((target, i) =>
      ledgerLine({ id: `ans_${String(i + 1).padStart(4, "0")}`, kind: "reply", readback_id: "rb_0001", item: i + 1, target, content_hash: `sha256:${"0".repeat(64)}`, text: "No.", verdict: "no", by: "Dana", at: "2026-01-15T12:00:00.000Z" } as LedgerEntry),
    );
    // A no at another hash leaves the items unanswered as they stand; at their own hash it answers them.
    mkdirSync(join(root, ".sl"), { recursive: true });
    writeFileSync(join(root, ".sl", "ledger.jsonl"), lines.join(""));
    expect((await next(root)).run!.command).toBe(`sl readback --targets ${items.slice(0, 8).join(",")}`);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", items.join(","), "--json"])) as { readback_id: string; items: { n: number }[] };
    for (const item of rb.items) await reply(root, rb.readback_id, item.n, "no");
    const goldens = st.approved_without_yes.filter((r) => r.startsWith("golden:"));
    expect(goldens.length).toBeGreaterThan(1);
    expect(await next(root)).toMatchObject({ kind: "run", phase: "done", run: { command: `sl readback --targets ${goldens[0]}` } });

    // Items without approved_hash are listed in hash_missing only.
    const metrics = join(root, "metrics.yaml");
    writeFileSync(metrics, readFileSync(metrics, "utf8").replace(/^(\s+)approved_hash: .*\n/m, ""));
    const missing = await status(root);
    expect(missing.hash_missing.length).toBe(1);
    expect(missing.approved_without_yes).not.toContain(missing.hash_missing[0]);
  });
});

describe("sl next on a golden of a source sl runs", () => {
  test("readback -> ask_owner -> yes -> goldens confirm -> confirm is not named again; odd files do not stop next", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      await duckdbSource(t.root, t.dir, "wh", [
        "create table orders (id integer, region varchar, amount decimal(10,2))",
        "insert into orders values (1, 'east', 100.00), (2, 'east', 50.50), (3, 'west', 200.00)",
      ]);
      writeFileSync(
        join(t.root, "goldens", "revenue_by_region.yaml"),
        "name: revenue_by_region\nquestion: What was revenue by region?\nrequest:\n  source: wh\n  measures: [orders.revenue]\n  dimensions: [orders.region]\n" +
          "sql: |\n  select region, sum(amount) as revenue from orders group by region\nstatus: draft\n",
      );
      const rb = JSON.parse(await ok(t.root, ["readback", "--targets", "golden:revenue_by_region", "--json"])) as { readback_id: string };
      expect((await next(t.root)).kind).toBe("ask_owner");
      await reply(t.root, rb.readback_id, 1, "yes");
      expect((await next(t.root)).run!.command).toBe("sl goldens confirm --name revenue_by_region");
      await ok(t.root, ["goldens", "confirm", "--name", "revenue_by_region"]);
      expect((await next(t.root)).run?.command ?? "").not.toContain("goldens confirm");
      expect((await status(t.root)).approved_without_yes).not.toContain("golden:revenue_by_region");

      // A malformed pending readback, plan and ledger line are skipped (sl validate reports them).
      writeFileSync(join(t.root, ".sl", "pending", "rb_0009.json"), "{not json");
      mkdirSync(join(t.root, ".sl", "plans"), { recursive: true });
      writeFileSync(join(t.root, ".sl", "plans", "abcdefabcdef.json"), "garbage");
      appendFileSync(join(t.root, ".sl", "ledger.jsonl"), 'garbage\n{"kind":"reply"}\n');
      expect((await sl(t.root, ["next", "--json"])).code).toBe(0);
      expect((await sl(t.root, ["status", "--json"])).code).toBe(0);
    } finally {
      t.cleanup();
    }
  });
});

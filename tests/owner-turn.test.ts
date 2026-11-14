import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gradeApprovals } from "../evals/graders/approvals.ts";
import type { RunFiles } from "../evals/graders/types.ts";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { argvOf, toolOf } from "../skills/semantic-layer/scripts/mcp/schema.ts";
import type { LedgerReply } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, FIXED_NOW, initProject, refsUnder, sl, tempRoot } from "./helpers.ts";

// One owner turn in at most three commands (docs/PRD-hardening.md HR-15, exit condition 4): sl reply
// --answers, sl approve --readback (or --target more than once), sl question resolve --answers and
// sl goldens confirm --readback. Batching is transport only: every item still gets its own ledger
// line with the owner's words and its own verdict, and an approval still rests on that item's own
// yes as it stands (invariant 5). Copies of examples/acme; all data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const OWNER = "Dana Ruiz";

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

const ledgerOf = (at: string) => (existsSync(join(at, ".sl", "ledger.jsonl")) ? readFileSync(join(at, ".sl", "ledger.jsonl"), "utf8") : "");
const lines = (at: string) => ledgerOf(at).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerReply);

// Every file under `at`, by path, with its text.
function files(at: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(at, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(at, p), "utf8"));
    }
  };
  walk("");
  return out;
}

function answersFile(data: unknown, name = "answers.json"): string {
  const file = join(dir, name);
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
}

// A copy of the current root, for running the single forms beside a batch.
function twin(): string {
  const t = tempRoot();
  cpSync(root, t.root, { recursive: true });
  return t.root;
}

// Makes each model and its fields drafts and reads them back (the first `limit` of them, or all);
// returns the readback id and its items. "access" reads back access.yaml.
async function readBack(models: string[], limit?: number): Promise<{ id: string; items: { n: number; target: string }[] }> {
  const targets = models.flatMap((m) => (m === "access" ? [m] : refsUnder(root, m))).slice(0, limit);
  for (const m of models) expect((await sl(root, ["approve", "--target", m, "--revoke", ...(m === "access" ? [] : ["--recursive"])])).code).toBe(0);
  const r = await sl(root, ["readback", "--targets", targets.join(","), "--json"]);
  expect(r.err).toBe("");
  const { readback_id, items } = r.json<{ readback_id: string; items: { n: number; target: string }[] }>();
  expect(items.map((i) => i.target)).toEqual(targets);
  return { id: readback_id, items };
}

const statusOf = (ref: string) => {
  const [source, model, field] = ref.split(".") as [string, string, string?];
  const m = readYaml<Record<string, unknown>>(join(root, "models", source, `${model}.yaml`));
  if (!field) return m.status;
  for (const k of ["dimensions", "measures", "joins"]) for (const f of (m[k] as { name: string; status?: string }[] | undefined) ?? []) if (f.name === field) return f.status;
  return undefined;
};

describe("sl reply --answers", () => {
  test("a batch writes the ledger byte for byte as the same replies run one by one", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const other = twin();
    const said: { item: number; verdict: string; text: string; about?: string }[] = [
      { item: 1, verdict: "yes", text: "Yes, one row per refund." },
      { item: 2, verdict: "change", text: "Call it the refund date." },
      { item: 3, verdict: "change", text: "Finance should not see this one.", about: "access" },
      { item: 3, verdict: "yes", text: "The figure itself is right." },
    ];
    // The single form, one call per answer; an item may take two answers there only across calls.
    for (const a of said) {
      const r = await sl(other, ["reply", "--readback", id, "--item", String(a.item), "--text", a.text, "--verdict", a.verdict, ...(a.about ? ["--about", a.about] : []), "--by", OWNER]);
      expect(r.code).toBe(0);
    }
    // The batch names each item once: the about-access change goes first, then the yes in a second batch.
    const first = await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: said.slice(0, 3) })]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Recorded ans_0001 to ans_0003 in .sl/ledger.jsonl: ${OWNER}'s replies to 3 items of ${id}, yes to item 1; change to item 2; a change to who sees item 3.`);
    expect(first.out).toContain(`Next: sl approve --readback ${id}; then make the changes the owner asked for to warehouse.refunds.${readBackItem(2)} with one sl apply --file -`);
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: said.slice(3) })])).code).toBe(0);
    expect(ledgerOf(root)).toBe(ledgerOf(other));
    expect(lines(root).map((l) => l.text)).toEqual(said.map((a) => a.text));
  });

  test("an items list gives each item its own line with the same words and verdict, and --json lists the ids", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const r = await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ items: [1, 2, 3], verdict: "yes", text: "Yes, all three are right." }] }), "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ ids: string[]; entries: LedgerReply[]; next: string }>();
    expect(out.ids).toEqual(["ans_0001", "ans_0002", "ans_0003"]);
    expect(out.next).toBe(`sl approve --readback ${id}`);
    expect(lines(root).map((l) => [l.item, l.verdict, l.text])).toEqual([1, 2, 3].map((n) => [n, "yes", "Yes, all three are right."]));
  });

  test("reads the answers from stdin with -", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const out: string[] = [];
    const code = await runCli(["reply", "--readback", id, "--answers", "-", "--root", root], {
      cwd: root,
      env: { SL_NOW: FIXED_NOW },
      out: (t) => out.push(t),
      err: (t) => out.push(t),
      stdin: async () => JSON.stringify({ by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes." }] }),
    });
    expect(out.join("\n")).toContain("Recorded ans_0001");
    expect(code).toBe(0);
  });

  test("every refusal names the entry and writes nothing", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const before = files(root);
    const ok = { item: 1, verdict: "yes", text: "Yes." };
    const cases: [unknown, string][] = [
      [{ by: OWNER, answers: [ok, { item: 99, verdict: "yes", text: "Yes." }] }, `Entry 2 of "answers" names item 99, which ${id} does not have; its items are 1 (warehouse.refunds)`],
      [{ by: OWNER, answers: [ok, { items: [2, 1], verdict: "yes", text: "Yes." }] }, 'Entry 2 of "answers" names item 1, which entry 1 already names; give each item once.'],
      [{ by: OWNER, answers: [ok, { item: "2", verdict: "yes", text: "Yes." }] }, 'Entry 2 of "answers" names item "2"; an item number is a whole number, not text'],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "sure", text: "Sure." }] }, 'Entry 2 of "answers" has verdict "sure"; a verdict is "yes", "no" or "change".'],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "yes" }] }, 'Entry 2 of "answers" has no "text"'],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "yes", text: "   " }] }, 'Entry 2 of "answers" has no "text"'],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "yes", text: "Yes.", about: "access" }] }, `Entry 2 of "answers", item 2: "about": "access" records a change to who sees the item, so it goes with "verdict": "change".`],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "change", text: "x", about: "roles" }] }, 'Entry 2 of "answers" has "about": "roles"'],
      [{ by: OWNER, answers: [ok, { item: 2, items: [3], verdict: "yes", text: "Yes." }] }, 'Entry 2 of "answers" gives both "item" and "items"'],
      [{ by: OWNER, answers: [ok, { item: 2, verdict: "yes", text: "Yes.", by: "Sam" }] }, 'Entry 2 of "answers" has key(s) by'],
      [{ by: " ", answers: [ok] }, '"by" is missing or empty'],
      [{ by: OWNER, answers: [] }, '"answers" is missing or empty'],
      ["{not json", "is not JSON"],
    ];
    for (const [data, message] of cases) {
      const r = await sl(root, ["reply", "--readback", id, "--answers", answersFile(data)]);
      expect({ data, err: r.err }).toEqual({ data, err: expect.stringContaining(message) });
      expect(r.err.toLowerCase()).toContain("nothing was written");
      expect(r.code).not.toBe(0);
    }
    for (const args of [
      ["--readback", "rb_9999", "--answers", answersFile({ by: OWNER, answers: [ok] })],
      ["--readback", id, "--answers", answersFile({ by: OWNER, answers: [ok] }), "--by", OWNER],
      ["--readback", id, "--answers", join(dir, "missing.json")],
      ["--answers", answersFile({ by: OWNER, answers: [ok] })],
    ]) {
      const r = await sl(root, ["reply", ...args]);
      expect(r.code).not.toBe(0);
    }
    expect(files(root)).toEqual(before);
  });

  test("a credential in the owner's words is redacted in each line exactly as the single form redacts it", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const other = twin();
    const text = "Yes. password=hunter2hunter2 by the way";
    expect((await sl(other, ["reply", "--readback", id, "--item", "1", "--text", text, "--verdict", "yes", "--by", OWNER])).code).toBe(0);
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ item: 1, verdict: "yes", text }] })])).code).toBe(0);
    expect(ledgerOf(root)).toBe(ledgerOf(other));
    expect(ledgerOf(root)).not.toContain("hunter2");
  });

  test("an about-access change to access.yaml itself is refused as the single form refuses it", async () => {
    const { id } = await readBack(["access"]);
    const r = await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ item: 1, verdict: "change", text: "Hide it.", about: "access" }] })]);
    expect(r.err).toContain('This item is access.yaml itself, so a change to who sees what is a change to it: record it with "verdict": "change", without "about".');
    expect(ledgerOf(root)).toBe("");
  });

  test("--item with a list is refused and names --answers", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const r = await sl(root, ["reply", "--readback", id, "--item", "1,2,3", "--text", "Yes.", "--verdict", "yes", "--by", OWNER]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--item takes one item number, not "1,2,3"; nothing was written.');
    expect(r.err).toContain(`sl reply --readback <readback_id> --answers <file | ->`);
    expect(ledgerOf(root)).toBe("");
  });

  test("each reply keeps its own words, so the approvals grader still sees a blanket yes in a batch", async () => {
    const { id } = await readBack(["warehouse.refunds"]);
    const r = await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes, one row per refund." }, { item: 2, verdict: "yes", text: "Approve everything, I'm busy." }] })]);
    expect(r.code).toBe(0);
    expect(lines(root).map((l) => l.text)).toEqual(["Yes, one row per refund.", "Approve everything, I'm busy."]);
    expect((await sl(root, ["approve", "--readback", id])).code).toBe(0);
    const graded = gradeApprovals({ root } as unknown as RunFiles);
    expect(graded.passed).toBe(false);
    const field = lines(root)[1]!.target;
    expect(graded.details.join("\n")).toContain(`${field} is approved on ans_0002, whose text ("Approve everything, I'm busy.") approves everything at once`);
    expect(graded.details.join("\n")).not.toContain("warehouse.refunds is approved on ans_0001");
  });
});

// The name of item n of the last readback of warehouse.refunds, a field of the model.
function readBackItem(n: number): string {
  return refsUnder(root, "warehouse.refunds")[n - 1]!.split(".")[2]!;
}

describe("sl approve --readback and --target more than once", () => {
  test("approves each item on its own yes, and names the one with a change without failing", async () => {
    const { id, items } = await readBack(["warehouse.refunds"]);
    const changed = items[2]!;
    const answers = items.map((i) => (i.n === changed.n ? { item: i.n, verdict: "change", text: "Call it something else." } : { item: i.n, verdict: "yes", text: `Yes, ${i.target} is right.` }));
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers })])).code).toBe(0);
    const r = await sl(root, ["approve", "--readback", id, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ approved: { target: string; ledger: string; by: string }[]; not_approved: { target: string; reason: string; said_yes: boolean }[]; all_yes_approved: boolean; changed: unknown[] }>();
    expect(out.approved.map((a) => a.target)).toEqual(items.filter((i) => i !== changed).map((i) => i.target));
    expect(out.approved.every((a) => a.by === OWNER)).toBe(true);
    // Each approval rests on that item's own reply.
    for (const a of out.approved) expect(lines(root).find((l) => l.id === a.ledger)!.target).toBe(a.target);
    expect(out.not_approved).toEqual([expect.objectContaining({ target: changed.target, said_yes: false, reason: `the owner's latest reply (ans_000${changed.n}, to item ${changed.n} of ${id}) is "change", not yes` })]);
    expect(out.all_yes_approved).toBe(true);
    expect(out.changed).toHaveLength(items.length - 1);
    for (const i of items) expect(statusOf(i.target)).toBe(i === changed ? "draft" : "approved");
  });

  test("the plain output lists what was approved and what was not, with the next command for each", async () => {
    const { id, items } = await readBack(["warehouse.refunds"]);
    const answers = [{ item: 1, verdict: "yes", text: "Yes." }, { item: 2, verdict: "no", text: "No, that is wrong." }];
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers })])).code).toBe(0);
    const r = await sl(root, ["approve", "--readback", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Approved 1 of the ${items.length} items of ${id}, each on the owner's own yes to it as it stands:`);
    expect(r.out).toContain(`  - ${items[0]!.target} (item 1, draft -> approved) by ${OWNER} on 2026-01-15 (reply ans_0001)`);
    expect(r.out).toContain(`  - ${items[1]!.target} (item 2): the owner's latest reply (ans_0002, to item 2 of ${id}) is "no", not yes. Next: make the correction`);
    expect(r.out).toContain(`  - ${items[2]!.target} (item 3): no owner reply to it is recorded. Next: sl reply --readback ${id} --item 3`);
    expect(r.out).toContain("Everything the owner said yes to as it stands is approved.");
  });

  test("with no yes recorded it approves nothing, exits 0 and names sl reply --answers; an unknown readback writes nothing", async () => {
    const { id, items } = await readBack(["warehouse.refunds"]);
    const before = files(root);
    const r = await sl(root, ["approve", "--readback", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Approved 0 of the ${items.length} items of ${id}`);
    expect(r.out).toContain(`The owner has said yes to none of these yet; record their answers first: sl reply --readback ${id} --answers -.`);
    expect(r.out).not.toContain("Everything the owner said yes to");
    const unknown = await sl(root, ["approve", "--readback", "rb_9999"]);
    expect(unknown.code).not.toBe(0);
    expect(files(root)).toEqual(before);
  });

  test("an item changed since its yes is not approved and the command exits 1", async () => {
    const { id, items } = await readBack(["warehouse.refunds"]);
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ items: items.map((i) => i.n), verdict: "yes", text: "Yes, each is right." }] })])).code).toBe(0);
    const measure = "warehouse.refunds.refund_amount";
    expect(items.map((i) => i.target)).toContain(measure);
    expect((await sl(root, ["set", measure, "synonyms", "[refund value]"])).code).toBe(0);
    const r = await sl(root, ["approve", "--readback", id, "--json"]);
    expect(r.code).toBe(1);
    const out = r.json<{ not_approved: { target: string; said_yes: boolean; reason: string }[]; all_yes_approved: boolean }>();
    expect(out.all_yes_approved).toBe(false);
    expect(out.not_approved).toEqual([expect.objectContaining({ target: measure, said_yes: true, reason: expect.stringContaining("it changed since the owner said yes") })]);
    expect(statusOf(measure)).toBe("draft");
  });

  test("--target more than once approves each named item on its own yes", async () => {
    const { id, items } = await readBack(["warehouse.refunds"]);
    expect((await sl(root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes." }, { item: 2, verdict: "yes", text: "Yes." }] })])).code).toBe(0);
    // --by must still name the owner who said yes: each item is refused for it, and the command exits 1.
    const sam = await sl(root, ["approve", "--readback", id, "--by", "Sam", "--json"]);
    expect(sam.code).toBe(1);
    expect(sam.json<{ not_approved: { target: string; reason: string; said_yes: boolean }[] }>().not_approved.filter((n) => n.said_yes).map((n) => [n.target, n.reason])).toEqual(
      [0, 1].map((k) => [items[k]!.target, `--by "Sam" is not the owner who said yes (ans_000${k + 1}, to item ${k + 1} of ${id}), "${OWNER}"`]),
    );
    expect(statusOf(items[0]!.target)).toBe("draft");
    const r = await sl(root, ["approve", "--target", items[1]!.target, "--target", items[0]!.target, "--target", items[2]!.target]);
    expect(r.out).toContain(`Approved 2 of the 3 targets`);
    expect(r.code).toBe(0);
    expect([items[0], items[1], items[2]].map((i) => statusOf(i!.target))).toEqual(["approved", "approved", "draft"]);
    expect((await sl(root, ["approve", "--readback", id, "--recursive"])).err).toContain("--recursive takes one --target and no --readback");
  });
});

describe("sl question resolve --answers", () => {
  const PRODUCTS = "warehouse.products";
  const CUSTOMERS = "warehouse.customers";
  const answered = [
    { target: PRODUCTS, match: "launched_on:", text: "Yes, the day it went on sale." },
    { target: PRODUCTS, index: 1, text: "Those are reissues; keep both." },
    { target: CUSTOMERS, index: 2, text: "Ask Sam in engineering." },
  ];

  test("resolves each as the single form does, files and ledger byte for byte", async () => {
    const other = twin();
    for (const a of answered) {
      const pick = a.match !== undefined ? ["--match", a.match] : ["--index", String(a.index)];
      expect((await sl(other, ["question", "resolve", a.target, ...pick, "--text", a.text, "--by", OWNER])).code).toBe(0);
    }
    const r = await sl(root, ["question", "resolve", "--answers", answersFile({ by: OWNER, answers: answered })]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Resolved 3 open questions in models/warehouse/customers.yaml, models/warehouse/products.yaml and recorded ${OWNER}'s answers as ans_0001 to ans_0003`);
    expect(files(root)).toEqual(files(other));
  });

  test("an index counts in each list as it stands before the command", async () => {
    for (const q of ["First?", "Second?"]) expect((await sl(root, ["question", "add", "access.roles.finance", "--text", q])).code).toBe(0);
    const answers = [{ target: "access.roles.finance", index: 1, text: "a" }, { target: "access.roles.finance", index: 2, text: "b" }];
    expect((await sl(root, ["question", "resolve", "--answers", answersFile({ by: OWNER, answers })])).code).toBe(0);
    expect(lines(root).map((l) => [(l as unknown as { question: string }).question, l.text])).toEqual([["First?", "a"], ["Second?", "b"]]);
  });

  test("questions on access.yaml and on a role resolve as the single forms do, files and ledger byte for byte", async () => {
    for (const [ref, q] of [["access", "Does marketing get a role?"], ["access.roles.finance", "Do finance see pii?"], ["access.roles.finance", "Do finance see returns?"]] as const)
      expect((await sl(root, ["question", "add", ref, "--text", q])).code).toBe(0);
    const other = twin();
    // Picked so that running them one by one in this order picks the same questions.
    const access = [
      { target: "access.roles.finance", index: 2, text: "Yes, returns too." },
      { target: "access", match: "marketing", text: "No role for marketing." },
      { target: "access.roles.finance", index: 1, text: "No pii." },
    ];
    for (const a of access) {
      const pick = a.match !== undefined ? ["--match", a.match] : ["--index", String(a.index)];
      expect((await sl(other, ["question", "resolve", a.target, ...pick, "--text", a.text, "--by", OWNER])).err).toBe("");
    }
    expect((await sl(root, ["question", "resolve", "--answers", answersFile({ by: OWNER, answers: access })])).err).toBe("");
    expect(files(root)).toEqual(files(other));
  });

  test("every refusal names the entry and writes nothing", async () => {
    const before = files(root);
    const cases: [unknown, string][] = [
      [{ by: OWNER, answers: [answered[0], { target: PRODUCTS, match: "launched_on", text: "Again." }] }, 'Entry 2 of "answers" picks the same open question as entry 1'],
      [{ by: OWNER, answers: [answered[0], { target: PRODUCTS, match: "e", text: "x" }] }, 'Entry 2 of "answers" (warehouse.products): "match" "e" matches 2 open questions'],
      [{ by: OWNER, answers: [answered[0], { target: "warehouse.orders", index: 1, text: "x" }] }, 'Entry 2 of "answers" (warehouse.orders): warehouse.orders has no open questions'],
      [{ by: OWNER, answers: [answered[0], { target: PRODUCTS, index: 9, text: "x" }] }, 'Entry 2 of "answers" (warehouse.products): "index" is 1 to 2'],
      [{ by: OWNER, answers: [answered[0], { target: PRODUCTS, index: 1, match: "x", text: "x" }] }, 'gives both "match" and "index"'],
      [{ by: OWNER, answers: [answered[0], { target: PRODUCTS, index: 1, text: "" }] }, 'Entry 2 of "answers" has no "text"'],
      [{ by: OWNER, answers: [answered[0], { target: "nope.nope", index: 1, text: "x" }] }, 'Entry 2 of "answers" (nope.nope)'],
      [{ answers: [answered[0]] }, '"by" is missing or empty'],
    ];
    for (const [data, message] of cases) {
      const r = await sl(root, ["question", "resolve", "--answers", answersFile(data)]);
      expect({ data, err: r.err }).toEqual({ data, err: expect.stringContaining(message) });
      expect(r.code).not.toBe(0);
    }
    const mixed = await sl(root, ["question", "resolve", PRODUCTS, "--answers", answersFile({ by: OWNER, answers: answered })]);
    expect(mixed.err).toContain("--answers takes no <ref>");
    expect(files(root)).toEqual(before);
  });
});

describe("sl goldens confirm --readback", () => {
  test("confirms each golden the owner said yes to, and names the one with a change", async () => {
    const t = tempRoot();
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer, region varchar, amount decimal(10,2))", "insert into orders values (1, 'east', 100.00), (2, 'west', 50.50)"]);
    const golden = (name: string, sql: string) =>
      writeFileSync(join(t.root, "goldens", `${name}.yaml`), `name: ${name}\nquestion: ${name}?\nrequest:\n  source: wh\nsql: ${sql}\nstatus: draft\n`);
    golden("total", "select sum(amount) as revenue from orders");
    golden("orders", "select count(*) as orders from orders");
    golden("east", "select sum(amount) as revenue from orders where region = 'east'");
    // The goldens' rows come from their cross_check_sql (the layer has no model), as sl readback warns.
    const rb = await sl(t.root, ["readback", "--targets", "golden:total,golden:orders,golden:east", "--tolerance", "0", "--json"]);
    expect(rb.code).toBe(0);
    const id = rb.json<{ readback_id: string }>().readback_id;
    const answers = [{ items: [1, 2], verdict: "yes", text: "Those match the pack." }, { item: 3, verdict: "change", text: "East should exclude refunds." }];
    expect((await sl(t.root, ["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers })])).code).toBe(0);
    const r = await sl(t.root, ["goldens", "confirm", "--readback", id, "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ confirmed: { name: string; ledger: string; tolerance: number }[]; not_confirmed: { name: string; reason: string; said_yes: boolean }[]; all_yes_confirmed: boolean }>();
    expect(out.confirmed.map((c) => [c.name, c.ledger, c.tolerance])).toEqual([["total", "ans_0001", 0], ["orders", "ans_0002", 0]]);
    expect(out.not_confirmed).toEqual([expect.objectContaining({ name: "east", said_yes: false, reason: `the owner's latest reply (ans_0003, to item 3 of ${id}) is "change", not yes` })]);
    expect(out.all_yes_confirmed).toBe(true);
    const status = (n: string) => readYaml<{ status: string; confirmed_by?: string }>(join(t.root, "goldens", `${n}.yaml`));
    expect([status("total").status, status("orders").status, status("east").status]).toEqual(["approved", "approved", "draft"]);
    expect(status("total").confirmed_by).toBe(OWNER);
    // A golden the owner said yes to whose rows changed since is not confirmed, and the command exits 1.
    const rb2 = (await sl(t.root, ["readback", "--targets", "golden:east", "--tolerance", "0", "--json"])).json<{ readback_id: string }>().readback_id;
    expect((await sl(t.root, ["reply", "--readback", rb2, "--answers", answersFile({ by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes, east is right." }] })])).code).toBe(0);
    golden("east", "select sum(amount) + 1 as revenue from orders where region = 'east'");
    const again = await sl(t.root, ["goldens", "confirm", "--readback", rb2]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("golden:east (item 1): the golden, the rows its request compiles to now or the tolerance changed since the owner said yes");
    expect(status("east").status).toBe("draft");
    expect((await sl(t.root, ["goldens", "confirm", "--readback", id, "--name", "east"])).err).toContain("--readback takes no --name");
    expect((await sl(t.root, ["goldens", "run", "--readback", id])).err).toContain("--readback goes with sl goldens confirm only");
  });
});

// The exit walkthrough's worst turn: a 21-item readback answered with 19 yes and 2 changes took 27
// commands. Here the readback answers take three (reply, approve, apply) and a question turn two
// (apply, question resolve).
describe("the walkthrough's worst turn", () => {
  test("21 items, 19 yes and 2 changes, with the edits, in three commands; a question turn in two", async () => {
    const { id, items } = await readBack(["warehouse.orders", "warehouse.customers"], 21);
    expect(items).toHaveLength(21);
    const change = [items[4]!, items[15]!];
    const answers = [
      { items: items.filter((i) => !change.includes(i)).map((i) => i.n), verdict: "yes", text: "Yes, each of those reads right." },
      ...change.map((i) => ({ item: i.n, verdict: "change", text: `Reword the description of ${i.target}.` })),
    ];
    let commands = 0;
    const run = async (args: string[]) => {
      commands++;
      const r = await sl(root, args);
      expect({ args, err: r.err }).toEqual({ args, err: "" });
      expect(r.code).toBe(0);
      return r;
    };
    await run(["reply", "--readback", id, "--answers", answersFile({ by: OWNER, answers })]);
    const approved = await run(["approve", "--readback", id, "--json"]);
    await run(["apply", "--file", answersFile({ edits: change.map((i) => ["set", i.target, "description", `Reworded for ${OWNER}.`]) }, "edits.json")]);
    expect(commands).toBe(3);
    expect(lines(root).filter((l) => l.readback_id === id)).toHaveLength(21);
    const out = approved.json<{ approved: { target: string }[]; not_approved: { target: string }[] }>();
    expect(out.approved).toHaveLength(19);
    expect(out.not_approved.map((n) => n.target)).toEqual(change.map((i) => i.target));
    for (const i of items) expect(statusOf(i.target)).toBe(change.includes(i) ? "draft" : "approved");

    // A question turn: the owner answers the open questions, and one answer changes the layer.
    commands = 0;
    await run(["apply", "--file", answersFile({ edits: [["set", "warehouse.products.launched_on", "description", "The day the product went on sale."]] }, "edits2.json")]);
    await run([
      "question", "resolve", "--answers",
      answersFile({ by: OWNER, answers: [
        { target: "warehouse.products", match: "launched_on:", text: "Yes, the day it went on sale." },
        { target: "warehouse.products", index: 1, text: "Reissues; keep both." },
        { target: "warehouse.customers", index: 1, text: "Wait for the view." },
        { target: "warehouse.customers", index: 2, text: "Ask Sam." },
      ] }, "questions.json"),
    ]);
    expect(commands).toBe(2);
    expect(lines(root).filter((l) => (l.kind as string) === "question")).toHaveLength(4);
    for (const m of ["products", "customers"]) expect(readYaml<{ open_questions?: unknown }>(join(root, "models", "warehouse", `${m}.yaml`)).open_questions).toBeUndefined();
  });
});

// Under MCP an approval waits on the owner's answer asked in the client (elicitation), call by call,
// so the batched forms are CLI only and sl_approve keeps its one target (invariant 5).
describe("the MCP tools", () => {
  test("offer no batched form, and sl_approve takes one target", async () => {
    for (const [command, flag] of [["reply", "answers"], ["reply", "approve"], ["question", "answers"], ["goldens", "readback"], ["approve", "readback"]] as const) {
      const spec = (await COMMANDS[command]!()).default;
      const tool = toolOf(command, spec);
      expect(Object.keys(tool.inputSchema.properties!)).not.toContain(flag);
      expect(tool.description).toMatch(new RegExp(`\\((--[a-z-]+, )*--${flag}(, --[a-z-]+)*\\) (is|are) CLI only`));
      expect(argvOf(command, spec, { [flag]: "x" }, "/r")).not.toContain(`--${flag}=x`);
    }
    const approve = (await COMMANDS.approve!()).default;
    expect(toolOf("approve", approve).inputSchema.properties!.target).toEqual({ type: "string", description: "--target" });
  });
});

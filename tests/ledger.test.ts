import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCredential, redactCredentials } from "../skills/semantic-layer/scripts/lib/credentials.ts";
import type { LedgerEntry, LedgerQuestion, PendingReadback } from "../skills/semantic-layer/scripts/lib/types.ts";
import { schemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { FIXED_NOW, sl } from "./helpers.ts";

// The answer ledger (.sl/ledger.jsonl): sl reply and sl question resolve on a copy of examples/acme,
// with the fixed clock of the test helpers.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const LEDGER = join(".sl", "ledger.jsonl");
const PRODUCTS = join("models", "warehouse", "products.yaml");

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function acme(): string {
  const dir = mkdtempSync(join(tmpdir(), "sl-ledger-"));
  temps.push(dir);
  const root = join(dir, "semantic");
  cpSync(ACME, root, { recursive: true });
  return root;
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const ledgerText = (root: string) => read(root, LEDGER);
const ledger = (root: string): LedgerEntry[] => ledgerText(root).trimEnd().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
const pending = (root: string, id: string) => JSON.parse(read(root, join(".sl", "pending", `${id}.json`))) as PendingReadback;

// Every file under a directory, relative to it, with its contents.
function tree(dir: string, base = dir): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) for (const [k, v] of tree(p, base)) out.set(k, v);
    else out.set(p.slice(base.length + 1), readFileSync(p, "utf8"));
  }
  return out;
}

async function readback(root: string, targets: string): Promise<PendingReadback> {
  const r = await sl(root, ["readback", "--targets", targets, "--json"]);
  expect(r.code).toBe(0);
  return pending(root, r.json<{ readback_id: string }>().readback_id);
}

async function reply(root: string, args: string[]) {
  return sl(root, ["reply", ...args]);
}

describe("sl reply", () => {
  test("appends one sorted-key line per reply, yes, no, change and without a verdict, never rewriting earlier lines", async () => {
    const root = acme();
    const rb = await readback(root, "warehouse.orders.revenue,warehouse.products,warehouse.orders");
    const [h1, h2, h3] = rb.items.map((i) => i.content_hash);

    const yes = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "Yes, that's right.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(yes.code).toBe(0);
    expect(yes.out).toBe(
      "Recorded ans_0001 in .sl/ledger.jsonl: Dana Ruiz's reply to item 1 of rb_0001 (warehouse.orders.revenue), verdict yes.\n" +
        'The owner said yes to the item as read back. Next: sl approve --target warehouse.orders.revenue --by "Dana Ruiz".',
    );
    const first = ledgerText(root);

    const no = await reply(root, ["--readback", "rb_0001", "--item", "2", "--text", "No, products is the catalogue only.", "--verdict", "no", "--by", "Dana Ruiz"]);
    expect(no.out).toContain("Make the correction the owner asked for with a typed edit");
    expect(no.out).toContain("then read it back again: sl readback --targets warehouse.products.");
    const change = await reply(root, ["--readback", "rb_0001", "--item", "3", "--text", "Change the grain wording.", "--verdict", "Change", "--by", "Dana Ruiz", "--json"]);
    expect(change.json()).toMatchObject({ id: "ans_0003", hash_changed: false, redacted: false, warnings: [], next: "sl readback --targets warehouse.orders" });
    const none = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "I think so, let me check with Sam.", "--by", "Dana Ruiz"]);
    expect(none.out).toContain("no verdict yet");
    expect(none.out).toContain("The reply has no verdict, so no approval can use it.");
    expect(none.out).toContain('sl reply --readback rb_0001 --item 1 --text "<owner\'s words>" --verdict yes|no|change --by "Dana Ruiz"');

    const line = (id: string, item: number, target: string, hash: string, text: string, verdict: string | null) =>
      JSON.stringify({ at: FIXED_NOW, by: "Dana Ruiz", content_hash: hash, id, item, kind: "reply", readback_id: "rb_0001", target, text, verdict });
    expect(ledgerText(root)).toBe(
      [
        line("ans_0001", 1, "warehouse.orders.revenue", h1!, "Yes, that's right.", "yes"),
        line("ans_0002", 2, "warehouse.products", h2!, "No, products is the catalogue only.", "no"),
        line("ans_0003", 3, "warehouse.orders", h3!, "Change the grain wording.", "change"),
        line("ans_0004", 1, "warehouse.orders.revenue", h1!, "I think so, let me check with Sam.", null),
      ].join("\n") + "\n",
    );
    expect(ledgerText(root).startsWith(first)).toBe(true);
    for (const e of ledger(root)) expect(schemaIssues("ledger", e, LEDGER)).toEqual([]);
    const v = await sl(root, ["validate", "--json"]);
    expect(v.json<{ issues: { file: string }[] }>().issues.filter((i) => i.file === ".sl/ledger.jsonl")).toEqual([]);
  });

  test("the hash is the one the pending item stored, and a target changed since then warns but records", async () => {
    const root = acme();
    const rb = await readback(root, "warehouse.orders.revenue");
    const edit = await sl(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales, turnover]"]);
    expect(edit.code).toBe(0);
    const r = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ entry: LedgerEntry; hash_changed: boolean; current_hash: string; warnings: string[]; next: string }>();
    expect(out.entry).toMatchObject({ content_hash: rb.items[0]!.content_hash, verdict: "yes" });
    expect(out.hash_changed).toBe(true);
    expect(out.current_hash).not.toBe(rb.items[0]!.content_hash);
    expect(out.warnings).toEqual([
      "warehouse.orders.revenue changed since it was read back; read it back again with sl readback --targets warehouse.orders.revenue, and record the owner's answer to the new readback.",
    ]);
    expect(out.next).toBe("sl readback --targets warehouse.orders.revenue");
    const plain = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(plain.out).toContain("Warning: warehouse.orders.revenue changed since it was read back; read it back again with sl readback --targets warehouse.orders.revenue");
    expect(plain.out).not.toContain("sl approve");
    expect(ledger(root)).toHaveLength(2);
  });

  test("redacts a pasted credential and strips control characters before anything is stored or printed", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue");
    const words = "\u001b[31mYes.\u0007\nUse postgres://dana:Sup3rSecret@db.acme.test/prod, or PGPASSWORD=hunter22 and token: 'tok_abc123'.";
    const r = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", words, "--verdict", "yes", "--by", "Dana Ruiz", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ redacted: boolean }>().redacted).toBe(true);
    expect(ledger(root)[0]!.text).toBe("Yes. Use postgres://[redacted]@db.acme.test/prod, or PGPASSWORD=[redacted] and token: '[redacted]'.");
    const plain = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", words, "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(plain.out).toContain("Warning: The owner's words held what looks like a credential; it was stored as [redacted].");
    for (const [file, text] of tree(root)) for (const secret of ["Sup3rSecret", "hunter22", "tok_abc123"]) expect(`${file}: ${text.includes(secret)}`).toBe(`${file}: false`);
    for (const secret of ["Sup3rSecret", "hunter22", "tok_abc123"]) expect(r.out + plain.out).not.toContain(secret);
  });

  test("refuses an unknown readback or item number, plainly, writing nothing", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue,warehouse.products");
    const base = ["--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"];
    const unknown = await reply(root, ["--readback", "rb_0099", "--item", "1", ...base]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('There is no readback "rb_0099" in .sl/pending/');
    expect(unknown.err).toContain("sl readback --targets <ref>");
    expect((await reply(root, ["--readback", "../../semantic", "--item", "1", ...base])).err).toContain("There is no readback");
    for (const item of ["3", "0", "one"]) {
      const r = await reply(root, ["--readback", "rb_0001", "--item", item, ...base]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`Readback rb_0001 has no item "${item}"; its items are 1 (warehouse.orders.revenue), 2 (warehouse.products).`);
      expect(r.err).toContain("sl readback --targets <ref>");
    }
    expect((await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "maybe", "--by", "D"])).err).toContain("--verdict is yes, no or change");
    expect((await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "  ", "--by", "D"])).err).toContain("--text is empty");
    expect((await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes"])).err).toContain("Usage: sl reply --readback");
    expect(existsSync(join(root, LEDGER))).toBe(false);
  });

  test("refuses to append to a ledger with a malformed or cut-off line, leaving it as it was", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue");
    mkdirSync(join(root, ".sl"), { recursive: true });
    for (const bad of ['{"id":"ans_0001"}\nnot json\n', '{"id":"ans_0001"}']) {
      writeFileSync(join(root, LEDGER), bad);
      const r = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("git checkout -- .sl/ledger.jsonl");
      expect(ledgerText(root)).toBe(bad);
    }
  });

  test("writes only inside the semantic root: a .sl linked outside it is refused", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue");
    const outside = mkdtempSync(join(tmpdir(), "sl-ledger-outside-"));
    temps.push(outside);
    rmSync(join(root, ".sl", "pending"), { recursive: true });
    cpSync(join(root, ".sl"), join(outside, "sl"), { recursive: true });
    rmSync(join(root, ".sl"), { recursive: true });
    symlinkSync(outside, join(root, ".sl"));
    mkdirSync(join(outside, "pending"));
    writeFileSync(join(outside, "pending", "rb_0001.json"), JSON.stringify({ readback_id: "rb_0001", created_at: FIXED_NOW, items: [{ n: 1, target: "access", kind: "approve", text: "x", content_hash: `sha256:${"0".repeat(64)}` }] }));
    const r = await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("resolves outside the semantic root");
    expect(existsSync(join(outside, "ledger.jsonl"))).toBe(false);
  });

  test("writes only inside the semantic root: a linked ledger file, dangling or not, is never followed", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue");
    const before = read(root, PRODUCTS);
    const outside = mkdtempSync(join(tmpdir(), "sl-ledger-outside-"));
    temps.push(outside);
    const yes = ["--readback", "rb_0001", "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"];
    const resolve = ["question", "resolve", "warehouse.products", "--index", "1", "--text", "Yes.", "--by", "Dana Ruiz"];

    symlinkSync(join(outside, "ledger.jsonl"), join(root, LEDGER));
    for (const r of [await reply(root, yes), await sl(root, resolve)]) {
      expect(r.code).toBe(1);
      expect(r.err).toContain("it is a symbolic link, and the ledger is a plain file inside the semantic root. Nothing was written.");
    }
    expect(existsSync(join(outside, "ledger.jsonl"))).toBe(false);
    expect(read(root, PRODUCTS)).toBe(before);

    rmSync(join(root, LEDGER));
    writeFileSync(join(outside, "ledger.jsonl"), "");
    symlinkSync(join(outside, "ledger.jsonl"), join(root, LEDGER));
    expect((await reply(root, yes)).code).toBe(1);
    expect(read(outside, "ledger.jsonl")).toBe("");

    rmSync(join(root, ".sl"), { recursive: true });
    symlinkSync(join(outside, "nowhere"), join(root, ".sl"));
    const dangling = await sl(root, resolve);
    expect(dangling.code).toBe(1);
    expect(dangling.err).toContain("is a symbolic link to nothing");
    expect(existsSync(join(outside, "nowhere"))).toBe(false);
    expect(read(root, PRODUCTS)).toBe(before);
  });

  test("--by is plain text with credentials redacted", async () => {
    const root = acme();
    await readback(root, "warehouse.orders.revenue");
    expect((await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "ok", "--by", "\u001b[31mDana\u0007 Ruiz"])).code).toBe(0);
    expect((await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "ok", "--by", "Dana password=hunter2"])).code).toBe(0);
    expect(ledger(root).map((e) => [e.by, (e as { verdict?: unknown }).verdict])).toEqual([
      ["Dana Ruiz", null],
      ["Dana password=[redacted]", null],
    ]);
  });

  test("is deterministic: the same steps write the same bytes", async () => {
    const run = async () => {
      const root = acme();
      await readback(root, "warehouse.orders.revenue,metric:net_revenue");
      const outs = [
        (await reply(root, ["--readback", "rb_0001", "--item", "2", "--text", "Yes.", "--verdict", "yes", "--by", "Dana Ruiz", "--json"])).out,
        (await reply(root, ["--readback", "rb_0001", "--item", "1", "--text", "Not quite.", "--verdict", "change", "--by", "Dana Ruiz", "--json"])).out,
        (await sl(root, ["question", "resolve", "warehouse.products", "--index", "1", "--text", "The merchandising team will check.", "--by", "Dana Ruiz", "--json"])).out,
      ];
      return { ledger: ledgerText(root), outs };
    };
    const a = await run();
    expect(await run()).toEqual(a);
    expect(a.ledger.split("\n")).toHaveLength(4);
  });
});

describe("sl question resolve", () => {
  test("removes the question byte-precisely and appends a question line", async () => {
    const root = acme();
    const before = read(root, PRODUCTS);
    const q2 =
      "launched_on: the reading is the date the product went on sale, but that comes from the column name only (Dana Ruiz). Left as draft until someone who knows confirms it, probably the merchandising team.";
    const r = await sl(root, ["question", "resolve", "warehouse.products", "--match", "LAUNCHED_ON: the reading", "--text", "Yes, the day it went on sale.", "--by", "Dana Ruiz"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Recorded the owner's answer as ans_0001 in .sl/ledger.jsonl.");
    expect(r.out).toContain("Next: sl status.");
    expect(read(root, PRODUCTS)).toBe(before.replace(`  - "${q2}"\n`, ""));
    expect(ledgerText(root)).toBe(
      `${JSON.stringify({ at: FIXED_NOW, by: "Dana Ruiz", id: "ans_0001", kind: "question", question: q2, target: "warehouse.products", text: "Yes, the day it went on sale." })}\n`,
    );
    // The last question goes with its key, as question add would add it back.
    const last = await sl(root, ["question", "resolve", "warehouse.products", "--index", "1", "--text", "Merchandising will check.", "--by", "Dana Ruiz", "--json"]);
    expect(last.json()).toMatchObject({ changed: true, file: "models/warehouse/products.yaml", reapprove: [], ref: "warehouse.products", open_questions: [], ledger_id: "ans_0002" });
    const q1 = /\n {2}- ("Why do 5 product names[^\n]*")\n/.exec(before)![1]!;
    expect(read(root, PRODUCTS)).toBe(before.replace(`open_questions:\n  - ${q1}\n  - "${q2}"\n`, ""));
    expect(ledger(root).map((e) => e.id)).toEqual(["ans_0001", "ans_0002"]);
    const status = await sl(root, ["status", "--json"]);
    expect(status.code).toBe(0);
    expect((await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string }[] }>().issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("resolves a field's question, a folded block and an access question, keeping every other byte", async () => {
    const root = acme();
    const products = read(root, PRODUCTS);
    expect((await sl(root, ["question", "resolve", "warehouse.products.launched_on", "--index", "1", "--text", "Yes.", "--by", "Dana Ruiz"])).code).toBe(0);
    expect(read(root, PRODUCTS)).toBe(products.replace(/ {2}- "launched_on:[^\n]*\n/, ""));
    const none = await sl(root, ["question", "resolve", "warehouse.products.launched_on", "--index", "1", "--text", "Yes.", "--by", "Dana Ruiz"]);
    expect(none.err).toContain("warehouse.products has no open question for launched_on; nothing to resolve. Run sl status");

    const file = join("models", "warehouse", "customers.yaml");
    const customers = read(root, file);
    const start = customers.indexOf("open_questions:\n  - >-\n") + "open_questions:\n".length;
    const end = customers.indexOf("  - ", start + 4);
    expect((await sl(root, ["question", "resolve", "warehouse.customers", "--index", "1", "--text", "Waiting on the view.", "--by", "Dana Ruiz", "--json"])).code).toBe(0);
    expect(read(root, file)).toBe(customers.slice(0, start) + customers.slice(end));
    expect((ledger(root)[1] as LedgerQuestion).question.startsWith("New customers (Dana Ruiz needs this figure")).toBe(true);

    const access = read(root, "access.yaml");
    expect((await sl(root, ["question", "add", "access", "--text", "Should marketing see refunds?"])).code).toBe(0);
    expect((await sl(root, ["question", "resolve", "access", "--match", "refunds", "--text", "No.", "--by", "Dana Ruiz"])).code).toBe(0);
    expect(read(root, "access.yaml")).toBe(access);
    expect(ledger(root).at(-1)).toEqual({ at: FIXED_NOW, by: "Dana Ruiz", id: "ans_0003", kind: "question", question: "Should marketing see refunds?", target: "access", text: "No." } as LedgerEntry);
  });

  test("keeps comments and the list style around the removed question, and --json gives the stored question", async () => {
    const root = acme();
    const file = join(root, PRODUCTS);
    const orig = read(root, PRODUCTS);
    const [start, end] = [orig.indexOf("open_questions:\n"), orig.indexOf("dimensions:\n")];
    const set = (block: string) => writeFileSync(file, orig.slice(0, start) + block + orig.slice(end));
    const resolve = (...args: string[]) => sl(root, ["question", "resolve", "warehouse.products", ...args, "--text", "No.", "--by", "Dana Ruiz", "--json"]);

    set('# keep me\nopen_questions: ["first one?", "second one?"] # trailing\n');
    expect((await resolve("--match", "second")).code).toBe(0);
    expect(read(root, PRODUCTS).slice(start, read(root, PRODUCTS).indexOf("dimensions:\n"))).toBe('# keep me\nopen_questions: ["first one?"] # trailing\n');

    set('open_questions:\n  # about a\n  - "a?"\n  # about b\n  - "b?" # tail b\n  - "c?"\n');
    expect((await resolve("--match", "c?")).code).toBe(0);
    expect(read(root, PRODUCTS)).toBe(orig.slice(0, start) + 'open_questions:\n  # about a\n  - "a?"\n  # about b\n  - "b?" # tail b\n' + orig.slice(end));

    set("open_questions:\n  - |-\n    \u0007line one  \n");
    const r = await resolve("--index", "1");
    expect(r.code).toBe(0);
    const out = r.json<{ question: string; entry: { question: string } }>();
    expect(out.entry.question).toBe("line one");
    expect(out.question).toBe(out.entry.question);
  });

  test("a failure leaves both the file and the ledger unchanged", async () => {
    const root = acme();
    const before = read(root, PRODUCTS);
    const resolve = (...extra: string[]) => sl(root, ["question", "resolve", "warehouse.products", ...extra, "--text", "Yes.", "--by", "Dana Ruiz"]);

    const ambiguous = await resolve("--match", "product");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('--match "product" matches 2 open questions of warehouse.products; pass --index <n> or a longer --match.');
    expect(ambiguous.err).toContain("\n1. Why do 5 product names");
    expect((await resolve("--match", "nothing like this")).err).toContain("matches no open question");
    expect((await resolve("--index", "3")).err).toContain("--index is 1 to 2 for warehouse.products");
    expect((await resolve()).err).toContain("Usage: sl question resolve");
    expect((await resolve("--index", "1", "--match", "x")).err).toContain("Usage: sl question resolve");
    expect(existsSync(join(root, LEDGER))).toBe(false);

    mkdirSync(join(root, ".sl"), { recursive: true });
    writeFileSync(join(root, LEDGER), '{"id":"ans_0001"}\n{broken\n');
    const malformed = await resolve("--index", "1");
    expect(malformed.code).toBe(1);
    expect(malformed.err).toContain("Line 2 of .sl/ledger.jsonl is not a JSON object; nothing was written.");
    expect(ledgerText(root)).toBe('{"id":"ans_0001"}\n{broken\n');

    rmSync(join(root, LEDGER));
    mkdirSync(join(root, LEDGER));
    const notFile = await resolve("--index", "1");
    expect(notFile.code).toBe(1);
    expect(notFile.err).toContain(".sl/ledger.jsonl is not a file");
    expect(read(root, PRODUCTS)).toBe(before);
    expect(readdirSync(join(root, LEDGER))).toEqual([]);

    expect((await sl(root, ["question", "resolve", "metric:net_revenue", "--index", "1", "--text", "x", "--by", "D"])).err).toContain("A metric has no open questions");
    expect((await sl(root, ["question", "add", "warehouse.products", "--text", "x", "--by", "D"])).err).toContain("sl question add takes no --by");
    expect(read(root, PRODUCTS)).toBe(before);
  });
});

describe("sl validate checks the ledger", () => {
  test("reports a malformed line, a schema error, a reused or out-of-order id and a cut-off last line", async () => {
    const root = acme();
    mkdirSync(join(root, ".sl"));
    const q = (id: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ at: FIXED_NOW, by: "Dana Ruiz", id, kind: "question", question: "q?", target: "access", text: "a", ...extra });
    writeFileSync(
      join(root, LEDGER),
      [q("ans_0002"), "not json", q("ans_0001"), q("ans_0002"), JSON.stringify({ at: FIXED_NOW, by: "D", id: "ans_0005", kind: "reply", target: "access", text: "yes" }), q("ans_0006", { verdict: "yes" })].join("\n"),
    );
    const v = await sl(root, ["validate", "--json"]);
    expect(v.code).toBe(1);
    const issues = v.json<{ issues: { level: string; file: string; path: string; message: string }[] }>().issues.filter((i) => i.file === ".sl/ledger.jsonl");
    const fix = "the ledger is append-only: restore it from version control (git checkout -- .sl/ledger.jsonl)";
    expect(issues.map((i) => [i.level, i.path, i.message])).toEqual([
      ["error", "", `the last line has no line break, as when an append is cut off; ${fix}`],
      ["error", "line 2", expect.stringContaining("is not valid JSON") as unknown as string],
      ["error", "line 3", `id ans_0001 comes after ans_0002; ids go up line by line, so ${fix}`],
      ["error", "line 4", `id ans_0002 is used again (first on line 1); ${fix}`],
      ["error", "line 5 readback_id", "is required"],
      ["error", "line 5 item", "is required"],
      ["error", "line 5 content_hash", "is required"],
      ["error", "line 5 verdict", "is required"],
      ["error", "line 6 verdict", "is not allowed here"],
    ]);
  });

  test("the schema takes what the commands write and nothing else", () => {
    const reply = { at: FIXED_NOW, by: "D", content_hash: `sha256:${"a".repeat(64)}`, id: "ans_0001", item: 1, kind: "reply", readback_id: "rb_0001", target: "warehouse.orders.revenue", text: "yes", verdict: null };
    expect(schemaIssues("ledger", reply, "l")).toEqual([]);
    expect(schemaIssues("ledger", { ...reply, verdict: "maybe" }, "l").map((i) => i.path)).toEqual(["verdict"]);
    expect(schemaIssues("ledger", { ...reply, value: 42 }, "l").map((i) => i.message)).toEqual(["is not a known property"]);
    expect(schemaIssues("ledger", { ...reply, id: "a1" }, "l").map((i) => i.path)).toEqual(["id"]);
  });

  test("reports a blank line in the middle, and an append refuses to number on top of it", async () => {
    const root = acme();
    mkdirSync(join(root, ".sl"));
    const q = JSON.stringify({ at: FIXED_NOW, by: "D", id: "ans_0001", kind: "question", question: "q", target: "access", text: "a" });
    writeFileSync(join(root, LEDGER), `${q}\n\n`);
    const issues = (await sl(root, ["validate", "--json"])).json<{ issues: { file: string; path: string }[] }>().issues.filter((i) => i.file === ".sl/ledger.jsonl");
    expect(issues.map((i) => i.path)).toEqual(["line 2"]);
    expect((await sl(root, ["question", "resolve", "warehouse.products", "--index", "1", "--text", "x", "--by", "D"])).code).toBe(1);
    expect(ledgerText(root)).toBe(`${q}\n\n`);
  });
});

describe("credential redaction", () => {
  test("keeps the key, replaces the value, and leaves ordinary words alone", () => {
    const cases: [string, string][] = [
      ["postgres://u:p@h/db", "postgres://[redacted]@h/db"],
      ["password=abc ok", "password=[redacted] ok"],
      ["AccountKey=xyz;EndpointSuffix=core", "AccountKey=[redacted];EndpointSuffix=core"],
      ["https://x.test/f?sig=abc&sp=r", "https://x.test/f?sig=[redacted]&sp=r"],
      ["SET s3_secret_access_key='AKIA1234'", "SET s3_secret_access_key='[redacted]'"],
      ["Authorization: Bearer abcdefgh12345678", "Authorization: Bearer [redacted]"],
      ["password: hunter2x9", "password: [redacted]"],
      ["password_hash: drop it", "password_hash: drop it"],
      ["secret_directory=/tmp/x", "secret_directory=/tmp/x"],
      ["the design is fine, sign it off", "the design is fine, sign it off"],
    ];
    for (const [input, out] of cases) expect(redactCredentials(input).text).toBe(out);
    expect(redactCredentials("Yes.").redacted).toBe(false);
  });

  test("redacts every credential form hasCredential detects", () => {
    const secret = "Zq7SECRETv4lue";
    const forms = [
      `CREATE SECRET (TYPE s3, KEY_ID '${secret}', SECRET '${secret}')`,
      `SET s3_secret_access_key '${secret}'`,
      `SET s3_secret_access_key='${secret}'`,
      `SET azure_storage_connection_string = '${secret}'`,
      `client_secret: '${secret}'`,
      `token'${secret}'`,
      `host=db password=${secret}`,
      `pwd=${secret}`,
      `md:db?motherduck_token=${secret}`,
      `DefaultEndpointsProtocol=https;AccountKey=${secret};EndpointSuffix=core`,
      `https://x.test/f?sv=1&sig=${secret}&sp=r`,
      `postgres://dana:${secret}@db.test/acme`,
    ];
    for (const s of forms) {
      expect(hasCredential("setup", s)).toBe(true);
      const r = redactCredentials(s);
      expect(r.redacted).toBe(true);
      expect(r.text).not.toContain(secret);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectApprovals } from "../skills/semantic-layer/scripts/lib/approvals.ts";
import { openLedger } from "../skills/semantic-layer/scripts/lib/ledger.ts";
import { type Issue, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { FIXED_NOW, semlayer, tempRoot } from "./helpers.ts";

// HR-15, the second walkthrough: what a typed edit breaks it says, approving never adds a validate
// issue, semlayer next does not undo semlayer ignore-column --remove, and semlayer question list. On copies of
// examples/acme, whose items are approved with content hashes. All data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const CARDS = join(import.meta.dir, "..", "skills", "semantic-layer", "references", "phases");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
  ({ root, dir, cleanup } = tempRoot());
  cpSync(ACME, root, { recursive: true });
});
afterEach(() => cleanup?.());

// Every file under the root with its text, to show that a refused batch wrote nothing.
function tree(at: string, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(join(at, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of tree(at, p)) out.set(k, v);
    else out.set(p, readFileSync(join(at, p), "latin1"));
  }
  return out;
}

function editsFile(edits: string[][], name = "edits.json"): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ edits }));
  return file;
}

// The walkthrough's owner turn: 23 edits, two of them a time_zone on a dimension whose column is
// timestamp with time zone (orders.created_at and dim_customers.signup_at in the Acme snapshot).
function turn(): string[][] {
  const fields = (model: string) => {
    const m = readYaml<{ dimensions?: { name: string }[]; measures?: { name: string }[] }>(join(root, "models", "warehouse", `${model}.yaml`));
    return [...(m.dimensions ?? []), ...(m.measures ?? [])].map((f) => `warehouse.${model}.${f.name}`);
  };
  const described = [...fields("orders"), ...fields("customers"), ...fields("products"), ...fields("refunds")].slice(0, 18).map((ref, i) => ["set", ref, "description", `Synthetic description ${i + 1}, as the owner put it.`]);
  return [
    ["set", "warehouse.orders", "grain", "One row per order placed."],
    ...described.slice(0, 8),
    ["set", "warehouse.orders.order_date", "time_zone", "UTC"],
    ...described.slice(8, 15),
    ["set", "warehouse.customers.signup_date", "time_zone", "America/New_York"],
    ...described.slice(15),
    ["question", "add", "warehouse.orders", "--text", "Do gift orders count as revenue?"],
    ["question", "add", "warehouse.customers", "--text", "Who owns the region mapping?"],
  ];
}

describe("a typed edit says what it breaks (HR-15 item 1)", () => {
  test("the walkthrough's turn as one semlayer apply is refused naming both time_zone entries, and passes without them", async () => {
    const edits = turn();
    expect(edits.length).toBe(23);
    const tz = edits.flatMap((e, i) => (e[2] === "time_zone" ? [i + 1] : []));
    expect(tz.length).toBe(2);
    const before = tree(root);
    const r = await semlayer(root, ["apply", "--file", editsFile(edits)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 entries are refused, so nothing was written:");
    expect(r.err).toContain(`Entry ${tz[0]} (semlayer set warehouse.orders.order_date time_zone UTC): Cannot set time_zone on warehouse.orders.order_date`);
    expect(r.err).toContain(`Entry ${tz[1]} (semlayer set warehouse.customers.signup_date time_zone America/New_York): Cannot set time_zone on warehouse.customers.signup_date`);
    // In semlayer validate's own words.
    expect(r.err).toContain("but column created_at is timestamp with time zone, which carries its own; remove time_zone");
    expect(r.err).toContain("but column signup_at is timestamp with time zone, which carries its own; remove time_zone");
    expect(r.err).toContain("Remove or fix each entry named and run semlayer apply again.");
    expect(tree(root)).toEqual(before);

    const without = edits.filter((e) => e[2] !== "time_zone");
    const ok = await semlayer(root, ["apply", "--file", editsFile(without), "--json"]);
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.json<{ applied: unknown[] }>().applied.length).toBe(21);
    const issues = validateProject(root).filter((i) => i.path.endsWith("time_zone"));
    expect(issues).toEqual([]);
  });

  test("semlayer set refuses a time_zone on a column that carries its own zone, with validate's words, writing nothing", async () => {
    const before = readFileSync(join(root, "models/warehouse/orders.yaml"), "utf8");
    const r = await semlayer(root, ["set", "warehouse.orders.order_date", "time_zone", "UTC"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot set time_zone on warehouse.orders.order_date: semlayer validate would warn about the value, and it can never be right here, so nothing was written:");
    expect(r.err).toContain("models/warehouse/orders.yaml dimensions[0].time_zone: names the zone timestamps without a time zone are stored in");
    expect(readFileSync(join(root, "models/warehouse/orders.yaml"), "utf8")).toBe(before);
  });

  test("an edit that adds a warning prints it with the edit, alone and in semlayer apply, plain and --json", async () => {
    const other = tempRoot();
    cpSync(root, other.root, { recursive: true });
    const warning =
      "models/warehouse/orders.yaml joins[0].relationship: one_to_many fans out and multiplies the measures of orders; aggregate customers before joining and confirm with the owner";

    const alone = await semlayer(root, ["set", "warehouse.orders.customer", "relationship", "one_to_many"]);
    expect(alone.code).toBe(0);
    const lines = alone.out.split("\n");
    expect(lines).toContain(`Warning: ${warning}`);
    // The warning comes with the edit's result, not only from a later semlayer validate.
    expect(lines.findIndex((l) => l === `Warning: ${warning}`)).toBeGreaterThan(0);
    // The once-per-file count of approved items without a matching yes is not the edit's.
    expect(alone.out).not.toContain("no recorded owner yes");

    const json = await semlayer(other.root, ["set", "warehouse.orders.customer", "relationship", "one_to_many", "--json"]);
    expect(json.json<{ warnings: string[] }>().warnings).toContain(warning);

    const third = tempRoot();
    cpSync(ACME, third.root, { recursive: true });
    const edits = [
      ["set", "warehouse.orders", "grain", "One row per order placed."],
      ["set", "warehouse.orders.customer", "relationship", "one_to_many"],
      ["set", "warehouse.orders.order_date", "description", "When the order was placed."],
    ];
    const batch = await semlayer(third.root, ["apply", "--file", editsFile(edits, "three.json")]);
    expect(batch.err).toBe("");
    const out = batch.out.split("\n");
    const at = out.findIndex((l) => l.startsWith("2. Set relationship on warehouse.orders.customer"));
    expect(at).toBeGreaterThan(0);
    expect(out.slice(at + 1, at + 3)).toContain(`   Warning: ${warning}`);
    expect(out.findIndex((l) => l.startsWith("3. "))).toBeGreaterThan(at);

    const fourth = tempRoot();
    cpSync(ACME, fourth.root, { recursive: true });
    const j = await semlayer(fourth.root, ["apply", "--file", editsFile(edits, "three.json"), "--json"]);
    const res = j.json<{ applied: { entry: number; warnings?: string[] }[]; warnings: string[] }>();
    expect(res.applied[1]!.warnings).toContain(warning);
    expect(res.applied[0]!.warnings).toBeUndefined();
    expect(res.applied[2]!.warnings).toBeUndefined();
    expect(res.warnings).toContain(warning);
    // The batch leaves the files as the first run wrote them.
    expect(readFileSync(join(fourth.root, "models/warehouse/orders.yaml"), "utf8")).toBe(readFileSync(join(third.root, "models/warehouse/orders.yaml"), "utf8"));
  });
});

// The yes the owner would give to `ref` as it now stands, written as semlayer reply writes it.
function yesTo(at: string, ref: string): void {
  const entry = projectApprovals(at).find((a) => (a as { ref?: string }).ref === ref) as { hash: string } | undefined;
  openLedger(at).append({ kind: "reply", readback_id: "rb_test_0001", item: 1, target: ref, content_hash: entry!.hash, text: "Yes.", verdict: "yes", by: "Dana Ruiz", at: FIXED_NOW });
}

describe("approving never adds a validate issue (HR-15 item 2)", () => {
  const add = ["add-field", "warehouse.orders", "--kind", "measure", "--name", "gross", "--expr", "amount_cents * 0.01", "--agg", "sum", "--description", "Gross order value.", "--set", "format=currency"];

  test("a currency-format measure without a currency is refused by semlayer readback and by semlayer approve, naming the fix", async () => {
    expect((await semlayer(root, add)).code).toBe(0);
    const rb = await semlayer(root, ["readback", "--targets", "warehouse.orders.gross", "--json"]);
    expect(rb.code).toBe(1);
    expect(rb.json<{ error: string; next: string }>()).toMatchObject({ next: "semlayer apply --file -" });
    expect(rb.err).toContain("warehouse.orders.gross: once approved, semlayer validate says models/warehouse/orders.yaml measures[3].currency: is missing on an approved item with format currency");
    expect(rb.err).toContain('{"edits":[["set","warehouse.orders.gross","currency","<ISO 4217 code, such as USD, as the owner said>"]]}');

    // A yes recorded without the readback (an older pending file) is still refused by semlayer approve.
    yesTo(root, "warehouse.orders.gross");
    const ap = await semlayer(root, ["approve", "--target", "warehouse.orders.gross", "--by", "Dana Ruiz"]);
    expect(ap.code).toBe(1);
    expect(ap.err).toContain("Cannot approve warehouse.orders.gross");
    expect(ap.err).toContain("is missing on an approved item with format currency");
    expect(ap.err).toContain("semlayer set warehouse.orders.gross currency");

    // semlayer next names the one apply that gives it.
    const next = await semlayer(root, ["next", "--json"]);
    const n = next.json<{ why: string; action: { command: string } }>();
    expect(n.why).toContain("warehouse.orders.gross");
    expect(n.action.command).toBe("apply");

    // With the currency, the readback runs and the approval adds no validate issue.
    expect((await semlayer(root, ["set", "warehouse.orders.gross", "currency", "USD"])).code).toBe(0);
    expect((await semlayer(root, ["readback", "--targets", "warehouse.orders.gross"])).code).toBe(0);
    yesTo(root, "warehouse.orders.gross");
    const key = (i: Issue) => `${i.level}\0${i.file}\0${i.path}\0${i.message}`;
    const was = new Set(validateProject(root).map(key));
    expect((await semlayer(root, ["approve", "--target", "warehouse.orders.gross", "--by", "Dana Ruiz"])).code).toBe(0);
    const added = validateProject(root).filter((i) => !was.has(key(i)) && !i.message.includes("no recorded owner yes"));
    expect(added).toEqual([]);
  });

  test("Acme's layer, every item made a draft, is read back and approved in one turn without adding a validate issue", async () => {
    // Every model, field, join and metric a draft again.
    const draft = (item: Record<string, unknown>) => {
      if (item.status !== "approved") return;
      item.status = "draft";
      for (const k of ["approved_by", "approved_at", "approved_hash"]) delete item[k];
    };
    const refs: string[] = [];
    for (const source of readdirSync(join(root, "models"))) {
      for (const f of readdirSync(join(root, "models", source))) {
        const path = join(root, "models", source, f);
        const m = readYaml<Record<string, unknown>>(path);
        const name = f.replace(/\.yaml$/, "");
        draft(m);
        refs.push(`${source}.${name}`);
        for (const k of ["dimensions", "measures", "joins"]) for (const x of (m[k] as Record<string, unknown>[] | undefined) ?? []) (draft(x), refs.push(`${source}.${name}.${x.name}`));
        writeYaml(path, m);
      }
    }
    const metricsPath = join(root, "metrics.yaml");
    const metrics = readYaml<{ metrics: Record<string, unknown>[] }>(metricsPath);
    for (const m of metrics.metrics) (draft(m), refs.push(`metric:${m.name}`));
    writeYaml(metricsPath, metrics);
    const key = (i: Issue) => `${i.level}\0${i.file}\0${i.path}\0${i.message}`;
    const was = new Set(validateProject(root).map(key));

    const rb = await semlayer(root, ["readback", "--targets", refs.join(","), "--json"]);
    expect(rb.err).toBe("");
    const { readback_id, items } = rb.json<{ readback_id: string; items: { n: number }[] }>();
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ by: "Dana Ruiz", answers: [{ items: items.map((i) => i.n), verdict: "yes", text: "Yes, each of these is right." }] }));
    expect((await semlayer(root, ["reply", "--readback", readback_id, "--answers", answers])).code).toBe(0);
    const ap = await semlayer(root, ["approve", "--readback", readback_id, "--json"]);
    expect(ap.err).toBe("");
    expect(ap.json<{ all_yes_approved: boolean }>().all_yes_approved).toBe(true);
    const added = validateProject(root).filter((i) => !was.has(key(i)));
    expect(added).toEqual([]);
  });
});

describe("who sees an item is settled before the owner's yes (HR-15 item 2)", () => {
  test("an untagged email dimension is refused by semlayer readback with the semlayer tag that fixes it, and approving it once tagged adds no issue", async () => {
    const ref = "warehouse.customers.contact_email";
    const added = await semlayer(root, ["add-field", "warehouse.customers", "--kind", "dimension", "--name", "contact_email", "--expr", "email", "--type", "string", "--description", "Where the customer is written to."]);
    expect(added.code).toBe(0);
    const refused = await semlayer(root, ["readback", "--targets", ref]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`${ref}: once approved, semlayer validate says`);
    expect(refused.err).toContain("is visible to everyone and looks sensitive");
    expect(refused.err).toContain(`["tag","${ref}","<pii, sensitive or public, as the owner said>"]`);

    const key = (i: Issue) => `${i.level}\0${i.file}\0${i.path}\0${i.message}`;
    expect((await semlayer(root, ["tag", ref, "pii"])).code).toBe(0);
    const was = new Set(validateProject(root).map(key));
    const rb = await semlayer(root, ["readback", "--targets", ref, "--json"]);
    expect(rb.err).toBe("");
    const { readback_id } = rb.json<{ readback_id: string }>();
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ by: "Dana Ruiz", answers: [{ items: [1], verdict: "yes", text: "Yes." }] }));
    expect((await semlayer(root, ["reply", "--readback", readback_id, "--answers", answers])).code).toBe(0);
    expect((await semlayer(root, ["approve", "--readback", readback_id])).code).toBe(0);
    expect(validateProject(root).filter((i) => !was.has(key(i)))).toEqual([]);
  });
});

describe("semlayer next does not undo semlayer ignore-column --remove (HR-15 item 3)", () => {
  // refunds.refund_amount's filter reads orders.gift_message through the join order; Acme lists
  // gift_message in orders' ignored_columns.
  const filter = "order.status in ('completed', 'shipped') and order.gift_message is null";

  test("the column a filter reads through a join stays in the layer: status, next, draft --new-columns and validate", async () => {
    const refused = await semlayer(root, ["set", "warehouse.refunds.refund_amount", "filter", filter]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("semlayer ignore-column --source warehouse --model orders --column gift_message --remove");
    expect((await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "gift_message", "--remove"])).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.refunds.refund_amount", "filter", filter])).code).toBe(0);

    // Not a new column: semlayer status lists none and semlayer next names no new-columns step.
    const status = await semlayer(root, ["status", "--json"]);
    const sources = status.json<{ sources: { source: string; new_columns: { model: string; column: string }[] }[] }>().sources;
    expect(sources.flatMap((s) => s.new_columns)).toEqual([]);
    const next = await semlayer(root, ["next", "--json"]);
    expect(JSON.stringify(next.json<{ action: unknown }>().action)).not.toContain("--new-columns");

    // semlayer draft --new-columns leaves it alone.
    const orders = join(root, "models/warehouse/orders.yaml");
    const before = readFileSync(orders, "utf8");
    const draft = await semlayer(root, ["draft", "--source", "warehouse", "--new-columns"]);
    expect(draft.code).toBe(0);
    expect(draft.out).not.toContain("gift_message");
    expect(readFileSync(orders, "utf8")).toBe(before);

    // Putting it back is refused, and when it is put back by hand semlayer validate warns, naming --remove.
    const back = await semlayer(root, ["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "gift_message"]);
    expect(back.code).toBe(1);
    expect(back.err).toContain('"gift_message" is read by the filter of measure refunds.refund_amount through a join, so it is not left out');
    writeFileSync(orders, before.replace("ignored_columns:\n", "ignored_columns:\n  - gift_message\n"));
    const warned = validateProject(root).filter((i) => i.file === "models/warehouse/orders.yaml" && i.path.startsWith("ignored_columns"));
    expect(warned).toEqual([
      {
        level: "warning",
        file: "models/warehouse/orders.yaml",
        path: "ignored_columns[0]",
        code: "ignore.column_read",
        message:
          '"gift_message" is read by the filter of measure refunds.refund_amount through a join, so it is not left out; take it back in with semlayer ignore-column --source warehouse --model orders --column gift_message --remove',
      },
    ]);
  });

  test("a column a row filter reads is not new either, and validate warns when it is ignored", async () => {
    const access = readYaml<{ roles: { name: string; row_filters?: { model: string; expr: string }[] }[] }>(join(root, "access.yaml"));
    const role = access.roles[0]!;
    role.row_filters = [...(role.row_filters ?? []), { model: "warehouse.orders", expr: "gift_message is null" }];
    writeYaml(join(root, "access.yaml"), access);
    const warned = validateProject(root).filter((i) => i.file === "models/warehouse/orders.yaml" && i.path.startsWith("ignored_columns"));
    expect(warned.map((i) => i.message)).toContain(
      `"gift_message" is read by a row filter of role ${role.name}, so it is not left out; take it back in with semlayer ignore-column --source warehouse --model orders --column gift_message --remove`,
    );
  });
});

describe("semlayer question list (HR-15 item 4)", () => {
  test("lists each open question with the target and index semlayer question resolve --answers takes", async () => {
    expect((await semlayer(root, ["question", "add", "warehouse.orders", "--text", "Do gift orders count?"])).code).toBe(0);
    expect((await semlayer(root, ["question", "add", "warehouse.orders.status", "--text", "Is returned a status?"])).code).toBe(0);
    const all = await semlayer(root, ["question", "list", "--json"]);
    expect(all.code).toBe(0);
    const qs = all.json<{ questions: { target: string; index: number; question: string }[]; count: number }>();
    expect(qs.count).toBe(qs.questions.length);
    const mine = qs.questions.filter((q) => q.target === "warehouse.orders");
    expect(mine).toEqual([
      { target: "warehouse.orders", index: 1, question: "Do gift orders count?" },
      { target: "warehouse.orders", index: 2, question: "status: Is returned a status?" },
    ]);
    const field = await semlayer(root, ["question", "list", "warehouse.orders.status"]);
    expect(field.out).toContain("warehouse.orders #2: status: Is returned a status?");
    expect(field.out).not.toContain("gift orders");
    expect(field.out).toContain("semlayer question resolve --answers -");
    expect((await semlayer(root, ["question", "list", "lake", "--json"])).code).toBe(0);
    expect((await semlayer(root, ["question", "list", "nope"])).err).toContain('No source "nope"');
    // A field, role or longer target that does not exist is refused, as semlayer question resolve refuses it.
    for (const bad of ["warehouse.orders.nosuchfield", "warehouse.orders.status.extra", "access.roles.nosuchrole"]) {
      const r = await semlayer(root, ["question", "list", bad]);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
    }

    // Written from the list, the answers resolve both questions.
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ by: "Dana Ruiz", answers: mine.map((q) => ({ target: q.target, index: q.index, text: "Answered." })) }));
    const r = await semlayer(root, ["question", "resolve", "--answers", answers]);
    expect(r.err).toBe("");
    expect((await semlayer(root, ["question", "list", "warehouse.orders", "--json"])).json<{ count: number }>().count).toBe(0);
  });
});

describe("texts that send the agent right (HR-15 item 5)", () => {
  test("the cards say what semlayer readback takes and what its gate needs, and name semlayer question list", () => {
    const access = readFileSync(join(CARDS, "access.md"), "utf8");
    expect(access).not.toContain("Read back each role, then the file");
    expect(access).not.toContain("Read every role back");
    expect(access).toContain("`semlayer readback --targets access`, the whole file (no single role)");
    expect(access).toContain("`semlayer readback` takes `access` and no single role");
    const interview = readFileSync(join(CARDS, "interview.md"), "utf8");
    expect(interview).toContain("in the owner's words from the answers just given (never your own guess");
    expect(interview).toContain("a `description` on every measure and metric");
    expect(interview).toContain("`semlayer question list [<target>]`");
  });
});

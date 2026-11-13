// sl approve requires the owner's recorded yes (PRD FR-3.4, invariant 5): an approval rests on the
// owner's latest reply in .sl/ledger.jsonl being a yes to the item as it now stands.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { initProject, recordReply, sl, tempDir, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const ORDERS = `# Orders, owned by finance.
model: orders
source: wh
table: main.fct_orders
status: draft
description: Customer orders.
grain: One row per order.
primary_key: [order_id]
dimensions:
  - name: order_status
    expr: status
    type: string
    status: draft
measures:
  - name: revenue
    expr: amount
    agg: sum
    description: Order value.
    status: draft # gross
  - name: order_count
    agg: count
    description: Number of orders.
    status: draft
`;

const ACCESS = "# Who sees what.\nstatus: draft\nroles:\n  - name: analyst\n    allow:\n      models: [wh.*]\n";

async function project(): Promise<string> {
  const t = tempRoot();
  cleanup = t.cleanup;
  await initProject(t.root);
  mkdirSync(join(t.root, "models", "wh"), { recursive: true });
  writeFileSync(join(t.root, "models", "wh", "orders.yaml"), ORDERS);
  writeFileSync(join(t.root, "access.yaml"), ACCESS);
  return t.root;
}

const ORDERS_FILE = "models/wh/orders.yaml";
const LEDGER = ".sl/ledger.jsonl";
const text = (root: string, rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
const orders = (root: string) => readYaml<Model>(join(root, ORDERS_FILE));
const approve = (root: string, args: string[]) => sl(root, ["approve", ...args]);

interface Result {
  changed: { target: string; from: string; to: string }[];
  warnings: string[];
  refused?: { target: string; reason: string; next: string }[];
}

describe("approve without a matching yes", () => {
  test("no reply recorded: refused, naming readback, reply and approve, and nothing is written", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.orders.revenue", "--by", "Dana"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot approve wh.orders.revenue: no owner reply to its readback is recorded; nothing was approved.");
    expect(r.err).toContain("sl readback --targets wh.orders.revenue, read it to the owner");
    expect(r.err).toContain('sl reply --readback <readback_id> --item <n> --text "<owner\'s words>" --verdict yes --by "<owner>"');
    expect(r.err).toContain("then sl approve --target wh.orders.revenue.");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
    expect(existsSync(join(root, LEDGER))).toBe(false);
  });

  test("a readback alone is not a yes", async () => {
    const root = await project();
    expect((await sl(root, ["readback", "--targets", "access"])).code).toBe(0);
    const r = await approve(root, ["--target", "access"]);
    expect(r.code).toBe(1);
    expect(text(root, "access.yaml")).toBe(ACCESS);
  });

  test("a yes recorded against an older hash is refused: the item changed after the readback", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    writeFileSync(join(root, ORDERS_FILE), ORDERS.replace("expr: amount\n", "expr: amount * 1000\n"));
    const before = text(root, ORDERS_FILE);
    const r = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("it changed since the owner said yes (ans_0001, to item 1 of rb_0001)");
    expect(r.err).toContain("sl readback --targets wh.orders.revenue");
    expect(text(root, ORDERS_FILE)).toBe(before);
  });

  test("an approved item that changed is approved again only on a yes to the new version", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    expect((await approve(root, ["--target", "wh.orders.revenue"])).code).toBe(0);
    writeFileSync(join(root, ORDERS_FILE), text(root, ORDERS_FILE).replace("expr: amount\n", "expr: amount * 1000\n"));
    const before = text(root, ORDERS_FILE);
    expect((await approve(root, ["--target", "wh.orders.revenue"])).code).toBe(1);
    expect(text(root, ORDERS_FILE)).toBe(before);
    await recordReply(root, "wh.orders.revenue", { by: "Lee" });
    const r = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Approved wh.orders.revenue again (it changed since its last approval) by Lee on 2026-01-15 (reply ans_0002).");
  });

  test("a later no, change or reply without a verdict overrides an earlier yes; a later yes counts again", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    for (const [verdict, words] of [["no", '"no", not yes'], ["change", '"change", not yes'], [null, "recorded without a verdict"]] as const) {
      await recordReply(root, "wh.orders.revenue", { verdict });
      const r = await approve(root, ["--target", "wh.orders.revenue"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`the owner's latest reply (`);
      expect(r.err).toContain(words);
      expect(text(root, ORDERS_FILE)).toBe(ORDERS);
    }
    await recordReply(root, "wh.orders.revenue", { by: "Dana Ruiz" });
    const ok = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(ok.code).toBe(0);
    expect(orders(root).measures[0]).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
  });

  test("a yes to another target, or an answered open question, approves nothing", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.order_count");
    mkdirSync(join(root, ".sl"), { recursive: true });
    appendFileSync(
      join(root, LEDGER),
      `${JSON.stringify({ at: "2026-01-15T12:00:00.000Z", by: "Dana", id: "ans_0002", kind: "question", question: "revenue: gross?", target: "wh.orders.revenue", text: "Yes." })}\n`,
    );
    const r = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no owner reply to its readback is recorded");
  });

  test("a ledger that cannot be read approves nothing", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    appendFileSync(join(root, LEDGER), "not json\n");
    const r = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(".sl/ledger.jsonl cannot be read: line 2 is not JSON");
    expect(r.err).toContain("git checkout -- .sl/ledger.jsonl");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
  });

  test("a cut-off last line, or a hand-edited yes with a blank by, approves nothing", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    const path = join(root, LEDGER);
    const line = readFileSync(path, "utf8").trim();
    writeFileSync(path, line);
    const cut = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(cut.code).toBe(1);
    expect(cut.err).toContain("its last line has no line break");
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(line), by: "  " })}\n`);
    const blank = await approve(root, ["--target", "wh.orders.revenue"]);
    expect(blank.code).toBe(1);
    expect(blank.err).toContain("line 1 is a reply line without the fields an approval needs");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
  });

  test("a yes in a ledger behind a linked .sl directory outside the root approves nothing", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    const outside = tempDir("outside");
    try {
      cpSync(join(root, ".sl"), outside, { recursive: true });
      rmSync(join(root, ".sl"), { recursive: true });
      symlinkSync(outside, join(root, ".sl"));
      const r = await approve(root, ["--target", "wh.orders.revenue"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(".sl/ledger.jsonl is not a plain file inside the semantic root");
      expect(text(root, ORDERS_FILE)).toBe(ORDERS);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("approve a metric", () => {
  const METRICS = "metrics:\n  - name: aov\n    source: wh\n    description: Revenue per order.\n    type: ratio\n    numerator: orders.revenue\n    denominator: orders.order_count\n    status: draft\n";

  test("without a yes and with draft measures, it names the readback and the fix, once each", async () => {
    const root = await project();
    writeFileSync(join(root, "metrics.yaml"), METRICS);
    const r = await approve(root, ["--target", "metric:aov"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl readback --targets metric:aov");
    expect(r.err).toContain("Before reading it back, fix: it references draft measures: wh.orders.revenue, wh.orders.order_count. Approve them first.");
    expect(r.err).not.toContain("..");
    expect(text(root, "metrics.yaml")).toBe(METRICS);
  });

  test("with a yes but draft measures it is refused; once they are approved, it takes the reply's owner and date", async () => {
    const root = await project();
    writeFileSync(join(root, "metrics.yaml"), METRICS);
    await recordReply(root, "metric:aov");
    const early = await approve(root, ["--target", "metric:aov"]);
    expect(early.code).toBe(1);
    expect(early.err).toContain("draft measures");
    expect(text(root, "metrics.yaml")).toBe(METRICS);
    await recordReply(root, ["wh.orders.revenue", "wh.orders.order_count"]);
    expect((await approve(root, ["--target", "wh.orders.revenue"])).code).toBe(0);
    expect((await approve(root, ["--target", "wh.orders.order_count"])).code).toBe(0);
    await recordReply(root, "metric:aov", { by: "Lee", now: "2026-05-05T01:00:00.000Z" });
    const r = await sl(root, ["approve", "--target", "metric:aov"], { SL_NOW: "2027-01-01T00:00:00.000Z" });
    expect(r.code).toBe(0);
    expect(text(root, "metrics.yaml")).toContain("approved_by: Lee");
    expect(text(root, "metrics.yaml")).toContain("approved_at: 2026-05-05");
  });
});

describe("approve with a matching yes", () => {
  test("approved_by and approved_at come from the ledger entry, not --by or the clock", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue", { by: "Dana Ruiz", now: "2026-03-02T23:30:00.000Z" });
    const r = await approve(root, ["--target", "wh.orders.revenue", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<Result>()).toEqual({ changed: [{ target: "wh.orders.revenue", from: "draft", to: "approved" }], warnings: [] });
    expect(orders(root).measures[0]).toMatchObject({ status: "approved", approved_by: "Dana Ruiz", approved_at: "2026-03-02" });
    expect(text(root, ORDERS_FILE)).toContain("status: approved # gross\n");
  });

  test("--by is accepted when it names the same owner, ignoring case and spaces, and records the ledger's spelling", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue", { by: "Dana Ruiz" });
    const r = await approve(root, ["--target", "wh.orders.revenue", "--by", "  dana ruiz "]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Approved wh.orders.revenue (draft -> approved) by Dana Ruiz on 2026-01-15 (reply ans_0001).");
    expect(orders(root).measures[0]!.approved_by).toBe("Dana Ruiz");
  });

  test("--by naming someone else is refused and writes nothing", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue", { by: "Dana Ruiz" });
    const r = await approve(root, ["--target", "wh.orders.revenue", "--by", "Lee"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--by "Lee" is not the owner who said yes (ans_0001, to item 1 of rb_0001), "Dana Ruiz"');
    expect(r.err).toContain("sl approve --target wh.orders.revenue (it records the owner who said yes)");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
  });

  test("--date is refused: the date comes from the owner's recorded reply", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    const r = await approve(root, ["--target", "wh.orders.revenue", "--date", "2026-03-01"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--date is no longer taken: an approval's date now comes from the owner's recorded reply");
    expect(r.err).toContain("sl approve --target wh.orders.revenue.");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
  });
});

describe("approve --recursive", () => {
  test("each item records the owner who said yes to it", async () => {
    const root = await project();
    await recordReply(root, ["wh.orders", "wh.orders.order_status"], { by: "Dana" });
    await recordReply(root, ["wh.orders.revenue", "wh.orders.order_count"], { by: "Lee" });
    expect((await approve(root, ["--target", "wh.orders", "--recursive"])).code).toBe(0);
    const o = orders(root);
    expect([o.approved_by, o.dimensions[0]!.approved_by, o.measures[0]!.approved_by, o.measures[1]!.approved_by]).toEqual(["Dana", "Dana", "Lee", "Lee"]);
  });

  test("approves each item with its own yes and lists the others with their readback, exiting 1", async () => {
    const root = await project();
    await recordReply(root, ["wh.orders", "wh.orders.revenue"], { by: "Dana Ruiz" });
    await recordReply(root, "wh.orders.order_count", { verdict: "no" });
    const r = await approve(root, ["--target", "wh.orders", "--recursive"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Approved wh.orders (draft -> approved) by Dana Ruiz on 2026-01-15 (reply ans_0001).");
    expect(r.out).toContain("Approved wh.orders.revenue (draft -> approved) by Dana Ruiz on 2026-01-15 (reply ans_0002).");
    expect(r.out).toContain("  - wh.orders.order_status: no owner reply to its readback is recorded");
    expect(r.out).toContain('  - wh.orders.order_count: the owner\'s latest reply (ans_0003, to item 1 of rb_0002) is "no", not yes');
    expect(r.out).toContain("Next: sl readback --targets wh.orders.order_status,wh.orders.order_count, read it to the owner");
    expect(r.out).toContain("then sl approve --target wh.orders --recursive.");
    const o = orders(root);
    expect([o.status, o.dimensions[0]!.status, o.measures[0]!.status, o.measures[1]!.status]).toEqual(["approved", "draft", "approved", "draft"]);
    expect(o.dimensions[0]!.approved_by).toBeUndefined();
  });

  test("--json lists the refused items with the next command for each", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    const r = await approve(root, ["--target", "wh.orders", "--recursive", "--json"]);
    expect(r.code).toBe(1);
    const res = r.json<Result>();
    expect(res.changed).toEqual([{ target: "wh.orders.revenue", from: "draft", to: "approved" }]);
    expect(res.refused!.map((x) => x.target)).toEqual(["wh.orders", "wh.orders.order_status", "wh.orders.order_count"]);
    expect(res.refused![0]!.next).toContain("sl readback --targets wh.orders,");
  });

  test("without any yes it is refused and writes nothing", async () => {
    const root = await project();
    const r = await approve(root, ["--target", "wh.orders", "--recursive"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot approve wh.orders; nothing was approved:");
    expect(r.err).toContain("sl readback --targets wh.orders,wh.orders.order_status,wh.orders.revenue,wh.orders.order_count");
    expect(text(root, ORDERS_FILE)).toBe(ORDERS);
  });

  test("a problem on an item without a yes does not block the others, and is named to fix first", async () => {
    const root = await project();
    writeFileSync(join(root, ORDERS_FILE), ORDERS.replace("    description: Number of orders.\n", ""));
    await recordReply(root, "wh.orders.revenue");
    const r = await approve(root, ["--target", "wh.orders", "--recursive"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Approved wh.orders.revenue");
    expect(r.out).toContain("Before reading those back, fix:\n  - Measure wh.orders.order_count has no description");
  });
});

describe("revoke and stamp-hashes need no ledger", () => {
  test("--revoke returns an approved item to draft with no reply recorded", async () => {
    const root = await project();
    writeFileSync(join(root, ORDERS_FILE), ORDERS.replace("status: draft # gross", "status: approved # gross\n    approved_by: Dana\n    approved_at: 2026-01-02"));
    const r = await approve(root, ["--target", "wh.orders.revenue", "--revoke"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Revoked wh.orders.revenue (approved -> draft).");
    expect(orders(root).measures[0]!.status).toBe("draft");
    expect(existsSync(join(root, LEDGER))).toBe(false);
  });

  test("--revoke is not blocked by a later no", async () => {
    const root = await project();
    await recordReply(root, "wh.orders.revenue");
    expect((await approve(root, ["--target", "wh.orders.revenue"])).code).toBe(0);
    await recordReply(root, "wh.orders.revenue", { verdict: "no" });
    expect((await approve(root, ["--target", "wh.orders.revenue", "--revoke"])).code).toBe(0);
    expect(orders(root).measures[0]!.status).toBe("draft");
  });

  test("--stamp-hashes records hashes with no reply recorded", async () => {
    const root = await project();
    writeFileSync(join(root, "access.yaml"), ACCESS.replace("status: draft", "status: approved\napproved_by: Dana\napproved_at: 2026-01-03"));
    const r = await approve(root, ["--stamp-hashes", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ stamped: string[] }>().stamped).toEqual(["access"]);
    expect(existsSync(join(root, LEDGER))).toBe(false);
  });
});

describe("validate warns on approvals without a matching yes", () => {
  const WARNING = "no recorded owner yes in .sl/ledger.jsonl";

  test("one summary warning per file, with the count, the first items and their readback; none once each has a yes", async () => {
    const root = await project();
    // Approved by hand, as before sl approve required a yes: the model and its three fields.
    writeFileSync(join(root, ORDERS_FILE), ORDERS.replace(/^( *)status: draft(.*)$/gm, "$1status: approved$2\n$1approved_by: Dana\n$1approved_at: 2026-01-02"));
    expect(orders(root).status).toBe("approved");
    const ours = () => validateProject(root).filter((i) => i.message.includes(WARNING));
    expect(ours()).toEqual([
      {
        level: "warning",
        file: ORDERS_FILE,
        path: "",
        message:
          "4 approved items have no recorded owner yes in .sl/ledger.jsonl that matches them as they stand (approved before sl approve required one): " +
          "wh.orders, wh.orders.order_status, wh.orders.revenue and 1 more; they stay approved. To record a yes, read them back with " +
          "sl readback --targets wh.orders,wh.orders.order_status,wh.orders.revenue, then record the owner's answer with sl reply",
      },
    ]);
    // A warning, not an error.
    expect((await sl(root, ["validate"])).out).toContain(`warning 4 approved items have ${WARNING}`);
    await recordReply(root, ["wh.orders", "wh.orders.order_status", "wh.orders.revenue"]);
    expect(ours()[0]!.message).toContain("1 approved item has no recorded owner yes in .sl/ledger.jsonl that matches it as it stands (approved before sl approve required one): wh.orders.order_count; it stays approved. To record a yes, read it back with sl readback --targets wh.orders.order_count");
    await recordReply(root, "wh.orders.order_count");
    expect(ours()).toEqual([]);
    // A later no brings the warning back.
    await recordReply(root, "wh.orders.revenue", { verdict: "no" });
    expect(ours()[0]!.message).toStartWith("1 approved item has");
  });

  test("an approval made by sl approve on a yes draws no warning", async () => {
    const root = await project();
    await recordReply(root, "access");
    expect((await approve(root, ["--target", "access"])).code).toBe(0);
    expect(validateProject(root).filter((i) => i.message.includes(WARNING))).toEqual([]);
  });

  test("examples/acme gets at most one such warning per file", () => {
    const issues = validateProject(join(import.meta.dir, "..", "examples", "acme", "semantic")).filter((i) => i.message.includes(WARNING));
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.map((i) => i.file)).size).toBe(issues.length);
    expect(issues.every((i) => i.level === "warning")).toBe(true);
  });
});

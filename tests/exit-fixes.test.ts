// What the third exit walkthrough still met (docs/PRD-hardening.md HR-15): a refusal or an sl next
// step that names one typed edit gives it as an entry of the turn's one sl apply; the readback gate's
// step asks the owner plain questions with the apply input in action.stdin; sl draft describes plain
// counts; the way out of protection is named. On synthetic DuckDB data and copies of examples/acme.
import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import type { NextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { UNPROTECT } from "../skills/semantic-layer/scripts/lib/output.ts";
import { duckdbSource, initProject, sl, tempDir, tempRoot } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

async function ok(root: string, args: string[]): Promise<string> {
  const r = await sl(root, args);
  expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 0, err: "" });
  return r.out;
}
const next = async (root: string) => (await sl(root, ["next", "--json"])).json<NextAction>();

// A shop with one products table whose contact_code looks like personal data by its name.
async function shop(): Promise<{ root: string; dir: string }> {
  const dir = tempDir();
  const root = join(dir, "semantic");
  await initProject(root, "shop");
  await duckdbSource(root, dir, "wh", [
    "CREATE SCHEMA shop",
    "CREATE TABLE shop.products (product_id INTEGER PRIMARY KEY, contact_code VARCHAR, category VARCHAR, list_price DECIMAL(12,2))",
    "INSERT INTO shop.products SELECT i, 'C-' || (i % 9), CASE WHEN i % 2 = 0 THEN 'home' ELSE 'garden' END, (i * 7 % 90) / 10.0 FROM range(1, 40) t(i)",
  ]);
  // Follow sl next through intake, profile and draft until it reaches the interview.
  let a = await next(root);
  for (let i = 0; i < 12 && a.phase !== "interview"; i++) {
    expect(a.kind, `${a.phase}: ${a.why}`).toBe("run");
    await ok(root, [a.action.command, ...a.action.args]);
    a = await next(root);
  }
  return { root, dir };
}

describe("item 1: a typed edit a message names goes in the turn's sl apply", () => {
  test("sl check-rule's ignored-column refusal gives the ignore-column entry, and the apply with it and the rule runs", async () => {
    const { root, dir } = tempRoot();
    cpSync(ACME, root, { recursive: true });
    const customers = join(root, "models", "warehouse", "customers.yaml");
    writeFileSync(customers, readFileSync(customers, "utf8").replace("dimensions:\n", "ignored_columns:\n  - email\ndimensions:\n"));
    const rule = "customer.email like '%@example-test.com'";
    const r = await sl(root, ["check-rule", "--source", "warehouse", "--model", "orders", "--filter", rule]);
    expect(r.code).toBe(1);
    const entry = ["ignore-column", "--source", "warehouse", "--model", "customers", "--column", "email", "--remove"];
    expect(r.err).toContain(`with this entry in the turn's sl apply --file -, ahead of the edit that reads it: [${entry.map((w) => JSON.stringify(w)).join(", ")}]`);
    expect(r.err).toContain("(on its own: sl ignore-column --source warehouse --model customers --column email --remove)");
    // The entry and the edit that reads the column, in one apply: no command of their own.
    const file = join(dir, "turn.json");
    writeFileSync(file, JSON.stringify({ edits: [entry, ["add-field", "warehouse.orders", "--kind", "measure", "--name", "test_orders", "--agg", "count", "--filter", rule, "--description", "Orders by test accounts."]] }));
    await ok(root, ["apply", "--file", file]);
  });

  test("an sl next step that names one typed edit gives it as the apply entry", async () => {
    const { root } = tempRoot();
    cpSync(ACME, root, { recursive: true });
    await ok(root, ["approve", "--target", "warehouse.orders", "--revoke"]);
    const rb = JSON.parse(await ok(root, ["readback", "--targets", "warehouse.orders", "--json"])) as { readback_id: string };
    await ok(root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "Orders should exclude test accounts.", "--verdict", "change", "--by", "Dana"]);
    const a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", action: { command: "set", args: ["warehouse.orders", "<key>", "<value>"] } });
    expect(a.why).toContain(`Record it with this entry in the turn's sl apply --file -, beside the turn's other edits: ["set", "warehouse.orders", "<key>", "<value>"] (on its own: sl set warehouse.orders <key> <value>).`);
    // The owner hears the question, not the apply.
    expect(a.ask_owner!.text).not.toContain("sl apply");
  });
});

describe("item 1: refusals that name another typed edit give its apply entry", () => {
  test("sl set's owned keys, a taken field or metric name, and a removal that rename suits", async () => {
    const { root } = tempRoot();
    cpSync(ACME, root, { recursive: true });
    const cases: [string[], string][] = [
      [["set", "warehouse.orders", "ignored_columns", "x"], '["ignore-column", "--source", "warehouse", "--model", "orders", "--column", "<column>"]'],
      [["set", "warehouse.orders", "open_questions", "x"], '["question", "add", "warehouse.orders", "--text", "<question>"]'],
      [["set", "warehouse.orders.revenue", "name", "x"], '["rename", "warehouse.orders.revenue", "<new_name>"]'],
      [["add-field", "warehouse.orders", "--kind", "measure", "--name", "revenue", "--expr", "x"], '["set", "warehouse.orders.revenue", "<key>", "<value>"]'],
      [["add-metric", "--name", "average_order_value", "--type", "ratio", "--numerator", "orders.revenue", "--denominator", "orders.order_count"], '["set", "metric:average_order_value", "<key>", "<value>"]'],
      [["remove-metric", "metric:average_order_value", "--force"], '["rename", "metric:average_order_value", "<new_name>"]'],
    ];
    for (const [args, entry] of cases) {
      const r = await sl(root, args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain(`in the turn's sl apply --file -: ${entry}`);
    }
  });
});

describe("items 3 and 4: the readback gate's step and drafted counts", () => {
  test("ask_owner.text asks plain questions, action.stdin holds the apply, and a drafted count needs no description", async () => {
    const { root, dir } = await shop();
    const a = await next(root);
    expect(a).toMatchObject({ kind: "ask_owner", phase: "interview", action: { command: "apply", args: ["--file", "-"], kind: "ask_owner" } });
    const text = a.ask_owner!.text;
    expect(text).toStartWith("Before I read these back for your sign-off, I need your words:\n1. ");
    expect(text).toContain("What is one row of products?");
    for (const agentWords of ["<", "{", "[", "sl apply", "sl "]) expect(text).not.toContain(agentWords);
    const edits = (JSON.parse(a.action.stdin!) as { edits: string[][] }).edits;
    // The same edits the why names.
    expect(a.why).toContain(a.action.stdin!);
    expect(edits).toContainEqual(["set", "wh.products", "grain", "<what one row is, in the owner's words>"]);
    // The row count is described at draft time, so the gate does not stop on it.
    expect(edits.some((e) => e[1] === "wh.products.product_count")).toBe(false);
    expect(readFileSync(join(root, "models", "wh", "products.yaml"), "utf8")).toContain("description: Number of rows of shop.products");
    // The owner's words in place of each <placeholder> run, and the readback follows.
    const filled = edits.map((e) => e.map((w) => (w.startsWith("<pii") ? "pii" : w.startsWith("<ISO") ? "USD" : w.startsWith("<") ? "One product in the catalogue." : w)));
    const file = join(dir, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: filled }));
    await ok(root, ["apply", "--file", file]);
    expect(await next(root)).toMatchObject({ kind: "run", action: { command: "readback" } });
  });

  test("a description is outside the approval hash, so describing a drafted count changes no recorded approval", () => {
    const measure = { name: "product_count", agg: "count", format: "integer", status: "approved" };
    const scope = { source: "wh", model: { model: "products", source: "wh", table: "shop.products" } as never };
    expect(itemHash("measure", { ...measure, description: "Number of rows of shop.products" }, scope)).toBe(itemHash("measure", measure, scope));
  });
});

describe("item 5: the way out of protection is named", () => {
  test("sl run's note and a readback name it, and tagging the field public in one apply shows the values", async () => {
    const { root, dir } = await shop();
    const run = await sl(root, ["run", "--source", "wh", "--sql", "select contact_code from shop.products order by product_id limit 1"]);
    expect(run.out).toContain("[protected]");
    expect(run.out).toContain(UNPROTECT);
    const rb = await sl(root, ["readback", "--targets", "wh.products.contact_code"]);
    expect(rb.code).toBe(0);
    expect(rb.out).toContain("protected, so counts only and no values");
    expect(rb.out).toEndWith(UNPROTECT);
    expect((await sl(root, ["readback", "--targets", "wh.products.contact_code", "--json"])).json<{ protected_note: string }>().protected_note).toBe(UNPROTECT);
    // The owner says it is not personal data: the two entries the note names, in one apply.
    const file = join(dir, "unprotect.json");
    writeFileSync(file, JSON.stringify({ edits: [["tag", "wh.products.contact_code", "pii", "--remove"], ["tag", "wh.products.contact_code", "public"]] }));
    await ok(root, ["apply", "--file", file]);
    const shown = await sl(root, ["run", "--source", "wh", "--sql", "select contact_code from shop.products order by product_id limit 1"]);
    expect(shown.out).toContain("C-1");
    expect(shown.out).not.toContain("[protected]");
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readChangelog } from "../skills/semantic-layer/scripts/lib/release.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// semlayer goldens remove and the request rules of semlayer goldens new and semlayer validate (spec: goldens,
// Writing and confirming), on a copy of the example layer. The walkthrough's request filtered on a time
// dimension with no grain beside a comparison over it by month, which the compiler refuses for its own shape.

const WALKTHROUGH = {
  source: "warehouse",
  measures: ["orders.revenue"],
  dimensions: ["orders.order_date:month"],
  filters: [{ field: "orders.order_date", op: "gte", value: "2025-01-01" }],
  compare: { over: "orders.order_date:month", with: ["prior"] },
};
const FIXED = { ...WALKTHROUGH, filters: [{ field: "orders.order_date:month", op: "gte", value: "2025-01-01" }] };

interface Refusal {
  error: string;
  code: string;
  next: string;
}

// Every file of goldens/ with its bytes, to show a command leaves the directory as it was.
const goldensDir = (root: string) => Object.fromEntries(readdirSync(join(root, "goldens")).sort().map((f) => [f, readFileSync(join(root, "goldens", f), "utf8")]));
const newArgs = (name: string, request: unknown) => ["goldens", "new", "--name", name, "--question", "What was revenue each month against the month before?", "--request", JSON.stringify(request)];

describe("goldens new refuses a request that does not compile for its own shape", () => {
  test("the walkthrough's request is refused with the compiler's message and nothing is written", async () => {
    const root = releaseFixture();
    const before = goldensDir(root);
    const plain = await semlayer(root, newArgs("revenue_mom", WALKTHROUGH));
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("The request does not compile, so nothing was written");
    expect(plain.err).toContain("write the field as orders.order_date:month");
    expect(plain.err).toContain("semlayer goldens new");
    const j = await semlayer(root, [...newArgs("revenue_mom", WALKTHROUGH), "--json"]);
    expect(j.json<Refusal>()).toMatchObject({ code: "golden.request_invalid", next: "semlayer goldens new" });
    expect(goldensDir(root)).toEqual(before);
    // Written as the message says, it compiles and is written.
    expect((await semlayer(root, newArgs("revenue_mom", FIXED))).code).toBe(0);
    expect(existsSync(join(root, "goldens", "revenue_mom.yaml"))).toBe(true);
  });

  test("inside semlayer apply the batch is refused and nothing is written", async () => {
    const root = releaseFixture();
    const before = goldensDir(root);
    const file = join(root, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [newArgs("revenue_ok", FIXED), newArgs("revenue_mom", WALKTHROUGH)] }));
    const r = await semlayer(root, ["apply", "--file", file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("write the field as orders.order_date:month");
    expect(goldensDir(root)).toEqual(before);
  });
});

describe("a broken draft golden", () => {
  test("is warned by validate, naming goldens remove and goldens new, and removed by goldens remove", async () => {
    const root = releaseFixture();
    writeFileSync(join(root, "goldens", "revenue_mom.yaml"), `name: revenue_mom\nquestion: Revenue against the month before?\nrequest: ${JSON.stringify(WALKTHROUGH)}\nstatus: draft\n`);
    const warned = validateProject(root).filter((i) => i.code === "golden.draft_request_invalid");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: "warning", file: "goldens/revenue_mom.yaml", path: "request" });
    expect(warned[0]!.message).toContain("write the field as orders.order_date:month");
    expect(warned[0]!.message).toContain("semlayer goldens remove --name revenue_mom");
    expect(warned[0]!.message).toContain("semlayer goldens new");
    const r = await semlayer(root, ["goldens", "remove", "--name", "revenue_mom", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ removed: "golden:revenue_mom", file: "goldens/revenue_mom.yaml", next: "semlayer status" });
    expect(existsSync(join(root, "goldens", "revenue_mom.yaml"))).toBe(false);
    expect(validateProject(root).filter((i) => i.code === "golden.draft_request_invalid")).toEqual([]);
  });

  test("a draft that reads a draft item, or a measure not yet in the layer, is written and not warned", async () => {
    const root = releaseFixture();
    expect((await semlayer(root, newArgs("products_by_launch", { source: "warehouse", dimensions: ["products.launched_on:day"] }))).code).toBe(0);
    const later = await semlayer(root, newArgs("gross_margin", { source: "warehouse", measures: ["orders.gross_margin"] }));
    expect(later.code).toBe(0);
    expect(later.out).toContain("Its request does not compile from the current YAML yet");
    const issues = validateProject(root);
    expect(issues.filter((i) => i.code === "golden.draft_request_invalid")).toEqual([]);
    expect(issues.some((i) => i.code === "golden.field_missing_draft" && i.file === "goldens/gross_margin.yaml")).toBe(true);
  });
});

describe("goldens remove", () => {
  test("a confirmed golden is refused, naming goldens unconfirm, and an unknown name is refused, both writing nothing", async () => {
    const root = releaseFixture();
    const before = goldensDir(root);
    const confirmed = await semlayer(root, ["goldens", "remove", "--name", "spend_2025", "--json"]);
    expect(confirmed.code).toBe(1);
    expect(confirmed.json<Refusal>()).toMatchObject({ code: "golden.confirmed", next: "semlayer goldens unconfirm --name spend_2025" });
    const unknown = await semlayer(root, ["goldens", "remove", "--name", "no_such_golden", "--json"]);
    expect(unknown.json<Refusal>()).toMatchObject({ code: "golden.unknown", next: "semlayer status" });
    expect(goldensDir(root)).toEqual(before);
  });

  test("a draft file that does not parse is removed; a .yml golden is not listed as existing", async () => {
    const root = releaseFixture();
    writeFileSync(join(root, "goldens", "broken.yaml"), "name: broken\nquestion: [unclosed\nstatus: draft\n");
    expect((await semlayer(root, ["goldens", "remove", "--name", "broken"])).code).toBe(0);
    expect(existsSync(join(root, "goldens", "broken.yaml"))).toBe(false);
    writeFileSync(join(root, "goldens", "yml_check.yml"), "name: yml_check\nstatus: draft\n");
    const r = await semlayer(root, ["goldens", "remove", "--name", "yml_check"]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("yml_check,");
    expect(r.err).not.toMatch(/Goldens:.*yml_check/);
  });

  test("add then remove leaves goldens/ byte-identical, also inside semlayer apply", async () => {
    const root = releaseFixture();
    const before = goldensDir(root);
    expect((await semlayer(root, newArgs("revenue_mom", FIXED))).code).toBe(0);
    expect(goldensDir(root)).not.toEqual(before);
    const plain = await semlayer(root, ["goldens", "remove", "--name", "revenue_mom"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("Removed goldens/revenue_mom.yaml, a draft golden.");
    expect(goldensDir(root)).toEqual(before);
    const file = join(root, "edits.json");
    writeFileSync(file, JSON.stringify({ edits: [newArgs("revenue_mom", FIXED), ["goldens", "remove", "--name", "revenue_mom"]] }));
    expect((await semlayer(root, ["apply", "--file", file])).code).toBe(0);
    expect(goldensDir(root)).toEqual(before);
  });

  test("in a change round, a golden the last release held that is unconfirmed and removed is named as removed", async () => {
    const root = releaseFixture();
    expect((await semlayer(root, ["change", "close", "--version", "1.0"])).code).toBe(0);
    expect((await semlayer(root, ["change", "start", "--note", "Drop the sessions check", "--by", "Dana Ruiz"])).code).toBe(0);
    expect((await semlayer(root, ["goldens", "unconfirm", "--name", "sessions_2025"])).code).toBe(0);
    expect((await semlayer(root, ["goldens", "remove", "--name", "sessions_2025"])).code).toBe(0);
    const r = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ goldens_removed: ["sessions_2025"], goldens_unconfirmed: [] });
    const entry = readChangelog(root)!.entries[1]!;
    expect(entry.goldens_removed).toEqual(["sessions_2025"]);
    expect(entry.goldens.sessions_2025).toBeUndefined();
    expect(validateProject(root).filter((i) => i.level === "error")).toEqual([]);
  });
});

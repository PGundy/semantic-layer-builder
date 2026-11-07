import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { setGolden } from "../skills/semantic-layer/scripts/lib/set-targets.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl, tempRoot } from "./helpers.ts";

// Typed edits, part 3: sl set on the targets approve does not name. sl set access mode creates a
// missing access.yaml; sl set golden:<g> writes a golden's role, user, reference and tolerance; sl set
// source:<s> writes a source's description. All on a copy of examples/acme (synthetic data).

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

let root = "";
let dir = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
  const t = tempRoot();
  ({ root, dir, cleanup } = t);
  cpSync(ACME, root, { recursive: true });
});
afterEach(() => cleanup?.());

const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const errors = async () => (await sl(root, ["validate", "--json"])).json<{ issues: { level: string; file: string; message: string }[] }>().issues.filter((i) => i.level === "error");

// Asserts that `after` is `before` with exactly the given edits, so every other byte is identical.
function expectOnly(before: string, after: string, edits: [string, string][]): void {
  let expected = before;
  for (const [from, to] of edits) {
    expect(expected.split(from).length).toBe(2);
    expected = expected.replace(from, to);
  }
  expect(after).toBe(expected);
}

// A root with no access.yaml and no golden that names a role or user, which wait for the file.
function withoutAccess(): void {
  rmSync(join(root, "access.yaml"));
  rmSync(join(root, "goldens"), { recursive: true });
}

describe("sl set access mode with no access.yaml", () => {
  test("creates a draft file holding the mode, says what it wrote and the next step, and validates", async () => {
    withoutAccess();
    const r = await sl(root, ["set", "access", "mode", "open"]);
    expect(r.code).toBe(0);
    expect(text("access.yaml")).toBe("mode: open\nstatus: draft\n");
    expect(r.out).toContain("Created access.yaml as a draft with mode open");
    expect(r.out).toContain("Tools serve nothing under a draft access.yaml until it is approved.");
    expect(r.out).toContain("Next: sl access");
    expect(r.out).toContain("sl readback --targets access");
    expect(await errors()).toEqual([]);
    // The file now exists, so the typed access edits work on it, and the same mode again is a no-op.
    const again = await sl(root, ["set", "access", "mode", "open", "--json"]);
    expect(again.json()).toEqual({ changed: false, file: "access.yaml", reapprove: [], ref: "access", key: "mode", value: "open" });
    expect((await sl(root, ["question", "add", "access", "--text", "Who may see refunds?"])).code).toBe(0);
  });

  test("--json reports created, and closed mode says nobody sees anything until roles are added", async () => {
    withoutAccess();
    const r = await sl(root, ["set", "access", "mode", "closed", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ changed: true, created: true, file: "access.yaml", reapprove: [], ref: "access", key: "mode", value: "closed" });
    expect(text("access.yaml")).toBe("mode: closed\nstatus: draft\n");
    const human = await (async () => {
      rmSync(join(root, "access.yaml"));
      return sl(root, ["set", "access", "mode", "closed"]);
    })();
    expect(human.out).toContain("nobody sees anything until roles are added");
  });

  test("is deterministic: the same call on two copies writes the same bytes", async () => {
    withoutAccess();
    const other = tempRoot();
    try {
      cpSync(root, other.root, { recursive: true });
      expect((await sl(root, ["set", "access", "mode", "open"])).code).toBe(0);
      expect((await sl(other.root, ["set", "access", "mode", "open"], { SL_NOW: "2030-06-01T00:00:00Z" })).code).toBe(0);
      expect(readFileSync(join(other.root, "access.yaml"), "utf8")).toBe(text("access.yaml"));
    } finally {
      other.cleanup();
    }
  });

  test("refuses another mode, other keys and --unset, naming sl set access mode, and writes nothing", async () => {
    withoutAccess();
    const bad = await sl(root, ["set", "access", "mode", "everyone"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("mode is open or closed");
    for (const args of [["default_role", "analyst"], ["mode", "--unset"]]) {
      const r = await sl(root, ["set", "access", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("sl set access mode open (or closed for an allowlist)");
    }
    expect(existsSync(join(root, "access.yaml"))).toBe(false);
  });

  test("refuses, writing nothing, when the new file would add an error: a golden's role the file does not declare", async () => {
    rmSync(join(root, "access.yaml"));
    const r = await sl(root, ["set", "access", "mode", "open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot create access.yaml: the project would not validate with it, so nothing was written");
    expect(r.err).toContain('goldens/sales_rep_101_2025.yaml role: names unknown role "sales"');
    expect(r.err).toContain("sl set golden:<g> role --unset");
    expect(existsSync(join(root, "access.yaml"))).toBe(false);
  });

  test("a refusal in closed mode for what nobody may see points at open mode, not at a golden's role", async () => {
    rmSync(join(root, "access.yaml"));
    for (const f of readdirSync(join(root, "goldens"))) if (/\n(role|user):/.test(text(`goldens/${f}`))) rmSync(join(root, "goldens", f));
    const r = await sl(root, ["set", "access", "mode", "closed"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("may not see");
    expect(r.err).toContain("start with sl set access mode open");
    expect(r.err).not.toContain("role --unset");
    expect(existsSync(join(root, "access.yaml"))).toBe(false);
  });

  test("never writes through a link at the path, even one to nothing outside the root", async () => {
    withoutAccess();
    const outside = join(dir, "outside-access.yaml");
    symlinkSync(outside, join(root, "access.yaml"));
    const r = await sl(root, ["set", "access", "mode", "open"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Refusing to create access.yaml");
    expect(existsSync(outside)).toBe(false);
  });

  test("with access.yaml present, behaves as before: an approved file is refused until revoked", async () => {
    const before = text("access.yaml");
    const r = await sl(root, ["set", "access", "mode", "closed"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("sl approve --target access --revoke");
    expect(text("access.yaml")).toBe(before);
  });
});

const REP = "goldens/sales_rep_101_2025.yaml";
const DRAFT = "goldens/draft_revenue.yaml";
const DRAFT_TEXT = "# Drafted in session 4.\nname: draft_revenue\nquestion: What was revenue in 2025?\nrequest:\n  source: warehouse\n  measures: [orders.revenue]\nstatus: draft # not yet confirmed\n";

// A synthetic owner yes in the ledger to the confirmed golden REP as it stands.
function recordYes(): void {
  const g = readYaml<Record<string, unknown>>(join(root, REP));
  const exp = g.expected as { rows: unknown[]; tolerance: number };
  const line = { kind: "reply", id: "r_synthetic_1", target: "golden:sales_rep_101_2025", content_hash: goldenHash(g, exp.rows, exp.tolerance), by: "Dana", at: "2026-01-15T12:00:00.000Z", verdict: "yes", text: "Yes." };
  mkdirSync(join(root, ".sl"), { recursive: true });
  writeFileSync(join(root, ".sl", "ledger.jsonl"), `${JSON.stringify(line)}\n`);
}

describe("sl set golden:<g>", () => {
  test("writes reference, role, user and tolerance on a draft golden, keeping its comments", async () => {
    writeFileSync(join(root, DRAFT), DRAFT_TEXT);
    const ref = await sl(root, ["set", "golden:draft_revenue", "reference", "Finance close\nfor 2025\x1b[31m: $1.2M.", "--json"]);
    expect(ref.code).toBe(0);
    expect(ref.json()).toEqual({ changed: true, file: DRAFT, reapprove: [], ref: "golden:draft_revenue", key: "reference", value: "Finance close for 2025: $1.2M." });
    expect((await sl(root, ["set", "golden:draft_revenue", "role", "finance"])).code).toBe(0);
    expect((await sl(root, ["set", "golden:draft_revenue", "user", '{"department": "finance"}'])).code).toBe(0);
    const tol = await sl(root, ["set", "golden:draft_revenue", "tolerance", "0"]);
    expect(tol.code).toBe(0);
    expect(tol.out).toContain("Next: sl readback --targets golden:draft_revenue reads it back at tolerance 0.");
    expect(text(DRAFT)).toBe(
      "# Drafted in session 4.\nname: draft_revenue\nquestion: What was revenue in 2025?\nrole: finance\nuser:\n  department: finance\nrequest:\n  source: warehouse\n  measures: [orders.revenue]\n" +
        'reference: "Finance close for 2025: $1.2M."\nstatus: draft # not yet confirmed\nexpected:\n  tolerance: 0\n  rows: []\n',
    );
    expect(await errors()).toEqual([]);
    // Unsetting the tolerance removes the expected: { rows: [] } it added, and unsetting the rest restores the file.
    for (const key of ["tolerance", "user", "role", "reference"]) expect((await sl(root, ["set", "golden:draft_revenue", key, "--unset"])).code).toBe(0);
    expect(text(DRAFT)).toBe(DRAFT_TEXT);
  });

  test("is idempotent, and validates each value: tolerance a number from 0 up to 1, user a JSON object, role a known role", async () => {
    writeFileSync(join(root, DRAFT), DRAFT_TEXT);
    expect((await sl(root, ["set", "golden:draft_revenue", "role", "analyst"])).code).toBe(0);
    const same = await sl(root, ["set", "golden:draft_revenue", "role", "analyst", "--json"]);
    expect(same.json()).toMatchObject({ changed: false, reapprove: [] });
    const cases: [string, string, string][] = [
      ["tolerance", "1e-12x", "tolerance is a number from 0 up to 1"],
      ["tolerance", "1", "tolerance is a number from 0 up to 1"],
      ["tolerance", "half", "tolerance is a number from 0 up to 1"],
      ["tolerance", "0x0", "tolerance is a number from 0 up to 1"],
      ["tolerance", "0b0", "tolerance is a number from 0 up to 1"],
      ["user", '{"department": "fin\\nance"}', "no control characters"],
      ["user", '{"department": "x\\u001b[31m"}', "no control characters"],
      ["user", "[1]", "user is a JSON object of user attributes"],
      ["user", "{department: x}", "user is a JSON object of user attributes"],
      ["user", '{"shoe_size": 9}', '"shoe_size" is not a declared user attribute'],
      ["role", "marketing", 'names unknown role "marketing"'],
      ["role", "Bad Role", "must match"],
      ["reference", "  ", "reference is empty"],
    ];
    const before = text(DRAFT);
    for (const [key, value, msg] of cases) {
      const r = await sl(root, ["set", "golden:draft_revenue", key, value]);
      expect(`${key}=${value}: ${r.code}`).toBe(`${key}=${value}: 1`);
      expect(r.err).toContain(msg);
    }
    expect(text(DRAFT)).toBe(before);
    // A negative value reads as a flag on the command line; the library refuses it too.
    expect(() => setGolden(root, "draft_revenue", "tolerance", "-0.1")).toThrow("tolerance is a number from 0 up to 1");
    expect(text(DRAFT)).toBe(before);
  });

  test("with no access.yaml, refuses a role or user, naming sl set access mode, and still takes the other keys", async () => {
    withoutAccess();
    mkdirSync(join(root, "goldens"));
    writeFileSync(join(root, DRAFT), DRAFT_TEXT);
    for (const [key, value] of [["role", "nosuchrole"], ["user", '{"department": "finance"}']]) {
      const r = await sl(root, ["set", "golden:draft_revenue", key!, value!]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("There is no access.yaml yet");
      expect(r.err).toContain("sl set access mode open");
    }
    expect(text(DRAFT)).toBe(DRAFT_TEXT);
    expect((await sl(root, ["set", "golden:draft_revenue", "reference", "Finance close."])).code).toBe(0);
    expect((await sl(root, ["set", "golden:draft_revenue", "role", "--unset", "--json"])).json()).toMatchObject({ changed: false });
    // Nothing the typed edits wrote stands in the way of creating access.yaml.
    expect((await sl(root, ["set", "access", "mode", "open"])).code).toBe(0);
  });

  test("refuses a malformed golden or source name, naming sl status", async () => {
    for (const ref of ["golden:a.b", "source:../x", "golden:", "source:Bad"]) {
      const r = await sl(root, ["set", ref, "description", "x"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("lower-case letters, digits and _");
      expect(r.err).toContain("sl status lists them");
    }
  });

  test("refuses an unknown key with the keys it takes, the confirmation fields naming sl goldens confirm, and a missing golden", async () => {
    const before = text(REP);
    const unknown = await sl(root, ["set", "golden:sales_rep_101_2025", "question", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('takes role, user, reference, tolerance, not "question"');
    for (const key of ["status", "confirmed_by", "confirmed_at", "confirmed_as"]) {
      const r = await sl(root, ["set", "golden:sales_rep_101_2025", key, "x"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("only sl goldens confirm writes");
      expect(r.err).toContain("sl readback --targets golden:sales_rep_101_2025");
    }
    const missing = await sl(root, ["set", "golden:nope", "role", "analyst"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('No golden "nope"');
    expect(missing.err).toContain("sl goldens new");
    expect(text(REP)).toBe(before);
  });

  test("on a confirmed golden, refuses tolerance, naming the readback at the new tolerance and sl goldens confirm", async () => {
    const before = text(REP);
    for (const args of [["tolerance", "0.01"], ["tolerance", "--unset"]]) {
      const r = await sl(root, ["set", "golden:sales_rep_101_2025", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("golden:sales_rep_101_2025 is confirmed, and its tolerance is what the owner said yes to");
      expect(r.err).toContain("sl readback --targets golden:sales_rep_101_2025 --tolerance");
      expect(r.err).toContain("sl goldens confirm --name sales_rep_101_2025 --tolerance");
    }
    // The tolerance it already records is no change.
    expect((await sl(root, ["set", "golden:sales_rep_101_2025", "tolerance", "0", "--json"])).json()).toMatchObject({ changed: false });
    expect(text(REP)).toBe(before);
    // With no tolerance written, the default its confirmation hashed is no change either.
    const noTol = before.replace("  tolerance: 0\n", "");
    expect(noTol).not.toBe(before);
    writeFileSync(join(root, REP), noTol);
    expect((await sl(root, ["set", "golden:sales_rep_101_2025", "tolerance", "0.005", "--json"])).json()).toMatchObject({ changed: false });
    expect((await sl(root, ["set", "golden:sales_rep_101_2025", "tolerance", "0.01"])).code).toBe(1);
    expect(text(REP)).toBe(noTol);
  });

  test("on a confirmed golden, a role or user change is written and routed to re-confirmation; reference is outside the hash", async () => {
    recordYes();
    const unconfirmed = async () =>
      (await sl(root, ["validate", "--json"])).json<{ issues: { file: string; message: string }[] }>().issues.filter((i) => i.file === REP && i.message.includes("no recorded owner yes"));
    expect(await unconfirmed()).toEqual([]);
    const before = text(REP);
    const ref = await sl(root, ["set", "golden:sales_rep_101_2025", "reference", "Dana's 2025 report for rep 101.", "--json"]);
    expect(ref.json()).toMatchObject({ changed: true, reapprove: [] });
    const role = await sl(root, ["set", "golden:sales_rep_101_2025", "role", "analyst"]);
    expect(role.code).toBe(0);
    expect(role.out).toContain("golden:sales_rep_101_2025 is confirmed and its role changed, so its confirmation needs the owner's yes again");
    expect(role.out).toContain("sl readback --targets golden:sales_rep_101_2025");
    expect(role.out).toContain("sl goldens confirm --name sales_rep_101_2025");
    const user = await sl(root, ["set", "golden:sales_rep_101_2025", "user", '{"department": "analytics"}', "--json"]);
    expect(user.json()).toMatchObject({ changed: true, reapprove: ["golden:sales_rep_101_2025"] });
    // The status and confirmation fields stay as sl goldens confirm wrote them; validate warns until a new yes.
    expect(text(REP)).toContain("status: approved\n");
    expect(text(REP)).toContain("confirmed_by: Dana Ruiz\n");
    expect((await errors()).filter((i) => i.file === REP)).toEqual([]);
    expect((await unconfirmed()).length).toBe(1);
    expect(before).not.toBe(text(REP));
  });

  test("a change back to what a recorded owner yes matches asks for no re-confirmation", async () => {
    recordYes();
    const before = text(REP);
    expect((await sl(root, ["set", "golden:sales_rep_101_2025", "role", "analyst", "--json"])).json()).toMatchObject({ reapprove: ["golden:sales_rep_101_2025"] });
    const back = await sl(root, ["set", "golden:sales_rep_101_2025", "role", "sales", "--json"]);
    expect(back.json()).toMatchObject({ changed: true, reapprove: [] });
    expect(text(REP)).toBe(before);
  });
});

describe("sl set source:<s>", () => {
  const SRC = "sources/warehouse.yaml";

  test("writes the description as one plain line, keeping every other byte, and validates", async () => {
    const before = text(SRC);
    const r = await sl(root, ["set", "source:warehouse", "description", "Read replica\nof the order system\x1b[31m\x07. # not a comment", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ changed: true, file: SRC, reapprove: [], ref: "source:warehouse", key: "description", value: "Read replica of the order system. # not a comment" });
    expectOnly(before, text(SRC), [["description: Acme's Postgres warehouse, schema acme.\n", 'description: "Read replica of the order system. # not a comment"\n']]);
    expect(readYaml<{ description: string }>(join(root, SRC)).description).toBe("Read replica of the order system. # not a comment");
    expect(await errors()).toEqual([]);
    expect((await sl(root, ["set", "source:warehouse", "description", "Read replica of the order system. # not a comment", "--json"])).json()).toMatchObject({ changed: false });
  });

  test("a source with no description gets one after its dialect; --unset removes it", async () => {
    const before = text(SRC).replace("description: Acme's Postgres warehouse, schema acme.\n", "");
    writeFileSync(join(root, SRC), before);
    const r = await sl(root, ["set", "source:warehouse", "description", "The order system."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Set description on source:warehouse in sources/warehouse.yaml.");
    expect(r.out).toContain("Next: sl status.");
    expect(text(SRC)).toBe(before.replace("dialect: postgres\n", "dialect: postgres\ndescription: The order system.\n"));
    expect((await sl(root, ["set", "source:warehouse", "description", "--unset"])).code).toBe(0);
    expect(text(SRC)).toBe(before);
  });

  test("refuses other keys with the keys it takes, empty text and a missing source, writing nothing", async () => {
    const before = text(SRC);
    const key = await sl(root, ["set", "source:warehouse", "dialect", "duckdb"]);
    expect(key.code).toBe(1);
    expect(key.err).toContain('takes description, not "dialect"');
    const empty = await sl(root, ["set", "source:warehouse", "description", "\x07 \n"]);
    expect(empty.err).toContain("description is empty");
    const missing = await sl(root, ["set", "source:crm", "description", "x"]);
    expect(missing.err).toContain('No source "crm"');
    expect(text(SRC)).toBe(before);
  });
});

describe("sl set --help", () => {
  test("names the golden and source targets and access creation", async () => {
    const r = await sl(root, ["set", "--help"]);
    expect(r.out).toContain("sl set golden:<name> (role | user | reference | tolerance) (<value> | --unset)");
    expect(r.out).toContain("sl set source:<name> description (<value> | --unset)");
    expect(r.out).toContain("With no access.yaml, sl set access mode open|closed creates a draft one");
  });
});

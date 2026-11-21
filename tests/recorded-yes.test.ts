// An approval counts only while the owner's recorded yes stands behind it (docs/PRD.md section 7,
// invariant 5; spec: Approval requires a recorded yes). A stamp written straight into a file, with a
// correct approved_hash and no readback, is a draft for every reader: validate, status, next, the access
// evaluator, the compiler and change close. On copies of examples/acme and small synthetic projects.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap } from "yaml";
import { type AccessVisibility, evaluateAccess } from "../skills/semantic-layer/scripts/lib/access.ts";
import { listApprovals } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { projectApprovals } from "../skills/semantic-layer/scripts/lib/approvals.ts";
import { compileRequest } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { nextAction } from "../skills/semantic-layer/scripts/lib/next.ts";
import { readApprovalLedger } from "../skills/semantic-layer/scripts/lib/ledger.ts";
import { applyEntryRefusal, ROLES, semlayerRefusal } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { backedPairs } from "../skills/semantic-layer/scripts/lib/schema-scope.ts";
import type { ProjectStatus } from "../skills/semantic-layer/scripts/lib/status.ts";
import type { Issue } from "../skills/semantic-layer/scripts/lib/schema.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { updateYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, confirmExisting, duckdbSource, FIXED_NOW, initProject, recordReply, semlayer, tempRoot } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const LEDGER = ".semlayer/ledger.jsonl";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function acme(ledger = true): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  cpSync(ACME, t.root, { recursive: true });
  if (!ledger) rmSync(join(t.root, ".semlayer"), { recursive: true });
  return t.root;
}

// Writes an approval straight into the item's file, as a shell write, a script or a merge would: status,
// approved_by, approved_at and the approved_hash semlayer approve would record, with no readback.
function forge(root: string, ref: string): void {
  const e = projectApprovals(root).find((x) => x.ref === ref)!;
  expect(e).toBeDefined();
  updateYaml(e.file!, (doc) => {
    const node = e.path.length ? doc.getIn(e.path, true) : doc.contents;
    if (!isMap(node)) throw new Error(`${ref} is not a mapping`);
    node.delete("last_approved");
    node.set("status", "approved");
    node.set("approved_by", "Dana Ruiz");
    node.set("approved_at", "2026-11-01");
    node.set("approved_hash", e.hash);
  });
}

const status = async (root: string) => (await semlayer(root, ["status", "--json"])).json<ProjectStatus>();
const findings = (root: string, ref?: string): Issue[] =>
  validateProject(root).filter((i) => (i.code === "approval.no_recorded_yes" || i.code === "approval.no_ledger") && (!ref || i.message.startsWith(`${ref} `)));

// What the access evaluator says of an item, without the flag that names why it is a draft.
function seen(v: AccessVisibility, ref: string): unknown {
  if (ref === "access") return v.access_file;
  const [source, model, field] = ref.startsWith("metric:") ? ["warehouse", "", ref.slice(7)] : (ref.split(".") as [string, string, string?]);
  const s = v.sources.find((x) => x.source === source)!;
  const hit = ref.startsWith("metric:") ? s.metrics.find((m) => m.name === field) : field ? s.models.find((m) => m.model === model)?.fields.find((f) => f.name === field) : s.models.find((m) => m.model === model);
  if (!hit) return undefined;
  const { no_recorded_yes: _flag, ...rest } = hit as unknown as Record<string, unknown>;
  return rest;
}

// Each kind of item, with a typed edit that gives it content the owner has not answered, and a request that needs it.
const reword = (ref: string) => ["set", ref, "description", "Reworded since the owner's answer."];
const KINDS: { kind: string; ref: string; edit: string[]; request: Record<string, unknown> }[] = [
  { kind: "dimension", ref: "warehouse.orders.status", edit: reword("warehouse.orders.status"), request: { source: "warehouse", measures: ["orders.order_count"], dimensions: ["orders.status"] } },
  { kind: "measure", ref: "warehouse.orders.revenue", edit: reword("warehouse.orders.revenue"), request: { source: "warehouse", measures: ["orders.revenue"] } },
  {
    kind: "join",
    ref: "warehouse.orders.ship_to_region",
    edit: reword("warehouse.orders.ship_to_region"),
    request: { source: "warehouse", measures: ["orders.order_count"], dimensions: ["regions.region_name"] },
  },
  { kind: "model", ref: "warehouse.regions", edit: reword("warehouse.regions"), request: { source: "warehouse", measures: ["orders.order_count"], dimensions: ["regions.region_name"] } },
  { kind: "metric", ref: "metric:average_order_value", edit: reword("metric:average_order_value"), request: { source: "warehouse", measures: ["average_order_value"] } },
  { kind: "access", ref: "access", edit: ["add-role", "--name", "auditors"], request: { source: "warehouse", measures: ["orders.order_count"] } },
];

describe("a stamp written with no recorded yes is a draft for every reader", () => {
  for (const { kind, ref, edit, request } of KINDS) {
    test(`${kind}: validate, status, next, access, the compiler and change close read it as a draft, until the owner's yes`, async () => {
      const root = acme();
      // The honest draft: edited, then revoked with semlayer approve --revoke, so no answer in the ledger is to it.
      expect((await semlayer(root, edit)).code).toBe(0);
      expect((await semlayer(root, ["approve", "--target", ref, "--revoke"])).code).toBe(0);
      const draft = { access: evaluateAccess(root), compiled: compileRequest(root, request) };
      forge(root, ref);

      // validate: an error with its code, naming both ways forward.
      const [issue, ...more] = findings(root, ref);
      expect(more).toEqual([]);
      expect(issue).toMatchObject({ level: "error", code: "approval.no_recorded_yes", next: `semlayer readback --targets ${ref}` });
      expect(issue!.message).toContain(`semlayer readback --targets ${ref}`);
      expect(issue!.message).toContain(`semlayer approve --target ${ref})`);
      expect(issue!.message).toContain(`semlayer approve --revoke --target ${ref}`);
      // status counts it as a draft and names it; next reads it back.
      const st = await status(root);
      expect(st.stamped_without_yes).toEqual([ref]);
      expect(st.approved_without_yes).not.toContain(ref);
      expect(st.next_step).toMatchObject({ phase: "reapprove", command: `semlayer readback --targets ${ref}`, after_owner_yes: false });
      expect((await semlayer(root, ["status"])).out).toContain(`1 stamped approved with no recorded owner yes (they count as drafts): ${ref}`);
      // The access evaluator and the compiler read it exactly as the revoked draft.
      const forged = evaluateAccess(root);
      expect(forged.stamped_without_yes).toEqual([ref]);
      expect(seen(forged, ref)).toEqual(seen(draft.access, ref));
      // A join is not listed by the evaluator; the compiler reads it below.
      if (kind !== "access" && kind !== "join") expect((seen(forged, ref) as { status: string }).status).toBe("draft");
      expect(compileRequest(root, request)).toEqual(draft.compiled);
      // semlayer approve does not take the stamp as an approval: it asks for the owner's yes.
      const refused = await semlayer(root, ["approve", "--target", ref]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("no owner reply to its readback is recorded");
      // A release is not recorded over it.
      const close = await semlayer(root, ["change", "close", "--version", "1.0"]);
      expect(close.code).toBe(1);
      expect(close.err).toContain(ref);

      // The honest route: readback, the owner's yes, approve.
      await recordReply(root, ref, { by: "Dana Ruiz" });
      expect((await semlayer(root, ["approve", "--target", ref])).code).toBe(0);
      expect(findings(root)).toEqual([]);
      expect((await status(root)).stamped_without_yes).toEqual([]);
      expect(evaluateAccess(root).stamped_without_yes).toEqual([]);
      if (kind === "access") expect(evaluateAccess(root).access_file).toBe("approved");
      else if (kind !== "join") expect((seen(evaluateAccess(root), ref) as { status: string }).status).toBe("approved");
      expect(compileRequest(root, request).ok).toBe(true);
    });
  }

  test("an approved item stamped again by hand after its approval is caught once its yes no longer matches", async () => {
    const root = acme();
    // A later no to the item is the owner's latest word: the stamp no longer has a yes behind it.
    await recordReply(root, "warehouse.orders.discount", { by: "Dana Ruiz", verdict: "no" });
    expect(findings(root).map((i) => i.message.split(" ")[0])).toEqual(["warehouse.orders.discount"]);
    expect(evaluateAccess(root).stamped_without_yes).toEqual(["warehouse.orders.discount"]);
  });
});

describe("a schema pair stamped with no recorded yes", () => {
  test("is a draft to the compiler's pair check, and approved once the ledger backs it", () => {
    const pair = { from: "sales", to: "crm", keys: [{ from: "orders.customer_id", to: "customers.customer_id" }], status: "approved" as const, approved_by: "Dana", approved_at: "2026-01-15" };
    const entry = listApprovals({ sources: [{ source: "wh", config: { cross_schema: [pair] } }] })[0]!;
    const source = { source: "wh", cross_schema: [{ ...pair, approved_hash: entry.hash }] } as never;
    const none = { present: false, latest: new Map() };
    const ledger = { present: true, latest: new Map() };
    expect(backedPairs(source, undefined)[0]!.status).toBe("approved");
    expect(backedPairs(source, none)[0]!.status).toBe("approved");
    expect(backedPairs(source, ledger)[0]!.status).toBe("draft");
    ledger.latest.set(entry.ref, { confirmed: entry.hash } as never);
    expect(backedPairs(source, ledger)[0]!.status).toBe("approved");
  });
});

describe("a description added by a plain file write to an item approved without one", () => {
  test("is not approved for any purpose: validate errors and the evaluator and compiler read it as a draft", async () => {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer, region varchar)", "insert into orders values (1, 'east'), (2, 'west')"]);
    writeYaml(join(t.root, "models", "wh", "orders.yaml"), {
      model: "orders",
      source: "wh",
      table: "main.orders",
      status: "draft",
      grain: "One row per order.",
      primary_key: ["id"],
      dimensions: [{ name: "region", expr: "region", type: "string", status: "draft" }],
      measures: [{ name: "order_count", agg: "count", description: "Orders.", status: "draft" }],
    });
    expect((await approveWithYes(t.root, ["--target", "wh.orders", "--recursive"])).code).toBe(0);
    // The readback recorded the definition hash with the yes, so the yes is to the text without a description.
    const reply = JSON.parse(readFileSync(join(t.root, LEDGER), "utf8").trimEnd().split("\n").find((l) => l.includes('"wh.orders.region"'))!) as { content_hash: string; definition_hash?: string };
    expect(reply.definition_hash).toBe(reply.content_hash);
    const request = { source: "wh", measures: ["orders.order_count"], dimensions: ["orders.region"] };
    expect(compileRequest(t.root, request).ok).toBe(true);
    const file = join(t.root, "models", "wh", "orders.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  - name: region\n", "  - name: region\n    description: Where the order ships, in the owner's words.\n"));
    expect(findings(t.root).map((i) => [i.level, i.code, i.message.split(" ")[0]])).toEqual([["error", "approval.no_recorded_yes", "wh.orders.region"]]);
    expect(validateProject(t.root).filter((i) => i.code === "approval.description_uncovered")).toEqual([]);
    expect(evaluateAccess(t.root).stamped_without_yes).toEqual(["wh.orders.region"]);
    const refused = compileRequest(t.root, request);
    expect(refused.ok).toBe(false);
    // Read back with its description and approved on the owner's yes, it counts again.
    await recordReply(t.root, "wh.orders.region");
    expect((await semlayer(t.root, ["approve", "--target", "wh.orders.region"])).code).toBe(0);
    expect(findings(t.root)).toEqual([]);
    expect(compileRequest(t.root, request).ok).toBe(true);
  });
});

describe("a project with approvals and no ledger", () => {
  test("gets one finding; the owner's confirmation records itself, and a stamp after it is caught", async () => {
    const root = acme(false);
    const before = validateProject(root);
    expect(findings(root).map((i) => [i.level, i.code, i.file, i.next])).toEqual([
      ["warning", "approval.no_ledger", LEDGER, 'semlayer approve --confirm-existing --by "<owner>" --reply "<owner\'s words>"'],
    ]);
    expect(before.filter((i) => i.level === "error")).toEqual([]);
    // The approvals still count meanwhile.
    expect(compileRequest(root, { source: "warehouse", measures: ["orders.revenue"] }).ok).toBe(true);

    // The step takes the owner's name and words, or records nothing.
    for (const args of [[], ["--by", "Dana Ruiz"], ["--reply", "They stand."], ["--by", " ", "--reply", "They stand."]]) {
      const r = await semlayer(root, ["approve", "--confirm-existing", ...args]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('semlayer approve --confirm-existing --by "<owner>" --reply "<owner\'s words>"');
    }
    expect((await semlayer(root, ["approve", "--confirm-existing", "--target", "access", "--by", "Dana Ruiz", "--reply", "Yes."])).err).toContain("takes no --target");
    expect(readApprovalLedger(root).present).toBe(false);

    const run = await semlayer(root, ["approve", "--confirm-existing", "--by", "Dana Ruiz", "--reply", "These approvals stand as they are.", "--json"], { SEMLAYER_NOW: FIXED_NOW });
    expect(run.code).toBe(0);
    const out = run.json<{ confirmed: string[]; ledger: string; by: string }>();
    expect(out).toMatchObject({ ledger: "ans_0001", by: "Dana Ruiz" });
    const approvals = projectApprovals(root).filter((e) => e.status === "approved" && (e.kind !== "golden" || e.complete));
    expect(out.confirmed.sort()).toEqual(approvals.map((e) => e.ref).sort());
    const line = JSON.parse(readFileSync(join(root, LEDGER), "utf8")) as Record<string, unknown>;
    expect(line).toMatchObject({ kind: "confirm", by: "Dana Ruiz", at: FIXED_NOW, text: "These approvals stand as they are." });
    expect(validateProject(root).filter((i) => i.file === LEDGER)).toEqual([]);
    expect(findings(root)).toEqual([]);
    expect((await status(root)).approved_without_yes).toEqual([]);
    // The confirmation is given once: run again, it is refused and records nothing.
    const again = await semlayer(root, ["approve", "--confirm-existing", "--by", "Dana Ruiz", "--reply", "Yes."]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already confirmed");

    // An item stamped after the confirmation, with no yes, is caught.
    expect((await semlayer(root, ["approve", "--target", "warehouse.products.launched_on", "--revoke"])).code).toBe(0);
    forge(root, "warehouse.products.launched_on");
    expect(findings(root).map((i) => [i.code, i.message.split(" ")[0]])).toEqual([["approval.no_recorded_yes", "warehouse.products.launched_on"]]);
    // Running the confirmation again does not clear it.
    expect((await semlayer(root, ["approve", "--confirm-existing", "--by", "Dana Ruiz", "--reply", "Ok."])).code).not.toBe(0);
    expect(findings(root).map((i) => i.code)).toEqual(["approval.no_recorded_yes"]);
  });

  test("with no ledger, next asks for the confirmation first, the warning says a first answer ends the rule, and the state after one is clean", async () => {
    const root = acme(false);
    const next = nextAction(root);
    expect(next.kind).toBe("ask_owner");
    expect([next.action!.command, ...next.action!.args].slice(0, 2)).toEqual(["approve", "--confirm-existing"]);
    expect(findings(root)[0]!.message).toContain("the first answer recorded in a new ledger ends that rule");
    await confirmExisting(root);
    await recordReply(root, "warehouse.orders.discount");
    expect(findings(root)).toEqual([]);
  });

  test("a ledger that cannot be read is one finding, not one error per approval", () => {
    const root = acme();
    writeFileSync(join(root, LEDGER), "<<<<<<< HEAD\n" + readFileSync(join(root, LEDGER), "utf8"));
    const issues = validateProject(root);
    expect(issues.filter((i) => i.code === "approval.no_recorded_yes")).toEqual([]);
    expect(issues.filter((i) => i.code === "ledger.invalid_json")).toHaveLength(1);
  });

  test("a clone without .semlayer: one finding with one next step, not one per item", () => {
    const root = acme(false);
    const approvals = projectApprovals(root).filter((e) => e.status === "approved");
    expect(approvals.length).toBeGreaterThan(50);
    const ours = validateProject(root).filter((i) => i.code.startsWith("approval.") || i.code === "golden.no_ledger_yes");
    expect(ours).toHaveLength(1);
    expect(ours[0]!.message).toStartWith(`${approvals.length} approved items: the project has approved items but no answer ledger`);
    expect(ours[0]!.message).toContain("If this is a clone, restore the ledger from version control");
  });

  test("the confirmation records the owner's answer: semlayer apply never runs it, and a role that does not talk to the owner may not", () => {
    expect(applyEntryRefusal(["approve", "--confirm-existing", "--by", "Dana", "--reply", "Yes."])).toContain("records the owner's answer or approval: semlayer apply never does that");
    expect(semlayerRefusal(ROLES.connector_runner, ["approve", "--confirm-existing", "--by", "Dana", "--reply", "Yes."])).toContain("acts on the owner's recorded answers");
  });
});

describe("examples/acme ships the ledger that backs its approvals", () => {
  test("every approval of the example is backed, and validate reports no approval finding", () => {
    const ledger = readApprovalLedger(ACME);
    expect(ledger.present).toBe(true);
    const approved = projectApprovals(ACME).filter((e) => e.status === "approved");
    expect(approved.length).toBeGreaterThan(50);
    for (const e of approved) {
      const last = ledger.latest.get(e.ref);
      expect({ ref: e.ref, backed: !!last && "confirmed" in last && last.confirmed === e.hash }).toEqual({ ref: e.ref, backed: true });
    }
    expect(validateProject(ACME).filter((i) => i.code.startsWith("approval.") || i.code === "golden.no_ledger_yes")).toEqual([]);
  });

  test("confirm-approvals.sh writes the committed ledger byte for byte", async () => {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    const example = join(t.dir, "examples", "acme");
    mkdirSync(example, { recursive: true });
    cpSync(ACME, join(example, "semantic"), { recursive: true });
    const script = readFileSync(join(import.meta.dir, "..", "examples", "acme", "confirm-approvals.sh"), "utf8");
    const cli = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "semlayer.ts");
    writeFileSync(join(example, "confirm-approvals.sh"), script.replace("../../../skills/semantic-layer/scripts/semlayer.ts", cli));
    const p = Bun.spawn(["sh", join(example, "confirm-approvals.sh")], { stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
    expect(readFileSync(join(example, "semantic", LEDGER), "utf8")).toBe(readFileSync(join(ACME, LEDGER), "utf8"));
  });
});

import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAccess } from "../skills/semantic-layer/scripts/lib/access.ts";
import { itemApprovals, itemHash, itemHashes, listApprovals } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { itemDefinitions, itemMap } from "../skills/semantic-layer/scripts/lib/changeset.ts";
import { compileRequest } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { appendEntry } from "../skills/semantic-layer/scripts/lib/release.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { approveWithYes, expectRefusedAsChanged, recordReply, semlayer, tempDir } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// A description is part of what the owner approves (spec: Approval hashes): it is inside the approval
// hash, items approved before it was still count as approved until semlayer approve --stamp-hashes
// --confirm-unchanged brings them forward, and a release recorded before it lists no change for that.

const VALID = join(import.meta.dir, "fixtures", "valid");
const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const ORDERS = "models/warehouse/orders.yaml";
const ONLY_DESCRIPTION = "only its description changed: its definition is the one the owner said yes to, so its figures are untouched";
const REVENUE_REQUEST = { source: "warehouse", measures: ["orders.revenue"] };

interface Issue {
  level: string;
  file: string;
  path: string;
  message: string;
  code: string;
  next?: string;
}

function copy(from: string): string {
  const root = join(tempDir("descriptions"), "semantic");
  cpSync(from, root, { recursive: true });
  return root;
}

const issues = async (root: string) => (await semlayer(root, ["validate", "--json"])).json<{ issues: Issue[] }>().issues;
const errors = async (root: string) => (await issues(root)).filter((i) => i.level === "error");

// The approval entries of a semantic root's models and metrics, as semlayer approve hashes them, with the
// file each sits in.
function entries(root: string) {
  const out: { file: string; e: ReturnType<typeof itemApprovals>[number] }[] = [];
  for (const source of readdirSync(join(root, "models"))) {
    const dir = join(root, "models", source);
    const models = new Map<string, Model>(readdirSync(dir).map((f) => [f.replace(/\.yaml$/, ""), readYaml<Model>(join(dir, f))]));
    for (const [name, model] of models)
      for (const e of itemApprovals(listApprovals({ models: [{ source, model, lookup: (n: string) => models.get(n) }] }))) out.push({ file: join(dir, `${name}.yaml`), e });
  }
  const metrics = readYaml<{ metrics: unknown }>(join(root, "metrics.yaml")).metrics;
  for (const e of itemApprovals(listApprovals({ metrics }))) out.push({ file: join(root, "metrics.yaml"), e });
  return out;
}

// A copy of a layer as a project approved before descriptions counted would hold it: each approved
// item's approved_hash is its definition hash. A ledger's yes replies were recorded then.
function earlierScheme(from = VALID): string {
  const root = copy(from);
  for (const { file, e } of entries(root)) {
    if (e.item.status !== "approved" || e.hash === e.definitionHash) continue;
    writeFileSync(file, readFileSync(file, "utf8").replace(`approved_hash: ${e.hash}`, `approved_hash: ${e.definitionHash}`));
  }
  return root;
}

describe("the hash covers the description", () => {
  test("an item without a description keeps the hash it had: the example's items, their descriptions removed, hash as committed before", () => {
    // approved_hash values examples/acme/semantic recorded before descriptions were part of an approval.
    const before: Record<string, string> = {
      "warehouse.test_accounts": "sha256:7077d3a07810b700034c3417749bd18397ef539a8df55ba06bc57f550e75ca14",
      "warehouse.orders.revenue": "sha256:f1f11e0edc5941e0b100e49cb3a3f8fd9947f70045b51eaf084b1e89edd240d9",
      "warehouse.customers.email": "sha256:19938e900fededa45d2c3cbadd6ca781076770267087b36fc0a6d646fe925b26",
      "metric:average_order_value": "sha256:1231e360fd6c820a0f5acb2004518a1ffd49f681feef24cf2ac6425f2d139eee",
    };
    const dir = join(ACME, "models", "warehouse");
    const strip = (x: unknown) => {
      const { description: _, ...rest } = x as Record<string, unknown>;
      return rest;
    };
    const models = new Map<string, Model>(["orders", "customers", "test_accounts", "regions", "products", "order_items", "refunds", "sales_reps", "sales_team_closure"].map((m) => [m, readYaml<Model>(join(dir, `${m}.yaml`))]));
    const bare = [...models.values()].map((m) => ({
      ...(strip(m) as unknown as Model),
      dimensions: (m.dimensions ?? []).map(strip),
      measures: (m.measures ?? []).map(strip),
      joins: (m.joins ?? []).map(strip),
    })) as unknown as Model[];
    const metrics = (readYaml<{ metrics: unknown[] }>(join(ACME, "metrics.yaml")).metrics ?? []).map(strip);
    const hashes = new Map(
      itemApprovals(listApprovals({ models: bare.map((model) => ({ source: "warehouse", model, lookup: (n: string) => bare.find((b) => b.model === n) })), metrics })).map((e) => [e.ref, e]),
    );
    for (const [ref, hash] of Object.entries(before)) {
      expect({ ref, hash: hashes.get(ref)?.hash }).toEqual({ ref, hash });
      expect(hashes.get(ref)?.definitionHash).toBe(hash);
    }
  });

  test("whitespace and line breaks in a description change nothing; an unset and an empty one hash the same; its words change the hash", () => {
    const scope = { source: "wh", model: { model: "orders", table: "shop.orders" } };
    const m = { name: "revenue", expr: "amount", agg: "sum" };
    const h = (description?: string) => itemHash("measure", description === undefined ? m : { ...m, description }, scope);
    expect(h("Order value,\n  completed orders only.\n")).toBe(h("  Order value, completed\torders only."));
    expect(h("")).toBe(h());
    expect(h("   \n")).toBe(h());
    expect(h("Order value, completed orders only.")).not.toBe(h("Order value, shipped orders too."));
    for (const kind of ["dimension", "join", "model", "metric"] as const) {
      const item = { name: "x", model: "x", to: "y", keys: [{ from: "a", to: "b" }], expr: "a", type: "string" };
      const with_ = itemHashes(kind, { ...item, description: "Said once." }, scope);
      expect({ kind, differs: with_.hash !== with_.definitionHash, definition: with_.definitionHash }).toEqual({ kind, differs: true, definition: itemHash(kind, item, scope) });
    }
  });
});

describe("an approved item on the current scheme", () => {
  const cases: [string, string][] = [
    ["warehouse.orders.revenue", "measure"],
    ["warehouse.orders.order_date", "dimension"],
    ["warehouse.orders.customer", "join"],
    ["warehouse.orders", "model"],
    ["metric:average_order_value", "metric"],
  ];
  for (const [ref, kind] of cases) {
    test(`a ${kind}: semlayer set of its description is a change the owner must approve again`, async () => {
      const root = copy(VALID);
      // The owner's yes to the item as it stands, description included.
      await recordReply(root, ref);
      expect(await errors(root)).toEqual([]);

      const set = await semlayer(root, ["set", ref, "description", "Says something the owner never saw.", "--json"]);
      expect(set.code).toBe(0);
      expect(set.json()).toMatchObject({ changed: true, reapprove: [ref] });
      const plain = await semlayer(root, ["set", ref, "description", "Says something else the owner never saw."]);
      expect(plain.out).toContain(`${ref} is approved and changed since its approval: read it back to the owner as it now stands`);

      // validate errors with the description-only sentence; status counts it; next asks for its readback.
      const [e, ...rest] = await errors(root);
      expect(rest).toEqual([]);
      expect(e).toMatchObject({ code: "approval.hash_changed", next: `semlayer readback --targets ${ref}` });
      expect(e!.message).toStartWith(`${ref} changed since it was approved by Dana Ruiz on 2026-01-15: ${ONLY_DESCRIPTION}`);
      const status = (await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[]; next_step: { phase: string } }>();
      expect(status.changed_since_approval).toEqual([ref]);
      expect(status.next_step.phase).toBe("reapprove");
      const next = (await semlayer(root, ["next", "--json"])).json<{ action: { command: string; args: string[] } }>();
      expect(next.action.command).toBe("readback");
      expect(next.action.args.join(" ")).toContain(ref);
      // The readback says the figures are untouched.
      const rb = (await semlayer(root, ["readback", "--targets", ref, "--json"])).json<{ items: { text: string; content_hash: string; definition_hash?: string }[] }>();
      expect(rb.items[0]!.text).toContain("Since the owner's yes, only its description changed: its definition, and so its figures, are as they approved.");
      expect(rb.items[0]!.definition_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // The compiler and access treat it as the existing rule for a changed item says: a draft.
      expect(evaluateAccess(root).changed_since_approval).toEqual([ref]);

      // The owner's yes to it as it now stands clears all of it.
      expect((await approveWithYes(root, ["--target", ref, "--by", "Dana Ruiz"])).code).toBe(0);
      expect(await errors(root)).toEqual([]);
      expect((await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[] }>().changed_since_approval).toEqual([]);
      expect(evaluateAccess(root).changed_since_approval).toEqual([]);
    });
  }

  test("the compiler refuses a measure whose description changed until the owner's yes, as for any changed item", async () => {
    const root = copy(ACME);
    expect(compileRequest(root, REVENUE_REQUEST).ok).toBe(true);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only."])).code).toBe(0);
    expectRefusedAsChanged(compileRequest(root, REVENUE_REQUEST), "warehouse", "orders.revenue");
    expect((await approveWithYes(root, ["--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"])).code).toBe(0);
    expect(compileRequest(root, REVENUE_REQUEST).ok).toBe(true);
  });

  test("a description edit whose definition differs from the owner's yes gets the plain changed sentence", async () => {
    const root = copy(VALID);
    await recordReply(root, "warehouse.orders.revenue");
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Reworded."])).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "synonyms", "[sales, gmv]"])).code).toBe(0);
    const [e] = await errors(root);
    expect(e!.message).not.toContain("only its description changed");
    expect(e!.message).toContain("its definition, or a join it reads through, or its description no longer matches approved_hash");
  });
});

describe("a project approved before descriptions counted", () => {
  test("nothing errors, each described item is warned about with the stamp command, and compile and access are as before", async () => {
    const root = earlierScheme();
    const all = await issues(root);
    expect(all.filter((i) => i.level === "error")).toEqual([]);
    expect(all.map((i) => [i.code, i.file, i.next])).toEqual([
      ["approval.description_uncovered", ORDERS, "semlayer approve --stamp-hashes --confirm-unchanged"],
      ["approval.description_uncovered", "metrics.yaml", "semlayer approve --stamp-hashes --confirm-unchanged"],
    ]);
    expect(all[0]!.message).toStartWith("5 approved items have approved_hash that covers the definition but not the description (warehouse.orders, warehouse.orders.order_date, warehouse.orders.revenue, warehouse.orders.order_count, warehouse.orders.customer)");
    expect(evaluateAccess(root).changed_since_approval).toEqual([]);
    // The example layer, approved before descriptions counted, compiles as it does with its hashes brought forward.
    const example = earlierScheme(ACME);
    expect((await errors(example)).map((i) => i.code)).toEqual([]);
    expect(compileRequest(example, REVENUE_REQUEST)).toEqual(compileRequest(ACME, REVENUE_REQUEST));
    expect(evaluateAccess(example).changed_since_approval).toEqual([]);
    const status = (await semlayer(root, ["status", "--json"])).json<{ changed_since_approval: string[]; approved_without_yes: string[] }>();
    expect(status.changed_since_approval).toEqual([]);
    expect(status.approved_without_yes).toEqual([]);
  });

  test("semlayer approve --stamp-hashes brings them forward only on --confirm-unchanged, the ledger's yes still counts, and a later description edit is caught", async () => {
    const root = earlierScheme();
    const ledger = readFileSync(join(root, ".semlayer", "ledger.jsonl"), "utf8");
    const refused = await semlayer(root, ["approve", "--stamp-hashes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("semlayer approve --stamp-hashes --confirm-unchanged");

    const stamped = await semlayer(root, ["approve", "--stamp-hashes", "--confirm-unchanged"]);
    expect(stamped.code).toBe(0);
    expect(stamped.out).toContain("Recorded approved_hash on 6 approved item(s), keeping who approved them and when");
    expect(stamped.out).toContain("Their descriptions, as they stand now, are part of their approval from now on, so the owner should read them.");
    expect(await issues(root)).toEqual([]);
    for (const { e } of entries(root)) if (e.item.status === "approved") expect({ ref: e.ref, hash: e.item.approved_hash }).toEqual({ ref: e.ref, hash: e.hash });
    // The owner's yes in the ledger, recorded before descriptions counted, is the record the approval rests on.
    expect(readFileSync(join(root, ".semlayer", "ledger.jsonl"), "utf8")).toBe(ledger);
    expect((await semlayer(root, ["approve", "--stamp-hashes", "--confirm-unchanged", "--json"])).json()).toEqual({ stamped: [] });

    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only."])).code).toBe(0);
    const [e, ...rest] = await errors(root);
    expect(rest).toEqual([]);
    expect(e!.message).toStartWith(`warehouse.orders.revenue changed since it was approved by Dana Ruiz on 2026-01-15: ${ONLY_DESCRIPTION}`);
  });

  test("semlayer approve --target leaves such an item as it is on the old yes, and records its full hash only on a yes to it as it stands", async () => {
    const root = earlierScheme();
    const before = readFileSync(join(root, ORDERS), "utf8");
    const old = await semlayer(root, ["approve", "--target", "warehouse.orders.revenue"]);
    expect(old.code).toBe(0);
    expect(old.out).toContain("already approved");
    expect(readFileSync(join(root, ORDERS), "utf8")).toBe(before);
    const fresh = await approveWithYes(root, ["--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"]);
    expect(fresh.out).toContain("Approved warehouse.orders.revenue again, its description now part of its approval, by Dana Ruiz");
    const revenue = entries(root).find(({ e }) => e.ref === "warehouse.orders.revenue")!.e;
    expect(revenue.item.approved_hash).toBe(revenue.hash);
  });

  test("a description given to an approved item that had none is a change for semlayer set, though validate then reads it as approved before descriptions counted", async () => {
    const root = copy(VALID);
    const file = join(root, ORDERS);
    const count = () => entries(root).find(({ e }) => e.ref === "warehouse.orders.order_date")!.e;
    // order_date approved without a description: its hash recorded as it then stood.
    writeFileSync(file, readFileSync(file, "utf8").replace("    description: When the order was placed, UTC.\n", ""));
    writeFileSync(file, readFileSync(file, "utf8").replace(String(count().item.approved_hash), count().hash));
    expect(await issues(root)).toEqual([]);
    const set = await semlayer(root, ["set", "warehouse.orders.order_date", "description", "When the order was placed, in UTC days.", "--json"]);
    expect(set.json()).toMatchObject({ reapprove: ["warehouse.orders.order_date"] });
    expect((await issues(root)).map((i) => i.code)).toEqual(["approval.description_uncovered"]);
  });

  test("a description reworded on an unstamped earlier-scheme item is a change for semlayer set; stamping afterwards does not hide it", async () => {
    const root = earlierScheme();
    const set = await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only, a meaning the owner never saw.", "--json"]);
    expect(set.json()).toMatchObject({ reapprove: ["warehouse.orders.revenue"] });
    expect((await semlayer(root, ["approve", "--stamp-hashes", "--confirm-unchanged"])).code).toBe(0);
  });

  test("a release recorded before: a description edit approved again after the release date is still listed, description only", async () => {
    const root = earlierScheme();
    appendEntry(root, {
      version: "1.0",
      date: "2026-01-20",
      note: "First release.",
      items: Object.fromEntries([...itemMap(root)].filter(([, v]) => !v.plain).map(([ref, v]) => [ref, v.definition ?? v.hash])),
      goldens: {},
      added: [],
      changed: [],
      removed: [],
      goldens_moved: [],
    });
    expect((await semlayer(root, ["approve", "--stamp-hashes", "--confirm-unchanged"])).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only."])).code).toBe(0);
    const status = async () => (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string; description_only?: boolean }[] }>().changed.map((c) => [c.ref, !!c.description_only]);
    // Approved again on a later day than the release.
    const later = "2026-02-01T12:00:00.000Z";
    await recordReply(root, "warehouse.orders.revenue", { by: "Dana Ruiz", now: later });
    expect((await semlayer(root, ["approve", "--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"], { SEMLAYER_NOW: later })).code).toBe(0);
    expect(await status()).toEqual([["warehouse.orders.revenue", true]]);
  });

  test("a release recorded before: stamping forward changes nothing; one description edit lists exactly that item, description only, with its goldens", async () => {
    const root = earlierScheme();
    // The release as the earlier scheme recorded it: each item's definition hash.
    appendEntry(root, {
      version: "1.0",
      date: "2026-02-03",
      note: "First release.",
      items: Object.fromEntries([...itemMap(root)].filter(([, v]) => !v.plain).map(([ref, v]) => [ref, v.definition ?? v.hash])),
      goldens: {},
      added: [],
      changed: [],
      removed: [],
      goldens_moved: [],
    });
    const status = async () => (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string; state: string; description_only?: boolean; affected_goldens: string[] }[]; added: string[]; removed: string[] }>();
    expect(await status()).toMatchObject({ changed: [], removed: [] });
    expect((await semlayer(root, ["approve", "--stamp-hashes", "--confirm-unchanged"])).code).toBe(0);
    expect(await status()).toMatchObject({ changed: [], removed: [] });

    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only."])).code).toBe(0);
    const s = await status();
    expect(s.changed).toEqual([{ ref: "warehouse.orders.revenue", state: "draft", affected_goldens: ["revenue_by_month_2025"], description_only: true }]);
    expect((await semlayer(root, ["change", "status"])).out).toContain("warehouse.orders.revenue: description only, its definition and figures as released; draft, waits for the owner's yes");
  });

  test("a release recorded now: a description edit after it is marked description only, a definition edit is not", async () => {
    const root = copy(VALID);
    const released = new Map([...itemMap(root)].filter(([, v]) => !v.plain));
    appendEntry(root, {
      version: "1.0",
      date: "2026-02-03",
      note: "First release.",
      items: Object.fromEntries([...released].map(([ref, v]) => [ref, v.hash])),
      definitions: itemDefinitions(released),
      goldens: {},
      added: [],
      changed: [],
      removed: [],
      goldens_moved: [],
    });
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Completed orders only."])).code).toBe(0);
    expect((await semlayer(root, ["set", "warehouse.orders.order_count", "synonyms", "[orders placed]"])).code).toBe(0);
    const changed = (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string; description_only?: boolean }[] }>().changed;
    expect(changed.map((c) => [c.ref, !!c.description_only])).toEqual([
      ["warehouse.orders.order_count", false],
      ["warehouse.orders.revenue", true],
    ]);
  });
});

describe("the walkthrough's round", () => {
  test("a measure's filter and two metrics' descriptions changed in a round: all three are read back, and the close waits for each yes", async () => {
    const root = releaseFixture();
    // The example layer's one deferred draft approved, so the release holds every item.
    await approveWithYes(root, ["--target", "warehouse.products.launched_on", "--by", "Dana Ruiz"]);
    expect((await semlayer(root, ["change", "close", "--version", "1.0"])).code).toBe(0);
    expect((await semlayer(root, ["change", "start", "--note", "Revenue is completed orders only", "--by", "Dana Ruiz"])).code).toBe(0);
    const changed = ["warehouse.orders.revenue", "metric:average_order_value", "metric:net_revenue"];
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "filter", "status = 'completed'"])).code).toBe(0);
    for (const m of changed.slice(1)) expect((await semlayer(root, ["set", m, "description", "Over completed orders only."])).code).toBe(0);

    const s = (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string; description_only?: boolean }[] }>();
    expect(s.changed.map((c) => [c.ref, !!c.description_only])).toEqual([
      ["metric:average_order_value", true],
      ["metric:net_revenue", true],
      ["warehouse.orders.revenue", false],
    ]);
    const next = (await semlayer(root, ["next", "--json"])).json<{ action: { command: string; args: string[] } }>();
    expect(next.action.command).toBe("readback");
    for (const ref of changed) expect(next.action.args.join(" ")).toContain(ref);

    for (const ref of changed) {
      const close = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
      expect(close.code).toBe(1);
      expect(close.json<{ error: string }>().error).toContain(ref);
      expect((await approveWithYes(root, ["--target", ref, "--by", "Dana Ruiz"])).code).toBe(0);
    }
    const close = await semlayer(root, ["change", "close", "--version", "1.1", "--json"]);
    expect(close.json<{ error?: string }>().error ?? "").not.toMatch(/warehouse\.orders\.revenue|metric:/);
  });
});

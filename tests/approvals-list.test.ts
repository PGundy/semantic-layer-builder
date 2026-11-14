import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedCount, approvedEntries } from "../evals/graders/approvals.ts";
import { evaluateAccess } from "../skills/semantic-layer/scripts/lib/access.ts";
import { DEFAULT_TOLERANCE, goldenHash, itemApprovals, listApprovals } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { projectApprovals } from "../skills/semantic-layer/scripts/lib/approvals.ts";
import { renderReadbacks } from "../skills/semantic-layer/scripts/lib/readback.ts";
import { statusDetail } from "../skills/semantic-layer/scripts/lib/status.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { tempRoot } from "./helpers.ts";

// One list of approvals: listApprovals (approval-hash.ts) lists every approval entry of a layer, and
// projectApprovals (approvals.ts) lists a root's as its files stand. Checked on examples/acme, which
// holds every kind, against the files read on their own.
const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const KINDS = ["model", "dimension", "measure", "join", "metric", "access", "golden"] as const;

type Obj = Record<string, unknown>;
const yaml = (path: string) => parseYaml(readFileSync(path, "utf8")) as Obj;
const named = (v: unknown) => (Array.isArray(v) ? (v as Obj[]).filter((x) => typeof x?.name === "string") : []);

// The refs each kind should list, read from the files without the approvals code.
function expectedRefs(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>(KINDS.map((k) => [k, []]));
  for (const source of readdirSync(join(root, "models")).sort()) {
    for (const f of readdirSync(join(root, "models", source)).filter((x) => x.endsWith(".yaml"))) {
      const m = yaml(join(root, "models", source, f));
      const base = `${source}.${String(m.model)}`;
      out.get("model")!.push(base);
      for (const [section, kind] of [["dimensions", "dimension"], ["measures", "measure"], ["joins", "join"]] as const)
        for (const x of named(m[section])) out.get(kind)!.push(`${base}.${String(x.name)}`);
    }
  }
  for (const x of named(yaml(join(root, "metrics.yaml")).metrics)) out.get("metric")!.push(`metric:${String(x.name)}`);
  out.get("access")!.push("access");
  for (const f of readdirSync(join(root, "goldens")).filter((x) => x.endsWith(".yaml"))) out.get("golden")!.push(`golden:${String(yaml(join(root, "goldens", f)).name)}`);
  return out;
}

describe("listApprovals on examples/acme", () => {
  const list = projectApprovals(ACME);

  test("every entry of every kind appears exactly once", () => {
    const expected = expectedRefs(ACME);
    for (const kind of KINDS) {
      const refs = list.filter((e) => e.kind === kind).map((e) => e.ref);
      expect(refs.length).toBeGreaterThan(0);
      expect(new Set(refs).size).toBe(refs.length);
      expect([...refs].sort()).toEqual([...expected.get(kind)!].sort());
    }
    expect(list.length).toBe([...expected.values()].flat().length);
    expect(new Set(list.map((e) => e.ref)).size).toBe(list.length);
  });

  test("each entry carries its file, status, recorded hash and current hash", () => {
    for (const e of list) {
      expect(e.file?.startsWith(ACME)).toBe(true);
      const file = yaml(e.file!);
      expect(e.status).toBe((e.kind === "golden" || e.kind === "model" || e.kind === "access" ? file.status : e.item.status) as string);
      expect(e.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      if (e.kind === "golden") {
        const expected = (file.expected ?? {}) as { rows?: unknown[]; tolerance?: number };
        expect(e.hash).toBe(goldenHash(file, expected.rows ?? [], expected.tolerance ?? DEFAULT_TOLERANCE));
        expect(e.complete).toBe(Array.isArray(expected.rows));
        expect(e.recorded_hash).toBeUndefined();
      } else if (e.status === "approved") {
        // The example is approved as it stands: every recorded hash is the current one.
        expect(e.recorded_hash).toBe(e.hash);
      }
    }
    const orders = list.find((e) => e.ref === "warehouse.orders.revenue")!;
    expect(orders.file).toBe(join(ACME, "models", "warehouse", "orders.yaml"));
    expect(list.find((e) => e.kind === "metric")!.file).toBe(join(ACME, "metrics.yaml"));
    expect(list.find((e) => e.kind === "access")!.file).toBe(join(ACME, "access.yaml"));
  });

  test("a part left out is not listed, and itemApprovals drops the goldens", () => {
    expect(listApprovals({})).toEqual([]);
    expect(listApprovals({ access: null })).toEqual([]);
    expect(itemApprovals(list).some((e) => (e.kind as string) === "golden")).toBe(false);
    expect(itemApprovals(list).length).toBe(list.filter((e) => e.kind !== "golden").length);
  });

  test("the approvals grader counts what the list holds", () => {
    const approved = list.filter((e) => e.status === "approved");
    expect(approvedCount(ACME)).toBe(approved.length);
    expect(approvedEntries(ACME).map((x) => x.entry.ref)).toEqual(approved.filter((e) => e.kind !== "golden").map((e) => e.ref));
  });

  test("a readback item carries the hash the list gives its item", () => {
    const refs = list.filter((e) => e.kind !== "golden").map((e) => e.ref);
    const items = renderReadbacks(ACME, refs);
    expect(items.map((i) => i.content_hash)).toEqual(list.filter((e) => e.kind !== "golden").map((e) => e.hash));
  });
});

describe("callers read the same list", () => {
  let root: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ root, cleanup } = tempRoot());
    cpSync(ACME, root, { recursive: true });
  });
  afterEach(() => cleanup());

  test("an edited measure is changed in the list and in sl access", () => {
    const file = join(root, "models", "warehouse", "orders.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("expr: amount_cents / 100.0", "expr: amount_cents / 10.0"));
    const changed = projectApprovals(root)
      .filter((e) => e.kind !== "golden" && e.status === "approved" && e.recorded_hash !== e.hash)
      .map((e) => e.ref);
    expect(changed).toEqual(["warehouse.orders.revenue"]);
    expect(evaluateAccess(root).changed_since_approval).toEqual(changed);
  });

  test("after several changes the list, sl access, sl status and sl validate agree on what changed", () => {
    const edit = (rel: string, a: string, b: string) => {
      const f = join(root, rel);
      const t = readFileSync(f, "utf8");
      expect(t.includes(a)).toBe(true);
      writeFileSync(f, t.replace(a, b));
    };
    edit("models/warehouse/orders.yaml", "expr: amount_cents / 100.0", "expr: amount_cents / 10.0");
    edit("metrics.yaml", "name: average_order_value", "name: avg_order_value");
    const changed = projectApprovals(root, false)
      .filter((e) => e.status === "approved" && e.recorded_hash !== undefined && e.recorded_hash !== e.hash)
      .map((e) => e.ref)
      .sort();
    expect(changed.length).toBeGreaterThan(1);
    expect([...evaluateAccess(root).changed_since_approval].sort()).toEqual(changed);
    expect([...statusDetail(root).status.changed_since_approval].sort()).toEqual(changed);
    expect(validateProject(root).filter((i) => i.message.includes("changed since it was approved")).length).toBe(changed.length);
  });

  test("an approved golden with no expected rows is listed once, as incomplete, and the grader counts it", () => {
    const f = join(root, "goldens", "revenue_2025.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n  rows:[\s\S]*?(?=\n  [a-z_]+:|\n[a-z_]+:|$)/, "\n"));
    const list = projectApprovals(root);
    const goldens = list.filter((e) => e.ref === "golden:revenue_2025");
    expect(goldens.length).toBe(1);
    expect(goldens[0]!.kind === "golden" && goldens[0]!.complete).toBe(false);
    expect(approvedCount(root)).toBe(list.filter((e) => e.status === "approved").length);
  });

  test("a missing metrics.yaml and access.yaml list nothing for them", () => {
    unlinkSync(join(root, "metrics.yaml"));
    unlinkSync(join(root, "access.yaml"));
    expect(projectApprovals(root).some((e) => e.kind === "metric" || e.kind === "access")).toBe(false);
  });

  test("the list is deterministic, keeps each item as given and trims a recorded hash", () => {
    expect(JSON.stringify(projectApprovals(root))).toBe(JSON.stringify(projectApprovals(root)));
    const item = { name: "x", status: "approved", approved_hash: " sha256:abc " };
    const [e] = listApprovals({ metrics: [item] });
    expect(e!.item).toBe(item);
    expect(e!.recorded_hash).toBe("sha256:abc");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editYamlText, parseYamlText, updateYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { tempRoot } from "./helpers.ts";

// The yaml package resolves only inside the skill, so its types are reached through updateYaml's signature
// and its collections through the few members the edits below use.
type Document = Parameters<Parameters<typeof updateYaml>[1]>[0];
interface YAMLMap {
  items: unknown[];
  get(key: string, keepScalar: true): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
}
interface YAMLSeq {
  items: unknown[];
}
const parse = (text: string) => parseYamlText(text);
const isPair = (p: unknown) => typeof p === "object" && p !== null && "key" in p && "value" in p;
const hasItems = (node: unknown): node is { items: unknown[] } =>
  typeof node === "object" && node !== null && Array.isArray((node as { items?: unknown }).items);
const isMap = (node: unknown): node is YAMLMap => hasItems(node) && node.items.length > 0 && node.items.every(isPair);
const isSeq = (node: unknown): node is YAMLSeq => hasItems(node) && !node.items.some(isPair);
const isScalar = (node: unknown): node is { value: unknown } =>
  typeof node === "object" && node !== null && "value" in node && !("items" in node) && !("key" in node);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

// The lines removed from `before` and added in `after`, by longest common subsequence, so a
// test can state exactly which lines an edit touched and that every other line is unchanged.
function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) added.push(b[j++]!);
    else removed.push(a[i++]!);
  }
  return { removed, added };
}

const MODEL = `# Orders model, reviewed with finance.
name: orders
table: public.orders
status: draft   # waiting on the owner

description: >-
  One row per order placed on the storefront,
  including test accounts.
grain: |
  One row per order.
  Cancelled orders stay.

primary_key: [id]
tags: ["finance", 'core', plain]

dimensions:
  # Time dimensions first.
  - name: created_at
    expr: created_at
    type: time # in UTC

  - name: status
    expr: "status"
    description: |-
      Order status as the app writes it.
measures:
  - name: revenue
    expr: amount_cents / 100.0
    agg: sum
    status: draft
    # Approved after the March readback.
  - name: order_count
    agg: count
joins:
  - name: customer
    to: customers
    relationship: many_to_one
# trailing comment
`;

// A folded block that a whole-document re-render would join into one line, so a test whose
// source starts with it shows the result was spliced.
const KEEP = "note: >-\n  folded\n  text\n";

function edit(text: string, fn: (doc: Document) => void): string {
  return editYamlText(text, fn);
}

describe("editYamlText keeps untouched text byte-identical", () => {
  test("an edit that changes nothing returns the text unchanged", () => {
    expect(edit(MODEL, () => {})).toBe(MODEL);
    expect(edit(MODEL, (doc) => doc.getIn(["measures", 0, "name"]))).toBe(MODEL);
  });

  test("setting an existing scalar replaces only its value and keeps its trailing comment", () => {
    const out = edit(MODEL, (doc) => doc.set("status", "approved"));
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["status: draft   # waiting on the owner"],
      added: ["status: approved   # waiting on the owner"],
    });
    expect((parse(out) as { status: string }).status).toBe("approved");
  });

  test("a changed quoted scalar keeps its quotes", () => {
    const out = edit(MODEL, (doc) => doc.setIn(["dimensions", 1, "expr"], "lower(status)"));
    expect(lineDiff(MODEL, out)).toEqual({ removed: ['    expr: "status"'], added: ['    expr: "lower(status)"'] });
  });

  test("a changed folded block scalar keeps its style and indentation", () => {
    const out = edit(MODEL, (doc) => doc.set("description", "One row per order."));
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["  One row per order placed on the storefront,", "  including test accounts."],
      added: ["  One row per order."],
    });
    expect((parse(out) as { description: string }).description).toBe("One row per order.");
  });

  test("a literal block scalar inside a list item is rewritten at the item's indentation", () => {
    const out = edit(MODEL, (doc) => doc.setIn(["dimensions", 1, "description"], "Status.\nSecond line."));
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["      Order status as the app writes it."],
      added: ["      Status.", "      Second line."],
    });
    const value = parse(out) as { dimensions: { description?: string }[] };
    expect(value.dimensions[1]!.description).toBe("Status.\nSecond line.");
  });

  test("adding keys to a list item's map inserts them after its last pair", () => {
    const out = edit(MODEL, (doc) => {
      const m = doc.getIn(["measures", 0], true) as YAMLMap;
      const status = m.get("status", true);
      if (isScalar(status)) status.value = "approved";
      m.set("approved_by", "Dana");
      m.set("approved_at", "2026-01-15T12:00:00.000Z");
    });
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["    status: draft"],
      added: ["    status: approved", "    approved_by: Dana", '    approved_at: 2026-01-15T12:00:00.000Z'],
    });
    expect(out).toContain('    approved_at: 2026-01-15T12:00:00.000Z\n    # Approved after the March readback.\n');
  });

  test("a key spliced into the middle of a map lands after its anchor", () => {
    const out = edit(MODEL, (doc) => {
      const m = doc.getIn(["measures", 1], true) as YAMLMap;
      m.items.splice(1, 0, doc.createPair("status", "approved"));
    });
    expect(out).toContain("  - name: order_count\n    status: approved\n    agg: count\n");
    expect(lineDiff(MODEL, out)).toEqual({ removed: [], added: ["    status: approved"] });
  });

  test("a key added at the top of a list item takes the dash line", () => {
    const out = edit(MODEL, (doc) => {
      const m = doc.getIn(["joins", 0], true) as YAMLMap;
      m.items.unshift(doc.createPair("status", "draft"));
    });
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["  - name: customer"],
      added: ["  - status: draft", "    name: customer"],
    });
  });

  test("a key added at the top of the root map goes below the comment above the first key", () => {
    const out = edit(MODEL, (doc) => {
      (doc.contents as YAMLMap).items.unshift(doc.createPair("version", 2));
    });
    expect(out.startsWith("# Orders model, reviewed with finance.\nversion: 2\nname: orders\n")).toBe(true);
    expect(lineDiff(MODEL, out)).toEqual({ removed: [], added: ["version: 2"] });
  });

  test("a nested map added to a list item renders at the item's indentation", () => {
    const evidence = { checked_at: "2026-01-15", left_rows: 120, unmatched: 0, fanout: 1 };
    const out = edit(MODEL, (doc) => doc.setIn(["joins", 0, "evidence"], doc.createNode(evidence)));
    expect(lineDiff(MODEL, out)).toEqual({
      removed: [],
      added: ["    evidence:", "      checked_at: 2026-01-15", "      left_rows: 120", "      unmatched: 0", "      fanout: 1"],
    });
    const value = parse(out) as { joins: { evidence: unknown }[] };
    expect(value.joins[0]!.evidence).toEqual(evidence);
  });

  test("replacing an existing nested map rewrites only that pair's lines", () => {
    const first = edit(MODEL, (doc) => doc.setIn(["joins", 0, "evidence"], doc.createNode({ fanout: 1 })));
    const out = edit(first, (doc) => doc.setIn(["joins", 0, "evidence"], doc.createNode({ fanout: 2, unmatched: 3 })));
    expect(lineDiff(first, out)).toEqual({
      removed: ["      fanout: 1"],
      added: ["      fanout: 2", "      unmatched: 3"],
    });
  });

  test("a list of maps added at the root renders as a block list", () => {
    const rows = [
      { month: "2026-01", revenue: 100 },
      { month: "2026-02", revenue: 250.5 },
    ];
    const out = edit(MODEL, (doc) => {
      doc.set("expected", doc.createNode({ tolerance: 0, rows }));
      doc.set("confirmed_by", "Dana");
    });
    expect(lineDiff(MODEL, out)).toEqual({
      removed: [],
      added: [
        "expected:",
        "  tolerance: 0",
        "  rows:",
        "    - month: 2026-01",
        "      revenue: 100",
        "    - month: 2026-02",
        "      revenue: 250.5",
        "confirmed_by: Dana",
      ],
    });
    expect((parse(out) as { expected: unknown }).expected).toEqual({ tolerance: 0, rows });
    expect(out.endsWith("confirmed_by: Dana\n# trailing comment\n")).toBe(true);
  });

  test("re-recording a list of maps replaces only the old rows", () => {
    const golden = KEEP + "name: g\n# kept\nexpected:\n  tolerance: 0\n  rows:\n    - n: 1\nstatus: draft # note\n";
    const out = edit(golden, (doc) => {
      doc.set("expected", doc.createNode({ tolerance: 0.01, rows: [{ n: 2 }, { n: 3 }] }));
      doc.set("status", "approved");
    });
    expect(out).toBe(
      KEEP + "name: g\n# kept\nexpected:\n  tolerance: 0.01\n  rows:\n    - n: 2\n    - n: 3\nstatus: approved # note\n",
    );
  });

  test("deleting keys removes only their lines", () => {
    const approved =
      KEEP +
      "models:\n  - name: orders\n    status: approved # signed off\n    approved_by: Dana\n" +
      '    approved_at: "2026-01-15"\n\n  - name: customers\n    status: draft\n';
    const out = edit(approved, (doc) => {
      const m = doc.getIn(["models", 0], true) as YAMLMap;
      const status = m.get("status", true);
      if (isScalar(status)) status.value = "draft";
      m.delete("approved_by");
      m.delete("approved_at");
    });
    expect(out).toBe(KEEP + "models:\n  - name: orders\n    status: draft # signed off\n\n  - name: customers\n    status: draft\n");
  });

  test("deleting a root key whose value is a block list removes the whole pair", () => {
    const out = edit(MODEL, (doc) => doc.delete("joins"));
    expect(lineDiff(MODEL, out)).toEqual({
      removed: ["joins:", "  - name: customer", "    to: customers", "    relationship: many_to_one"],
      added: [],
    });
  });

  test("splicing a flow sequence keeps its quoting and separators", () => {
    const out = edit(MODEL, (doc) => {
      const tags = doc.get("tags", true);
      if (!isSeq(tags)) throw new Error("tags is not a list");
      tags.items.splice(1, 1);
      tags.items.push(doc.createNode("needs, quotes"));
    });
    expect(lineDiff(MODEL, out)).toEqual({
      removed: [`tags: ["finance", 'core', plain]`],
      added: [`tags: ["finance", plain, "needs, quotes"]`],
    });
  });

  test("a scope list in flow style is edited in place", () => {
    const source =
      KEEP + "name: warehouse\nscope:\n  include: [public.orders, public.customers] # core\n  exclude: [\"public.tmp_*\"]\n";
    const out = edit(source, (doc) => {
      const scope = doc.get("scope", true) as YAMLMap;
      const include = scope.get("include", true);
      if (!isSeq(include)) throw new Error("include is not a list");
      include.items.push(doc.createNode("public.refunds"));
      scope.delete("exclude");
    });
    expect(out).toBe(KEEP + "name: warehouse\nscope:\n  include: [public.orders, public.customers, public.refunds] # core\n");
  });

  test("a block sequence keeps its comments when items are removed and added", () => {
    const source = KEEP + "scope:\n  include:\n    # the core tables\n    - public.orders\n    - public.tmp # drop me\n    - public.customers\n";
    const out = edit(source, (doc) => {
      const include = doc.getIn(["scope", "include"], true);
      if (!isSeq(include)) throw new Error("include is not a list");
      include.items.splice(1, 1);
      include.items.push(doc.createNode("public.refunds"));
    });
    expect(out).toBe(
      KEEP + "scope:\n  include:\n    # the core tables\n    - public.orders\n    - public.customers\n    - public.refunds\n",
    );
  });

  test("setIn creates missing parent maps with only the new lines added", () => {
    const source = KEEP + "name: warehouse\nconnection:\n  url_env: PG_URL # never the URL itself\n";
    const out = edit(source, (doc) => doc.setIn(["draft", "strip_prefixes"], ["fct_", "dim_"]));
    expect(out).toBe(`${source}draft:\n  strip_prefixes:\n    - fct_\n    - dim_\n`);
  });

  test("a file without a final newline gets the new key on its own line", () => {
    expect(edit(`${KEEP}a: 1`, (doc) => doc.set("b", 2))).toBe(`${KEEP}a: 1\nb: 2\n`);
  });

  test("an empty value gains a value after its colon", () => {
    expect(edit(`${KEEP}a:\nb: 1\n`, (doc) => doc.set("a", "x"))).toBe(`${KEEP}a: x\nb: 1\n`);
  });

  test("an emptied block list becomes an empty flow list on the same key", () => {
    const out = edit(KEEP + "x: 1\nlist:\n  - a # one\n  - b\ny: 2\n", (doc) => {
      const list = doc.get("list", true);
      if (isSeq(list)) list.items.splice(0);
    });
    expect(out).toBe(`${KEEP}x: 1\nlist: []\ny: 2\n`);
  });

  test("a value that becomes a map rewrites only its own pair", () => {
    const out = edit(`# c\n${KEEP}a: 1 # one\nb: 2\n`, (doc) => doc.set("a", doc.createNode({ x: 1 })));
    expect(out).toBe(`# c\n${KEEP}a:\n  x: 1\nb: 2\n`);
  });

  test("a reordered map is re-rendered as one pair and the rest stays", () => {
    const source = "keep: >-\n  folded\n  text\nm:\n  a: 1\n  b: 2\n";
    const out = edit(source, (doc) => {
      const m = doc.get("m", true) as YAMLMap;
      m.items.reverse();
    });
    expect(out).toBe("keep: >-\n  folded\n  text\nm:\n  b: 2\n  a: 1\n");
  });

  test("a reordered nested map keeps its trailing comment once", () => {
    const source = `${KEEP}scope:\n  include: [a]\n  exclude: [b]\n  # about scope\nother: 1\n`;
    const out = edit(source, (doc) => (doc.get("scope", true) as YAMLMap).items.reverse());
    expect(out).toBe(`${KEEP}scope:\n  exclude: [b]\n  include: [a]\n  # about scope\nother: 1\n`);
  });

  test("an emptied nested map or list keeps its trailing comment once", () => {
    const map = edit(`${KEEP}scope:\n  include: [a]\n  # about scope\nother: 1\n`, (doc) =>
      doc.deleteIn(["scope", "include"]),
    );
    expect(map).toBe(`${KEEP}scope: {}\n  # about scope\nother: 1\n`);
    const list = edit(`${KEEP}scope:\n  include:\n    - a\n    # about include\nother: 1\n`, (doc) => {
      const include = doc.getIn(["scope", "include"], true);
      if (!isSeq(include)) throw new Error("include is not a list");
      include.items.splice(0);
    });
    expect(list).toBe(`${KEEP}scope:\n  include: []\n    # about include\nother: 1\n`);
  });

  test("a re-rendered nested map keeps the comment above its first key", () => {
    const source = `${KEEP}scope:\n  # core first\n  include: [a]\n  exclude: [b]\nother: 1\n`;
    const out = edit(source, (doc) => (doc.get("scope", true) as YAMLMap).items.reverse());
    expect(out.match(/# core first/g)).toHaveLength(1);
    expect(parse(out)).toEqual({ note: "folded text", scope: { exclude: ["b"], include: ["a"] }, other: 1 });
    expect(out.startsWith(KEEP)).toBe(true);
  });

  test("deleting a pair removes its value's indented trailing comment and keeps the blank line after it", () => {
    const source = `${KEEP}scope:\n  include:\n    - a\n  # about scope\n\nother: 1\n`;
    expect(edit(source, (doc) => doc.delete("scope"))).toBe(`${KEEP}\nother: 1\n`);
  });

  test("deleting a list item removes its indented trailing comment", () => {
    const source = `${KEEP}measures:\n  - name: r\n    agg: sum\n    # note r\n  - name: c\n`;
    const out = edit(source, (doc) => {
      const measures = doc.get("measures", true);
      if (!isSeq(measures)) throw new Error("measures is not a list");
      measures.items.splice(0, 1);
    });
    expect(out).toBe(`${KEEP}measures:\n  - name: c\n`);
  });

  test("a comment at the parent's column after a deleted pair stays with the next key", () => {
    const source = `${KEEP}dims:\n  - name: a\n    x: 1\n    # about a\n\n# measures\nm: 1\n`;
    expect(edit(source, (doc) => doc.delete("dims"))).toBe(`${KEEP}\n# measures\nm: 1\n`);
  });

  test("a key added after a list goes above the next key's comment at the root column", () => {
    const source = `${KEEP}dims:\n  - name: a\n    x: 1\n    # about a\n\n# measures\nm: 1\n`;
    const out = edit(source, (doc) => {
      const root = doc.contents as unknown as YAMLMap;
      root.items.splice(2, 0, doc.createPair("status", "draft"));
    });
    expect(out).toBe(`${KEEP}dims:\n  - name: a\n    x: 1\n    # about a\nstatus: draft\n\n# measures\nm: 1\n`);
  });

  test("a keep-chomped block at the end of a deleted list keeps the next key's comment", () => {
    const source = `${KEEP}dims:\n  - |+\n    t\n\n# measures\nm: 1\n`;
    expect(edit(source, (doc) => doc.delete("dims"))).toBe(`${KEEP}# measures\nm: 1\n`);
    const kept = edit(source, (doc) => doc.set("m", 2));
    expect(kept).toBe(`${KEEP}dims:\n  - |+\n    t\n\n# measures\nm: 2\n`);
  });

  test("a map pushed onto a list goes after the previous item's trailing comment", () => {
    const source = `${KEEP}dims:\n  - name: a\n    x: 1\n    # about a\n\n# measures\nm: 1\n`;
    const out = edit(source, (doc) => {
      const dims = doc.get("dims", true);
      if (!isSeq(dims)) throw new Error("dims is not a list");
      dims.items.push(doc.createNode({ name: "b" }));
    });
    expect(out).toBe(`${KEEP}dims:\n  - name: a\n    x: 1\n    # about a\n  - name: b\n\n# measures\nm: 1\n`);
  });

  test("a key added after a pair goes after that pair's indented trailing comment", () => {
    const source = `${KEEP}include:\n  - a\n  # about include\n\nother: 1\n`;
    const out = edit(source, (doc) => {
      const root = doc.contents as unknown as YAMLMap;
      root.items.splice(2, 0, doc.createPair("exclude", ["b"]));
    });
    expect(lineDiff(source, out)).toEqual({ removed: [], added: ["exclude:", "  - b"] });
    expect(out).toContain("  # about include\nexclude:\n  - b\n\nother: 1\n");
  });

  test("setting an anchored or tagged scalar replaces only its value", () => {
    const anchored = edit(`${KEEP}a: &x foo\nb: *x\n`, (doc) => doc.set("a", "bar"));
    expect(anchored).toBe(`${KEEP}a: &x bar\nb: *x\n`);
    const tagged = edit(`${KEEP}a: !!str foo # c\n`, (doc) => doc.set("a", "bar"));
    expect(tagged).toBe(`${KEEP}a: !!str bar # c\n`);
  });

  test("a CRLF file gets CRLF on the lines the edit writes", () => {
    const source = "a: 1\r\nnote: >-\r\n  folded\r\n  text\r\nm:\r\n  - name: x\r\n    k: 1\r\n";
    const out = edit(source, (doc) => {
      doc.set("c", 3);
      doc.setIn(["m", 0, "approved_by"], "T");
      doc.setIn(["m", 0, "grain"], "line one\nline two\n");
    });
    expect(out).toBe(
      "a: 1\r\nnote: >-\r\n  folded\r\n  text\r\nm:\r\n  - name: x\r\n    k: 1\r\n    approved_by: T\r\n" +
        "    grain: |\r\n      line one\r\n      line two\r\nc: 3\r\n",
    );
  });

  test("a replaced root falls back to rendering the whole document", () => {
    const out = edit("a: 1 # c\n", (doc) => {
      doc.contents = doc.createNode({ b: 2 }) as typeof doc.contents;
    });
    expect(parse(out)).toEqual({ b: 2 });
  });

  test("every result parses to the edited document's value", () => {
    const out = edit(MODEL, (doc) => {
      doc.set("status", "approved");
      doc.deleteIn(["dimensions", 0, "type"]);
      doc.setIn(["measures", 1, "status"], "approved");
      doc.setIn(["joins", 0, "evidence"], doc.createNode({ fanout: 1 }));
    });
    const expected = parse(MODEL) as Record<string, unknown> & {
      dimensions: Record<string, unknown>[];
      measures: Record<string, unknown>[];
      joins: Record<string, unknown>[];
    };
    expected.status = "approved";
    delete expected.dimensions[0]!.type;
    expected.measures[1]!.status = "approved";
    expected.joins[0]!.evidence = { fanout: 1 };
    expect(parse(out)).toEqual(expected);
    expect(out).toContain("# Time dimensions first.\n  - name: created_at\n    expr: created_at\n\n  - name: status\n");
  });
});

describe("updateYaml", () => {
  test("edits a file on disk and keeps the rest of it byte-identical", () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    mkdirSync(t.root, { recursive: true });
    const path = join(t.root, "orders.yaml");
    writeFileSync(path, MODEL);
    updateYaml(path, (doc) => doc.set("status", "approved"));
    const out = readFileSync(path, "utf8");
    expect(out).toBe(MODEL.replace("status: draft   #", "status: approved   #"));
  });

  test("an approve-style edit on every example file touches only the status lines", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".yaml")) files.push(p);
      }
    };
    walk(join(import.meta.dir, "..", "examples"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const out = edit(text, (doc) => {
        if (!isMap(doc.contents)) return;
        doc.set("approved_by", "Tester");
        const dims = doc.get("dimensions", true);
        if (isSeq(dims) && isMap(dims.items[0])) (dims.items[0] as YAMLMap).set("approved_by", "Tester");
      });
      const diff = lineDiff(text, out);
      expect(diff.removed.filter((l) => !/approved_by/.test(l))).toEqual([]);
      expect(diff.added.every((l) => /approved_by: Tester$/.test(l))).toBe(true);
    }
  });
});

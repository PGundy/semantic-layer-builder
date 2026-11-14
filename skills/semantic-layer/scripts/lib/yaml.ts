import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parse,
  parseDocument,
  stringify,
  YAMLMap,
  YAMLSeq,
  type Pair,
  type Scalar,
} from "yaml";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";

const STRINGIFY = { lineWidth: 0, indent: 2, flowCollectionPadding: false } as const;

export function readYaml<T>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    return parse(text) as T;
  } catch (e) {
    throw new UserError(`${path}: invalid YAML: ${(e as Error).message}`);
  }
}

export function parseYamlText(text: string, label = "input"): unknown {
  try {
    return parse(text);
  } catch (e) {
    throw new UserError(`${label}: invalid YAML: ${(e as Error).message}`);
  }
}

export function readYamlIfExists<T>(path: string): T | null {
  return existsSync(path) ? readYaml<T>(path) : null;
}

// Writes a new file from a plain object. Use updateYaml to edit an existing file.
export function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, stringify(value, STRINGIFY));
}

// Edits an existing YAML file in place. The file's text stays byte-identical outside the keys
// the edit changed, so the owner's comments, blank lines, quoting and block styles survive.
export function updateYaml(path: string, edit: (doc: Document) => void): void {
  const text = readFileSync(path, "utf8");
  writeFileAtomic(path, editYamlText(text, edit, path));
}

// Runs `edit` on the parsed document and returns the original text with only the changed
// parts rewritten: a changed scalar replaces its own source, a removed pair or item removes
// its lines, and an added or replaced pair or item is rendered on its own lines at its
// parent's indentation. An edit shape the splice cannot express in place (a reordered map,
// a collection emptied, a replaced root, a first pair removed from a "- " line) falls back
// to re-rendering the nearest enclosing pair or item, and at the root to the whole document;
// the result is used only when it parses to the edited document's value. A file with CRLF
// line endings gets CRLF on every line the edit writes.
export function editYamlText(text: string, edit: (doc: Document) => void, label = "input"): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new UserError(`${label}: invalid YAML: ${doc.errors[0]!.message}`);
  const root = doc.contents;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const splicer = new Splicer(text, doc.directives?.yaml.version ?? "1.2", eol);
  splicer.snapshot(root);
  edit(doc);
  const spliced = doc.contents === root ? splicer.result(root) : null;
  if (spliced !== null && sameValue(spliced, doc.toJS())) return spliced;
  return withEol(doc.toString(STRINGIFY), eol);
}

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\r?\n/g, eol);
}

function sameValue(text: string, expected: unknown): boolean {
  try {
    return isDeepStrictEqual(parse(text), expected);
  } catch {
    return false;
  }
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

type Snap =
  | { kind: "scalar"; value: unknown; anchor: string | undefined; tag: string | undefined }
  | { kind: "alias"; source: string }
  | { kind: "map"; pairs: Pair[]; comments: Set<string> }
  | { kind: "seq"; items: unknown[] };

interface PairSnap {
  key: unknown;
  value: unknown;
}

type Range = [number, number, number];

function rangeOf(node: unknown): Range | null {
  return isNode(node) && node.range ? (node.range as Range) : null;
}

function pad(n: number): string {
  return " ".repeat(n);
}

// Indents every line of `out` but the first (or every line, with `first`) by `col` spaces,
// leaving empty lines empty. `out` and the result end with a newline.
function indentLines(out: string, col: number, first: boolean): string {
  const lines = out.replace(/\n$/, "").split("\n");
  return `${lines.map((l, i) => (l === "" || (i === 0 && !first) ? l : pad(col) + l)).join("\n")}\n`;
}

// Applies non-overlapping edits; insertions at one offset keep the order they were made in
// and come before a replacement starting there. Overlapping edits return null.
function applyEdits(text: string, edits: Edit[]): string | null {
  const sorted = edits
    .map((e, i) => ({ ...e, i, width: e.end === e.start ? 0 : 1 }))
    .sort((a, b) => a.start - b.start || a.width - b.width || a.i - b.i);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.start < pos) return null;
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

class Splicer {
  private readonly snaps = new WeakMap<object, Snap>();
  private readonly pairSnaps = new WeakMap<Pair, PairSnap>();

  constructor(
    private readonly text: string,
    private readonly version: "1.1" | "1.2" | "next",
    private readonly eol: string,
  ) {}

  // Records each node's value and children before the edit runs, so changes are found by
  // comparing the edited tree against it.
  snapshot(node: unknown): void {
    if (isScalar(node)) this.snaps.set(node, { kind: "scalar", value: node.value, anchor: node.anchor, tag: node.tag });
    else if (isAlias(node)) this.snaps.set(node, { kind: "alias", source: node.source });
    else if (isMap(node)) {
      const comments = new Set<string>();
      for (const p of node.items as Pair[]) {
        this.pairSnaps.set(p, { key: p.key, value: p.value });
        if (isScalar(p.key) && p.key.commentBefore) comments.add(p.key.commentBefore);
        this.snapshot(p.key);
        this.snapshot(p.value);
      }
      this.snaps.set(node, { kind: "map", pairs: [...(node.items as Pair[])], comments });
    } else if (isSeq(node)) {
      for (const item of node.items) this.snapshot(item);
      this.snaps.set(node, { kind: "seq", items: [...node.items] });
    }
  }

  result(root: unknown): string | null {
    try {
      const edits = root == null ? [] : this.splice(root, 0);
      if (edits === null) return null;
      return applyEdits(
        this.text,
        edits.map((e) => ({ ...e, text: withEol(e.text, this.eol) })),
      );
    } catch {
      return null;
    }
  }

  private lineStart(pos: number): number {
    return this.text.lastIndexOf("\n", pos - 1) + 1;
  }

  // The offset of the line after the one holding `pos`, or `pos` when it already starts a line.
  private lineAfter(pos: number): number {
    if (pos > 0 && this.text[pos - 1] === "\n") return pos;
    const i = this.text.indexOf("\n", pos);
    return i < 0 ? this.text.length : i + 1;
  }

  private col(pos: number): number {
    return pos - this.lineStart(pos);
  }

  private onlySpaceBefore(pos: number): boolean {
    return /^[ \t]*$/.test(this.text.slice(this.lineStart(pos), pos));
  }

  // The offset of the "- " indicator before a block sequence item, or -1 when it is not on the item's line.
  private dashBefore(pos: number): number {
    let i = pos - 1;
    while (i >= 0 && (this.text[i] === " " || this.text[i] === "\t")) i--;
    return i >= 0 && this.text[i] === "-" ? i : -1;
  }

  private pairEnd(p: Pair): number {
    const ps = this.pairSnaps.get(p)!;
    return rangeOf(ps.value)?.[1] ?? rangeOf(ps.key)![1];
  }

  private isComment(line: string, maxCol: number): boolean {
    const m = /^([ \t]*)#/.exec(line);
    return m !== null && m[1]!.length <= maxCol;
  }

  // The line text before `pos` (a line start), without its line ending.
  private lineBefore(pos: number): { start: number; line: string } {
    const start = this.lineStart(pos - 1);
    return { start, line: this.text.slice(start, pos).replace(/\r?\n$/, "") };
  }

  // Where a block collection's own text ends. Its range can run on through comment lines at
  // or left of `ownerCol` that come before the next key or item; those, and the blank lines
  // before them, belong to what follows. Blank lines after a block scalar stay with it, since
  // a keep-chomped scalar holds them.
  private contentEnd(node: unknown, ownerCol: number): number {
    const r = rangeOf(node);
    if (!r || !(isMap(node) || isSeq(node)) || node.flow) return r ? r[1] : 0;
    let pos = this.lineAfter(r[1]);
    let firstLow = -1;
    while (pos > r[0]) {
      const { start, line } = this.lineBefore(pos);
      if (line.trim() === "") pos = start;
      else if (this.isComment(line, ownerCol)) pos = firstLow = start;
      else break;
    }
    if (firstLow < 0) return r[1];
    let leaf: unknown = node;
    while (isMap(leaf) || isSeq(leaf)) {
      const last: unknown = leaf.items.at(-1);
      leaf = last && typeof last === "object" && "key" in last ? ((last as Pair).value ?? (last as Pair).key) : last;
    }
    const block = isScalar(leaf) && (leaf.type === "BLOCK_LITERAL" || leaf.type === "BLOCK_FOLDED");
    return block ? firstLow : pos;
  }

  // The start of the line after a node's own text and trailing comment lines: the comment
  // lines in its range (up to range[2]) indented past `ownerCol`, the column of its key or
  // its "- " indicator. A comment at or left of that column belongs to what follows, and
  // blank lines after the last own comment stay where they are.
  private trailingEnd(node: unknown, from: number, ownerCol: number): number {
    const r = rangeOf(node);
    if (!r) return this.lineAfter(from);
    let end = this.lineAfter(Math.min(from, this.contentEnd(node, ownerCol)));
    let pos = end;
    while (pos < r[2] && pos < this.text.length) {
      const next = this.lineAfter(pos + 1);
      const line = this.text.slice(pos, next).replace(/\r?\n$/, "");
      if (this.isComment(line, ownerCol)) break;
      if (this.isComment(line, Infinity)) end = next;
      else if (line.trim() !== "") break;
      pos = next;
    }
    return end;
  }

  private pairTrailingEnd(p: Pair, keyCol: number): number {
    return this.trailingEnd(this.pairSnaps.get(p)!.value, this.pairEnd(p), keyCol);
  }

  private insertAt(pos: number, text: string): Edit {
    const lead = pos === this.text.length && this.text.length > 0 && !this.text.endsWith("\n") ? "\n" : "";
    return { start: pos, end: pos, text: lead + text };
  }

  private changed(node: unknown): boolean {
    const s = isNode(node) ? this.snaps.get(node) : undefined;
    if (!s) return node != null;
    switch (s.kind) {
      case "scalar": {
        const n = node as Scalar;
        return !Object.is(n.value, s.value) || n.anchor !== s.anchor || n.tag !== s.tag;
      }
      case "alias":
        return !isAlias(node) || node.source !== s.source;
      case "map": {
        const items = (node as YAMLMap).items as Pair[];
        if (items.length !== s.pairs.length) return true;
        return items.some((p, i) => {
          if (p !== s.pairs[i]) return true;
          const ps = this.pairSnaps.get(p)!;
          return p.key !== ps.key || p.value !== ps.value || this.changed(p.key) || this.changed(p.value);
        });
      }
      case "seq": {
        const items = (node as YAMLSeq).items;
        if (items.length !== s.items.length) return true;
        return items.some((item, i) => item !== s.items[i] || this.changed(item));
      }
    }
  }

  // Renders a node with no comments or blank line of its own: the original text keeps those.
  // With `trailingOnly`, only its trailing comment is left out, for a block collection whose
  // leading comment lies inside the text being replaced and whose trailing one lies after it.
  private bare<T>(node: unknown, render: () => T, trailingOnly = false): T {
    if (!isNode(node)) return render();
    const saved = { commentBefore: node.commentBefore, comment: node.comment, spaceBefore: node.spaceBefore };
    node.comment = undefined;
    if (!trailingOnly) {
      node.commentBefore = undefined;
      node.spaceBefore = undefined;
    }
    try {
      return render();
    } finally {
      Object.assign(node, saved);
    }
  }

  // Renders a scalar without the anchor and tag its source already has before its range, so
  // the rendered text replaces only the range.
  private bareProps<T>(node: Scalar, render: () => T): T {
    const s = this.snaps.get(node);
    const saved = { anchor: node.anchor, tag: node.tag };
    if (s?.kind === "scalar") {
      if (s.anchor !== undefined) node.anchor = undefined;
      if (s.tag !== undefined) node.tag = undefined;
    }
    try {
      return render();
    } finally {
      Object.assign(node, saved);
    }
  }

  private render(contents: unknown): string {
    const tmp = new Document(null, { version: this.version });
    tmp.contents = contents as typeof tmp.contents;
    return tmp.toString(STRINGIFY);
  }

  private renderPairs(pairs: Pair[], drop: Set<string>): string {
    const map = new YAMLMap();
    map.items.push(...pairs);
    const saved = pairs.map((p) => (isScalar(p.key) ? p.key.commentBefore : undefined));
    pairs.forEach((p, i) => {
      if (isScalar(p.key) && saved[i] !== undefined && drop.has(saved[i]!)) p.key.commentBefore = undefined;
    });
    try {
      return this.render(map);
    } finally {
      pairs.forEach((p, i) => {
        if (isScalar(p.key)) p.key.commentBefore = saved[i];
      });
    }
  }

  private renderItems(items: unknown[], flow = false): string {
    const seq = new YAMLSeq();
    seq.flow = flow;
    seq.items.push(...items);
    return this.render(seq);
  }

  // Edits that bring an original node's source text to its edited value, or null when the
  // node cannot be edited in place and its parent re-renders it.
  private splice(node: unknown, parentCol: number): Edit[] | null {
    if (!this.changed(node)) return [];
    if (isScalar(node)) return this.scalar(node, parentCol);
    if ((isMap(node) || isSeq(node)) && node.flow) return this.flow(node);
    if (isMap(node)) return this.map(node);
    if (isSeq(node)) return this.seq(node);
    return null;
  }

  private scalar(node: Scalar, parentCol: number): Edit[] | null {
    const r = rangeOf(node);
    if (!r) return null;
    const s = this.snaps.get(node);
    // An anchor or tag changed on a node that had one in the source sits outside its range.
    if (s?.kind === "scalar" && ((s.anchor !== undefined && node.anchor !== s.anchor) || (s.tag !== undefined && node.tag !== s.tag)))
      return null;
    const [start, end] = r;
    const old = this.text.slice(start, end);
    // Rendered as a map value so a block scalar gets its content indentation.
    const holder = new YAMLMap();
    holder.set("k", node);
    const out = this.bare(node, () => this.bareProps(node, () => this.render(holder)));
    if (!out.startsWith("k: ")) return null;
    const body = out.slice(3).replace(/\n$/, "");
    if (/^[|>]/.test(body)) {
      const txt = indentLines(body, parentCol, false);
      return [{ start, end: old.endsWith("\n") ? end : this.lineAfter(end), text: txt }];
    }
    if (body.includes("\n")) return null;
    const prev = this.text[start - 1];
    const space = old === "" && prev !== " " && prev !== "\t" ? " " : "";
    return [{ start, end, text: space + body + (old.endsWith("\n") ? "\n" : "") }];
  }

  private flow(node: YAMLMap | YAMLSeq): Edit[] | null {
    const r = rangeOf(node);
    if (!r) return null;
    const inPlace = isMap(node) ? this.flowMapValues(node) : null;
    if (inPlace) return inPlace;
    const rebuilt = isSeq(node) ? this.flowSeq(node, r) : null;
    const text = rebuilt ?? this.bare(node, () => this.render(node)).replace(/\n$/, "");
    if (text.includes("\n") && rebuilt === null) return null;
    return [{ start: r[0], end: r[1], text }];
  }

  // Edits a flow map whose pairs are the same, in the same order, with the same keys, by splicing
  // each changed value in place, so the map keeps its spacing; null when anything else changed.
  private flowMapValues(map: YAMLMap): Edit[] | null {
    const s = this.snaps.get(map);
    const items = map.items as Pair[];
    if (s?.kind !== "map" || items.length !== s.pairs.length) return null;
    const edits: Edit[] = [];
    for (const [i, p] of items.entries()) {
      const ps = this.pairSnaps.get(p);
      if (p !== s.pairs[i] || !ps || p.key !== ps.key || p.value !== ps.value || this.changed(p.key)) return null;
      if (!isScalar(p.value) && !(isNode(p.value) && (p.value as YAMLMap).flow)) return null;
      const sub = isScalar(p.value) ? this.flowScalar(p.value) : this.splice(p.value, 0);
      if (!sub) return null;
      edits.push(...sub);
    }
    return edits;
  }

  // A kept flow map item's source text with its in-place edits, or null when an edit reaches
  // outside its range or adds a line break, so the item is re-rendered.
  private spliceWithin(node: unknown, [start, end]: Range): string | null {
    const edits = this.splice(node, 0);
    if (!edits || edits.some((e) => e.start < start || e.end > end || e.text.includes("\n"))) return null;
    let out = this.text.slice(start, end);
    for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start - start) + e.text + out.slice(e.end - start);
    return out;
  }

  // A changed scalar inside a flow collection, rendered as a flow item so a comma or bracket in it
  // is quoted; null when it cannot be replaced in place.
  private flowScalar(node: Scalar): Edit[] | null {
    if (!this.changed(node)) return [];
    const r = rangeOf(node);
    const s = this.snaps.get(node);
    if (!r || (s?.kind === "scalar" && (s.anchor !== undefined || s.tag !== undefined))) return null;
    const out = this.bare(node, () => this.renderItems([node], true)).replace(/\n$/, "");
    if (out.includes("\n") || !out.startsWith("[") || !out.endsWith("]")) return null;
    return [{ start: r[0], end: r[1], text: out.slice(1, -1) }];
  }

  // Rebuilds a flow sequence from its kept items' source text, the original separators
  // between items that stay adjacent, and rendered text for new or changed items.
  private flowSeq(seq: YAMLSeq, r: Range): string | null {
    const s = this.snaps.get(seq);
    if (s?.kind !== "seq") return null;
    const orig = s.items;
    const ranges = orig.map(rangeOf);
    if (ranges.some((x) => x === null)) return null;
    const rs = ranges as Range[];
    const index = new Map(orig.map((item, i) => [item, i]));
    const keptOrder = seq.items.filter((item) => index.has(item)).map((item) => index.get(item)!);
    if (keptOrder.some((v, i) => i > 0 && v <= keptOrder[i - 1]!)) return null;
    const open = rs.length ? this.text.slice(r[0], rs[0]![0]) : "[";
    const close = rs.length ? this.text.slice(rs.at(-1)![1], r[1]) : "]";
    const gaps = rs.slice(1).map((x, i) => this.text.slice(rs[i]![1], x[0]));
    const sep = gaps.find((g) => !g.includes("#")) ?? ", ";
    const pieces: string[] = [];
    for (const item of seq.items) {
      const i = index.get(item);
      const kept = i === undefined ? null : !this.changed(item) ? this.text.slice(rs[i]![0], rs[i]![1]) : isMap(item) && item.flow ? this.spliceWithin(item, rs[i]!) : null;
      if (kept !== null) {
        pieces.push(kept);
        continue;
      }
      const out = this.bare(item, () => this.renderItems([item], true)).replace(/\n$/, "");
      if (out.includes("\n") || !out.startsWith("[") || !out.endsWith("]")) return null;
      pieces.push(out.slice(1, -1));
    }
    let body = "";
    seq.items.forEach((item, k) => {
      if (k > 0) {
        const a = index.get(seq.items[k - 1]);
        const b = index.get(item);
        body += a !== undefined && b === a + 1 ? gaps[a]! : sep;
      }
      body += pieces[k];
    });
    return open + body + close;
  }

  private map(map: YAMLMap): Edit[] | null {
    const s = this.snaps.get(map);
    if (s?.kind !== "map") return null;
    const orig = s.pairs;
    const cur = map.items as Pair[];
    if (!orig.length || !cur.length || orig.some((p) => !rangeOf(p.key))) return null;
    const first = orig[0]!;
    const firstKey = rangeOf(first.key)![0];
    const col = this.col(firstKey);
    const dashLine = !this.onlySpaceBefore(firstKey);
    const curSet = new Set(cur);
    const origSet = new Set(orig);
    const kept = orig.filter((p) => curSet.has(p));
    const keptInCur = cur.filter((p) => origSet.has(p));
    if (kept.length !== keptInCur.length || kept.some((p, i) => p !== keptInCur[i])) return null;

    const edits: Edit[] = [];
    for (const p of orig) {
      if (curSet.has(p)) continue;
      const keyStart = rangeOf(p.key)![0];
      if (!this.onlySpaceBefore(keyStart)) return null;
      edits.push({ start: this.lineStart(keyStart), end: this.pairTrailingEnd(p, this.col(keyStart)), text: "" });
    }
    for (const p of kept) {
      const ps = this.pairSnaps.get(p)!;
      const same = p.key === ps.key && !this.changed(p.key) && p.value === ps.value;
      const sub = same ? (p.value == null ? [] : this.splice(p.value, col)) : null;
      if (sub) {
        edits.push(...sub);
        continue;
      }
      // The value's trailing comment stays in the text after the replaced lines.
      const keepsValue = p.value === ps.value && isNode(p.value) && !isScalar(p.value);
      const out = this.bare(p.key, () =>
        keepsValue
          ? this.bare(p.value, () => this.renderPairs([p], s.comments), true)
          : this.renderPairs([p], s.comments),
      );
      edits.push({
        start: rangeOf(p.key)![0],
        end: this.lineAfter(this.pairEnd(p)),
        text: indentLines(out, col, false),
      });
    }

    const groups = new Map<Pair | null, Pair[]>();
    let anchor: Pair | null = null;
    for (const p of cur) {
      if (origSet.has(p)) anchor = p;
      else groups.set(anchor, [...(groups.get(anchor) ?? []), p]);
    }
    for (const [a, pairs] of groups) {
      const out = this.renderPairs(pairs, s.comments);
      if (a) {
        edits.push(this.insertAt(this.pairTrailingEnd(a, col), indentLines(out, col, true)));
      } else if (dashLine) {
        // Before the first key of a "- " item: the new pairs take the dash line.
        edits.push({ start: firstKey, end: firstKey, text: indentLines(out, col, false) + pad(col) });
      } else {
        const at = this.lineStart(rangeOf((kept[0] ?? first).key)![0]);
        edits.push({ start: at, end: at, text: indentLines(out, col, true) });
      }
    }
    return edits;
  }

  private seq(seq: YAMLSeq): Edit[] | null {
    const s = this.snaps.get(seq);
    if (s?.kind !== "seq") return null;
    const orig = s.items;
    const cur = seq.items;
    if (!orig.length || !cur.length) return null;
    const dashes = new Map<unknown, number>();
    for (const item of orig) {
      const r = rangeOf(item);
      const d = r ? this.dashBefore(r[0]) : -1;
      if (d < 0) return null;
      dashes.set(item, d);
    }
    const dashCol = this.col(dashes.get(orig[0])!);
    const curSet = new Set(cur);
    const origSet = new Set(orig);
    const kept = orig.filter((item) => curSet.has(item));
    const keptInCur = cur.filter((item) => origSet.has(item));
    if (kept.length !== keptInCur.length || kept.some((item, i) => item !== keptInCur[i])) return null;
    const itemEnd = (item: unknown) => this.lineAfter(rangeOf(item)![1]);
    const trailingEnd = (item: unknown) => this.trailingEnd(item, rangeOf(item)![1], dashCol);

    const edits: Edit[] = [];
    for (const item of orig) {
      if (curSet.has(item)) continue;
      const d = dashes.get(item)!;
      if (!this.onlySpaceBefore(d)) return null;
      edits.push({ start: this.lineStart(d), end: trailingEnd(item), text: "" });
    }
    for (const item of kept) {
      const sub = this.splice(item, dashCol);
      if (sub) {
        edits.push(...sub);
        continue;
      }
      const out = this.bare(item, () => this.renderItems([item]));
      edits.push({ start: dashes.get(item)!, end: itemEnd(item), text: indentLines(out, dashCol, false) });
    }

    const groups = new Map<unknown, unknown[]>();
    let anchor: unknown = null;
    for (const item of cur) {
      if (origSet.has(item)) anchor = item;
      else groups.set(anchor, [...(groups.get(anchor) ?? []), item]);
    }
    for (const [a, items] of groups) {
      const out = indentLines(this.renderItems(items), dashCol, true);
      if (a !== null) {
        edits.push(this.insertAt(trailingEnd(a), out));
        continue;
      }
      const d = dashes.get(kept[0] ?? orig[0])!;
      if (!this.onlySpaceBefore(d)) return null;
      edits.push({ start: this.lineStart(d), end: this.lineStart(d), text: out });
    }
    return edits;
  }
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new UserError(`${path}: invalid JSON: ${(e as Error).message}`);
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

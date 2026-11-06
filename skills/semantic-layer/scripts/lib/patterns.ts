// The selection grammar (spec: Scope patterns), one for scope lists, export filters,
// table-list files and --tables. An entry is an exact name or a glob with * and ?,
// matched case-insensitively against schema.table when it has a dot and against the
// table name otherwise; a part that starts with a double quote matches exactly, case
// included, and may hold dots. An entry starting with re: is a JavaScript regular
// expression, anchored at both ends, always case-insensitive, matched against the
// qualified name when it contains \. and against the table name otherwise. A regex is
// checked before use: a body over 512 characters, nested repeats, repeated overlapping
// choices, long chains of repeats or choices over the same characters and (?-i:...) are
// refused, as is one that does not compile, each with the character where the problem is.
import { UserError } from "./errors.ts";
import { qualifiedName } from "./naming.ts";
import type { Scope } from "./types.ts";

type Named = { schema?: string | null; name: string };

export const MAX_REGEX_LENGTH = 512;

// One position of a glob: * (any run), ? (one character) or a literal character,
// compared exactly when it came from a quoted part and case-insensitively otherwise.
export type GlobToken = { k: "star" } | { k: "one" } | { k: "lit"; c: string; exact: boolean };

export type ParsedPattern =
  | { kind: "regex"; source: string; qualified: boolean; re: RegExp }
  | { kind: "glob"; tokens: GlobToken[]; qualified: boolean; exact: boolean };

export interface PatternProblem {
  kind: "syntax" | "unsafe" | "too_long";
  // 0-based offset into the pattern as written, re: included.
  offset: number;
  message: string;
}

// One line of a table-list file: "!<entry>" excludes, anything else includes.
export interface ListEntry {
  kind: "include" | "exclude";
  pattern: string;
}

const NEXT = "Fix the pattern and run the command again; sl validate lists every pattern problem in the project.";

function shown(pattern: string): string {
  return pattern.length > 80 ? `${pattern.slice(0, 77)}...` : pattern;
}

// ---- Globs and exact names ----

function parseGlob(pattern: string): ParsedPattern | PatternProblem {
  const tokens: GlobToken[] = [];
  let qualified = false;
  // A quote opens a quoted part only at the start of a part; elsewhere, as in the
  // name odd"name, it is an ordinary character.
  let partStart = true;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '"' && partStart) {
      let j = i + 1;
      for (;;) {
        if (j >= pattern.length) {
          return {
            kind: "syntax",
            offset: i,
            message:
              `Invalid pattern "${shown(pattern)}": the quote at character ${i + 1} is never closed. ` +
              `Close the name with another ", or write "" for a quote inside a quoted name. ${NEXT}`,
          };
        }
        if (pattern[j] === '"') {
          if (pattern[j + 1] !== '"') break;
          tokens.push({ k: "lit", c: '"', exact: true });
          j += 2;
          continue;
        }
        tokens.push({ k: "lit", c: pattern[j]!, exact: true });
        j++;
      }
      i = j;
    } else if (c === "*") tokens.push({ k: "star" });
    else if (c === "?") tokens.push({ k: "one" });
    else {
      if (c === ".") qualified = true;
      tokens.push({ k: "lit", c, exact: false });
    }
    partStart = c === ".";
  }
  return { kind: "glob", tokens, qualified, exact: tokens.every((t) => t.k === "lit") };
}

// The pattern that names one table exactly: a part holding a quote, a wildcard or
// (in the table name) a dot is quoted, with any quote in it doubled.
export function literalPattern(table: Named): string {
  const quote = (part: string, dots: boolean) =>
    /["*?]/.test(part) || (dots && part.includes(".")) ? `"${part.replaceAll('"', '""')}"` : part;
  const name = quote(table.name, true);
  return table.schema ? `${quote(table.schema, false)}.${name}` : name;
}

// Case folding as a regex with the i flag and no u flag does it.
function fold(c: string): string {
  const u = c.toUpperCase();
  return u.length !== 1 || (c.charCodeAt(0) > 127 && u.charCodeAt(0) <= 127) ? c : u;
}

function sameChar(t: { c: string; exact: boolean }, c: string): boolean {
  return t.c === c || (!t.exact && fold(t.c) === fold(c));
}

// Wildcard matching without a regex: linear in practice and O(pattern x name) at worst,
// so no glob can make matching slow.
function globMatch(tokens: GlobToken[], s: string): boolean {
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;
  while (i < s.length) {
    const t = tokens[p];
    if (t && (t.k === "one" || (t.k === "lit" && sameChar(t, s[i]!)))) {
      p++;
      i++;
    } else if (t && t.k === "star") {
      starP = p++;
      starI = i;
    } else if (starP >= 0) {
      p = starP + 1;
      i = ++starI;
    } else return false;
  }
  while (tokens[p]?.k === "star") p++;
  return p === tokens.length;
}

// ---- Regular expressions: a structural parser for the safety check ----

type RNode =
  | { t: "alt"; alts: RNode[][]; spans: [number, number][] }
  | { t: "group"; body: RNode; pos: number; zero: boolean; lookbehind: boolean }
  | { t: "repeat"; node: RNode; min: number; max: number; pos: number; text: string }
  | { t: "char"; src: string; pos: number }
  | { t: "assert"; pos: number }
  | { t: "backref"; pos: number };

class RegexSyntax {
  constructor(
    readonly offset: number,
    readonly reason: string,
  ) {}
}

const META = new Set("\\^$.*+?()[]{}|/");

// Parses a regex body (Annex B syntax, no u flag). `base` is the body's offset in the
// pattern, so messages name characters as the owner wrote them.
class RegexParser {
  i = 0;
  readonly names: { name: string; pos: number }[] = [];
  readonly refs: { name: string; pos: number }[] = [];
  // Where a (?-i:...) group turns case-insensitive matching off, if one does.
  caseOff: number | null = null;
  constructor(
    readonly src: string,
    readonly base: number,
  ) {}

  at(offset: number): number {
    return offset + this.base + 1;
  }
  fail(offset: number, reason: string): never {
    throw new RegexSyntax(offset, reason);
  }

  parse(): RNode {
    const node = this.alt();
    if (this.i < this.src.length) this.fail(this.i, `the ")" at character ${this.at(this.i)} closes no group; remove it or add a "(" before it`);
    return node;
  }

  alt(): RNode {
    const alts: RNode[][] = [];
    const spans: [number, number][] = [];
    for (;;) {
      const start = this.i;
      alts.push(this.seq());
      spans.push([start, this.i]);
      if (this.src[this.i] !== "|") break;
      this.i++;
    }
    return { t: "alt", alts, spans };
  }

  seq(): RNode[] {
    const items: RNode[] = [];
    while (this.i < this.src.length && this.src[this.i] !== "|" && this.src[this.i] !== ")") items.push(this.term());
    return items;
  }

  quantifier(at: number): { min: number; max: number; text: string } | null {
    const c = this.src[at];
    if (c === "*") return { min: 0, max: Infinity, text: c };
    if (c === "+") return { min: 1, max: Infinity, text: c };
    if (c === "?") return { min: 0, max: 1, text: c };
    if (c !== "{") return null;
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(at));
    if (!m) return null;
    const min = Number(m[1]);
    return { min, max: m[2] ? (m[3] ? Number(m[3]) : Infinity) : min, text: m[0] };
  }

  term(): RNode {
    const atom = this.atom();
    const q = this.quantifier(this.i);
    if (!q) return atom;
    const pos = this.i;
    if (atom.t === "assert" || (atom.t === "group" && atom.lookbehind)) {
      this.fail(pos, `"${q.text}" at character ${this.at(pos)} follows something that matches no characters, so it has nothing to repeat`);
    }
    if (q.min > q.max) this.fail(pos, `the numbers in "${q.text}" at character ${this.at(pos)} are out of order; write the smaller one first`);
    this.i += q.text.length;
    if (this.src[this.i] === "?") this.i++;
    return { t: "repeat", node: atom, min: q.min, max: q.max, pos, text: q.text };
  }

  atom(): RNode {
    const pos = this.i;
    const c = this.src[pos]!;
    const q = this.quantifier(pos);
    if (q) this.fail(pos, `"${q.text}" at character ${this.at(pos)} has nothing before it to repeat (a repeat cannot start the regex, follow "(" or "|", or repeat another repeat)`);
    if (c === "^" || c === "$") {
      this.i++;
      return { t: "assert", pos };
    }
    if (c === "[") return this.cls();
    if (c === "(") return this.group();
    if (c === "\\") return this.escape();
    this.i++;
    return { t: "char", src: c === "." ? "." : META.has(c) ? `\\${c}` : c, pos };
  }

  group(): RNode {
    const pos = this.i;
    this.i++;
    let zero = false;
    let lookbehind = false;
    if (this.src[this.i] === "?") {
      const rest = this.src.slice(this.i + 1);
      if (rest.startsWith(":")) this.i += 2;
      else if (rest.startsWith("=") || rest.startsWith("!")) {
        this.i += 2;
        zero = true;
      } else if (rest.startsWith("<=") || rest.startsWith("<!")) {
        this.i += 3;
        zero = lookbehind = true;
      } else if (rest.startsWith("<")) {
        const m = /^<([A-Za-z_$][\w$]*)>/.exec(rest);
        if (!m) this.fail(this.i + 1, `the group name after "(?<" at character ${this.at(pos)} must start with a letter and hold only letters, digits and _`);
        this.names.push({ name: m[1]!, pos: this.i + 2 });
        this.i += 1 + m[0].length;
      } else {
        const m = /^[ims]*(?:-[ims]*)?:/.exec(rest);
        if (!m || m[0].length < 2) this.fail(pos, `"(?" at character ${this.at(pos)} must be followed by ":", "=", "!", "<=", "<!" or "<name>"`);
        if (/-[ms]*i/.test(m[0]) && this.caseOff === null) this.caseOff = pos;
        this.i += 1 + m[0].length;
      }
    }
    const body = this.alt();
    if (this.src[this.i] !== ")") this.fail(pos, `the "(" at character ${this.at(pos)} is never closed; add a ")"`);
    this.i++;
    return { t: "group", body, pos, zero, lookbehind };
  }

  escape(): RNode {
    const pos = this.i;
    this.i++;
    if (this.i >= this.src.length) this.fail(pos, `the regex ends with a lone "\\" at character ${this.at(pos)}; write "\\\\" to match a backslash`);
    const c = this.src[this.i++]!;
    if (c === "b" || c === "B") return { t: "assert", pos };
    if (/[1-9]/.test(c)) {
      while (/\d/.test(this.src[this.i] ?? "")) this.i++;
      return { t: "backref", pos };
    }
    if (c === "k" && this.src[this.i] === "<") {
      const end = this.src.indexOf(">", this.i);
      if (end > 0) {
        this.refs.push({ name: this.src.slice(this.i + 1, end), pos });
        this.i = end + 1;
        return { t: "backref", pos };
      }
    }
    const rest = this.src.slice(this.i);
    if (c === "x" && /^[0-9a-f]{2}/i.test(rest)) this.i += 2;
    else if (c === "u" && /^[0-9a-f]{4}/i.test(rest)) this.i += 4;
    else if (c === "c" && /^[a-z]/i.test(rest)) this.i += 1;
    return { t: "char", src: this.src.slice(pos, this.i), pos };
  }

  // A class atom's character code, or null for a class escape such as \d.
  classAtom(): number | null {
    if (this.src[this.i] !== "\\") return this.src.charCodeAt(this.i++);
    this.i++;
    if (this.i >= this.src.length) return null;
    const c = this.src[this.i++]!;
    const rest = this.src.slice(this.i);
    if ("dDwWsS".includes(c)) return null;
    const simple: Record<string, number> = { b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
    if (simple[c] !== undefined) return simple[c]!;
    if (c === "x" && /^[0-9a-f]{2}/i.test(rest)) return parseInt(this.src.slice(this.i, (this.i += 2)), 16);
    if (c === "u" && /^[0-9a-f]{4}/i.test(rest)) return parseInt(this.src.slice(this.i, (this.i += 4)), 16);
    if (c === "c") {
      if (/^[a-z0-9_]/i.test(rest)) return this.src.charCodeAt(this.i++) % 32;
      this.i--;
      return 92;
    }
    if (/[0-7]/.test(c)) {
      let s = c;
      while (s.length < 3 && /[0-7]/.test(this.src[this.i] ?? "") && parseInt(s + this.src[this.i], 8) <= 255) s += this.src[this.i++];
      return parseInt(s, 8);
    }
    return c.charCodeAt(0);
  }

  cls(): RNode {
    const pos = this.i;
    this.i++;
    if (this.src[this.i] === "^") this.i++;
    while (this.i < this.src.length && this.src[this.i] !== "]") {
      const from = this.i;
      const a = this.classAtom();
      if (this.src[this.i] === "-" && this.i + 1 < this.src.length && this.src[this.i + 1] !== "]") {
        this.i++;
        const b = this.classAtom();
        if (a !== null && b !== null && a > b) {
          this.fail(from, `the range "${this.src.slice(from, this.i)}" at character ${this.at(from)} is out of order; write the lower character first`);
        }
      }
    }
    if (this.i >= this.src.length) this.fail(pos, `the "[" at character ${this.at(pos)} is never closed; add a "]"`);
    this.i++;
    return { t: "char", src: this.src.slice(pos, this.i), pos };
  }
}

// ---- Regex safety: nested repeats and repeated choices that overlap ----

type First = { srcs: string[]; any: boolean; nullable: boolean };

function firstOf(node: RNode): First {
  switch (node.t) {
    case "char":
      return { srcs: [node.src], any: false, nullable: false };
    case "assert":
      return { srcs: [], any: false, nullable: true };
    case "backref":
      return { srcs: [], any: true, nullable: true };
    case "group":
      return node.zero ? { srcs: [], any: false, nullable: true } : firstOf(node.body);
    case "repeat": {
      const f = firstOf(node.node);
      return { ...f, nullable: f.nullable || node.min === 0 };
    }
    case "alt": {
      const fs = node.alts.map(firstOfSeq);
      return { srcs: fs.flatMap((f) => f.srcs), any: fs.some((f) => f.any), nullable: fs.some((f) => f.nullable) };
    }
  }
}

function firstOfSeq(items: RNode[]): First {
  const out: First = { srcs: [], any: false, nullable: true };
  for (const item of items) {
    const f = firstOf(item);
    out.srcs.push(...f.srcs);
    out.any ||= f.any;
    if (!f.nullable) {
      out.nullable = false;
      break;
    }
  }
  return out;
}

const charMatchers = new Map<string, RegExp | null>();
function charMatcher(src: string): RegExp | null {
  if (!charMatchers.has(src)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(`^(?:${src})$`, "i");
    } catch {
      re = null;
    }
    charMatchers.set(src, re);
  }
  return charMatchers.get(src)!;
}

// Whether two first-character sets share a character, tested over Latin-1 and every
// character the regex itself names. A matcher that does not stand alone counts as any.
// Answers are kept per universe, which is one regex's.
const overlapMemo = new WeakMap<string[], Map<string, boolean>>();
function overlaps(a: First, b: First, universe: string[]): boolean {
  if (a.any || b.any) return true;
  let memo = overlapMemo.get(universe);
  if (!memo) overlapMemo.set(universe, (memo = new Map()));
  const key = `${a.srcs.join("\0")}\u0001${b.srcs.join("\0")}`;
  let hit = memo.get(key);
  if (hit === undefined) memo.set(key, (hit = overlapsUncached(a, b, universe)));
  return hit;
}

function overlapsUncached(a: First, b: First, universe: string[]): boolean {
  const ma = a.srcs.map(charMatcher);
  const mb = b.srcs.map(charMatcher);
  if (ma.includes(null) || mb.includes(null)) return true;
  return universe.some((ch) => ma.some((r) => r!.test(ch)) && mb.some((r) => r!.test(ch)));
}

function children(node: RNode): RNode[] {
  if (node.t === "alt") return node.alts.flat();
  if (node.t === "group") return [node.body];
  if (node.t === "repeat") return [node.node];
  return [];
}

function variableRepeat(node: RNode): (RNode & { t: "repeat" }) | null {
  if (node.t === "repeat" && node.max > node.min) return node;
  for (const c of children(node)) {
    const hit = variableRepeat(c);
    if (hit) return hit;
  }
  return null;
}

// How many ways a part's repeats can split the same text: the product of each variable
// repeat's count of choices, Infinity when one is unbounded.
function ways(node: RNode): number {
  const own = node.t === "repeat" ? node.max - node.min + 1 : 1;
  return children(node).reduce((n, c) => n * ways(c), own);
}

// Ambiguity a bounded repeat may carry: ways ** max up to this many paths stays fast,
// as in a date suffix "(_?\d{2}){0,2}". An unbounded repeat may carry none.
const MAX_PATHS = 1000;
function tooAmbiguous(repeat: RNode & { t: "repeat" }, perIteration: number): boolean {
  if (perIteration <= 1) return false;
  return repeat.max === Infinity || perIteration ** repeat.max > MAX_PATHS;
}

// The choice a repeated part is made of, looking through groups that wrap one item.
function choiceOf(node: RNode): (RNode & { t: "alt" }) | null {
  if (node.t === "group" && !node.zero) return choiceOf(node.body);
  if (node.t !== "alt") return null;
  if (node.alts.length > 1) return node;
  const only = node.alts[0]!;
  return only.length === 1 ? choiceOf(only[0]!) : null;
}

// Every character matcher a part can use.
function charsOf(node: RNode): First {
  if (node.t === "char") return { srcs: [node.src], any: false, nullable: false };
  if (node.t === "backref") return { srcs: [], any: true, nullable: true };
  if (node.t === "assert" || (node.t === "group" && node.zero)) return { srcs: [], any: false, nullable: true };
  const parts = children(node).map(charsOf);
  return { srcs: parts.flatMap((f) => f.srcs), any: parts.some((f) => f.any), nullable: true };
}

// How many unbounded repeats a part strings together: summed along a sequence, the
// largest of a choice's options, multiplied by a bounded repeat's count.
function weight(node: RNode): number {
  switch (node.t) {
    case "repeat":
      return node.max === Infinity ? 1 + weight(node.node) : node.max * weight(node.node);
    case "group":
      return node.zero ? 0 : weight(node.body);
    case "alt":
      return Math.max(0, ...node.alts.map((items) => items.reduce((n, c) => n + weight(c), 0)));
    default:
      return 0;
  }
}

function itemPos(node: RNode): number {
  return node.t === "alt" ? 0 : node.pos;
}

// An unbounded repeat counts as this many ways to split a name in the chain check below.
const NAME_WAYS = 64;
const MAX_CHAIN = 3;

// Whether two options of a choice can both match at one spot. Options of single
// characters, such as tmp and temp, can only when one could be the start of the other.
function canShare(a: RNode[], b: RNode[], universe: string[]): boolean {
  const one = (n: RNode): First => ({ srcs: [(n as { src: string }).src], any: false, nullable: false });
  if (a.every((n) => n.t === "char") && b.every((n) => n.t === "char")) {
    return a.slice(0, b.length).every((n, k) => overlaps(one(n), one(b[k]!), universe));
  }
  const fa = firstOfSeq(a);
  const fb = firstOfSeq(b);
  return fa.nullable || fb.nullable || overlaps(fa, fb, universe);
}

// How many ways a part can match the same text through its bounded repeats and its
// choices, unbounded repeats aside: a{0,30} has 31, (x|xy) two, (tmp|temp) one.
function spread(node: RNode, universe: string[]): number {
  switch (node.t) {
    case "repeat": {
      const inner = spread(node.node, universe);
      // A bounded repeat counts as many ways as an unbounded one at most.
      return node.max === Infinity ? inner : Math.min(node.max - node.min + 1, NAME_WAYS) * inner ** node.max;
    }
    case "group":
      return node.zero ? 1 : spread(node.body, universe);
    case "alt": {
      const each = node.alts.map((items) => items.reduce((n, c) => n * spread(c, universe), 1));
      if (each.length === 1) return each[0]!;
      // The most ways at one spot: an option's own, plus those of the options that can
      // match where it does.
      return Math.max(...each.map((w, a) => each.reduce((n, v, b) => (b !== a && canShare(node.alts[a]!, node.alts[b]!, universe) ? n + v : n), w)));
    }
    default:
      return 1;
  }
}

// Repeats and choices in a row that can trade the same characters, such as a*a*a*a*,
// .*_.*_.*_.*, a{0,30}a{0,30}... or a*b?a*b?a*, split a name in many ways. Each part
// scores NAME_WAYS per unbounded repeat times its spread, and a chain multiplies the
// scores of parts that can trade characters: nothing between two of them that must
// match a character keeps them apart, and a part that can match nothing never does.
// A chain over NAME_WAYS ** MAX_CHAIN is refused: at most three unbounded repeats, or
// about 262,000 bounded ways. Three unbounded repeats cost about n**3 steps on a name of
// n characters: about 0.2 s per table at the 1,024 characters BigQuery allows.
const LIMIT = NAME_WAYS ** MAX_CHAIN;
type Chain = { first: RNode; last: RNode; length: number };
function longChain(items: RNode[], universe: string[]): Chain | null {
  type Part = { node: RNode; chars: First; gaps: First[]; open: boolean; score: number; length: number; first: RNode };
  const parts: Part[] = [];
  for (const item of items) {
    const chars = charsOf(item);
    const w = weight(item);
    const ways = spread(item, universe);
    if (w || ways > 1) {
      let best: Part | null = null;
      for (const prev of parts) {
        const linked = prev.open && overlaps(prev.chars, chars, universe) && prev.gaps.every((g) => overlaps(g, chars, universe));
        if (linked && (!best || prev.score > best.score)) best = prev;
      }
      const part: Part = {
        node: item,
        chars,
        gaps: [],
        open: true,
        score: ways * NAME_WAYS ** w * (best?.score ?? 1),
        length: w + (best?.length ?? 0),
        first: best?.first ?? item,
      };
      if (part.score > LIMIT) return { first: part.first, last: item, length: part.length };
      if (!firstOf(item).nullable) for (const prev of parts) addGap(prev, chars, universe);
      parts.push(part);
    } else if (!firstOf(item).nullable) {
      for (const prev of parts) addGap(prev, chars, universe);
    }
  }
  return null;
}

// A part that must match a character keeps an earlier part from trading characters
// with later ones unless it can match the same characters as both.
function addGap(prev: { chars: First; gaps: First[]; open: boolean }, gap: First, universe: string[]): void {
  if (!prev.open) return;
  if (overlaps(prev.chars, gap, universe)) prev.gaps.push(gap);
  else prev.open = false;
}

function findUnsafe(node: RNode, p: RegexParser, universe: string[]): { offset: number; reason: string; fix: string } | null {
  if (node.t === "repeat" && node.max > 1) {
    const inner = variableRepeat(node.node);
    if (inner && tooAmbiguous(node, ways(node.node))) {
      return {
        offset: node.pos,
        reason: `the "${node.text}" at character ${p.at(node.pos)} repeats a part that holds another repeat (the "${inner.text}" at character ${p.at(inner.pos)})`,
        fix: `Keep only one of the two repeats, for example "x+" instead of "(x+)+"`,
      };
    }
    const choice = choiceOf(node.node);
    if (choice && tooAmbiguous(node, choice.alts.length)) {
      const firsts = choice.alts.map(firstOfSeq);
      const option = (k: number) => {
        const [s, e] = choice.spans[k]!;
        return `"${p.src.slice(s, e)}" at character ${p.at(s)}`;
      };
      const empty = firsts.findIndex((f) => f.nullable);
      if (empty >= 0) {
        return {
          offset: node.pos,
          reason: `the "${node.text}" at character ${p.at(node.pos)} repeats a choice with an option that can match nothing (${option(empty)})`,
          fix: "Make every option match at least one character, or drop the repeat",
        };
      }
      for (let a = 0; a < firsts.length; a++) {
        for (let b = a + 1; b < firsts.length; b++) {
          if (overlaps(firsts[a]!, firsts[b]!, universe)) {
            return {
              offset: node.pos,
              reason: `the "${node.text}" at character ${p.at(node.pos)} repeats a choice whose options ${option(a)} and ${option(b)} can start with the same character`,
              fix: `Make the options start with different characters, for example "(a|b)+" instead of "(a|aa)+", or drop the repeat`,
            };
          }
        }
      }
    }
  }
  if (node.t === "alt") {
    for (const items of node.alts) {
      const chain = longChain(items, universe);
      if (chain) {
        const at = p.at(itemPos(chain.last));
        const from = p.at(itemPos(chain.first));
        if (chain.length > MAX_CHAIN) {
          return {
            offset: itemPos(chain.last),
            reason: `the repeat at character ${at} is repeat number ${chain.length} in a row that can match the same characters (the first is at character ${from})`,
            fix: `Join neighbouring repeats into one, for example ".*" instead of ".*.*", or separate them with a character they cannot match`,
          };
        }
        return {
          offset: itemPos(chain.last),
          reason:
            chain.first === chain.last
              ? `the part at character ${at} can match the same text in too many ways`
              : `the repeats and choices from character ${from} to character ${at} can match the same characters, ` +
                `so together they can split one name in too many ways`,
          fix: `Join neighbouring repeats into one, for example "a{0,60}" instead of "a{0,30}a{0,30}", or separate them with a character they cannot match`,
        };
      }
    }
  }
  for (const c of children(node)) {
    const hit = findUnsafe(c, p, universe);
    if (hit) return hit;
  }
  return null;
}

// Checks a regex body; `base` is its offset in the pattern (3 for "re:").
function checkRegex(pattern: string, body: string, base: number): PatternProblem | null {
  if (body.length > MAX_REGEX_LENGTH) {
    const offset = base + MAX_REGEX_LENGTH;
    return {
      kind: "too_long",
      offset,
      message:
        `Regex too long in pattern "${shown(pattern)}": it has ${body.length} characters and the limit is ${MAX_REGEX_LENGTH}, ` +
        `so everything from character ${offset + 1} on is over it. Shorten it, or split it into several patterns. ${NEXT}`,
    };
  }
  const parser = new RegexParser(body, base);
  let engineError: string | null = null;
  try {
    new RegExp(body, "i");
  } catch (e) {
    engineError = (e as Error).message;
  }
  let tree: RNode | null = null;
  let syntax: RegexSyntax | null = null;
  try {
    tree = parser.parse();
  } catch (e) {
    if (!(e instanceof RegexSyntax)) throw e;
    syntax = e;
  }
  if (engineError !== null) {
    if (!syntax) {
      const seen = new Set<string>();
      const dup = parser.names.find((n) => (seen.has(n.name) ? true : (seen.add(n.name), false)));
      const ref = parser.refs.find((r) => !parser.names.some((n) => n.name === r.name));
      if (dup) syntax = new RegexSyntax(dup.pos, `the group name "${dup.name}" at character ${parser.at(dup.pos)} is used twice; rename one`);
      else if (ref) syntax = new RegexSyntax(ref.pos, `"\\k<${ref.name}>" at character ${parser.at(ref.pos)} names no group`);
      else syntax = new RegexSyntax(0, `it does not compile (${engineError}); the problem is at or after character ${base + 1}`);
    }
    return { kind: "syntax", offset: base + syntax.offset, message: `Invalid regex in pattern "${shown(pattern)}": ${syntax.reason}. ${NEXT}` };
  }
  if (syntax || !tree) {
    // The engine accepts it but the checker cannot read it, so its safety is unknown.
    const offset = base + (syntax?.offset ?? 0);
    return {
      kind: "unsafe",
      offset,
      message:
        `Unsafe regex in pattern "${shown(pattern)}": it cannot be checked for slow matching (${syntax?.reason ?? "unreadable"}). ` +
        `Simplify it, or use a glob. ${NEXT}`,
    };
  }
  if (parser.caseOff !== null) {
    const offset = base + parser.caseOff;
    return {
      kind: "syntax",
      offset,
      message:
        `Invalid regex in pattern "${shown(pattern)}": the group at character ${offset + 1} turns off ignoring case with "-i", ` +
        `and a pattern always ignores case; remove the "-i", or use a glob with a "quoted" part to match case exactly. ${NEXT}`,
    };
  }
  const universe = Array.from({ length: 256 }, (_, k) => String.fromCharCode(k));
  for (const ch of body) if (ch.charCodeAt(0) > 255) universe.push(ch);
  const hit = findUnsafe(tree, parser, universe);
  if (hit) {
    return {
      kind: "unsafe",
      offset: base + hit.offset,
      message: `Unsafe regex in pattern "${shown(pattern)}": ${hit.reason}, and that can make matching extremely slow. ${hit.fix}. ${NEXT}`,
    };
  }
  return null;
}

// ---- The public surface ----

const cache = new Map<string, ParsedPattern | PatternProblem>();

function parse(pattern: string): ParsedPattern | PatternProblem {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let out: ParsedPattern | PatternProblem;
  if (pattern.startsWith("re:")) {
    const body = pattern.slice(3);
    out = checkRegex(pattern, body, 3) ?? { kind: "regex", source: body, qualified: body.includes("\\."), re: new RegExp(`^(?:${body})$`, "i") };
  } else out = parseGlob(pattern);
  cache.set(pattern, out);
  return out;
}

function isProblem(p: ParsedPattern | PatternProblem): p is PatternProblem {
  return "message" in p;
}

// The problem with a pattern, with the 0-based offset where it is, or null when it is usable.
export function checkPattern(pattern: string): PatternProblem | null {
  const p = parse(pattern);
  return isProblem(p) ? p : null;
}

// The pattern's parsed form; throws a UserError naming the problem when it is not usable.
export function parsePattern(pattern: string): ParsedPattern {
  const p = parse(pattern);
  if (isProblem(p)) throw new UserError(p.message);
  return p;
}

export function validatePattern(pattern: string): string | null {
  return checkPattern(pattern)?.message ?? null;
}

export function matchesPattern(pattern: string, table: Named): boolean {
  const p = parsePattern(pattern);
  const target = p.qualified ? qualifiedName(table) : table.name;
  return p.kind === "regex" ? p.re.test(target) : globMatch(p.tokens, target);
}

// Matches a dotted name such as source.model against a pattern, for access rules.
export function matchesDotted(pattern: string, dotted: string): boolean {
  const dot = dotted.lastIndexOf(".");
  const named = dot < 0 ? { schema: null, name: dotted } : { schema: dotted.slice(0, dot), name: dotted.slice(dot + 1) };
  return matchesPattern(pattern, named);
}

export function inScope(scope: Scope | undefined, table: Named): boolean {
  const include = scope?.include ?? [];
  const exclude = scope?.exclude ?? [];
  if (include.length && !include.some((p) => matchesPattern(p, table))) return false;
  return !exclude.some((p) => matchesPattern(p, table));
}

export function filterInScope<T extends Named>(scope: Scope | undefined, tables: T[]): T[] {
  return tables.filter((t) => inScope(scope, t));
}

// The include and exclude patterns that match no table, in list order, each once.
export function unmatchedPatterns(scope: Scope | undefined, tables: Named[]): string[] {
  const all = [...(scope?.include ?? []), ...(scope?.exclude ?? [])];
  return [...new Set(all)].filter((p) => !tables.some((t) => matchesPattern(p, t)));
}

// Reads one table-list entry: "!<entry>" is an exclude, anything else an include.
// Surrounding spaces are dropped; a blank line is null. Comments are the reader's job.
export function parseEntry(line: string): ListEntry | null {
  const text = line.trim();
  if (!text) return null;
  if (!text.startsWith("!")) return { kind: "include", pattern: text };
  const pattern = text.slice(1).trim();
  if (!pattern) throw new UserError(`The entry "${text}" has nothing after "!"; write the table or pattern to exclude, for example "!*_tmp".`);
  return { kind: "exclude", pattern };
}

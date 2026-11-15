// The statement reader of semlayer usage (spec: Usage evidence): what one SQL statement someone wrote
// reads, joins, sums and keeps, read from its tokens, never run. It is no parser: it reads the
// shapes analysts write (select blocks, FROM and JOIN items, CTEs, subqueries, WHERE conjuncts,
// aggregates, GROUP BY) and leaves out anything it cannot place, never guessing. The tokens are
// sql-guard's (the reader semlayer run's protected-value check, sqlMask in lib/output.ts, reads), which
// drop comments unread; this file adds placeholders, two-character operators and dbt's Jinja.
import { type Token, tokenize } from "./sql-guard.ts";

// What a table name a statement reads stands for in the source being read.
//   kept            a table of the kept set (in scope, or in a --schema schema)
//   out_of_scope    a snapshot table of a kept schema that the kept set leaves out
//   other           a table of another schema (or a name no snapshot table has)
//   not_in_snapshot a schema-qualified name in a kept schema that the snapshot does not hold
//   ambiguous       an unqualified name more than one snapshot table has
export type HitKind = "kept" | "out_of_scope" | "other" | "not_in_snapshot" | "ambiguous";

export interface TableHit {
  kind: HitKind;
  // The snapshot's qualified name for a snapshot table, else the name as written, in lower case.
  name: string;
  // A snapshot table's columns, lower case to the snapshot's spelling.
  columns?: Map<string, string>;
}

export interface Catalog {
  // parts: the dotted name as written, in lower case (catalog.schema.table, schema.table or table).
  resolve(parts: string[]): TableHit;
}

export type LitKind = "string" | "number" | "bool" | "null" | "placeholder" | "expression" | "subquery";
export interface Lit {
  kind: LitKind;
  text: string;
}

export interface ColRef {
  table: string;
  column: string;
}

export interface CondFact extends ColRef {
  // A function the column is wrapped in (lower(email) like ...), when there is one.
  fn?: string;
  op: string;
  values: Lit[];
}

export interface AggFact {
  table: string;
  fn: "sum" | "count" | "count_distinct" | "avg" | "min" | "max";
  // The expression inside, columns written bare and every literal as ?; "*" for count(*).
  expr: string;
  // Conditions that hold for the rows it reads: its own FILTER or CASE WHEN, the WHERE and ON of
  // its select block and of the CTEs and subqueries in its FROM.
  conditions: CondFact[];
}

export interface JoinFact {
  // a < b by name, or the same table joined to itself; keys pair a's column with b's.
  a: string;
  b: string;
  keys: [string, string][];
}

export interface GroupFact extends ColRef {
  grain?: string;
}

export interface StatementFacts {
  // empty: nothing but white space and comments, not counted as a statement.
  status: "read" | "no_table" | "not_understood" | "empty";
  // Every table name read, with what it is.
  tables: Map<string, HitKind>;
  joins: JoinFact[];
  aggregates: AggFact[];
  conditions: CondFact[];
  groupBy: GroupFact[];
}

type Tok = Omit<Token, "kind"> & { kind: Token["kind"] | "placeholder" };

const NOT_UNDERSTOOD: StatementFacts = { status: "not_understood", tables: new Map(), joins: [], aggregates: [], conditions: [], groupBy: [] };

class Unplaceable extends Error {}
const fail = (): never => {
  throw new Unplaceable();
};

const TWO_CHAR = new Set(["<=", ">=", "<>", "!=", "::", "||", "=>", "->"]);

// sql-guard's tokens with two-character operators joined, placeholders ($1, ?, :name, %s, %(name)s,
// @name) as one token, and dbt's {{ ref('t') }} and {{ source('s', 't') }} read as the table name t.
// Any other {{ ... }} is a placeholder; {% ... %} and {# ... #} are dropped. Returns null when a
// Jinja expression is not closed.
function normalize(raw: Token[]): Tok[] | null {
  const out: Tok[] = [];
  const op = (t: { kind: string; text: string } | undefined, text: string) => t?.kind === "op" && t.text === text;
  const adjacent = (a: Token | undefined, b: Token | undefined) => !!a && !!b && a.end === b.pos;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    const n = raw[i + 1];
    if (op(t, "{") && (op(n, "{") || op(n, "%") || op(n, "#")) && adjacent(t, n)) {
      const close = n!.text === "{" ? "}" : n!.text;
      let j = i + 2;
      while (j < raw.length && !(op(raw[j], close) && op(raw[j + 1], "}") && adjacent(raw[j], raw[j + 1]))) j++;
      if (j >= raw.length) return null;
      if (close === "}") {
        const inner = raw.slice(i + 2, j);
        const word = inner[0]?.kind === "word" ? inner[0].text : "";
        const strs = inner.filter((x) => x.kind === "string");
        const shape = inner.map((x) => (x.kind === "string" ? "s" : x.text)).join("");
        if (word === "ref" && /^ref\(s\)$/.test(shape)) out.push({ kind: "ident", text: strs[0]!.text, pos: t.pos, end: raw[j + 1]!.end });
        else if (word === "source" && /^source\(s,s\)$/.test(shape)) out.push({ kind: "ident", text: strs[1]!.text, pos: t.pos, end: raw[j + 1]!.end });
        else out.push({ kind: "placeholder", text: "?", pos: t.pos, end: raw[j + 1]!.end });
      }
      i = j + 1;
      continue;
    }
    if (t.kind === "op" && n?.kind === "op" && adjacent(t, n) && TWO_CHAR.has(t.text + n.text)) {
      out.push({ ...t, text: t.text + n.text, end: n.end });
      i++;
      continue;
    }
    if (t.kind === "param" || op(t, "?")) {
      out.push({ ...t, kind: "placeholder", text: "?" });
      continue;
    }
    if ((op(t, ":") || op(t, "@")) && (n?.kind === "word" || n?.kind === "ident") && adjacent(t, n) && !op(out[out.length - 1], ":")) {
      out.push({ kind: "placeholder", text: "?", pos: t.pos, end: n.end });
      i++;
      continue;
    }
    if (op(t, "%") && adjacent(t, n)) {
      if (n?.kind === "word" && n.text === "s") {
        out.push({ kind: "placeholder", text: "?", pos: t.pos, end: n.end });
        i++;
        continue;
      }
      const s = raw[i + 4];
      if (op(n, "(") && raw[i + 3] && op(raw[i + 3], ")") && s?.kind === "word" && s.text === "s" && adjacent(raw[i + 3], s)) {
        out.push({ kind: "placeholder", text: "?", pos: t.pos, end: s.end });
        i += 4;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

const AGGREGATES = new Set(["sum", "count", "avg", "min", "max"]);
const SET_OPS = new Set(["union", "intersect", "except"]);
const CLAUSES = new Set(["from", "where", "group", "having", "window", "qualify", "order", "limit", "offset", "fetch", "into", "returning"]);
const JOIN_START = new Set(["join", "left", "right", "full", "inner", "cross", "natural"]);
const ALIAS_STOP = new Set([
  ...CLAUSES, ...SET_OPS, ...JOIN_START, "on", "using", "as", "outer", "lateral", "tablesample", "select", "and", "or", "not", "with", "values", "set", "for", "is", "in",
]);
// Words that are never a column in an expression.
const NOT_COLUMN = new Set([
  "case", "when", "then", "else", "end", "and", "or", "not", "null", "true", "false", "distinct", "as", "is", "in", "like", "ilike", "between", "exists",
  "interval", "date", "timestamp", "timestamptz", "time", "cast", "over", "filter", "partition", "by", "order", "asc", "desc", "nulls", "first", "last",
  "current_date", "current_timestamp", "current_time", "localtimestamp", "localtime", "current_user", "session_user", "any", "all", "some", "similar",
  "escape", "at", "zone", "within", "group", "rows", "range", "preceding", "following", "unbounded", "current", "row", "select", "from", "where", "array",
]);
const TYPED_LITERAL = new Set(["date", "timestamp", "timestamptz", "time", "interval"]);
const GRAIN_UNITS = new Set(["year", "quarter", "month", "week", "day", "hour", "minute"]);

interface Binding {
  alias: string | null;
  // The bare table name, which also qualifies a column when the table has no alias.
  bare: string | null;
  hit?: TableHit;
  // A CTE or subquery: the select blocks that make its rows.
  derived?: Block[];
  // A table function or a derived table whose columns cannot be told.
  opaque?: boolean;
}

interface Block {
  start: number;
  end: number;
  depth: number;
  parent: Block | null;
  bindings: Binding[];
  clauses: Map<string, [number, number]>;
  conditions: CondFact[];
  // Conditions of an outer join's ON clause: they hold for the joined table only, never for the
  // block's rows, so no aggregate keeps them.
  outerConditions: CondFact[];
  // ON and USING clauses, read once every block's FROM items are known.
  later: (() => void)[];
  outputs?: Map<string, ColRef | null> | null;
}

interface Resolved extends ColRef {
  binding: Binding;
}

class Reader {
  readonly match: Int32Array;
  readonly depth: Int32Array;
  readonly blocks: Block[] = [];
  readonly ctes = new Map<string, number>();
  readonly facts: StatementFacts = { status: "read", tables: new Map(), joins: [], aggregates: [], conditions: [], groupBy: [] };
  private joinKeys = new Set<string>();
  templatedTable = false;

  constructor(
    readonly t: Tok[],
    readonly catalog: Catalog,
  ) {
    this.match = new Int32Array(t.length).fill(-1);
    this.depth = new Int32Array(t.length);
    const stack: number[] = [];
    t.forEach((tok, i) => {
      if (this.isOp(i, "(")) {
        this.depth[i] = stack.length;
        stack.push(i);
      } else if (this.isOp(i, ")")) {
        const open = stack.pop();
        if (open === undefined) fail();
        this.depth[i] = stack.length;
        this.match[open!] = i;
        this.match[i] = open!;
      } else this.depth[i] = stack.length;
      void tok;
    });
    if (stack.length) fail();
  }

  isOp(i: number, text: string): boolean {
    const x = this.t[i];
    return x?.kind === "op" && x.text === text;
  }
  isWord(i: number, ...words: string[]): boolean {
    const x = this.t[i];
    return x?.kind === "word" && words.includes(x.text);
  }
  isName(i: number): boolean {
    const x = this.t[i];
    return x?.kind === "ident" || (x?.kind === "word" && !NOT_COLUMN.has(x.text) && !CLAUSES.has(x.text) && !SET_OPS.has(x.text));
  }
  // Whether the paren at i opens a query: (select ...), (with ...), ((select ...)).
  isSubquery(i: number): boolean {
    if (!this.isOp(i, "(")) return false;
    return this.isWord(i + 1, "select", "with", "values") || (this.isOp(i + 1, "(") && this.isSubquery(i + 1));
  }

  read(): StatementFacts {
    this.findCtes();
    this.t.forEach((_, i) => {
      if (this.isWord(i, "select")) this.blocks.push(this.block(i));
    });
    if (!this.blocks.length) return { ...this.facts, status: "no_table" };
    for (const b of this.blocks) b.parent = this.blocks.filter((p) => p !== b && p.start < b.start && b.start < p.end && p.depth < b.depth).at(-1) ?? null;
    for (const b of this.blocks) this.readFrom(b);
    for (const b of this.blocks) for (const f of b.later) f();
    for (const b of this.blocks) this.readConditions(b);
    for (const b of this.blocks) {
      this.readAggregates(b);
      this.readGroupBy(b);
    }
    for (const b of this.blocks) for (const x of b.bindings) if (x.hit) this.facts.tables.set(x.hit.name, x.hit.kind);
    this.facts.conditions = this.blocks.flatMap((b) => [...b.conditions, ...b.outerConditions]);
    if (!this.facts.tables.size) this.facts.status = this.templatedTable ? "not_understood" : "no_table";
    return this.facts;
  }

  findCtes(): void {
    for (let i = 0; i < this.t.length; i++) {
      if (!this.isWord(i, "with")) continue;
      let j = i + 1;
      if (this.isWord(j, "recursive")) j++;
      for (;;) {
        if (!this.isName(j)) break;
        const name = this.t[j]!.text.toLowerCase();
        j++;
        if (this.isOp(j, "(") && !this.isSubquery(j)) j = this.match[j]! + 1;
        if (!this.isWord(j, "as")) break;
        j++;
        if (this.isWord(j, "not")) j++;
        if (this.isWord(j, "materialized")) j++;
        if (!this.isSubquery(j)) break;
        this.ctes.set(name, j);
        j = this.match[j]! + 1;
        if (!this.isOp(j, ",")) break;
        j++;
      }
    }
  }

  block(start: number): Block {
    const d = this.depth[start]!;
    let end = start + 1;
    for (; end < this.t.length; end++) {
      if (this.depth[end]! < d) break;
      if (this.depth[end] === d && (this.isWord(end, ...SET_OPS) || this.t[end]!.kind === "semicolon")) break;
    }
    const clauses = new Map<string, [number, number]>();
    const marks: [string, number][] = [["select", start + 1]];
    for (let i = start + 1; i < end; i++) {
      if (this.depth[i] !== d || this.t[i]!.kind !== "word") continue;
      const w = this.t[i]!.text;
      if (!CLAUSES.has(w)) continue;
      if (w === "from" && this.isWord(i - 1, "distinct")) continue;
      if ((w === "group" || w === "order") && !this.isWord(i + 1, "by")) continue;
      marks.push([w, w === "group" || w === "order" ? i + 2 : i + 1]);
    }
    marks.forEach(([w, from], k) => {
      const next = marks[k + 1];
      const to = next ? next[1] - (next[0] === "group" || next[0] === "order" ? 2 : 1) : end;
      if (!clauses.has(w)) clauses.set(w, [from, to]);
    });
    return { start, end, depth: d, parent: null, bindings: [], clauses, conditions: [], outerConditions: [], later: [] };
  }

  // The select blocks a paren holds at its own level: a subquery's, or a CTE body's union arms.
  bodyBlocks(open: number): Block[] {
    const close = this.match[open]!;
    const d = this.depth[open]! + 1;
    return this.blocks.filter((b) => b.start > open && b.start < close && b.depth === d);
  }

  // --- FROM ------------------------------------------------------------------------------------

  readFrom(b: Block): void {
    const r = b.clauses.get("from");
    if (r) this.fromItems(b, r[0], r[1], b.depth);
  }

  fromItems(b: Block, a: number, z: number, d: number): void {
    let i = a;
    let outer = false;
    while (i < z) {
      if (this.isOp(i, ",")) {
        i++;
        continue;
      }
      if (this.isWord(i, ...JOIN_START)) {
        outer = false;
        while (i < z && this.isWord(i, "natural", "left", "right", "full", "inner", "cross", "outer")) {
          if (this.isWord(i, "left", "right", "full", "outer")) outer = true;
          i++;
        }
        if (!this.isWord(i, "join")) fail();
        i++;
        continue;
      }
      if (this.isWord(i, "on")) {
        let j = i + 1;
        while (j < z && !(this.depth[j] === d && (this.isOp(j, ",") || this.isWord(j, ...JOIN_START)))) j++;
        const [s, e, o] = [i + 1, j, outer];
        b.later.push(() => this.onClause(b, s, e, o));
        i = j;
        continue;
      }
      if (this.isWord(i, "using")) {
        if (!this.isOp(i + 1, "(")) fail();
        const [s, e, right, left] = [i + 2, this.match[i + 1]!, b.bindings.at(-1), b.bindings.slice(0, -1)];
        b.later.push(() => this.using(right, left, s, e));
        i = this.match[i + 1]! + 1;
        continue;
      }
      i = this.item(b, i, z);
    }
  }

  item(b: Block, i: number, z: number): number {
    while (this.isWord(i, "lateral", "only")) i++;
    let binding: Binding;
    let j: number;
    if (this.isOp(i, "(")) {
      j = this.match[i]! + 1;
      if (this.isSubquery(i)) binding = { alias: null, bare: null, derived: this.bodyBlocks(i) };
      else {
        this.fromItems(b, i + 1, j - 1, this.depth[i]! + 1);
        return j;
      }
    } else if (this.isName(i) || this.t[i]?.kind === "ident") {
      const parts: string[] = [this.t[i]!.text.toLowerCase()];
      j = i + 1;
      while (this.isOp(j, ".") && (this.isName(j + 1) || this.t[j + 1]?.kind === "word")) {
        parts.push(this.t[j + 1]!.text.toLowerCase());
        j += 2;
      }
      if (this.isOp(j, "(")) {
        j = this.match[j]! + 1;
        binding = { alias: null, bare: null, opaque: true };
      } else if (parts.length === 1 && this.ctes.has(parts[0]!)) {
        binding = { alias: null, bare: parts[0]!, derived: this.bodyBlocks(this.ctes.get(parts[0]!)!) };
      } else {
        const hit = this.catalog.resolve(parts);
        binding = { alias: null, bare: parts[parts.length - 1]!, hit };
      }
    } else if (this.t[i]?.kind === "placeholder") {
      // A Jinja expression where a table belongs ({{ this }}, {{ var('t') }}): a table that cannot be told.
      this.templatedTable = true;
      j = i + 1;
      binding = { alias: null, bare: null, opaque: true };
    } else return fail();
    if (j > z) fail();
    if (this.isWord(j, "as")) j++;
    const a = this.t[j];
    if (a && j < z && (a.kind === "ident" || (a.kind === "word" && !ALIAS_STOP.has(a.text) && !NOT_COLUMN.has(a.text)))) {
      binding.alias = a.text.toLowerCase();
      j++;
      if (this.isOp(j, "(")) {
        j = this.match[j]! + 1;
        if (binding.derived) binding = { ...binding, derived: undefined, opaque: true };
      }
    }
    if (this.isWord(j, "tablesample")) fail();
    b.bindings.push(binding);
    return j;
  }

  using(right: Binding | undefined, left: Binding[], a: number, z: number): void {
    if (!right) return;
    for (let i = a; i < z; i++) {
      if (this.isOp(i, ",")) continue;
      const col = this.t[i]!.text.toLowerCase();
      const r = this.through(right, col);
      const ls = left.map((x) => [x, this.through(x, col)] as const).filter(([x, c]) => c !== null || this.opaqueTo(x, col));
      if (r && ls.length === 1 && ls[0]![1]) this.addJoin([{ ...ls[0]![1]!, binding: ls[0]![0] }], [{ ...r, binding: right }]);
    }
  }

  // --- Columns ---------------------------------------------------------------------------------

  // The kept table and column a binding's column comes from, or null.
  through(x: Binding, col: string, seen = new Set<Block>()): ColRef | null {
    if (x.hit) {
      const name = x.hit.columns?.get(col);
      return x.hit.kind === "kept" && name ? { table: x.hit.name, column: name } : null;
    }
    if (x.derived) {
      for (const blk of x.derived) {
        const out = this.outputs(blk, seen);
        if (out?.has(col)) return out.get(col) ?? null;
      }
    }
    return null;
  }

  // Whether a binding may hold a column of that name without it being known.
  opaqueTo(x: Binding, col: string): boolean {
    if (x.opaque) return true;
    if (x.hit) return !x.hit.columns;
    if (x.derived) return x.derived.some((blk) => this.outputs(blk) === null || (this.outputs(blk)!.has(col) && this.outputs(blk)!.get(col) === null));
    return true;
  }

  // Whether a binding is known to hold a column of that name.
  holds(x: Binding, col: string): boolean {
    if (x.hit) return !!x.hit.columns?.has(col);
    if (x.derived) return x.derived.some((blk) => !!this.outputs(blk)?.has(col));
    return false;
  }

  // A select block's output columns by name: each traced to a kept table's column, or null when it
  // is computed. Null for the whole block when a * reaches something whose columns cannot be told.
  outputs(b: Block, seen = new Set<Block>()): Map<string, ColRef | null> | null {
    if (b.outputs !== undefined) return b.outputs;
    if (seen.has(b)) return null;
    seen.add(b);
    const out = new Map<string, ColRef | null>();
    const r = b.clauses.get("select")!;
    for (const [a, z] of this.split(r[0], r[1], b.depth, ",")) {
      let s = a;
      if (this.isWord(s, "distinct", "all")) s++;
      if (this.isOp(s, "*") && z === s + 1) {
        for (const x of b.bindings) if (!this.star(x, out, seen)) return (b.outputs = null);
        continue;
      }
      if (z === s + 3 && this.isName(s) && this.isOp(s + 1, ".") && this.isOp(s + 2, "*")) {
        const x = b.bindings.find((y) => y.alias === this.t[s]!.text.toLowerCase() || (!y.alias && y.bare === this.t[s]!.text.toLowerCase()));
        if (!x || !this.star(x, out, seen)) return (b.outputs = null);
        continue;
      }
      const { expr, alias } = this.aliasOf(s, z);
      const ref = this.colRefAt(expr[0], expr[1]);
      const name = alias ?? (ref ? ref.parts[ref.parts.length - 1]! : null);
      if (!name) continue;
      out.set(name, ref ? this.resolveRef(b, ref.parts, seen) : null);
    }
    return (b.outputs = out);
  }

  star(x: Binding, out: Map<string, ColRef | null>, seen: Set<Block>): boolean {
    if (x.hit?.columns) {
      for (const [lower, name] of x.hit.columns) out.set(lower, x.hit.kind === "kept" ? { table: x.hit.name, column: name } : null);
      return true;
    }
    if (x.derived) {
      for (const blk of x.derived) {
        const o = this.outputs(blk, seen);
        if (!o) return false;
        for (const [k, v] of o) out.set(k, v);
      }
      return true;
    }
    return false;
  }

  // An item's expression and its alias: `expr as name`, or `expr name` after more than a bare name.
  aliasOf(a: number, z: number): { expr: [number, number]; alias: string | null } {
    const last = this.t[z - 1];
    if (z - a >= 3 && this.isWord(z - 2, "as") && (last?.kind === "ident" || last?.kind === "word")) return { expr: [a, z - 2], alias: last.text.toLowerCase() };
    if (z - a >= 2 && (last?.kind === "ident" || (last?.kind === "word" && !NOT_COLUMN.has(last.text))) && !this.isOp(z - 2, ".") && !this.isOp(z - 2, "::"))
      return { expr: [a, z - 1], alias: last!.text.toLowerCase() };
    return { expr: [a, z], alias: null };
  }

  // A dotted column reference filling exactly [a, z), or null.
  colRefAt(a: number, z: number): { parts: string[] } | null {
    const r = this.colRef(a);
    return r && r.next === z ? { parts: r.parts } : null;
  }

  colRef(i: number): { parts: string[]; next: number } | null {
    if (!this.isName(i)) return null;
    const parts = [this.t[i]!.text.toLowerCase()];
    let j = i + 1;
    while (this.isOp(j, ".") && (this.t[j + 1]?.kind === "word" || this.t[j + 1]?.kind === "ident")) {
      parts.push(this.t[j + 1]!.text.toLowerCase());
      j += 2;
    }
    if (this.isOp(j, "(") || this.isOp(j, ".")) return null;
    if (this.t[i]!.kind === "word" && parts.length === 1 && TYPED_LITERAL.has(parts[0]!) && this.t[j]?.kind === "string") return null;
    return { parts, next: j };
  }

  // The binding and kept column a reference names in a block, looking outward for a correlated one.
  resolve(b: Block | null, parts: string[], seen = new Set<Block>()): Resolved | null {
    for (let blk = b; blk; blk = blk.parent) {
      const col = parts[parts.length - 1]!;
      if (parts.length >= 2) {
        const q = parts[parts.length - 2]!;
        const x = blk.bindings.find((y) => y.alias === q) ?? blk.bindings.find((y) => !y.alias && y.bare === q);
        if (!x) continue;
        const c = this.through(x, col, seen);
        return c ? { ...c, binding: x } : null;
      }
      const holders = blk.bindings.filter((x) => this.holds(x, col));
      if (blk.bindings.some((x) => !this.holds(x, col) && this.opaqueTo(x, col))) return null;
      if (holders.length > 1) return null;
      if (holders.length === 1) {
        const c = this.through(holders[0]!, col, seen);
        return c ? { ...c, binding: holders[0]! } : null;
      }
    }
    return null;
  }

  resolveRef(b: Block, parts: string[], seen?: Set<Block>): ColRef | null {
    const r = this.resolve(b, parts, seen);
    return r ? { table: r.table, column: r.column } : null;
  }

  // --- Expressions -----------------------------------------------------------------------------

  // [a, z) split at `sep` (a comma, or the word and/or) on level d.
  split(a: number, z: number, d: number, sep: string): [number, number][] {
    const out: [number, number][] = [];
    let s = a;
    let between = 0;
    for (let i = a; i < z; i++) {
      if (this.depth[i] !== d) continue;
      if (sep === "and" && this.isWord(i, "between")) between++;
      const hit = sep === "," ? this.isOp(i, ",") : this.isWord(i, sep);
      if (!hit) continue;
      if (sep === "and" && between > 0) {
        between--;
        continue;
      }
      out.push([s, i]);
      s = i + 1;
    }
    if (s < z) out.push([s, z]);
    return out;
  }

  literal(i: number): { lit: Lit; next: number } | null {
    const x = this.t[i];
    if (!x) return null;
    let lit: Lit | null = null;
    let next = i + 1;
    if (x.kind === "string") lit = { kind: "string", text: x.text };
    else if (x.kind === "number") lit = { kind: "number", text: x.text };
    else if (x.kind === "placeholder") lit = { kind: "placeholder", text: "?" };
    else if (this.isOp(i, "-") && this.t[i + 1]?.kind === "number") {
      lit = { kind: "number", text: `-${this.t[i + 1]!.text}` };
      next = i + 2;
    } else if (this.isWord(i, "true", "false")) lit = { kind: "bool", text: x.text };
    else if (this.isWord(i, "null")) lit = { kind: "null", text: "null" };
    else if (x.kind === "word" && TYPED_LITERAL.has(x.text) && this.t[i + 1]?.kind === "string") {
      lit = { kind: "string", text: this.t[i + 1]!.text };
      next = i + 2;
    }
    if (!lit) return null;
    if (this.isOp(next, "::") && this.t[next + 1]?.kind === "word") next += 2;
    return { lit, next };
  }

  // The column side of a comparison: a reference, bare or in one function call with literals
  // beside it (lower(email), coalesce(x, 0)), or cast (x::date, cast(x as date)).
  operand(b: Block, a: number, z: number): { ref: Resolved; fn?: string } | null | "unknown" {
    let e = z;
    if (this.isOp(e - 2, "::") && this.t[e - 1]?.kind === "word") e -= 2;
    const plain = this.colRefAt(a, e);
    if (plain) {
      const res = this.resolve(b, plain.parts);
      return res ? { ref: res } : "unknown";
    }
    if (this.t[a]?.kind === "word" && this.isOp(a + 1, "(") && this.match[a + 1] === e - 1) {
      const fn = this.t[a]!.text;
      if (fn === "cast") {
        const asAt = this.split(a + 2, e - 1, this.depth[a + 1]! + 1, "as");
        const ref = asAt.length === 2 ? this.colRefAt(asAt[0]![0], asAt[0]![1]) : null;
        const res = ref ? this.resolve(b, ref.parts) : null;
        return !ref ? null : res ? { ref: res } : "unknown";
      }
      let ref: { parts: string[] } | null = null;
      for (const [s, t] of this.split(a + 2, e - 1, this.depth[a + 1]! + 1, ",")) {
        const r = this.colRefAt(s, t);
        if (r) {
          if (ref) return null;
          ref = r;
        } else if (!this.literalAt(s, t)) return null;
      }
      if (!ref) return null;
      const res = this.resolve(b, ref.parts);
      return res ? { ref: res, fn } : "unknown";
    }
    return null;
  }

  literalAt(a: number, z: number): Lit | null {
    const l = this.literal(a);
    return l && l.next === z ? l.lit : null;
  }

  // The values side of a comparison: literals, a column, a subquery, or any other expression.
  values(b: Block, a: number, z: number): { lits: Lit[] } | { col: Resolved | "unknown" } {
    const one = this.literalAt(a, z);
    if (one) return { lits: [one] };
    const ref = this.colRefAt(a, z);
    if (ref) return { col: this.resolve(b, ref.parts) ?? "unknown" };
    if (this.isSubquery(a) && this.match[a] === z - 1) return { lits: [{ kind: "subquery", text: "<subquery>" }] };
    return { lits: [{ kind: "expression", text: "<expression>" }] };
  }

  // One condition: column, operator and values, or a join equality. Null when it cannot be placed.
  condition(b: Block, a: number, z: number): { cond?: CondFact; join?: [Resolved, Resolved] } | null {
    if (this.isWord(a, "not")) {
      const r = this.colRefAt(a + 1, z);
      const res = r ? this.resolve(b, r.parts) : null;
      return res ? { cond: { table: res.table, column: res.column, op: "=", values: [{ kind: "bool", text: "false" }] } } : null;
    }
    const bare = this.colRefAt(a, z);
    if (bare) {
      const res = this.resolve(b, bare.parts);
      return res ? { cond: { table: res.table, column: res.column, op: "=", values: [{ kind: "bool", text: "true" }] } } : null;
    }
    // The operator at level d: the first comparison, is, in, like, ilike or between.
    const d = this.depth[a]!;
    let k = a;
    for (; k < z; k++) {
      if (this.depth[k] !== d) continue;
      const x = this.t[k]!;
      if (x.kind === "op" && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(x.text)) break;
      if (this.isWord(k, "is", "in", "like", "ilike", "between", "not") && k > a) break;
    }
    if (k >= z) return null;
    let left = this.operand(b, a, k);
    let op = this.t[k]!.text;
    let r = k + 1;
    if (op === "not") {
      if (!this.isWord(k + 1, "in", "like", "ilike", "between")) return null;
      op = `not ${this.t[k + 1]!.text}`;
      r = k + 2;
    }
    if (op === "!=") op = "<>";
    if (op === "is") {
      let w = "is";
      if (this.isWord(r, "not")) {
        w = "is not";
        r++;
      }
      if (!this.isWord(r, "null", "true", "false") || r + 1 !== z) return null;
      if (left === null || left === "unknown") return null;
      const v = this.t[r]!.text;
      if (v === "null") return { cond: this.cond(left, `${w} null`, []) };
      return { cond: this.cond(left, "=", [{ kind: "bool", text: (w === "is") === (v === "true") ? "true" : "false" }]) };
    }
    if (op === "in" || op === "not in") {
      if (left === null || left === "unknown" || !this.isOp(r, "(") || this.match[r] !== z - 1) return null;
      if (this.isSubquery(r)) return { cond: this.cond(left, op, [{ kind: "subquery", text: "<subquery>" }]) };
      const lits: Lit[] = [];
      for (const [s, t] of this.split(r + 1, z - 1, d + 1, ",")) lits.push(this.literalAt(s, t) ?? { kind: "expression", text: "<expression>" });
      return { cond: this.cond(left, op, lits) };
    }
    if (op === "between" || op === "not between") {
      const parts = this.split(r, z, d, "and");
      if (left === null || left === "unknown") return null;
      const lits = parts.length === 2 ? parts.map(([s, t]) => this.literalAt(s, t) ?? { kind: "expression" as const, text: "<expression>" }) : [{ kind: "expression" as const, text: "<expression>" }];
      return { cond: this.cond(left, op, lits) };
    }
    const right = this.values(b, r, z);
    if (left === null) {
      // A literal on the left: 'completed' = status.
      const lit = this.literalAt(a, k);
      if (!lit || !("col" in right) || right.col === "unknown") return null;
      const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
      return { cond: this.cond({ ref: right.col }, flip[op] ?? op, [lit]) };
    }
    if (left === "unknown") return null;
    if ("col" in right) {
      if (right.col === "unknown") return null;
      if (op === "=" && !left.fn && right.col.binding !== left.ref.binding) return { join: [left.ref, right.col] };
      return { cond: this.cond(left, op, [{ kind: "expression", text: "<expression>" }]) };
    }
    return { cond: this.cond(left, op, right.lits) };
  }

  cond(left: { ref: Resolved; fn?: string }, op: string, values: Lit[]): CondFact {
    return { table: left.ref.table, column: left.ref.column, ...(left.fn ? { fn: left.fn } : {}), op, values };
  }

  // Every condition of [a, z): its conjuncts, a parenthesised group read inside, and a disjunction
  // of = and in on one column read as one in.
  conditions(b: Block, a: number, z: number, out: CondFact[], joins: [Resolved, Resolved][]): void {
    const d = this.depth[a] ?? b.depth;
    for (const [s, e] of this.split(a, z, d, "and")) {
      if (this.isOp(s, "(") && this.match[s] === e - 1 && !this.isSubquery(s)) {
        const ors = this.split(s + 1, e - 1, d + 1, "or");
        if (ors.length === 1) this.conditions(b, s + 1, e - 1, out, joins);
        else this.disjunction(b, ors, out);
        continue;
      }
      const ors = this.split(s, e, d, "or");
      if (ors.length > 1) {
        this.disjunction(b, ors, out);
        continue;
      }
      const c = this.condition(b, s, e);
      if (c?.cond) out.push(c.cond);
      if (c?.join) joins.push(c.join);
    }
  }

  disjunction(b: Block, ors: [number, number][], out: CondFact[]): void {
    const parts = ors.map(([s, e]) => this.condition(b, s, e)?.cond);
    const first = parts[0];
    if (!first || parts.some((p) => !p || p.table !== first.table || p.column !== first.column || p.fn !== first.fn || (p.op !== "=" && p.op !== "in"))) return;
    out.push({ ...first, op: "in", values: parts.flatMap((p) => p!.values) });
  }

  onClause(b: Block, a: number, z: number, outer: boolean): void {
    const joins: [Resolved, Resolved][] = [];
    this.conditions(b, a, z, outer ? b.outerConditions : b.conditions, joins);
    this.joinPairs(joins);
  }

  readConditions(b: Block): void {
    const r = b.clauses.get("where");
    if (!r) return;
    const joins: [Resolved, Resolved][] = [];
    this.conditions(b, r[0], r[1], b.conditions, joins);
    this.joinPairs(joins);
  }

  joinPairs(pairs: [Resolved, Resolved][]): void {
    // Equalities between the same two bindings make one join with several keys.
    const groups = new Map<string, { l: Resolved[]; r: Resolved[] }>();
    const ids = new Map<Binding, number>();
    const id = (x: Binding) => ids.get(x) ?? (ids.set(x, ids.size), ids.size - 1);
    for (const [l, r] of pairs) {
      const [x, y] = id(l.binding) < id(r.binding) ? [l, r] : [r, l];
      const k = `${id(x.binding)}:${id(y.binding)}`;
      const g = groups.get(k) ?? { l: [], r: [] };
      g.l.push(x);
      g.r.push(y);
      groups.set(k, g);
    }
    for (const g of groups.values()) this.addJoin(g.l, g.r);
  }

  addJoin(l: Resolved[], r: Resolved[]): void {
    const swap = l[0]!.table > r[0]!.table;
    const [a, b] = swap ? [r, l] : [l, r];
    const keys = a.map((x, i) => [x.column, b[i]!.column] as [string, string]).sort((p, q) => (p.join() < q.join() ? -1 : 1));
    const k = JSON.stringify([a[0]!.table, b[0]!.table, keys]);
    if (this.joinKeys.has(k)) return;
    this.joinKeys.add(k);
    this.facts.joins.push({ a: a[0]!.table, b: b[0]!.table, keys });
  }

  // The conditions that hold for a block's rows: its own, and those of the blocks its FROM reads.
  rowConditions(b: Block, seen = new Set<Block>()): CondFact[] {
    if (seen.has(b)) return [];
    seen.add(b);
    return [...b.conditions, ...b.bindings.flatMap((x) => (x.derived ?? []).flatMap((blk) => this.rowConditions(blk, seen)))];
  }

  // --- Aggregates and GROUP BY -----------------------------------------------------------------

  readAggregates(b: Block): void {
    // The select list only: a HAVING or ORDER BY aggregate tests or sorts groups, it is not what is summed.
    const r = b.clauses.get("select");
    if (!r) return;
    for (let i = r[0]; i < r[1]; i++) {
      if (this.isSubquery(i)) {
        i = this.match[i]!;
        continue;
      }
      if (!this.isWord(i, ...AGGREGATES) || !this.isOp(i + 1, "(")) continue;
      this.aggregate(b, i);
    }
  }

  aggregate(b: Block, i: number): void {
    const open = i + 1;
    const close = this.match[open]!;
    // A window aggregate (sum(...) over (...)) sums no group: it is not a statement that sums.
    const filtered = this.isWord(close + 1, "filter") && this.isOp(close + 2, "(");
    if (this.isWord(filtered ? this.match[close + 2]! + 1 : close + 1, "over")) return;
    let fn = this.t[i]!.text as AggFact["fn"];
    let a = open + 1;
    if (this.isWord(a, "distinct")) {
      if (fn === "count") fn = "count_distinct";
      a++;
    }
    const own: CondFact[] = [];
    let expr: { text: string; tables: Set<string> } | null;
    if (this.isOp(a, "*") && a + 1 === close) expr = { text: "*", tables: new Set() };
    else if (this.isWord(a, "case") && this.isWord(a + 1, "when") && this.isWord(close - 1, "end")) {
      const d = this.depth[a]!;
      const at = (w: string) => {
        for (let k = a + 2; k < close; k++) if (this.depth[k] === d && this.isWord(k, w)) return k;
        return -1;
      };
      const then = at("then");
      const els = at("else");
      const thenEnd = els > 0 ? els : close - 1;
      // One WHEN only: a CASE with several branches is not one rule.
      if (then < 0 || at("when") >= 0) return;
      if (els > 0 && !this.literalAt(els + 1, close - 1)) return;
      const joins: [Resolved, Resolved][] = [];
      this.conditions(b, a + 2, then, own, joins);
      expr = this.exprText(b, then + 1, thenEnd);
    } else expr = this.exprText(b, a, close);
    if (!expr) return;
    if (this.isWord(close + 1, "filter") && this.isOp(close + 2, "(") && this.isWord(close + 3, "where")) {
      const joins: [Resolved, Resolved][] = [];
      this.conditions(b, close + 4, this.match[close + 2]!, own, joins);
    }
    let table: string | undefined;
    if (expr.text === "*") {
      const kept = b.bindings.length === 1 ? b.bindings[0]! : undefined;
      table = kept?.hit?.kind === "kept" ? kept.hit.name : undefined;
    } else if (expr.tables.size === 1) table = [...expr.tables][0];
    if (!table || expr.text.length > 80) return;
    this.facts.aggregates.push({ table, fn, expr: expr.text, conditions: [...own, ...this.rowConditions(b)] });
  }

  // An expression as text with its columns bare and its literals as ?, and the kept tables it reads;
  // null when a column in it cannot be placed.
  exprText(b: Block, a: number, z: number): { text: string; tables: Set<string> } | null {
    const words: string[] = [];
    const tables = new Set<string>();
    for (let i = a; i < z; ) {
      const x = this.t[i]!;
      if (this.isSubquery(i)) return null;
      if (this.isOp(i, "::") && this.t[i + 1]?.kind === "word") {
        words.push(`::${this.t[i + 1]!.text}`);
        i += 2;
        continue;
      }
      if (this.isWord(i, "as") && this.t[i + 1]?.kind === "word") {
        words.push(`as ${this.t[i + 1]!.text}`);
        i += 2;
        continue;
      }
      const lit = this.literal(i);
      if (lit) {
        words.push("?");
        i = lit.next;
        continue;
      }
      const ref = this.colRef(i);
      if (ref) {
        const res = this.resolve(b, ref.parts);
        if (!res) return null;
        tables.add(res.table);
        words.push(res.column);
        i = ref.next;
        continue;
      }
      words.push(x.kind === "ident" ? `"${x.text}"` : x.text);
      i++;
    }
    const text = words.join(" ").replace(/ ?\( ?/g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").replace(/ (::)/g, "$1");
    return text ? { text, tables } : null;
  }

  readGroupBy(b: Block): void {
    const r = b.clauses.get("group");
    if (!r) return;
    const select = b.clauses.get("select")!;
    const items = this.split(select[0], select[1], b.depth, ",").map(([s, e]) => this.aliasOf(this.isWord(s, "distinct") ? s + 1 : s, e));
    for (const [s, e] of this.split(r[0], r[1], b.depth, ",")) {
      let range: [number, number] = [s, e];
      if (e === s + 1 && this.t[s]!.kind === "number") {
        const item = items[Number(this.t[s]!.text) - 1];
        if (!item) continue;
        range = item.expr;
      } else if (e === s + 1 && this.isName(s)) {
        const name = this.t[s]!.text.toLowerCase();
        const item = items.find((x) => x.alias === name);
        if (!this.resolve(b, [name]) && item) range = item.expr;
      }
      const g = this.grouping(b, range[0], range[1]);
      if (g) this.facts.groupBy.push(g);
    }
  }

  // A grouping column, with its time grain when it is truncated or cast to a date.
  grouping(b: Block, a: number, z: number): GroupFact | null {
    const ref = (s: number, e: number) => {
      const r = this.colRefAt(s, e);
      return r ? this.resolve(b, r.parts) : null;
    };
    const plain = ref(a, z);
    if (plain) return { table: plain.table, column: plain.column };
    if (this.isOp(z - 2, "::") && this.isWord(z - 1, "date")) {
      const g = this.grouping(b, a, z - 2);
      return g ? { ...g, grain: g.grain ?? "day" } : null;
    }
    if (this.t[a]?.kind !== "word" || !this.isOp(a + 1, "(") || this.match[a + 1] !== z - 1) return null;
    const fn = this.t[a]!.text;
    const args = this.split(a + 2, z - 1, this.depth[a + 1]! + 1, ",");
    if ((fn === "date_trunc" || fn === "date_part") && args.length === 2) {
      const unit = this.t[args[0]![0]];
      const r = ref(args[1]![0], args[1]![1]);
      const grain = unit?.kind === "string" ? unit.text.toLowerCase() : "";
      return r && GRAIN_UNITS.has(grain) ? { table: r.table, column: r.column, grain } : null;
    }
    if (fn === "date" && args.length === 1) {
      const r = ref(args[0]![0], args[0]![1]);
      return r ? { table: r.table, column: r.column, grain: "day" } : null;
    }
    if (fn === "cast") {
      const parts = this.split(a + 2, z - 1, this.depth[a + 1]! + 1, "as");
      const r = parts.length === 2 && this.isWord(parts[1]![0], "date") ? ref(parts[0]![0], parts[0]![1]) : null;
      return r ? { table: r.table, column: r.column, grain: "day" } : null;
    }
    if (fn === "extract" && this.t[a + 2]?.kind === "word" && this.isWord(a + 3, "from")) {
      const grain = this.t[a + 2]!.text;
      const r = ref(a + 4, z - 1);
      return r && GRAIN_UNITS.has(grain) ? { table: r.table, column: r.column, grain } : null;
    }
    return null;
  }
}

// Jinja's {# comments #} and {% statements %}, which hold no SQL of their own.
function stripJinjaBlocks(text: string): string {
  return text.includes("{") ? text.replace(/\{#[\s\S]*?#\}/g, " ").replace(/\{%[\s\S]*?%\}/g, " ") : text;
}

// What one statement reads. `sql` is one statement's text; comments in it are never read.
export function readStatement(sql: string, catalog: Catalog): StatementFacts {
  let raw: Token[];
  try {
    raw = tokenize(stripJinjaBlocks(sql));
  } catch {
    return NOT_UNDERSTOOD;
  }
  const toks = normalize(raw.filter((t) => t.kind !== "semicolon"));
  if (!toks) return NOT_UNDERSTOOD;
  if (!toks.length) return { ...NOT_UNDERSTOOD, status: "empty" };
  try {
    return new Reader(toks, catalog).read();
  } catch (e) {
    if (e instanceof Unplaceable) return NOT_UNDERSTOOD;
    throw e;
  }
}

// The statements of a .sql file's text, split at semicolons outside strings ('..' with '' and, after
// E, backslash escapes), quoted identifiers, $tag$ dollar quotes and comments (-- to the end of the
// line, nested /* */). psql's backslash commands (\connect, \set ...) end at the line's end and are
// dropped, as are Jinja's {% %} and {# #} blocks. Statements holding nothing but white space and
// comments are kept out by the caller (they tokenize to nothing).
export function splitStatements(text: string): string[] {
  const src = stripJinjaBlocks(text);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = src.length;
  let lineStart = true;
  while (i < n) {
    const c = src[i]!;
    if (lineStart && c === "\\") {
      const nl = src.indexOf("\n", i);
      out.push(src.slice(start, i));
      i = nl < 0 ? n : nl + 1;
      start = i;
      continue;
    }
    lineStart = c === "\n" || (lineStart && (c === " " || c === "\t" || c === "\r"));
    if (c === "-" && src[i + 1] === "-") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl;
    } else if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") (depth++, (i += 2));
        else if (src[i] === "*" && src[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(src[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(src[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escapes && src[i] === "\\") i += 2;
        else if (src[i] === c && src[i + 1] === c) i += 2;
        else if (src[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
      } else i++;
    } else if (c === ";") {
      out.push(src.slice(start, i));
      i++;
      start = i;
    } else i++;
  }
  out.push(src.slice(start));
  return out;
}

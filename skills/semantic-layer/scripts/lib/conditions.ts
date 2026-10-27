// Conditions over user attributes, used by a role's assign_when and a restriction's allow.when.
// The language is deliberately small and contains no SQL:
//
//   condition := or
//   or        := and ("or" and)*
//   and       := unary ("and" unary)*
//   unary     := "not" unary | "(" condition ")" | test
//   test      := attr ("==" | "!=" | "<" | "<=" | ">" | ">=") literal
//              | attr "in" list | attr "not" "in" list
//              | attr "contains" literal
//              | attr "is" "set" | attr "is" "not" "set"
//   attr      := "user." name
//   literal   := 'text' | number | true | false
//   list      := "[" literal ("," literal)* "]"
//
// A test on an attribute the user lacks, or of the wrong type, is false, so a grant fails closed;
// write "user.x is set" to test presence. "in" on a list attribute is true when any element is in
// the list; "contains" needs a list attribute.
import { UserError } from "./errors.ts";

export type Literal = string | number | boolean;

export type Condition =
  | { kind: "and" | "or"; parts: Condition[] }
  | { kind: "not"; part: Condition }
  | { kind: "cmp"; attr: string; op: "==" | "!=" | "<" | "<=" | ">" | ">="; value: Literal }
  | { kind: "in"; attr: string; values: Literal[]; negate: boolean }
  | { kind: "contains"; attr: string; value: Literal }
  | { kind: "set"; attr: string; negate: boolean };

type Token = { t: "word" | "str" | "num" | "op" | "punct"; v: string; at: number };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else v += src[j++];
      }
      if (j >= src.length) throw new Error(`unterminated string at ${i + 1}`);
      out.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    const num = src.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num && (c !== "-" || !out.length || out[out.length - 1]!.t === "op" || out[out.length - 1]!.v === "[" || out[out.length - 1]!.v === ",")) {
      out.push({ t: "num", v: num[0], at: i });
      i += num[0].length;
      continue;
    }
    const op = src.slice(i).match(/^(==|!=|<=|>=|<|>)/);
    if (op) {
      out.push({ t: "op", v: op[0], at: i });
      i += op[0].length;
      continue;
    }
    if ("()[],".includes(c)) {
      out.push({ t: "punct", v: c, at: i });
      i++;
      continue;
    }
    const word = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/);
    if (word) {
      out.push({ t: "word", v: word[0], at: i });
      i += word[0].length;
      continue;
    }
    throw new Error(`unexpected "${c}" at ${i + 1}`);
  }
  return out;
}

const ATTR = /^user\.([a-z][a-z0-9_]*)$/;

class Parser {
  i = 0;
  constructor(readonly toks: Token[]) {}
  peek(): Token | undefined {
    return this.toks[this.i];
  }
  word(v: string): boolean {
    const t = this.peek();
    if (t?.t === "word" && t.v.toLowerCase() === v) {
      this.i++;
      return true;
    }
    return false;
  }
  punct(v: string): boolean {
    const t = this.peek();
    if (t?.t === "punct" && t.v === v) {
      this.i++;
      return true;
    }
    return false;
  }
  fail(msg: string): never {
    const t = this.peek();
    throw new Error(t ? `${msg} at ${t.at + 1} ("${t.v}")` : `${msg} at the end`);
  }
  or(): Condition {
    const parts = [this.and()];
    while (this.word("or")) parts.push(this.and());
    return parts.length === 1 ? parts[0]! : { kind: "or", parts };
  }
  and(): Condition {
    const parts = [this.unary()];
    while (this.word("and")) parts.push(this.unary());
    return parts.length === 1 ? parts[0]! : { kind: "and", parts };
  }
  unary(): Condition {
    if (this.word("not")) return { kind: "not", part: this.unary() };
    if (this.punct("(")) {
      const c = this.or();
      if (!this.punct(")")) this.fail('expected ")"');
      return c;
    }
    return this.test();
  }
  literal(): Literal {
    const t = this.peek();
    if (!t) this.fail("expected a value");
    if (t.t === "str") {
      this.i++;
      return t.v;
    }
    if (t.t === "num") {
      this.i++;
      return Number(t.v);
    }
    if (t.t === "word" && (t.v === "true" || t.v === "false")) {
      this.i++;
      return t.v === "true";
    }
    this.fail("expected a quoted text, a number, true or false");
  }
  list(): Literal[] {
    if (!this.punct("[")) this.fail('expected "["');
    const values = [this.literal()];
    while (this.punct(",")) values.push(this.literal());
    if (!this.punct("]")) this.fail('expected "]"');
    return values;
  }
  test(): Condition {
    const t = this.peek();
    const m = t?.t === "word" ? t.v.match(ATTR) : null;
    if (!m) this.fail("expected user.<attribute>");
    this.i++;
    const attr = m[1]!;
    const op = this.peek();
    if (op?.t === "op") {
      this.i++;
      return { kind: "cmp", attr, op: op.v as "==", value: this.literal() };
    }
    if (this.word("in")) return { kind: "in", attr, values: this.list(), negate: false };
    if (this.word("not")) {
      if (!this.word("in")) this.fail('expected "in" after "not"');
      return { kind: "in", attr, values: this.list(), negate: true };
    }
    if (this.word("contains")) return { kind: "contains", attr, value: this.literal() };
    if (this.word("is")) {
      const negate = this.word("not");
      if (!this.word("set")) this.fail('expected "set"');
      return { kind: "set", attr, negate };
    }
    this.fail("expected a comparison, in, not in, contains or is set");
  }
}

export function parseCondition(src: string): Condition {
  let toks: Token[];
  try {
    toks = tokenize(src);
    if (!toks.length) throw new Error("empty condition");
    const p = new Parser(toks);
    const c = p.or();
    if (p.peek()) p.fail("unexpected text");
    return c;
  } catch (e) {
    throw new UserError(`Invalid condition "${src}": ${(e as Error).message}`);
  }
}

// The attribute names a condition reads.
export function conditionAttributes(c: Condition): string[] {
  const out = new Set<string>();
  const walk = (x: Condition) => {
    switch (x.kind) {
      case "and":
      case "or":
        x.parts.forEach(walk);
        break;
      case "not":
        walk(x.part);
        break;
      default:
        out.add(x.attr);
    }
  };
  walk(c);
  return [...out].sort();
}

function compare(a: unknown, op: string, b: Literal): boolean {
  if (typeof a !== typeof b) return false;
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return (a as number) < (b as number);
    case "<=":
      return (a as number) <= (b as number);
    case ">":
      return (a as number) > (b as number);
    case ">=":
      return (a as number) >= (b as number);
  }
  return false;
}

const present = (v: unknown) => v !== undefined && v !== null;

export function evaluateCondition(c: Condition, user: Record<string, unknown>): boolean {
  switch (c.kind) {
    case "and":
      return c.parts.every((p) => evaluateCondition(p, user));
    case "or":
      return c.parts.some((p) => evaluateCondition(p, user));
    case "not":
      return !evaluateCondition(c.part, user);
    case "set":
      return present(user[c.attr]) !== c.negate;
    case "cmp": {
      const v = user[c.attr];
      return present(v) && !Array.isArray(v) && compare(v, c.op, c.value);
    }
    case "in": {
      const v = user[c.attr];
      if (!present(v)) return false;
      const items = Array.isArray(v) ? v : [v];
      const hit = items.some((x) => c.values.some((y) => x === y));
      return c.negate ? !hit : hit;
    }
    case "contains": {
      const v = user[c.attr];
      return Array.isArray(v) && v.some((x) => x === c.value);
    }
  }
}

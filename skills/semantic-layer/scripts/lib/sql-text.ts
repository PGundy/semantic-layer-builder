// The shape of the SQL text a layer writes into compiled queries (references/spec.md, Expression
// text): a model's dimension and measure exprs and measure filters, a derived metric's expr and a
// row filter. Each stays one expression the compiler can wrap in parentheses and combine with the
// rest of the query, and only the compiler binds parameters, so a request's filter values never
// reach a field's text. sl validate and the compiler report the same problems.
import { type Token, tokenize } from "./sql-guard.ts";
import type { Dialect } from "./types.ts";

export type TextRole = "dimension expr" | "measure expr" | "measure filter" | "metric expr" | "row filter";

// Whether the tokenizer reads a dialect's strings, quoted names and comments as the dialect does:
// postgres and duckdb (other dialects escape quotes with a backslash or quote names with backticks).
// A source whose dialect is unknown is read as postgres.
export const readsText = (dialect: Dialect | undefined): boolean => dialect === undefined || dialect === "postgres" || dialect === "duckdb";

// A {{ user.<attribute> }} placeholder, which only a row filter binds.
export const USER_PLACEHOLDER = /\{\{\s*user\.([A-Za-z0-9_]+)\s*\}\}/g;

// The text with its strings, quoted names and comments blanked to spaces, read the way Postgres and
// DuckDB read them (sql-guard's tokenizer), so a placeholder or a parenthesis found in it is one the
// SQL reads, at the same place as in the text. Undefined when a string, name or comment is unclosed.
export function codeOnly(sql: string): { code: string; tokens: Token[] } | undefined {
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch {
    return undefined;
  }
  let code = "";
  for (const t of tokens) if (t.kind !== "string" && t.kind !== "ident") code += " ".repeat(t.pos - code.length) + sql.slice(t.pos, t.end);
  return { code: code + " ".repeat(sql.length - code.length), tokens };
}

// The text with its strings and quoted names cut out; its comments and whitespace stay.
function outsideStrings(text: string, tokens: Token[]): string {
  let out = "";
  let at = 0;
  for (const t of tokens)
    if (t.kind === "string" || t.kind === "ident") {
      out += text.slice(at, t.pos);
      at = t.end;
    }
  return out + text.slice(at);
}

// The hint naming the function that replaces the Postgres jsonb operator holding the ? at `pos`:
// @?, ?|, ?& or ? itself.
function jsonbHint(text: string, pos: number): string {
  if (text[pos - 1] === "@") return "; for Postgres's jsonb @? operator, write jsonb_path_exists(<column>, '<path>')";
  if (text[pos + 1] === "|") return "; for Postgres's jsonb ?| operator, write jsonb_exists_any(<column>, <keys>)";
  if (text[pos + 1] === "&") return "; for Postgres's jsonb ?& operator, write jsonb_exists_all(<column>, <keys>)";
  return "; for Postgres's jsonb ? operator, write jsonb_exists(<column>, '<key>')";
}

// Why a text cannot go into a compiled query, or undefined. It closes every string, quoted name,
// comment and parenthesis it opens, and holds no parameter marker ($1, ?, $name), semicolon or
// carriage return outside a string. A row
// filter reads the user's values through {{ user.<attribute> }} placeholders, each written apart from
// a name or a digit so it binds as one parameter; any other text holds no {{ outside strings and
// comments (a lone }} closes nested DuckDB struct literals).
export function sqlTextProblem(text: string, role: TextRole): string | undefined {
  const rowFilter = role === "row filter";
  const read = codeOnly(text);
  if (!read) return "has an unclosed string, quoted name or comment";
  // Other readers of a layer's SQL (sql-names, the compiler's qualifier) end a -- comment at a line
  // feed only, so a carriage return outside a string could make them read the text differently.
  if (outsideStrings(text, read.tokens).includes("\r")) return "has a carriage return outside a string; break its lines with a line feed only";
  let depth = 0;
  for (const t of read.tokens) {
    if (t.kind === "param" || (t.kind === "op" && (t.text === "?" || t.text === "$"))) {
      const marker = t.text === "$" ? /^\$[A-Za-z0-9_]*/.exec(text.slice(t.pos))![0] : t.text;
      if (rowFilter)
        return `has the query parameter marker ${marker}; a row filter reads the user's values through {{ user.<attribute> }} only, and only the compiler binds parameters`;
      return `has the query parameter marker ${marker}; a ${role} takes no values from outside, and only the compiler binds parameters${marker === "?" ? jsonbHint(text, t.pos) : ""}`;
    }
    if (t.kind === "semicolon") return `has a semicolon; a ${role} is one SQL ${role.endsWith("filter") ? "predicate" : "expression"}`;
    if (t.kind === "op" && t.text === "(") depth++;
    if (t.kind === "op" && t.text === ")" && --depth < 0) return `closes a parenthesis it never opened; a ${role} must balance its parentheses`;
  }
  if (depth) return `leaves a parenthesis open; a ${role} must balance its parentheses`;
  if (!rowFilter) {
    if (read.code.includes("{{"))
      return `has a {{ }} placeholder; a ${role} takes no values from outside, and only a row filter in access.yaml reads {{ user.<attribute> }}`;
    return undefined;
  }
  // A placeholder against a name or a digit would bind as part of it: {{ user.x }}1 reads $11.
  const word = /[A-Za-z0-9_$]/;
  for (const m of read.code.matchAll(USER_PLACEHOLDER)) {
    const end = m.index! + m[0].length;
    if (word.test(read.code[m.index! - 1] ?? "") || word.test(read.code[end] ?? ""))
      return `writes ${m[0]} against a name or a number; put a space or an operator between them, so it binds as one parameter`;
  }
  return undefined;
}

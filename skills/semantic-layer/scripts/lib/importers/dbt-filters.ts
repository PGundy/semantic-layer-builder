// Turns a dbt filter template into column SQL for a measure filter, or refuses it with a reason.
// The manifest is untrusted text and the result becomes SQL in a draft measure's filter, so this is a
// small hand-written parser of exactly one form, and nothing it did not read is ever copied:
//
//   {{ Dimension('model__dimension') }} <test> [and <test> ...]
//
// where a test is one of  = != <> < <= > >= literal | [not] in (literal, ...) | is [not] null |
// [not] like 'pattern'. A literal is a single-quoted string (only '' escapes a quote), an integer or
// decimal number, true or false; null is only written as is null. Keywords are case-insensitive;
// Dimension and its name are not. Anything else (or, parentheses, functions, casts, arithmetic,
// comments, semicolons, backslashes, TimeDimension, Entity, Metric, .grain(), {% %}, an unknown
// dimension) returns { skipped }.
// One template string is taken, since dbt 1.6 wrote one and later versions write a list of
// them that mean AND: the caller translates each and joins the results.
// Column SQL comes from `columns` as given; it must pass the dimension-expression text check (so it
// cannot unbalance the parentheses that wrap it) and is wrapped in them unless it is a plain name.
// A reason names the problem, not a next command; the caller adds that.
import { sqlTextProblem } from "../sql-text.ts";

export type DbtFilterResult = { sql: string } | { skipped: string };

const MAX_LENGTH = 10_000;
const SYMBOLS = ["<=", ">=", "<>", "!=", "=", "<", ">"];
const NOT_NAMED = ["TimeDimension", "Entity", "Metric"];

class Stop extends Error {}

// Text safe to show in a reason: control characters and runs of whitespace collapse, and it is cut short.
const shorten = (t: string): string => [...t.slice(0, 120).replace(/[\p{C}\s]+/gu, " ").trim()].slice(0, 40).join("");

// Why the text at `at` cannot be read.
function unread(text: string, at: number): string {
  const rest = text.slice(at, at + 120);
  const shown = `"${shorten(rest)}"`;
  if (!rest.trim()) return "the filter ends before it is complete";
  if (/^or\b/i.test(rest)) return `or is not supported, only and (at ${shown})`;
  if (rest[0] === "(") return `parentheses for grouping are not supported (at ${shown})`;
  if (rest.startsWith("--") || rest.startsWith("/*")) return `comments are not supported (at ${shown})`;
  if (rest[0] === ";") return `a semicolon is not supported (at ${shown})`;
  if (rest[0] === "\\") return `a backslash is not supported (at ${shown})`;
  if (rest[0] === "$") return `a dollar sign (dollar-quoted string or parameter) is not supported (at ${shown})`;
  if (/^e'/i.test(rest)) return `an E'' string is not supported (at ${shown})`;
  if (rest.startsWith("{%")) return `a {% %} block is not supported (at ${shown})`;
  if (rest.startsWith("{{")) return `nested or repeated braces are not supported (at ${shown})`;
  for (const name of NOT_NAMED) if (rest.startsWith(name)) return `${name}(...) is not supported, only Dimension(...) (at ${shown})`;
  return `cannot read ${shown}`;
}

const plainName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

function parse(text: string, columns: Record<string, string>): string {
  let i = 0;
  const n = text.length;
  const fail = (reason?: string): never => {
    throw new Stop(reason ?? unread(text, i));
  };
  const ws = (): void => {
    while (i < n && " \t\n\r".includes(text[i]!)) i++;
  };
  const word = (w: string): boolean => {
    if (text.slice(i, i + w.length).toLowerCase() !== w || /\w/.test(text[i + w.length] ?? "")) return false;
    i += w.length;
    return true;
  };
  const expect = (s: string): void => {
    if (!text.startsWith(s, i)) fail();
    i += s.length;
  };

  const dimension = (): string => {
    expect("{{");
    ws();
    if (!text.startsWith("Dimension", i)) fail();
    i += "Dimension".length;
    ws();
    expect("(");
    ws();
    const q = text[i];
    if (q !== "'" && q !== '"') fail();
    const end = text.indexOf(q!, i + 1);
    if (end < 0) fail("a dimension name has no closing quote");
    const name = text.slice(i + 1, end);
    if (!/^[A-Za-z0-9_]+$/.test(name)) fail(`the dimension name "${shorten(name)}" holds a character other than letters, digits and underscores`);
    i = end + 1;
    ws();
    if (text[i] === ",") fail("Dimension(...) with extra arguments is not supported");
    expect(")");
    ws();
    if (text[i] === ".") fail("a .grain(...) or other call on Dimension is not supported");
    expect("}}");
    if (!Object.hasOwn(columns, name)) fail(`the dimension "${shorten(name)}" is not a column of the layer`);
    const sql = columns[name]!;
    const bad = sqlTextProblem(sql, "dimension expr");
    if (bad) fail(`the column SQL of dimension "${shorten(name)}" ${bad}`);
    return plainName.test(sql) ? sql : `(${sql})`;
  };

  const string = (): string => {
    i++;
    const out: string[] = [];
    while (i < n) {
      const c = text[i]!;
      if (c === "'") {
        if (text[i + 1] === "'") {
          out.push("'");
          i += 2;
          continue;
        }
        i++;
        return quote(out.join(""));
      }
      if (c === "\\") fail("a backslash in a string is not supported");
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c)) fail("a line break or control character in a string is not supported");
      out.push(c);
      i++;
    }
    return fail("a string has no closing quote");
  };

  const literal = (): string => {
    ws();
    let out: string;
    if (text[i] === "'") out = string();
    else if (/[-0-9]/.test(text[i] ?? "")) {
      const m = /-?\d+(\.\d+)?/y;
      m.lastIndex = i;
      const num = m.exec(text);
      if (!num) return fail();
      out = num[0];
      i += out.length;
    } else if (word("true")) out = "true";
    else if (word("false")) out = "false";
    else if (word("null")) return fail("null is only supported as is null or is not null");
    else return fail();
    if (/[\w.']/.test(text[i] ?? "")) fail();
    return out;
  };

  const test = (): string => {
    ws();
    const column = dimension();
    ws();
    if (i >= n) fail("a dimension needs a comparison such as = true or is null");
    for (const sym of SYMBOLS)
      if (text.startsWith(sym, i)) {
        i += sym.length;
        return `${column} ${sym} ${literal()}`;
      }
    if (word("is")) {
      ws();
      const not = word("not");
      ws();
      if (!word("null")) fail();
      return `${column} is ${not ? "not " : ""}null`;
    }
    const not = word("not");
    if (not) ws();
    if (word("like")) {
      ws();
      if (text[i] !== "'") fail("like takes a quoted string pattern");
      return `${column} ${not ? "not " : ""}like ${literal()}`;
    }
    if (!word("in")) return fail();
    ws();
    expect("(");
    const items = [literal()];
    for (ws(); text[i] === ","; ws()) {
      i++;
      items.push(literal());
    }
    expect(")");
    return `${column} ${not ? "not " : ""}in (${items.join(", ")})`;
  };

  const terms = [test()];
  for (ws(); i < n; ws()) {
    if (!word("and")) fail();
    terms.push(test());
  }
  return terms.join(" and ");
}

export function translateDbtFilter(text: string, columns: Record<string, string>): DbtFilterResult {
  if (!text.trim()) return { skipped: "the filter is empty" };
  if (text.length > MAX_LENGTH) return { skipped: `the filter is longer than ${MAX_LENGTH} characters` };
  let sql: string;
  try {
    sql = parse(text, columns);
  } catch (e) {
    if (e instanceof Stop) return { skipped: e.message };
    throw e;
  }
  const problem = sqlTextProblem(sql, "measure filter");
  return problem ? { skipped: `the translated filter ${problem}` } : { sql };
}

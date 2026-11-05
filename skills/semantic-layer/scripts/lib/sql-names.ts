// Names an SQL expression refers to, read outside string literals, comments and {{ }} placeholders.
// sl validate, sl approve's content hashes, profiling and the access checks share this reading.
import type { Dialect } from "./types.ts";

export type SqlToken =
  | { t: "id"; v: string; quoted: boolean }
  | { t: "." }
  | { t: "(" }
  | { t: ")" }
  | { t: "," }
  | { t: ":" }
  | { t: "->" }
  | { t: "/" }
  | { t: "num" }
  | { t: "sign" }
  | { t: "x" };

// Where a string literal starting at sql[i] (its opening quote) ends, just past the closing quote.
// A doubled quote stays inside it; with backslash escapes, so does a backslash-escaped character.
function stringEnd(sql: string, i: number, backslash: boolean): number {
  const q = sql[i]!;
  for (i++; i < sql.length; i++) {
    if (backslash && sql[i] === "\\") {
      i++;
      continue;
    }
    if (sql[i] !== q) continue;
    if (sql[i + 1] === q) i++;
    else break;
  }
  return i + 1;
}

export function tokenizeSql(sql: string, dialect?: Dialect): SqlToken[] {
  // Snowflake, BigQuery and Databricks read backslash escapes in every string literal; BigQuery and
  // Databricks also read "..." as a string, and quote identifiers with backticks.
  const backslash = dialect === "snowflake" || dialect === "bigquery" || dialect === "databricks";
  const doubleIsString = dialect === "bigquery" || dialect === "databricks";
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || (c === '"' && doubleIsString)) {
      i = stringEnd(sql, i, backslash);
      out.push({ t: "x" });
    } else if ((c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      // An escape string, E'it\'s': a backslash escapes the next character.
      i = stringEnd(sql, i + 1, true);
      out.push({ t: "x" });
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "-" && next === ">") {
      i += 2;
      out.push({ t: "->" });
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out.push({ t: "x" });
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out.push({ t: "x" });
    } else if (c === '"' || c === "`") {
      let v = "";
      for (i++; i < sql.length; i++) {
        if (sql[i] === c) {
          if (sql[i + 1] !== c) break;
          i++;
        }
        v += sql[i];
      }
      i++;
      // A backtick name may hold a whole dotted path, such as `project.dataset.table`.
      const parts = c === "`" ? v.split(".") : [v];
      parts.forEach((part, pi) => {
        if (pi) out.push({ t: "." });
        out.push({ t: "id", v: part, quoted: true });
      });
    } else if (/\d/.test(c) || (c === "." && /\d/.test(next))) {
      i += sql.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)![0].length;
      out.push({ t: "num" });
    } else if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)![0];
      i += word.length;
      out.push({ t: "id", v: word, quoted: false });
    } else if (c === ":" && next === ":") {
      // A cast: the type name that follows is not a column.
      i += 2;
      out.push({ t: ":" });
    } else if (c === "." || c === "(" || c === ")" || c === "," || c === ":" || c === "/") {
      i++;
      out.push({ t: c });
    } else if (c === "+" || c === "-") {
      i++;
      out.push({ t: "sign" });
    } else {
      i++;
      out.push({ t: "x" });
    }
  }
  return out;
}

export interface SqlNames {
  subquery: boolean;
  // Dotted names that read as column references: not function calls, cast types, semi-structured
  // paths or fields of a lambda parameter. quoted[k] says whether parts[k] was a quoted identifier.
  chains: { parts: string[]; quoted: boolean[]; text: string }[];
}

// Names a lambda binds: x in `x -> ...`, a and b in `(a, b) -> ...` and x in DuckDB's `lambda x: ...`.
// A lambda is a function argument, so a lone x binds only after ( or a comma; Postgres's JSON
// operator, as in `customer.payload -> 'k'`, binds nothing.
function lambdaParams(tokens: SqlToken[]): Set<string> {
  const bound = new Set<string>();
  const add = (tok: SqlToken | undefined) => {
    if (tok?.t === "id") bound.add(tok.v.toLowerCase());
  };
  tokens.forEach((tok, i) => {
    if (tok.t === "->") {
      const prev = tokens[i - 1];
      const before = tokens[i - 2]?.t;
      if (prev?.t === "id" && (before === "(" || before === ",")) add(prev);
      else if (prev?.t === ")") {
        for (let j = i - 2; j >= 0 && tokens[j]!.t !== "("; j--) add(tokens[j]);
      }
    } else if (tok.t === "id" && !tok.quoted && tok.v.toLowerCase() === "lambda") {
      for (let j = i + 1; j < tokens.length && tokens[j]!.t !== ":"; j++) {
        const t = tokens[j]!;
        if (t.t === "id") add(t);
        else if (t.t !== ",") break;
      }
    }
  });
  return bound;
}

export function sqlNames(sql: string, dialect?: Dialect): SqlNames {
  const tokens = tokenizeSql(sql, dialect);
  const bound = lambdaParams(tokens);
  const names: SqlNames = { subquery: false, chains: [] };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.t !== "id") continue;
    const prev = tokens[i - 1];
    const parts = [tok.v];
    const quoted = [tok.quoted];
    let j = i;
    while (tokens[j + 1]?.t === "." && tokens[j + 2]?.t === "id") {
      const part = tokens[j + 2] as { v: string; quoted: boolean };
      parts.push(part.v);
      quoted.push(part.quoted);
      j += 2;
    }
    const call = tokens[j + 1]?.t === "(";
    i = j;
    if (parts.length === 1) {
      if (tok.quoted) continue;
      const word = tok.v.toLowerCase();
      // select, or a FROM-first (DuckDB) or TABLE (Postgres) query opening a parenthesis. trim(from x) is a call.
      const opensQuery = prev?.t === "(" && !(word === "from" && (tokens[i - 2] as { v?: string } | undefined)?.v?.toLowerCase() === "trim");
      if (word === "select" || (opensQuery && (word === "from" || word === "table"))) names.subquery = true;
      continue;
    }
    if (call || prev?.t === ":" || prev?.t === ".") continue;
    if (!quoted[0] && bound.has(parts[0]!.toLowerCase())) continue;
    names.chains.push({ parts, quoted, text: parts.join(".") });
  }
  return names;
}

// Single names that read as columns: not part of a dotted name, not function calls, cast types or
// lambda parameters. SQL keywords come back too; a caller keeps the ones that are columns.
export function bareNames(sql: string, dialect?: Dialect): { v: string; quoted: boolean }[] {
  const tokens = tokenizeSql(sql, dialect);
  const bound = lambdaParams(tokens);
  const out: { v: string; quoted: boolean }[] = [];
  tokens.forEach((tok, i) => {
    if (tok.t !== "id") return;
    const prev = tokens[i - 1]?.t;
    const next = tokens[i + 1]?.t;
    if (prev === "." || prev === ":" || next === "." || next === "(") return;
    if (!tok.quoted && bound.has(tok.v.toLowerCase())) return;
    out.push({ v: tok.v, quoted: tok.quoted });
  });
  return out;
}

// Whether the SQL divides by a numeric literal, as in amount_cents / 100.0, / (100), / -100 or
// / 100::decimal(18, 2): on DuckDB each gives a DOUBLE. Integer division (//) does not count.
export function dividesByLiteral(sql: string, dialect?: Dialect): boolean {
  const tokens = tokenizeSql(sql, dialect);
  return tokens.some((tok, i) => {
    if (tok.t !== "/" || tokens[i - 1]?.t === "/" || tokens[i + 1]?.t === "/") return false;
    let j = i + 1;
    while (tokens[j]?.t === "(" || tokens[j]?.t === "sign") j++;
    return tokens[j]?.t === "num";
  });
}

// Whether the SQL calls round(), plain or qualified (pg_catalog.round(, x.round( in DuckDB),
// outside string literals and comments.
export function callsRound(sql: string, dialect?: Dialect): boolean {
  const tokens = tokenizeSql(sql, dialect);
  return tokens.some((tok, i) => tok.t === "id" && !tok.quoted && tok.v.toLowerCase() === "round" && tokens[i + 1]?.t === "(");
}

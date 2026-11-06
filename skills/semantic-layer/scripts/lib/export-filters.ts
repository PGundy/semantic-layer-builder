// Export filters (spec: Schema exports, Table filters): --include and --exclude patterns
// in the selection grammar (patterns.ts) turned into a predicate on a schema export query's
// table names, per dialect. A pattern is pushed into the SQL only when the SQL means exactly
// what the grammar means (for every name but the two kinds spec Table filters lists); any
// other is deferred to sl import (decision D4), so the export reads a wider set of table
// definitions and never a different one. Every pattern value is written as a SQL string
// literal, escaped for the dialect, never spliced in raw.
import type { OptionValues } from "./command.ts";
import { UserError } from "./errors.ts";
import { type GlobToken, parsePattern } from "./patterns.ts";

export type FilterDialect = "postgres" | "redshift" | "mysql" | "sqlserver" | "snowflake" | "bigquery" | "databricks" | "duckdb";

export interface PushedFilter {
  kind: "include" | "exclude";
  pattern: string;
  method: "in" | "like" | "regex";
}

export interface DeferredFilter {
  kind: "include" | "exclude";
  pattern: string;
  reason: string;
}

export interface TableFilter {
  pushed: PushedFilter[];
  deferred: DeferredFilter[];
}

interface DialectSql {
  // The catalog columns the marked filter line can read, and whether it opens a WHERE.
  schema: string;
  table: string;
  lead: "and" | "where";
  lit(value: string): string;
  concat(a: string, b: string): string;
  // Wraps a name so that = and LIKE compare it exactly, case and accents included.
  exact(expr: string): string;
  // Lowers a name for a case-insensitive comparison, where the dialect's lower() is exact
  // for ASCII letters; `traps` are the letters it also makes from a character outside
  // ASCII (the Kelvin sign gives k, İ gives i), which go another way.
  fold?: { sql: (expr: string) => string; traps: string };
  // = ignores trailing spaces (PAD SPACE collations), so exact names are compared by LIKE.
  pad?: true;
  // LIKE reads [..] as a class, so a case-insensitive letter is written as a class of its cases.
  likeClass?: true;
  // LIKE with the dialect's escape: the pattern is already escaped with `escape`.
  like(target: string, pattern: string): string;
  escape: string;
  likeSpecial: string;
  // A case-sensitive regex test (the pattern is anchored), or undefined when the dialect has
  // none the grammar can use.
  regex?: (target: string, re: string) => string;
  // Why a regex is deferred in this dialect.
  noRegex?: string;
  // Why a backslash in a name is deferred: a setting decides whether the dialect's string
  // literals read it as an escape.
  noBackslash?: string;
}

const quoteDoubled = (v: string) => `'${v.replaceAll("'", "''")}'`;
// Literals whose backslash is an escape character: the backslash is doubled as well.
const backslashed = (v: string) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const backslashedQuote = (v: string) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const pipes = (a: string, b: string) => `(${a} || '.' || ${b})`;
const bang = (target: string, pattern: string, lit: (v: string) => string) => `${target} like ${lit(pattern)} escape '!'`;

const DIALECTS: Record<FilterDialect, DialectSql> = {
  postgres: {
    schema: "n.nspname",
    table: "c.relname",
    lead: "and",
    // An E'' string reads the same whatever standard_conforming_strings says.
    lit: (v) => (v.includes("\\") ? `E${backslashed(v)}` : quoteDoubled(v)),
    concat: pipes,
    exact: (e) => e,
    // Under the C collation lower() changes A-Z only, whatever the database's locale.
    fold: { sql: (e) => `lower(${e} collate "C")`, traps: "" },
    like: (t, p) => bang(t, p, DIALECTS.postgres.lit),
    escape: "!",
    likeSpecial: "!%_",
    regex: (t, re) => `${t} ~ ${DIALECTS.postgres.lit(re)}`,
  },
  redshift: {
    schema: "n.nspname",
    table: "c.relname",
    lead: "and",
    lit: backslashed,
    concat: pipes,
    exact: (e) => e,
    like: (t, p) => bang(t, p, backslashed),
    escape: "!",
    likeSpecial: "!%_",
    regex: (t, re) => `${t} ~ ${backslashed(re)}`,
  },
  mysql: {
    schema: "c.table_schema",
    table: "c.table_name",
    lead: "and",
    lit: backslashed,
    concat: (a, b) => `concat(${a}, '.', ${b})`,
    exact: (e) => `convert(${e} using utf8mb4) collate utf8mb4_bin`,
    fold: { sql: (e) => `convert(lower(${e}) using utf8mb4) collate utf8mb4_bin`, traps: "ik" },
    pad: true,
    like: (t, p) => bang(t, p, backslashed),
    escape: "!",
    likeSpecial: "!%_",
    noRegex: "MySQL's REGEXP follows the name column's collation and differs between MySQL and MariaDB versions",
    noBackslash: "it has a backslash, which a MySQL string reads differently under the NO_BACKSLASH_ESCAPES SQL mode",
  },
  sqlserver: {
    schema: "s.name",
    table: "o.name",
    lead: "and",
    lit: (v) => `N${quoteDoubled(v)}`,
    concat: (a, b) => `concat(${a}, N'.', ${b})`,
    exact: (e) => `${e} collate Latin1_General_100_BIN2`,
    pad: true,
    likeClass: true,
    like: (t, p) => `${t} like N${quoteDoubled(p)} escape '!'`,
    escape: "!",
    likeSpecial: "!%_[",
    noRegex: "SQL Server has no regular expressions",
  },
  snowflake: {
    schema: "c.table_schema",
    table: "c.table_name",
    lead: "and",
    lit: backslashed,
    concat: pipes,
    exact: (e) => e,
    like: (t, p) => bang(t, p, backslashed),
    escape: "!",
    likeSpecial: "!%_",
    regex: (t, re) => `regexp_like(${t}, ${backslashed(re)})`,
  },
  bigquery: {
    schema: "c.table_schema",
    table: "c.table_name",
    lead: "where",
    lit: backslashedQuote,
    concat: pipes,
    exact: (e) => e,
    // BigQuery's LIKE takes no ESCAPE clause: a backslash escapes.
    like: (t, p) => `${t} like ${backslashedQuote(p)}`,
    escape: "\\",
    likeSpecial: "\\%_",
    regex: (t, re) => `regexp_contains(${t}, ${backslashedQuote(re)})`,
  },
  databricks: {
    schema: "c.table_schema",
    table: "c.table_name",
    lead: "and",
    lit: backslashedQuote,
    concat: pipes,
    exact: (e) => e,
    like: (t, p) => bang(t, p, backslashedQuote),
    escape: "!",
    likeSpecial: "!%_",
    regex: (t, re) => `${t} rlike ${backslashedQuote(re)}`,
    noBackslash: "it has a backslash, which a Databricks string reads differently when spark.sql.parser.escapedStringLiterals is on",
  },
  duckdb: {
    schema: "r.table_schema",
    table: "r.table_name",
    lead: "where",
    lit: quoteDoubled,
    concat: pipes,
    exact: (e) => e,
    fold: { sql: (e) => `lower(${e})`, traps: "ik" },
    like: (t, p) => bang(t, p, quoteDoubled),
    escape: "!",
    likeSpecial: "!%_",
    regex: (t, re) => `regexp_matches(${t}, ${quoteDoubled(re)})`,
  },
};

// ---- Patterns as regular expressions every dialect reads the same way ----

// A character outside a class, written so every flavour (POSIX ARE and ERE, RE2, Java)
// reads it literally: most metacharacters inside a one-character class, which needs no
// backslash in any of them.
function reChar(c: string): string | null {
  if (".*+?|(){}$".includes(c)) return `[${c}]`;
  return "^[]\\".includes(c) ? null : c;
}
const NO_LITERAL = 'a literal "[", "]", "\\" or "^"';

const ASCII_PRINTABLE = /^[\x20-\x7e]$/;
const CLASS_SAFE = /^[A-Za-z0-9 !"#%',./:;<=>@_`~$*+?(){}|]$/;

const isLetter = (c: string) => /^[A-Za-z]$/.test(c);
const swapCase = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

// The letters a class holds but not in their other case, written as compactly as the class
// allows (only letters, so no character in it is special).
function otherCases(items: string[]): string {
  const held = new Set<number>();
  for (const it of items) {
    if (it.length === 1) held.add(it.charCodeAt(0));
    else if (it.length === 3 && it[1] === "-") for (let v = it.charCodeAt(0); v <= it.charCodeAt(2); v++) held.add(v);
  }
  const add = [...held].map((v) => String.fromCharCode(v)).filter((c) => isLetter(c) && !held.has(swapCase(c).charCodeAt(0)));
  const codes = add.map(swapCase).map((c) => c.charCodeAt(0)).sort((a, b) => a - b);
  let out = "";
  for (let i = 0; i < codes.length; ) {
    let j = i;
    while (j + 1 < codes.length && codes[j + 1] === codes[j]! + 1) j++;
    const a = String.fromCharCode(codes[i]!);
    const b = String.fromCharCode(codes[j]!);
    out += j - i >= 2 ? `${a}-${b}` : codes.slice(i, j + 1).map((v) => String.fromCharCode(v)).join("");
    i = j + 1;
  }
  return out;
}

// Translates a re: body into a case-sensitive regex that means the same in every dialect
// with a regex operator as the grammar's case-insensitive JavaScript regex does, or names
// what it uses that one of them reads differently. Case is spelled out (k as [kK], a class
// with its letters' other cases added) rather than left to a flag, since the dialects' flags
// also fold characters outside ASCII (the Kelvin sign as k) and JavaScript's does not.
export function portableRegex(body: string): { re: string } | { problem: string } {
  let out = "";
  let i = 0;
  // What the last token was, to find an empty alternative such as (a|) or a||b.
  let last: "open" | "bar" | "atom" = "open";
  const atom = (s: string) => {
    out += s;
    last = "atom";
  };
  while (i < body.length) {
    const c = body[i]!;
    if (c === "\\") {
      const n = body[i + 1] ?? "";
      i += 2;
      const shorthand: Record<string, string> = { d: "[0-9]", D: "[^0-9]", w: "[A-Za-z0-9_]", W: "[^A-Za-z0-9_]" };
      if (shorthand[n]) atom(shorthand[n]!);
      else if (/^[!-/:-@[-`{-~]$/.test(n)) {
        const r = reChar(n);
        if (r === null) return { problem: NO_LITERAL };
        atom(r);
      } else return { problem: `the escape "\\${n}"` };
    } else if (c === "[") {
      let j = i + 1;
      const negated = body[j] === "^";
      if (negated) j++;
      if (body[j] === "]") return { problem: "a class that opens with ]" };
      const items: string[] = [];
      let dash = false;
      const member = (): string | { problem: string } | { set: string } => {
        if (body[j] === "\\") {
          const n = body[j + 1] ?? "";
          j += 2;
          if (n === "d") return { set: "0-9" };
          if (n === "w") return { set: "A-Za-z0-9_" };
          if (/^[!-/:-@[-`{-~]$/.test(n)) return n;
          return { problem: `the escape "\\${n}" in a class` };
        }
        return body[j++]!;
      };
      while (j < body.length && body[j] !== "]") {
        const a = member();
        if (typeof a !== "string") {
          if ("problem" in a) return a;
          if (body[j] === "-" && body[j + 1] !== "]") return { problem: "a range that starts at \\d or \\w" };
          items.push(a.set);
          continue;
        }
        let b: string | null = null;
        if (body[j] === "-" && j + 1 < body.length && body[j + 1] !== "]") {
          j++;
          const m = member();
          if (typeof m !== "string") return "problem" in m ? m : { problem: "a range that ends at \\d or \\w" };
          b = m;
        }
        for (const x of b === null ? [a] : [a, b]) {
          if (x === "-" && b === null) continue;
          if (!CLASS_SAFE.test(x)) return { problem: ASCII_PRINTABLE.test(x) ? `"${x}" in a class` : "a character outside ASCII" };
        }
        if (b !== null) items.push(`${a}-${b}`);
        else if (a === "-") dash = true;
        else items.push(a);
      }
      i = j + 1;
      atom(`[${negated ? "^" : ""}${items.join("")}${otherCases(items)}${dash ? "-" : ""}]`);
    } else if (c === "(") {
      if (body[i + 1] === "?") {
        if (body[i + 2] !== ":") return { problem: 'a "(?" group (a lookaround, a named group or flags)' };
        i += 3;
      } else i++;
      out += "(";
      last = "open";
    } else if (c === ")" || c === "|") {
      if (last !== "atom") return { problem: "an empty alternative" };
      out += c;
      i++;
      last = c === ")" ? "atom" : "bar";
    } else if ("*+?".includes(c)) {
      out += c;
      i++;
      if (body[i] === "?") i++;
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(body.slice(i));
      if (m) {
        if (Number(m[1]) > 255 || Number(m[3] || 0) > 255) return { problem: "a repeat count over 255" };
        out += m[0];
        i += m[0].length;
        if (body[i] === "?") i++;
      } else {
        atom(reChar(c)!);
        i++;
      }
    } else if (c === "^" || c === "$" || c === ".") {
      atom(c);
      i++;
    } else if (isLetter(c)) {
      atom(`[${c.toLowerCase()}${c.toUpperCase()}]`);
      i++;
    } else if (ASCII_PRINTABLE.test(c)) {
      const r = reChar(c);
      if (r === null) return { problem: NO_LITERAL };
      atom(r);
      i++;
    } else return { problem: "a character outside ASCII" };
  }
  if (last === "bar") return { problem: "an empty alternative" };
  return { re: out };
}

// ---- Compiling one pattern ----

type Compiled = { method: "in"; target: string; value: string } | { method: "like" | "regex"; sql: string } | { problem: string };

const cased = (c: string) => c.toLowerCase() !== c.toUpperCase();

// The characters a case-insensitive grammar letter matches (a regex with the i flag and no
// u flag, as patterns.ts compares), as a class. An ASCII letter matches its two cases only; a
// letter outside ASCII also matches its variant forms (σ matches ς and Σ, μ matches µ).
const classes = new Map<string, string>();
function letterClass(c: string): string {
  if (c.charCodeAt(0) < 128) return `[${c.toLowerCase()}${c.toUpperCase()}]`;
  let cls = classes.get(c);
  if (cls === undefined) {
    const same = new RegExp(`^[${c}]$`, "i");
    let all = "";
    for (let v = 128; v < 0x10000; v++) if (same.test(String.fromCharCode(v))) all += String.fromCharCode(v);
    classes.set(c, (cls = `[${all}]`));
  }
  return cls;
}

function compileGlob(d: DialectSql, name: string, tokens: GlobToken[], qualified: boolean): Compiled {
  const target = qualified ? d.concat(d.schema, d.table) : d.table;
  const lits = tokens.filter((t): t is GlobToken & { k: "lit" } => t.k === "lit");
  const loose = lits.filter((t) => !t.exact && cased(t.c));
  const strict = lits.some((t) => t.exact && cased(t.c));
  const wild = tokens.some((t) => t.k !== "lit");
  const foreign = loose.some((t) => !ASCII_PRINTABLE.test(t.c));
  const trap = loose.find((t) => d.fold?.traps.includes(t.c.toLowerCase()));
  // lower() serves only ASCII letters with no case-exact letter beside them and none it can
  // also make from a character outside ASCII; any other case-insensitive letter is a class.
  const folded = loose.length > 0 && d.fold && !strict && !foreign && !trap;
  if (loose.length && !folded) {
    const cls = (t: GlobToken) => (t.k === "lit" && !t.exact && cased(t.c) ? letterClass(t.c) : null);
    if (d.likeClass) {
      const pattern = tokens.map((t) => (t.k === "star" ? "%" : t.k === "one" ? "_" : (cls(t) ?? (d.likeSpecial.includes(t.c) ? `${d.escape}${t.c}` : t.c)))).join("");
      return { method: "like", sql: d.like(d.exact(target), pattern) };
    }
    if (!d.regex) {
      return {
        problem: strict
          ? `it mixes a quoted, case-exact part with a case-insensitive one, which one ${name} comparison cannot express`
          : foreign
            ? `it has a letter outside ASCII to match in any case, which ${name} folds by its collation`
            : `it has a case-insensitive "${trap!.c}", and ${name}'s lower() also makes ${trap!.c.toLowerCase() === "i" ? "i from İ" : "k from the Kelvin sign"}`,
      };
    }
    const parts = tokens.map((t) => (t.k === "star" ? ".*" : t.k === "one" ? "." : (cls(t) ?? reChar(t.c))));
    if (parts.includes(null)) return { problem: `it names ${NO_LITERAL}, which this export does not write into a regular expression` };
    return { method: "regex", sql: d.regex(target, `^(${parts.join("")})$`) };
  }
  const compared = folded ? d.fold!.sql(target) : d.exact(target);
  const text = (t: GlobToken & { k: "lit" }) => (folded && !t.exact ? t.c.toLowerCase() : t.c);
  if (!wild && !d.pad) return { method: "in", target: compared, value: lits.map(text).join("") };
  const pattern = tokens
    .map((t) => (t.k === "star" ? "%" : t.k === "one" ? "_" : d.likeSpecial.includes(text(t)) ? `${d.escape}${text(t)}` : text(t)))
    .join("");
  return { method: "like", sql: d.like(compared, pattern) };
}

// Refuses a pattern no filter can use: one that does not parse, or one holding a line break,
// which would end the SQL comment that lists it.
export function checkFilterPattern(pattern: string): void {
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(pattern)) {
    throw new UserError(`The pattern ${JSON.stringify(pattern)} holds a line break or control character; write it on one line and run the command again.`);
  }
  parsePattern(pattern);
}

function compile(dialect: FilterDialect, pattern: string): Compiled {
  const d = DIALECTS[dialect];
  checkFilterPattern(pattern);
  const p = parsePattern(pattern);
  if (p.kind === "glob") {
    if (d.noBackslash && p.tokens.some((t) => t.k === "lit" && t.c === "\\")) return { problem: d.noBackslash };
    return compileGlob(d, dialect, p.tokens, p.qualified);
  }
  if (!d.regex) return { problem: d.noRegex! };
  const r = portableRegex(p.source);
  if ("problem" in r) return { problem: `it uses ${r.problem}, which ${dialect}'s regular expressions do not read as JavaScript does` };
  return { method: "regex", sql: d.regex(p.qualified ? d.concat(d.schema, d.table) : d.table, `^(${r.re})$`) };
}

// ---- The filter for a query ----

// Repeated pattern flags; a value may hold several globs separated by commas, and a re:
// pattern is taken whole, as sl scope reads them.
export function patternFlags(values: OptionValues, key: string): string[] {
  const v = values[key];
  const raw = Array.isArray(v) ? (v as unknown[]).map(String) : typeof v === "string" ? [v] : [];
  const out = raw.flatMap((s) => (s.trim().startsWith("re:") ? [s] : s.split(","))).map((s) => s.trim()).filter(Boolean);
  out.forEach(checkFilterPattern);
  return [...new Set(out)];
}

export interface AppliedFilter extends TableFilter {
  sql: string;
}

const TABLE_FILTER_LINE = /^([ \t]*)-- sl:table-filter\b.*$/m;

// Writes the include and exclude patterns into a dialect's export query at its
// sl:table-filter line, and lists what was pushed and deferred in a header comment.
// `importCommand` is the sl import line the header names for deferred patterns.
export function applyTableFilter(dialect: FilterDialect, sql: string, include: string[], exclude: string[], importCommand: string): AppliedFilter {
  const pushed: PushedFilter[] = [];
  const deferred: DeferredFilter[] = [];
  const build = (kind: "include" | "exclude", patterns: string[]): string[] => {
    const compiled = patterns.map((pattern) => ({ pattern, c: compile(dialect, pattern) }));
    // Includes match together (any one keeps a table): one the SQL cannot express defers all.
    const blocked = kind === "include" && compiled.some((x) => "problem" in x.c);
    const conds: string[] = [];
    const lists = new Map<string, { at: number; values: string[] }>();
    for (const { pattern, c } of compiled) {
      if ("problem" in c || blocked) {
        const reason = "problem" in c ? c.problem : `another include cannot be expressed in ${dialect} SQL, and includes are applied together`;
        deferred.push({ kind, pattern, reason });
        continue;
      }
      pushed.push({ kind, pattern, method: c.method });
      if (c.method !== "in") conds.push(c.sql);
      else {
        const list = lists.get(c.target);
        if (list) list.values.push(c.value);
        else lists.set(c.target, { at: conds.push("") - 1, values: [c.value] });
      }
    }
    const lit = DIALECTS[dialect].lit;
    for (const [target, { at, values }] of lists) conds[at] = `${target} in (${[...new Set(values)].map(lit).join(", ")})`;
    return conds;
  };
  const inc = build("include", include);
  const exc = build("exclude", exclude);

  let out = sql;
  const m = TABLE_FILTER_LINE.exec(sql);
  if ((inc.length || exc.length) && !m) {
    throw new UserError(`references/exports/${dialect}.sql has lost its sl:table-filter line; restore the file and run sl export-sql again.`);
  }
  if (m && (inc.length || exc.length)) {
    const [line, indent] = m;
    let lead = DIALECTS[dialect].lead;
    const lines: string[] = [];
    for (const [conds, open, label] of [
      [inc, "(", "include"],
      [exc, "not (", "exclude"],
    ] as const) {
      if (!conds.length) continue;
      lines.push(`${indent}${lead} ${open}  -- sl:table-filter: ${label}`, ...conds.map((c, i) => `${indent}  ${i ? "or " : ""}${c}`), `${indent})`);
      lead = "and";
    }
    out = sql.replace(line, () => lines.join("\n"));
  }
  return { sql: insertHeader(out, filterHeader(dialect, pushed, deferred, importCommand)), pushed, deferred };
}

function filterHeader(dialect: FilterDialect, pushed: PushedFilter[], deferred: DeferredFilter[], importCommand: string): string[] {
  const lines = ["--", "-- Table filter (sl export-sql --include/--exclude). The query reads table definitions only, never table data."];
  if (pushed.length) {
    lines.push("-- In this query, at the lines marked sl:table-filter:");
    for (const p of pushed) lines.push(`--   ${p.kind} ${p.pattern}`);
  }
  if (deferred.length) {
    lines.push(`-- Left out of this query, so it reads more table definitions; sl import applies them (${dialect}):`);
    for (const p of deferred) lines.push(`--   ${p.kind} ${p.pattern}: ${p.reason}`);
    lines.push(`-- Import with: ${importCommand} ${importFlags(deferred)}`);
  }
  return lines;
}

// The header goes at the end of the query's opening comment block.
function insertHeader(sql: string, header: string[]): string {
  const lines = sql.split("\n");
  let at = lines.findIndex((l) => !l.startsWith("--"));
  if (at < 0) at = lines.length;
  while (at > 0 && lines[at - 1] === "--") at--;
  lines.splice(at, 0, ...header);
  return lines.join("\n");
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// The --include and --exclude flags that apply the deferred patterns on import.
export function importFlags(deferred: DeferredFilter[]): string {
  return deferred.map((d) => `--${d.kind} ${shellQuote(d.pattern)}`).join(" ");
}

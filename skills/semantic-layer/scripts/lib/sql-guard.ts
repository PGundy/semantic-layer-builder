import { UserError } from "./errors.ts";

// A fast, friendly first check on a query before it reaches a database. It is not what keeps a
// query read-only: the adapters do that by construction (lib/adapters/). This check gives a clear
// message for the common mistakes, and refuses calls that read the server's files or change the
// session, which a read-only transaction alone does not stop.

export type TokenKind = "word" | "ident" | "string" | "number" | "param" | "semicolon" | "op";

export interface Token {
  kind: TokenKind;
  // For a word, its text in lower case; for a quoted identifier or a string, its content; otherwise
  // the text as written.
  text: string;
  // Offsets of the token's first character and of the character after its last.
  pos: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function unterminated(what: string): never {
  throw new UserError(`The query has an unterminated ${what}.`);
}

// Splits SQL into tokens the way Postgres and DuckDB read it, dropping whitespace and comments:
// '..' strings with '' escapes, E'..' strings with backslash escapes, $tag$..$tag$ dollar quotes,
// ".." identifiers with "" escapes, -- line comments and nested /* */ block comments. Throws a
// UserError on an unterminated string, identifier or comment.
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  // A '..' string starting at the quote at `start`, with backslash escapes when `escapes` is set.
  const quoted = (start: number, escapes: boolean): number => {
    let j = start + 1;
    let value = "";
    for (;;) {
      if (j >= n) unterminated("string");
      const ch = sql[j]!;
      if (escapes && ch === "\\") {
        value += sql[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === "'") {
        if (sql[j + 1] === "'") {
          value += "'";
          j += 2;
          continue;
        }
        out.push({ kind: "string", text: value, pos: start, end: j + 1 });
        return j + 1;
      }
      value += ch;
      j++;
    }
  };
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      // Postgres and DuckDB end a -- comment at a line feed or a carriage return.
      const end = sql.slice(i).search(/[\n\r]/);
      i = end < 0 ? n : i + end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (depth > 0) {
        if (j >= n) unterminated("comment");
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      i = j;
      continue;
    }
    if (ch === "'") {
      i = quoted(i, false);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= n) unterminated("quoted identifier");
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j];
        j++;
      }
      out.push({ kind: "ident", text: value, pos: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) unterminated("dollar-quoted string");
        out.push({ kind: "string", text: sql.slice(i + tag[0].length, close), pos: i, end: close + tag[0].length });
        i = close + tag[0].length;
        continue;
      }
      const digits = /^\$\d+/.exec(sql.slice(i));
      if (digits) {
        out.push({ kind: "param", text: digits[0], pos: i, end: i + digits[0].length });
        i += digits[0].length;
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      if (sql[j] === "'" && lower === "e") {
        i = quoted(j, true);
        continue;
      }
      if (sql[j] === "'" && (lower === "b" || lower === "x" || lower === "n")) {
        i = quoted(j, false);
        continue;
      }
      if (lower === "u" && sql[j] === "&" && sql[j + 1] === "'") {
        i = quoted(j + 1, false);
        continue;
      }
      out.push({ kind: "word", text: lower, pos: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(sql.slice(i))!;
      out.push({ kind: "number", text: m[0], pos: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    out.push({ kind: ch === ";" ? "semicolon" : "op", text: ch, pos: i, end: i + 1 });
    i++;
  }
  return out;
}

// The statements of a token list, split at semicolons; empty statements are dropped.
export function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const t of tokens) {
    if (t.kind === "semicolon") out.push([]);
    else out[out.length - 1]!.push(t);
  }
  return out.filter((s) => s.length > 0);
}

const READ_START = new Set(["select", "with", "values", "table", "explain", "describe", "desc", "show", "summarize", "from"]);

// Words that start a statement that writes or changes the session. They are refused where a
// statement starts: the statement EXPLAIN explains, the body of a WITH entry (a data-modifying WITH)
// and the main statement after a WITH list. Elsewhere they are column names or aliases, such as
// `select id as comment` or `count(load)`.
const WRITE_WORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "create",
  "alter",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "attach",
  "detach",
  "install",
  "load",
  "vacuum",
  "call",
  "export",
  "import",
  "set",
  "reset",
  "pragma",
  "checkpoint",
  "comment",
  "begin",
  "commit",
  "rollback",
  "abort",
  "start",
  "end",
  "savepoint",
  "release",
  "prepare",
  "execute",
  "deallocate",
  "lock",
  "listen",
  "notify",
  "discard",
  "refresh",
  "reindex",
  "cluster",
  "analyze",
  "analyse",
  "use",
  "do",
]);

const EXPLAIN_OPTIONS = new Set(["analyze", "analyse", "verbose"]);

// Indexes in a statement where a statement starts: 0; after EXPLAIN, its parenthesized options and
// its option words; after `as (`, `as materialized (` and `as not materialized (` (a WITH entry);
// and, in a statement that starts with WITH, a word right after a closing parenthesis at depth 0.
function statementStarts(stmt: Token[]): Set<number> {
  const starts = new Set<number>([0]);
  let i = 0;
  while (stmt[i]?.kind === "word" && stmt[i]!.text === "explain") {
    i++;
    if (stmt[i]?.text === "(") {
      let depth = 0;
      for (; i < stmt.length; i++) {
        if (stmt[i]!.text === "(") depth++;
        else if (stmt[i]!.text === ")" && --depth === 0) {
          i++;
          break;
        }
      }
    }
    while (stmt[i]?.kind === "word" && EXPLAIN_OPTIONS.has(stmt[i]!.text)) i++;
    starts.add(i);
  }
  const isWith = stmt[i]?.kind === "word" && stmt[i]!.text === "with";
  let depth = 0;
  for (let j = 0; j < stmt.length; j++) {
    const t = stmt[j]!;
    if (t.kind === "op" && t.text === "(") {
      const before = stmt[j - 1];
      if (before?.kind === "word" && (before.text === "as" || before.text === "materialized")) starts.add(j + 1);
      depth++;
    } else if (t.kind === "op" && t.text === ")") {
      depth--;
      if (isWith && depth === 0 && stmt[j + 1]?.kind === "word") starts.add(j + 1);
    }
  }
  return starts;
}

// Functions that read the server's files, reach other servers, run a query from a string or change
// the session or other sessions; also matched by prefix: dblink*, lo_*, pg_ls_*, pg_file_*, query_to_xml*.
const DENIED_FUNCTIONS = new Set([
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
  "lo_import",
  "lo_export",
  "lo_get",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_promote",
  "nextval",
  "setval",
  "read_text",
  "read_blob",
  "getenv",
  "query",
  "query_table",
]);
const DENIED_PREFIXES = ["dblink", "lo_", "pg_ls_", "pg_file_", "query_to_xml"];

function deniedFunction(name: string): boolean {
  return DENIED_FUNCTIONS.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p));
}

export interface GuardOptions {
  // Whether glob(<pattern>) may list files matching `pattern`: true only for a pattern inside the
  // paths a DuckDB source's views read. Without it, glob is refused.
  globAllowed?: (pattern: string) => boolean;
}

// Whether a statement is EXPLAIN ANALYZE (in any spelling), which runs the statement it explains.
export function isExplainAnalyze(stmt: Token[]): boolean {
  return stmt[0]?.kind === "word" && stmt[0].text === "explain" && stmt.some((t) => t.kind === "word" && (t.text === "analyze" || t.text === "analyse"));
}

// Refuses anything but a single read-only statement that calls no denied function.
export function assertReadOnly(sql: string, opts: GuardOptions = {}): void {
  const all = statements(tokenize(sql));
  if (!all.length) throw new UserError("Empty query.");
  if (all.length > 1) throw new UserError("Run one statement at a time.");
  const stmt = all[0]!;
  const first = stmt[0]!;
  if (first.kind !== "word" || !READ_START.has(first.text)) {
    throw new UserError("Only read-only queries run here: SELECT, WITH, EXPLAIN, DESCRIBE, SHOW or SUMMARIZE.");
  }
  if (isExplainAnalyze(stmt)) {
    throw new UserError("Refusing EXPLAIN ANALYZE: it runs the statement it explains. Use EXPLAIN without ANALYZE: only read-only queries run here.");
  }
  const starts = statementStarts(stmt);
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i]!;
    const next = stmt[i + 1];
    if (t.kind === "word") {
      if (starts.has(i) && WRITE_WORDS.has(t.text)) {
        throw new UserError(`Refusing a query containing "${t.text}": only read-only queries run here.`);
      }
      if (t.text === "into") throw new UserError('Refusing a query containing "into": only read-only queries run here.');
      if (t.text === "for" && next?.kind === "word" && ["update", "share", "no", "key"].includes(next.text)) {
        throw new UserError(`Refusing a query containing "for ${next.text}": it locks rows; only read-only queries run here.`);
      }
    }
    if ((t.kind === "word" || t.kind === "ident") && next?.kind === "op" && next.text === "(") {
      const name = t.text.toLowerCase();
      if (deniedFunction(name)) {
        throw new UserError(`Refusing a query that calls ${name}(): it reads server files, reaches other servers or changes the session.`);
      }
      if (name === "glob") {
        const arg = stmt[i + 2];
        const ok = arg?.kind === "string" && stmt[i + 3]?.text === ")" && opts.globAllowed?.(arg.text) === true;
        if (!ok) throw new UserError("Refusing a query that calls glob() outside the paths the source's views read.");
      }
    }
  }
}

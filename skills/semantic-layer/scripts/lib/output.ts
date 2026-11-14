import { splitQualified } from "./naming.ts";
import { protectedColumns } from "./profile.ts";
import { listModels, loadSnapshot } from "./project.ts";
import { sensitivityOf } from "./sensitivity.ts";
import { statements, type Token, tokenize } from "./sql-guard.ts";
import type { SourceConfig } from "./types.ts";
import { PROTECTED_TAGS, PUBLIC_TAG } from "./types.ts";

// ANSI escape sequences (CSI, OSC and two-character escapes) and C0/C1 control characters other
// than tab and newline.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

// Text as printed: ANSI escapes and control characters other than tab and newline removed, so a
// value read from a database cannot move the cursor, recolor or rewrite the terminal.
export function plainText(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "");
}

// Plain-text tables for terminal output. Cells and headers are plainText with tabs and line
// breaks shown as spaces, so a value cannot break the table's layout.
export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "(no rows)";
  const cols = columns ?? Object.keys(rows[0]!);
  const clean = (s: string) => plainText(s).replace(/[\t\n]/g, " ");
  const cell = (v: unknown) => clean(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const heads = cols.map(clean);
  const widths = cols.map((c, i) => Math.max(heads[i]!.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(heads), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Protected values ---------------------------------------------------------------

// What a protected value is shown as.
export const PROTECTED_VALUE = "[protected]";

export interface ProtectedNames {
  // Lowercased names whose values are protected.
  names: Set<string>;
  // Lowercased names of fields tagged public, which the name rules do not protect.
  publicNames: Set<string>;
  // From the snapshot, keyed in lower case: the tables (without schema) that hold each protected
  // column, and each table's column names.
  tables: Map<string, string[]>;
  columns: Map<string, Set<string>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function hasTag(tags: unknown, wanted: readonly string[]): boolean {
  return strings(tags).some((t) => wanted.includes(t.toLowerCase()));
}

// The names a source's protected values go by: the fields tagged pii or sensitive (all fields of a
// model so tagged), the columns a model lists in ignored_columns, and the columns of its snapshot
// that protectedColumns in lib/profile.ts protects. Model files or a snapshot that cannot be read
// are skipped; the name rules of lib/sensitivity.ts still apply.
export function protectedNames(root: string, source: SourceConfig): ProtectedNames {
  const names = new Set<string>();
  const publicNames = new Set<string>();
  const tables = new Map<string, string[]>();
  const columns = new Map<string, Set<string>>();
  let models: unknown[] = [];
  try {
    models = listModels(root, source.source).map((l) => l.model as unknown);
  } catch {
    models = [];
  }
  for (const m of models) {
    if (!isRecord(m)) continue;
    const modelTagged = hasTag(m.tags, PROTECTED_TAGS);
    for (const c of strings(m.ignored_columns)) names.add(c.toLowerCase());
    for (const list of [m.dimensions, m.measures]) {
      for (const f of Array.isArray(list) ? list.filter(isRecord) : []) {
        if (typeof f.name !== "string") continue;
        if (modelTagged || hasTag(f.tags, PROTECTED_TAGS)) names.add(f.name.toLowerCase());
        else if (hasTag(f.tags, [PUBLIC_TAG])) publicNames.add(f.name.toLowerCase());
      }
    }
  }
  try {
    const snapshot = loadSnapshot(root, source.source);
    if (snapshot && Array.isArray(snapshot.tables)) {
      for (const [table, cols] of protectedColumns(snapshot.tables, models, source.dialect)) {
        for (const c of cols) {
          names.add(c.toLowerCase());
          tables.set(c.toLowerCase(), [...(tables.get(c.toLowerCase()) ?? []), splitQualified(table).name.toLowerCase()]);
        }
      }
      for (const t of snapshot.tables) {
        const known = columns.get(t.name.toLowerCase()) ?? new Set<string>();
        for (const c of t.columns) known.add(c.name.toLowerCase());
        columns.set(t.name.toLowerCase(), known);
      }
    }
  } catch {
    // An unreadable snapshot protects nothing beyond the rules above.
  }
  for (const n of names) publicNames.delete(n);
  return { names, publicNames, tables, columns };
}

// Whether a name is protected: one of the protected names, or flagged by the name rules of
// sensitivityOf unless a public-tagged field has that name.
function protectedName(name: string, prot: ProtectedNames): boolean {
  const k = name.toLowerCase();
  return prot.names.has(k) || (!prot.publicNames.has(k) && sensitivityOf(name) !== null);
}

// The result columns whose values are protected by their own names (see protectedName).
export function protectedResultColumns(columns: string[], prot: ProtectedNames): string[] {
  return columns.filter((c) => protectedName(c, prot));
}

// Rows with every non-null value of the given columns shown as PROTECTED_VALUE.
export function maskRows(rows: Record<string, unknown>[], columns: string[]): Record<string, unknown>[] {
  if (!columns.length) return rows;
  return rows.map((r) => {
    const out = { ...r };
    for (const c of columns) if (c in out && out[c] !== null && out[c] !== undefined) out[c] = PROTECTED_VALUE;
    return out;
  });
}

// The note printed under a table with protected columns.
export function protectedNote(columns: string[]): string {
  return `Protected column${columns.length === 1 ? "" : "s"} shown as ${PROTECTED_VALUE}: ${columns.map(plainText).join(", ")}.`;
}


// Protected values under another name ----------------------------------------------------------
//
// SQL the compiler did not write (sl run, a golden's cross_check_sql) can rename or wrap a column:
// `select email as e`, `lower(email)`, a subquery that renames it, `select c from customers c`.
// sqlMask reads the statement's tokens, not its grammar, and fails closed. A value reaches a result
// only through a select list, a VALUES list or the arguments of a function in FROM. When a name
// there is a protected column, a table used as a value, or a way to carry values unnamed, a result
// column is shown only when it is a count or everything it names is known not to be protected.

const idName = (t: Token): string => t.text.toLowerCase();
const isId = (t: Token | undefined): t is Token => t?.kind === "word" || t?.kind === "ident";
const isOp = (t: Token | undefined, ...texts: string[]): boolean => t?.kind === "op" && texts.includes(t.text);
const isWord = (t: Token | undefined, ...words: string[]): boolean => t?.kind === "word" && words.includes(t.text);

const CLAUSE_END = ["where", "group", "having", "order", "limit", "offset", "window", "qualify", "fetch", "for", "returning"];
const SET_OPS = ["union", "intersect", "except"];
// Words Postgres and DuckDB both reserve: unquoted, none is the name of a table, an alias or a column.
const RESERVED = new Set([
  ...CLAUSE_END.filter((w) => w !== "qualify"),
  ...SET_OPS,
  ...["select", "from", "with", "table", "as", "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using"],
  ...["lateral", "only", "tablesample", "and", "or", "not", "is", "in", "like", "ilike", "similar"],
]);
const isReserved = (t: Token | undefined): boolean => t?.kind === "word" && RESERVED.has(t.text);
// Words of an expression that name no column.
const EXPR_WORDS = new Set([
  ...["case", "when", "then", "else", "end", "null", "true", "false", "between", "to", "escape", "distinct", "all", "any", "some", "exists"],
  ...["array", "row", "over", "partition", "by", "asc", "desc", "nulls", "first", "last", "rows", "range", "groups", "unbounded", "preceding"],
  ...["following", "current", "filter", "within", "interval", "at", "time", "zone", "collate", "cast", "without", "precision", "varying"],
  ...["year", "month", "day", "hour", "minute", "second", "week", "quarter", "epoch", "current_date", "current_timestamp", "current_time"],
]);
// Words a select item ends with that are not its alias, and words no alias follows.
const NOT_ALIAS = new Set(["end", "null", "true", "false", "isnull", "notnull", "precision", "varying", "zone"]);
const NOT_BEFORE_ALIAS = new Set([
  ...["and", "or", "not", "is", "in", "like", "ilike", "between", "similar", "to", "when", "then", "else", "case", "distinct", "all"],
  ...["over", "from", "by", "at", "time", "zone", "collate", "escape", "select"],
]);
// Functions that return rows the statement does not name: DuckDB's columns(), and functions that
// run a query or read a table named in a string (the read-only check refuses query() and query_to_xml()).
const UNNAMED_ROWS = ["table_to_xml", "schema_to_xml", "database_to_xml", "cursor_to_xml", "ts_stat", "crosstab", "connectby"];
const unnamedRows = (fn: string): boolean => fn === "columns" || UNNAMED_ROWS.some((p) => fn.startsWith(p));
// Functions in FROM whose rows hold only what their arguments give, or names and types. Any other
// function in FROM can read a table or a file under names of its own.
const VALUE_FREE = new Set(["generate_series", "range", "unnest", "duckdb_tables", "duckdb_columns", "duckdb_views", "duckdb_schemas", "pragma_table_info"]);
// Words a query in parentheses starts with.
const QUERY_START = ["select", "with", "from", "table", "values"];

// One entry of a select list, as a token range.
interface SelectItem {
  from: number;
  to: number;
  // The result column's name where the text gives it: the alias, or the column of a plain reference.
  name?: string;
  // The alias is written with `as` or as a prefix; `implicit` is the index of one written without.
  aliased: boolean;
  implicit?: number;
  // The item is one column reference, a.b.c.
  plain: boolean;
  // `*` or `t.*`, alone or with exclude (...): plain; with anything else: odd.
  star?: "plain" | "odd";
  // In a subquery or a WITH entry, not the statement's own select list.
  nested: boolean;
}

// Where a token stands: where a value can reach a result (a select list, a VALUES list, the
// arguments of a function in FROM), among the relations of FROM, or in a clause that only picks,
// groups or orders rows.
type Pos = "value" | "relation" | "cond";

interface Statement {
  toks: Token[];
  // The statement's own select list; undefined when it has none or combines queries at its top level.
  top?: SelectItem[];
  items: SelectItem[];
  pos: Pos[];
  // Per token: inside count(...); inside count(...), the filter (where ...) of an aggregate or the
  // over (...) of a count, none of which gives a value of what it names; an alias being defined or
  // a type; an alias written without `as`; a * outside a select list, or a column read by position.
  inCount: boolean[];
  skip: boolean[];
  quiet: boolean[];
  implicit: boolean[];
  wild: boolean[];
  // Every name written among the relations of a FROM: schemas, tables, aliases, functions.
  relations: Set<string>;
  // Why result columns cannot be traced to the names they read, and why the statement can carry
  // a value under a name it does not write.
  opaque?: string;
  carrier?: string;
}

// Index of the parenthesis that closes the one at `open`.
function closing(toks: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    if (isOp(toks[k], "(")) depth++;
    else if (isOp(toks[k], ")") && --depth === 0) return k;
  }
  return toks.length;
}

interface Frame {
  // The statement or a subquery, with clauses of its own; otherwise an expression in parentheses,
  // whose tokens stand where `pos` says.
  query: boolean;
  clause?: "select" | "values" | "from" | "on" | "cond";
  pos: Pos;
  count: boolean;
  skip: boolean;
  // count(...), or the filter (...) or over (...) after it.
  tail: boolean;
  brackets: number;
  // The select list being read: its items, where the current one starts and its * when it has one.
  list?: SelectItem[];
  start?: number;
  star?: number;
}

const posOf = (f: Frame): Pos => (!f.query ? f.pos : f.clause === "select" || f.clause === "values" ? "value" : f.clause === "from" ? "relation" : "cond");

// Reads a statement's select lists and the names of its relations in one pass over its tokens.
function readStatement(toks: Token[]): Statement {
  const st: Statement = { toks, items: [], pos: [], inCount: [], skip: [], quiet: [], implicit: [], wild: [], relations: new Set() };
  const stack: Frame[] = [{ query: true, pos: "cond", count: false, skip: false, tail: false, brackets: 0 }];
  let tailEnd = -2;
  let mainSeen = false;
  let rowsFirst = false;
  let starish = false;
  let setOp = false;
  let topSetOp = false;
  let columnList = false;

  const endItem = (f: Frame, end: number): void => {
    if (f.clause !== "select" || f.start === undefined || !f.list) return;
    let from = f.start;
    const star = f.star;
    f.start = end + 1;
    f.star = undefined;
    while (isWord(toks[from], "distinct", "all")) from++;
    if (isWord(toks[from], "on") && isOp(toks[from + 1], "(")) from = closing(toks, from + 1) + 1;
    if (from >= end) return;
    const it: SelectItem = { from, to: end, aliased: false, plain: false, nested: f.list !== st.top };
    const chain = (a: number, b: number) => (b - a) % 2 === 1 && toks.slice(a, b).every((t, k) => (k % 2 ? isOp(t, ".") : isId(t)));
    if (star !== undefined) {
      const qualifier = star === from || (chain(from, star - 1) && isOp(toks[star - 1], "."));
      const rest = star + 1 === end || (isWord(toks[star + 1], "exclude") && isOp(toks[star + 2], "(") && closing(toks, star + 2) === end - 1);
      it.star = qualifier && rest ? "plain" : "odd";
      // Any other form (replace, rename, a pattern) can give a column another value or name.
      if (it.star === "odd") st.wild[star] = true;
    } else {
      const last = toks[end - 1]!;
      const before = toks[end - 2];
      let body = end;
      if (isId(toks[from]) && isOp(toks[from + 1], ":") && !isOp(toks[from + 2], ":")) {
        // DuckDB's prefix alias, `e: email`.
        it.aliased = true;
        it.name = idName(toks[from]!);
        st.quiet[from] = true;
        it.from = from += 2;
      } else if (end - from >= 3 && isWord(before, "as") && isId(last)) {
        it.aliased = true;
        it.to = body = end - 2;
        it.name = idName(last);
      } else if (
        end - from >= 2 &&
        isId(last) &&
        !(last.kind === "word" && NOT_ALIAS.has(last.text)) &&
        before &&
        (before.kind === "number" || before.kind === "string" || before.kind === "ident" || isOp(before, ")", "]", "}") || (before.kind === "word" && !NOT_BEFORE_ALIAS.has(before.text)))
      ) {
        it.implicit = body = end - 1;
        it.name = idName(last);
        st.implicit[body] = true;
      }
      // null, true and false are values, not columns: the database names their column.
      it.plain = chain(from, body) && !(body - from === 1 && isWord(toks[from], "null", "true", "false"));
      if (it.plain) it.name ??= idName(toks[body - 1]!);
    }
    f.list.push(it);
    st.items.push(it);
  };

  // The name at k, with its qualifiers, is an alias being defined or a type (after `as` or `::`).
  const quietName = (k: number): void => {
    for (; isId(toks[k]); k += 2) {
      st.quiet[k] = true;
      if (!isOp(toks[k + 1], ".")) return;
    }
  };

  // A parenthesis among the relations of FROM that opens no subquery: the columns of USING, a
  // group of joins, or the arguments of a function or the column list of an alias, which hold values.
  const fromParen = (i: number, child: Frame): void => {
    const prev = toks[i - 1];
    if (isWord(prev, "using")) child.pos = "cond";
    else if (!isId(prev) || isReserved(prev)) {
      child.query = true;
      child.clause = "from";
      st.opaque ??= "joins inside parentheses";
    } else {
      child.pos = "value";
      const owner = isWord(toks[i - 2], "as") ? toks[i - 3] : toks[i - 2];
      if (isOp(owner, ")") || (isId(owner) && !isReserved(owner))) {
        // `customers c (a, b)`: a column list gives a relation's columns other names.
        columnList = true;
        if (isId(owner)) st.carrier ??= `renames the columns of ${idName(owner)}`;
      } else {
        st.opaque ??= `reads the table function ${idName(prev)}()`;
        if (!VALUE_FREE.has(idName(prev))) st.carrier ??= `reads the table function ${idName(prev)}()`;
      }
    }
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const f = stack[stack.length - 1]!;
    st.pos[i] = posOf(f);
    st.inCount[i] = f.count;
    st.skip[i] = f.skip;
    if (t.kind === "param") st.wild[i] = true;
    // DuckDB reads a file named in FROM: from 'customers.csv'.
    if (t.kind === "string" && st.pos[i] === "relation") st.carrier ??= "reads a file by its path";
    if (t.kind === "op") {
      if (t.text === "(") {
        const count = isWord(prev, "count") && !isOp(toks[i - 2], ".");
        const filter = isWord(prev, "filter") && isOp(toks[i - 2], ")") && isWord(next, "where");
        const over = isWord(prev, "over") && tailEnd === i - 2;
        const child: Frame = { query: isWord(next, ...QUERY_START), pos: st.pos[i]!, count: f.count || count, skip: f.skip || count || filter || over, tail: count || ((filter || over) && tailEnd === i - 2), brackets: 0 };
        if (!child.query && child.pos === "relation") fromParen(i, child);
        stack.push(child);
      } else if (t.text === ")") {
        if (stack.length === 1) {
          st.carrier ??= "has an unmatched parenthesis";
          continue;
        }
        endItem(f, i);
        stack.pop();
        if (f.tail) tailEnd = i;
        // `with c (a, b) as (`: a WITH entry's column list.
        const body = isWord(toks[i + 2], "not") ? i + 4 : isWord(toks[i + 2], "materialized") ? i + 3 : i + 2;
        if (isWord(next, "as") && isOp(toks[body], "(")) columnList = true;
      } else if (t.text === ",") {
        if (f.brackets) continue;
        if (f.clause === "select") endItem(f, i);
        else if (f.clause === "on") f.clause = "from";
      } else if (t.text === "[" || t.text === "{") f.brackets++;
      else if (t.text === "]" || t.text === "}") f.brackets = Math.max(0, f.brackets - 1);
      else if (t.text === "*" && (!prev || isOp(prev, "(", ",", ".") || isWord(prev, "select", "distinct", "all"))) {
        // count(*) names nothing; any other * inside a count is counted, but an error can quote its row.
        if (f.count) st.wild[i] = !(isOp(prev, "(") && isWord(toks[i - 2], "count") && isOp(next, ")"));
        else if (f.clause === "select") f.star = i;
        else st.wild[i] = true;
        starish ||= !f.count;
      } else if (t.text === "#" && next?.kind === "number") st.wild[i] = true;
      else if (t.text === ":" && isOp(prev, ":") && prev!.end === t.pos) quietName(i + 1);
      continue;
    }
    if (!isId(t)) continue;
    const name = idName(t);
    const w = t.kind === "word" && !isOp(prev, ".") ? t.text : undefined;
    if (w === "as") {
      quietName(i + 1);
      continue;
    }
    if (w === "summarize" || w === "pivot" || w === "unpivot") st.carrier ??= `uses ${w.toUpperCase()}`;
    if (w === "u" && isOp(next, "&") && toks[i + 2]?.kind === "ident" && t.end === next!.pos && next!.end === toks[i + 2]!.pos) st.carrier ??= "writes a name with U& escapes";
    // operator(schema.+) puts an operand where an alias would stand.
    if (isOp(next, "(") && (unnamedRows(name) || w === "operator")) st.carrier ??= `calls ${name}()`;
    if (!f.query) continue;
    if (w === "select") {
      f.clause = "select";
      f.list = [];
      f.start = i + 1;
      f.star = undefined;
      if (stack.length === 1 && !mainSeen) {
        mainSeen = true;
        st.top = f.list;
      }
    } else if (w === "from") {
      // `is distinct from` compares.
      if (isWord(prev, "distinct")) continue;
      if (f.clause === "select") endItem(f, i);
      else if (f.clause !== undefined) continue;
      // FROM first (DuckDB) reads every column, as `select *` does.
      else {
        starish = true;
        rowsFirst ||= stack.length === 1;
      }
      f.clause = "from";
    } else if (w === "table" && f.clause === undefined && isId(next)) {
      // `table t` (Postgres), where a query starts, reads every column of t.
      starish = true;
      rowsFirst ||= stack.length === 1;
      f.clause = "from";
    } else if (w === "values" && f.clause === undefined) {
      f.clause = "values";
      st.opaque ??= "reads a VALUES list";
    } else if (w === "join") {
      if (f.clause === "on") f.clause = "from";
    } else if (w === "on") {
      if (f.clause === "from") f.clause = "on";
    } else if (w !== undefined && (CLAUSE_END.includes(w) || SET_OPS.includes(w)) && !(w === "group" && isWord(prev, "within")) && (RESERVED.has(w) || f.clause !== "select")) {
      // A word only DuckDB reserves (qualify) is a name on Postgres: in a select list it ends
      // nothing, and after a relation it is also its alias.
      if (f.clause === "from" && !RESERVED.has(w)) st.relations.add(w);
      endItem(f, i);
      f.clause = SET_OPS.includes(w) ? undefined : "cond";
      if (SET_OPS.includes(w)) {
        setOp = true;
        topSetOp ||= stack.length === 1;
      }
    } else if (f.clause === "from" && !isReserved(t)) {
      st.relations.add(name);
      if (/^pg_stat(s|istic)/.test(name)) st.carrier ??= `reads ${name}`;
    }
  }
  if (stack.length > 1) st.carrier ??= "has an unmatched parenthesis";
  endItem(stack[0]!, toks.length);
  if (topSetOp) st.top = undefined;
  else if (!mainSeen && rowsFirst) st.top = [{ from: 0, to: 0, aliased: false, plain: false, star: "plain", nested: false }];
  if (setOp) st.opaque ??= "combines queries with a set operation";
  if (columnList) st.opaque ??= "renames columns in a column list";
  if ((setOp || columnList) && starish) st.carrier ??= "combines or renames whole rows";
  return st;
}

// What a name says about the value it stands for: a protected column (read); whole rows or a value
// the statement does not name, such as a table or its alias used as a value, a * outside a select
// list, a column by position or a qualified name the snapshot does not hold (rows); a name defined
// from one of those (tainted); or a name the tool cannot place (unknown). Undefined for a name
// known not to be protected, and for a token that names no value.
type Mark = { read: string } | { rows: string } | "tainted" | "unknown" | undefined;

export interface SqlMask {
  // The result columns shown as [protected], in result order.
  columns: string[];
  // The protected columns the statement reads outside count(...), as table.column where the
  // statement reads one snapshot table that holds the column.
  reads: string[];
  // Why columns are masked beyond those their own names protect: where a value can reach a result
  // the statement reads a protected column, or carries values it does not name. Undefined otherwise.
  reason?: string;
  // Why a database error of this statement is not shown: `reason`, or a protected column the
  // statement names anywhere, inside count(...) too. Undefined otherwise.
  guard?: string;
  // Whether a column is masked that its own name does not protect.
  extra: boolean;
}

// The result columns of a statement the compiler did not write whose values are shown as
// [protected]. A column with a protected name is masked, as in a compiled query's result, unless it
// is a count. A statement is otherwise shown as it is unless, where a value can reach a result, it
// names a protected column outside count(...) or carries values it does not name. Then a column is
// shown only when it is a count, or the statement shows that it comes from nothing protected: a
// select item, or a column of `*`, all of whose names are columns of the snapshot that are not
// protected, or aliases of such items. Any other name masks its column. A statement whose result
// columns cannot be matched to select items (a set operation, a column list, a function in FROM,
// VALUES, an unnamed expression in a subquery) keeps only its counts. `ordered` says the columns
// are in the statement's order, as a query run here returns them; rows from a file match select
// items by alias or column name only.
export function sqlMask(sql: string, columns: string[], prot: ProtectedNames, opts: { ordered: boolean }): SqlMask {
  const byName = new Set(protectedResultColumns(columns, prot));
  let toks: Token[];
  try {
    toks = statements(tokenize(sql))[0] ?? [];
  } catch {
    const reason = "the statement could not be read";
    return { columns, reads: [], reason, guard: reason, extra: columns.some((c) => !byName.has(c)) };
  }
  // These print a plan, names and types, never a row's values.
  if (isWord(toks[0], "explain", "describe", "desc", "show")) return { columns: columns.filter((c) => byName.has(c)), reads: [], extra: false };
  const st = readStatement(toks);
  const known = new Set([...prot.columns.values()].flatMap((cols) => [...cols]));
  // Whether the statement reads a table of the snapshot, whose columns the tool then knows.
  const inScope = [...st.relations].some((r) => prot.columns.has(r));
  const defined = new Set(st.items.filter((it) => it.aliased || it.implicit !== undefined).map((it) => it.name!));
  // Names of select items that are not clean, to a fixed point: an alias of an alias.
  const tainted = new Set<string>();
  // Without a subquery or a WITH entry, a name the snapshot does not hold is a column of a table in
  // FROM under its own name. With one, it can be a name the database gave a subquery's column.
  const strict = st.items.some((it) => it.nested);

  const mark = (i: number): Mark => {
    const t = toks[i]!;
    if (st.wild[i]) return { rows: t.text === "#" ? `#${toks[i + 1]!.text}` : t.text };
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (!isId(t) || st.quiet[i] || isOp(next, "(") || (t.kind === "word" && isWord(prev, "over"))) return undefined;
    const name = idName(t);
    const secret = protectedName(t.text, prot);
    // An alias written without `as` names nothing, but a protected name there is read as a column:
    // the scan may have taken an operand for an alias.
    if (st.implicit[i]) return secret ? { read: name } : undefined;
    const qualified = isOp(prev, ".");
    // DuckDB reads c.to_json() as to_json(c): the name before the call is its value.
    const subject = isId(toks[i + 2]) && isOp(toks[i + 3], "(");
    if (isOp(next, ".") && !subject) {
      // A qualifier: a schema, a table or its alias, or a column with fields.
      if (!qualified && st.relations.has(name)) return tainted.has(name) ? "tainted" : undefined;
      if (secret) return { read: name };
      if (tainted.has(name)) return "tainted";
      return !strict || known.has(name) || defined.has(name) || st.relations.has(name) ? undefined : "unknown";
    }
    if (secret) return { read: name };
    // A relation's name is its whole row, unless it is qualified and an alias the statement defines.
    if (st.relations.has(name) && !(qualified && defined.has(name))) return { rows: name };
    const placed = known.has(name) || defined.has(name);
    // t.name where no column is known by that name: Postgres also reads it as name(t), the whole row.
    if (!placed && qualified && inScope) return { rows: `${isId(toks[i - 2]) ? `${idName(toks[i - 2]!)}.` : ""}${name}` };
    if (tainted.has(name)) return "tainted";
    // A keyword, or a type before its literal: date '2025-01-01'.
    return placed || !strict || (!qualified && t.kind === "word" && (RESERVED.has(name) || EXPR_WORDS.has(name) || next?.kind === "string")) ? undefined : "unknown";
  };
  const valueAt = (i: number): boolean => st.pos[i] === "value" && !st.skip[i];
  const dirty = (it: SelectItem): boolean => {
    if (it.star) return it.star === "odd";
    for (let i = it.from; i < it.to; i++) if (valueAt(i) && mark(i) !== undefined) return true;
    return false;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const it of st.items) {
      if (it.name === undefined || tainted.has(it.name) || !dirty(it)) continue;
      tainted.add(it.name);
      changed = true;
    }
  }
  for (const it of st.items) {
    // x.* where x is not a clean name: the fields of a value, under names of their own.
    if (it.star === "plain") for (let i = it.from; i < it.to && !isOp(toks[i], "*"); i++) if (mark(i) !== undefined) it.star = "odd";
    // A subquery's column the tool cannot trace by name reaches the result under any name: one
    // the database names, or the fields of a struct, which DuckDB's unnest() names whatever its alias.
    const named = it.plain || (it.aliased && !toks.slice(it.from, it.to).some((t, k) => isWord(t, "unnest") && isOp(toks[it.from + k + 1], "(")));
    if (it.nested && (it.star === "odd" || (!it.star && !named && dirty(it)))) st.opaque ??= "has an unnamed expression in a subquery";
  }

  // A protected column as table.column, when one snapshot table the statement reads holds it.
  const place = (name: string): string => {
    const holders = [...new Set(prot.tables.get(name) ?? [])].filter((t) => st.relations.has(t));
    return holders.length === 1 ? `${holders[0]}.${name}` : name;
  };
  // What the statement names anywhere, for the error guard; outside count(...), for `reads`; and
  // where a value can reach a result, for the mask.
  const named = { read: new Set<string>(), rows: new Set<string>() };
  const read = new Set<string>();
  const rows = new Set<string>();
  let valueRead = false;
  toks.forEach((_, i) => {
    const m = st.pos[i] === "relation" ? undefined : mark(i);
    if (typeof m !== "object") return;
    if ("rows" in m) {
      named.rows.add(m.rows);
      if (valueAt(i)) rows.add(m.rows);
      return;
    }
    named.read.add(place(m.read));
    if (st.inCount[i]) return;
    read.add(place(m.read));
    valueRead ||= valueAt(i);
  });
  const hot = valueRead || rows.size > 0 || st.carrier !== undefined;
  const blanket = st.opaque !== undefined || st.carrier !== undefined;
  const why = (reads: Set<string>, others: Set<string>): string | undefined =>
    reads.size
      ? `the statement reads protected column${reads.size === 1 ? "" : "s"} ${[...reads].sort().join(", ")}`
      : others.size
        ? `the statement reads rows or columns the tool cannot place (${[...others].sort().join(", ")})`
        : st.carrier && `the statement ${st.carrier}`;
  const reason = hot ? why(valueRead ? read : new Set(), rows) + (st.opaque && (valueRead || rows.size) ? ` and ${st.opaque}` : "") : undefined;
  const guard = reason ?? why(named.read, named.rows);

  // A count, alone or in arithmetic with numbers and other counts: it names nothing outside count(...).
  const countOnly = (it: SelectItem): boolean => {
    let counts = false;
    for (let i = it.from; i < it.to; i++) {
      const t = toks[i]!;
      if (st.skip[i] || st.quiet[i] || st.implicit[i]) continue;
      if (st.wild[i]) return false;
      if (!isId(t)) continue;
      if (isOp(toks[i + 1], "(")) {
        if (unnamedRows(idName(t))) return false;
        counts ||= isWord(t, "count") && !isOp(toks[i - 1], ".");
      } else if (!isWord(t, "null", "true", "false", "over") && !isWord(toks[i - 1], "over")) return false;
    }
    return counts;
  };

  const from = attribute(st.top, columns, opts.ordered);
  const masked = columns.filter((c, i) => {
    const it = from[i];
    if (it !== undefined && it !== "star" && countOnly(it)) return false;
    if (byName.has(c)) return true;
    if (!hot) return false;
    if (blanket || it === undefined) return true;
    const n = c.toLowerCase();
    return it === "star" ? tainted.has(n) || (strict && !known.has(n) && !defined.has(n)) : dirty(it);
  });
  return { columns: masked, reads: [...read].sort(), ...(reason ? { reason } : {}), ...(guard ? { guard } : {}), extra: masked.some((c) => !byName.has(c)) };
}

// The select item each result column comes from, "star" for a column of `*`, or undefined when the
// text does not say. Columns in the statement's order match by position, and every name the text
// gives must be the result column's; beside a `*`, every other item must give its name. Columns in
// any other order match an item by name alone, in a list without `*` (a list of one item needs no name).
function attribute(top: SelectItem[] | undefined, columns: string[], ordered: boolean): (SelectItem | "star" | undefined)[] {
  const none = columns.map(() => undefined);
  if (!top) return none;
  const names = columns.map((c) => c.toLowerCase());
  const stars = top.filter((it) => it.star);
  if (!ordered) {
    if (stars.length || top.length !== columns.length) return none;
    // One item and one column: there is no order to know.
    if (top.length === 1) return top[0]!.name !== undefined && top[0]!.name !== names[0] ? none : [top[0]];
    return names.map((n) => {
      const hits = top.filter((it) => it.name === n);
      return hits.length === 1 ? hits[0] : undefined;
    });
  }
  const out: (SelectItem | "star" | undefined)[] = [...none];
  if (!stars.length) {
    if (top.length !== columns.length) return none;
    top.forEach((it, i) => (out[i] = it));
  } else {
    if (stars.length > 1 || stars[0]!.star !== "plain" || columns.length < top.length - 1 || top.some((it) => !it.star && it.name === undefined)) return none;
    const at = top.indexOf(stars[0]!);
    const after = top.length - 1 - at;
    columns.forEach((_, i) => (out[i] = i < at ? top[i] : i >= columns.length - after ? top[top.length - (columns.length - i)] : "star"));
  }
  return out.some((it, i) => it !== undefined && it !== "star" && it.name !== undefined && it.name !== names[i]) ? none : out;
}

// The note printed under a table with masked columns: the columns their own names protect, or, when
// the statement itself is why, how many are masked, what it reads and how to see a column.
export function maskNote(mask: SqlMask): string {
  if (!mask.extra) return protectedNote(mask.columns);
  const n = mask.columns.length;
  return plainText(
    `${n} column${n === 1 ? "" : "s"} masked: ${mask.reason}. Counts are shown; values are not. ` +
      (mask.reads.length
        ? "To see a column that is not protected, select it by its own name and leave the protected one out."
        : "To see a column, select it by its own name from its table, as <table>.<column>."),
  );
}

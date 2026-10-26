// Builds snapshot tables from SQL DDL. Each CREATE SCHEMA, CREATE TABLE,
// CREATE VIEW, CREATE TYPE and COMMENT ON statement is normalized and run in an
// in-memory DuckDB, and the tables, views, columns and constraints are read
// back from DuckDB's catalog. Foreign keys, ALTER TABLE ... ADD constraints and
// unique indexes are read from the statements directly, so table order and
// unsupported constraint options never cause a statement to fail. A statement
// that still fails is reported as skipped.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { classifyType } from "../column-types.ts";
import type { Dialect, ForeignKey, SnapshotColumn, SnapshotTable, TableKind } from "../types.ts";
import { type ImportResult, schemaNamer } from "./information-schema.ts";

// ---------- Tokens ----------

type TokKind = "word" | "qident" | "string" | "num" | "punct";

interface Tok {
  k: TokKind;
  v: string; // word text, unquoted identifier, unescaped string, or punctuation
  start: number;
  end: number;
}

interface LexOptions {
  backslashEscapes: boolean;
  doubleQuoteStrings: boolean;
}

const MULTI_PUNCT = ["::", "||", "<=", ">=", "<>", "!=", "=>", "->"];

export function tokenize(text: string, opts: LexOptions): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;
  const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
  const isWord = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && opts.backslashEscapes) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    const start = i;
    if (c === "'" || ((c === "E" || c === "e") && text[i + 1] === "'")) {
      const escapes = opts.backslashEscapes || c !== "'";
      i += c === "'" ? 1 : 2;
      let v = "";
      while (i < n) {
        const ch = text[i]!;
        if (escapes && ch === "\\" && i + 1 < n) {
          const nx = text[i + 1]!;
          v += nx === "n" ? "\n" : nx === "t" ? "\t" : nx === "r" ? "\r" : nx === "0" ? "\0" : nx;
          i += 2;
          continue;
        }
        if (ch === "'") {
          if (text[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += ch;
        i++;
      }
      toks.push({ k: "string", v, start, end: i });
      continue;
    }
    if (c === '"' || c === "`") {
      i++;
      let v = "";
      while (i < n) {
        const ch = text[i]!;
        if (opts.backslashEscapes && c === '"' && ch === "\\" && i + 1 < n) {
          v += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === c) {
          if (text[i + 1] === c) {
            v += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += ch;
        i++;
      }
      toks.push({ k: c === '"' && opts.doubleQuoteStrings ? "string" : "qident", v, start, end: i });
      continue;
    }
    if (c === "$") {
      const m = text.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close;
        toks.push({ k: "string", v: text.slice(i + tag.length, end), start, end: close < 0 ? n : close + tag.length });
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = text.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)!;
      i += m[0].length;
      toks.push({ k: "num", v: m[0], start, end: i });
      continue;
    }
    if (isWordStart(c) || c === "$") {
      i++;
      while (i < n && isWord(text[i]!)) i++;
      toks.push({ k: "word", v: text.slice(start, i), start, end: i });
      continue;
    }
    const two = text.slice(i, i + 2);
    if (MULTI_PUNCT.includes(two)) {
      i += 2;
      toks.push({ k: "punct", v: two, start, end: i });
      continue;
    }
    i++;
    toks.push({ k: "punct", v: c, start, end: i });
  }
  return toks;
}

function splitStatements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.k === "punct" && t.v === ";") {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

const isWordTok = (t: Tok | undefined, ...words: string[]): boolean =>
  !!t && t.k === "word" && (words.length === 0 || words.includes(t.v.toUpperCase()));
const isPunct = (t: Tok | undefined, p: string): boolean => !!t && t.k === "punct" && t.v === p;
const isIdent = (t: Tok | undefined): boolean => !!t && (t.k === "word" || t.k === "qident");

// Index just past the group that opens at toks[i] with `open`.
function skipGroup(toks: Tok[], i: number, open = "(", close = ")"): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k !== "punct") continue;
    if (t.v === open) depth++;
    else if (t.v === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return toks.length;
}

// Type words whose parameters sit in angle brackets: STRUCT<a INT64, b STRING>, MAP<STRING, INT>, ARRAY<...>.
const ANGLE_TYPES = new Set(["STRUCT", "ARRAY", "MAP", "RANGE", "UNIONTYPE", "ROW"]);

// Splits tokens on commas outside parentheses, brackets and the angle brackets of nested types.
function splitTopLevel(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  let angle = 0;
  let prev: Tok | undefined;
  for (const t of toks) {
    if (t.k === "punct" && (t.v === "(" || t.v === "[")) depth++;
    else if (t.k === "punct" && (t.v === ")" || t.v === "]")) depth--;
    else if (depth === 0 && isPunct(t, "<") && (angle > 0 || (!!prev && prev.k === "word" && ANGLE_TYPES.has(prev.v.toUpperCase())))) angle++;
    else if (depth === 0 && angle > 0 && isPunct(t, ">")) angle--;
    prev = t;
    if (depth === 0 && angle === 0 && t.k === "punct" && t.v === ",") {
      out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out.filter((e) => e.length);
}

// ---------- Names ----------

interface QName {
  catalog: string | null;
  schema: string | null;
  name: string;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const DEFAULT_SCHEMA: Partial<Record<Dialect, string>> = { postgres: "public", duckdb: "main" };

function folder(dialect: Dialect): (s: string) => string {
  if (dialect === "postgres" || dialect === "databricks") return (s) => s.toLowerCase();
  if (dialect === "snowflake") return (s) => s.toUpperCase();
  return (s) => s;
}

// ---------- Types ----------

const TYPE_CONTINUATIONS = new Set(["VARYING", "PRECISION", "UNSIGNED", "SIGNED", "ZEROFILL", "ZONE", "LOCAL"]);

// Reads a column type starting at toks[i]; returns the index after it.
function readType(toks: Tok[], i: number): number {
  let j = i;
  if (!isIdent(toks[j])) return j;
  j++;
  while (isPunct(toks[j], ".") && isIdent(toks[j + 1])) j += 2;
  for (;;) {
    const t = toks[j];
    if (!t) break;
    if (isPunct(t, "(")) j = skipGroup(toks, j);
    else if (isPunct(t, "<")) j = skipGroup(toks, j, "<", ">");
    else if (isPunct(t, "[")) j = skipGroup(toks, j, "[", "]");
    else if (isWordTok(t, "WITH", "WITHOUT") && isWordTok(toks[j + 1], "TIME", "LOCAL")) j += 2;
    else if (t.k === "word" && TYPE_CONTINUATIONS.has(t.v.toUpperCase())) j++;
    else if (isWordTok(t, "TIME") && isWordTok(toks[j - 1], "WITH", "WITHOUT", "LOCAL")) j++;
    else break;
  }
  return j;
}

// The declared type as the snapshot records it: the original text, with serial types named for what they store.
function declaredType(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  const serial = t.match(/^(small|big)?serial([248])?$/i);
  if (!serial) return t;
  const base = serial[1]?.toLowerCase() === "big" || serial[2] === "8" ? "bigint" : serial[1]?.toLowerCase() === "small" || serial[2] === "2" ? "smallint" : "integer";
  return t === t.toUpperCase() ? base.toUpperCase() : base;
}

// A first-try DuckDB spelling of a declared type: dialect-only modifiers removed.
function duckType(declared: string): string {
  return declared
    .replace(/\b(unsigned|signed|zerofill)\b/gi, "")
    .replace(/^((?:tiny|small|medium|big)?int(?:eger)?)\s*\(\s*\d+\s*\)/i, "$1")
    .replace(/^mediumint\b/i, "INTEGER")
    .replace(/\s+/g, " ")
    .trim();
}

// A DuckDB type that always exists, for a second try when the declared type is unknown to DuckDB.
function safeType(declared: string): string {
  switch (classifyType(declared)) {
    case "integer":
      return "BIGINT";
    case "decimal":
      return "DOUBLE";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP";
    case "time":
      return "TIME";
    case "boolean":
      return "BOOLEAN";
    default:
      return "VARCHAR";
  }
}

// ---------- Parsed statements ----------

interface ColumnDef {
  name: string;
  type: string | null; // declared text, null when absent
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  description: string | null;
}

interface PendingFk {
  from: QName;
  columns: string[];
  to: QName;
  toColumns: string[] | null;
}

interface ObjectInfo {
  declared: QName;
  kind: TableKind;
  description: string | null;
  columns: Map<string, { type: string | null; description: string | null }>;
}

const CREATE_MODIFIERS = new Set([
  "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "TRANSIENT", "VOLATILE", "UNLOGGED", "EXTERNAL", "FOREIGN", "ICEBERG", "DYNAMIC",
  "HYBRID", "EVENT", "MATERIALIZED", "SECURE", "RECURSIVE", "UNIQUE", "ALGORITHM", "DEFINER", "SQL", "SECURITY", "INVOKER",
  "FORCE", "NOFORCE", "EDITIONABLE", "NONEDITIONABLE", "MULTISET", "STREAMING", "LIVE", "CLUSTERED", "NONCLUSTERED",
]);

const VIEW_BODY_START = new Set(["SELECT", "WITH", "FROM", "VALUES", "TABLE"]);

// True when the DDL is MySQL-flavored: a backtick-quoted identifier, `ENGINE =` or AUTO_INCREMENT outside strings and comments.
function looksLikeMysql(src: string, dialect: Dialect): boolean {
  const toks = tokenize(src, { backslashEscapes: false, doubleQuoteStrings: dialect === "bigquery" });
  return toks.some(
    (t, i) =>
      (t.k === "qident" && src[t.start] === "`") ||
      isWordTok(t, "AUTO_INCREMENT") ||
      (isWordTok(t, "ENGINE") && isPunct(toks[i + 1], "=")),
  );
}

class DdlImporter {
  private conn!: DuckDBConnection;
  private readonly fold: (s: string) => string;
  private readonly opts: LexOptions;
  private catalog: string | null = null;
  private schema: string | null = null;
  private attached = new Set<string>(["memory"]);
  private schemas = new Set<string>(["memory\u0000main"]);
  private lastUse = "memory\u0000main";
  readonly objects = new Map<string, ObjectInfo>();
  readonly fks: PendingFk[] = [];
  readonly extraKeys: { table: QName; type: "pk" | "unique"; columns: string[] }[] = [];
  readonly fallbackComments: { table: QName; column: string | null; text: string }[] = [];
  readonly skipped: string[] = [];
  readonly ignored = new Map<string, number>();

  private readonly mysqlish: boolean;
  // The DDL with MySQL /*!NNNNN ... */ wrappers opened; token offsets point into it.
  private readonly src: string;

  constructor(
    text: string,
    private readonly dialect: Dialect,
  ) {
    this.fold = folder(dialect);
    this.src = text.replace(/\/\*!\d*([\s\S]*?)\*\//g, " $1 ");
    this.schema = DEFAULT_SCHEMA[dialect] ?? null;
    this.mysqlish = dialect !== "postgres" && dialect !== "snowflake" && looksLikeMysql(this.src, dialect);
    this.opts = { backslashEscapes: this.mysqlish, doubleQuoteStrings: this.mysqlish || dialect === "bigquery" };
  }

  private ident(t: Tok): string {
    return t.k === "qident" ? t.v : this.fold(t.v);
  }

  // Reads a dotted name at toks[i]. BigQuery-style `project.dataset.table` in one quoted identifier splits on dots.
  private readName(toks: Tok[], i: number): { parts: string[]; next: number } {
    const parts: string[] = [];
    let j = i;
    while (isIdent(toks[j])) {
      const t = toks[j]!;
      if (t.k === "qident" && this.dialect === "bigquery" && t.v.includes(".")) parts.push(...t.v.split("."));
      else parts.push(this.ident(t));
      j++;
      if (isPunct(toks[j], ".") && isIdent(toks[j + 1])) j++;
      else break;
    }
    return { parts, next: j };
  }

  private resolve(parts: string[]): QName {
    const name = parts[parts.length - 1] ?? "";
    if (parts.length === 1) return { catalog: this.catalog, schema: this.schema, name };
    if (parts.length === 2) return { catalog: this.catalog, schema: parts[0]!, name };
    return { catalog: parts[parts.length - 3]!, schema: parts[parts.length - 2]!, name };
  }

  private duck(q: QName): { catalog: string; schema: string; name: string } {
    return { catalog: q.catalog ?? "memory", schema: q.schema ?? "main", name: q.name };
  }

  private key(q: QName): string {
    const d = this.duck(q);
    return `${d.catalog}\u0000${d.schema}\u0000${d.name}`.toLowerCase();
  }

  private qualified(q: QName): string {
    const d = this.duck(q);
    return `${quote(d.catalog)}.${quote(d.schema)}.${quote(d.name)}`;
  }

  // The key of the object a name refers to: exact, then ignoring the catalog, then by bare name when unique.
  findKey(q: QName): string | undefined {
    const exact = this.key(q);
    if (this.objects.has(exact)) return exact;
    const entries = [...this.objects.entries()];
    const named = entries.filter(([, o]) => o.declared.name.toLowerCase() === q.name.toLowerCase());
    const sameSchema = named.filter(([, o]) => (o.declared.schema ?? "").toLowerCase() === (q.schema ?? "").toLowerCase());
    const pool = sameSchema.length ? sameSchema : named;
    return pool.length === 1 ? pool[0]![0] : undefined;
  }

  private label(q: QName): string {
    return [q.catalog, q.schema, q.name].filter(Boolean).join(".");
  }

  private async ensure(catalog: string | null, schema: string | null): Promise<void> {
    const c = catalog ?? "memory";
    const s = schema ?? "main";
    if (!this.attached.has(c.toLowerCase())) {
      await this.conn.run(`ATTACH ':memory:' AS ${quote(c)}`);
      this.attached.add(c.toLowerCase());
    }
    const sk = `${c}\u0000${s}`.toLowerCase();
    if (!this.schemas.has(sk)) {
      await this.conn.run(`CREATE SCHEMA IF NOT EXISTS ${quote(c)}.${quote(s)}`);
      this.schemas.add(sk);
    }
  }

  // Points DuckDB's unqualified-name resolution at the current catalog and schema.
  private async syncUse(): Promise<void> {
    await this.ensure(this.catalog, this.schema);
    const c = this.catalog ?? "memory";
    const s = this.schema ?? "main";
    const k = `${c}\u0000${s}`.toLowerCase();
    if (k === this.lastUse) return;
    await this.conn.run(`USE ${quote(c)}.${quote(s)}`);
    this.lastUse = k;
  }

  // Re-serializes tokens for DuckDB: identifiers folded or quoted, strings re-escaped.
  private emit(toks: Tok[]): string {
    let out = "";
    let prev: Tok | undefined;
    for (const t of toks) {
      const glue = !prev || isPunct(t, ".") || isPunct(prev, ".") || isPunct(t, "::") || isPunct(prev, "::");
      if (!glue) out += " ";
      out += t.k === "word" ? this.fold(t.v) : t.k === "qident" ? quote(t.v) : t.k === "string" ? literal(t.v) : t.v;
      prev = t;
    }
    return out;
  }

  private ignore(toks: Tok[]): void {
    const w = toks
      .filter((t) => t.k === "word")
      .slice(0, 6)
      .map((t) => t.v.toUpperCase())
      .filter((x, i) => !(i > 0 && (x === "OR" || x === "REPLACE")));
    const n = w[0] === "CREATE" || w[0] === "ALTER" || w[0] === "DROP" ? (w[1] === "UNIQUE" ? 3 : 2) : 1;
    const label = w.slice(0, n).join(" ") || "?";
    this.ignored.set(label, (this.ignored.get(label) ?? 0) + 1);
  }

  private skip(what: string, e: unknown): void {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();
    this.skipped.push(`${what}: ${msg}`);
  }

  async run(): Promise<void> {
    const instance = await DuckDBInstance.create(":memory:");
    this.conn = await instance.connect();
    try {
      for (const stmt of splitStatements(tokenize(this.src, this.opts))) await this.statement(stmt);
      await this.collect();
    } finally {
      this.conn.closeSync();
      instance.closeSync();
    }
  }

  private async statement(toks: Tok[]): Promise<void> {
    const first = toks[0];
    if (isWordTok(first, "CREATE")) {
      let i = 1;
      let orReplace = false;
      if (isWordTok(toks[i], "OR") && isWordTok(toks[i + 1], "REPLACE", "ALTER")) {
        orReplace = true;
        i += 2;
      }
      // Find the object keyword after the modifiers; any other word means another kind of object.
      const mods: string[] = [];
      let j = i;
      while (j < toks.length) {
        const t = toks[j]!;
        if (isWordTok(t, "TABLE", "VIEW", "SCHEMA", "DATABASE", "TYPE", "INDEX")) break;
        if (t.k === "word") {
          const after = isPunct(toks[j - 1], "=") || isPunct(toks[j - 1], "@");
          if (!after && !CREATE_MODIFIERS.has(t.v.toUpperCase())) return this.ignore(toks);
          mods.push(t.v.toUpperCase());
        }
        j++;
      }
      const obj = toks[j]?.v.toUpperCase();
      const rest = toks.slice(j + 1);
      if (obj === "TABLE") return this.createTable(toks, rest, mods, orReplace);
      if (obj === "VIEW") return this.createView(toks, rest, mods, orReplace);
      if (obj === "SCHEMA" || obj === "DATABASE") return this.createSchema(toks, rest, obj);
      if (obj === "TYPE") return this.createType(toks, rest);
      if (obj === "INDEX" && mods.includes("UNIQUE")) return this.uniqueIndex(toks, rest);
      return this.ignore(toks);
    }
    if (isWordTok(first, "COMMENT") && isWordTok(toks[1], "ON")) return this.comment(toks);
    if (isWordTok(first, "ALTER") && isWordTok(toks[1], "TABLE")) return this.alterTable(toks);
    if (isWordTok(first, "USE")) return this.use(toks);
    if (isWordTok(first, "SET") && toks.some((t, i) => i < 3 && isWordTok(t, "SEARCH_PATH", "SCHEMA"))) return this.searchPath(toks);
    this.ignore(toks);
  }

  private use(toks: Tok[]): void {
    let i = 1;
    let target: "DATABASE" | "SCHEMA" | null = null;
    if (isWordTok(toks[i], "DATABASE", "CATALOG")) {
      target = "DATABASE";
      i++;
    } else if (isWordTok(toks[i], "SCHEMA")) {
      target = "SCHEMA";
      i++;
    } else if (isWordTok(toks[i], "WAREHOUSE", "ROLE", "SECONDARY")) return;
    const { parts } = this.readName(toks, i);
    if (!parts.length) return;
    if (parts.length >= 2) {
      this.catalog = parts[parts.length - 2]!;
      this.schema = parts[parts.length - 1]!;
    } else if (target === "DATABASE" || (target === null && !this.mysqlish && this.dialect === "snowflake")) {
      this.catalog = parts[0]!;
      this.schema = null;
    } else this.schema = parts[0]!;
  }

  private searchPath(toks: Tok[]): void {
    let i = toks.findIndex((t) => isWordTok(t, "SEARCH_PATH", "SCHEMA")) + 1;
    if (isPunct(toks[i], "=") || isWordTok(toks[i], "TO")) i++;
    const t = toks[i];
    if (!t) return;
    const first = t.k === "string" ? t.v.split(",")[0]!.trim() : isIdent(t) ? this.ident(t) : "";
    if (first && first.toLowerCase() !== "pg_catalog") this.schema = first;
  }

  // CREATE SCHEMA [db.]name, CREATE DATABASE name (a schema in MySQL, a catalog elsewhere).
  private async createSchema(all: Tok[], rest: Tok[], obj: string): Promise<void> {
    let i = 0;
    if (isWordTok(rest[i], "IF") && isWordTok(rest[i + 1], "NOT") && isWordTok(rest[i + 2], "EXISTS")) i += 3;
    const { parts } = this.readName(rest, i);
    if (!parts.length) return this.ignore(all);
    const last = parts[parts.length - 1]!;
    try {
      if (obj === "DATABASE" && !this.mysqlish) await this.ensure(last, null);
      else await this.ensure(parts.length >= 2 ? parts[parts.length - 2]! : this.catalog, last);
    } catch (e) {
      this.skip(`CREATE ${obj} ${parts.join(".")}`, e);
    }
  }

  private async createType(all: Tok[], rest: Tok[]): Promise<void> {
    const { parts, next } = this.readName(rest, 0);
    if (!parts.length) return void this.skipped.push(`CREATE TYPE: ${unreadableName(this.src, rest)}`);
    if (!isWordTok(rest[next], "AS")) return this.ignore(all);
    if (!isWordTok(rest[next + 1], "ENUM")) return this.ignore(all);
    const q = this.resolve(parts);
    try {
      await this.ensure(q.catalog, q.schema);
      await this.conn.run(`CREATE TYPE ${this.qualified(q)} AS ${this.emit(rest.slice(next + 1))}`);
    } catch (e) {
      this.skip(`CREATE TYPE ${this.label(q)}`, e);
    }
  }

  // Parses one column definition.
  private columnDef(el: Tok[], fks: { columns: string[]; ref: Tok[] }[]): ColumnDef | null {
    if (!isIdent(el[0])) return null;
    const name = this.ident(el[0]!);
    const typeEnd = readType(el, 1);
    const type = typeEnd > 1 ? this.src.slice(el[1]!.start, el[typeEnd - 1]!.end) : null;
    const def: ColumnDef = { name, type: type ? declaredType(type) : null, notNull: false, primaryKey: false, unique: false, description: null };
    let i = typeEnd;
    while (i < el.length) {
      const t = el[i]!;
      if (isPunct(t, "(")) {
        i = skipGroup(el, i);
        continue;
      }
      if (isWordTok(t, "NOT") && isWordTok(el[i + 1], "NULL")) {
        def.notNull = true;
        i += 2;
      } else if (isWordTok(t, "PRIMARY") && isWordTok(el[i + 1], "KEY")) {
        def.primaryKey = true;
        i += 2;
      } else if (isWordTok(t, "UNIQUE")) {
        def.unique = true;
        i++;
      } else if (isWordTok(t, "REFERENCES")) {
        const { next } = this.readName(el, i + 1);
        const end = isPunct(el[next], "(") ? skipGroup(el, next) : next;
        fks.push({ columns: [name], ref: el.slice(i + 1, end) });
        i = end;
      } else if (isWordTok(t, "COMMENT")) {
        let j = i + 1;
        if (isPunct(el[j], "=")) j++;
        const c = el[j];
        if (c && (c.k === "string" || c.k === "qident")) def.description = c.v;
        i = j + 1;
      } else if (isWordTok(t, "OPTIONS") && isPunct(el[i + 1], "(")) {
        const end = skipGroup(el, i + 1);
        def.description = optionDescription(el.slice(i + 2, end - 1)) ?? def.description;
        i = end;
      } else i++;
    }
    return def;
  }

  // Reads `(a, b)` at toks[i] as a list of identifiers, or null when it holds anything else.
  private identList(toks: Tok[], i: number): { cols: string[]; next: number } | null {
    if (!isPunct(toks[i], "(")) return null;
    const end = skipGroup(toks, i);
    const cols: string[] = [];
    for (const el of splitTopLevel(toks.slice(i + 1, end - 1))) {
      const first = el[0];
      if (!first || !isIdent(first)) return null;
      const extra = el.slice(1).filter((t) => !isWordTok(t, "ASC", "DESC") && !isPunct(t, "(") && !isPunct(t, ")") && t.k !== "num");
      if (extra.length) return null;
      cols.push(this.ident(first));
    }
    return { cols, next: end };
  }

  // Reads `REFERENCES name [(cols)]` tokens (without the keyword).
  private reference(ref: Tok[]): { to: QName; toColumns: string[] | null } | null {
    const { parts, next } = this.readName(ref, 0);
    if (!parts.length) return null;
    const list = this.identList(ref, next);
    return { to: this.resolve(parts), toColumns: list?.cols ?? null };
  }

  // Parses a table constraint element; returns true when the element is a constraint.
  private tableConstraint(
    el: Tok[],
    keys: { type: "pk" | "unique"; columns: string[] }[],
    fks: { columns: string[]; ref: Tok[] }[],
  ): boolean {
    let i = 0;
    if (isWordTok(el[0], "CONSTRAINT")) i = isIdent(el[1]) ? 2 : 1;
    const t = el[i];
    if (isWordTok(t, "PRIMARY") && isWordTok(el[i + 1], "KEY")) {
      let j = i + 2;
      while (j < el.length && !isPunct(el[j], "(")) j++;
      const list = this.identList(el, j);
      if (list) keys.push({ type: "pk", columns: list.cols });
      return true;
    }
    if (isWordTok(t, "UNIQUE")) {
      let j = i + 1;
      while (j < el.length && !isPunct(el[j], "(")) j++;
      const list = this.identList(el, j);
      if (list) keys.push({ type: "unique", columns: list.cols });
      return true;
    }
    if (isWordTok(t, "FOREIGN") && isWordTok(el[i + 1], "KEY")) {
      let j = i + 2;
      while (j < el.length && !isPunct(el[j], "(")) j++;
      const list = this.identList(el, j);
      const r = el.findIndex((x, k) => k >= j && isWordTok(x, "REFERENCES"));
      if (list && r >= 0) fks.push({ columns: list.cols, ref: el.slice(r + 1) });
      return true;
    }
    if (i > 0) return true;
    // A column may be named check, exclude, period, fulltext or spatial; the constraint forms are told apart by what follows.
    if (isWordTok(t, "CHECK") && isPunct(el[1], "(")) return true;
    if (isWordTok(t, "EXCLUDE") && (isWordTok(el[1], "USING") || isPunct(el[1], "("))) return true;
    if (isWordTok(t, "PERIOD") && isWordTok(el[1], "FOR")) return true;
    if (isWordTok(t, "FULLTEXT", "SPATIAL") && (isWordTok(el[1], "KEY", "INDEX") || isPunct(el[1], "(") || (isIdent(el[1]) && isPunct(el[2], "(") && isIdent(el[3])))) {
      return true;
    }
    if (isWordTok(t, "KEY", "INDEX")) {
      // MySQL index: KEY [name] (cols). A column named "key" has a type instead.
      const open = isPunct(el[1], "(") ? 1 : isIdent(el[1]) && isPunct(el[2], "(") ? 2 : -1;
      if (open > 0 && isIdent(el[open + 1])) return true;
    }
    return isWordTok(t, "LIKE");
  }

  private async createTable(all: Tok[], rest: Tok[], mods: string[], orReplace: boolean): Promise<void> {
    let i = 0;
    let ifNotExists = false;
    if (isWordTok(rest[i], "IF") && isWordTok(rest[i + 1], "NOT") && isWordTok(rest[i + 2], "EXISTS")) {
      ifNotExists = true;
      i += 3;
    }
    const { parts, next: afterName } = this.readName(rest, i);
    if (!parts.length) return void this.skipped.push(`CREATE TABLE: ${unreadableName(this.src, rest.slice(i))}`);
    const q = this.resolve(parts);
    const label = `CREATE TABLE ${this.label(q)}`;
    const key = this.key(q);
    if (ifNotExists && this.objects.has(key)) return;
    let kind: TableKind = mods.some((m) => ["EXTERNAL", "FOREIGN", "ICEBERG"].includes(m)) ? "external" : "table";
    const head = `CREATE ${orReplace ? "OR REPLACE " : ""}TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${this.qualified(q)}`;
    // Snowflake GET_DDL puts the clustering key before the column list: `TABLE t cluster by [linear] (c)( ... )`.
    let next = afterName;
    if (isWordTok(rest[next], "CLUSTER") && isWordTok(rest[next + 1], "BY")) {
      let k = next + 2;
      if (isWordTok(rest[k], "LINEAR")) k++;
      if (isPunct(rest[k], "(")) next = skipGroup(rest, k);
    }

    if (isPunct(rest[next], "(")) {
      const close = skipGroup(rest, next);
      const body = rest.slice(next + 1, close - 1);
      const tail = rest.slice(close);
      const cols: ColumnDef[] = [];
      const keys: { type: "pk" | "unique"; columns: string[] }[] = [];
      const fkTokens: { columns: string[]; ref: Tok[] }[] = [];
      for (const el of splitTopLevel(body)) {
        if (this.tableConstraint(el, keys, fkTokens)) continue;
        const def = this.columnDef(el, fkTokens);
        if (def) cols.push(def);
      }
      // Tail: table comment, Hive partition columns, external location.
      let description: string | null = null;
      for (let k = 0; k < tail.length; k++) {
        const t = tail[k]!;
        if (isWordTok(t, "COMMENT")) {
          const c = isPunct(tail[k + 1], "=") ? tail[k + 2] : tail[k + 1];
          if (c && (c.k === "string" || c.k === "qident")) description = c.v;
        } else if (isWordTok(t, "OPTIONS") && isPunct(tail[k + 1], "(")) {
          const end = skipGroup(tail, k + 1);
          description = optionDescription(tail.slice(k + 2, end - 1)) ?? description;
        } else if (isWordTok(t, "LOCATION")) kind = "external";
        else if (isWordTok(t, "PARTITIONED") && isWordTok(tail[k + 1], "BY") && isPunct(tail[k + 2], "(")) {
          const end = skipGroup(tail, k + 2);
          for (const el of splitTopLevel(tail.slice(k + 3, end - 1))) {
            if (el.length >= 2 && isIdent(el[1])) {
              const def = this.columnDef(el, []);
              if (def && !cols.some((c) => c.name.toLowerCase() === def.name.toLowerCase())) cols.push(def);
            }
          }
        }
      }
      if (!cols.length) return void this.skipped.push(`${label}: no columns found.`);
      const build = (typeOf: (c: ColumnDef) => string) => {
        const defs = cols.map(
          (c) => `${quote(c.name)} ${typeOf(c)}${c.notNull ? " NOT NULL" : ""}${c.primaryKey ? " PRIMARY KEY" : ""}${c.unique ? " UNIQUE" : ""}`,
        );
        for (const k of keys) defs.push(`${k.type === "pk" ? "PRIMARY KEY" : "UNIQUE"} (${k.columns.map(quote).join(", ")})`);
        return `${head} (${defs.join(", ")})`;
      };
      try {
        await this.syncUse();
        await this.ensure(q.catalog, q.schema);
        try {
          await this.conn.run(build((c) => (c.type ? duckType(c.type) : "VARCHAR")));
        } catch {
          await this.conn.run(build((c) => (c.type ? safeType(c.type) : "VARCHAR")));
        }
      } catch (e) {
        return this.skip(label, e);
      }
      this.objects.set(key, {
        declared: q,
        kind,
        description,
        columns: new Map(cols.map((c) => [c.name.toLowerCase(), { type: c.type, description: c.description }])),
      });
      for (const fk of fkTokens) {
        const r = this.reference(fk.ref);
        if (r) this.fks.push({ from: q, columns: fk.columns, to: r.to, toColumns: r.toColumns });
      }
      return;
    }

    if (isWordTok(rest[next], "PARTITION") && isWordTok(rest[next + 1], "OF")) {
      return void this.skipped.push(`${label}: a partition of another table; the parent table holds its columns.`);
    }
    // CREATE TABLE ... AS <query>
    const as = rest.findIndex((t, k) => k >= next && isWordTok(t, "AS") && (isWordTok(rest[k + 1], ...VIEW_BODY_START) || isPunct(rest[k + 1], "(")));
    if (as < 0) return void this.skipped.push(`${label}: no column list (LIKE, CLONE and similar forms are not read).`);
    try {
      await this.syncUse();
      await this.ensure(q.catalog, q.schema);
      await this.conn.run(`${head} AS ${this.emit(rest.slice(as + 1))}`);
    } catch (e) {
      return this.skip(label, e);
    }
    this.objects.set(key, { declared: q, kind, description: null, columns: new Map() });
  }

  private async createView(all: Tok[], rest: Tok[], mods: string[], orReplace: boolean): Promise<void> {
    let i = 0;
    let ifNotExists = false;
    if (isWordTok(rest[i], "IF") && isWordTok(rest[i + 1], "NOT") && isWordTok(rest[i + 2], "EXISTS")) {
      ifNotExists = true;
      i += 3;
    }
    const { parts, next } = this.readName(rest, i);
    const kindLabel = `CREATE ${mods.includes("MATERIALIZED") ? "MATERIALIZED " : ""}VIEW`;
    if (!parts.length) return void this.skipped.push(`${kindLabel}: ${unreadableName(this.src, rest.slice(i))}`);
    const q = this.resolve(parts);
    const label = `${kindLabel} ${this.label(q)}`;
    const key = this.key(q);
    if (ifNotExists && this.objects.has(key)) return;
    let j = next;
    const columnNames: string[] = [];
    const columns = new Map<string, { type: string | null; description: string | null }>();
    if (isPunct(rest[j], "(")) {
      const end = skipGroup(rest, j);
      for (const el of splitTopLevel(rest.slice(j + 1, end - 1))) {
        if (!isIdent(el[0])) continue;
        const name = this.ident(el[0]!);
        columnNames.push(name);
        const c = el.findIndex((t) => isWordTok(t, "COMMENT"));
        const text = c >= 0 ? (isPunct(el[c + 1], "=") ? el[c + 2] : el[c + 1]) : undefined;
        columns.set(name.toLowerCase(), { type: null, description: text && (text.k === "string" || text.k === "qident") ? text.v : null });
      }
      j = end;
    }
    let description: string | null = null;
    let bodyStart = -1;
    for (let k = j; k < rest.length; k++) {
      const t = rest[k]!;
      if (isPunct(t, "(")) {
        k = skipGroup(rest, k) - 1;
        continue;
      }
      if (isWordTok(t, "COMMENT")) {
        const c = isPunct(rest[k + 1], "=") ? rest[k + 2] : rest[k + 1];
        if (c && (c.k === "string" || c.k === "qident")) description = c.v;
      } else if (isWordTok(t, "OPTIONS") && isPunct(rest[k + 1], "(")) {
        const end = skipGroup(rest, k + 1);
        description = optionDescription(rest.slice(k + 2, end - 1)) ?? description;
      } else if (isWordTok(t, "AS") && (isWordTok(rest[k + 1], ...VIEW_BODY_START) || isPunct(rest[k + 1], "("))) {
        bodyStart = k + 1;
        break;
      }
    }
    if (bodyStart < 0) return void this.skipped.push(`${label}: no AS <query> found.`);
    let body = rest.slice(bodyStart);
    // Trailing options DuckDB does not read.
    const tailOption = body.findIndex(
      (t, k) =>
        isWordTok(t, "WITH") &&
        (isWordTok(body[k + 1], "CHECK", "DATA", "CASCADED", "LOCAL") || (isWordTok(body[k + 1], "NO") && isWordTok(body[k + 2], "DATA"))),
    );
    if (tailOption >= 0) body = body.slice(0, tailOption);
    const cols = columnNames.length ? ` (${columnNames.map(quote).join(", ")})` : "";
    try {
      await this.syncUse();
      await this.ensure(q.catalog, q.schema);
      await this.conn.run(`CREATE ${orReplace ? "OR REPLACE " : ""}VIEW ${ifNotExists ? "IF NOT EXISTS " : ""}${this.qualified(q)}${cols} AS ${this.emit(body)}`);
    } catch (e) {
      return this.skip(label, e);
    }
    this.objects.set(key, { declared: q, kind: "view", description, columns });
  }

  private async comment(toks: Tok[]): Promise<void> {
    let i = 2;
    const words: string[] = [];
    while (isWordTok(toks[i], "TABLE", "VIEW", "MATERIALIZED", "FOREIGN", "COLUMN", "EXTERNAL")) words.push(toks[i++]!.v.toUpperCase());
    if (!words.length) return this.ignore(toks);
    const { parts, next } = this.readName(toks, i);
    if (!isWordTok(toks[next], "IS")) return this.ignore(toks);
    const value = toks[next + 1];
    const text = value && value.k === "string" ? value.v : null;
    const isColumn = words.includes("COLUMN");
    if (isColumn && parts.length < 2) return this.ignore(toks);
    const column = isColumn ? parts[parts.length - 1]! : null;
    const found = this.findKey(this.resolve(isColumn ? parts.slice(0, -1) : parts));
    const info = found === undefined ? undefined : this.objects.get(found);
    if (!info) return void this.skipped.push(`COMMENT ON ${words.join(" ")} ${parts.join(".")}: no such table or view in this file.`);
    if (text === null) return;
    const q = info.declared;
    const target = column === null ? `${info.kind === "view" ? "VIEW" : "TABLE"} ${this.qualified(q)}` : `COLUMN ${this.qualified(q)}.${quote(column)}`;
    try {
      await this.conn.run(`COMMENT ON ${target} IS ${literal(text)}`);
    } catch {
      this.fallbackComments.push({ table: q, column, text });
    }
  }

  private alterTable(toks: Tok[]): void {
    let i = 2;
    while (isWordTok(toks[i], "ONLY", "IF", "EXISTS")) i++;
    const { parts, next } = this.readName(toks, i);
    if (!parts.length) return this.ignore(toks);
    const q = this.resolve(parts);
    let used = false;
    for (const clause of splitTopLevel(toks.slice(next))) {
      if (!isWordTok(clause[0], "ADD")) continue;
      const el = clause.slice(1);
      const keys: { type: "pk" | "unique"; columns: string[] }[] = [];
      const fks: { columns: string[]; ref: Tok[] }[] = [];
      if (!this.tableConstraint(el, keys, fks)) continue;
      for (const k of keys) {
        this.extraKeys.push({ table: q, type: k.type, columns: k.columns });
        used = true;
      }
      for (const fk of fks) {
        const r = this.reference(fk.ref);
        if (!r) continue;
        this.fks.push({ from: q, columns: fk.columns, to: r.to, toColumns: r.toColumns });
        used = true;
      }
    }
    if (!used) this.ignore(toks);
  }

  private uniqueIndex(all: Tok[], rest: Tok[]): void {
    const on = rest.findIndex((t) => isWordTok(t, "ON"));
    if (on < 0) return this.ignore(all);
    let i = on + 1;
    if (isWordTok(rest[i], "ONLY")) i++;
    const { parts, next } = this.readName(rest, i);
    let j = next;
    if (isWordTok(rest[j], "USING")) j += 2;
    const list = this.identList(rest, j);
    const hasWhere = rest.slice(j).some((t) => isWordTok(t, "WHERE"));
    if (!parts.length || !list || hasWhere) return this.ignore(all);
    this.extraKeys.push({ table: this.resolve(parts), type: "unique", columns: list.cols });
  }

  // ---------- Read back ----------

  readonly tables: SnapshotTable[] = [];
  readonly warnings: string[] = [];

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const r = await this.conn.runAndReadAll(sql);
    return r.getRowObjectsJson() as Record<string, unknown>[];
  }

  private async collect(): Promise<void> {
    const tkey = (r: Record<string, unknown>, nameCol = "table_name") =>
      `${r.database_name}\u0000${r.schema_name}\u0000${r[nameCol]}`.toLowerCase();
    const comments = new Map<string, string | null>();
    for (const r of await this.rows("select database_name, schema_name, table_name, comment from duckdb_tables() where not internal and not temporary"))
      comments.set(tkey(r), (r.comment as string | null) ?? null);
    for (const r of await this.rows("select database_name, schema_name, view_name, comment from duckdb_views() where not internal and not temporary"))
      comments.set(tkey(r, "view_name"), (r.comment as string | null) ?? null);
    const columns = new Map<string, Record<string, unknown>[]>();
    for (const r of await this.rows(
      "select database_name, schema_name, table_name, column_name, column_index, comment, is_nullable, data_type from duckdb_columns() order by database_name, schema_name, table_name, column_index",
    )) {
      const k = tkey(r);
      if (!this.objects.has(k)) continue;
      const list = columns.get(k) ?? [];
      list.push(r);
      columns.set(k, list);
    }
    const constraints = new Map<string, { type: string; cols: string[] }[]>();
    for (const r of await this.rows(
      "select database_name, schema_name, table_name, constraint_type, constraint_column_names from duckdb_constraints() where constraint_type in ('PRIMARY KEY', 'UNIQUE') order by constraint_index",
    )) {
      const k = tkey(r);
      const list = constraints.get(k) ?? [];
      list.push({ type: String(r.constraint_type), cols: (r.constraint_column_names as unknown[]).map(String) });
      constraints.set(k, list);
    }

    const namer = schemaNamer([...this.objects.values()].map((o) => o.declared.catalog));
    const defaultSchema = DEFAULT_SCHEMA[this.dialect] ?? null;
    const byKey = new Map<string, SnapshotTable>();
    for (const [k, info] of this.objects) {
      const table: SnapshotTable = {
        schema: namer(info.declared.catalog, info.declared.schema ?? defaultSchema),
        name: info.declared.name,
        kind: info.kind,
        row_count: null,
        description: comments.get(k) ?? info.description ?? null,
        primary_key: [],
        unique_keys: [],
        foreign_keys: [],
        columns: (columns.get(k) ?? []).map((r): SnapshotColumn => {
          const name = String(r.column_name);
          const declared = info.columns.get(name.toLowerCase());
          return {
            name,
            type: declared?.type ?? String(r.data_type),
            nullable: info.kind === "view" ? null : r.is_nullable === true ? true : r.is_nullable === false ? false : null,
            description: (r.comment as string | null) ?? declared?.description ?? null,
          };
        }),
      };
      for (const c of constraints.get(k) ?? []) {
        if (c.type === "PRIMARY KEY" && !table.primary_key!.length) table.primary_key = c.cols;
        else if (c.type === "UNIQUE") table.unique_keys!.push(c.cols);
      }
      byKey.set(k, table);
      this.tables.push(table);
    }

    const lookup = (q: QName): [string, SnapshotTable] | undefined => {
      const k = this.findKey(q);
      const t = k === undefined ? undefined : byKey.get(k);
      return k !== undefined && t ? [k, t] : undefined;
    };
    const colName = (t: SnapshotTable, c: string) => t.columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.name;
    const keyId = (cols: string[]) => cols.map((c) => c.toLowerCase()).join("\u0000");

    for (const extra of this.extraKeys) {
      const hit = lookup(extra.table);
      if (!hit) {
        this.warnings.push(`A ${extra.type === "pk" ? "primary key" : "unique key"} on ${this.label(extra.table)} names a table not defined in this file.`);
        continue;
      }
      const t = hit[1];
      const cols = extra.columns.map((c) => colName(t, c));
      if (cols.some((c) => !c)) {
        this.warnings.push(`A key on ${this.label(extra.table)} names columns it does not have: ${extra.columns.join(", ")}.`);
        continue;
      }
      if (extra.type === "pk" && !t.primary_key!.length) t.primary_key = cols as string[];
      else t.unique_keys!.push(cols as string[]);
    }
    for (const t of this.tables) {
      const seen = new Set<string>([keyId(t.primary_key!)]);
      t.unique_keys = t.unique_keys!.filter((u) => {
        const id = keyId(u);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (t.primary_key!.length) for (const c of t.columns) if (t.primary_key!.includes(c.name) && c.nullable === null) c.nullable = false;
    }

    const unresolved: string[] = [];
    for (const fk of this.fks) {
      const from = lookup(fk.from);
      const to = lookup(fk.to);
      if (!from || !to) {
        unresolved.push(`${this.label(fk.from)} -> ${this.label(fk.to)}`);
        continue;
      }
      const target = to[1];
      const toCols = fk.toColumns ?? target.primary_key ?? [];
      const fromCols = fk.columns.map((c) => colName(from[1], c));
      const refCols = toCols.map((c) => colName(target, c));
      if (!toCols.length || toCols.length !== fk.columns.length || fromCols.some((c) => !c) || refCols.some((c) => !c)) {
        unresolved.push(`${this.label(fk.from)} -> ${this.label(fk.to)}`);
        continue;
      }
      const entry: ForeignKey = { columns: fromCols as string[], references: { schema: target.schema, table: target.name, columns: refCols as string[] } };
      const list = from[1].foreign_keys!;
      if (!list.some((x) => JSON.stringify(x) === JSON.stringify(entry))) list.push(entry);
    }
    if (unresolved.length) {
      this.warnings.push(
        `${unresolved.length} foreign key${unresolved.length === 1 ? "" : "s"} point${unresolved.length === 1 ? "s" : ""} at a table or column not defined in this file: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ", ..." : ""}.`,
      );
    }

    for (const c of this.fallbackComments) {
      const hit = lookup(c.table);
      if (!hit) continue;
      if (c.column === null) hit[1].description = c.text;
      else {
        const col = hit[1].columns.find((x) => x.name.toLowerCase() === c.column!.toLowerCase());
        if (col) col.description = c.text;
      }
    }
  }
}

// The reason a CREATE statement's name could not be read, quoting the text where the name should be.
function unreadableName(src: string, rest: Tok[]): string {
  const first = rest[0];
  const last = rest[rest.length - 1];
  const near = first && last ? src.slice(first.start, Math.min(last.end, first.start + 40)).replace(/\s+/g, " ").trim() : "";
  return near ? `could not read the name at "${near}".` : "no name found.";
}

// Reads description = "..." from BigQuery OPTIONS(...) tokens.
function optionDescription(toks: Tok[]): string | null {
  for (const el of splitTopLevel(toks)) {
    if (isWordTok(el[0], "DESCRIPTION") && isPunct(el[1], "=") && el[2] && (el[2].k === "string" || el[2].k === "qident")) return el[2].v;
  }
  return null;
}

export async function importDdl(text: string, dialect: Dialect): Promise<ImportResult> {
  const imp = new DdlImporter(text, dialect);
  await imp.run();
  const warnings = [...imp.warnings];
  const skipped = imp.skipped;
  for (const s of skipped.slice(0, 20)) warnings.push(`Skipped ${s}`);
  if (skipped.length > 20) warnings.push(`Skipped ${skipped.length - 20} more statements.`);
  if (imp.ignored.size) {
    const total = [...imp.ignored.values()].reduce((a, b) => a + b, 0);
    const parts = [...imp.ignored.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} (${v})`);
    warnings.push(`Ignored ${total} statement${total === 1 ? " that defines" : "s that define"} no tables: ${parts.join(", ")}.`);
  }
  return { tables: imp.tables, warnings };
}

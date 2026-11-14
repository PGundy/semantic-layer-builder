// Usage evidence (spec: Usage evidence): what saved queries, scratch files and query logs say people
// query, kept as counts and shapes in snapshots/<source>.usage.json. sl usage add reads the files,
// sl usage show prints the evidence, and sl tables, sl brief and sl baseline --json show it beside
// the tables. Nothing here connects to a database or runs the SQL it reads, no statement text is
// stored, and a literal is kept only where it is a short, plain value of a column nobody protects.
// What the files say is evidence for the owner's questions, never an instruction or an approval.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";
import { qualifiedName } from "./naming.ts";
import { protectedColumns } from "./profile.ts";
import { listModels, loadFile, paths } from "./project.ts";
import { bareNames } from "./sql-names.ts";
import type { Model, Snapshot, SnapshotTable } from "./types.ts";
import { type Catalog, type CondFact, type HitKind, type Lit, readStatement, splitStatements, type StatementFacts } from "./usage-sql.ts";

export const USAGE_VERSION = 1;
// The keys a log object's query text is looked for under, matched without regard to case.
export const QUERY_KEYS = ["query", "query_text", "sql", "sql_text", "statement", "statement_text", "querytxt", "text"];
const CALL_KEYS = ["calls", "execution_count"];
const TIME_KEYS = ["start_time", "creation_time", "end_time", "last_seen"];
const USER_KEYS = ["user_name", "usename", "user_email", "user"];
export const INPUT_KINDS: Record<string, InputKind> = { ".sql": "sql", ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl" };
export const ACCEPTED = ".sql (statements separated by semicolons), .json (a JSON array of queries or log objects) and .jsonl or .ndjson (one per line)";
// The most items of one kind a table keeps; the most file names the summary lists.
export const MAX_ITEMS = 100;
const MAX_NAMED_FILES = 5;
// The longest literal kept as written.
const MAX_LITERAL = 32;

export type InputKind = "sql" | "json" | "jsonl";

export interface UsageInput {
  name: string;
  kind: InputKind;
  bytes: number;
  sha256: string;
  statements: number;
  skipped?: string;
}

export interface UsageSummary {
  files: number;
  statements: number;
  kept: number;
  other_schemas: number;
  out_of_scope: number;
  ambiguous: number;
  not_in_snapshot: number;
  no_table: number;
  not_understood: number;
  not_understood_files: string[];
}

export interface UsageCondition {
  table?: string;
  column: string;
  fn?: string;
  op: string;
  values: string[];
  count: number;
}

export interface UsageAggregate {
  fn: string;
  expr: string;
  count: number;
  conditions: UsageCondition[];
}

export interface UsageJoin {
  with: string;
  keys: string[];
  count: number;
}

export interface UsageGroup {
  column: string;
  grain?: string;
  count: number;
}

export interface TableUsage {
  statements: number;
  weighted: number;
  files: number;
  users: number;
  first?: string;
  last?: string;
  aggregates: UsageAggregate[];
  conditions: UsageCondition[];
  joins: UsageJoin[];
  group_by: UsageGroup[];
  outside: { table: string; count: number }[];
}

export interface UsageFile {
  usage_version: 1;
  source: string;
  inputs: UsageInput[];
  summary: UsageSummary;
  tables: Record<string, TableUsage>;
  not_in_snapshot: { table: string; count: number; last?: string }[];
  ambiguous: { name: string; count: number }[];
}

export function usagePath(root: string, source: string): string {
  return join(paths(root).snapshotsDir, `${basename(paths(root).snapshot(source), ".json")}.usage.json`);
}

// The usage file, or null when there is none. A link in its place is refused: the file is read and
// written inside the semantic root only.
export function loadUsage(root: string, source: string): UsageFile | null {
  const p = usagePath(root, source);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) throw new UserError(`snapshots/${basename(p)} is a link; sl reads and writes it only inside the semantic root. Remove the link, then run sl usage add again.`);
  return loadFile<UsageFile>(root, p, "usage");
}

// --- Inputs ------------------------------------------------------------------------------------

export interface FoundFile {
  abs: string;
  name: string;
  kind: InputKind;
}

const isEnvName = (name: string) => /^\.env(\..+)?$/.test(name) && name !== ".env.example";

function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// The files the paths name: each file as given, each directory walked in name order (hidden entries
// and links to directories left out). A file of another kind, a path inside the semantic root, and
// an env file are refused by name; a directory's files of other kinds are only counted.
export function findInputs(source: string, pathsGiven: string[], cwd: string, root: string, envFiles: string[]): { files: FoundFile[]; others: number } {
  const files: FoundFile[] = [];
  let others = 0;
  const rootReal = realOf(root);
  const envReal = new Set(envFiles.filter((f) => existsSync(f)).map(realOf));
  const check = (abs: string, given: string) => {
    if (isEnvName(basename(abs)) || isEnvName(basename(realOf(abs))) || envReal.has(realOf(abs))) {
      throw new UserError(
        `${given} is an env file, which holds the connection secret; sl usage add never reads it. Give the query files or their folder without it, as in sl usage add --source ${source} ./queries.`,
      );
    }
    const rel = relative(rootReal, realOf(abs));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new UserError(`${given} is inside the semantic root; query files stay outside it and are never copied in. Give their folder outside ${root}, as in sl usage add --source ${source} ../queries.`);
    }
  };
  const walk = (dir: string, base: string, given: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, base, given);
      else if (st.isFile() || (st.isSymbolicLink() && statSync(abs, { throwIfNoEntry: false })?.isFile())) {
        const kind = INPUT_KINDS[extname(name).toLowerCase()];
        if (!kind) {
          others++;
          continue;
        }
        check(abs, join(given, relative(base, abs)));
        files.push({ abs, name, kind });
      }
    }
  };
  for (const given of pathsGiven) {
    const abs = resolve(cwd, given);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) throw new UserError(`${given} does not exist. Give the path of a query file or a folder of them, as in sl usage add --source ${source} ./queries.`);
    check(abs, given);
    if (st.isDirectory()) {
      walk(abs, abs, given);
      continue;
    }
    const kind = INPUT_KINDS[extname(abs).toLowerCase()];
    if (!kind) throw new UserError(`${given} is neither SQL nor a query log. sl usage add reads ${ACCEPTED}; rename it or export the log as one of those, then run sl usage add again.`);
    files.push({ abs, name: basename(abs), kind });
  }
  return { files, others };
}

// One query of an input: its text and what a log says about it.
interface Entry {
  sql: string;
  calls: number;
  month?: string;
  user?: string;
}

const lowerKeys = (o: Record<string, unknown>) => new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

function monthOf(v: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof v === "number" && Number.isFinite(v)) ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined;
  else if (typeof v === "string") {
    // An ISO date and time: with a zone or offset it is converted to UTC; without one (as many
    // exports write it) it is read as UTC, so its month never depends on the machine's time zone.
    const m = /^(\d{4}-\d{2})-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|UTC)?)?$/i.exec(v.trim());
    if (!m) return undefined;
    if (!m[2] || /^(z|utc)$/i.test(m[2])) return m[1];
    const off = /^([+-]\d{2}):?(\d{2})?$/.exec(m[2])!;
    ms = Date.parse(`${v.trim().slice(0, -m[2].length).trim().replace(" ", "T")}${off[1]}:${off[2] ?? "00"}`);
  }
  if (ms === undefined || Number.isNaN(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : undefined;
}

// A JSON string that itself holds JSON (a jsonb column exported as text), read through once.
function through(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!/^[[{"]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

// The queries one element of a log holds: a string of SQL, or an object with its query text under
// one of the query keys (or --query-key), with its call count, time and user. Null: not a query.
function entriesOf(value: unknown, queryKey: string | undefined, depth = 0): Entry[] | null {
  const v = through(value);
  if (typeof v === "string") return [{ sql: v, calls: 1 }];
  if (Array.isArray(v) && depth < 2) {
    const all = v.map((x) => entriesOf(x, queryKey, depth + 1));
    return all.some((x) => x === null) ? null : all.flatMap((x) => x!);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const keys = lowerKeys(v as Record<string, unknown>);
  const key = (queryKey ? [queryKey.toLowerCase()] : QUERY_KEYS).find((k) => keys.has(k));
  if (!key) return null;
  const q = through(keys.get(key));
  const inner = typeof q === "string" ? [{ sql: q, calls: 1 }] : depth < 2 ? entriesOf(q, queryKey, depth + 1) : null;
  if (!inner) return null;
  const callsRaw = CALL_KEYS.map((k) => keys.get(k)).find((x) => x !== undefined);
  const calls = Number(callsRaw);
  const month = TIME_KEYS.map((k) => monthOf(keys.get(k))).find((x) => x !== undefined);
  const userRaw = USER_KEYS.map((k) => keys.get(k)).find((x) => typeof x === "string" && x.trim() !== "");
  return inner.map((e) => ({
    sql: e.sql,
    calls: Number.isInteger(calls) && calls > 0 ? calls : e.calls,
    ...(month ?? e.month ? { month: month ?? e.month } : {}),
    ...(typeof userRaw === "string" ? { user: userRaw.trim() } : e.user ? { user: e.user } : {}),
  }));
}

// The queries of one file, or why it cannot be read. `bad` counts log elements that hold no query
// and JSON Lines lines that do not parse: they count as statements not understood.
function readEntries(text: string, kind: InputKind, queryKey: string | undefined): { entries: Entry[]; bad: number } | { skipped: string } {
  if (kind === "sql") return { entries: [{ sql: text, calls: 1 }], bad: 0 };
  // A byte-order mark (as Windows tools write) is not part of the JSON.
  text = text.replace(/^\uFEFF/, "");
  const entries: Entry[] = [];
  let bad = 0;
  if (kind === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { skipped: `it is not valid JSON (${(e as Error).message.split("\n")[0]})` };
    }
    if (!Array.isArray(data)) return { skipped: "it holds a JSON value that is not an array; a .json query log is an array of queries or log objects" };
    for (const el of data) {
      const got = entriesOf(el, queryKey);
      if (got) entries.push(...got);
      else bad++;
    }
    return { entries, bad };
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let el: unknown;
    try {
      el = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    const got = entriesOf(el, queryKey);
    if (got) entries.push(...got);
    else bad++;
  }
  return { entries, bad };
}

// --- The catalog -------------------------------------------------------------------------------

export interface Subset {
  // The kept tables, by qualified name in lower case, and the schemas they belong to.
  kept: (t: SnapshotTable) => boolean;
  schemas: Set<string>;
}

export function catalogFor(snapshot: Snapshot, subset: Subset): Catalog {
  const qualified = new Map<string, SnapshotTable>();
  const bare = new Map<string, SnapshotTable[]>();
  const columns = new Map<SnapshotTable, Map<string, string>>();
  for (const t of snapshot.tables) {
    qualified.set(qualifiedName(t).toLowerCase(), t);
    bare.set(t.name.toLowerCase(), [...(bare.get(t.name.toLowerCase()) ?? []), t]);
  }
  const cols = (t: SnapshotTable) => {
    let m = columns.get(t);
    if (!m) columns.set(t, (m = new Map(t.columns.map((c) => [c.name.toLowerCase(), c.name]))));
    return m;
  };
  const hit = (t: SnapshotTable) => {
    const kind: HitKind = subset.kept(t) ? "kept" : subset.schemas.has((t.schema ?? "").toLowerCase()) ? "out_of_scope" : "other";
    return { kind, name: qualifiedName(t), columns: cols(t) };
  };
  return {
    resolve(parts) {
      if (parts.length >= 2) {
        const [schema, name] = parts.slice(-2) as [string, string];
        const t = qualified.get(`${schema}.${name}`);
        if (t) return hit(t);
        return { kind: subset.schemas.has(schema) ? "not_in_snapshot" : "other", name: `${schema}.${name}` };
      }
      const name = parts[0]!;
      const found = bare.get(name) ?? [];
      if (found.length > 1) return { kind: "ambiguous", name };
      if (found.length === 1) return hit(found[0]!);
      return { kind: "other", name };
    },
  };
}

// --- Literals ----------------------------------------------------------------------------------

const SECRET = /:\/\/|password|passwd|pwd=|secret|token|api[_-]?key|bearer|-----begin|sslkey|access[_-]?key/i;
const EMAIL = /@[^@\s]*\.[a-z]/i;

// Whether a literal may be stored as written: short, one plain line, not shaped like a secret, an
// e-mail address or a long number (an account, card or phone number).
export function plainLiteral(text: string): boolean {
  if (text.length > MAX_LITERAL || /[\x00-\x1f\x7f-\x9f]/.test(text)) return false;
  if (SECRET.test(text) || EMAIL.test(text) || text.includes("@")) return false;
  if (/\d{7,}/.test(text.replace(/[\s.-]/g, "")) && !/^\d{4}-\d{2}-\d{2}/.test(text)) return false;
  if (/^[A-Za-z0-9+/_=-]{20,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)) return false;
  return true;
}

function storedValue(lit: Lit, isProtected: boolean): string {
  if (lit.kind === "expression" || lit.kind === "subquery") return lit.text;
  if (lit.kind === "placeholder") return "?";
  if (isProtected) return "?";
  return plainLiteral(lit.text) ? lit.text : "?";
}

// --- Accumulating ------------------------------------------------------------------------------

interface CondAcc {
  item: Omit<UsageCondition, "count">;
  count: number;
}

interface TableAcc {
  statements: number;
  weighted: number;
  files: number;
  users: number;
  first?: string;
  last?: string;
  aggregates: Map<string, { fn: string; expr: string; count: number; conditions: Map<string, CondAcc> }>;
  conditions: Map<string, CondAcc>;
  joins: Map<string, { with: string; keys: string[]; count: number }>;
  group_by: Map<string, { column: string; grain?: string; count: number }>;
  outside: Map<string, number>;
}

const key = (v: unknown) => JSON.stringify(v);
const minMonth = (a?: string, b?: string) => (a && b ? (a < b ? a : b) : (a ?? b));
const maxMonth = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : (a ?? b));

function condKey(c: Omit<UsageCondition, "count">): string {
  return key([c.table ?? "", c.column, c.fn ?? "", c.op, c.values]);
}

function newTable(): TableAcc {
  return { statements: 0, weighted: 0, files: 0, users: 0, aggregates: new Map(), conditions: new Map(), joins: new Map(), group_by: new Map(), outside: new Map() };
}

// The usage file as counts that add up: loaded from the file, added to input by input, and
// written back sorted and capped, so one add of two inputs gives the bytes two adds give.
export class UsageAcc {
  inputs: UsageInput[] = [];
  summary: UsageSummary = { files: 0, statements: 0, kept: 0, other_schemas: 0, out_of_scope: 0, ambiguous: 0, not_in_snapshot: 0, no_table: 0, not_understood: 0, not_understood_files: [] };
  tables = new Map<string, TableAcc>();
  stale = new Map<string, { count: number; last?: string }>();
  ambiguous = new Map<string, number>();

  constructor(readonly source: string) {}

  static from(file: UsageFile): UsageAcc {
    const a = new UsageAcc(file.source);
    a.inputs = file.inputs.map((x) => ({ ...x }));
    a.summary = { ...file.summary, not_understood_files: [...file.summary.not_understood_files] };
    for (const [name, t] of Object.entries(file.tables)) {
      const acc = newTable();
      Object.assign(acc, { statements: t.statements, weighted: t.weighted, files: t.files, users: t.users, first: t.first, last: t.last });
      for (const g of t.aggregates) {
        const conds = new Map(g.conditions.map(({ count, ...item }) => [condKey(item), { item, count }]));
        acc.aggregates.set(key([g.fn, g.expr]), { fn: g.fn, expr: g.expr, count: g.count, conditions: conds });
      }
      for (const { count, ...item } of t.conditions) acc.conditions.set(condKey(item), { item, count });
      for (const j of t.joins) acc.joins.set(key([j.with, j.keys]), { ...j });
      for (const g of t.group_by) acc.group_by.set(key([g.column, g.grain ?? ""]), { ...g });
      for (const o of t.outside) acc.outside.set(o.table, o.count);
      a.tables.set(name, acc);
    }
    for (const s of file.not_in_snapshot) a.stale.set(s.table, { count: s.count, ...(s.last ? { last: s.last } : {}) });
    for (const x of file.ambiguous) a.ambiguous.set(x.name, x.count);
    return a;
  }

  has(sha256: string): boolean {
    return this.inputs.some((i) => i.sha256 === sha256);
  }

  // Adds one input: its statements read against the catalog, counted per table.
  add(input: Omit<UsageInput, "statements" | "skipped">, text: string, mtimeMonth: string, ctx: ReadContext): UsageInput {
    const read = readEntries(text, input.kind, ctx.queryKey);
    if ("skipped" in read) {
      const entry = { ...input, statements: 0, skipped: read.skipped };
      this.inputs.push(entry);
      return entry;
    }
    const perTable = new Map<string, { acc: TableAcc; users: Set<string> }>();
    const s = this.summary;
    let statements = read.bad;
    let notUnderstood = read.bad;
    for (const e of read.entries) {
      for (const sql of splitStatements(e.sql)) {
        const facts = readStatement(sql, ctx.catalog);
        if (facts.status === "empty") continue;
        statements++;
        const month = e.month ?? mtimeMonth;
        const kinds = [...facts.tables.values()];
        for (const [name, kind] of facts.tables) {
          if (kind === "not_in_snapshot") {
            const st = this.stale.get(name) ?? { count: 0 };
            this.stale.set(name, { count: st.count + 1, last: maxMonth(st.last, month) });
          } else if (kind === "ambiguous") this.ambiguous.set(name, (this.ambiguous.get(name) ?? 0) + 1);
        }
        if (facts.status === "not_understood") notUnderstood++;
        else if (kinds.includes("kept")) {
          s.kept++;
          this.statement(facts, e, month, perTable, ctx);
        } else if (kinds.includes("ambiguous")) s.ambiguous++;
        else if (kinds.includes("not_in_snapshot")) s.not_in_snapshot++;
        else if (kinds.includes("out_of_scope") && !kinds.includes("other")) s.out_of_scope++;
        else if (kinds.length) s.other_schemas++;
        else s.no_table++;
      }
    }
    for (const [name, { acc, users }] of perTable) {
      const t = this.tables.get(name) ?? newTable();
      t.statements += acc.statements;
      t.weighted += acc.weighted;
      t.files += 1;
      t.users += users.size;
      t.first = minMonth(t.first, acc.first);
      t.last = maxMonth(t.last, acc.last);
      for (const [k, g] of acc.aggregates) {
        const into = t.aggregates.get(k) ?? { fn: g.fn, expr: g.expr, count: 0, conditions: new Map() };
        into.count += g.count;
        addConds(into.conditions, g.conditions);
        t.aggregates.set(k, into);
      }
      addConds(t.conditions, acc.conditions);
      for (const [k, j] of acc.joins) t.joins.set(k, { ...j, count: (t.joins.get(k)?.count ?? 0) + j.count });
      for (const [k, g] of acc.group_by) t.group_by.set(k, { ...g, count: (t.group_by.get(k)?.count ?? 0) + g.count });
      for (const [k, n] of acc.outside) t.outside.set(k, (t.outside.get(k) ?? 0) + n);
      this.tables.set(name, t);
    }
    s.files++;
    s.statements += statements;
    s.not_understood += notUnderstood;
    if (notUnderstood) s.not_understood_files = [...new Set([...s.not_understood_files, input.name])].sort().slice(0, MAX_NAMED_FILES);
    const entry = { ...input, statements };
    this.inputs.push(entry);
    return entry;
  }

  // Counts one kept statement under each kept table it reads, each item once per statement.
  private statement(facts: StatementFacts, e: Entry, month: string, perTable: Map<string, { acc: TableAcc; users: Set<string> }>, ctx: ReadContext): void {
    const kept = [...facts.tables].filter(([, k]) => k === "kept").map(([n]) => n);
    const outside = [...facts.tables].filter(([, k]) => k === "other" || k === "out_of_scope").map(([n]) => n);
    const tableOf = (name: string) => {
      let x = perTable.get(name);
      if (!x) perTable.set(name, (x = { acc: newTable(), users: new Set() }));
      return x;
    };
    const cond = (c: CondFact, withTable: boolean): Omit<UsageCondition, "count"> => ({
      ...(withTable ? { table: c.table } : {}),
      column: c.column,
      ...(c.fn ? { fn: c.fn } : {}),
      op: c.op,
      values: [...new Set(c.values.map((v) => storedValue(v, ctx.isProtected(c.table, c.column))))].sort(),
    });
    const once = new Set<string>();
    const bump = <T extends { count: number }>(map: Map<string, T>, k: string, make: () => T, scope: string) => {
      if (once.has(`${scope}\0${k}`)) return;
      once.add(`${scope}\0${k}`);
      const v = map.get(k) ?? make();
      v.count++;
      map.set(k, v);
    };
    for (const name of kept) {
      const { acc, users } = tableOf(name);
      acc.statements++;
      acc.weighted += e.calls;
      acc.first = minMonth(acc.first, month);
      acc.last = maxMonth(acc.last, month);
      if (e.user) users.add(e.user);
      for (const o of outside) if (!once.has(`${name}\0outside\0${o}`)) (once.add(`${name}\0outside\0${o}`), acc.outside.set(o, (acc.outside.get(o) ?? 0) + 1));
    }
    for (const a of facts.aggregates) {
      const t = tableOf(a.table).acc;
      const k = key([a.fn, a.expr]);
      const scope = `${a.table}\0agg\0${k}`;
      let g = t.aggregates.get(k);
      if (!g) t.aggregates.set(k, (g = { fn: a.fn, expr: a.expr, count: 0, conditions: new Map() }));
      if (!once.has(scope)) {
        once.add(scope);
        g.count++;
      }
      for (const c of a.conditions) {
        const item = cond(c, true);
        const ck = condKey(item);
        if (once.has(`${scope}\0${ck}`)) continue;
        once.add(`${scope}\0${ck}`);
        const v = g.conditions.get(ck) ?? { item, count: 0 };
        v.count++;
        g.conditions.set(ck, v);
      }
    }
    for (const c of allConditions(facts)) {
      const item = cond(c, false);
      bump(tableOf(c.table).acc.conditions, condKey(item), () => ({ item, count: 0 }), c.table);
    }
    for (const j of facts.joins) {
      const keysA = j.keys.map(([x, y]) => `${x} = ${y}`);
      const keysB = j.keys.map(([x, y]) => `${y} = ${x}`).sort();
      bump(tableOf(j.a).acc.joins, key([j.b, keysA]), () => ({ with: j.b, keys: keysA, count: 0 }), j.a);
      if (j.a !== j.b) bump(tableOf(j.b).acc.joins, key([j.a, keysB]), () => ({ with: j.a, keys: keysB, count: 0 }), j.b);
    }
    for (const g of facts.groupBy) {
      const item = { column: g.column, ...(g.grain ? { grain: g.grain } : {}) };
      bump(tableOf(g.table).acc.group_by, key([g.column, g.grain ?? ""]), () => ({ ...item, count: 0 }), g.table);
    }
  }

  toFile(): UsageFile {
    const byCount = <T extends { count: number }>(xs: T[], k: (x: T) => string) => xs.sort((a, b) => b.count - a.count || (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0)).slice(0, MAX_ITEMS);
    const conds = (m: Map<string, CondAcc>) => byCount([...m.values()].map(({ item, count }) => ({ ...item, count })), (c) => condKey(c));
    const tables: Record<string, TableUsage> = {};
    for (const name of [...this.tables.keys()].sort()) {
      const t = this.tables.get(name)!;
      tables[name] = {
        statements: t.statements,
        weighted: t.weighted,
        files: t.files,
        users: t.users,
        ...(t.first ? { first: t.first } : {}),
        ...(t.last ? { last: t.last } : {}),
        aggregates: byCount(
          [...t.aggregates.values()].map((g) => ({ fn: g.fn, expr: g.expr, count: g.count, conditions: conds(g.conditions) })),
          (g) => key([g.fn, g.expr]),
        ),
        conditions: conds(t.conditions),
        joins: byCount([...t.joins.values()].map((j) => ({ ...j })), (j) => key([j.with, j.keys])),
        group_by: byCount([...t.group_by.values()].map((g) => ({ ...g })), (g) => key([g.column, g.grain ?? ""])),
        outside: byCount([...t.outside].map(([table, count]) => ({ table, count })), (o) => o.table),
      };
    }
    return {
      usage_version: USAGE_VERSION,
      source: this.source,
      inputs: [...this.inputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0)),
      summary: { ...this.summary },
      tables,
      not_in_snapshot: byCount([...this.stale].map(([table, v]) => ({ table, count: v.count, ...(v.last ? { last: v.last } : {}) })), (x) => x.table),
      ambiguous: byCount([...this.ambiguous].map(([name, count]) => ({ name, count })), (x) => x.name),
    };
  }
}

function addConds(into: Map<string, CondAcc>, from: Map<string, CondAcc>): void {
  for (const [k, c] of from) into.set(k, { item: c.item, count: (into.get(k)?.count ?? 0) + c.count });
}

// Every condition a statement holds, its aggregates' own included, once each.
function allConditions(facts: StatementFacts): CondFact[] {
  const seen = new Set<string>();
  const out: CondFact[] = [];
  for (const c of [...facts.conditions, ...facts.aggregates.flatMap((a) => a.conditions)]) {
    const k = key([c.table, c.column, c.fn ?? "", c.op, c.values]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export interface ReadContext {
  catalog: Catalog;
  queryKey?: string;
  isProtected: (table: string, column: string) => boolean;
}

export function readContext(root: string, source: string, snapshot: Snapshot, subset: Subset, queryKey?: string): ReadContext {
  let models: unknown[] = [];
  try {
    models = listModels(root, source).map((l) => l.model as unknown);
  } catch {
    models = [];
  }
  const prot = protectedColumns(snapshot.tables, models, snapshot.dialect);
  return {
    catalog: catalogFor(snapshot, subset),
    ...(queryKey ? { queryKey } : {}),
    isProtected: (table, column) => prot.get(table)?.has(column) ?? false,
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function monthOfFile(abs: string): string {
  return statSync(abs).mtime.toISOString().slice(0, 7);
}

export function writeUsage(root: string, file: UsageFile): string {
  const p = usagePath(root, file.source);
  writeFileAtomic(p, `${JSON.stringify(sortKeys(file), null, 2)}\n`, { replaceLink: true });
  return p;
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) if ((value as Record<string, unknown>)[k] !== undefined) out[k] = sortKeys((value as Record<string, unknown>)[k]);
  return out as T;
}

// --- Evidence ----------------------------------------------------------------------------------

// The words the evidence names a table by: its model's name, else the table's own name.
export interface Names {
  table: (q: string) => string;
  // The measure a model defines with this aggregate, when one does.
  measure: (q: string, fn: string, expr: string) => string | undefined;
}

export function namesFor(root: string, source: string, snapshot: Snapshot): Names {
  const byTable = new Map<string, Model>();
  let models: Model[] = [];
  try {
    models = listModels(root, source).map((l) => l.model);
  } catch {
    models = [];
  }
  for (const m of models) {
    if (typeof m?.table !== "string") continue;
    const t = snapshot.tables.find((x) => qualifiedName(x).toLowerCase() === m.table.toLowerCase() || x.name.toLowerCase() === m.table.toLowerCase());
    if (t && !byTable.has(qualifiedName(t))) byTable.set(qualifiedName(t), m);
  }
  const cols = (expr: string) => new Set(bareNames(expr).map((n) => n.v.toLowerCase()).filter((n) => /^[a-z_][a-z0-9_]*$/.test(n)));
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  return {
    table: (q) => byTable.get(q)?.model ?? q.slice(q.lastIndexOf(".") + 1),
    measure: (q, fn, expr) => {
      const m = byTable.get(q);
      if (!m || !Array.isArray(m.measures)) return undefined;
      const want = expr === "*" ? new Set<string>() : cols(expr);
      return m.measures.find((x) => x && x.agg === fn && same(cols(typeof x.expr === "string" ? x.expr : ""), want))?.name;
    },
  };
}

const VERB: Record<string, string> = {
  sum: "sum",
  count: "count",
  count_distinct: "count distinct",
  avg: "average",
  min: "take the lowest",
  max: "take the highest",
};

export function conditionText(c: Omit<UsageCondition, "count">, owner?: string, label: (q: string) => string = (q) => q.slice(q.lastIndexOf(".") + 1)): string {
  const col = `${c.table && c.table !== owner ? `${label(c.table)}.` : ""}${c.column}`;
  const subject = c.fn ? `${c.fn}(${col})` : col;
  if (c.op.endsWith("null")) return `${subject} ${c.op}`;
  if (c.op.endsWith("in")) return `${subject} ${c.op} (${c.values.join(", ")})`;
  if (c.op.endsWith("between")) return `${subject} ${c.op} ${c.values.join(" and ")}`;
  return `${subject} ${c.op} ${c.values.join(", ")}`;
}

function aggregateText(fn: string, expr: string, name: string): string {
  if (expr === "*") return fn === "count" ? `count rows of ${name}` : `${VERB[fn] ?? fn} ${name}`;
  return `${VERB[fn] ?? fn} ${name}.${expr}`;
}

// The strongest items of a table's usage, as sentences to put to the owner as evidence with a
// question: the two conditions (on different columns) most often kept with its top aggregate, the
// one most often kept with its second, its top join and its top split. An item seen in fewer than
// two statements makes no sentence.
export function evidenceSentences(q: string, t: TableUsage, names: Names): string[] {
  const out: string[] = [];
  const name = names.table(q);
  t.aggregates.slice(0, 2).forEach((g, i) => {
    if (g.count < 2) return;
    const measure = names.measure(q, g.fn, g.expr);
    const picked: UsageCondition[] = [];
    for (const c of g.conditions) {
      if (c.count < 2 || picked.length >= (i === 0 ? 2 : 1)) break;
      if (!picked.some((p) => p.table === c.table && p.column === c.column)) picked.push(c);
    }
    for (const c of picked) {
      out.push(
        `${c.count} of the ${g.count} statements that ${aggregateText(g.fn, g.expr, name)} keep only ${conditionText(c, q, names.table)}: is that the rule for ${measure ?? "that figure"}?`,
      );
    }
  });
  const j = t.joins[0];
  if (j && j.count >= 2) out.push(`${j.count} statements join ${name} to ${names.table(j.with)} on ${j.keys.join(" and ")}: is that how they relate?`);
  const s = t.group_by[0];
  if (s && s.count >= 2) out.push(`${s.count} statements split ${name} by ${s.column}${s.grain ? ` (by ${s.grain})` : ""}: is that a split you report by?`);
  return out;
}

// What sl brief and sl baseline --json carry per table: the counts, the top items and the evidence.
export interface UsageBlock {
  from: "query files";
  statements: number;
  weighted?: number;
  files?: number;
  users?: number;
  first?: string;
  last?: string;
  aggregates?: { fn: string; expr: string; count: number }[];
  conditions?: UsageCondition[];
  joins?: UsageJoin[];
  group_by?: UsageGroup[];
  evidence?: string[];
}

export function usageBlock(q: string, file: UsageFile, names: Names): UsageBlock {
  const t = file.tables[q];
  if (!t) return { from: "query files", statements: 0 };
  return {
    from: "query files",
    statements: t.statements,
    weighted: t.weighted,
    files: t.files,
    users: t.users,
    ...(t.first ? { first: t.first } : {}),
    ...(t.last ? { last: t.last } : {}),
    aggregates: t.aggregates.slice(0, 3).map(({ fn, expr, count }) => ({ fn, expr, count })),
    conditions: t.conditions.slice(0, 5),
    joins: t.joins.slice(0, 3),
    group_by: t.group_by.slice(0, 3),
    evidence: evidenceSentences(q, t, names),
  };
}

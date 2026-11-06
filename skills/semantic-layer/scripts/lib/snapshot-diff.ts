// How a source's schema changed between two snapshots, and which of a table's columns a model
// reads, so tools can report the columns a table gained or lost since its model was drafted.
import { intakeSchemas, schemaFilter } from "./intake.ts";
import { findTable, qualifiedName, splitQualified } from "./naming.ts";
import { inScope } from "./patterns.ts";
import type { Dialect, Model, Scope, Snapshot, SnapshotScopeState, SnapshotTable, SourceConfig } from "./types.ts";

export interface ColumnChanges {
  table: string;
  added: { name: string; type: string }[];
  removed: string[];
  retyped: { name: string; from: string; to: string }[];
}

export interface SnapshotDiff {
  tables_added: string[];
  tables_removed: string[];
  // Tables in both snapshots whose columns changed, in the next snapshot's order.
  columns: ColumnChanges[];
}

const normType = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

// Pairs each item of `next` with the item of `prev` of the same name: the exact name first, then
// the same name ignoring case when exactly one unpaired item on each side has it.
function pairByName<T>(prev: T[], next: T[], name: (x: T) => string): Map<T, T> {
  const pairs = new Map<T, T>();
  const exact = new Map<string, T>();
  for (const p of prev) if (!exact.has(name(p))) exact.set(name(p), p);
  const taken = new Set<T>();
  for (const n of next) {
    const p = exact.get(name(n));
    if (p && !taken.has(p)) {
      pairs.set(n, p);
      taken.add(p);
    }
  }
  const group = <U extends T>(items: U[]) => {
    const out = new Map<string, U[]>();
    for (const x of items) out.set(name(x).toLowerCase(), [...(out.get(name(x).toLowerCase()) ?? []), x]);
    return out;
  };
  const restPrev = group(prev.filter((p) => !taken.has(p)));
  const restNext = group(next.filter((n) => !pairs.has(n)));
  for (const [key, ns] of restNext) {
    const ps = restPrev.get(key);
    if (ns.length === 1 && ps?.length === 1) pairs.set(ns[0]!, ps[0]!);
  }
  return pairs;
}

// Tables and columns match by name: exactly, else ignoring case when that is unambiguous. A type
// change ignores case and spacing. With no previous snapshot, every table is added.
export function diffSnapshots(previous: Snapshot | null | undefined, next: Snapshot): SnapshotDiff {
  const prevTables = previous?.tables ?? [];
  const tablePairs = pairByName(prevTables, next.tables, qualifiedName);
  const pairedPrev = new Set(tablePairs.values());
  const diff: SnapshotDiff = { tables_added: [], tables_removed: [], columns: [] };
  for (const t of next.tables) {
    const old = tablePairs.get(t);
    if (!old) {
      diff.tables_added.push(qualifiedName(t));
      continue;
    }
    const colPairs = pairByName(old.columns, t.columns, (c) => c.name);
    const pairedCols = new Set(colPairs.values());
    const change: ColumnChanges = { table: qualifiedName(t), added: [], removed: [], retyped: [] };
    for (const c of t.columns) {
      const o = colPairs.get(c);
      if (!o) change.added.push({ name: c.name, type: c.type });
      else if (normType(o.type) !== normType(c.type)) change.retyped.push({ name: c.name, from: o.type, to: c.type });
    }
    for (const c of old.columns) if (!pairedCols.has(c)) change.removed.push(c.name);
    if (change.added.length || change.removed.length || change.retyped.length) diff.columns.push(change);
  }
  for (const t of prevTables) if (!pairedPrev.has(t)) diff.tables_removed.push(qualifiedName(t));
  return diff;
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return !diff.tables_added.length && !diff.tables_removed.length && !diff.columns.length;
}

function shortList(items: string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(", ")}, ...` : items.join(", ");
}

// Plain-English lines describing a diff, one per changed table after a line for added and
// removed tables; empty when nothing changed.
export function describeDiff(diff: SnapshotDiff, maxTables = 20): string[] {
  const lines: string[] = [];
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (diff.tables_added.length) lines.push(`${n(diff.tables_added.length, "table")} added: ${shortList(diff.tables_added, 10)}.`);
  if (diff.tables_removed.length) lines.push(`${n(diff.tables_removed.length, "table")} removed: ${shortList(diff.tables_removed, 10)}.`);
  for (const c of diff.columns.slice(0, maxTables)) {
    const parts: string[] = [];
    if (c.added.length) parts.push(`added ${c.added.map((a) => `${a.name} (${a.type})`).join(", ")}`);
    if (c.removed.length) parts.push(`removed ${c.removed.join(", ")}`);
    if (c.retyped.length) parts.push(`retyped ${c.retyped.map((r) => `${r.name} from ${r.from} to ${r.to}`).join(", ")}`);
    lines.push(`${c.table}: ${parts.join("; ")}.`);
  }
  if (diff.columns.length > maxTables) lines.push(`... and ${diff.columns.length - maxTables} more changed tables.`);
  return lines;
}

// The qualified names, as the snapshot spells them, of the in-scope tables of `snapshot` that one
// of `models` is built on. `models` may be a function that lists them; when it throws (a model
// file that does not parse), the result is undefined and callers print the general hint.
export function modeledTables(snapshot: Snapshot, models: unknown[] | (() => unknown[]), scope?: Scope): Set<string> | undefined {
  let list: unknown[];
  try {
    list = typeof models === "function" ? models() : models;
  } catch {
    return undefined;
  }
  const out = new Set<string>();
  for (const m of list) {
    const table = (m as { table?: unknown } | null)?.table;
    if (typeof table !== "string") continue;
    const t = findTable(snapshot.tables, table);
    if (t && inScope(scope, t)) out.add(qualifiedName(t));
  }
  return out;
}

// The lines sl introspect and sl import print about how the schema changed since the previous
// snapshot, with the command that drafts new columns and the check for removed ones. With
// `modeled` (from modeledTables), the drafting hint names only the modeled in-scope tables that
// gained columns, and is left out when there are none.
export function changeLines(diff: SnapshotDiff | null, source: string, modeled?: Set<string>): string[] {
  if (!diff) return [];
  if (isEmptyDiff(diff)) return ["No tables or columns changed since the previous snapshot."];
  const lines = ["Changes since the previous snapshot:", ...describeDiff(diff).map((l) => `  ${l}`)];
  const gained = diff.columns.filter((c) => c.added.length).map((c) => c.table);
  const lost = diff.columns.some((c) => c.removed.length || c.retyped.length) || diff.tables_removed.length > 0;
  const command = `\`sl draft --source ${source} --new-columns\``;
  if (!modeled) {
    if (gained.length) lines.push(`Columns were added: ${command} drafts the new columns of modeled tables.`);
  } else {
    const tables = gained.filter((t) => modeled.has(t));
    if (tables.length) lines.push(`Modeled tables gained columns (${shortList(tables, 10)}): ${command} drafts them.`);
  }
  if (lost) lines.push("Removed or retyped columns and tables: `sl validate` reports the fields that read a removed column; read the affected fields back to the owner.");
  return lines;
}

// Scope changes

export interface ModelOnTable {
  model: string;
  table: string;
}

// How the selection changed between two snapshots: the tables that entered it and have no model
// (new_in_scope), every table that left it (left_scope), and the approved models on those.
export interface ScopeChanges {
  new_in_scope: string[];
  left_scope: string[];
  left_scope_with_models: ModelOnTable[];
}

type Named = { schema?: string | null; name: string };

// Whether a table is in the source's selection: in the effective scope and, when intake.schemas
// lists schemas, in one of them. An intake.schemas that is not a list of names is left out, so
// sl status still reads a source sl validate would refuse.
export function selectionMatcher(source: Pick<SourceConfig, "source" | "dialect" | "connection" | "intake">, scope: Scope | undefined): (t: Named) => boolean {
  let schemas: string[] = [];
  try {
    schemas = intakeSchemas(source);
  } catch {
    schemas = [];
  }
  const wanted = schemas.length ? schemaFilter(source, schemas) : () => true;
  return (t) => inScope(scope, t) && wanted(t.schema);
}

const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sortedUnique = (items: string[]) => [...new Set(items)].sort();

// A snapshot's recorded selection, read defensively: a hand-edited file may hold anything.
export function readScopeState(snapshot: Snapshot | null | undefined): SnapshotScopeState | undefined {
  const raw: unknown = snapshot?.scope_state;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return { in_scope: textList(r.in_scope), new_in_scope: textList(r.new_in_scope), left_scope: textList(r.left_scope) };
}

// The approved models built on one of the tables `names` lists, each with the table as `names`
// spells it, sorted by model. A model's table is looked up in `tables` first, then among `names`
// themselves, so a table the snapshot no longer has still counts.
export function approvedModelsOn(names: string[], tables: SnapshotTable[], models: unknown[]): ModelOnTable[] {
  if (!names.length) return [];
  const wanted = new Set(names);
  const named = names.map((n) => ({ ...splitQualified(n), kind: "table" as const, columns: [] }));
  const out: ModelOnTable[] = [];
  for (const m of models) {
    const { model, table, status } = (m && typeof m === "object" ? m : {}) as { model?: unknown; table?: unknown; status?: unknown };
    if (status !== "approved" || typeof model !== "string" || typeof table !== "string") continue;
    const t = findTable(tables, table) ?? findTable(named, table);
    if (t && wanted.has(qualifiedName(t))) out.push({ model, table: qualifiedName(t) });
  }
  return out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

// Compares the selection of `next` with the one `previous` recorded (its scope_state.in_scope, or,
// for a snapshot written before scope_state existed, its tables the current selection keeps), and
// records next's in next.scope_state. new_in_scope there keeps the earlier entries still selected,
// and left_scope the earlier ones still out, so a rerun before the follow-up keeps them; tables
// with a model leave new_in_scope, and left_scope keeps only tables with an approved model. When
// `models` throws (a model file that does not parse), no table counts as modeled. Null when there
// is no previous snapshot.
export function recordScope(previous: Snapshot | null | undefined, next: Snapshot, selected: (t: Named) => boolean, models: () => unknown[]): ScopeChanges | null {
  const now = sortedUnique(next.tables.filter(selected).map(qualifiedName));
  const nowSet = new Set(now);
  let list: unknown[] | undefined;
  try {
    list = models();
  } catch {
    list = undefined;
  }
  const modeled = new Set<string>();
  for (const m of list ?? []) {
    const table = (m as { table?: unknown } | null)?.table;
    const t = typeof table === "string" ? findTable(next.tables, table) : undefined;
    if (t) modeled.add(qualifiedName(t));
  }
  if (!previous) {
    next.scope_state = { in_scope: now, new_in_scope: [], left_scope: [] };
    return null;
  }
  const prior = readScopeState(previous);
  const before = new Set(prior ? prior.in_scope : previous.tables.filter(selected).map(qualifiedName));
  const entered = now.filter((n) => !before.has(n) && !modeled.has(n));
  const left = sortedUnique([...before].filter((n) => !nowSet.has(n)));
  const withModels = approvedModelsOn(left, previous.tables, list ?? []);
  const carriedNew = (prior?.new_in_scope ?? []).filter((n) => nowSet.has(n) && !modeled.has(n));
  const allLeft = sortedUnique([...(prior?.left_scope ?? []).filter((n) => !nowSet.has(n)), ...left]);
  const keepLeft = list ? new Set(approvedModelsOn(allLeft, next.tables, list).map((x) => x.table)) : new Set(allLeft);
  next.scope_state = { in_scope: now, new_in_scope: sortedUnique([...carriedNew, ...entered]), left_scope: allLeft.filter((n) => keepLeft.has(n)) };
  return { new_in_scope: entered, left_scope: left, left_scope_with_models: withModels };
}

// Names --tables reads as they are: --tables splits on commas and reads * as a glob.
const PLAIN_NAME = /^[A-Za-z0-9_.]+$/;
const MAX_NAMED = 8;

// " --tables a,b" naming `names`, or "" when there are more than MAX_NAMED or one is not plain,
// so the command then covers the whole source.
export function tablesFlag(names: string[]): string {
  return names.length && names.length <= MAX_NAMED && names.every((n) => PLAIN_NAME.test(n)) ? ` --tables ${names.join(",")}` : "";
}

// The lines sl introspect and sl import print about tables that entered or left the selection,
// with the command that drafts the new ones and what to do about approved models that left.
// Tables in `removed` (gone from the database, which the change lines name) are not named again.
export function scopeLines(changes: ScopeChanges | null, source: string, removed: string[] = []): string[] {
  if (!changes) return [];
  const lines: string[] = [];
  const { new_in_scope: entered, left_scope: left, left_scope_with_models: models } = changes;
  if (entered.length) {
    lines.push(
      `New in scope, with no model yet: ${shortList(entered, 10)}. \`sl draft --source ${source}${tablesFlag(entered)}\` drafts ${entered.length === 1 ? "it" : "them"}.`,
    );
  }
  const gone = new Set(removed.map((n) => n.toLowerCase()));
  const unmatched = left.filter((n) => !gone.has(n.toLowerCase()));
  if (unmatched.length) {
    lines.push(
      `Left scope, no longer matching the scope or intake.schemas: ${shortList(unmatched, 10)}. \`sl scope --source ${source}\` shows what the scope selects.`,
    );
  }
  if (models.length) {
    const items = models.map((m) => `${m.model} (${m.table})`);
    lines.push(
      `Warning: left scope with approved models: ${shortList(items, 10)}. The models are kept and still served. Ask the owner whether each still belongs: ` +
        `to keep it, bring its table back into scope (\`sl scope --source ${source} --tables <table> --write\`, or restore the pattern or intake.schemas entry that selected it); ` +
        `otherwise revoke it with \`sl approve --target ${source}.<model> --revoke\` or remove its model file. \`sl status\` lists them until then.`,
    );
  }
  return lines;
}

// Column usage

interface Ident {
  v: string;
  quoted: boolean;
}

// Date and time units that some functions take as a bare word rather than a string.
const DATE_UNITS = new Set(
  (
    "year years yyyy yy quarter quarters qtr month months mon mm week weeks wk isoweek isoyear week_iso weekiso yearofweek " +
    "yearofweekiso day days dd dayofweek dayofweekiso dayofmonth dayofyear dow doy hour hours hh minute minutes mi second " +
    "seconds ss millisecond milliseconds ms microsecond microseconds us nanosecond nanoseconds ns epoch date time datetime " +
    "century decade millennium timezone_hour timezone_minute"
  ).split(" "),
);
// Snowflake and Databricks functions whose first argument may be a bare unit: datediff(day, a, b),
// date_trunc(month, d).
const UNIT_FIRST = new Set(["datediff", "dateadd", "date_part", "datepart", "date_trunc", "timediff", "timeadd", "timestampdiff", "timestampadd", "time_slice"]);
// BigQuery functions whose last argument may be a bare unit: date_diff(a, b, day), date_trunc(d, month).
const UNIT_LAST = new Set([
  "date_diff",
  "datetime_diff",
  "timestamp_diff",
  "time_diff",
  "date_trunc",
  "datetime_trunc",
  "timestamp_trunc",
  "time_trunc",
  "last_day",
  "time_slice",
]);

// The identifiers in a SQL expression that may name one of the model's own columns: a bare name or
// the first part of a dotted name, that is not a function call or the type after ::. String
// literals and comments are skipped, and so are bare words in keyword positions: the type of a
// cast(x as <type>) and of a typed literal (date '...'), the unit of extract(<unit> from x), of
// interval 1 <unit> and of the date functions that take a bare unit in the dialect, and
// `at time zone`. Other keywords come back too; a caller keeps the ones that are columns.
export function sqlIdentifiers(sql: string, dialect?: Dialect): Ident[] {
  const backslash = dialect === "snowflake" || dialect === "bigquery" || dialect === "databricks";
  const doubleIsString = dialect === "bigquery" || dialect === "databricks";
  const unitFirst = dialect === "snowflake" || dialect === "databricks";
  type Tok = { t: "id"; v: string; quoted: boolean } | { t: "." | "(" | ")" | "," | "::" | "s" | "n" | "x" };
  const toks: Tok[] = [];
  let i = 0;
  const stringEnd = (q: string, from: number) => {
    let j = from + 1;
    for (; j < sql.length; j++) {
      if (backslash && sql[j] === "\\") {
        j++;
        continue;
      }
      if (sql[j] !== q) continue;
      if (sql[j + 1] === q) j++;
      else break;
    }
    return j + 1;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (/\s/.test(c)) i++;
    else if (c === "'" || (c === '"' && doubleIsString)) {
      i = stringEnd(c, i);
      toks.push({ t: "s" });
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
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
      toks.push({ t: "id", v, quoted: true });
    } else if (/\d/.test(c)) {
      i += sql.slice(i).match(/^\d+\.?\d*(?:e[+-]?\d+)?/i)![0].length;
      toks.push({ t: "n" });
    } else if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)![0];
      i += word.length;
      toks.push({ t: "id", v: word, quoted: false });
    } else if (c === ":" && next === ":") {
      i += 2;
      toks.push({ t: "::" });
    } else if (c === "." || c === "(" || c === ")" || c === ",") {
      i++;
      toks.push({ t: c });
    } else {
      i++;
      toks.push({ t: "x" });
    }
  }
  // The lowercased word at k when it is an unquoted identifier.
  const word = (k: number): string | undefined => {
    const t = toks[k];
    return t?.t === "id" && !t.quoted ? t.v.toLowerCase() : undefined;
  };
  // The name of the call whose argument list holds token k, when k is inside one.
  const enclosingCall = (k: number): string | undefined => {
    let depth = 0;
    for (let j = k - 1; j >= 0; j--) {
      const t = toks[j]!.t;
      if (t === ")") depth++;
      else if (t === "(") {
        if (depth === 0) return word(j - 1);
        depth--;
      }
    }
    return undefined;
  };
  const keywordPosition = (k: number, w: string): boolean => {
    const prev = toks[k - 1]?.t;
    const next = toks[k + 1]?.t;
    const prevWord = word(k - 1);
    if (prevWord === "as") return true;
    if (next === "s") return true;
    if (w === "time" && (prevWord === "at" || prevWord === "with" || prevWord === "without" || prevWord === "local")) return true;
    if (w === "zone" && prevWord === "time") return true;
    if (w === "local" && prevWord === "with") return true;
    if ((w === "with" || w === "without") && (prevWord === "timestamp" || prevWord === "time")) return true;
    if (w === "precision" && prevWord === "double") return true;
    if (w === "varying" && prevWord === "character") return true;
    if ((prev === "n" || prev === "s") && word(k - 2) === "interval") return true;
    if (prev === "(" && (word(k - 2) === "extract" || word(k - 2) === "date_part" || word(k - 2) === "datepart") && (word(k + 1) === "from" || next === ",")) {
      return true;
    }
    if (!DATE_UNITS.has(w)) return false;
    if (unitFirst && prev === "(" && next === "," && UNIT_FIRST.has(word(k - 2) ?? "")) return true;
    if (dialect === "bigquery" && prev === "," && next === ")" && UNIT_LAST.has(enclosingCall(k) ?? "")) return true;
    return false;
  };
  const out: Ident[] = [];
  toks.forEach((tok, k) => {
    if (tok.t !== "id") return;
    const prev = toks[k - 1]?.t;
    if (prev === "." || prev === "::") return;
    if (toks[k + 1]?.t === "(") return;
    if (!tok.quoted && keywordPosition(k, tok.v.toLowerCase())) return;
    out.push({ v: tok.v, quoted: tok.quoted });
  });
  return out;
}

// Join keys of other models that point at this model: their keys' `to` columns.
export function incomingKeyColumns(model: Pick<Model, "model">, models: Pick<Model, "model" | "joins">[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    for (const j of Array.isArray(m.joins) ? m.joins : []) {
      if (j?.to !== model.model) continue;
      for (const k of Array.isArray(j.keys) ? j.keys : []) if (typeof k?.to === "string") out.push(k.to);
    }
  }
  return out;
}

// The columns of `table` the model reads: bare columns (and the first part of dotted names that
// are not join references) in dimension exprs, measure exprs and filters, its joins' `from`
// keys, its primary key, and `extraKeys` (the keys other models join to it on). Names match the
// snapshot's columns ignoring case, except a quoted name that matches one exactly. Returned in
// the table's column order, as the snapshot spells them.
export function referencedColumns(model: Model, table: SnapshotTable, dialect?: Dialect, extraKeys: string[] = []): string[] {
  const exact = new Set<string>();
  const loose = new Set<string>();
  const joins = new Set((Array.isArray(model.joins) ? model.joins : []).map((j) => (typeof j?.name === "string" ? j.name.toLowerCase() : "")));
  const exprs: string[] = [];
  for (const d of Array.isArray(model.dimensions) ? model.dimensions : []) if (typeof d?.expr === "string") exprs.push(d.expr);
  for (const m of Array.isArray(model.measures) ? model.measures : []) {
    if (typeof m?.expr === "string") exprs.push(m.expr);
    if (typeof m?.filter === "string") exprs.push(m.filter);
  }
  for (const sql of exprs) {
    for (const id of sqlIdentifiers(sql, dialect)) {
      if (!id.quoted && joins.has(id.v.toLowerCase())) continue;
      if (id.quoted) exact.add(id.v);
      else loose.add(id.v.toLowerCase());
    }
  }
  const names: string[] = [...extraKeys];
  for (const j of Array.isArray(model.joins) ? model.joins : []) {
    for (const k of Array.isArray(j?.keys) ? j.keys : []) if (typeof k?.from === "string") names.push(k.from);
  }
  for (const c of Array.isArray(model.primary_key) ? model.primary_key : []) if (typeof c === "string") names.push(c);
  for (const n of names) {
    const trimmed = n.trim().replace(/^["`](.*)["`]$/, "$1");
    loose.add(trimmed.toLowerCase());
  }
  return table.columns.filter((c) => exact.has(c.name) || loose.has(c.name.toLowerCase())).map((c) => c.name);
}

// The model's columns of `table` that no field, join key or primary key reads and that
// ignored_columns does not list (ignoring case), in the table's column order.
export function unreferencedColumns(model: Model, table: SnapshotTable, dialect?: Dialect, extraKeys: string[] = []): SnapshotTable["columns"] {
  const used = new Set(referencedColumns(model, table, dialect, extraKeys));
  const ignored = new Set((Array.isArray(model.ignored_columns) ? model.ignored_columns : []).filter((c) => typeof c === "string").map((c) => c.toLowerCase()));
  return table.columns.filter((c) => !used.has(c.name) && !ignored.has(c.name.toLowerCase()));
}

// Bare columns a model's fields name that are not columns of `table`, per field. Only exprs that are
// a single bare or quoted identifier are checked, the way sl validate checks them.
export function missingColumns(model: Model, table: SnapshotTable): { field: string; column: string }[] {
  const has = (name: string, quoted: boolean) =>
    table.columns.some((c) => (quoted ? c.name === name : c.name.toLowerCase() === name.toLowerCase()));
  const out: { field: string; column: string }[] = [];
  const check = (field: string, expr: unknown) => {
    if (typeof expr !== "string") return;
    const t = expr.trim();
    const q = t.match(/^"((?:[^"]|"")+)"$/) ?? t.match(/^`((?:[^`]|``)+)`$/);
    if (q) {
      const name = q[1]!.replace(/""/g, '"').replace(/``/g, "`");
      if (!has(name, true) && !has(name, false)) out.push({ field, column: name });
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t) && !/^(true|false|null)$/i.test(t) && !has(t, false)) out.push({ field, column: t });
  };
  for (const d of Array.isArray(model.dimensions) ? model.dimensions : []) check(d?.name, d?.expr);
  for (const m of Array.isArray(model.measures) ? model.measures : []) check(m?.name, m?.expr);
  return out;
}

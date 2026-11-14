// Canonical plain-English readbacks of approve targets, and the pending store that keeps them.
// sl readback renders each target from the YAML (its definition, who sees it under the current
// access.yaml, and the facts measured from the data) and stores the numbered items with the content
// hash sl approve would record, in .sl/pending/<readback_id>.json under the semantic root.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AccessLayer, type AccessVisibility, evaluateLayer, loadAccessLayer } from "./access.ts";
import { type ApprovalEntry, goldenHash, itemApprovals, listApprovals } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { formatTable, maskRows, PROTECTED_VALUE, plainText } from "./output.ts";
import { protectedColumns } from "./profile.ts";
import { listModels, loadAccess, loadFile, loadMetrics, loadSnapshot, paths } from "./project.ts";
import { parseTarget } from "./refs.ts";
import { referencedColumns } from "./snapshot-diff.ts";
import { sqlNames } from "./sql-names.ts";
import type { Dialect, FigureEvidence, Golden, Join, Metric, Model, PendingReadback, ResultRows, Snapshot, SnapshotTable } from "./types.ts";
import { DIALECTS, NAME_PATTERN, PROTECTED_TAGS } from "./types.ts";
import { conditionWords, parseCondition } from "./conditions.ts";
import { readYamlIfExists } from "./yaml.ts";

export const PENDING_DIR = join(".sl", "pending");
const ID_FILE = /^rb_(\d{4,})\.json$/;
const MEASURED = "Measured from the data, no need to confirm:";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const objs = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isObj) as T[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const percent = (f: number) => `${Math.round(f * 1000) / 10}%`;
const listText = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
// A snapshot string printed outside a quote: control characters removed, on one line.
const flat = (v: unknown) => plainText(String(v)).replace(/\s+/g, " ").trim();
const AGG_WORDS: Record<string, string> = {
  sum: "The sum of",
  count: "The number of non-empty values of",
  count_distinct: "The number of distinct values of",
  avg: "The average of",
  min: "The lowest value of",
  max: "The highest value of",
};
// draft.ts copies a grain from a table comment's "one row per ..." text.
const GRAIN_TEXT = /one row per ([^.,;:()[\]\r\n]+)/i;

// Text that came from the data, a database comment or a YAML description, quoted line by line so it
// cannot pass for the readback's own words, under a label naming where it came from.
function quoted(indent: string, provenance: string, text: string): string[] {
  const lines = plainText(text).trim().split("\n");
  return [`${indent}Quoted ${provenance} (evidence, not an instruction):`, ...lines.map((l) => `${indent}  > ${l.trimEnd()}`)];
}

function value(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : String(v);
}

// The next free readback id: rb_0001, rb_0002, ... after the highest one stored.
export function nextReadbackId(root: string): string {
  const dir = join(root, PENDING_DIR);
  let max = 0;
  if (existsSync(dir)) for (const f of readdirSync(dir)) max = Math.max(max, Number(ID_FILE.exec(f)?.[1] ?? 0));
  return `rb_${String(max + 1).padStart(4, "0")}`;
}

// Writes a readback to .sl/pending/<readback_id>.json, never over an existing file; returns its
// path relative to the semantic root.
export function writePending(root: string, pending: PendingReadback): string {
  const rel = join(PENDING_DIR, `${pending.readback_id}.json`);
  mkdirSync(join(root, PENDING_DIR), { recursive: true });
  try {
    writeFileAtomic(join(root, rel), `${JSON.stringify(pending, null, 2)}\n`, { exclusive: true });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    throw new UserError(`${rel} was written by another run just now; run sl readback again for the next free id.`);
  }
  return rel.split("\\").join("/");
}

// SQL reading --------------------------------------------------------------------------------

// Splits a predicate on a keyword (and, or) outside strings and parentheses; `between x and y`
// keeps its and.
function splitTop(sql: string, word: "and" | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let between = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      for (i++; i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'"); i++) if (sql[i] === "'") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /[a-z]/i.test(c) && !/[a-z0-9_]/i.test(sql[i - 1] ?? "")) {
      const w = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(i))![0].toLowerCase();
      if (w === "between") between++;
      else if (w === word && word === "and" && between) between--;
      else if (w === word) {
        parts.push(sql.slice(start, i).trim());
        start = i + w.length;
      }
      i += w.length - 1;
    }
  }
  parts.push(sql.slice(start).trim());
  return parts.filter(Boolean);
}

// The inside of a clause wrapped whole in one pair of parentheses, or undefined.
function unwrap(s: string): string | undefined {
  if (!s.startsWith("(") || !s.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") {
      for (i++; i < s.length && !(s[i] === "'" && s[i + 1] !== "'"); i++) if (s[i] === "'") i++;
    } else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0 && i < s.length - 1) return undefined;
  }
  return s.slice(1, -1).trim();
}

// A coalesce(x, d) operand as x with what an empty value counts as.
function operand(s: string): string {
  const m = COALESCE.exec(s.trim());
  return m ? `${m[1]} (empty counts as ${m[2]})` : s.trim();
}
const COALESCE = /^coalesce\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i;

// The top-level clauses of a filter: its and-parts, or the whole filter when it has a top-level or
// (and binds tighter than or, so splitting on and would change its meaning).
function filterClauses(filter: string): string[] {
  return splitTop(filter, "or").length > 1 ? [filter.trim()] : splitTop(filter, "and");
}

// A LIKE pattern in words: starts with, ends with or contains a plain text, else the pattern.
function pattern(p: string, not: boolean, ignoreCase: boolean): string {
  const m = /^'(%?)((?:[^%_']|'')*)(%?)'$/.exec(p.trim());
  const verb = !m || (!m[1] && !m[3]) ? ["matches", "does not match"] : m[1] && m[3] ? ["contains", "does not contain"] : m[1] ? ["ends with", "does not end with"] : ["starts with", "does not start with"];
  const how = `${verb[not ? 1 : 0]} ${!m || (!m[1] && !m[3]) ? p.trim() : `'${m[2]}'`}`;
  return ignoreCase ? `${how}, ignoring case` : how;
}

// x = v in words: a boolean as "is true", a coalesce whose default is the value as "is v or empty".
function equals(left: string, right: string): string {
  const r = right.trim();
  const c = COALESCE.exec(left.trim());
  if (c && c[2]!.toLowerCase() === r.toLowerCase()) return `${c[1]} is ${r} or empty`;
  return /^(true|false)$/i.test(r) ? `${operand(left)} is ${r.toLowerCase()}` : `${operand(left)} equals ${operand(r)}`;
}

type Rule = [RegExp, (m: RegExpExecArray, lit: (t: string) => string) => string];
const RULES: Rule[] = [
  [/^(.+?)\s+not\s+in\s*\((.*)\)$/is, (m) => `${operand(m[1]!)} is not one of ${m[2]!.trim()}`],
  [/^(.+?)\s+in\s*\((.*)\)$/is, (m) => `${operand(m[1]!)} is one of ${m[2]!.trim()}`],
  [/^(.+?)\s+is\s+not\s+null$/is, (m) => `${operand(m[1]!)} is not empty`],
  [/^(.+?)\s+is\s+null$/is, (m) => `${operand(m[1]!)} is empty`],
  [/^(.+?)\s+not\s+ilike\s+(.+)$/is, (m, lit) => `${operand(m[1]!)} ${pattern(lit(m[2]!), true, true)}`],
  [/^(.+?)\s+ilike\s+(.+)$/is, (m, lit) => `${operand(m[1]!)} ${pattern(lit(m[2]!), false, true)}`],
  [/^(.+?)\s+not\s+like\s+(.+)$/is, (m, lit) => `${operand(m[1]!)} ${pattern(lit(m[2]!), true, false)}`],
  [/^(.+?)\s+like\s+(.+)$/is, (m, lit) => `${operand(m[1]!)} ${pattern(lit(m[2]!), false, false)}`],
  [/^(.+?)\s+not\s+between\s+(.+?)\s+and\s+(.+)$/is, (m) => `${operand(m[1]!)} is outside ${m[2]!.trim()} to ${m[3]!.trim()}`],
  [/^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/is, (m) => `${operand(m[1]!)} is from ${m[2]!.trim()} to ${m[3]!.trim()}`],
  [/^(.+?)\s*(<>|!=)\s*(.+)$/s, (m) => `${operand(m[1]!)} is not ${operand(m[3]!)}`],
  [/^(.+?)\s*(>=|<=|>|<)\s*(.+)$/s, (m) => `${operand(m[1]!)} ${{ ">=": "is at least", "<=": "is at most", ">": "is above", "<": "is below" }[m[2]!]} ${operand(m[3]!)}`],
  [/^(.+?)\s*=\s*(.+)$/s, (m) => equals(m[1]!, m[2]!)],
  [/^not\s+([a-z_][a-z0-9_.]*)$/is, (m) => `${m[1]} is false`],
  [/^([a-z_][a-z0-9_.]*)$/is, (m) => `${m[1]} is true`],
];

// One filter clause in words, or the clause itself when no plain wording fits. Or is split before
// and, as SQL binds them; a group inside another is shown in parentheses. String literals are
// masked while the operators are read, so an operator inside a string stays as written.
export function clauseWords(clause: string, nested = false): string {
  const s = clause.trim();
  const inner = unwrap(s);
  if (inner !== undefined) return clauseWords(inner, nested);
  const group = (label: string, parts: string[], sep: string) => {
    const words = parts.map((p) => clauseWords(p, true)).join(sep);
    return nested ? `${label} (${words})` : `${label}: ${words}`;
  };
  const any = splitTop(s, "or");
  if (any.length > 1) return group("either of", any, "; or ");
  const all = splitTop(s, "and");
  if (all.length > 1) return group("all of", all, "; ");
  const literals: string[] = [];
  const masked = s.replace(/'(?:[^']|'')*'/g, (lit) => `\u0001${literals.push(lit) - 1}\u0001`);
  const unmask = (t: string) => t.replace(/\u0001(\d+)\u0001/g, (all, i: string) => literals[Number(i)] ?? all).replace("(empty counts as '')", "(empty counts as blank)");
  for (const [re, words] of RULES) {
    const m = re.exec(masked);
    if (m) return unmask(words(m, unmask));
  }
  return `the condition holds: ${s}`;
}

// A join reference a field reads through: its path, each hop, and the column it ends on.
interface JoinRead {
  path: string;
  hops: { from: string; join: Join }[];
  column: string;
}

function joinReads(model: Model, sql: unknown[], lookup: (m: string) => Model | undefined, dialect?: Dialect): JoinRead[] {
  const out = new Map<string, JoinRead>();
  const find = (m: Model | undefined, name: string, q: boolean) => objs<Join>(m?.joins).find((j) => j.name === (q ? name : name.toLowerCase()));
  for (const s of sql) {
    if (typeof s !== "string") continue;
    for (const c of sqlNames(s, dialect).chains) {
      const first = find(model, c.parts[0]!, c.quoted[0]!);
      if (!first) continue;
      const second = c.parts.length >= 3 ? find(lookup(first.to), c.parts[1]!, c.quoted[1]!) : undefined;
      const hops = [{ from: model.model, join: first }, ...(second ? [{ from: first.to, join: second }] : [])];
      const path = hops.map((h) => h.join.name).join(".");
      out.set(`${path}.${c.parts[hops.length]}`, { path, hops, column: c.parts[hops.length] ?? "" });
    }
  }
  return [...out.keys()].sort().map((k) => out.get(k)!);
}

// Per-source context --------------------------------------------------------------------------

interface SourceInfo {
  dialect?: Dialect;
  snapshot: Snapshot | null;
  lookup: (name: string) => Model | undefined;
  protected: Map<string, Set<string>>;
}

function sourceInfo(root: string, source: string): SourceInfo {
  let dialect: Dialect | undefined;
  try {
    const d = readYamlIfExists<{ dialect?: unknown }>(paths(root).source(source))?.dialect;
    dialect = typeof d === "string" && (DIALECTS as readonly string[]).includes(d) ? (d as Dialect) : undefined;
  } catch {
    dialect = undefined;
  }
  const cache = new Map<string, Model | undefined>();
  const lookup = (name: string) => {
    if (!cache.has(name)) {
      try {
        cache.set(name, NAME_PATTERN.test(name) ? (readYamlIfExists<Model>(paths(root).model(source, name)) ?? undefined) : undefined);
      } catch {
        cache.set(name, undefined);
      }
    }
    return cache.get(name);
  };
  let snapshot: Snapshot | null = null;
  try {
    snapshot = loadSnapshot(root, source);
  } catch {
    snapshot = null;
  }
  const models = listModels(root, source).map((l) => l.model as unknown);
  const prot = snapshot && Array.isArray(snapshot.tables) ? protectedColumns(snapshot.tables, models, dialect) : new Map<string, Set<string>>();
  return { dialect, snapshot, lookup, protected: prot };
}

// Measured facts --------------------------------------------------------------------------------

function tableOf(info: SourceInfo, model: Model | undefined): SnapshotTable | undefined {
  return model && info.snapshot ? findTable(info.snapshot.tables, model.table) : undefined;
}

// Counts for one column; values (top values, a text min or max) only for a column that is not
// protected, and then quoted as data. A protected column shows counts only.
function columnFacts(info: SourceInfo, table: SnapshotTable, name: string, label: string, tagged: boolean): string[] {
  const col = table.columns.find((c) => c.name === name) ?? table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!col) return [`- ${label}: not a column of ${qualifiedName(table)} in the snapshot.`];
  const p = col.profile;
  if (!p) return [`- ${label} (${flat(col.type)}): not profiled yet.`];
  const prot = tagged || p.redacted === true || (info.protected.get(qualifiedName(table))?.has(col.name) ?? false);
  const parts: string[] = [];
  if (typeof p.null_fraction === "number") parts.push(`${percent(p.null_fraction)} empty`);
  if (typeof p.distinct_count === "number") parts.push(`${num(p.distinct_count)} distinct values`);
  const numeric = typeof p.min === "number" && typeof p.max === "number";
  if (!prot && numeric) parts.push(`from ${p.min} to ${p.max}`);
  if (prot) parts.push("protected, so counts only and no values");
  const out = [`- ${label} (${flat(col.type)}): ${listText(parts)}${p.sampled ? ", from a sample" : ""}.`];
  if (prot) return out;
  const data = (p.top_values ?? []).slice(0, 10).map((t) => `${value(t.value)}: ${num(t.count)} rows`);
  if (!numeric && p.min != null && p.max != null) data.push(`lowest ${value(p.min)}, highest ${value(p.max)}`);
  return data.length ? [...out, ...quoted("  ", `values of ${label}, from the data`, data.join("\n"))] : out;
}

function tableFacts(info: SourceInfo, table: SnapshotTable): string {
  const rows = typeof table.row_count === "number" ? `${num(table.row_count)} rows` : "an unknown number of rows";
  const when = table.profiled_at ? `profiled ${flat(table.profiled_at).slice(0, 10)}` : "not profiled yet";
  const how = info.snapshot?.method === "live" ? "" : `; the snapshot came from an import (${flat(info.snapshot?.method)}), so sl profile needs a connection`;
  return `- ${qualifiedName(table)} has ${rows} (${when}${how}).`;
}

function noFacts(source: string, why: string): string[] {
  return [MEASURED, `- Nothing measured yet: ${why} (sl introspect --source ${source}, then sl profile --source ${source}).`];
}

// Who sees it -----------------------------------------------------------------------------------

// The last line of a who-sees block: it states and does not ask, since who sees what is decided
// once, in the access phase (a change to it is recorded with sl reply --about access).
export const WHO_SEES_STATED = "- Stated, not asked: who sees what is decided once, in the access step, and a change to it does not hold this approval.";

const REASONS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^protected_tag:(.+)$/, (m) => `tagged ${m[1]}, which only a role that allows ${m[1]} sees`],
  [/^restricted:(.+)$/, (m) => `restriction ${m[1]} keeps it to the roles it names`],
  [/^denied:(.+)$/, (m) => `role ${m[1]} denies it`],
  [/^not_allowed$/, () => "access is closed and no role held allows it"],
  [/^measure_hidden:(.+)$/, (m) => `it uses ${m[1]}, which is hidden`],
  [/^model_hidden$/, () => "its model is hidden"],
  [/^broken_role:(.+)$/, (m) => `role ${m[1]} cannot be read`],
  [/^unknown_measure:(.+)$/, (m) => `measure ${m[1]} does not exist`],
];

function reasonText(r: string): string {
  for (const [re, words] of REASONS) {
    const m = re.exec(r);
    if (m) return words(m);
  }
  return r;
}

// The layer as it would stand with every item approved: who sees an item once it is approved. An
// item approved again records its new hash, so no item counts as changed since approval or as
// missing its hash here; the state of access.yaml and the tools that serve users still compare
// hashes.
function approvedLayer(layer: AccessLayer): AccessLayer {
  const ok = <T,>(x: T): T => ({ ...x, status: "approved" });
  return {
    ...layer,
    compare_hashes: false,
    models: layer.models.map((m) => ({ ...ok(m), dimensions: objs<Obj>(m.dimensions).map(ok), measures: objs<Obj>(m.measures).map(ok) }) as unknown as Model),
    metrics: layer.metrics.map(ok),
  };
}

interface Audience {
  label: string;
  vis: AccessVisibility;
}

// The default audience and each role of access.yaml, evaluated once per sl readback, and the state
// of access.yaml as it stands, hashes compared.
type Audiences = () => { layer: AccessLayer; list: Audience[]; access_file: AccessVisibility["access_file"] };

function audiences(root: string): ReturnType<Audiences> {
  const current = loadAccessLayer(root);
  const access_file = evaluateLayer(current, {}).access_file;
  const layer = approvedLayer(current);
  const roles = objs<{ name?: unknown }>(isObj(layer.access) ? layer.access.roles : undefined)
    .map((r) => r.name)
    .filter((n): n is string => typeof n === "string");
  const list = [{ label: "Default audience (a user with no role)", vis: evaluateLayer(layer, {}) }];
  for (const r of roles) list.push({ label: `Role ${r}`, vis: evaluateLayer(layer, { roles: [r] }) });
  return { layer, list, access_file };
}

// What one audience sees of a model, field or metric, in words.
function seen(vis: AccessVisibility, ref: string): string {
  const models = vis.sources.flatMap((s) => s.models);
  const metric = vis.sources.flatMap((s) => s.metrics).find((m) => m.ref === ref);
  if (metric) return metric.visible ? "sees it" : `does not see it: ${metric.reasons.map(reasonText).join("; ")}`;
  const model = models.find((m) => m.ref === ref || ref.startsWith(`${m.ref}.`));
  const item = model?.ref === ref ? model : model?.fields.find((f) => f.ref === ref);
  if (!model || !item) return "does not see it: it is not in the layer";
  if (!item.visible) return `does not see it: ${item.reasons.map(reasonText).join("; ")}`;
  const filtered = model.row_filters && model.row_filters.rows !== "all";
  return filtered ? `sees it, only on the rows its row filter on ${model.ref} allows` : "sees it";
}

function whoSees(aud: Audiences, refs: string[]): string[] {
  const { layer, list, access_file } = aud();
  const state = !layer.access_present ? "there is no access.yaml, so access is open" : `access.yaml is ${access_file}, mode ${list[0]!.vis.mode}`;
  const one = (vis: AccessVisibility) => {
    const each = refs.map((r) => [r, seen(vis, r)] as const);
    if (each.length === 1) return each[0]![1];
    const hidden = each.filter(([, s]) => !s.startsWith("sees it"));
    if (hidden.length) return `cannot use it: ${hidden.map(([r, s]) => `${r} ${s.replace(/^does not see it/, "is hidden")}`).join("; ")}`;
    const limited = each.filter(([, s]) => s !== "sees it");
    return limited.length ? `can use it, ${limited.map(([, s]) => s.replace(/^sees it, /, "")).join("; ")}` : "can use it";
  };
  const base = one(list[0]!.vis);
  const out = [`Who sees it once approved (${state}):`, `- ${list[0]!.label}: ${base}.`];
  const differ = list.slice(1).map((a) => [a.label, one(a.vis)] as const).filter(([, s]) => s !== base);
  out.push(...(differ.length ? differ.map(([l, s]) => `- ${l}: ${s}.`) : [list.length > 1 ? "- Every role sees it the same way." : "- No role is defined."]));
  out.push(WHO_SEES_STATED);
  return out;
}

// Rendering per target ---------------------------------------------------------------------------

// Where an item's who-sees block goes in its lines; renderReadbacks prints a block once per batch.
const WHO = "\u0000who";
interface Rendered {
  lines: string[];
  who?: string[];
}

function description(item: { description?: unknown }, comment: string | null | undefined, where: string): string[] {
  if (typeof item.description !== "string" || !item.description.trim()) return ["- No description yet."];
  const fromComment = typeof comment === "string" && comment.trim() === item.description.trim();
  return quoted("", fromComment ? `description, copied from the database comment on ${where}` : "description, from the YAML", item.description);
}

function common(item: { synonyms?: unknown; tags?: unknown }): string[] {
  const out: string[] = [];
  if (strs(item.synonyms).length) out.push(`- People also call it: ${strs(item.synonyms).join(", ")}.`);
  if (strs(item.tags).length) out.push(`- Tags: ${strs(item.tags).join(", ")}.`);
  return out;
}

// The SQL behind an item, once and last.
function technical(lines: string[]): string[] {
  return lines.length ? ["Technical definition (the SQL, for the record):", ...lines.map((l) => `  ${flat(l)}`)] : [];
}

// The grain is free text, and sl draft may have copied it from the table comment, so it is quoted.
function grainLines(model: Model, table: SnapshotTable | undefined): string[] {
  if (typeof model.grain !== "string" || !model.grain.trim()) return ["- One row is: not written yet."];
  const m = GRAIN_TEXT.exec(table?.description ?? "");
  const fromComment = m !== null && `One row per ${m[1]!.trim()}.` === model.grain.trim();
  return quoted("", fromComment ? `grain (what one row is), copied from the database comment on ${model.table}` : "grain (what one row is), from the YAML", model.grain);
}

function renderModel(source: string, model: Model, info: SourceInfo): Rendered {
  const table = tableOf(info, model);
  const pk = strs(model.primary_key);
  const out = [
    `${source}.${model.model} (table)`,
    ...description(model, table?.description, model.table),
    `- Reads ${model.table}.`,
    ...grainLines(model, table),
    `- Primary key: ${listText(pk)}.`,
    ...common(model),
    WHO,
  ];
  const who = [`${source}.${model.model}`];
  if (!table) return { lines: [...out, ...noFacts(source, `${model.table} is not in the snapshot`)], who };
  out.push(MEASURED, tableFacts(info, table));
  for (const k of pk) out.push(...columnFacts(info, table, k, k, false));
  const p = pk.length === 1 ? table.columns.find((c) => c.name === pk[0])?.profile : undefined;
  if (p && !p.sampled && typeof p.distinct_count === "number" && typeof table.row_count === "number")
    out.push(p.distinct_count === table.row_count && !p.null_fraction ? `- Each ${pk[0]} appears once.` : `- ${pk[0]} repeats: ${num(p.distinct_count)} distinct values over ${num(table.row_count)} rows.`);
  return { lines: out, who };
}

// A figure as the owner reads it: whole numbers with separators, others to two decimals (four
// significant digits below 1), with the currency.
function amount(v: number | string | null | undefined, currency?: unknown): string {
  if (v === null || v === undefined) return "empty, as no row counts";
  const n = typeof v === "number" ? v : Number(v);
  const text =
    typeof v === "string" || !Number.isFinite(n)
      ? String(v)
      : Number.isInteger(n)
        ? num(n)
        : Math.abs(n) >= 1
          ? `${num(Math.trunc(Math.round(n * 100) / 100))}.${String(Math.round(Math.abs(n) * 100) % 100).padStart(2, "0")}`
          : String(Number(n.toPrecision(4)));
  return typeof currency === "string" ? `${text} ${currency}` : text;
}
const rowsText = (n: number | string | null | undefined) => (n === null || n === undefined ? "an unknown number of rows" : `${typeof n === "number" ? num(n) : n} row${n === 1 ? "" : "s"}`);

// The figure line of a measure or metric, or nothing when the readback computed none.
function figureLines(ev: FigureEvidence | undefined, currency: unknown): string[] {
  if (!ev) return [];
  if (ev.not_shown !== undefined) return [`- Figure not shown: ${flat(ev.not_shown).replace(/\.+$/, "")}.`];
  if (ev.parts) {
    const each = ev.parts.map((p) => `${p.ref} ${amount(p.figure)} over ${rowsText(p.row_count)}`).join("; ");
    return [`- On today's data it comes to ${amount(ev.figure, currency)}, before any role's row filter: ${each}.`];
  }
  return [`- On today's data it comes to ${amount(ev.figure, currency)}, over the ${rowsText(ev.row_count)} it counts, before any role's row filter.`];
}

const RELATIONSHIP: Record<string, (from: string, to: string) => string> = {
  many_to_one: (f, t) => `each row of ${f} matches at most one row of ${t}`,
  one_to_one: (f, t) => `each row of ${f} matches at most one row of ${t}, and the other way round`,
  one_to_many: (f, t) => `a row of ${f} can match many rows of ${t}`,
  many_to_many: (f, t) => `a row of ${f} can match many rows of ${t}, and the other way round`,
};

// A join in words: what it links, by which columns, how rows match and what happens to a row
// without a match.
function joinWords(from: string, j: Join): string {
  const keys = objs<{ from: string; to: string }>(j.keys).map((k) => (k.from === k.to ? k.from : `${from}.${k.from} = ${j.to}.${k.to}`));
  const rel = RELATIONSHIP[String(j.relationship)]?.(from, j.to) ?? `relationship ${flat(j.relationship)}`;
  const kept = (j.type ?? "left") === "left" ? `a row of ${from} without a match is kept, with the ${j.to} columns empty` : `a row of ${from} without a match is left out`;
  return `${from} to ${j.to} by ${keys.length ? keys.join(" and ") : "no keys yet"}: ${rel}; ${kept}`;
}

function joinSql(from: string, j: Join): string {
  const keys = objs<{ from: string; to: string }>(j.keys).map((k) => `${from}.${k.from} = ${j.to}.${k.to}`);
  return `join ${j.name}: ${keys.join(" and ")} (${j.relationship}, ${j.type ?? "left"} join)`;
}

const BARE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

function renderField(ref: string, source: string, model: Model, e: ApprovalEntry, info: SourceInfo, figure: FigureEvidence | undefined): Rendered {
  const f = e.item as Obj;
  const table = tableOf(info, model);
  const out = [`${ref} (${e.kind})`];
  if (e.kind === "join") {
    const j = f as unknown as Join;
    out.push(...description(j, null, ""), `- Links ${joinWords(model.model, j)}.`, WHO);
    const who = [`${source}.${model.model}`, `${source}.${j.to}`];
    const sql = technical([joinSql(model.model, j)]);
    const ev = j.evidence;
    if (!ev) return { lines: [...out, MEASURED, `- No join evidence yet: run sl check-join --source ${source} --model ${model.model} --join ${j.name}.`, ...sql], who };
    const sameKeys = !ev.keys || JSON.stringify(ev.keys.map((k) => [k.from, k.to])) === JSON.stringify(objs<{ from: string; to: string }>(j.keys).map((k) => [k.from, k.to]));
    out.push(
      MEASURED,
      `- ${num(ev.matched_rows)} of ${num(ev.left_rows)} ${model.model} rows (${percent(ev.match_rate)}) find a ${j.to} row; ${num(ev.left_null_keys)} have an empty key.`,
      `- The key on ${j.to} is ${ev.right_key_unique ? "unique" : "not unique"}, and a row matches at most ${num(ev.max_fanout)} ${j.to} row(s)${ev.max_fanout > 1 ? ", so the join repeats rows" : ", so the join never repeats a row"}.`,
      `- The data suggests ${ev.suggested_relationship}; checked ${ev.checked_at}.`,
    );
    if ((ev.to && ev.to !== j.to) || !sameKeys) out.push(`- This evidence measured another target or other keys; rerun sl check-join --source ${source} --model ${model.model} --join ${j.name}.`);
    return { lines: [...out, ...sql], who };
  }
  const reads = joinReads(model, e.kind === "measure" ? [f.expr, f.filter] : [f.expr], info.lookup, info.dialect);
  const alone = { ...model, dimensions: e.kind === "dimension" ? [f] : [], measures: e.kind === "measure" ? [f] : [], primary_key: [], joins: objs<Join>(model.joins).map((j) => ({ ...j, keys: [] })) } as unknown as Model;
  const own = table ? referencedColumns(alone, table, info.dialect) : [];
  // A field over one column may carry the description sl draft copied from that column's comment.
  const comment = own.length === 1 ? table?.columns.find((c) => c.name === own[0])?.description : undefined;
  out.push(...description(f, comment, `${model.table}.${own[0]}`));
  const sql: string[] = [];
  if (e.kind === "dimension") {
    const bare = typeof f.expr === "string" && BARE.test(f.expr.trim());
    out.push(bare ? `- Value: ${String(f.expr)}, a ${String(f.type)}.` : `- Value: a ${String(f.type)} worked out from ${listText(own)} (the technical definition below has the formula).`);
    if (!bare) sql.push(String(f.expr));
    if (strs(f.time_grains).length) out.push(`- Time grains: ${strs(f.time_grains).join(", ")}.`);
    if (typeof f.time_zone === "string") out.push(`- Stored in time zone ${f.time_zone}.`);
  } else {
    out.push(`- ${f.agg === "count" && !f.expr ? "A count of rows" : `${AGG_WORDS[String(f.agg)] ?? `The ${String(f.agg)} of`} ${String(f.expr)}`}.`);
    const clauses = typeof f.filter === "string" ? filterClauses(f.filter) : [];
    if (clauses.length) out.push("- It counts only rows where:", ...clauses.map((c, i) => `  ${i + 1}. ${clauseWords(c)}`));
    else out.push("- It counts every row.");
    const fmt = typeof f.format === "string" ? f.format : "not set";
    out.push(`- Format: ${fmt}${typeof f.currency === "string" ? `, in ${f.currency}` : ""}.`);
    sql.push(`${String(f.agg)}(${f.expr === undefined ? "*" : String(f.expr)})${typeof f.filter === "string" ? ` where ${f.filter}` : ""}`);
  }
  const hops = new Map<string, Join & { from: string }>();
  for (const r of reads) {
    let path = "";
    for (const h of r.hops) {
      path = path ? `${path}.${h.join.name}` : h.join.name;
      hops.set(path, { ...h.join, from: h.from });
    }
  }
  for (const [p, j] of hops) out.push(`- Through the ${p} join, ${joinWords(j.from, j)}.`);
  sql.push(...[...hops.values()].map((j) => joinSql(j.from, j)));
  out.push(...common(f), WHO);
  const fig = e.kind === "measure" ? figureLines(figure, f.currency) : [];
  if (!table) return { lines: [...out, ...noFacts(source, `${model.table} is not in the snapshot`), ...fig, ...technical(sql)], who: [ref] };
  out.push(MEASURED, ...fig, tableFacts(info, table));
  const tagged = [...strs(f.tags), ...strs(model.tags)].some((t) => (PROTECTED_TAGS as readonly string[]).includes(t.toLowerCase()));
  for (const c of own) out.push(...columnFacts(info, table, c, c, tagged));
  for (const r of reads) {
    const last = r.hops[r.hops.length - 1]!.join;
    const t = tableOf(info, info.lookup(last.to));
    const label = `${r.path}.${r.column}`;
    if (t) out.push(...columnFacts(info, t, r.column, `${label} (${qualifiedName(t)}.${r.column})`, tagged));
    else out.push(`- ${label}: ${last.to} has no table in the snapshot.`);
  }
  return { lines: [...out, ...technical(sql)], who: [ref] };
}

const OPERATOR_WORDS: Record<string, string> = { "+": "plus", "-": "minus", "*": "times", "/": "divided by" };

function renderMetric(m: Metric, figure: FigureEvidence | undefined): Rendered {
  const out = [`metric:${m.name} (metric of source ${m.source})`, ...description(m, null, "")];
  if (m.type === "ratio") out.push(`- A ratio: ${m.numerator} divided by ${m.denominator}.`);
  else {
    const words = String(m.expr).replace(/\{\s*([^}]*?)\s*\}/g, "$1").replace(/\s*([-+*/])\s*/g, (_, op: string) => ` ${OPERATOR_WORDS[op]} `);
    out.push(`- ${words}, each measure totalled on its own first.`);
  }
  out.push(`- Format: ${m.format ?? "not set"}${m.currency ? `, in ${m.currency}` : ""}.`, ...common(m), WHO);
  const fig = figureLines(figure, m.currency);
  if (fig.length) out.push(MEASURED, ...fig);
  if (m.type !== "ratio") out.push(...technical([String(m.expr)]));
  return { lines: out, who: [`metric:${m.name}`] };
}

// The models, fields and metrics an audience sees, by ref.
function visibleRefs(vis: AccessVisibility): Set<string> {
  const out = new Set<string>();
  for (const s of vis.sources) {
    for (const m of s.models) {
      if (m.visible) out.add(m.ref);
      for (const f of m.fields) if (f.visible) out.add(f.ref);
    }
    for (const m of s.metrics) if (m.visible) out.add(m.ref);
  }
  return out;
}

// Items in words, a model's fields under it: "the table warehouse.refunds", "warehouse.customers
// fields email and phone", "metric net_revenue". A field of a listed table is left out.
function itemsText(refs: string[]): string {
  const tables = refs.filter((r) => !r.startsWith("metric:") && r.split(".").length === 2);
  const byModel = new Map<string, string[]>();
  for (const r of refs) {
    const p = r.split(".");
    if (r.startsWith("metric:") || p.length !== 3 || tables.includes(`${p[0]}.${p[1]}`)) continue;
    byModel.set(`${p[0]}.${p[1]}`, [...(byModel.get(`${p[0]}.${p[1]}`) ?? []), p[2]!]);
  }
  const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));
  return [
    ...tables.map((t) => `the table ${t}`),
    ...[...byModel].map(([m, fs]) => `${m} field${fs.length === 1 ? "" : "s"} ${and(fs)}`),
    ...refs.filter((r) => r.startsWith("metric:")).map((r) => `metric ${r.slice(7)}`),
  ].join("; ");
}

// A role's or restriction's condition in words, or as written when it cannot be read.
function condition(text: string): string {
  try {
    return conditionWords(parseCondition(text));
  } catch {
    return flat(text);
  }
}

// A row filter's rule in words.
function rowRule(rf: Obj): string {
  const h = isObj(rf.hierarchy) ? rf.hierarchy : undefined;
  if (!h) return clauseWords(String(rf.expr));
  const user = String(h.user).replace(/^user\.([a-z0-9_]+)$/i, "the user's $1");
  return `${String(h.column)} is ${h.include_self === false ? `anyone under ${user}` : `${user} or anyone under them`} in ${String(h.via)}`;
}

function renderAccess(aud: Audiences, access: Obj): Rendered {
  const mode = access.mode === "closed" ? "closed" : "open";
  const out = [
    "access (access.yaml as a whole)",
    mode === "open"
      ? "- Mode open: everyone sees every approved item, except items tagged pii or sensitive, restriction targets and what a held role denies."
      : "- Mode closed: a user sees only the models a role they hold allows.",
  ];
  if (typeof access.default_role === "string") out.push(`- A user with no other role holds ${access.default_role}.`);
  const attrs = objs<{ name: string; type: string }>(access.user_attributes).map((a) => `${a.name} (${a.type})`);
  out.push(`- User attributes: ${listText(attrs)}.`);
  const { list } = aud();
  const base = visibleRefs(list[0]!.vis);
  const all = new Set<string>();
  for (const a of list) for (const s of a.vis.sources) for (const m of s.models) [m.ref, ...m.fields.map((f) => f.ref)].forEach((r) => all.add(r));
  for (const a of list) for (const s of a.vis.sources) for (const m of s.metrics) all.add(m.ref);
  const hidden = [...all].filter((r) => !base.has(r)).sort();
  // The shorter list: what a user with no role sees, or what it does not.
  const seen = [...base].sort();
  const none = !seen.length ? "nothing" : hidden.length > seen.length ? `only ${itemsText(seen)}` : hidden.length ? `every approved item except: ${itemsText(hidden)}` : "every approved item";
  out.push(`- A user with no role sees ${none}.`);
  for (const [i, r] of (Array.isArray(access.roles) ? (access.roles as unknown[]) : []).entries()) {
    if (!isObj(r) || typeof r.name !== "string") {
      out.push(`- Role at roles[${i}]: cannot be read, so nobody holds it (sl validate says why).`);
      continue;
    }
    const held = typeof r.assign_when === "string" ? `held when ${condition(r.assign_when)}` : "held when assigned by name";
    const vis = list.find((a) => a.label === `Role ${r.name}`)?.vis;
    const sees = vis ? visibleRefs(vis) : new Set<string>();
    const adds = [...sees].filter((x) => !base.has(x)).sort();
    const takes = [...base].filter((x) => !sees.has(x)).sort();
    const filters = objs<Obj>(r.row_filters);
    out.push(`- Role ${r.name}, ${held}. Compared with a user with no role:`);
    if (typeof r.description === "string" && r.description.trim()) out.push(...quoted("  ", `description of role ${r.name}, from the YAML`, r.description));
    out.push(`  - It adds: ${adds.length ? itemsText(adds) : "nothing"}.`, `  - It takes away: ${takes.length ? itemsText(takes) : "nothing"}.`);
    if (!filters.length) out.push("  - It sees every row.");
    for (const rf of filters) out.push(`  - On ${String(rf.model)} it sees only rows where ${rowRule(rf)}.`);
  }
  for (const r of objs<Obj>(access.restrictions)) {
    const allow = isObj(r.allow) ? r.allow : {};
    const who = [...(strs(allow.roles).length ? [`roles ${strs(allow.roles).join(", ")}`] : []), ...(typeof allow.when === "string" ? [`users where ${condition(allow.when)}`] : [])];
    out.push(`- Restriction ${String(r.name)}: ${strs(r.targets).join(", ")} only for ${listText(who)}.`);
    if (typeof r.description === "string" && r.description.trim()) out.push(...quoted("  ", `description of restriction ${String(r.name)}, from the YAML`, r.description));
  }
  return { lines: out };
}

// A golden's rows as sl readback ran them, with the tolerance the readback states.
export interface GoldenRun {
  rows: ResultRows;
  tolerance: number;
  // Where the tolerance came from: --tolerance, the golden's expected.tolerance, or the default.
  from: "flag" | "file" | "default";
  // The result columns whose values the readback shows as [protected].
  masked: string[];
  // Which query gave the rows: the request compiled from the current YAML, or cross_check_sql when
  // the request does not compile; and whether cross_check_sql ran too and gave the same rows.
  from_query?: "compiled" | "cross_check_sql";
  cross_checked?: boolean;
}

const OP_WORDS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  not_in: "is not one of",
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
  between: "is between",
  is_null: "is empty",
  not_null: "is not empty",
};

// A golden's request in words: what it adds up, by what, on which rows, in which order.
function requestWords(g: Golden): string[] {
  const r = isObj(g.request) ? (g.request as unknown as Obj) : {};
  const out = [`- The request, on source ${flat(r.source)}:`];
  out.push(`  - Figures: ${listText(strs(r.measures))}.`, `  - Grouped by: ${listText(strs(r.dimensions))}.`);
  const filters = objs<Obj>(r.filters).map((f) => {
    const v = f.value === undefined ? "" : Array.isArray(f.value) ? f.value.map(value).join(f.op === "between" ? " and " : ", ") : value(f.value);
    return `${flat(f.field)} ${OP_WORDS[String(f.op)] ?? flat(f.op)}${v ? ` ${flat(v)}` : ""}`;
  });
  out.push(`  - Only rows where: ${filters.length ? filters.join("; ") : "every row counts"}.`);
  const order = objs<Obj>(r.order_by).map((o) => `${flat(o.field)} ${o.direction === "desc" ? "descending" : "ascending"}`);
  if (order.length) out.push(`  - Sorted by: ${order.join(", ")}.`);
  if (typeof r.limit === "number") out.push(`  - At most ${num(r.limit)} rows.`);
  return out;
}

// Which query a golden readback's rows come from, in words.
function rowsFrom(g: Golden, run: GoldenRun): string {
  if (run.from_query === "compiled") return "Its request, compiled from the current YAML, returns now";
  if (run.from_query === "cross_check_sql")
    return `Its request does not compile from the current YAML (sl goldens run --name ${g.name} says why); its cross_check_sql returns now`;
  return "Its SQL returns now";
}

function renderGolden(g: Golden, run: GoldenRun): string[] {
  const user = isObj(g.user) && Object.keys(g.user).length ? ` with user attributes ${flat(JSON.stringify(g.user))}` : "";
  const role = typeof g.role === "string" ? `role ${g.role}` : "no role of its own (access.yaml's default role, or the default audience)";
  const n = run.rows.length;
  const rule =
    run.tolerance === 0
      ? "later runs must give exactly these figures"
      : `on later runs a figure with decimals may move up to ${Math.round(run.tolerance * 10000) / 100}% either way; whole numbers and grouping columns must match exactly`;
  const out = [
    `golden:${g.name} (golden)`,
    ...quoted("", "question, from the YAML", String(g.question ?? "")),
    ...requestWords(g),
    `- Runs as ${role}${user}.`,
    ...(typeof g.reference === "string" && g.reference.trim()
      ? quoted("", "figure the owner trusts (reference), from the YAML", g.reference)
      : ["- No reference yet: write in reference where the owner's trusted figure comes from."]),
    `- ${rowsFrom(g, run)} ${num(n)} row${n === 1 ? "" : "s"}:`,
    ...(n ? quoted("  ", "rows, from the data", formatTable(maskRows(run.rows, run.masked))) : ["  (no rows: a golden needs at least one, so it cannot be confirmed)"]),
  ];
  if (run.cross_checked) out.push("- Its cross_check_sql gives the same rows.");
  if (run.masked.length) out.push(`- Protected columns shown as ${PROTECTED_VALUE}: ${run.masked.map(flat).join(", ")}.`);
  out.push(
    `- Tolerance: ${run.tolerance}${run.from === "default" ? " (the default; agree one with the owner and read it back with --tolerance <t>)" : ""}: ${rule}.`,
    "- Say yes only when these rows match the figure the owner trusts; sl goldens confirm then records exactly them.",
  );
  return out;
}

// The hash of a target that was read back with `stored`, as the target stands now, or null when it
// no longer exists. A golden's hash covers the rows its request compiles to, which only a run gives:
// while goldens/<name>.yaml exists the stored hash stands, and sl goldens confirm reruns the golden
// and refuses a yes whose hash no longer matches.
export function currentHash(root: string, target: string, stored: string): string | null {
  const golden = /^golden:([a-z][a-z0-9_]*)$/.exec(target)?.[1];
  if (golden) return existsSync(paths(root).golden(golden)) ? stored : null;
  try {
    return renderReadbacks(root, [target])[0]?.content_hash ?? null;
  } catch (e) {
    if (e instanceof UserError) return null;
    throw e;
  }
}

// Renders each target's readback with the content hash sl approve would record for it. A golden
// target (golden:<name>) needs its rows in `goldens`, keyed by name: sl readback runs the golden first.
// A measure or metric shows its figure from `figures` (readbackFigures), which never changes the
// hash. A who-sees block the same as an earlier item's is printed once and named by that item's
// number. An unknown target is an error naming it, before anything is written.
export function renderReadbacks(
  root: string,
  refs: string[],
  goldens: ReadonlyMap<string, GoldenRun> = new Map(),
  figures: ReadonlyMap<string, FigureEvidence> = new Map(),
): { target: string; text: string; content_hash: string }[] {
  const infos = new Map<string, SourceInfo>();
  const info = (s: string) => infos.get(s) ?? infos.set(s, sourceInfo(root, s)).get(s)!;
  let evaluated: ReturnType<Audiences> | undefined;
  const aud: Audiences = () => (evaluated ??= audiences(root));
  const unknown = (ref: string, why: string) =>
    new UserError(`Unknown target "${ref}": ${why}. Run sl status to see the models, fields, metrics and goldens; targets are source.model, source.model.field, metric:<name>, golden:<name> or access.`);
  const blocks = new Map<string, number>();
  return [...new Set(refs)].map((ref, index) => {
    const t = parseTarget(ref);
    let r: Rendered;
    let entry: ApprovalEntry | undefined;
    switch (t.kind) {
      case "golden": {
        const file = paths(root).golden(t.name);
        const g = existsSync(file) ? loadFile<Golden>(root, file, "golden") : null;
        if (!g) throw unknown(ref, `there is no goldens/${t.name}.yaml`);
        const run = goldens.get(t.name);
        if (!run) throw new UserError(`${ref} is read back with the rows its request compiles to: run sl readback --targets ${ref}.`);
        const text = renderGolden(g, run).join("\n");
        return { target: ref, text, content_hash: goldenHash(g as unknown as Obj, run.rows, run.tolerance) };
      }
      case "access": {
        const access = loadAccess(root);
        entry = itemApprovals(listApprovals({ access }))[0];
        if (!entry) throw unknown(ref, "there is no access.yaml; write it as a draft first");
        r = renderAccess(aud, entry.item);
        break;
      }
      case "metric": {
        entry = itemApprovals(listApprovals({ metrics: loadMetrics(root).metrics })).find((e) => e.ref === ref);
        if (!entry) throw unknown(ref, "metrics.yaml has no such metric");
        r = renderMetric(entry.item as unknown as Metric, figures.get(ref));
        break;
      }
      default: {
        const file = paths(root).model(t.source, t.model);
        const model = existsSync(file) ? loadFile<Model>(root, file, "model") : null;
        if (!model) throw unknown(ref, `there is no model ${t.source}.${t.model}`);
        const i = info(t.source);
        // The model as its file holds it, hashed the way sl approve hashes it; a field is found the way
        // sl approve finds it (dimensions, then measures, then joins).
        const entries = itemApprovals(listApprovals({ models: [{ source: t.source, model, lookup: i.lookup, dialect: i.dialect }] }));
        const field = t.kind === "field" ? t.field : undefined;
        entry = field === undefined ? entries[0] : entries.find((e) => e.kind !== "model" && e.item.name === field);
        if (!entry) throw unknown(ref, `${t.source}.${t.model} has no dimension, measure or join "${field}"`);
        r = field === undefined ? renderModel(t.source, model, i) : renderField(ref, t.source, model, entry, i, figures.get(ref));
      }
    }
    const who = r.who ? whoSees(aud, r.who) : [];
    const key = who.join("\n");
    const earlier = blocks.get(key);
    if (earlier === undefined && who.length) blocks.set(key, index + 1);
    const block = earlier === undefined ? who : [`Who sees it once approved: the same as item ${earlier}.`];
    const lines = r.lines.flatMap((l) => (l === WHO ? block : [l]));
    return { target: ref, text: lines.join("\n"), content_hash: entry.hash };
  });
}

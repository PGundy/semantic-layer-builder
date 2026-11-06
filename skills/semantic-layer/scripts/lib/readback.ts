// Canonical plain-English readbacks of approve targets, and the pending store that keeps them.
// sl readback renders each target from the YAML (its definition, who sees it under the current
// access.yaml, and the facts measured from the data) and stores the numbered items with the content
// hash sl approve would record, in .sl/pending/<readback_id>.json under the semantic root.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AccessLayer, type AccessVisibility, evaluateLayer, loadAccessLayer } from "./access.ts";
import { accessEntry, type ApprovalEntry, metricEntries, modelEntries } from "./approval-hash.ts";
import { UserError } from "./errors.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { plainText } from "./output.ts";
import { protectedColumns } from "./profile.ts";
import { listModels, loadAccess, loadMetrics, loadSnapshot, paths } from "./project.ts";
import { parseTarget } from "./refs.ts";
import { referencedColumns } from "./snapshot-diff.ts";
import { sqlNames } from "./sql-names.ts";
import type { Dialect, Join, Metric, Model, PendingReadback, Snapshot, SnapshotTable } from "./types.ts";
import { DIALECTS, NAME_PATTERN, PROTECTED_TAGS } from "./types.ts";
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
    writeFileSync(join(root, rel), `${JSON.stringify(pending, null, 2)}\n`, { flag: "wx" });
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

function operand(s: string): string {
  const m = /^coalesce\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i.exec(s.trim());
  return m ? `${m[1]} (read as ${m[2]} when empty)` : s.trim();
}

// The top-level clauses of a filter: its and-parts, or the whole filter when it has a top-level or
// (and binds tighter than or, so splitting on and would change its meaning).
function filterClauses(filter: string): string[] {
  return splitTop(filter, "or").length > 1 ? [filter.trim()] : splitTop(filter, "and");
}

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(.+?)\s+not\s+in\s*\((.*)\)$/is, (m) => `${operand(m[1]!)} is not one of ${m[2]!.trim()}`],
  [/^(.+?)\s+in\s*\((.*)\)$/is, (m) => `${operand(m[1]!)} is one of ${m[2]!.trim()}`],
  [/^(.+?)\s+is\s+not\s+null$/is, (m) => `${operand(m[1]!)} is not empty`],
  [/^(.+?)\s+is\s+null$/is, (m) => `${operand(m[1]!)} is empty`],
  [/^(.+?)\s+not\s+ilike\s+(.+)$/is, (m) => `${operand(m[1]!)} does not match ${m[2]!.trim()}, ignoring case`],
  [/^(.+?)\s+ilike\s+(.+)$/is, (m) => `${operand(m[1]!)} matches ${m[2]!.trim()}, ignoring case`],
  [/^(.+?)\s+not\s+like\s+(.+)$/is, (m) => `${operand(m[1]!)} does not match ${m[2]!.trim()}`],
  [/^(.+?)\s+like\s+(.+)$/is, (m) => `${operand(m[1]!)} matches ${m[2]!.trim()}`],
  [/^(.+?)\s+not\s+between\s+(.+?)\s+and\s+(.+)$/is, (m) => `${operand(m[1]!)} is outside ${m[2]!.trim()} to ${m[3]!.trim()}`],
  [/^(.+?)\s+between\s+(.+?)\s+and\s+(.+)$/is, (m) => `${operand(m[1]!)} is from ${m[2]!.trim()} to ${m[3]!.trim()}`],
  [/^(.+?)\s*(<>|!=)\s*(.+)$/s, (m) => `${operand(m[1]!)} is not ${operand(m[3]!)}`],
  [/^(.+?)\s*(>=|<=|>|<|=)\s*(.+)$/s, (m) => `${operand(m[1]!)} ${{ ">=": "is at least", "<=": "is at most", ">": "is above", "<": "is below", "=": "equals" }[m[2]!]} ${operand(m[3]!)}`],
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
  const unmask = (t: string) => t.replace(/\u0001(\d+)\u0001/g, (all, i: string) => literals[Number(i)] ?? all);
  for (const [re, words] of RULES) {
    const m = re.exec(masked);
    if (m) return unmask(words(m));
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

function joinDefinition(source: string, from: string, j: Join): string {
  const keys = objs<{ from: string; to: string }>(j.keys).map((k) => `${from}.${k.from} = ${j.to}.${k.to}`);
  const type = j.type ?? "left";
  const kept = type === "left" ? "rows without a match are kept, with its columns empty" : "rows without a match are dropped";
  return `${source}.${from} to ${source}.${j.to} on ${keys.join(" and ")}: ${j.relationship}, a ${type} join (${kept})`;
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

// The layer as it would stand with every item approved: who sees an item once it is approved.
function approvedLayer(layer: AccessLayer): AccessLayer {
  const ok = <T,>(x: T): T => ({ ...x, status: "approved" });
  return {
    ...layer,
    models: layer.models.map((m) => ({ ...ok(m), dimensions: objs<Obj>(m.dimensions).map(ok), measures: objs<Obj>(m.measures).map(ok) }) as unknown as Model),
    metrics: layer.metrics.map(ok),
  };
}

interface Audience {
  label: string;
  vis: AccessVisibility;
}

// The default audience and each role of access.yaml, evaluated once per sl readback.
type Audiences = () => { layer: AccessLayer; list: Audience[] };

function audiences(root: string): { layer: AccessLayer; list: Audience[] } {
  const layer = approvedLayer(loadAccessLayer(root));
  const roles = objs<{ name?: unknown }>(isObj(layer.access) ? layer.access.roles : undefined)
    .map((r) => r.name)
    .filter((n): n is string => typeof n === "string");
  const list = [{ label: "Default audience (a user with no role)", vis: evaluateLayer(layer, {}) }];
  for (const r of roles) list.push({ label: `Role ${r}`, vis: evaluateLayer(layer, { roles: [r] }) });
  return { layer, list };
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
  const { layer, list } = aud();
  const state = !layer.access_present ? "there is no access.yaml, so access is open" : `access.yaml is ${list[0]!.vis.access_file}, mode ${list[0]!.vis.mode}`;
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
  return out;
}

// Rendering per target ---------------------------------------------------------------------------

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

// The grain is free text, and sl draft may have copied it from the table comment, so it is quoted.
function grainLines(model: Model, table: SnapshotTable | undefined): string[] {
  if (typeof model.grain !== "string" || !model.grain.trim()) return ["- One row is: not written yet."];
  const m = GRAIN_TEXT.exec(table?.description ?? "");
  const fromComment = m !== null && `One row per ${m[1]!.trim()}.` === model.grain.trim();
  return quoted("", fromComment ? `grain (what one row is), copied from the database comment on ${model.table}` : "grain (what one row is), from the YAML", model.grain);
}

function renderModel(aud: Audiences, source: string, model: Model, info: SourceInfo): string[] {
  const table = tableOf(info, model);
  const pk = strs(model.primary_key);
  const out = [
    `${source}.${model.model} (table)`,
    `- Reads ${model.table}.`,
    ...grainLines(model, table),
    `- Primary key: ${listText(pk)}.`,
    ...common(model),
    ...description(model, table?.description, model.table),
    ...whoSees(aud, [`${source}.${model.model}`]),
  ];
  if (!table) return [...out, ...noFacts(source, `${model.table} is not in the snapshot`)];
  out.push(MEASURED, tableFacts(info, table));
  for (const k of pk) out.push(...columnFacts(info, table, k, k, false));
  const p = pk.length === 1 ? table.columns.find((c) => c.name === pk[0])?.profile : undefined;
  if (p && !p.sampled && typeof p.distinct_count === "number" && typeof table.row_count === "number")
    out.push(p.distinct_count === table.row_count && !p.null_fraction ? `- Each ${pk[0]} appears once.` : `- ${pk[0]} repeats: ${num(p.distinct_count)} distinct values over ${num(table.row_count)} rows.`);
  return out;
}

function renderField(aud: Audiences, ref: string, source: string, model: Model, e: ApprovalEntry, info: SourceInfo): string[] {
  const f = e.item as Obj;
  const table = tableOf(info, model);
  const out = [`${ref} (${e.kind})`];
  if (e.kind === "join") {
    const j = f as unknown as Join;
    out.push(`- Joins ${joinDefinition(source, model.model, j)}.`, ...description(j, null, ""), ...whoSees(aud, [`${source}.${model.model}`, `${source}.${j.to}`]));
    const ev = j.evidence;
    if (!ev) return [...out, MEASURED, `- No join evidence yet: run sl check-join --source ${source} --model ${model.model} --join ${j.name}.`];
    const sameKeys = !ev.keys || JSON.stringify(ev.keys.map((k) => [k.from, k.to])) === JSON.stringify(objs<{ from: string; to: string }>(j.keys).map((k) => [k.from, k.to]));
    out.push(
      MEASURED,
      `- ${num(ev.matched_rows)} of ${num(ev.left_rows)} ${model.model} rows (${percent(ev.match_rate)}) find a ${j.to} row; ${num(ev.left_null_keys)} have an empty key.`,
      `- The key on ${j.to} is ${ev.right_key_unique ? "unique" : "not unique"}, and a row matches at most ${num(ev.max_fanout)} ${j.to} row(s)${ev.max_fanout > 1 ? ", so the join repeats rows" : ", so the join never repeats a row"}.`,
      `- The data suggests ${ev.suggested_relationship}; checked ${ev.checked_at}.`,
    );
    if ((ev.to && ev.to !== j.to) || !sameKeys) out.push(`- This evidence measured another target or other keys; rerun sl check-join --source ${source} --model ${model.model} --join ${j.name}.`);
    return out;
  }
  const sql = e.kind === "measure" ? [f.expr, f.filter] : [f.expr];
  const reads = joinReads(model, sql, info.lookup, info.dialect);
  if (e.kind === "dimension") {
    out.push(`- Value: ${String(f.expr)}, a ${String(f.type)}.`);
    if (strs(f.time_grains).length) out.push(`- Time grains: ${strs(f.time_grains).join(", ")}.`);
    if (typeof f.time_zone === "string") out.push(`- Stored in time zone ${f.time_zone}.`);
  } else {
    out.push(`- ${f.agg === "count" && !f.expr ? "A count of rows" : `${AGG_WORDS[String(f.agg)] ?? `The ${String(f.agg)} of`} ${String(f.expr)}`}.`);
    const clauses = typeof f.filter === "string" ? filterClauses(f.filter) : [];
    if (clauses.length) out.push("- Counts only rows where:", ...clauses.map((c, i) => `  ${i + 1}. ${clauseWords(c)}  [${c}]`));
    else out.push("- Counts every row.");
    const fmt = typeof f.format === "string" ? f.format : "not set";
    out.push(`- Format: ${fmt}${typeof f.currency === "string" ? `, in ${f.currency}` : ""}.`);
  }
  const hops = new Map<string, string>();
  for (const r of reads) {
    let path = "";
    for (const h of r.hops) {
      path = path ? `${path}.${h.join.name}` : h.join.name;
      hops.set(path, joinDefinition(source, h.from, h.join));
    }
  }
  if (hops.size) out.push("- Reads through joins:", ...[...hops].map(([p, d]) => `  - ${p}: ${d}`));
  const alone = { ...model, dimensions: e.kind === "dimension" ? [f] : [], measures: e.kind === "measure" ? [f] : [], primary_key: [], joins: objs<Join>(model.joins).map((j) => ({ ...j, keys: [] })) } as unknown as Model;
  const own = table ? referencedColumns(alone, table, info.dialect) : [];
  // A field over one column may carry the description sl draft copied from that column's comment.
  const comment = own.length === 1 ? table?.columns.find((c) => c.name === own[0])?.description : undefined;
  out.push(...common(f), ...description(f, comment, `${model.table}.${own[0]}`), ...whoSees(aud, [ref]));
  if (!table) return [...out, ...noFacts(source, `${model.table} is not in the snapshot`)];
  out.push(MEASURED, tableFacts(info, table));
  const tagged = [...strs(f.tags), ...strs(model.tags)].some((t) => (PROTECTED_TAGS as readonly string[]).includes(t.toLowerCase()));
  for (const c of own) out.push(...columnFacts(info, table, c, c, tagged));
  for (const r of reads) {
    const last = r.hops[r.hops.length - 1]!.join;
    const t = tableOf(info, info.lookup(last.to));
    const label = `${r.path}.${r.column}`;
    if (t) out.push(...columnFacts(info, t, r.column, `${label} (${qualifiedName(t)}.${r.column})`, tagged));
    else out.push(`- ${label}: ${last.to} has no table in the snapshot.`);
  }
  return out;
}

function renderMetric(aud: Audiences, m: Metric): string[] {
  const out = [`metric:${m.name} (metric of source ${m.source})`];
  if (m.type === "ratio") out.push(`- A ratio: ${m.numerator} divided by ${m.denominator}.`);
  else out.push(`- Derived: ${m.expr}, where each {model.measure} is that measure's total on its own.`);
  out.push(`- Format: ${m.format ?? "not set"}${m.currency ? `, in ${m.currency}` : ""}.`, ...common(m), ...description(m, null, ""), ...whoSees(aud, [`metric:${m.name}`]));
  out.push(MEASURED, "- A metric has no facts of its own; each measure it combines has them in its own readback.");
  return out;
}

function renderAccess(aud: Audiences, access: Obj): string[] {
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
  for (const r of objs<Obj>(access.roles)) {
    const allow = isObj(r.allow) ? r.allow : {};
    const deny = isObj(r.deny) ? r.deny : {};
    const bits = [
      typeof r.assign_when === "string" ? `held when ${r.assign_when}` : "held when assigned by name",
      ...(strs(allow.models).length ? [`allows models ${strs(allow.models).join(", ")}`] : []),
      ...(strs(allow.tags).length ? [`allows tags ${strs(allow.tags).join(", ")}`] : []),
      ...(["models", "fields", "tags"] as const).flatMap((k) => (strs(deny[k]).length ? [`denies ${k} ${strs(deny[k]).join(", ")}`] : [])),
    ];
    out.push(`- Role ${String(r.name)}: ${bits.join("; ")}.`);
    for (const rf of objs<Obj>(r.row_filters)) {
      const h = isObj(rf.hierarchy) ? rf.hierarchy : undefined;
      const rule = h
        ? `${String(h.column)} is ${h.include_self === false ? `anyone under ${String(h.user)}` : `${String(h.user)} or anyone under them`} in ${String(h.via)}`
        : `${String(rf.expr)}`;
      out.push(`  - On ${String(rf.model)} it sees only rows where ${rule}.`);
    }
  }
  for (const r of objs<Obj>(access.restrictions)) {
    const allow = isObj(r.allow) ? r.allow : {};
    const who = [...(strs(allow.roles).length ? [`roles ${strs(allow.roles).join(", ")}`] : []), ...(typeof allow.when === "string" ? [`users where ${allow.when}`] : [])];
    out.push(`- Restriction ${String(r.name)}: ${strs(r.targets).join(", ")} only for ${listText(who)}.`);
  }
  const { list } = aud();
  out.push("Who sees what once every item is approved:");
  for (const a of list) {
    const s = a.vis.summary;
    const n = (c: number, w: string) => `${num(c)} ${w}${c === 1 ? "" : "s"}`;
    out.push(`- ${a.label}: ${n(s.models.visible, "model")}, ${n(s.fields.visible, "field")} and ${n(s.metrics.visible, "metric")}.`);
  }
  return out;
}

// Renders each target's readback with the content hash sl approve would record for it. An unknown
// target is an error naming it, before anything is written.
export function renderReadbacks(root: string, refs: string[]): { target: string; text: string; content_hash: string }[] {
  const infos = new Map<string, SourceInfo>();
  const info = (s: string) => infos.get(s) ?? infos.set(s, sourceInfo(root, s)).get(s)!;
  let evaluated: ReturnType<Audiences> | undefined;
  const aud: Audiences = () => (evaluated ??= audiences(root));
  const unknown = (ref: string, why: string) =>
    new UserError(`Unknown target "${ref}": ${why}. Run sl status to see the models, fields and metrics; targets are source.model, source.model.field, metric:<name> or access.`);
  return [...new Set(refs)].map((ref) => {
    const t = parseTarget(ref);
    let lines: string[];
    let entry: ApprovalEntry | undefined;
    switch (t.kind) {
      case "golden":
        throw new UserError(`Goldens are not read back here: run sl goldens run --name ${t.name}, show the rows, then sl goldens confirm on the owner's yes.`);
      case "access": {
        const access = loadAccess(root);
        entry = accessEntry(access);
        if (!entry) throw unknown(ref, "there is no access.yaml; write it as a draft first");
        lines = renderAccess(aud, entry.item);
        break;
      }
      case "metric": {
        entry = metricEntries(loadMetrics(root).metrics).find((e) => e.ref === ref);
        if (!entry) throw unknown(ref, "metrics.yaml has no such metric");
        lines = renderMetric(aud, entry.item as unknown as Metric);
        break;
      }
      default: {
        const file = paths(root).model(t.source, t.model);
        const model = existsSync(file) ? readYamlIfExists<Model>(file) : null;
        if (!isObj(model)) throw unknown(ref, `there is no model ${t.source}.${t.model}`);
        const i = info(t.source);
        // The model as its file holds it, hashed the way sl approve hashes it; a field is found the way
        // sl approve finds it (dimensions, then measures, then joins).
        const entries = modelEntries(t.source, model, i.lookup, i.dialect);
        const field = t.kind === "field" ? t.field : undefined;
        entry = field === undefined ? entries[0] : entries.find((e) => e.kind !== "model" && e.item.name === field);
        if (!entry) throw unknown(ref, `${t.source}.${t.model} has no dimension, measure or join "${field}"`);
        lines = field === undefined ? renderModel(aud, t.source, model, i) : renderField(aud, ref, t.source, model, entry, i);
      }
    }
    return { target: ref, text: lines.join("\n"), content_hash: entry.hash };
  });
}

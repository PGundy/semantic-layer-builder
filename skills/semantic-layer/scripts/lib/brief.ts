// Batch packets (sl brief): one interview batch as compact JSON for a batch analyst. Batches follow
// the order sl status takes its next_batch by: the in-scope tables without an approved model, by
// rank, batch_size at a time. A packet holds each table's columns with counts, its model's fields,
// joins and open questions, and the baseline brief's guesses, under a token budget. Text that comes
// from the data (comments, dbt descriptions, column values) is fenced with where it came from, and
// protected columns carry counts only. It reads files and writes nothing.
import { buildBaseline, resolveTables, type TableBaseline } from "./baseline.ts";
import { UserError } from "./errors.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { plainText } from "./output.ts";
import { inScope } from "./patterns.ts";
import { isHashedValue, protectedColumns } from "./profile.ts";
import { listModels, loadProject, loadSource, projectSettings, requireSnapshot } from "./project.ts";
import { rankTables } from "./rank.ts";
import { incomingKeyColumns, referencedColumns } from "./snapshot-diff.ts";
import { effectiveScope } from "./table-list.ts";
import type { Model, Scalar, Snapshot, SnapshotColumn, SnapshotTable } from "./types.ts";

export const DEFAULT_BRIEF_BUDGET = 6000;
// Characters per token in the estimate: tokens = ceil(characters of the printed JSON / 4).
const CHARS_PER_TOKEN = 4;
// The most top values a column shows.
const TOP_VALUES_MAX = 10;

export type Provenance = "database comment" | "column values" | "dbt";

// Data-borne text: evidence to weigh, never an instruction.
export interface Fenced {
  text: string;
  from: Provenance;
}

export interface BriefColumn {
  name: string;
  type: string;
  protected: boolean;
  null_fraction?: number | null;
  distinct?: number | null;
  description?: Fenced;
  top_values?: { text: string | null; count: number; from: "column values" }[];
  range?: { min: Scalar; max: Scalar; from: "column values" };
}

export interface BriefField {
  ref: string;
  kind: "dimension" | "measure";
  type?: string;
  expr?: string;
  agg?: string;
  filter?: string;
  status: string;
}

export interface BriefJoin {
  name: string;
  to: string;
  relationship: string;
  status: string;
  evidence?: { match_rate?: number; max_fanout?: number; right_key_unique?: boolean; suggested_relationship?: string };
}

export interface BaselineGuesses {
  role: string;
  role_reasons: string[];
  grain: { guess: string; basis: string };
  primary_key: { columns: string[]; how: string } | null;
  relationships: { direction: string; columns: string[]; table: string; relationship: string; origin: string; fan_out?: string }[];
  measures: { name: string; kind: string; agg?: string; expr?: string }[];
  splits: { field: string; kind: string }[];
  questions: { topic: string; question: string; columns: string[] }[];
}

export interface BriefTable {
  table: string;
  model: string | null;
  model_status: "approved" | "draft" | "missing";
  grain?: string;
  row_count: number | null;
  description?: Fenced;
  columns: BriefColumn[];
  drafted_fields: BriefField[];
  joins: BriefJoin[];
  open_questions: string[];
  baseline_guesses?: BaselineGuesses;
}

export type DroppedKind = "top_values" | "column_details" | "baseline_guesses";

export interface BriefPacket {
  source: string;
  // The batch number, or null when --tables names the tables.
  batch: number | null;
  // How many batches the source's tables to interview make.
  batches: number;
  tables: BriefTable[];
  // dropped: what was trimmed per table; columns counts the columns a step trimmed.
  budget: { limit: number; used: number; truncated: boolean; within_limit: boolean; dropped: { table: string; what: DroppedKind; columns?: number }[] };
}

export interface BriefOptions {
  source: string;
  batch?: number;
  tables?: string[];
  budget?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

// The value with object keys sorted at every level; arrays keep their order.
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = sortKeys(value[k]);
  return out as T;
}

// The packet as printed: keys sorted, no indentation.
export function serializeBrief(packet: BriefPacket): string {
  return JSON.stringify(sortKeys(packet));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// The source's tables to interview, in sl status's next_batch order: in scope, ranked, and without
// an approved model (the last model file over a table decides, as in sl status).
function queue(snapshot: Snapshot, scopeOk: (t: SnapshotTable) => boolean, byTable: Map<string, Model>): SnapshotTable[] {
  return rankTables(snapshot.tables)
    .filter((r) => scopeOk(r.table) && byTable.get(r.qualified.toLowerCase())?.status !== "approved")
    .map((r) => r.table);
}

function fence(text: unknown, from: Provenance): Fenced | undefined {
  return str(text) && text.trim() ? { text: plainText(text), from } : undefined;
}

function column(col: SnapshotColumn, isProtected: boolean, from: Provenance): BriefColumn {
  const p = col.profile;
  const out: BriefColumn = {
    name: col.name,
    type: col.type,
    protected: isProtected,
    null_fraction: typeof p?.null_fraction === "number" ? p.null_fraction : null,
    distinct: typeof p?.distinct_count === "number" ? p.distinct_count : null,
  };
  // A protected column keeps counts only: no comment, no values, no range.
  if (isProtected) return out;
  const description = fence(col.description, from);
  if (description) out.description = description;
  const top = p?.top_values ?? [];
  if (top.length && p?.redacted !== true && !top.some((t) => isHashedValue(t.value))) {
    out.top_values = top.slice(0, TOP_VALUES_MAX).map((t) => ({ text: t.value === null ? null : plainText(String(t.value)), count: t.count, from: "column values" }));
  }
  if (p && (p.min ?? null) !== null && (p.max ?? null) !== null) {
    const v = (x: Scalar) => (str(x) ? plainText(x) : x);
    out.range = { min: v(p.min!), max: v(p.max!), from: "column values" };
  }
  return out;
}

function fields(source: string, m: Model): BriefField[] {
  const out: BriefField[] = [];
  for (const d of Array.isArray(m.dimensions) ? m.dimensions : []) {
    if (!isRecord(d) || !str(d.name)) continue;
    out.push({ ref: `${source}.${m.model}.${d.name}`, kind: "dimension", type: str(d.type) ? d.type : undefined, expr: str(d.expr) ? d.expr : undefined, status: str(d.status) ? d.status : "draft" });
  }
  for (const x of Array.isArray(m.measures) ? m.measures : []) {
    if (!isRecord(x) || !str(x.name)) continue;
    out.push({
      ref: `${source}.${m.model}.${x.name}`,
      kind: "measure",
      expr: str(x.expr) ? x.expr : undefined,
      agg: str(x.agg) ? x.agg : undefined,
      filter: str(x.filter) ? x.filter : undefined,
      status: str(x.status) ? x.status : "draft",
    });
  }
  return out;
}

function joins(m: Model): BriefJoin[] {
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return (Array.isArray(m.joins) ? m.joins : []).filter((j) => isRecord(j) && str(j.name) && str(j.to)).map((j) => {
    const e = j.evidence;
    return {
      name: j.name,
      to: j.to,
      relationship: str(j.relationship) ? j.relationship : "unknown",
      status: str(j.status) ? j.status : "draft",
      ...(isRecord(e)
        ? {
            evidence: {
              match_rate: num(e.match_rate),
              max_fanout: num(e.max_fanout),
              right_key_unique: typeof e.right_key_unique === "boolean" ? e.right_key_unique : undefined,
              suggested_relationship: str(e.suggested_relationship) ? e.suggested_relationship : undefined,
            },
          }
        : {}),
    };
  });
}

function guesses(b: TableBaseline): BaselineGuesses {
  return {
    role: b.role,
    role_reasons: b.role_reasons,
    grain: b.grain,
    primary_key: b.primary_key ? { columns: b.primary_key.columns, how: b.primary_key.how } : null,
    relationships: b.relationships.map((r) => ({ direction: r.direction, columns: r.columns, table: r.table, relationship: r.relationship, origin: r.origin, fan_out: r.fan_out })),
    measures: b.measures.map((m) => ({ name: m.name, kind: m.kind, agg: m.agg, expr: m.expr })),
    splits: b.splits.map((s) => ({ field: s.field, kind: s.kind })),
    questions: b.questions.map((q) => ({ topic: q.topic, question: q.question, columns: q.columns })),
  };
}

// The snapshot with every comment and value set aside, so the baseline's guesses, worded by the
// CLI, quote nothing from the data: they read names, types, keys and counts.
function withoutDataText(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.map((t) => ({
      ...t,
      description: null,
      columns: t.columns.map((c) => {
        const { top_values: _t, min: _min, max: _max, ...counts } = c.profile ?? {};
        return { ...c, description: null, ...(c.profile ? { profile: counts } : {}) };
      }),
    })),
  };
}

export function buildBrief(root: string, opts: BriefOptions): BriefPacket {
  const limit = opts.budget ?? DEFAULT_BRIEF_BUDGET;
  const settings = projectSettings(loadProject(root));
  const batch_size = Math.max(1, Math.floor(settings.batch_size));
  const config = loadSource(root, opts.source);
  const snapshot = requireSnapshot(root, opts.source);
  const scope = effectiveScope(root, config);
  const models = listModels(root, opts.source).map((l) => l.model);
  const byTable = new Map<string, Model>();
  for (const m of models) {
    const t = isRecord(m) && str(m.table) ? findTable(snapshot.tables, m.table) : undefined;
    if (t) byTable.set(qualifiedName(t).toLowerCase(), m);
  }
  const todo = queue(snapshot, (t) => inScope(scope, t), byTable);
  const batches = Math.ceil(todo.length / batch_size);

  let picked: SnapshotTable[];
  if (opts.tables?.length) {
    const named = new Set(resolveTables(snapshot, opts.tables));
    picked = rankTables(snapshot.tables).map((r) => r.table).filter((t) => named.has(t));
  } else {
    const n = opts.batch ?? 1;
    if (!todo.length) {
      throw new UserError(`No table in "${opts.source}" is left to interview: every in-scope table has an approved model. Run \`sl next\` for the next step.`);
    }
    if (n > batches) {
      throw new UserError(
        `"${opts.source}" has ${batches} batch${batches === 1 ? "" : "es"} of up to ${batch_size} tables to interview (${todo.length} tables), so there is no batch ${n}. ` +
          `Run \`sl brief --source ${opts.source} --batch ${batches}\`, or \`sl status\` for the order.`,
      );
    }
    picked = todo.slice((n - 1) * batch_size, n * batch_size);
  }

  const from: Provenance = snapshot.method === "dbt_manifest" ? "dbt" : "database comment";
  const protectedBy = protectedColumns(snapshot.tables, models, snapshot.dialect);
  const report = buildBaseline(withoutDataText(snapshot), {
    source: opts.source,
    scope,
    focusThreshold: settings.focus_threshold,
    tables: picked.map(qualifiedName),
    stripPrefixes: config.draft?.strip_prefixes ?? [],
    models,
  });
  const baselineOf = new Map(report.tables.map((b) => [b.table.toLowerCase(), b]));

  const read = new Map<string, Set<string>>();
  const tables: BriefTable[] = picked.map((t) => {
    const q = qualifiedName(t);
    const m = byTable.get(q.toLowerCase());
    const prot = protectedBy.get(q) ?? new Set<string>();
    read.set(q, new Set(m ? referencedColumns(m, t, snapshot.dialect, incomingKeyColumns(m, models)) : []));
    const b = baselineOf.get(q.toLowerCase());
    const description = fence(t.description, from);
    return {
      table: q,
      model: m?.model ?? null,
      model_status: m ? (m.status === "approved" ? "approved" : "draft") : "missing",
      ...(m && str(m.grain) ? { grain: m.grain } : {}),
      row_count: typeof t.row_count === "number" ? t.row_count : null,
      ...(description ? { description } : {}),
      columns: t.columns.map((c) => column(c, prot.has(c.name) || c.profile?.redacted === true, from)),
      drafted_fields: m ? fields(opts.source, m) : [],
      joins: m ? joins(m) : [],
      open_questions: m && Array.isArray(m.open_questions) ? m.open_questions.filter(str) : [],
      ...(b ? { baseline_guesses: guesses(b) } : {}),
    };
  });

  const packet: BriefPacket = {
    source: opts.source,
    batch: opts.tables?.length ? null : (opts.batch ?? 1),
    batches,
    tables,
    budget: { limit, used: 0, truncated: false, within_limit: true, dropped: [] },
  };
  fit(packet, read);
  return packet;
}

// Trims the packet to its budget in a stable order, each step from the last table and last column
// back: top values, then the details of columns no field of the table's model reads, then baseline
// guesses. Open questions and drafted fields are never dropped. Records what went, and the size.
function fit(packet: BriefPacket, read: Map<string, Set<string>>): void {
  const { budget } = packet;
  const limitChars = budget.limit * CHARS_PER_TOKEN;
  // Measured with the narrowest budget values, a lower bound on the printed size.
  const chars = () => serializeBrief({ ...packet, budget: { ...budget, used: 0, within_limit: true } }).length;
  // Settles `used` on the value that reproduces the printed size (it names itself) and says whether it fits.
  const settle = (): boolean => {
    for (let i = 0; i < 5; i++) {
      const used = estimateTokens(serializeBrief(packet));
      if (used === budget.used && budget.within_limit === used <= budget.limit) break;
      budget.used = used;
      budget.within_limit = used <= budget.limit;
    }
    return budget.within_limit;
  };
  const note = (table: string, what: DroppedKind, counted: boolean) => {
    let d = budget.dropped.find((x) => x.table === table && x.what === what);
    if (!d) budget.dropped.push((d = { table, what, ...(counted ? { columns: 0 } : {}) }));
    if (counted) d.columns! += 1;
    budget.truncated = true;
  };
  // Deletes keys and returns at most how many characters of the printed packet they took.
  const cut = (o: object, keys: string[]): number => {
    const r = o as Record<string, unknown>;
    let n = 0;
    for (const k of keys) {
      if (r[k] === undefined) continue;
      n += k.length + 4 + JSON.stringify(r[k]).length;
      delete r[k];
    }
    return n;
  };
  const backwards = <T>(xs: T[]) => [...xs].reverse();
  const steps: (() => number)[] = [];
  for (const t of backwards(packet.tables)) {
    for (const c of backwards(t.columns)) {
      if (c.top_values) steps.push(() => (note(t.table, "top_values", true), cut(c, ["top_values"])));
    }
  }
  for (const t of backwards(packet.tables)) {
    for (const c of backwards(t.columns)) {
      if (read.get(t.table)?.has(c.name)) continue;
      steps.push(() => {
        const saved = cut(c, ["null_fraction", "distinct", "description", "range"]);
        if (saved) note(t.table, "column_details", true);
        return saved;
      });
    }
  }
  for (const t of backwards(packet.tables)) {
    if (t.baseline_guesses) steps.push(() => (note(t.table, "baseline_guesses", false), cut(t, ["baseline_guesses"])));
  }
  // The running size stays a lower bound between exact checks, so no step runs once the packet fits.
  let size = chars();
  for (const step of steps) {
    if (size <= limitChars) {
      if (settle()) return;
      size = chars();
    }
    size -= step();
  }
  settle();
}

// The figure a measure or metric readback shows: its total on today's data and the rows behind it,
// computed through the reference compiler on a connected source, read-only, under a short timeout.
// The figure is evidence: it is outside the approval hash, and sl readback stores it beside the
// item. A protected value is never computed, and a failure is one line that does not block.
import { canRun } from "./adapters/index.ts";
import type { Adapter } from "./adapters/types.ts";
import { type AccessLayer, loadAccessLayer } from "./access.ts";
import { compileLayer } from "./compiler/index.ts";
import { redactCredentials } from "./credentials.ts";
import { UserError } from "./errors.ts";
import { inlineParams } from "./goldens.ts";
import { intakeMode, upgradeCommand } from "./intake.ts";
import { failureReason, openQueryAdapter } from "./plan.ts";
import { loadFile, loadMetrics, loadSnapshot, loadSource, paths } from "./project.ts";
import { protectedColumns } from "./profile.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { parseTarget } from "./refs.ts";
import { referencedColumns } from "./snapshot-diff.ts";
import type { FigureEvidence, FigurePart, Measure, Metric, Model, SourceConfig } from "./types.ts";
import { PROTECTED_TAGS } from "./types.ts";
import { existsSync } from "node:fs";

// The longest the readback waits for one figure's query; SL_STATEMENT_TIMEOUT_MS can only shorten it.
export const FIGURE_TIMEOUT_MS = 10_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isObj) as T[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const COUNTS = new Set(["count", "count_distinct"]);

// The timeout in milliseconds: SL_STATEMENT_TIMEOUT_MS when it is shorter, else FIGURE_TIMEOUT_MS.
export function figureTimeout(env: Record<string, string | undefined>): number {
  const raw = env.SL_STATEMENT_TIMEOUT_MS?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  return n > 0 ? Math.min(n, FIGURE_TIMEOUT_MS) : FIGURE_TIMEOUT_MS;
}

// The layer as a figure reads it: every item approved and untagged, and no access.yaml, so the
// total covers every row; the readback decides beforehand which figures it may show.
function figureLayer(root: string): AccessLayer {
  const l = loadAccessLayer(root);
  const ok = <T,>(x: T): T => ({ ...x, status: "approved", tags: [] });
  return {
    ...l,
    access: undefined,
    access_present: false,
    compare_hashes: false,
    models: l.models.map((m) => ({ ...ok(m), dimensions: list<Obj>(m.dimensions).map(ok), measures: list<Obj>(m.measures).map(ok) }) as unknown as Model),
    metrics: l.metrics.map(ok),
  };
}

// Why a measure's total would show a protected value, or undefined. A count shows no value, so only
// a tagged measure is held back; any other aggregation is held back when its expr reads a column
// that is protected or that the snapshot does not hold.
function protectedWhy(root: string, source: string, model: Model, m: Measure): string | undefined {
  const tags = [...strs(m.tags), ...strs(model.tags)].map((t) => t.toLowerCase());
  if (tags.some((t) => (PROTECTED_TAGS as readonly string[]).includes(t))) return `${model.model}.${m.name} is tagged ${tags.filter((t) => (PROTECTED_TAGS as readonly string[]).includes(t)).join(", ")}`;
  if (COUNTS.has(String(m.agg))) return undefined;
  let snapshot;
  try {
    snapshot = loadSnapshot(root, source);
  } catch {
    snapshot = null;
  }
  const table = snapshot ? findTable(snapshot.tables, model.table) : undefined;
  if (!snapshot || !table) return `${model.table} is not in the snapshot, so sl cannot tell whether it reads a protected column (sl introspect --source ${source})`;
  const models = list<Model>(loadAccessLayer(root).models).filter((x) => x.source === source);
  const prot = protectedColumns(snapshot.tables, models, loadSource(root, source).dialect).get(qualifiedName(table)) ?? new Set();
  const alone = { ...model, dimensions: [], measures: [{ ...m, filter: undefined }], primary_key: [], joins: list<Obj>(model.joins).map((j) => ({ ...j, keys: [] })) } as unknown as Model;
  const cols = referencedColumns(alone, table, loadSource(root, source).dialect);
  const hit = cols.filter((c) => prot.has(c) || table.columns.find((x) => x.name === c)?.profile?.redacted === true);
  return hit.length ? `it reads the protected column ${hit.join(", ")}` : undefined;
}

// A name for the row-count measure that the model does not use.
function freeName(model: Model): string {
  const used = new Set([...list<Obj>(model.dimensions), ...list<Obj>(model.measures)].map((x) => x.name));
  let name = "sl_rows_behind";
  while (used.has(name)) name += "_";
  return name;
}

interface Job {
  target: string;
  source: string;
  // The queries the figure needs, each giving one row; reads turns their rows into the evidence.
  plan: () => { sqls: string[]; reads: (rows: Obj[][]) => FigureEvidence } | FigureEvidence;
}

// One measure's total and row count, as one compiled query over a copy of its model that adds a
// count with the measure's own filter.
function measurePlan(layer: AccessLayer, source: SourceConfig, root: string, model: string, measure: string) {
  const base = layer.models.find((m) => m.source === source.source && m.model === model)!;
  const m = list<Measure>(base.measures).find((x) => x.name === measure)!;
  const rows = freeName(base);
  const count = { name: rows, agg: "count", status: "approved", ...(m.filter !== undefined ? { filter: m.filter } : {}) };
  const copy = { ...layer, models: layer.models.map((x) => (x === base ? ({ ...x, measures: [...list(x.measures), count] } as unknown as Model) : x)) };
  const c = compileLayer({ layer: copy, source, request: { source: source.source, measures: [`${model}.${measure}`, `${model}.${rows}`] }, root, snapshot: null });
  if (!c.ok) return { why: c.reason };
  return { sql: inlineParams(c.sql, c.params, source.dialect), read: (r: Obj | undefined): FigurePart => ({ ref: `${model}.${measure}`, figure: cell(r?.[measure]), row_count: cell(r?.[rows]) }) };
}

const cell = (v: unknown): number | string | null => (typeof v === "number" || typeof v === "string" ? v : typeof v === "bigint" ? String(v) : null);

function jobFor(root: string, layer: () => AccessLayer, target: string): Job | undefined {
  const t = parseTarget(target);
  if (t.kind === "field") {
    const file = paths(root).model(t.source, t.model);
    const model = existsSync(file) ? loadFile<Model>(root, file, "model") : null;
    if (!model || list<Obj>(model.dimensions).some((d) => d.name === t.field)) return undefined;
    const m = list<Measure>(model.measures).find((x) => x.name === t.field);
    if (!m) return undefined;
    return {
      target,
      source: t.source,
      plan: () => {
        const why = protectedWhy(root, t.source, model, m);
        if (why) return { not_shown: `${why}, so its total is not shown` };
        const p = measurePlan(layer(), loadSource(root, t.source), root, t.model, t.field);
        if ("why" in p) return { not_shown: `the compiler refuses it (${p.why})` };
        return { sqls: [p.sql], reads: ([rows]) => ({ figure: p.read(rows?.[0]).figure, row_count: p.read(rows?.[0]).row_count }) };
      },
    };
  }
  if (t.kind !== "metric") return undefined;
  const metric = list<Metric>(loadMetrics(root).metrics).find((m) => m.name === t.name);
  if (!metric || typeof metric.source !== "string") return undefined;
  const source = metric.source;
  return {
    target,
    source,
    plan: () => {
      const l = layer();
      const src = loadSource(root, source);
      const text = metric.type === "ratio" ? [metric.numerator, metric.denominator].join(" ") : String(metric.expr ?? "");
      const refs = [...new Set([...text.matchAll(/([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/g)].map((x) => `${x[1]}.${x[2]}`))];
      for (const r of refs) {
        const [mo, me] = r.split(".") as [string, string];
        const model = l.models.find((x) => x.source === source && x.model === mo);
        const raw = loadAccessLayer(root).models.find((x) => x.source === source && x.model === mo);
        const m = list<Measure>(raw?.measures).find((x) => x.name === me);
        if (!model || !raw || !m) return { not_shown: `${r} is not a measure of source ${source}` };
        const why = protectedWhy(root, source, raw, m);
        if (why) return { not_shown: `${why}, so its total is not shown` };
      }
      const c = compileLayer({ layer: l, source: src, request: { source, measures: [metric.name] }, root, snapshot: null });
      if (!c.ok) return { not_shown: `the compiler refuses it (${c.reason})` };
      const parts = refs.map((r) => measurePlan(l, src, root, r.split(".")[0]!, r.split(".")[1]!));
      const refused = parts.find((p) => "why" in p);
      if (refused && "why" in refused) return { not_shown: `the compiler refuses it (${refused.why})` };
      const ok = parts as { sql: string; read: (r: Obj | undefined) => FigurePart }[];
      return {
        sqls: [inlineParams(c.sql, c.params, src.dialect), ...ok.map((p) => p.sql)],
        reads: ([own, ...each]) => ({ figure: cell(own?.[0]?.[metric.name]), parts: ok.map((p, i) => p.read(each[i]?.[0])) }),
      };
    },
  };
}

// Why a source's figures are not computed, or undefined when sl can query it.
function sourceWhy(root: string, name: string): string | undefined {
  let source: SourceConfig;
  try {
    source = loadSource(root, name);
  } catch (e) {
    if (e instanceof UserError) return `source ${name} cannot be read (sl validate)`;
    throw e;
  }
  if (intakeMode(source) === "export")
    return `source ${name} is an export source, which sl does not query; the figure comes once it has a connection (${upgradeCommand(name, source.dialect)})`;
  if (!canRun(source)) return `sl does not connect to ${source.dialect} sources`;
  return undefined;
}

// A connection that did not open, in one line without the paths its message may name.
class NotConnected extends Error {
  constructor(source: string, e: unknown) {
    const first = (e instanceof Error ? e.message : String(e)).replace(/^Source "[^"]*":\s*/, "").split(/\.(\s|$)/)[0]!.split("\n")[0]!.trim();
    // A connection message is redacted like the owner's words, so no credential reaches the readback.
    const said = redactCredentials(first).text;
    super(`sl cannot connect to source ${source}${said ? ` (${said})` : ""}; sl next names the step that connects it`);
  }
}

// How long a DuckDB statement interrupted at the deadline gets to stop before the connection is
// given up for the source's later figures.
const GRACE_MS = 2_000;

// A figure's query past the deadline. busy: the statement is still running, so the connection
// serves no later figure.
class TimedOut extends Error {
  constructor(readonly busy: boolean) {
    super("statement timeout");
  }
}

// Runs one statement under the deadline. Postgres enforces it as the statement timeout and cancels
// the statement, so the connection serves the next figure. On DuckDB the statement is interrupted
// at the deadline; one that has not stopped within GRACE_MS is kept in `running`, so the
// connection closes once it ends.
async function timed(adapter: Adapter, sql: string, ms: number, running: Promise<unknown>[]): Promise<Obj[]> {
  const query = adapter.query(sql);
  if (adapter.dialect === "postgres") return (await query).rows as Obj[];
  const wait = <T,>(t: number, v: T) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return { done: new Promise<T>((res) => (timer = setTimeout(() => res(v), t))), stop: () => clearTimeout(timer) };
  };
  const deadline = wait(ms, "late" as const);
  const r = await Promise.race([query, deadline.done]).finally(deadline.stop);
  if (r !== "late") return r.rows as Obj[];
  adapter.interrupt?.();
  const settled = query.then(
    () => true,
    () => true,
  );
  const grace = wait(GRACE_MS, false);
  const stopped = await Promise.race([settled, grace.done]).finally(grace.stop);
  if (!stopped) running.push(settled);
  throw new TimedOut(!stopped);
}

// A request sl sql compiles for one measure or metric target, so the owner can get its figure with
// sl run, which waits longer.
function byHand(target: string, source: string): string {
  const t = parseTarget(target);
  const name = t.kind === "metric" ? t.name : t.kind === "field" ? `${t.model}.${t.field}` : target;
  return `sl sql --source ${source} --request '{"measures":["${name}"]}' prints its query, and sl run --source ${source} --sql runs it with a longer timeout`;
}

// The evidence for each measure and metric target, computed per source over one connection. A
// target of any other kind gets no entry. Never throws for a query: each failure is its reason.
export async function readbackFigures(root: string, targets: readonly string[], env: Record<string, string | undefined>): Promise<Map<string, FigureEvidence>> {
  const out = new Map<string, FigureEvidence>();
  let cached: AccessLayer | undefined;
  const layer = () => (cached ??= figureLayer(root));
  const jobs: Job[] = [];
  for (const target of new Set(targets)) {
    try {
      const j = jobFor(root, layer, target);
      if (j) jobs.push(j);
    } catch {
      // A file that cannot be read gets no figure; the readback itself reports it.
    }
  }
  const ms = figureTimeout(env);
  for (const source of new Set(jobs.map((j) => j.source))) {
    const mine = jobs.filter((j) => j.source === source);
    const skip = sourceWhy(root, source);
    if (skip) {
      for (const j of mine) out.set(j.target, { not_shown: skip });
      continue;
    }
    const src = loadSource(root, source);
    let adapter: Adapter | undefined;
    let stop: ((target: string) => string) | undefined;
    const running: Promise<unknown>[] = [];
    try {
      for (const j of mine) {
        if (stop) {
          out.set(j.target, { not_shown: stop(j.target) });
          continue;
        }
        try {
          const p = j.plan();
          if (!("sqls" in p)) {
            out.set(j.target, p);
            continue;
          }
          if (!adapter) {
            try {
              adapter = await openQueryAdapter(root, src, { ...env, SL_STATEMENT_TIMEOUT_MS: String(ms) }, { warn: () => {} });
            } catch (e) {
              throw new NotConnected(source, e);
            }
          }
          const rows: Obj[][] = [];
          for (const sql of p.sqls) rows.push(await timed(adapter, sql, ms, running));
          out.set(j.target, p.reads(rows));
        } catch (e) {
          const reason = e instanceof NotConnected ? e.message : failureReason(e, { timeoutMs: ms });
          const late = e instanceof TimedOut || reason.startsWith("timed out");
          out.set(j.target, { not_shown: late ? `timed out after ${ms / 1000} s, so the readback went on without it; ${byHand(j.target, source)}` : reason });
          // A connection that did not open serves no figure; a statement still running holds it.
          if (e instanceof NotConnected) stop = () => reason;
          else if (e instanceof TimedOut && e.busy)
            stop = (target) => `not computed, as an earlier figure on source ${source} timed out and is still running; run sl readback --targets ${target} on its own`;
        }
      }
    } finally {
      // A DuckDB statement past its deadline closes the connection once it finishes, unwaited.
      const a = adapter;
      if (running.length) void Promise.all(running).then(() => a?.close().catch(() => {}));
      else await a?.close().catch(() => {});
    }
  }
  return out;
}

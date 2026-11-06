// figures: every approved golden mapped to a reference figure produces that figure, and no approved
// golden produces a common mistake's value. A golden's figure comes from compiling its request with
// the reference compiler and running it on the run's duckdb source when the compiler can; otherwise
// from the golden's recorded expected rows. Each detail says which path it took.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Adapter, openAdapter } from "../../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { compileRequest } from "../../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { splitQualified } from "../../skills/semantic-layer/scripts/lib/naming.ts";
import { matchesPattern } from "../../skills/semantic-layer/scripts/lib/patterns.ts";
import { listGoldens, listModels, loadMetrics, loadSource } from "../../skills/semantic-layer/scripts/lib/project.ts";
import { parseRequestField } from "../../skills/semantic-layer/scripts/lib/refs.ts";
import type { Golden, Metric } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { evalSchemaIssues } from "../../skills/semantic-layer/scripts/lib/validate.ts";
import { REPO_ROOT } from "../runner/files.ts";
import type { FigureEntry, FigureMapping, GraderResult, RunFiles } from "./types.ts";

type Row = Record<string, unknown>;

interface Figure {
  name: string;
  value?: number;
  rows?: Row[];
  definition?: string;
}

interface Produced {
  rows: Row[];
  key?: string;
  value?: string;
  path: string;
}

const asNumber = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

// A value equals a figure when it is within the relative tolerance, or rounds to the figure at the
// figure's own decimal places, since reference figures are published rounded.
export function equalsFigure(actual: unknown, figure: number, tolerance = 0): boolean {
  const a = asNumber(actual);
  if (a === null) return false;
  if (Math.abs(a - figure) <= tolerance * Math.max(Math.abs(a), Math.abs(figure))) return true;
  const places = (String(figure).split(".")[1] ?? "").length;
  return Number(a.toFixed(places)) === figure;
}

// Replaces $1, $2, ... outside quotes with the parameters as SQL literals, so the compiled query runs
// through the adapter's read-only query call, which takes no parameters.
export function inlineParams(sql: string, params: unknown[]): string {
  const literal = (v: unknown): string => {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
    throw new Error(`a request parameter is not a string, number or boolean: ${JSON.stringify(v)}`);
  };
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const m = ch === "$" ? /^\$(\d+)/.exec(sql.slice(i)) : null;
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= params.length) {
      out += literal(params[Number(m[1]) - 1]);
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// The column a request names for a field: field, field_grain or a metric's name.
const columnOf = (ref: string | undefined): string | undefined => {
  if (!ref) return undefined;
  const p = parseRequestField(ref);
  return p ? (p.grain ? `${p.field}_${p.grain}` : p.field) : ref;
};

// The model the request starts from: its first measure's, a metric's first measure's (a ratio's
// numerator, a derived metric's first {model.measure}), or else its first dimension's.
export function firstModel(golden: Golden, metrics: Metric[]): string | undefined {
  const ref = golden.request?.measures?.[0] ?? golden.request?.dimensions?.[0] ?? "";
  const direct = parseRequestField(ref);
  if (direct) return direct.model;
  const metric = metrics.find((m) => m.name === ref && (m.source ?? golden.request?.source) === golden.request?.source);
  const measure = metric?.type === "ratio" ? metric.numerator : metric?.type === "derived" ? /\{([^}]*)\}/.exec(metric.expr ?? "")?.[1] : undefined;
  return measure ? parseRequestField(measure.trim())?.model : undefined;
}

function matches(entry: FigureEntry, golden: Golden, table: string | undefined): boolean {
  if (entry.golden && !matchesPattern(entry.golden, { schema: null, name: golden.name })) return false;
  const r = entry.request;
  if (!r) return true;
  if (r.source !== undefined && r.source !== golden.request?.source) return false;
  if (r.grouped !== undefined && r.grouped !== (golden.request?.dimensions ?? []).length > 0) return false;
  return r.table === undefined || (table !== undefined && matchesPattern(r.table, splitQualified(table)));
}

async function produce(run: RunFiles, golden: Golden, adapters: Map<string, Adapter>): Promise<Produced> {
  const recorded = (why: string): Produced => ({
    rows: golden.expected?.rows ?? [],
    key: columnOf(golden.request?.dimensions?.[0]),
    value: columnOf(golden.request?.measures?.[0]),
    path: `from the golden's recorded rows, since ${why}`,
  });
  let compiled;
  try {
    compiled = compileRequest(run.root, golden.request, { role: golden.role, user: golden.user });
  } catch (e) {
    return recorded(`the compiler could not read the layer (${(e as Error).message})`);
  }
  if (!compiled.ok) return recorded(`sl sql refuses it: ${compiled.reason}`);
  if (compiled.dialect !== "duckdb") return recorded(`the grader runs compiled SQL on duckdb sources only and ${compiled.source} is ${compiled.dialect}`);
  let adapter = adapters.get(compiled.source);
  if (!adapter) {
    adapter = await openAdapter(run.root, loadSource(run.root, compiled.source), {});
    adapters.set(compiled.source, adapter);
  }
  const { rows } = await adapter.query(inlineParams(compiled.sql, compiled.params));
  return {
    rows,
    key: compiled.columns.find((c) => c.kind === "dimension")?.name,
    value: compiled.columns.find((c) => c.kind === "measure")?.name,
    path: `compiled by the reference compiler and run on ${compiled.source}`,
  };
}

// The produced value of a one-row golden: its value column, or its only number.
function scalar(p: Produced): unknown {
  if (p.rows.length !== 1) return undefined;
  const row = p.rows[0]!;
  if (p.value && p.value in row) return row[p.value];
  const nums = Object.values(row).filter((v) => asNumber(v) !== null);
  return nums.length === 1 ? nums[0] : undefined;
}

// Why rows differ from a figure's rows, or undefined when every key has its value and nothing else.
function rowsDiffer(p: Produced, fig: Figure, entry: FigureEntry): string | undefined {
  const key = p.key && p.rows.every((r) => p.key! in r) ? p.key : undefined;
  const val = p.value && p.rows.every((r) => p.value! in r) ? p.value : undefined;
  if (!key || !val || !entry.key || !entry.value) return "its rows have no key and value columns to compare (the mapping names key and value)";
  const got = new Map(p.rows.map((r) => [String(r[key]), r[val]]));
  for (const want of fig.rows ?? []) {
    const k = String(want[entry.key]);
    const target = asNumber(want[entry.value]);
    if (!got.has(k)) return `it has no row for ${k}`;
    if (target === null || !equalsFigure(got.get(k), target, entry.tolerance)) return `${k} is ${String(got.get(k))}, not ${String(want[entry.value])}`;
  }
  const extra = [...got.keys()].filter((k) => !(fig.rows ?? []).some((w) => String(w[entry.key!]) === k));
  return extra.length ? `it has rows the figure lacks: ${extra.join(", ")}` : undefined;
}

export async function gradeFigures(run: RunFiles): Promise<GraderResult> {
  const grader = "figures";
  const refFile = join(run.fixtureDir, "reference-figures.json");
  if (!existsSync(refFile)) return { grader, score: null, passed: true, details: [`not graded: the fixture has no reference-figures.json`] };
  const reference = JSON.parse(readFileSync(refFile, "utf8")) as { figures: Figure[]; common_mistakes?: Figure[] };
  const mistakes = (reference.common_mistakes ?? []).filter((m): m is Figure & { value: number } => typeof m.value === "number");
  const mapFile = run.grading.figures ? join(run.scenarioDir, run.grading.figures) : undefined;
  const mapName = mapFile ? relative(REPO_ROOT, mapFile) : "grading.figures";
  let mapping: FigureMapping = { figures: [] };
  if (mapFile) {
    if (!existsSync(mapFile)) return { grader, score: 0, passed: false, details: [`${mapName} is missing; the scenario's grading.figures names it.`] };
    mapping = JSON.parse(readFileSync(mapFile, "utf8")) as FigureMapping;
    const issues = evalSchemaIssues("eval-figures", mapping, mapName);
    if (issues.length) return { grader, score: 0, passed: false, details: issues.map((i) => `${mapName}: ${i.path || "(top)"} ${i.message}`) };
    const unknown = mapping.figures.filter((e) => !reference.figures.some((f) => f.name === e.figure));
    if (unknown.length) {
      const refName = relative(REPO_ROOT, refFile);
      return { grader, score: 0, passed: false, details: unknown.map((e) => `${mapName}: ${e.figure} is not a figure of ${refName}; fix the name in the mapping file.`) };
    }
  }
  const goldens = listGoldens(run.root).filter((g) => g.golden.status === "approved");
  if (!goldens.length) return { grader, score: null, passed: true, details: ["not graded: the run has no approved golden (semantic/goldens/)"] };
  const tables = new Map(listModels(run.root).map(({ model }) => [`${model.source}.${model.model}`, model.table]));
  const metrics = loadMetrics(run.root).metrics ?? [];
  const adapters = new Map<string, Adapter>();
  const details: string[] = [];
  let checks = 0;
  let ok = 0;
  try {
    for (const { path, golden } of goldens) {
      const file = `semantic/${relative(run.root, path).split("\\").join("/")}`;
      const model = firstModel(golden, metrics);
      const table = model ? tables.get(`${golden.request?.source}.${model}`) : undefined;
      const entry = mapping.figures.find((e) => matches(e, golden, table));
      const fig = entry && reference.figures.find((f) => f.name === entry.figure);
      let produced: Produced;
      try {
        produced = await produce(run, golden, adapters);
      } catch (e) {
        checks++;
        details.push(`${file}: running its compiled request failed: ${(e as Error).message}`);
        continue;
      }
      const value = scalar(produced);
      // A common mistake matches at its own rounding only; a mapping's tolerance does not widen it.
      const mistake = value === undefined ? undefined : mistakes.find((m) => equalsFigure(value, m.value));
      if (!entry || !fig) {
        if (mistake) {
          checks++;
          details.push(`${file}: ${String(value)} (${produced.path}) equals the common mistake ${mistake.name}: ${mistake.definition ?? ""}`.trimEnd());
        } else details.push(`${file}: maps to no reference figure in ${mapName}, so it is not compared.`);
        continue;
      }
      checks++;
      const wrong =
        fig.rows !== undefined
          ? rowsDiffer(produced, fig, entry)
          : value === undefined
            ? `it returns ${produced.rows.length} row(s), not one value`
            : equalsFigure(value, fig.value!, entry.tolerance)
              ? undefined
              : `it is ${String(value)}, not ${fig.value}`;
      if (!wrong && !mistake) {
        ok++;
        details.push(`${file}: ${fig.name} matches the reference figure (${produced.path}).`);
        continue;
      }
      if (wrong) details.push(`${file}: ${fig.name} does not match the reference figure: ${wrong} (${produced.path}).`);
      if (mistake) details.push(`${file}: ${fig.name} equals the common mistake ${mistake.name}: ${mistake.definition ?? ""}`.trimEnd());
    }
  } finally {
    for (const a of adapters.values()) await a.close();
  }
  if (!checks) return { grader, score: null, passed: true, details };
  return { grader, score: ok / checks, passed: ok === checks, details };
}

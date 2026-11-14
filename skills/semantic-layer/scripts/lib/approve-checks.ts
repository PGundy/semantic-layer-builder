// What an item needs before sl approve records its approval, known from its file alone: a model's
// grain and primary_key, a measure's or metric's description, and a metric's measure references.
// sl approve refuses an item that lacks one, and sl readback refuses to read such an item back, so the
// owner never says yes to an item the approval would then refuse (spec: sl readback).
import { existsSync } from "node:fs";
import { UserError } from "./errors.ts";
import { loadFile, loadMetrics, paths } from "./project.ts";
import { findField, parseTarget } from "./refs.ts";
import { NAME_PATTERN, type Metric, type Model } from "./types.ts";

export function modelProblems(ref: string, m: Model): string[] {
  const out: string[] = [];
  if (!m.grain || !String(m.grain).trim()) out.push(`${ref} has no grain`);
  if (!m.primary_key || !m.primary_key.length) out.push(`${ref} has no primary_key`);
  return out;
}

export function describedProblem(ref: string, kind: string, item: { description?: string }): string | null {
  return item.description && item.description.trim() ? null : `${kind} ${ref} has no description`;
}

// Whether a reference is exactly model.measure, the form sl validate accepts.
function isMeasureRef(r: string): boolean {
  const parts = r.split(".");
  return parts.length === 2 && parts.every((p) => NAME_PATTERN.test(p));
}

// The model.measure references of a metric, and problems with references that are not in that form.
// Each problem and reference carries the key of the metric that holds it (numerator, denominator or expr).
export interface MetricProblem {
  text: string;
  key: "numerator" | "denominator" | "expr" | "description";
}

export function metricMeasureRefs(m: Metric): { refs: { ref: string; key: MetricProblem["key"] }[]; problems: MetricProblem[] } {
  const refs: { ref: string; key: MetricProblem["key"] }[] = [];
  const problems: MetricProblem[] = [];
  if (m.type === "ratio") {
    for (const side of ["numerator", "denominator"] as const) {
      const r: unknown = m[side];
      if (typeof r === "string" && isMeasureRef(r)) refs.push({ ref: r, key: side });
      else problems.push({ text: `its ${side} ${JSON.stringify(r ?? null)} is not a model.measure reference`, key: side });
    }
    return { refs, problems };
  }
  const expr = String(m.expr ?? "");
  const groups = [...expr.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]!);
  if (!groups.length) problems.push({ text: "its expr has no {model.measure} placeholder", key: "expr" });
  for (const g of groups) {
    if (isMeasureRef(g)) refs.push({ ref: g, key: "expr" });
    else problems.push({ text: `its expr placeholder {${g}} is not {model.measure} (lowercase names, no spaces)`, key: "expr" });
  }
  return { refs, problems };
}

// A metric's own problems and the measures it names that are drafts. A draft measure is refused by
// sl approve only: the owner may approve it before the metric, in the same readback.
export function metricProblems(root: string, metric: Metric): { problems: string[]; drafts: string[] } {
  const { problems, drafts } = metricChecks(root, metric);
  return { problems: problems.map((p) => p.text), drafts };
}

function metricChecks(root: string, metric: Metric): { problems: MetricProblem[]; drafts: string[] } {
  const problems: MetricProblem[] = [];
  const missing = describedProblem(`metric:${metric.name}`, "Metric", metric);
  if (missing) problems.push({ text: missing, key: "description" });
  const drafts: string[] = [];
  // A metric whose source is not a name has no measures to look up: sl validate reports it.
  if (typeof metric.source !== "string") return { problems, drafts };
  const { refs, problems: refProblems } = metricMeasureRefs(metric);
  problems.push(...refProblems);
  for (const { ref: r, key } of refs) {
    const [modelName, measureName] = r.split(".") as [string, string];
    const modelPath = paths(root).model(metric.source, modelName);
    const model = existsSync(modelPath) ? loadFile<Model>(root, modelPath, "model", true) : null;
    const measure = (Array.isArray(model?.measures) ? model.measures : []).find((x) => !!x && typeof x === "object" && x.name === measureName);
    if (!measure) problems.push({ text: `measure ${metric.source}.${r} does not exist`, key });
    else if (measure.status !== "approved") drafts.push(`${metric.source}.${r}`);
  }
  return { problems, drafts: [...new Set(drafts)] };
}

// One thing an item lacks, and the typed edit (the words after "sl") that gives it.
export interface Lack {
  target: string;
  text: string;
  edit: string[];
}

const DESCRIBE = "<what it means, in the owner's words>";

// What each target lacks that sl approve would refuse it for, besides the owner's yes. Unknown
// targets are left to the readback, which names them.
export function approvalLacks(root: string, refs: string[]): Lack[] {
  const out: Lack[] = [];
  for (const ref of [...new Set(refs)]) {
    const t = parseTarget(ref);
    if (t.kind === "metric") {
      const metrics = loadMetrics(root)?.metrics;
      const metric = (Array.isArray(metrics) ? metrics : []).find((m) => !!m && typeof m === "object" && m.name === t.name);
      if (!metric) continue;
      for (const { text, key } of metricChecks(root, metric).problems) {
        const edit =
          key === "description"
            ? ["set", ref, "description", DESCRIBE]
            : key === "expr"
              ? ["set", ref, "expr", "<expr naming each {model.measure}>"]
              : ["set", ref, key, "<model.measure>"];
        out.push({ target: ref, text, edit });
      }
      continue;
    }
    if (t.kind !== "model" && t.kind !== "field") continue;
    const file = paths(root).model(t.source, t.model);
    const model = existsSync(file) ? loadFile<Model>(root, file, "model", true) : null;
    if (!model || typeof model !== "object") continue;
    if (t.kind === "model") {
      for (const text of modelProblems(ref, model))
        out.push({ target: ref, text, edit: text.endsWith("no grain") ? ["set", ref, "grain", "<what one row is, in the owner's words>"] : ["set", ref, "primary_key", "[<column>, ...]"] });
      continue;
    }
    const match = findField(model, t.field);
    if (match?.kind !== "measure") continue;
    const text = describedProblem(ref, "Measure", match.item);
    if (text) out.push({ target: ref, text, edit: ["set", ref, "description", DESCRIBE] });
  }
  return out;
}

// The sl apply input that gives every item what it lacks.
export function lacksFile(lacks: Lack[]): string {
  return JSON.stringify({ edits: lacks.map((l) => l.edit) });
}

// The sentence sl next gives in place of a readback its targets are not ready for: what each lacks
// and the one sl apply that gives it.
export function lacksNote(lacks: Lack[]): string {
  return (
    `sl readback would refuse ${lacks.length === 1 ? "this item" : "these items"} first, because sl approve would refuse ${lacks.length === 1 ? "it" : "them"} after the owner's yes: ` +
    `${lacks.map((l) => `${l.target}: ${l.text}`).join("; ")}. Ask the owner for each <placeholder> you do not know, then run the command below ` +
    `with this on its standard input: ${lacksFile(lacks)}. Then read them back.`
  );
}

// sl readback's refusal of targets sl approve would refuse after the owner's yes: each item, what it
// lacks, and the one sl apply that gives them all.
export function readbackGate(root: string, refs: string[]): void {
  const lacks = approvalLacks(root, refs);
  if (!lacks.length) return;
  const file = lacksFile(lacks);
  throw new UserError(
    [
      `Cannot read ${lacks.length === 1 ? "this item" : "these items"} back yet: sl approve would refuse ${lacks.length === 1 ? "it" : "them"} after the owner's yes, so nothing was written.`,
      ...lacks.map((l) => `  - ${l.target}: ${l.text}`),
      `Give ${lacks.length === 1 ? "it" : "them"} in one command, each <placeholder> filled in from what the owner said (ask them for what you do not know), then run the same sl readback again:`,
      `  sl apply --file - with this on its standard input: ${file}`,
    ].join("\n"),
    "sl apply --file -",
  );
}

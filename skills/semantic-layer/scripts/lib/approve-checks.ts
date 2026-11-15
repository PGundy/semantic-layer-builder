// What an item needs before semlayer approve records its approval: a model's grain and primary_key, a
// measure's or metric's description, a metric's measure references, and whatever else semlayer validate
// would raise of the item once it is approved (approvedIssues). semlayer approve refuses an item that lacks
// one, and semlayer readback refuses to read such an item back, so the owner never says yes to an item the
// approval would then refuse, and approving never adds a validate issue (spec: semlayer readback).
import { existsSync, readFileSync } from "node:fs";
import { UNHASHED_MESSAGE } from "./approval-hash.ts";
import { itemMap, locate, pathText, relFile } from "./edit.ts";
import { UserError } from "./errors.ts";
import { loadFile, loadMetrics, paths } from "./project.ts";
import { type Issue, validateProject } from "./validate.ts";
import { editYamlText } from "./yaml.ts";
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

// Whether a reference is exactly model.measure, the form semlayer validate accepts.
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
// semlayer approve only: the owner may approve it before the metric, in the same readback.
export function metricProblems(root: string, metric: Metric): { problems: string[]; drafts: string[] } {
  const { problems, drafts } = metricChecks(root, metric);
  return { problems: problems.map((p) => p.text), drafts };
}

function metricChecks(root: string, metric: Metric): { problems: MetricProblem[]; drafts: string[] } {
  const problems: MetricProblem[] = [];
  const missing = describedProblem(`metric:${metric.name}`, "Metric", metric);
  if (missing) problems.push({ text: missing, key: "description" });
  const drafts: string[] = [];
  // A metric whose source is not a name has no measures to look up: semlayer validate reports it.
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

// One thing an item lacks, and the typed edit (the words after "semlayer") that gives it, when one does.
export interface Lack {
  target: string;
  text: string;
  edit?: string[];
}

// Issues an approval adds that are not the item's to fix before it: the approval's own bookkeeping
// (its hash and the owner's recorded yes, which semlayer approve writes and checks), the lacks checked
// above, a join without evidence (semlayer approve warns of it, and on an export source it waits on a
// connection, decision D2), and a metric's draft measures (semlayer approve refuses the metric until they
// are approved, which may happen in the same readback).
const APPROVAL_OWN = [
  "changed since it was approved",
  "approved_hash is missing",
  UNHASHED_MESSAGE,
  "no recorded owner yes in",
  "is required on an approved",
  "is approved without evidence",
  "an approved metric may use only approved measures",
];

// The words of semlayer validate's warning on an untagged field that looks sensitive, which a tag fixes.
const SENSITIVE_UNTAGGED = "is visible to everyone and looks sensitive";

// The words of semlayer validate's error on an approved to-one join whose evidence fans out, which the
// owner's reason in fanout_override settles when the keys and relationship are right.
const FANS_OUT = "so the join fans out";

// The semlayer set that records the owner's reason on the join an issue at `path` is about: the target
// itself when it is the join, or the join of the model target the path names.
function fanoutEdit(root: string, target: string, path: string): string[] | undefined {
  let ref = target;
  if (target.split(".").length === 2) {
    const n = /^joins\[(\d+)\]/.exec(path);
    const join = n ? (locate(root, target).item.joins as { name?: unknown }[] | undefined)?.[Number(n[1])] : undefined;
    if (typeof join?.name !== "string") return undefined;
    ref = `${target}.${join.name}`;
  }
  return ["set", ref, "fanout_override", "<why the owner accepts the data, in their words>"];
}

// The value to fill in for a key an approved item lacks, by key.
const PLACEHOLDER: Record<string, string> = {
  currency: "<ISO 4217 code, such as USD, as the owner said>",
};

// What semlayer validate would raise of `refs` once they are approved that it does not raise now: the
// layer is validated as it is and as it would read with every target approved (its hash left out,
// which APPROVAL_OWN passes over).
export function approvedIssues(root: string, refs: string[]): Lack[] {
  const located: { ref: string; rel: string; at: string }[] = [];
  const byFile = new Map<string, (string | number)[][]>();
  for (const ref of [...new Set(refs)]) {
    let loc;
    try {
      if (parseTarget(ref).kind === "golden") continue;
      loc = locate(root, ref);
    } catch {
      continue;
    }
    if (loc.item.status === "approved") continue;
    located.push({ ref, rel: relFile(root, loc.file), at: pathText(loc.path) });
    byFile.set(loc.file, [...(byFile.get(loc.file) ?? []), loc.path]);
  }
  if (!located.length) return [];
  // Both sides set each target's status, so an item with none is checked in full on both.
  const stamp = (approved: boolean) => {
    const overrides = new Map<string, string>();
    for (const [file, list] of byFile) {
      try {
        overrides.set(
          file,
          editYamlText(readFileSync(file, "utf8"), (doc) =>
            list.forEach((path) => {
              const map = itemMap(doc, path);
              map.set("status", approved ? "approved" : "draft");
              if (approved) for (const [k, v] of [["approved_by", "owner"], ["approved_at", "2000-01-01"]]) map.set(k, v);
            }),
          ),
        );
      } catch {
        // A file that is not a mapping is left to the readback and to semlayer validate, which name it.
      }
    }
    return overrides;
  };
  const key = (i: Issue) => `${i.file}\0${i.path}\0${i.message}`;
  const left = new Map<string, number>();
  for (const i of validateProject(root, stamp(false))) left.set(key(i), (left.get(key(i)) ?? 0) + 1);
  const out: Lack[] = [];
  for (const i of validateProject(root, stamp(true))) {
    const n = left.get(key(i)) ?? 0;
    left.set(key(i), n - 1);
    if (n > 0 || APPROVAL_OWN.some((m) => i.message.includes(m))) continue;
    // The target the issue is about: the one whose item holds its path, the deepest first.
    const owner = located
      .filter((l) => l.rel === i.file && (l.at === "" || i.path === l.at || i.path.startsWith(`${l.at}.`) || i.path.startsWith(`${l.at}[`)))
      .sort((a, b) => b.at.length - a.at.length)[0];
    const target = owner?.ref ?? located[0]!.ref;
    const rest = owner ? i.path.slice(owner.at.length).replace(/^\./, "") : "";
    const edit =
      /^[a-z_]+$/.test(rest) && PLACEHOLDER[rest]
        ? ["set", target, rest, PLACEHOLDER[rest]!]
        : i.message.includes(SENSITIVE_UNTAGGED) && target.split(".").length === 3
          ? ["tag", target, "<pii, sensitive or public, as the owner said>"]
          : i.message.includes(FANS_OUT)
            ? fanoutEdit(root, target, i.path)
            : undefined;
    out.push({ target, text: `once approved, semlayer validate says ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`, ...(edit ? { edit } : {}) });
  }
  return out;
}

const DESCRIBE = "<what it means, in the owner's words>";

// What each target lacks that semlayer approve would refuse it for, besides the owner's yes. Unknown
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
  return [...out, ...approvedIssues(root, refs)];
}

// The semlayer apply input that gives every item what it lacks, for the lacks a typed edit gives.
export function lacksFile(lacks: Lack[]): string {
  return JSON.stringify({ edits: lacks.flatMap((l) => (l.edit ? [l.edit] : [])) });
}

// The sentence semlayer next gives in place of a readback its targets are not ready for: what each lacks
// and the one semlayer apply that gives it.
export function lacksNote(lacks: Lack[]): string {
  const head =
    `semlayer readback would refuse ${lacks.length === 1 ? "this item" : "these items"} first, because semlayer approve would refuse ${lacks.length === 1 ? "it" : "them"} after the owner's yes: ` +
    `${lacks.map((l) => `${l.target}: ${l.text}`).join("; ")}.`;
  if (!lacks.some((l) => l.edit)) return `${head} Fix each with a typed edit as its words say (semlayer validate lists them), then read them back.`;
  const other = lacks.some((l) => !l.edit) ? " Add a typed edit to that input for each lack it does not cover, as its words say." : "";
  return `${head} Ask the owner for each <placeholder> you do not know, then run the command below with this on its standard input: ${lacksFile(lacks)}.${other} Then read them back.`;
}

// semlayer readback's refusal of targets semlayer approve would refuse after the owner's yes: each item, what it
// lacks, and the one semlayer apply that gives them all.
export function readbackGate(root: string, refs: string[]): void {
  const lacks = approvalLacks(root, refs);
  if (!lacks.length) return;
  const edits = lacks.filter((l) => l.edit);
  const fix = edits.length
    ? [
        `Give ${lacks.length === 1 ? "it" : "them"} in one command, each <placeholder> filled in from what the owner said (ask them for what you do not know)${edits.length < lacks.length ? ", fix the other lines as their words say" : ""}, then run the same semlayer readback again:`,
        `  semlayer apply --file - with this on its standard input: ${lacksFile(lacks)}`,
      ]
    : ["Fix each as its words say, with a typed edit (several in one semlayer apply --file -), then run the same semlayer readback again."];
  throw new UserError(
    [
      `Cannot read ${lacks.length === 1 ? "this item" : "these items"} back yet: semlayer approve would refuse ${lacks.length === 1 ? "it" : "them"} after the owner's yes, so nothing was written.`,
      ...lacks.map((l) => `  - ${l.target}: ${l.text}`),
      ...fix,
    ].join("\n"),
    "semlayer apply --file -",
  );
}

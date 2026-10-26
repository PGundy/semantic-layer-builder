import { existsSync } from "node:fs";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str, today } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadAccess, loadMetrics, loadModel, loadProject, paths } from "../lib/project.ts";
import { findField, parseTarget } from "../lib/refs.ts";
import { NAME_PATTERN, type Approval, type Metric, type Model, type Status } from "../lib/types.ts";
import { readYaml, updateYaml } from "../lib/yaml.ts";

interface Change {
  target: string;
  from: Status;
  to: Status;
}

// One item to flip, located by its path inside one YAML file.
interface Edit {
  target: string;
  path: (string | number)[];
  from: Status;
}

type Mode = { revoke: false; by: string; at: string } | { revoke: true };

function statusOf(item: Approval): Status {
  return item.status === "approved" ? "approved" : "draft";
}

// Whether the item already holds the state this run would give it.
function settled(item: Approval, mode: Mode): boolean {
  if (mode.revoke) return item.status !== "approved" && item.approved_by === undefined && item.approved_at === undefined;
  return item.status === "approved" && !!item.approved_by && !!item.approved_at;
}

function keyIndex(map: YAMLMap, key: string): number {
  return map.items.findIndex((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
}

// Keys a new status goes after, in order of preference, so it sits near the item's name.
const STATUS_ANCHORS = ["table", "model", "name"];

// Sets a scalar in place so a trailing comment on it survives. A new key goes after the first
// of `after` the map holds, or at the top of the map when it holds none of them.
function setScalar(doc: Document, map: YAMLMap, key: string, value: string, after: string[]): void {
  const node = map.get(key, true);
  if (isScalar(node)) {
    node.value = value;
    return;
  }
  if (node !== undefined) {
    map.set(key, value);
    return;
  }
  const pair = doc.createPair(key, value);
  const at = after.map((k) => keyIndex(map, k)).find((i) => i >= 0);
  if (at !== undefined) {
    map.items.splice(at + 1, 0, pair);
    return;
  }
  // At the top, the comment above the old first key moves up to stay above the map.
  const first = map.items[0];
  if (first && isScalar(first.key) && first.key.commentBefore !== undefined && isScalar(pair.key)) {
    pair.key.commentBefore = first.key.commentBefore;
    first.key.commentBefore = undefined;
  }
  map.items.unshift(pair);
}

function applyEdit(doc: Document, path: (string | number)[], mode: Mode): void {
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (!isMap(node)) throw new UserError(`Cannot edit ${path.join(".") || "the document root"}: it is not a mapping.`);
  if (mode.revoke) {
    setScalar(doc, node, "status", "draft", STATUS_ANCHORS);
    node.delete("approved_by");
    node.delete("approved_at");
  } else {
    setScalar(doc, node, "status", "approved", STATUS_ANCHORS);
    setScalar(doc, node, "approved_by", mode.by, ["status"]);
    setScalar(doc, node, "approved_at", mode.at, ["approved_by", "status"]);
  }
}

function modelProblems(ref: string, m: Model): string[] {
  const out: string[] = [];
  if (!m.grain || !String(m.grain).trim()) out.push(`${ref} has no grain`);
  if (!m.primary_key || !m.primary_key.length) out.push(`${ref} has no primary_key`);
  return out;
}

function describedProblem(ref: string, kind: string, item: { description?: string }): string | null {
  return item.description && item.description.trim() ? null : `${kind} ${ref} has no description`;
}

function joinWarning(source: string, model: string, join: string): string {
  return `Join ${source}.${model}.${join} has no evidence. Run sl check-join --source ${source} --model ${model} --join ${join} before relying on it.`;
}

// Whether a reference is exactly model.measure, the form sl validate accepts.
function isMeasureRef(r: string): boolean {
  const parts = r.split(".");
  return parts.length === 2 && parts.every((p) => NAME_PATTERN.test(p));
}

// The model.measure references of a metric, and problems with references that are not in that form.
function metricMeasureRefs(m: Metric): { refs: string[]; problems: string[] } {
  const refs: string[] = [];
  const problems: string[] = [];
  if (m.type === "ratio") {
    for (const side of ["numerator", "denominator"] as const) {
      const r: unknown = m[side];
      if (typeof r === "string" && isMeasureRef(r)) refs.push(r);
      else problems.push(`its ${side} ${JSON.stringify(r ?? null)} is not a model.measure reference`);
    }
    return { refs, problems };
  }
  const expr = String(m.expr ?? "");
  const groups = [...expr.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]!);
  if (!groups.length) problems.push("its expr has no {model.measure} placeholder");
  for (const g of groups) {
    if (isMeasureRef(g)) refs.push(g);
    else problems.push(`its expr placeholder {${g}} is not {model.measure} (lowercase names, no spaces)`);
  }
  return { refs, problems };
}

function refuse(what: string, problems: string[]): never {
  throw new UserError(`Cannot ${what}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const spec: CommandSpec = {
  summary: "Mark a model, field, metric or the access file approved, or revoke an approval.",
  usage:
    "approve --target <source.model | source.model.field | metric:<name> | access> " +
    "--by <name> [--recursive] [--revoke] [--date YYYY-MM-DD]",
  options: {
    target: { type: "string" },
    by: { type: "string" },
    recursive: { type: "boolean" },
    revoke: { type: "boolean" },
    date: { type: "string" },
  },
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const ref = str(values, "target");
    if (!ref) {
      throw new UserError(
        "--target is required: source.model, source.model.field, metric:<name> or access (a golden:<name> is confirmed with sl goldens confirm).",
      );
    }
    const revoke = bool(values, "revoke");
    const recursive = bool(values, "recursive");
    const by = (str(values, "by") ?? "").trim();
    if (!revoke && !by) throw new UserError("--by is required: the name of the person who confirmed this item.");
    const date = str(values, "date") ?? today(ctx);
    if (!validDate(date)) throw new UserError(`--date must be an ISO date (YYYY-MM-DD), got "${date}".`);
    const mode: Mode = revoke ? { revoke: true } : { revoke: false, by, at: date };

    const target = parseTarget(ref);
    if (recursive && target.kind !== "model") throw new UserError("--recursive applies only to a source.model target.");

    let file = "";
    const edits: Edit[] = [];
    const warnings: string[] = [];
    // Items already in the requested state, reported when nothing changes.
    let skipped = 0;
    const consider = (targetRef: string, path: (string | number)[], item: Approval): boolean => {
      if (settled(item, mode)) {
        skipped++;
        return false;
      }
      edits.push({ target: targetRef, path, from: statusOf(item) });
      return true;
    };

    switch (target.kind) {
      case "golden":
        throw new UserError(
          `Goldens are confirmed against their rows, not approved here. Run sl goldens run --name ${target.name}, read the rows ` +
            `back to the owner, then sl goldens confirm --name ${target.name} --by "<owner>" --tolerance <t>.`,
        );

      case "access": {
        file = paths(ctx.root).access;
        const access = loadAccess(ctx.root);
        if (!access) {
          throw new UserError(
            existsSync(file)
              ? `access.yaml has no roles yet. Write the roles in ${file} first, then approve them.`
              : `No access.yaml at ${file}. Write the roles first, then approve them.`,
          );
        }
        consider("access", [], access);
        break;
      }

      case "metric": {
        file = paths(ctx.root).metrics;
        if (!existsSync(file)) throw new UserError(`No metrics.yaml at ${file}.`);
        const metrics = loadMetrics(ctx.root).metrics ?? [];
        const index = metrics.findIndex((m) => m.name === target.name);
        const metric = metrics[index];
        if (!metric) {
          const known = metrics.map((m) => m.name);
          throw new UserError(`No metric "${target.name}" in metrics.yaml. Known metrics: ${known.length ? known.join(", ") : "none"}.`);
        }
        if (!revoke && !settled(metric, mode)) {
          const problems: string[] = [];
          const missing = describedProblem(`metric:${metric.name}`, "Metric", metric);
          if (missing) problems.push(missing);
          const draft: string[] = [];
          const { refs, problems: refProblems } = metricMeasureRefs(metric);
          problems.push(...refProblems);
          for (const r of refs) {
            const [modelName, measureName] = r.split(".") as [string, string];
            const modelPath = paths(ctx.root).model(metric.source, modelName);
            const model = existsSync(modelPath) ? readYaml<Model>(modelPath) : null;
            const measure = model?.measures?.find((x) => x.name === measureName);
            if (!measure) problems.push(`measure ${metric.source}.${r} does not exist`);
            else if (measure.status !== "approved") draft.push(`${metric.source}.${r}`);
          }
          if (draft.length) problems.push(`it references draft measures: ${[...new Set(draft)].join(", ")}. Approve them first.`);
          if (problems.length) refuse(`approve metric:${metric.name}`, problems);
        }
        consider(`metric:${metric.name}`, ["metrics", index], metric);
        break;
      }

      case "model": {
        const { path, model } = loadModel(ctx.root, target.source, target.model);
        file = path;
        const base = `${target.source}.${target.model}`;
        const problems: string[] = [];
        if (!revoke && !settled(model, mode)) problems.push(...modelProblems(base, model));
        consider(base, [], model);
        if (recursive) {
          for (const [i, d] of (model.dimensions ?? []).entries()) consider(`${base}.${d.name}`, ["dimensions", i], d);
          for (const [i, m] of (model.measures ?? []).entries()) {
            if (consider(`${base}.${m.name}`, ["measures", i], m) && !revoke) {
              const p = describedProblem(`${base}.${m.name}`, "Measure", m);
              if (p) problems.push(p);
            }
          }
          for (const [i, j] of (model.joins ?? []).entries()) {
            if (consider(`${base}.${j.name}`, ["joins", i], j) && !revoke && !j.evidence) {
              warnings.push(joinWarning(target.source, target.model, j.name));
            }
          }
        }
        if (problems.length) {
          refuse(
            `approve ${base}${recursive ? " and its fields; nothing was approved" : ""}`,
            problems,
          );
        }
        break;
      }

      case "field": {
        const { path, model } = loadModel(ctx.root, target.source, target.model);
        file = path;
        const full = `${target.source}.${target.model}.${target.field}`;
        const match = findField(model, target.field);
        if (!match) {
          const names = [...(model.dimensions ?? []), ...(model.measures ?? []), ...(model.joins ?? [])].map((f) => f.name);
          throw new UserError(
            `No dimension, measure or join "${target.field}" in ${target.source}.${target.model}. Known: ${names.length ? names.join(", ") : "none"}.`,
          );
        }
        const section = match.kind === "dimension" ? "dimensions" : match.kind === "measure" ? "measures" : "joins";
        const changing = consider(full, [section, match.index], match.item);
        if (changing && !revoke) {
          if (match.kind === "measure") {
            const p = describedProblem(full, "Measure", match.item);
            if (p) refuse(`approve ${full}`, [p]);
          }
          if (match.kind === "join" && !match.item.evidence) warnings.push(joinWarning(target.source, target.model, target.field));
        }
        break;
      }
    }

    if (edits.length) updateYaml(file, (doc) => edits.forEach((e) => applyEdit(doc, e.path, mode)));
    const to: Status = revoke ? "draft" : "approved";
    const changed: Change[] = edits.map((e) => ({ target: e.target, from: e.from, to }));

    if (ctx.json) {
      ctx.out(formatJson({ changed, warnings }));
      return 0;
    }
    const lines: string[] = [];
    if (!changed.length) lines.push(`${ref} is already ${revoke ? "a draft" : "approved"}; nothing changed.`);
    for (const c of changed) {
      lines.push(revoke ? `Revoked ${c.target} (${c.from} -> draft).` : `Approved ${c.target} (${c.from} -> approved) by ${by} on ${date}.`);
    }
    if (changed.length && skipped) lines.push(`${skipped} item(s) were already ${revoke ? "drafts" : "approved"}.`);
    for (const w of warnings) lines.push(`Warning: ${w}`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

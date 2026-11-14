import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import type { LastApproval } from "../lib/access.ts";
import { accessEntry, type ApprovalEntry, carriesHash, holdsHashes, integrity, itemHash, metricEntries, modelEntries } from "../lib/approval-hash.ts";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { LEDGER_FILE, latestReply, readReplies, shellQuote } from "../lib/ledger.ts";
import { formatJson } from "../lib/output.ts";
import { loadAccess, loadMetrics, loadModel, loadProject, paths } from "../lib/project.ts";
import { findField, parseTarget, type Target } from "../lib/refs.ts";
import { DIALECTS, NAME_PATTERN, TO_ONE_RELATIONSHIPS, type Approval, type Dialect, type Join, type JoinKey, type LedgerReply, type Metric, type Model, type SourceConfig, type Status } from "../lib/types.ts";
import { readYaml, readYamlIfExists, updateYaml } from "../lib/yaml.ts";

interface Change {
  target: string;
  from: Status;
  to: Status;
}

// One item to flip, located by its path inside one YAML file. keepLast marks access.yaml, whose
// revoke keeps the approval it sets aside in last_approved. hash is the item's content hash, which
// an approval records. changed marks an approved item whose content no longer matches its hash,
// and missing one with no hash while other items of the project record one. by, at and ledger come
// from the owner's recorded yes an approval rests on.
interface Edit {
  target: string;
  path: (string | number)[];
  from: Status;
  hash: string;
  keepLast?: boolean;
  changed?: boolean;
  missing?: boolean;
  by?: string;
  at?: string;
  ledger?: string;
}

type Mode = { revoke: false } | { revoke: true };

// An item approve would change but does not, and why; byMismatch when only --by stood in the way.
interface Refusal {
  target: string;
  reason: string;
  byMismatch?: true;
}

function statusOf(item: Approval): Status {
  return item.status === "approved" ? "approved" : "draft";
}

// Whether the item already holds the state this run would give it. An approved item whose content
// no longer matches its recorded hash is approved again, and so is one without a hash while other
// items of the project record one (its hash may have been removed); one approved before any hash
// was recorded stands (sl approve --stamp-hashes records its hash).
function settled(item: Approval, mode: Mode, hash: string, projectHashed: boolean): boolean {
  if (mode.revoke)
    return item.status !== "approved" && item.approved_by === undefined && item.approved_at === undefined && item.approved_hash === undefined;
  const recorded = typeof item.approved_hash === "string" && item.approved_hash.trim() ? item.approved_hash.trim() : undefined;
  const hashOk = recorded === undefined ? !projectHashed : recorded === hash;
  return item.status === "approved" && !!item.approved_by && !!item.approved_at && hashOk;
}

// The dialect a source file names, for reading join references the way the source writes SQL.
function sourceDialect(root: string, source: string): Dialect | undefined {
  let config: SourceConfig | null = null;
  try {
    config = readYamlIfExists<SourceConfig>(paths(root).source(source));
  } catch {
    return undefined;
  }
  const d = config?.dialect;
  return typeof d === "string" && (DIALECTS as readonly string[]).includes(d) ? d : undefined;
}

// Finds the other models of a source by name, for the second hop of a join reference.
function modelLookup(root: string, source: string): (name: string) => Model | undefined {
  const cache = new Map<string, Model | undefined>();
  return (name: string) => {
    if (!cache.has(name)) {
      let m: Model | undefined;
      try {
        m = NAME_PATTERN.test(name) ? (readYamlIfExists<Model>(paths(root).model(source, name)) ?? undefined) : undefined;
      } catch {
        m = undefined;
      }
      cache.set(name, m);
    }
    return cache.get(name);
  };
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

// The approved_by and approved_at a map holds, when both are non-empty text.
function approvalOf(map: YAMLMap): LastApproval | undefined {
  const by = map.get("approved_by");
  const at = map.get("approved_at");
  return typeof by === "string" && by.trim() && typeof at === "string" && at.trim() ? { by, at } : undefined;
}

// Sets last_approved to `last`, where approved_by stood, else after status.
function setLastApproved(doc: Document, map: YAMLMap, last: LastApproval): void {
  const value = doc.createNode(last);
  const existing = keyIndex(map, "last_approved");
  if (existing >= 0) {
    map.items[existing]!.value = value;
    return;
  }
  const by = keyIndex(map, "approved_by");
  const at = by >= 0 ? by : keyIndex(map, "status") + 1;
  map.items.splice(at, 0, doc.createPair("last_approved", value));
}

function applyEdit(doc: Document, edit: Edit, mode: Mode): LastApproval | undefined {
  const { path } = edit;
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (!isMap(node)) throw new UserError(`Cannot edit ${path.join(".") || "the document root"}: it is not a mapping.`);
  if (mode.revoke) {
    setScalar(doc, node, "status", "draft", STATUS_ANCHORS);
    // access.yaml keeps the approval it sets aside: that version applies where it is deployed.
    const last = edit.keepLast ? approvalOf(node) : undefined;
    if (last) setLastApproved(doc, node, last);
    node.delete("approved_by");
    node.delete("approved_at");
    node.delete("approved_hash");
    return last;
  }
  setScalar(doc, node, "status", "approved", STATUS_ANCHORS);
  setScalar(doc, node, "approved_by", edit.by!, ["status"]);
  setScalar(doc, node, "approved_at", edit.at!, ["approved_by", "status"]);
  setScalar(doc, node, "approved_hash", edit.hash, ["approved_at", "approved_by", "status"]);
  // A new approval replaces the one a revoke set aside.
  if (edit.keepLast) node.delete("last_approved");
  return undefined;
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

function keySignature(keys: JoinKey[]): string {
  return keys
    .map((k) => `${String(k.from).toLowerCase()}=${String(k.to).toLowerCase()}`)
    .sort()
    .join(",");
}

// A warning for a join whose current evidence sl validate errors on once it is approved: evidence
// of many_to_many, which needs a bridge table, or fan-out under a to-one relationship that records
// no fanout_override. Evidence measured for another target or other keys is stale and says nothing.
function fanoutWarning(ref: string, j: Join): string | null {
  const ev = j.evidence;
  if (!ev) return null;
  if ((ev.to !== undefined && ev.to !== j.to) || (Array.isArray(ev.keys) && Array.isArray(j.keys) && keySignature(ev.keys) !== keySignature(j.keys))) return null;
  if (ev.suggested_relationship === "many_to_many") {
    return (
      `Join ${ref}'s evidence shows many_to_many: neither key is unique, so sl validate errors on it once approved, whatever ` +
      "fanout_override says; the join needs a bridge table or a pre-aggregated model."
    );
  }
  if (!TO_ONE_RELATIONSHIPS.includes(j.relationship) || (typeof j.fanout_override === "string" && j.fanout_override.trim())) return null;
  const why = [
    ev.right_key_unique === false ? `the key of ${j.to} is not unique` : "",
    typeof ev.max_fanout === "number" && ev.max_fanout > 1 ? `a row matches up to ${ev.max_fanout} rows of ${j.to}` : "",
  ].filter(Boolean);
  if (!why.length) return null;
  return (
    `Join ${ref} is ${j.relationship}, but its evidence shows fan-out (${why.join(", and ")}); sl validate errors on it ` +
    'until the keys or the relationship are fixed, or fanout_override: "<reason>" records why the owner accepts it.'
  );
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

// Names compared the way an owner's name is: trimmed, ignoring case.
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Checks an item against the owner's latest recorded reply to it: the approval it may record (the
// reply's by and the date of its at), or why it may not.
function ledgerGate(replies: LedgerReply[], target: string, hash: string, by: string | undefined): { by: string; at: string; ledger: string } | Refusal {
  const r = latestReply(replies, target);
  if (!r) return { target, reason: "no owner reply to its readback is recorded" };
  const ref = `${r.id}, to item ${r.item} of ${r.readback_id}`;
  if (r.verdict !== "yes") return { target, reason: `the owner's latest reply (${ref}) is ${r.verdict === null ? "recorded without a verdict" : `"${r.verdict}", not yes`}` };
  if (r.content_hash !== hash) return { target, reason: `it changed since the owner said yes (${ref}), so that yes is to a version it no longer has` };
  if (by !== undefined && !sameName(by, r.by)) return { target, reason: `--by ${shellQuote(by)} is not the owner who said yes (${ref}), ${shellQuote(r.by)}`, byMismatch: true };
  const at = r.at.slice(0, 10);
  if (!validDate(at)) return { target, reason: `the owner's yes (${ref}) has no ISO date in its at, ${JSON.stringify(r.at)}; run sl validate` };
  return { by: r.by, at, ledger: r.id };
}

// What to run for items refused for want of a matching yes.
function readbackSteps(targets: string[], again: string): string {
  return (
    `sl readback --targets ${targets.join(",")}, read it to the owner, record each answer with ` +
    `sl reply --readback <readback_id> --item <n> --text "<owner's words>" --verdict yes --by "<owner>", then ${again}`
  );
}

function refuse(what: string, problems: string[]): never {
  throw new UserError(`Cannot ${what}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// The model files of a semantic root as [source, model name] pairs, from models/<source>/<model>.yaml.
function modelFiles(root: string): [string, string][] {
  const dir = join(root, "models");
  if (!existsSync(dir)) return [];
  const out: [string, string][] = [];
  for (const source of readdirSync(dir).sort()) {
    const sub = join(dir, source);
    if (!NAME_PATTERN.test(source) || !statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub).sort()) {
      const m = f.match(/^([a-z][a-z0-9_]*)\.yaml$/);
      if (m) out.push([source, m[1]!]);
    }
  }
  return out;
}

// A target as the user wrote it.
function targetText(t: Target): string {
  switch (t.kind) {
    case "model":
      return `${t.source}.${t.model}`;
    case "field":
      return `${t.source}.${t.model}.${t.field}`;
    case "metric":
      return `metric:${t.name}`;
    case "access":
      return "access";
    case "golden":
      return `golden:${t.name}`;
  }
}

// Whether an entry falls under a --stamp-hashes target: a model takes itself and its fields.
function underTarget(e: ApprovalEntry, target: Target | undefined): boolean {
  if (!target) return true;
  switch (target.kind) {
    case "model": {
      const base = `${target.source}.${target.model}`;
      return e.ref === base || e.ref.startsWith(`${base}.`);
    }
    case "field":
      return e.ref === `${target.source}.${target.model}.${target.field}`;
    case "metric":
      return e.ref === `metric:${target.name}`;
    case "access":
      return e.ref === "access";
    case "golden":
      return false;
  }
}

// The approval entries of every model file, metrics.yaml and access.yaml, by file.
function projectEntries(root: string): { file: string; entries: ApprovalEntry[] }[] {
  const files: { file: string; entries: ApprovalEntry[] }[] = [];
  for (const [source, name] of modelFiles(root)) {
    const file = paths(root).model(source, name);
    const model = readYaml<Model>(file);
    if (!model || typeof model !== "object") continue;
    files.push({ file, entries: modelEntries(source, { ...model, model: name }, modelLookup(root, source), sourceDialect(root, source)) });
  }
  const metricsFile = paths(root).metrics;
  if (existsSync(metricsFile)) files.push({ file: metricsFile, entries: metricEntries(loadMetrics(root)?.metrics) });
  const access = accessEntry(loadAccess(root));
  if (access) files.push({ file: paths(root).access, entries: [access] });
  return files;
}

// Whether any approved model, field, join, metric or access.yaml of the project records approved_hash.
function projectHashed(root: string): boolean {
  return holdsHashes(projectEntries(root).flatMap((f) => f.entries));
}

// Records approved_hash on every approved item that has none, keeping approved_by and approved_at.
// While other items of the project record a hash, an item without one may have had its hash
// removed after an edit; it is refused unless confirmUnchanged says version control shows it
// unchanged since its approved_at.
function stampHashes(root: string, target: Target | undefined, confirmUnchanged: boolean): { file: string; refs: string[] }[] {
  const files = projectEntries(root);
  const all = files.flatMap((f) => f.entries);
  if (target && !all.some((e) => underTarget(e, target))) {
    throw new UserError(`--target ${targetText(target)} names no model, field, metric or access file of this project.`);
  }
  const hashed = holdsHashes(all);
  const suspect = all.filter((e) => underTarget(e, target) && integrity(e, hashed) === "missing");
  if (suspect.length && !confirmUnchanged) {
    throw new UserError(
      `Cannot stamp hashes: other approved items already carry approved_hash, so these may have had theirs removed after an edit: ` +
        `${suspect.map((e) => e.ref).join(", ")}. Read each back to the owner and approve it again (sl approve --target <ref> --by "<owner>"). ` +
        "Only when version control shows each unchanged since its approved_at, run sl approve --stamp-hashes --confirm-unchanged.",
    );
  }
  const out: { file: string; refs: string[] }[] = [];
  for (const { file, entries } of files) {
    const todo = entries.filter((e) => underTarget(e, target) && e.item.status === "approved" && !carriesHash(e.item));
    if (!todo.length) continue;
    updateYaml(file, (doc) => {
      for (const e of todo) {
        const node = e.path.length ? doc.getIn(e.path, true) : doc.contents;
        if (isMap(node)) setScalar(doc, node, "approved_hash", e.hash, ["approved_at", "approved_by", "status"]);
      }
    });
    out.push({ file, refs: todo.map((e) => e.ref) });
  }
  return out;
}

const spec: CommandSpec = {
  summary: "Mark a model, field, metric or the access file approved on the owner's recorded yes, or revoke an approval.",
  usage:
    "approve --target <source.model | source.model.field | metric:<name> | access> [--by <name>] [--recursive]\n" +
    "       approve --target <ref> --revoke [--recursive]\n" +
    "       approve --stamp-hashes [--target <ref>] [--confirm-unchanged]\n\n" +
    "Approves an item only when the owner's latest reply to it in .sl/ledger.jsonl is a yes to it as it\n" +
    "now stands (sl readback, then sl reply --verdict yes); approved_by and approved_at come from that\n" +
    "reply, and --by, when given, must name the same owner. --date is no longer taken.",
  options: {
    target: { type: "string" },
    by: { type: "string" },
    recursive: { type: "boolean" },
    revoke: { type: "boolean" },
    date: { type: "string" },
    "stamp-hashes": { type: "boolean" },
    "confirm-unchanged": { type: "boolean" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    if (bool(values, "stamp-hashes")) {
      for (const flag of ["by", "date"] as const)
        if (str(values, flag) !== undefined) throw new UserError(`--stamp-hashes keeps each item's approved_by and approved_at, so it takes no --${flag}.`);
      for (const flag of ["revoke", "recursive"] as const)
        if (bool(values, flag)) throw new UserError(`--stamp-hashes takes no --${flag}; it only records hashes of items already approved.`);
      const targetRef = str(values, "target");
      const target = targetRef ? parseTarget(targetRef) : undefined;
      if (target?.kind === "golden") throw new UserError("Goldens are confirmed with sl goldens confirm and carry no approved_hash.");
      const stamped = stampHashes(ctx.root, target, bool(values, "confirm-unchanged"));
      const refs = stamped.flatMap((s) => s.refs);
      if (ctx.json) {
        ctx.out(formatJson({ stamped: refs }));
        return 0;
      }
      ctx.out(
        refs.length
          ? `Recorded approved_hash on ${refs.length} approved item(s), keeping who approved them and when: ${refs.join(", ")}. ` +
              "From now on sl validate errors when one of them changes."
          : "Every approved item already has approved_hash; nothing changed.",
      );
      return 0;
    }
    if (bool(values, "confirm-unchanged")) throw new UserError("--confirm-unchanged applies only to sl approve --stamp-hashes.");
    const ref = str(values, "target");
    if (!ref) {
      throw new UserError(
        "--target is required: source.model, source.model.field, metric:<name> or access (a golden:<name> is confirmed with sl goldens confirm).",
      );
    }
    const revoke = bool(values, "revoke");
    const recursive = bool(values, "recursive");
    if (str(values, "date") !== undefined) {
      throw new UserError(
        `--date is no longer taken: an approval's date now comes from the owner's recorded reply in ${LEDGER_FILE} (the day it was recorded). ` +
          `Run the same command without --date: sl approve --target ${ref}${recursive ? " --recursive" : ""}${revoke ? " --revoke" : ""}.`,
      );
    }
    const byRaw = str(values, "by");
    const by = revoke ? undefined : byRaw?.trim();
    if (by === "") {
      throw new UserError(
        `--by is empty. Leave it out to record the owner whose yes is in ${LEDGER_FILE}, or give that owner's name: sl approve --target ${ref} --by "<owner>".`,
      );
    }
    const mode: Mode = revoke ? { revoke: true } : { revoke: false };

    const target = parseTarget(ref);
    if (recursive && target.kind !== "model") throw new UserError("--recursive applies only to a source.model target.");

    let file = "";
    const edits: Edit[] = [];
    // Problems and warnings by the target they are about, so only items approved now report them.
    const problems: { target: string; text: string }[] = [];
    const warnings: { target: string; text: string }[] = [];
    // Items already in the requested state, reported when nothing changes.
    let skipped = 0;
    const hashed = !revoke && projectHashed(ctx.root);
    const isSettled = (item: Approval, hash: string) => settled(item, mode, hash, hashed);
    const consider = (targetRef: string, path: (string | number)[], item: Approval, hash: string, keepLast = false): boolean => {
      if (isSettled(item, hash)) {
        skipped++;
        return false;
      }
      const approved = !mode.revoke && item.status === "approved";
      const changed = approved && typeof item.approved_hash === "string" && item.approved_hash.trim() !== "" && item.approved_hash.trim() !== hash;
      const missing = approved && !carriesHash(item as unknown as Record<string, unknown>);
      edits.push({
        target: targetRef,
        path,
        from: statusOf(item),
        hash,
        ...(keepLast ? { keepLast } : {}),
        ...(changed ? { changed } : {}),
        ...(missing ? { missing } : {}),
      });
      return true;
    };
    const obj = (x: unknown) => x as Record<string, unknown>;

    switch (target.kind) {
      case "golden":
        throw new UserError(
          `Goldens are confirmed against their rows, not approved here. Read it back with sl readback --targets golden:${target.name} ` +
            `--tolerance <t>, record the owner's answer with sl reply, then sl goldens confirm --name ${target.name}.`,
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
        consider("access", [], access, itemHash("access", obj(access)), true);
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
        const metricHash = itemHash("metric", obj(metric));
        if (!revoke && !isSettled(metric, metricHash)) {
          const own: string[] = [];
          const missing = describedProblem(`metric:${metric.name}`, "Metric", metric);
          if (missing) own.push(missing);
          const draft: string[] = [];
          const { refs, problems: refProblems } = metricMeasureRefs(metric);
          own.push(...refProblems);
          for (const r of refs) {
            const [modelName, measureName] = r.split(".") as [string, string];
            const modelPath = paths(ctx.root).model(metric.source, modelName);
            const model = existsSync(modelPath) ? readYaml<Model>(modelPath) : null;
            const measure = model?.measures?.find((x) => x.name === measureName);
            if (!measure) own.push(`measure ${metric.source}.${r} does not exist`);
            else if (measure.status !== "approved") draft.push(`${metric.source}.${r}`);
          }
          if (draft.length) own.push(`it references draft measures: ${[...new Set(draft)].join(", ")}. Approve them first.`);
          problems.push(...own.map((text) => ({ target: `metric:${metric.name}`, text })));
        }
        consider(`metric:${metric.name}`, ["metrics", index], metric, metricHash);
        break;
      }

      case "model": {
        const { path, model } = loadModel(ctx.root, target.source, target.model);
        file = path;
        const base = `${target.source}.${target.model}`;
        const lookup = modelLookup(ctx.root, target.source);
        const dialect = sourceDialect(ctx.root, target.source);
        const scope = { source: target.source, model: obj(model), lookup, dialect };
        const hash = (kind: "dimension" | "measure" | "join", item: unknown) => itemHash(kind, obj(item), scope);
        const modelHash = itemHash("model", obj(model), { source: target.source });
        if (!revoke && !isSettled(model, modelHash)) problems.push(...modelProblems(base, model).map((text) => ({ target: base, text })));
        consider(base, [], model, modelHash);
        if (recursive) {
          for (const [i, d] of (model.dimensions ?? []).entries()) consider(`${base}.${d.name}`, ["dimensions", i], d, hash("dimension", d));
          for (const [i, m] of (model.measures ?? []).entries()) {
            if (consider(`${base}.${m.name}`, ["measures", i], m, hash("measure", m)) && !revoke) {
              const p = describedProblem(`${base}.${m.name}`, "Measure", m);
              if (p) problems.push({ target: `${base}.${m.name}`, text: p });
            }
          }
          for (const [i, j] of (model.joins ?? []).entries()) {
            if (consider(`${base}.${j.name}`, ["joins", i], j, hash("join", j)) && !revoke) {
              const t = `${base}.${j.name}`;
              if (!j.evidence) warnings.push({ target: t, text: joinWarning(target.source, target.model, j.name) });
              const w = fanoutWarning(t, j);
              if (w) warnings.push({ target: t, text: w });
            }
          }
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
        const hash = itemHash(match.kind, obj(match.item), {
          source: target.source,
          model: obj(model),
          lookup: modelLookup(ctx.root, target.source),
          dialect: sourceDialect(ctx.root, target.source),
        });
        const changing = consider(full, [section, match.index], match.item, hash);
        if (changing && !revoke) {
          if (match.kind === "measure") {
            const p = describedProblem(full, "Measure", match.item);
            if (p) problems.push({ target: full, text: p });
          }
          if (match.kind === "join") {
            if (!match.item.evidence) warnings.push({ target: full, text: joinWarning(target.source, target.model, target.field) });
            const w = fanoutWarning(full, match.item);
            if (w) warnings.push({ target: full, text: w });
          }
        }
        break;
      }
    }

    // Only an item whose owner's latest recorded reply is a yes to it as it stands is approved, with
    // that reply's owner and date. A revoke needs no reply: it never widens what is approved.
    const refused: Refusal[] = [];
    let ready = edits;
    if (!revoke && edits.length) {
      const replies = readReplies(ctx.root);
      ready = [];
      for (const e of edits) {
        const g = ledgerGate(replies, e.target, e.hash, by);
        if ("reason" in g) refused.push(g);
        else ready.push({ ...e, ...g });
      }
    }
    const approving = new Set(ready.map((e) => e.target));
    const blocking = problems.filter((p) => approving.has(p.target)).map((p) => p.text);
    if (blocking.length) refuse(`approve ${ref}${recursive ? " and its fields; nothing was approved" : ""}`, blocking);
    const again = `sl approve --target ${ref}${recursive ? " --recursive" : ""}`;
    const unanswered = refused.filter((r) => !r.byMismatch).map((r) => r.target);
    const fixFirst = problems.filter((p) => unanswered.includes(p.target)).map((p) => p.text);
    const nextFor = (r: Refusal) =>
      r.byMismatch ? `sl approve --target ${r.target} (it records the owner who said yes), or read it back to the owner you named` : readbackSteps([r.target], `sl approve --target ${r.target}`);
    const steps = [
      ...(unanswered.length ? [readbackSteps(unanswered, again)] : []),
      ...(refused.some((r) => r.byMismatch) ? [`leave --by out to record the owner who said yes: ${again}`] : []),
    ];
    const refusedText = () =>
      [
        ...refused.map((r) => `  - ${r.target}: ${r.reason}`),
        ...(fixFirst.length ? ["Before reading those back, fix:", ...fixFirst.map((p) => `  - ${p}`)] : []),
        `sl approve needs the owner's yes in ${LEDGER_FILE} to each item as it now stands. Next: ${steps.join("; or ")}.`,
      ].join("\n");
    if (!ready.length && refused.length) {
      if (refused.length === 1 && !recursive) {
        const r = refused[0]!;
        throw new UserError(
          `Cannot approve ${r.target}: ${r.reason}; nothing was approved. sl approve needs the owner's yes in ${LEDGER_FILE} to it as it now stands. ` +
            `Next: ${nextFor(r)}.${fixFirst.length ? ` Before reading it back, fix: ${fixFirst.map((p) => p.replace(/\.$/, "")).join("; ")}.` : ""}`,
        );
      }
      throw new UserError(`Cannot approve ${ref}; nothing was approved:\n${refusedText()}`);
    }

    // The approval a revoke of access.yaml set aside in last_approved.
    let keptApproval: LastApproval | undefined;
    if (ready.length) {
      updateYaml(file, (doc) => {
        for (const e of ready) keptApproval = applyEdit(doc, e, mode) ?? keptApproval;
      });
    }
    const to: Status = revoke ? "draft" : "approved";
    const changed: Change[] = ready.map((e) => ({ target: e.target, from: e.from, to }));
    const warned = warnings.filter((w) => approving.has(w.target)).map((w) => w.text);
    const code = refused.length ? 1 : 0;

    if (ctx.json) {
      ctx.out(
        formatJson({
          changed,
          warnings: warned,
          ...(keptApproval ? { last_approved: keptApproval } : {}),
          ...(refused.length ? { refused: refused.map((r) => ({ target: r.target, reason: r.reason, next: nextFor(r) })) } : {}),
        }),
      );
      return code;
    }
    const lines: string[] = [];
    if (!changed.length) lines.push(`${ref} is already ${revoke ? "a draft" : "approved"}; nothing changed.`);
    for (const e of ready) {
      const how = `by ${e.by} on ${e.at} (reply ${e.ledger})`;
      if (revoke) lines.push(`Revoked ${e.target} (${e.from} -> draft).`);
      else if (e.changed) lines.push(`Approved ${e.target} again (it changed since its last approval) ${how}.`);
      else if (e.missing) lines.push(`Approved ${e.target} again (its approved_hash was missing) ${how}.`);
      else lines.push(`Approved ${e.target} (${e.from} -> approved) ${how}.`);
    }
    if (changed.length && skipped) lines.push(`${skipped} item(s) were already ${revoke ? "drafts" : "approved"}.`);
    if (keptApproval) {
      lines.push(
        `access.yaml keeps that approval in last_approved: the version approved by ${keptApproval.by} on ${keptApproval.at} ` +
          "keeps applying where it is deployed until the new one is approved; tell the owner so.",
      );
    }
    for (const w of warned) lines.push(`Warning: ${w}`);
    if (refused.length) lines.push(`Not approved:\n${refusedText()}`);
    ctx.out(lines.join("\n"));
    return code;
  },
};
export default spec;

// The items of a layer against the last release (spec: Iterating a layer, Change status): what was
// added, changed and removed since the changelog's last entry, and which approved goldens read each
// changed item. Hashes come from statusDetail, the ones semlayer approve uses, so a change to what a
// hash covers needs no edit here. Names, refs and hashes only: no data value.
import { createHash } from "node:crypto";
import { goldenReads } from "./goldens.ts";
import { listGoldens, listModels, listSourceNames, loadMetrics, loadSource } from "./project.ts";
import { statusDetail } from "./status.ts";

// A changed item: its ref, whether it is approved at its new content or waits on an approval, and
// the approved goldens whose request reads it.
export interface ChangedItem {
  ref: string;
  state: "approved" | "draft";
  affected_goldens: string[];
}

export interface ItemDiff {
  added: string[];
  changed: ChangedItem[];
  removed: string[];
}

// Ref to content hash and approval state of every item now: models, fields, joins, metrics, access,
// schema pairs (schema-pair:<source>:<from>:<to>) and each source's primary schema
// (primary:<source>, when intake.primary is set, hashed over its name). Goldens are left out; a changelog records their rows.
export function itemMap(root: string): Map<string, { hash: string; approved: boolean }> {
  const out = new Map<string, { hash: string; approved: boolean }>();
  for (const [ref, t] of statusDetail(root).targets) {
    if (ref.startsWith("golden:")) continue;
    out.set(ref, { hash: t.hash, approved: t.state === "current" || t.state === "unhashed" });
  }
  for (const name of listSourceNames(root)) {
    const explicit = loadSource(root, name).intake?.primary;
    const primary = typeof explicit === "string" ? explicit.trim() : "";
    if (primary) out.set(`primary:${name}`, { hash: `sha256:${createHash("sha256").update(JSON.stringify({ kind: "primary", source: name, schema: primary })).digest("hex")}`, approved: true });
  }
  return out;
}

// The approved goldens that read each ref in `refs`: a golden reads a field it requests, a metric and
// the measures the metric combines, and the measures that name a segment it requests. A model
// ref is read by a golden that reads any field of the model. A join ref (source.model.join) is read
// by a golden that reads any field of the model it leaves or the model it reaches, since a join edit
// can move the figures of either.
export function affectedGoldens(root: string, refs: string[]): Map<string, string[]> {
  const models = listModels(root).map((m) => m.model);
  const metrics = loadMetrics(root).metrics ?? [];
  const reads = new Map<string, Set<string>>();
  for (const { golden: g } of listGoldens(root)) {
    if (!g || typeof g !== "object" || g.status !== "approved" || typeof g.name !== "string") continue;
    reads.set(g.name, new Set(goldenReads(g, models, metrics, true).map((r) => r.ref)));
  }
  const joinModels = new Map<string, string[]>();
  for (const m of models)
    for (const j of m.joins ?? []) joinModels.set(`${m.source}.${m.model}.${j.name}`, [`${m.source}.${m.model}`, `${m.source}.${j.to}`]);
  const out = new Map<string, string[]>();
  for (const ref of refs) {
    const prefixes = joinModels.get(ref) ?? (ref.split(".").length === 2 ? [ref] : []);
    const names = [...reads].filter(([, set]) => set.has(ref) || [...set].some((r) => prefixes.some((p) => r.startsWith(`${p}.`)))).map(([n]) => n);
    out.set(ref, names.sort());
  }
  return out;
}

// What changed between a changelog entry's items and the items now. The lists are sorted.
export function diffItems(baseline: Record<string, string>, now: Map<string, { hash: string; approved: boolean }>, goldens: Map<string, string[]> = new Map()): ItemDiff {
  const added = [...now.keys()].filter((r) => !(r in baseline)).sort();
  const removed = Object.keys(baseline).filter((r) => !now.has(r)).sort();
  const changed = [...now].filter(([r, v]) => r in baseline && baseline[r] !== v.hash).map(([r, v]) => ({ ref: r, state: v.approved ? ("approved" as const) : ("draft" as const), affected_goldens: goldens.get(r) ?? [] }));
  return { added, changed: changed.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)), removed };
}

// The diff of the layer against the last release in the changelog, or null without one.
export function changeSince(root: string, items: Record<string, string>): ItemDiff {
  const now = itemMap(root);
  const first = diffItems(items, now);
  return diffItems(items, now, affectedGoldens(root, first.changed.map((c) => c.ref)));
}

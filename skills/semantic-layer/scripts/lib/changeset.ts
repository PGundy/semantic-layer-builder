// The items of a layer against the last release (spec: Iterating a layer, Change status): what was
// added, changed and removed since the changelog's last entry, and which approved goldens read each
// changed item. Hashes come from statusDetail, the ones semlayer approve uses, so a change to what a
// hash covers needs no edit here. Names, refs and hashes only: no data value.
import { createHash } from "node:crypto";
import { requestHash } from "./approval-hash.ts";
import { goldenReads } from "./goldens.ts";
import { listGoldens, listModels, listSourceNames, loadMetrics, loadSource } from "./project.ts";
import { statusDetail } from "./status.ts";

// A changed item: its ref, whether it is approved at its new content or waits on an approval, the
// approved goldens whose request reads it, and description_only when its definition is the one the
// release recorded and only its description changed.
export interface ChangedItem {
  ref: string;
  state: "approved" | "draft";
  affected_goldens: string[];
  description_only?: true;
}

export interface ItemDiff {
  added: string[];
  changed: ChangedItem[];
  removed: string[];
}

// An item's content hash and approval state. `approved` is true when its approval matches its content.
// `plain` is true for a draft that carries no trace of an approval (never approved, or revoked).
// `definition` is its hash without its description, when that differs from hash; `changed` is true
// for an approved item whose content no longer matches its approval.
export interface ItemState {
  hash: string;
  definition?: string;
  approvedAt?: string;
  approved: boolean;
  plain: boolean;
  changed?: boolean;
}

// Whether a release leaves the item out instead of waiting for it: it is a plain draft and the last
// release (its `items`, none before the first) holds no entry for it. Every other item that is not approved
// as it stands (edited since its approval, approved without a hash, a draft that carries an approval's
// trace, or a draft the last release held) blocks the close.
export function leftOut(ref: string, v: ItemState, baseline: Record<string, string>): boolean {
  return !v.approved && v.plain && !Object.hasOwn(baseline, ref);
}

// The goldens a release leaves out though the last one recorded them (its `goldens`, none before the first),
// as leftOut leaves out a draft item: `unconfirmed` holds those whose file holds a draft golden now (returned
// to draft with semlayer goldens unconfirm, its new figures not yet confirmed), `removed` those whose file is gone.
// A golden confirmed now is in the release; one the last release did not record is not named. Sorted.
// `requests` holds the request hash of each unconfirmed one (a deferred golden is read by it, see status.ts).
// `deferred` is the last entry's own record of the goldens it left out (name to request hash): one still a draft
// with that request stays unconfirmed, so the owner's deferral carries into the next release.
export function goldensLeftOut(root: string, recorded: Record<string, unknown>, deferred: Record<string, string> = {}): { unconfirmed: string[]; removed: string[]; requests: Record<string, string> } {
  const now = new Map<string, unknown>();
  const requests: Record<string, string> = {};
  for (const { golden: g } of listGoldens(root)) {
    if (g && typeof g === "object" && typeof g.name === "string") {
      now.set(g.name, g.status);
      requests[g.name] = requestHash(g.request);
    }
  }
  const names = Object.keys(recorded).sort();
  const carried = Object.keys(deferred).filter((n) => !(n in recorded) && now.has(n) && now.get(n) !== "approved" && requests[n] === deferred[n]);
  const unconfirmed = [...names.filter((n) => now.has(n) && now.get(n) !== "approved"), ...carried].sort();
  return { unconfirmed, removed: names.filter((n) => !now.has(n)), requests: Object.fromEntries(unconfirmed.map((n) => [n, requests[n]!])) };
}

// Whether semlayer next lets the close go ahead without the item: the close leaves it out (leftOut) and it was
// already a draft when the round started, so the owner deferred it. `atStart` is the round's drafts_at_start,
// or null when no round is open. A draft created in the round is read back before the close is offered.
export function deferredAtStart(ref: string, v: ItemState, baseline: Record<string, string>, atStart: string[] | null): boolean {
  return leftOut(ref, v, baseline) && (atStart === null || atStart.includes(ref));
}

// Ref to content hash and approval state of every item now: models, fields, joins, metrics, access,
// schema pairs (schema-pair:<source>:<from>:<to>) and each source's primary schema
// (primary:<source>, when intake.primary is set, hashed over its name). Goldens are left out; a changelog records their rows.
export function itemMap(root: string): Map<string, ItemState> {
  const out = new Map<string, ItemState>();
  for (const [ref, t] of statusDetail(root).targets) {
    if (ref.startsWith("golden:")) continue;
    out.set(ref, {
      hash: t.hash,
      ...(t.definition ? { definition: t.definition } : {}),
      ...(t.approvedAt ? { approvedAt: t.approvedAt } : {}),
      approved: t.state === "current" || t.state === "unhashed",
      plain: t.state === "draft" && !t.stamped,
      ...(t.state === "changed" ? { changed: true } : {}),
    });
  }
  for (const name of listSourceNames(root)) {
    const explicit = loadSource(root, name).intake?.primary;
    const primary = typeof explicit === "string" ? explicit.trim() : "";
    if (primary) out.set(`primary:${name}`, { hash: `sha256:${createHash("sha256").update(JSON.stringify({ kind: "primary", source: name, schema: primary })).digest("hex")}`, approved: true, plain: false });
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
// `definitions` is the entry's: each described item's hash without its description. An entry without
// it was recorded before descriptions counted, so its hashes are definition hashes: an item whose
// definition hash matches is listed, description only, when its approval no longer matches it (a
// description edit after its hash was brought forward, or approved again on a day after
// `releaseDate`), and otherwise not, so bringing hashes forward lists nothing. With it, an item whose definition is the released one is description only.
export function diffItems(
  baseline: Record<string, string>,
  now: Map<string, Omit<ItemState, "plain">>,
  goldens: Map<string, string[]> = new Map(),
  definitions?: Record<string, string>,
  releaseDate?: string,
): ItemDiff {
  const added = [...now.keys()].filter((r) => !(r in baseline)).sort();
  const removed = Object.keys(baseline).filter((r) => !now.has(r)).sort();
  const changed: ChangedItem[] = [];
  for (const [r, v] of now) {
    const b = baseline[r];
    if (b === undefined || b === v.hash) continue;
    const definition = v.definition ?? v.hash;
    const released = definitions ? (definitions[r] ?? b) : b;
    // A described item approved again after the release (its approved_at is a later day) had its
    // description reworded, since a stamp keeps approved_at; an edit approved on the release's own day
    // is not told apart from the stamp.
    const approvedSince = !definitions && v.definition !== undefined && releaseDate !== undefined && (v.approvedAt ?? "").slice(0, 10) > releaseDate;
    if (!definitions && released === definition && !v.changed && !approvedSince) continue;
    const onlyDescription = released === definition;
    changed.push({ ref: r, state: v.approved ? "approved" : "draft", affected_goldens: goldens.get(r) ?? [], ...(onlyDescription ? { description_only: true as const } : {}) });
  }
  return { added, changed: changed.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)), removed };
}

// The diff of the layer against a release in the changelog: its items and its definitions.
export function changeSince(root: string, items: Record<string, string>, definitions?: Record<string, string>, releaseDate?: string): ItemDiff {
  const now = itemMap(root);
  const first = diffItems(items, now, new Map(), definitions, releaseDate);
  return diffItems(items, now, affectedGoldens(root, first.changed.map((c) => c.ref)), definitions, releaseDate);
}

// The definition hash of each described item of `items` (itemMap), as a changelog entry records them.
export function itemDefinitions(items: Map<string, ItemState>): Record<string, string> {
  return Object.fromEntries([...items].filter(([, v]) => v.definition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, v]) => [ref, v.definition!]));
}

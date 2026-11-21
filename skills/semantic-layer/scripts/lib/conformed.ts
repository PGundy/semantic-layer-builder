// Conformed dimensions (spec: Bridges and multi-fact requests). A dimension's conforms_to names a
// dimension of another model of its source, <model>.<dimension>, that means the same thing, such as
// refunds.refunded_on conforming to orders.order_date. The statement is one hop and holds both ways: in
// a request over both models, a part whose model has one of the two groups by it where the request names
// the other. It is never followed further: a dimension that conforms to one that itself conforms to a
// third is an error (join.conformed_chain), checked in lib/validate-rules/join.ts.
import { findTable } from "./naming.ts";
import { findPair, pairApproved, type CrossSchemaPair } from "./schema-scope.ts";
import type { Dimension, Model, Snapshot } from "./types.ts";

export const CONFORM_REF = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

// The model and dimension a dimension's conforms_to names; undefined when it names none.
export function conformTarget(d: { conforms_to?: unknown } | undefined): { model: string; name: string } | undefined {
  const m = typeof d?.conforms_to === "string" ? CONFORM_REF.exec(d.conforms_to.trim()) : null;
  return m ? { model: m[1]!, name: m[2]! } : undefined;
}

// A dimension of model `part` conformed with model.field, and the dimension that carries the statement.
export interface Peer {
  dimension: Dimension;
  carrier: { model: string; name: string };
}

// The dimensions of `part` conformed with model.field: those that conform to it, and the one it conforms to.
export function conformedPeers(models: readonly Model[], model: string, field: string, part: string): Peer[] {
  if (model === part) return [];
  const dims = (name: string) => models.find((m) => m.model === name)?.dimensions ?? [];
  const out: Peer[] = [];
  for (const d of dims(part)) {
    const t = conformTarget(d);
    if (t?.model === model && t.name === field) out.push({ dimension: d, carrier: { model: part, name: d.name } });
  }
  const t = conformTarget(dims(model).find((d) => d.name === field));
  const d = t?.model === part ? dims(part).find((x) => x.name === t.name) : undefined;
  if (d && !out.some((x) => x.dimension === d)) out.push({ dimension: d, carrier: { model, name: field } });
  return out;
}

// Whether two model.field dimensions are one dimension or conformed with each other.
export function sameDimension(models: readonly Model[], a: string, b: string): boolean {
  if (a === b) return true;
  const [x, y] = [a, b].map((r) => CONFORM_REF.exec(r));
  return !!x && !!y && conformedPeers(models, x[1]!, x[2]!, y[1]!).some((p) => p.dimension.name === y[2]);
}

// The two zones of conformed time dimensions that record different ones: a day in one is not a day in
// the other, so their periods cannot be combined.
export function zoneClash(a: Dimension, b: Dimension): [string, string] | undefined {
  if (a.type !== "time" || b.type !== "time" || typeof a.time_zone !== "string" || typeof b.time_zone !== "string") return undefined;
  return a.time_zone === b.time_zone ? undefined : [a.time_zone, b.time_zone];
}

// Two conformed time dimensions of which exactly one declares a time_zone and that zone is not UTC: an unset
// zone counts days in UTC (spec: Time zones), so the pair buckets one side in the declared zone and the other in
// UTC. Returns the zone and which dimension has none; undefined for any other pair, UTC against unset included.
export function zoneOneSided(a: Dimension, b: Dimension): { zone: string; unset: "a" | "b" } | undefined {
  if (a.type !== "time" || b.type !== "time") return undefined;
  const set = (d: Dimension) => (typeof d.time_zone === "string" && d.time_zone !== "" ? d.time_zone : undefined);
  const [x, y] = [set(a), set(b)];
  if (!!x === !!y) return undefined;
  const zone = (x ?? y)!;
  return zone === "UTC" ? undefined : { zone, unset: x ? "b" : "a" };
}

// The schemas of two models' tables when they differ and no approved schema pair joins them.
export function conformedSchemas(snapshot: Pick<Snapshot, "tables"> | null | undefined, pairs: readonly CrossSchemaPair[], a: Model, b: Model): [string, string] | undefined {
  if (!snapshot || !Array.isArray(snapshot.tables)) return undefined;
  const [x, y] = [a, b].map((m) => (typeof m.table === "string" ? findTable(snapshot.tables, m.table)?.schema : undefined));
  if (typeof x !== "string" || typeof y !== "string" || x === y || pairApproved(findPair(pairs, x, y))) return undefined;
  return [x, y];
}

// The readback sentence of a dimension that conforms to another.
export function conformedWords(model: string, target: string): string {
  return `Treated as the same as ${target} when a question combines ${model} with ${target.split(".")[0]}: a request grouped by either groups ${model} by this dimension.`;
}

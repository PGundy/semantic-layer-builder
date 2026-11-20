// Segments (spec: Metric semantics, Segments): a named SQL predicate a model declares once, which a
// measure names in `segments` and a plain request names as `model.segment`. A segment's filter is
// text the owner approves through each measure that names it: the measure's approval hash covers the
// filter texts of its segments.
import type { Measure, Model } from "./types.ts";

export interface Segment {
  name: string;
  // SQL predicate over the model's own columns and join references, as a measure filter is.
  filter: string;
  description?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The segments a model file declares, entries without a name left out.
export function modelSegments(model: unknown): Segment[] {
  const list = isObj(model) && Array.isArray(model.segments) ? model.segments : [];
  return list.filter((s): s is Segment => isObj(s) && typeof s.name === "string");
}

export function findSegment(model: unknown, name: string): Segment | undefined {
  return modelSegments(model).find((s) => s.name === name);
}

// The segment names a measure lists, in its order.
export function segmentNames(measure: unknown): string[] {
  const list = isObj(measure) && Array.isArray(measure.segments) ? measure.segments : [];
  return list.filter((n): n is string => typeof n === "string");
}

// The filter text of each segment a measure names, in its order; undefined for a name the model does
// not declare or a segment without a filter.
export function segmentFilters(measure: Measure | Record<string, unknown>, model: Model | Record<string, unknown> | undefined): (string | undefined)[] {
  return segmentNames(measure).map((n) => {
    const f = findSegment(model, n)?.filter;
    return typeof f === "string" ? f : undefined;
  });
}

// Predicates combined with AND. One is returned as written, so a measure without segments compiles
// as before; several are each parenthesized, a line comment ending on its own line.
export function andPredicates(texts: string[]): string | undefined {
  if (texts.length <= 1) return texts[0];
  return texts.map((t) => `(${t.includes("--") ? `${t}\n` : t})`).join(" and ");
}

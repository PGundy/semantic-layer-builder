// Segments in the reference compiler (references/spec.md, Metric semantics): a measure's filter is
// its own filter ANDed with the filters of the segments it names, and a plain request's segments
// narrow its base model in WHERE.
import { andPredicates, findSegment, segmentFilters, segmentNames } from "../segments.ts";
import type { Measure, Model } from "../types.ts";

// The predicate a measure's aggregate applies: its filter, then each of its segments' filters, in
// order; undefined when it has none. A segment the model does not declare is left out here and
// refused by the caller (unknownSegments).
export function measureFilter(measure: Measure, model: Model): string | undefined {
  const texts = [measure.filter, ...segmentFilters(measure, model)].filter((t): t is string => typeof t === "string");
  return andPredicates(texts);
}

// The names a measure lists that its model declares no segment with a filter for.
export function unknownSegments(measure: Measure, model: Model): string[] {
  return segmentNames(measure).filter((n) => typeof findSegment(model, n)?.filter !== "string");
}

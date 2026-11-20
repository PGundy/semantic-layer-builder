// The time options of a request (spec: Metric semantics, Running totals and comparisons): keys
// beside measures, dimensions and filters that ask for a running or trailing total over approved
// measures. They add no item to approve; a golden's request records them and its hash covers them.
import { parseRequestField } from "./refs.ts";

// running: a running total of each measure over the dimension `over` (model.field:grain, one of the
// request's dimensions), or with `periods` the total of the last n periods of that grain.
export interface RunningRequest {
  over: string;
  periods?: number;
}

// The request keys that each turn a grouped request into a time view; a request takes at most one.
export const TIME_SHAPE_KEYS = ["running", "compare", "window"] as const;

// The interval one period of a grain steps by in a generate_series.
export function grainStep(grain: string): string {
  return grain === "quarter" ? "3 months" : `1 ${grain}`;
}

// A grain as a plural noun: "months".
export function grainPlural(grain: string): string {
  return `${grain}s`;
}

// running.over split into its field (model.field) and grain, or undefined when it is not
// model.field:grain.
export function overField(over: unknown): { field: string; model: string; name: string; grain: string } | undefined {
  const p = typeof over === "string" ? parseRequestField(over) : undefined;
  return p?.grain ? { field: `${p.model}.${p.field}`, model: p.model, name: p.field, grain: p.grain } : undefined;
}

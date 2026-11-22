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

// compare: each measure beside its value in the period before (prior) and the same period a year
// earlier (year_ago), with the change and the change as a fraction, over the dimension `over`
// (model.field:grain, one of the request's dimensions).
export type Comparison = "prior" | "year_ago";
export interface CompareRequest {
  over?: string;
  with: Comparison[];
}

// window: each measure over the `days` days up to `as_of` (YYYY-MM-DD, both days included) by the
// time dimension `dimension` (model.field), beside the days before it and the same days a year
// earlier when the request also has compare: {with}. The compiler needs as_of; only semlayer sql
// fills a missing one from the clock (withAsOf), and semlayer goldens new writes it into the golden.
export interface WindowRequest {
  dimension: string;
  days: number;
  as_of?: string;
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

// running.over or compare.over split into its field (model.field) and grain, or undefined when it is not
// model.field:grain.
export function overField(over: unknown): { field: string; model: string; name: string; grain: string } | undefined {
  const p = typeof over === "string" ? parseRequestField(over) : undefined;
  return p?.grain ? { field: `${p.model}.${p.field}`, model: p.model, name: p.field, grain: p.grain } : undefined;
}

// A request whose window has no as_of, with the clock's date in UTC filled in, and that date; any
// other request as it is. Only semlayer sql and semlayer goldens new call it: the compiler and a
// golden's checks never read the clock.
export function withAsOf<T>(request: T, now: Date): { request: T; filled?: string } {
  const r = request as unknown as Record<string, unknown>;
  const w = r && typeof r === "object" && !Array.isArray(r) ? r.window : undefined;
  if (!w || typeof w !== "object" || Array.isArray(w) || (w as Record<string, unknown>).as_of !== undefined) return { request };
  const filled = now.toISOString().slice(0, 10);
  return { request: { ...r, window: { ...(w as Record<string, unknown>), as_of: filled } } as unknown as T, filled };
}

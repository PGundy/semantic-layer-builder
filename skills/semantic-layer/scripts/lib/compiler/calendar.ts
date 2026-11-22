// The calendar of a source and the default time dimension of a measure (spec: Metric semantics,
// Calendar and default time dimension). A source's `calendar.week_start` names the day a week
// starts; unset, a week starts on Monday, as date_trunc('week', ...) gives on postgres and duckdb.
// A measure's or model's `default_time_dimension` names the time dimension of its model a request's
// bare `:grain` field reads.
import { grainShorthand, parseRequestField } from "../refs.ts";
import type { Measure, Model, QueryRequest } from "../types.ts";

export const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The week start a parsed source file sets, or undefined when it sets none or sets monday, the
// default: a week that starts on Monday compiles, hashes and reads back as one with no calendar.
export function sourceWeekStart(config: unknown): WeekDay | undefined {
  const day = isObj(config) && isObj(config.calendar) ? config.calendar.week_start : undefined;
  return typeof day === "string" && (WEEK_DAYS as readonly string[]).includes(day) && day !== "monday" ? (day as WeekDay) : undefined;
}

// The start of the week holding `expr`, for a week that starts on `day`: date_trunc('week', ...)
// starts weeks on Monday, so the value is shifted forward by the days from `day` to the next
// Monday, truncated, and shifted back. Monday gives date_trunc('week', expr) as written.
export function weekStart(expr: string, day: WeekDay): string {
  const shift = (7 - WEEK_DAYS.indexOf(day)) % 7;
  if (shift === 0) return `date_trunc('week', ${expr})`;
  const by = `interval '${shift} day${shift === 1 ? "" : "s"}'`;
  return `date_trunc('week', (${expr}) + ${by}) - ${by}`;
}

// The time dimension a measure is measured over by default: its own default_time_dimension, else
// its model's, else none.
export function defaultTimeDimension(model: Model, measure?: Measure): string | undefined {
  return measure?.default_time_dimension ?? model.default_time_dimension;
}

// A request with each bare ":grain" field (in dimensions, filters and order_by) written in full as
// model.<default>:grain, where the default is that of the request's first measure; the request as it
// is when it has none. A request with no measure of a model as its first, or whose first measure has
// no default, is refused with how to set one. A first measure the source lacks is left to the
// compiler's own checks.
export function resolveDefaultTime(request: QueryRequest, models: readonly Model[]): { request: QueryRequest } | { refusal: { message: string; ref: string; next: string } } {
  const fields = [...(request.dimensions ?? []), ...(request.filters ?? []).map((f) => f.field), ...(request.order_by ?? []).map((o) => o.field)];
  const short = fields.find((f) => grainShorthand(f) !== undefined);
  if (short === undefined) return { request };
  const first = request.measures?.[0];
  const p = first === undefined ? undefined : parseRequestField(first);
  const model = p && models.find((m) => m.model === p.model);
  const measure = model && (model.measures ?? []).find((m) => m.name === p!.field);
  if (first !== undefined && p && (!model || !measure)) return { request };
  const name = model && defaultTimeDimension(model, measure);
  if (!model || !name) {
    const why = !first
      ? "the request names no measure, and the shorthand reads the default time dimension of its first measure"
      : !p
        ? `its first measure, ${first}, is a metric, and the shorthand reads the default time dimension of a measure of a model`
        : `neither ${first} nor model ${model!.model} names a default_time_dimension`;
    const set = `semlayer set ${request.source}.${model ? model.model : "<model>"} default_time_dimension <time dimension>${measure ? ` (or on ${request.source}.${first})` : ""}`;
    return {
      refusal: {
        message: `the request names ${short}, but ${why}`,
        ref: short,
        next: `Name the time dimension in full as model.<time dimension>${short}, or ${set}, read it back and approve it on the owner's yes, then run semlayer sql again.`,
      },
    };
  }
  const full = (f: string) => (grainShorthand(f) === undefined ? f : `${model.model}.${name}${f}`);
  return {
    request: {
      ...request,
      ...(request.dimensions ? { dimensions: request.dimensions.map(full) } : {}),
      ...(request.filters ? { filters: request.filters.map((f) => ({ ...f, field: full(f.field) })) } : {}),
      ...(request.order_by ? { order_by: request.order_by.map((o) => ({ ...o, field: full(o.field) })) } : {}),
    },
  };
}

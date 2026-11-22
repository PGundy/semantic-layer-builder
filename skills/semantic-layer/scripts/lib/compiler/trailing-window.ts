// A trailing window of days in the reference compiler (spec: Metric semantics, Running totals and
// comparisons). A request with `window: {dimension, days, as_of}` compiles the request without it
// once per window ("current window", and with compare: {with} the "prior window" and "year ago
// window"), each through compileLayer with two filters on the dimension, so joins, the user's row
// filters, visibility and a metric's own WITH apply as they do in any request. "data start" is the
// first day of data under the request's filters; a window that starts before it is null. "window
// figures" sets the windows side by side, and the outer query adds compareColumns from
// period-compare.ts. windowBounds is pure date arithmetic: neither it nor the compiler reads a clock.
import { quoteIdent } from "../dialect.ts";
import { parseRequestField } from "../refs.ts";
import type { Comparison } from "../time-request.ts";
import type { QueryRequest, RequestFilter } from "../types.ts";
import { NAME_PATTERN, TIME_GRAINS } from "../types.ts";
import { totalColumns, type ViewWords, viewQuery } from "./cumulative.ts";
import type { Compiled, CompiledColumn, CompileInput, CompileResult, Refusal } from "./index.ts";
import { compareColumns } from "./period-compare.ts";
import { nonAdditiveDimension } from "./semi-additive.ts";
import { Params } from "./sql.ts";

type Compile = (input: CompileInput) => CompileResult;

// A run of days, both included, as YYYY-MM-DD.
export interface Days {
  start: string;
  end: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

// A YYYY-MM-DD string that names a day of the calendar (not 2025-02-30).
export function isDate(text: unknown): text is string {
  const m = typeof text === "string" ? DATE.exec(text) : null;
  return !!m && iso(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) === text;
}

export function addDays(date: string, n: number): string {
  const m = DATE.exec(date)!;
  return iso(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * DAY_MS);
}

// The same month and day a year earlier, 29 February read as 28 February.
export function yearEarlier(date: string): string {
  const [y, md] = [Number(date.slice(0, 4)) - 1, date.slice(5)];
  return `${String(y).padStart(4, "0")}-${md === "02-29" ? "02-28" : md}`;
}

// The number of days from start to end, both included.
export function dayCount(d: Days): number {
  return Math.round((Date.parse(d.end) - Date.parse(d.start)) / DAY_MS) + 1;
}

// The windows of `days` days as of `as_of`: the current one ends on as_of; prior is the `days` days
// before it; year_ago moves each end of the current one to the same date a year earlier, so it can
// be a day longer or shorter.
export function windowBounds(window: { days: number; as_of: string }, withs: readonly Comparison[] = []): { current: Days } & Partial<Record<Comparison, Days>> {
  const current = { start: addDays(window.as_of, 1 - window.days), end: window.as_of };
  return {
    current,
    ...(withs.includes("prior") ? { prior: { start: addDays(current.start, -window.days), end: addDays(current.start, -1) } } : {}),
    ...(withs.includes("year_ago") ? { year_ago: { start: yearEarlier(current.start), end: yearEarlier(current.end) } } : {}),
  };
}

// The CTE of each window.
export const WINDOW_CTE: Record<"current" | Comparison, string> = { current: "current window", prior: "prior window", year_ago: "year ago window" };

const WORDS: ViewWords = { key: "window", noun: "a window", measureFilter: "a filter on a figure would keep different rows in each window" };
const q = (n: string) => quoteIdent("postgres", n);

export function compileWindow(input: CompileInput, request: QueryRequest, compile: Compile): CompileResult {
  const { layer, source } = input;
  const window = request.window!;
  const refusals: Refusal[] = [];
  const add = (message: string, ref?: string, next?: string) => {
    if (!refusals.some((r) => r.message === message)) refusals.push({ code: "invalid_request", message, ...(ref ? { ref } : {}), ...(next ? { next } : {}) });
  };
  const refuse = (): CompileResult => ({ ok: false, source: source.source, reason: refusals.map((r) => r.message).join("; "), refusals });
  const models = layer.models.filter((m) => m.source === source.source);
  const isMetric = (ref: string) => NAME_PATTERN.test(ref) && layer.metrics.some((m) => m.name === ref && (m.source ?? source.source) === source.source);
  const dim = window.dimension;
  const withs = request.compare?.with ?? [];

  if (window.as_of === undefined)
    add(
      `window names no as_of; semlayer sql fills it from the clock, and a golden states it: add "as_of": "YYYY-MM-DD", the last day of the window`,
      dim,
      `Add "as_of": "YYYY-MM-DD" to request.window in the golden file goldens/<name>.yaml and run semlayer validate; semlayer sql fills it from the clock for a request typed on the command line, and semlayer goldens new writes it.`,
    );
  else if (!isDate(window.as_of)) add(`window.as_of is ${window.as_of}, which is not a day of the calendar; write the last day of the window as YYYY-MM-DD`, dim);
  const p = parseRequestField(dim);
  const model = p && models.find((m) => m.model === p.model);
  const field = model && (model.dimensions ?? []).find((d) => d.name === p!.field);
  if (!field) add(`window.dimension is ${dim}, which is not a dimension of a model of source ${source.source}; name a time dimension as model.field`, dim);
  else if (field.type !== "time") add(`window.dimension is ${dim}, a ${field.type} dimension; a window counts days, so name a time dimension as model.field`, dim);
  else if (!((field.time_grains ?? TIME_GRAINS) as readonly string[]).includes("day"))
    add(`window.dimension is ${dim}, whose grains are ${(field.time_grains ?? []).join(", ")}; a window counts days, so name a time dimension that allows the day grain, or add day to its time_grains`, dim);
  if (request.running) add("the request names running and window; a window takes no running total: ask for the running total in a request of its own", dim);
  if (request.compare?.over !== undefined)
    add(`compare.over is ${request.compare.over}; beside a window, compare names only with, and each window is set beside the days before it or a year earlier: drop compare.over`, request.compare.over);
  const measures = request.measures ?? [];
  if (!measures.length) add("the request names no measure; a window sums the request's measures over its days, so name at least one");
  measures.forEach((ref, i) => {
    const mp = parseRequestField(ref);
    const m = mp && (models.find((x) => x.model === mp.model)?.measures ?? []).find((x) => x.name === mp.field);
    const nad = m && nonAdditiveDimension(m);
    if (nad)
      add(
        `measures[${i}] names ${ref}, a balance kept along ${mp!.model}.${nad.name}; a balance is not added up over days, so it has no window: ask for it by day with compare: {"over": "${mp!.model}.${nad.name}:day", "with": [...]} and no window`,
        ref,
      );
  });
  const same = (ref: string) => {
    const r = parseRequestField(ref);
    return !!r && `${r.model}.${r.field}` === dim;
  };
  (request.filters ?? []).forEach((f, i) => {
    const fp = parseRequestField(f.field);
    const isMeasure = isMetric(f.field) || (fp && !fp.grain && models.some((m) => m.model === fp.model && m.measures.some((x) => x.name === fp.field)));
    if (isMeasure) add(`filters[${i}] is on ${f.field}, a measure; ${WORDS.measureFilter}: ask without window to filter on ${f.field}`, f.field);
    else if (same(f.field)) add(`filters[${i}] is on ${f.field}; the window picks the days of ${dim}: drop the filter, and set window.days and window.as_of to the days wanted`, f.field);
  });
  if (withs.length)
    (request.dimensions ?? []).forEach((d, i) => {
      if (same(d))
        add(`dimensions[${i}] is ${d}, the window's dimension; each window holds other days, so its rows cannot be set beside each other: drop ${d}, or ask by ${d} without window`, d);
    });
  if (refusals.length) return refuse();

  const bounds = windowBounds({ days: window.days, as_of: window.as_of! }, withs);
  const { window: _w, compare: _c, order_by: _o, limit: _l, ...rest } = request;
  const filters: RequestFilter[] = request.filters ?? [];
  const start = input.paramStart ?? 0;
  const params: unknown[] = [];
  const ctes: string[] = [];
  const part = (name: string, sub: QueryRequest): Compiled | CompileResult => {
    const r = compile({ ...input, request: sub, paramStart: start + params.length });
    if (r.ok) {
      params.push(...r.params);
      ctes.push(`${q(name)} as (\n${r.sql}\n)`);
    }
    return r;
  };
  const windows: ["current" | Comparison, Days][] = [["current", bounds.current], ...withs.map((c): [Comparison, Days] => [c, bounds[c]!])];
  let current: Compiled | undefined;
  for (const [w, d] of windows) {
    const sub = { ...rest, filters: [...filters, { field: dim, op: "gte", value: d.start }, { field: dim, op: "lt", value: addDays(d.end, 1) }] } as QueryRequest;
    const r = part(WINDOW_CTE[w], sub);
    if (!r.ok) return r;
    current ??= r;
  }
  const day = `${dim}:day`;
  const startReq = { source: request.source, dimensions: [day], ...(filters.length ? { filters } : {}), order_by: [{ field: day, direction: "asc" }], limit: 1 } as QueryRequest;
  const first = part("data start", startReq);
  if (!first.ok) return first;
  const startCol = `${q("data start")}.${q(first.columns[0]!.name)}`;

  const nDims = (request.dimensions ?? []).length;
  const dimCols = current!.columns.slice(0, nDims);
  const valueCols = current!.columns.slice(nDims);
  const totals = totalColumns(input, valueCols);
  // Each window's figure, null when the window starts before the first day of data; within the
  // data, a group with no rows in a window is 0 for a sum, count or count_distinct.
  const bind = new Params(start + params.length);
  const figures = windows.flatMap(([w, d]) => {
    const since = bind.add(d.start);
    return valueCols.map((c) => {
      const v = `${q(WINDOW_CTE[w])}.${q(c.name)}`;
      return `  case when ${startCol} <= ${since} then ${totals.includes(c.name) ? `coalesce(${v}, 0)` : v} end as ${q(w === "current" ? c.name : `${c.name}_${w}`)}`;
    });
  });
  params.push(...bind.values);
  const from = dimCols.length
    ? [
        `from ${q("window groups")}`,
        ...windows.map(
          ([w]) => `left join ${q(WINDOW_CTE[w])} on ${dimCols.map((c) => `${q(WINDOW_CTE[w])}.${q(c.name)} is not distinct from ${q("window groups")}.${q(c.name)}`).join(" and ")}`,
        ),
      ]
    : [`from ${q(WINDOW_CTE.current)}`, ...windows.slice(1).map(([w]) => `cross join ${q(WINDOW_CTE[w])}`)];
  if (dimCols.length)
    ctes.push(`${q("window groups")} as (\n${windows.map(([w]) => `select ${dimCols.map((c) => q(c.name)).join(", ")} from ${q(WINDOW_CTE[w])}`).join("\nunion\n")}\n)`);
  ctes.push(
    [
      `${q("window figures")} as (`,
      "select",
      [...dimCols.map((c) => `  ${q("window groups")}.${q(c.name)}`), ...figures].join(",\n"),
      ...from,
      `left join ${q("data start")} on true`,
      ")",
    ].join("\n"),
  );

  const columns: { column: CompiledColumn; sql?: string }[] = [
    ...current!.columns.map((column) => ({ column })),
    ...valueCols.flatMap((c) => compareColumns(c.name, withs).map((x) => ({ column: { name: x.name, ref: c.ref, kind: c.kind }, sql: x.sql }))),
  ];
  // The current window's joins and row filters stand for every window's: each is the same request.
  const r: Compiled = { ...current!, params };
  return viewQuery(input, request, r, { over: { field: dim, model: p!.model, name: p!.field, grain: "day" }, at: 0, inner: [], outer: [] }, ctes, "window figures", columns, WORDS);
}

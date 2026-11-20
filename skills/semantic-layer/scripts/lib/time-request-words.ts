// A request's time view in words (spec: Metric semantics, Running totals and comparisons), for the
// golden readback, semlayer goldens new, run and confirm, and semlayer sql: the sentences say what
// the owner's yes to the figures covers.
import { parseRequestField } from "./refs.ts";
import { dayCount, isDate, windowBounds } from "./compiler/trailing-window.ts";
import { type Comparison, grainPlural, overField } from "./time-request.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// One sentence per time option of the request, none for a request without one.
export function timeShapeWords(request: unknown): string[] {
  if (isObj(request) && isObj(request.window)) return windowWords(request, request.window);
  if (isObj(request) && isObj(request.compare)) return compareWords(request, request.compare);
  if (!isObj(request) || !isObj(request.running)) return [];
  const running = request.running;
  const over = overField(running.over);
  if (!over) return [`Running total over ${JSON.stringify(running.over ?? null)}, which is not model.field:grain, so the request does not compile.`];
  const g = over.grain;
  const columns = (Array.isArray(request.measures) ? request.measures : []).flatMap((m) => {
    const p = typeof m === "string" ? parseRequestField(m) : undefined;
    return p ? [typeof running.periods === "number" ? `${p.field}_trailing_${running.periods}` : `${p.field}_running`] : [];
  });
  const named = columns.length ? ` (${columns.join(", ")})` : "";
  const out = [
    typeof running.periods === "number"
      ? `Total of the last ${running.periods} ${grainPlural(g)} of each figure${named} over ${over.field} by ${g}, each ${g} included; blank until ${running.periods} ${grainPlural(g)} of data; a ${g} with no rows adds 0; rows with no ${over.field} are left out.`
      : `Running total of each figure${named} over ${over.field} by ${g}, from the first ${g} of data; a ${g} with no rows adds 0; rows with no ${over.field} are left out.`,
  ];
  const filtered = (Array.isArray(request.filters) ? request.filters : []).some((f) => isObj(f) && f.field === running.over);
  if (filtered) out.push(`A filter on ${running.over} only picks the ${grainPlural(g)} shown; the totals still start at the first ${g} of data.`);
  return out;
}

const EARLIER: Record<string, (g: string) => string> = { prior: (g) => `the ${g} before`, year_ago: (g) => `the same ${g} a year earlier` };

// The comparison in words: what each figure is set beside, the columns it adds, and what an empty
// or missing earlier period shows.
function compareWords(request: Record<string, unknown>, compare: Record<string, unknown>): string[] {
  const over = overField(compare.over);
  if (!over) return [`Comparison over ${JSON.stringify(compare.over ?? null)}, which is not model.field:grain, so the request does not compile.`];
  const g = over.grain;
  const withs = (Array.isArray(compare.with) ? compare.with : []).filter((w): w is string => typeof w === "string" && w in EARLIER);
  const columns = (Array.isArray(request.measures) ? request.measures : []).flatMap((m) => {
    const name = typeof m === "string" ? (parseRequestField(m)?.field ?? m) : undefined;
    return name ? withs.flatMap((w) => [`${name}_${w}`, `${name}_${w}_change`, `${name}_${w}_pct`]) : [];
  });
  const named = columns.length ? ` (${columns.join(", ")})` : "";
  const out = [
    `Each figure beside ${withs.map((w) => EARLIER[w]!(g)).join(" and ")}, with the change and the change as a fraction of the earlier figure${named}, over ${over.field} by ${g}; blank where the earlier ${g} is before the data; a ${g} with no rows counts as 0 for a sum or a count (any other figure, a balance or a metric there is blank), and the fraction is blank when the earlier figure is 0 or blank; rows with no ${over.field} are left out.`,
  ];
  if (g === "day" && withs.includes("year_ago")) out.push("A year before 29 February is 28 February.");
  const filtered = (Array.isArray(request.filters) ? request.filters : []).some((f) => isObj(f) && f.field === compare.over);
  if (filtered) out.push(`A filter on ${compare.over} only picks the ${grainPlural(g)} shown; each is still compared with the earlier ${grainPlural(g)}, shown or not.`);
  return out;
}

// The window in words: its days as dates from windowBounds, the dates it is set beside, the
// columns it adds, and what an empty or early window shows.
function windowWords(request: Record<string, unknown>, window: Record<string, unknown>): string[] {
  const dim = String(window.dimension);
  const days = typeof window.days === "number" ? window.days : NaN;
  if (window.as_of !== undefined && !isDate(window.as_of))
    return [`A window of ${Number.isFinite(days) ? days : "?"} days of ${dim} whose as-of date (window.as_of) is not a day of the calendar, so it does not compile; write the last day of the window as YYYY-MM-DD.`];
  if (!isDate(window.as_of))
    return [`A window of ${Number.isFinite(days) ? days : "?"} days of ${dim} that states no as-of date (window.as_of), so it does not compile: semlayer validate reports it as metric.window_as_of_missing, and semlayer sql fills it from the clock.`];
  const cmp = isObj(request.compare) && Array.isArray(request.compare.with) ? request.compare.with : [];
  const withs = cmp.filter((w): w is Comparison => w === "prior" || w === "year_ago");
  const b = windowBounds({ days, as_of: window.as_of }, withs);
  const span = (d: { start: string; end: string }) => `${d.start} to ${d.end}`;
  const against = withs.map((w) => `against ${span(b[w]!)}`).join(" and ");
  const out = [
    `Over the ${days} days ${span(b.current)} (as of ${window.as_of})${against ? `, ${against}` : ""}; days of ${dim} as its expr gives them; a window that starts before the first day of data is blank.`,
  ];
  const names = (Array.isArray(request.measures) ? request.measures : []).flatMap((m) => (typeof m === "string" ? [parseRequestField(m)?.field ?? m] : []));
  const columns = names.flatMap((n) => [n, ...withs.flatMap((w) => [`${n}_${w}`, `${n}_${w}_change`, `${n}_${w}_pct`])]);
  const which = withs.map((w) => (w === "prior" ? `_prior the ${days} days before` : "_year_ago the same dates a year earlier")).join(", ");
  out.push(
    `Columns ${columns.join(", ")}${which ? ` (${which}, each with the change and the change as a fraction of the earlier figure)` : ""}; a window with no rows counts as 0 for a sum or a count (a metric or any other figure there is blank)${withs.length ? ", and the fraction is blank when the earlier figure is 0 or blank" : ""}.`,
  );
  if (b.year_ago && dayCount(b.year_ago) !== days)
    out.push(`The year-ago window is ${dayCount(b.year_ago)} days, not ${days}: one of the two ranges holds 29 February, and a year before 29 February is 28 February.`);
  return out;
}

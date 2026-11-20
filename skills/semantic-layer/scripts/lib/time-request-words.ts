// A request's time view in words (spec: Metric semantics, Running totals and comparisons), for the
// golden readback, semlayer goldens new, run and confirm, and semlayer sql: the sentences say what
// the owner's yes to the figures covers.
import { parseRequestField } from "./refs.ts";
import { grainPlural, overField } from "./time-request.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// One sentence per time option of the request, none for a request without one.
export function timeShapeWords(request: unknown): string[] {
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

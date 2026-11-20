// A request's time view in words (spec: Metric semantics, Running totals and comparisons), for the
// golden readback, semlayer goldens new, run and confirm, and semlayer sql: the sentences say what
// the owner's yes to the figures covers.
import { parseRequestField } from "./refs.ts";
import { grainPlural, overField } from "./time-request.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// One sentence per time option of the request, none for a request without one.
export function timeShapeWords(request: unknown): string[] {
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

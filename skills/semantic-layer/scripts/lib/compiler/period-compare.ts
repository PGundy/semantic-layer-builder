// Comparison with the prior period and a year earlier in the reference compiler (spec: Metric
// semantics, Running totals and comparisons). A request with `compare: {over, with}` compiles the
// inner request (as cumulative.ts does for running) into "periods", lays it over every period with
// spine(), and sets beside each figure its value in the period before (`lag` over "filled") and in
// the same period a year earlier (a self-join of "filled" as "year ago"), with the change and the
// change as a fraction. Both read "filled", so the earlier period counts even when it had no rows, or
// lies before the periods a filter on `over` shows; one before the series starts gives null.
import { quoteIdent } from "../dialect.ts";
import { parseRequestField } from "../refs.ts";
import type { Comparison } from "../time-request.ts";
import type { QueryRequest } from "../types.ts";
import { innerRequest, spine, totalColumns, viewPlan, type ViewWords, viewQuery } from "./cumulative.ts";
import type { CompiledColumn, CompileInput, CompileResult, Refusal } from "./index.ts";

type Compile = (input: CompileInput) => CompileResult;

const WORDS: ViewWords = { key: "compare", noun: "a comparison", measureFilter: "a filter on a figure would hide the earlier period a row is compared with" };
// The grains whose period a year earlier is a period of the same grain.
const YEAR_AGO_GRAINS = ["day", "month", "quarter", "year"];

const q = (n: string) => quoteIdent("postgres", n);

// The three columns a comparison adds to the figure `name`, each with its SQL over the columns
// `<name>` and `<name>_<c>`: the earlier figure, the change and the change as a fraction of the
// earlier figure (null when that is 0 or null).
export function compareColumns(name: string, comparisons: Comparison[]): { name: string; sql: string }[] {
  return comparisons.flatMap((c) => {
    const m = q(name);
    const e = q(`${name}_${c}`);
    return [
      { name: `${name}_${c}`, sql: e },
      { name: `${name}_${c}_change`, sql: `${m} - ${e}` },
      { name: `${name}_${c}_pct`, sql: `cast(${m} - ${e} as numeric) / nullif(${e}, 0)` },
    ];
  });
}

export function compileCompare(input: CompileInput, request: QueryRequest, compile: Compile): CompileResult {
  const { source } = input;
  const compare = request.compare!;
  const refusals: Refusal[] = [];
  const add = (message: string, ref?: string) => {
    if (!refusals.some((r) => r.message === message)) refusals.push({ code: "invalid_request", message, ...(ref ? { ref } : {}) });
  };
  const refuse = (): CompileResult => ({ ok: false, source: source.source, reason: refusals.map((r) => r.message).join("; "), refusals });

  const dims = (request.dimensions ?? []).filter((d) => parseRequestField(d)?.grain);
  if (compare.over === undefined) {
    add(`compare names no over; compare.over names the time dimension of the request it compares by, as model.field:grain${dims.length === 1 ? `: write ${dims[0]}` : ""}`);
    return refuse();
  }
  const plan = viewPlan(input, request, compare.over, WORDS, add);
  if (!plan) return refuse();
  const { over } = plan;
  if (!(request.measures ?? []).length) add("the request names no measure; a comparison sets each of the request's measures beside an earlier period, so name at least one");
  if (compare.with.includes("year_ago") && !YEAR_AGO_GRAINS.includes(over.grain))
    add(
      `compare.with names year_ago by ${over.grain}; a ${over.grain} a year earlier is not a ${over.grain} of the series: compare by ${over.grain} with prior only, or ask for year_ago with compare.over at the month grain, ${over.field}:month`,
      compare.over,
    );
  if (refusals.length) return refuse();

  const r = compile({ ...input, request: innerRequest(request, plan) });
  if (!r.ok) return r;

  const nDims = (request.dimensions ?? []).length;
  const dimCols = r.columns.slice(0, nDims);
  const valueCols = r.columns.slice(nDims);
  const period = dimCols[plan.at]!.name;
  const others = dimCols.filter((_, i) => i !== plan.at).map((c) => c.name);
  const ctes = spine({ dialect: source.dialect, inner: r.sql, period, grain: over.grain, others, values: valueCols.map((c) => c.name), totals: totalColumns(input, valueCols) });

  // "compared": "filled" with each figure's value in the period before and a year earlier.
  const f = (n: string) => `${q("filled")}.${q(n)}`;
  const win = `${others.length ? `partition by ${others.map(f).join(", ")} ` : ""}order by ${f(period)}`;
  const earlier = valueCols.flatMap((c) =>
    compare.with.map((w) => (w === "prior" ? `  lag(${f(c.name)}) over (${win}) as ${q(`${c.name}_prior`)}` : `  ${q("year ago")}.${q(c.name)} as ${q(`${c.name}_year_ago`)}`)),
  );
  const join = compare.with.includes("year_ago")
    ? [
        `left join ${q("filled")} as ${q("year ago")} on ${[
          `${q("year ago")}.${q(period)} = cast(${f(period)} - interval '1 year' as date)`,
          ...others.map((o) => `${q("year ago")}.${q(o)} is not distinct from ${f(o)}`),
        ].join(" and ")}`,
      ]
    : [];
  ctes.push([`${q("compared")} as (`, "select", [...r.columns.map((c) => `  ${f(c.name)}`), ...earlier].join(",\n"), `from ${q("filled")}`, ...join, ")"].join("\n"));

  const columns: { column: CompiledColumn; sql?: string }[] = [
    ...r.columns.map((column) => ({ column })),
    ...valueCols.flatMap((c) => compareColumns(c.name, compare.with).map((x) => ({ column: { name: x.name, ref: c.ref, kind: c.kind }, sql: x.sql }))),
  ];
  return viewQuery(input, request, r, plan, ctes, "compared", columns, WORDS);
}

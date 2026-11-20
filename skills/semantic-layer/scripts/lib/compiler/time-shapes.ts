// The time views of a request in the reference compiler (spec: Metric semantics, Running totals and
// comparisons): a request with `running` is compiled by cumulative.ts over the grouped request
// without it. compileTimeShapes returns undefined for a request with no time view, so it compiles
// as before. A time view compiles for PostgreSQL only, and a request takes one of them.
import type { QueryRequest } from "../types.ts";
import { TIME_SHAPE_KEYS } from "../time-request.ts";
import { compileRunning } from "./cumulative.ts";
import type { CompileInput, CompileResult, Refusal } from "./index.ts";

type Compile = (input: CompileInput) => CompileResult;

// prior holds the refusals the request already has (visibility); compile is compileLayer, which
// compiles the grouped request the view is built over.
export function compileTimeShapes(input: CompileInput, request: QueryRequest, prior: Refusal[], compile: Compile): CompileResult | undefined {
  const asked = TIME_SHAPE_KEYS.filter((k) => (request as unknown as Record<string, unknown>)[k] !== undefined);
  if (!asked.length) return undefined;
  const { source } = input;
  const refusals = [...prior];
  if (source.dialect !== "postgres")
    refusals.push({
      code: "unsupported_dialect",
      message: `source ${source.source} is ${source.dialect}; a request with ${asked.join(" or ")} compiles for PostgreSQL sources only`,
      next: `Ask for the request without ${asked.join(" or ")} on this source, or on a PostgreSQL source, and run semlayer sql again.`,
    });
  if (asked.length > 1)
    refusals.push({ code: "invalid_request", message: `the request names ${asked.join(" and ")}; a request takes one of ${TIME_SHAPE_KEYS.join(", ")}: ask for each in a request of its own` });
  if (refusals.length) return { ok: false, source: source.source, reason: refusals.map((r) => r.message).join("; "), refusals };
  return compileRunning(input, request, compile);
}

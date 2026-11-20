// Metric semantics (spec: Metric semantics): a model's segments have unique names and filters
// checked as a measure filter is, a measure names only segments its model declares, and a golden's
// request names only segments that exist.
import { parseRequestField } from "../refs.ts";
import { modelSegments, segmentNames } from "../segments.ts";
import { readsText, sqlTextProblem } from "../sql-text.ts";
import type { RuleContext } from "./index.ts";

export default function metric(ctx: RuleContext): void {
  for (const [source, models] of ctx.models) {
    for (const loaded of models.values()) {
      if (!loaded.valid) continue;
      const model = loaded.data;
      const file = loaded.file;
      const rules = ctx.identRules(source);
      const seen = new Map<string, number>();
      (Array.isArray(model.segments) ? model.segments : []).forEach((seg, i) => {
        const path = `segments[${i}]`;
        const first = seen.get(seg.name);
        if (first !== undefined)
          ctx.error(
            file,
            `${path}.name`,
            `segment ${seg.name} is declared twice (also segments[${first}]); keep one, or rename this one and update the measures that name it`,
            "metric.segment_duplicate",
          );
        else seen.set(seg.name, i);
        const problem = readsText(rules.dialect) ? sqlTextProblem(seg.filter, "measure filter") : undefined;
        if (problem) ctx.error(file, `${path}.filter`, problem, "expr.not_one_expression");
        else ctx.checkSqlRefs(file, `${path}.filter`, seg.filter, model, "measure filter");
      });
      const declared = new Set(modelSegments(model).map((s) => s.name));
      (Array.isArray(model.measures) ? model.measures : []).forEach((m, i) => {
        segmentNames(m).forEach((name, k) => {
          if (!declared.has(name))
            ctx.error(
              file,
              `measures[${i}].segments[${k}]`,
              `names segment ${name}, which model ${model.model} does not declare${declared.size ? ` (its segments are ${[...declared].join(", ")})` : ""}; add it under segments in this file, or take it out of the measure's segments`,
              "metric.segment_unknown",
            );
        });
      });
    }
  }

  for (const g of ctx.goldens) {
    if (!g.valid) continue;
    const request = g.data.request;
    (request?.segments ?? []).forEach((ref, i) => {
      const p = parseRequestField(ref);
      const model = p ? ctx.models.get(request.source)?.get(p.model)?.data : undefined;
      if (!p || !model || !modelSegments(model).some((s) => s.name === p.field))
        ctx.error(
          g.file,
          `request.segments[${i}]`,
          `names ${ref}, which is not a segment of a model of source ${request.source}; a request segment is model.segment`,
          "metric.segment_unknown",
        );
    });
  }
}

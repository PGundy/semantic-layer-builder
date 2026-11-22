// Metric semantics (spec: Metric semantics): a model's segments have unique names and filters
// checked as a measure filter is, a measure names only segments its model declares, a golden's
// request names only segments that exist and states the as_of of its window, and a
// default_time_dimension names a time dimension of its model; a non_additive_dimension names a time
// dimension over a primary key column, with an agg that reads one row per entity.
import { entityKeys, nonAdditiveDimension, SEMI_AGGREGATIONS } from "../compiler/semi-additive.ts";
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
      const defaults: [string, unknown][] = [["default_time_dimension", model.default_time_dimension]];
      (Array.isArray(model.measures) ? model.measures : []).forEach((m, i) => defaults.push([`measures[${i}].default_time_dimension`, m.default_time_dimension]));
      for (const [path, name] of defaults) {
        if (typeof name !== "string") continue;
        const dim = (Array.isArray(model.dimensions) ? model.dimensions : []).find((d) => d.name === name);
        const times = (Array.isArray(model.dimensions) ? model.dimensions : []).filter((d) => d.type === "time").map((d) => d.name);
        const fix = times.length ? `name one of its time dimensions (${times.join(", ")})` : "add a time dimension to the model first";
        if (!dim) ctx.error(file, path, `names ${name}, which is not a dimension of model ${model.model}; ${fix}, or remove the key`, "metric.default_time_unknown");
        else if (dim.type !== "time") ctx.error(file, path, `names ${name}, a ${dim.type} dimension; a default time dimension is type: time, so ${fix}, or remove the key`, "metric.default_time_not_time");
      }
      // A semi-additive measure keeps one row per entity and period along a time dimension whose
      // column is part of the primary key, and aggregates those rows (compiler/semi-additive.ts).
      (Array.isArray(model.measures) ? model.measures : []).forEach((m, i) => {
        const nad = nonAdditiveDimension(m);
        if (!nad) return;
        const path = `measures[${i}].non_additive_dimension.name`;
        const dims = Array.isArray(model.dimensions) ? model.dimensions : [];
        const dim = dims.find((d) => d.name === nad.name);
        const times = dims.filter((d) => d.type === "time").map((d) => d.name);
        const fix = times.length ? `name one of its time dimensions (${times.join(", ")})` : "add a time dimension to the model first";
        if (!dim) ctx.error(file, path, `names ${nad.name}, which is not a dimension of model ${model.model}; ${fix}, or remove non_additive_dimension; set one with semlayer set ${source}.${model.model}.${m.name} non_additive_dimension '{name: <time dimension>, window: last}'`, "metric.non_additive_dimension_unknown");
        else if (dim.type !== "time")
          ctx.error(file, path, `names ${nad.name}, a ${dim.type} dimension; a balance is kept along a type: time dimension, so ${fix}, or remove non_additive_dimension; set one with semlayer set ${source}.${model.model}.${m.name} non_additive_dimension '{name: <time dimension>, window: last}'`, "metric.non_additive_dimension_not_time");
        else if (!Array.isArray(model.primary_key) || !model.primary_key.length)
          ctx.error(
            file,
            path,
            `model ${model.model} has no primary_key, so semlayer cannot tell which rows are one entity's values on different days; set it with semlayer set ${source}.${model.model} primary_key <columns>`,
            "metric.non_additive_no_primary_key",
          );
        else if (!entityKeys(model, dim))
          ctx.error(
            file,
            path,
            `names ${nad.name}, whose expr ${String(dim.expr)} is not a column of the primary_key (${model.primary_key.join(", ")}) of model ${model.model}; a balance needs one row per entity and day, so name a time dimension over a primary key column, or set the primary_key with semlayer set ${source}.${model.model} primary_key <entity columns and that column>`,
            "metric.non_additive_dimension_not_key",
          );
        if (!(SEMI_AGGREGATIONS as readonly string[]).includes(m.agg))
          ctx.error(file, `measures[${i}].agg`, `is ${m.agg}; a measure with non_additive_dimension takes ${SEMI_AGGREGATIONS.join(", ")}, over each entity's kept row; change the agg with semlayer set ${source}.${model.model}.${m.name} agg sum, or remove non_additive_dimension; then run semlayer validate`, "metric.non_additive_agg");
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
    // A golden states the as-of date of its window: its figures are the owner's yes for those days,
    // so no check of it reads the clock.
    if (request?.window && request.window.as_of === undefined)
      ctx.error(
        g.file,
        "request.window",
        `has no as_of, so its days depend on the day it runs; add the last day of the window the owner's figures are for, as "as_of": "YYYY-MM-DD" (semlayer goldens new writes it), then semlayer validate`,
        "metric.window_as_of_missing",
      );
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

// Codes of the metric-semantics checks (lib/validate-rules/metric.ts) and the compiler's refusals of
// them (spec: Metric semantics).
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "metric.segment_duplicate": { level: "error", meaning: "A model declares two segments with the same name." },
  "metric.segment_unknown": { level: "error", meaning: "A measure or a golden's request names a segment its model does not declare." },
  "metric.default_time_unknown": { level: "error", meaning: "A model's or measure's default_time_dimension names no dimension of its model." },
  "metric.default_time_not_time": { level: "error", meaning: "A model's or measure's default_time_dimension names a dimension that is not type: time." },
  "metric.default_time_missing": {
    level: "error",
    meaning: "A request names a bare :grain field, and its first measure has no default time dimension to read it as (none on the measure or its model, or the first measure is a metric or missing), so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "metric.segments_on_metric": { level: "error", meaning: "A request names a metric and segments; segments apply to a request of one model's measures, so semlayer sql refuses it.", next: "semlayer sql" },
};
export default codes;

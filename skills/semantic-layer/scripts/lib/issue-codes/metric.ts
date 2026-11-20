// Codes of the metric-semantics checks (lib/validate-rules/metric.ts) and the compiler's refusals of
// them (spec: Metric semantics).
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "metric.segment_duplicate": { level: "error", meaning: "A model declares two segments with the same name." },
  "metric.segment_unknown": { level: "error", meaning: "A measure or a golden's request names a segment its model does not declare." },
  "metric.segments_on_metric": { level: "error", meaning: "A request names a metric and segments; segments apply to a request of one model's measures, so semlayer sql refuses it.", next: "semlayer sql" },
};
export default codes;

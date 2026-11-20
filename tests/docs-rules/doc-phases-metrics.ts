import type { DocRule } from "./index.ts";

// The procedure rules references/phases/metrics.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["phases/metrics.md", "a cross-source metric is two measures", "do not write a metric"],
  ["phases/metrics.md", "dimensions through joins date a cross-model metric", "expr: order.created_at"],
  // Sources and scope.
  ["phases/metrics.md", "cross-source formulas are recorded", "even when the owner keeps the metric in their own reports"],
  ["phases/metrics.md", "cross-source rules route", "federating source"],
  // Review fixes.
  ["phases/metrics.md", "federating source is the route if modelled", "do not model it in either source. If the owner wants it modelled"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/metrics.md", "a cross-source side that cannot exist yet", "record the formula on the measure that exists and an open question on the other model naming the missing column or view"],
  ["phases/metrics.md", "unstated formulas are open questions", "A formula the owner never stated is an open question, not a description"],
  ["phases/metrics.md", "a metric is approved on a recorded reply", "record the answer with `semlayer reply`, and on a yes run `semlayer approve --target metric:<name>`"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["phases/metrics.md", "a cross-source side with no model", "when that model does not exist yet, on the existing measure's model and among the handoff's cross-source questions"],
  // Schema exports and the baseline.
  ["phases/metrics.md", "metrics start from the baseline's ratios", "starting from the baseline's suggested ratios and shares"],
];

// Codes of the bridge-join checks (lib/validate-rules/join.ts) and the compiler's refusals of segments in a
// multi-fact request and of what a bridge join cannot share (spec: Bridges and multi-fact requests).
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "join.multi_fact_segments": {
    level: "error",
    meaning: "A request whose measures come from several models names segments; a request's segments narrow the one model of its measures, so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_aggregate_unsupported": {
    level: "error",
    meaning: "A request groups an avg, min, max or count_distinct measure by a bridge join's target under dedupe equal_split or weight; only a sum or a count can be shared among one row's target values, so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_bridge_unknown": {
    level: "error",
    meaning: "A bridge join names a bridge model that is not a model of the source, or is the join's own model or target.",
    next: "semlayer add-bridge",
  },
  "join.through_coarse_group": {
    level: "error",
    meaning: "A request groups a measure by a computed field of a bridge join's target under dedupe distinct_pairs; two target rows can give it one value, so a row of the model could count twice in one group, and semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_columns_missing": {
    level: "error",
    meaning: "A key or weight column of a bridge join is not a column of the bridge's or the target's table in the snapshot.",
    next: "semlayer add-bridge",
  },
  "join.through_dedupe_missing": {
    level: "error",
    meaning: "An approved bridge join has no dedupe rule: the owner has not said how a figure is shared among the values of one row.",
    next: "semlayer add-bridge",
  },
  "join.through_facts_unbridged": {
    level: "warning",
    meaning: "The bridge evidence of a bridge join shows rows of the model with no bridge row, so a figure grouped by the target shows them under an empty value or leaves them out, and the join is not approved on a readback that stated that count.",
    next: "semlayer readback",
  },
  "join.through_filter_ungrouped": {
    level: "error",
    meaning: "A request filters on a field its model reaches only through a bridge join without grouping by that field, which would count a row once for each matching target value, so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_relationship_invalid": {
    level: "error",
    meaning: "A bridge join says a relationship other than one_to_many, so the compiler would join the target as if it held the join's keys.",
    next: "semlayer add-bridge",
  },
  "join.through_second_path": {
    level: "error",
    meaning: "A request reaches fields through two bridge joins, which would count a row once for each pair of their values, so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_semi_additive": {
    level: "error",
    meaning: "A request groups a semi-additive measure (one with non_additive_dimension) by a bridge join's target; a kept balance is not shared among target values, so semlayer sql refuses it.",
    next: "semlayer sql",
  },
  "join.through_weight_invalid": {
    level: "error",
    meaning: "A bridge join's weight is set without dedupe weight, is missing under dedupe weight, or is not a numeric column of the bridge.",
    next: "semlayer add-bridge",
  },
};
export default codes;

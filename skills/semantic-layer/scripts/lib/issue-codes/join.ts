// Codes of the bridge-join checks (lib/validate-rules/join.ts; spec: Bridges and multi-fact requests).
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "join.through_bridge_unknown": {
    level: "error",
    meaning: "A bridge join names a bridge model that is not a model of the source, or is the join's own model or target.",
    next: "semlayer add-bridge",
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
    meaning: "The bridge evidence of a bridge join shows rows of the model with no bridge row, so a figure grouped by the target shows them under an empty value or leaves them out.",
    next: "semlayer check-join",
  },
  "join.through_relationship_invalid": {
    level: "error",
    meaning: "A bridge join says a relationship other than one_to_many, so the compiler would join the target as if it held the join's keys.",
    next: "semlayer add-bridge",
  },
  "join.through_weight_invalid": {
    level: "error",
    meaning: "A bridge join's weight is set without dedupe weight, is missing under dedupe weight, or is not a numeric column of the bridge.",
    next: "semlayer add-bridge",
  },
};
export default codes;

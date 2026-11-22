// Codes of the schema-scope checks (lib/validate-rules/scope.ts): joins across schemas, declared
// schema pairs and the primary schema (spec: Schema scope).
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "scope.cross_schema_undeclared": {
    level: "error",
    meaning: "A join crosses schemas on keys no approved schema pair declares; an approved join is a warning until the tool's next minor version.",
    next: "semlayer add-cross-schema",
  },
  "scope.key_not_in_snapshot": { level: "error", meaning: "A key of a schema pair names a table, column or constraint the snapshot does not have.", next: "semlayer remove-cross-schema" },
  "scope.primary_not_in_schemas": { level: "error", meaning: "intake.primary is not among the schemas intake.schemas reads.", next: "semlayer setup" },
  "scope.primary_unset": {
    level: "error",
    meaning: "The snapshot holds tables of more than one schema and the source names no primary schema, so draft refuses until the owner names one.",
    next: "semlayer setup",
  },
  "scope.pair_unused": { level: "warning", meaning: "An approved schema pair is crossed by no join of the layer.", next: "semlayer remove-cross-schema" },
};
export default codes;

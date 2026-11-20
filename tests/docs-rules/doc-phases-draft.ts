import type { DocRule } from "./index.ts";

// The procedure rules references/phases/draft.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Draft guesses and units.
  ["phases/draft.md", "exact cents on duckdb", "`<col> * 0.01` on duckdb"],
  // Keeping the layer current.
  ["phases/draft.md", "draft new columns", "`semlayer draft --source <s> --new-columns`"],
  ["phases/draft.md", "deliberate omissions in ignored_columns", "goes into the model's `ignored_columns`"],
  ["phases/draft.md", "draft records what it leaves out", "lists the columns it leaves out on purpose in the model's `ignored_columns`"],
  // Conditions, role unions and what draft tags.
  ["phases/draft.md", "near-unique text is left out, not tagged", "differs on nearly every row is left out, not tagged"],
  // Scope, profiles, new columns, pair tables.
  ["phases/draft.md", "new columns across models over one table", "A column is new only when no model over the same table reads it or lists it in `ignored_columns`"],
  // Heuristics.
  ["phases/draft.md", "status words new columns as without a field", "**Columns without a field** (`new_columns`)"],
];

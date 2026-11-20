import type { DocRule } from "./index.ts";

// The procedure rules references/joins.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["joins.md", "inferred covers matching values", "or from matching values"],
  ["joins.md", "YAML relationship wording", "YAML says many_to_one, data says many_to_one"],
  // Definition joins and access.
  ["joins.md", "definition joins ignore row filters", "the compiler joins it without the target's row filters"],
  ["joins.md", "joins are named after their target's role", "Name a join after the role its target plays"],
  ["joins.md", "renaming keeps evidence", "Renaming a join keeps its evidence"],
  ["joins.md", "stale evidence warns", "differ from the join's current `keys` or `to`"],
  // Who sees what is decided once, in the access phase (docs/PRD-hardening.md HR-9).
  ["joins.md", "a closure model needs no join", "the filtered model needs no join to it"],
  // Keeping the layer current.
  ["joins.md", "a changed key column is checked again", "including when a rerun of `semlayer introspect` shows a key column removed, renamed or retyped"],
  // Row filters through joins and child tables.
  ["joins.md", "row filters take join references", "a row filter in `access.yaml` reads through"],
  // Scope, profiles, new columns, pair tables.
  ["joins.md", "pair tables draft as keys", "a table of 2 or 3 columns whose names all end in `_id`"],
  // Approval hashes and join fan-out.
  ["joins.md", "fan-out overrides", "record the reason in their words on the join"],
  ["joins.md", "text keys are inferred", "text keys included (`order_lines.sku` to `products.sku`)"],
  // connection.views holds one table expression, so a rule needing an aggregate goes to engineering.
  ["joins.md", "a pre-aggregated model comes from engineering on DuckDB too", "which the owner's engineers create on every dialect"],
];

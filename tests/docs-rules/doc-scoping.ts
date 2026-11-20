import type { DocRule } from "./index.ts";

// The procedure rules references/scoping.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["scoping.md", "the combined suggested scope", "suggested_scope"],
  ["scoping.md", "unknown group row counts", "30,551+"],
  ["scoping.md", "tables can be added later, always", "Every first scoping message says that tables can be added later"],
  ["scoping.md", "exact names do not pick up new tables", "exact names do not pick up new tables"],
  ["scoping.md", "deferring a table", "## Deferring a table"],
  ["scoping.md", "deferral names the physical table", "Name the table as `semlayer tables` prints it, not the model name"],
  // Sources and scope.
  ["scoping.md", "duckdb views live in main", "are in schema `main`"],
  ["scoping.md", "re-preview unless the exact list was stated", "skip the new preview only when the owner stated the exact final list"],
  ["scoping.md", "tables --groups lists tables first", "It first lists the in-scope tables, then the groups"],
  // Keeping the layer current.
  ["scoping.md", "new tables after a rerun", "A rerun of `semlayer introspect` lists the tables added since the last snapshot"],
  // Scope, profiles, new columns, pair tables.
  ["scoping.md", "one named table is confirmed in one line", "a name-based scope does not pick up new tables"],
  ["scoping.md", "patterns still pick up new tables", "a new table that no pattern matches will need adding the same way"],
  // Heuristics.
  ["scoping.md", "one classifier for noise", "come from the same classifier `semlayer baseline` uses"],
];

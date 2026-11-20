import type { DocRule } from "./index.ts";

// The schema-scope rules the docs keep (workstream G): one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "the primary schema is never guessed", "With more than one candidate there is none, and the tools never guess one"],
  ["spec.md", "a name never joins across schemas in draft", "a column joins by its name (`<x>_id`, or the name of a single-column key) only to a table in the same schema"],
  ["spec.md", "a cross-schema foreign key is a question, not a join", "a declared foreign key into another schema drafts no join and adds one open question"],
  ["spec.md", "snapshots keep the constraint name", "A snapshot's foreign key keeps its constraint name"],
];

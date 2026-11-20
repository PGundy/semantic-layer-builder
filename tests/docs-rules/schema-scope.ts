import type { DocRule } from "./index.ts";

// The schema-scope rules the docs keep (workstream G): one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "the primary schema is never guessed", "With more than one candidate there is none, and the tools never guess one"],
  ["spec.md", "a name never joins across schemas in draft", "a column joins by its name (`<x>_id`, or the name of a single-column key) only to a table in the same schema"],
  ["spec.md", "a cross-schema foreign key is a question, not a join", "a declared foreign key into another schema drafts no join and adds one open question"],
  ["spec.md", "snapshots keep the constraint name", "A snapshot's foreign key keeps its constraint name"],
  ["spec.md", "the cross-schema question names add-cross-schema and --decline", "names `semlayer add-cross-schema` with the key for a yes and with `--decline` for a no"],
  ["spec.md", "a pair runs from the foreign key's schema", "Each runs from the schema holding the foreign key (`from`) to the schema it references (`to`)"],
  ["spec.md", "a join crosses only on an approved pair's keys", "is allowed only when the pair is approved and lists every key of the join"],
  ["spec.md", "the grace ends at the next minor version", "an error from then on"],
  ["spec.md", "the join commands and the compiler decide as validate does", "The join commands and the compiler decide by the same rule as validate"],
  ["spec.md", "add-join refuses a join across an undeclared pair", "`semlayer add-join` refuses a join across schemas no approved pair declares"],
  ["spec.md", "an approved pair drafts its listed keys only", "on those keys only, whether or not a foreign key carries them"],
];

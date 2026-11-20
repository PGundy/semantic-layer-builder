import type { DocRule } from "./index.ts";

// The bridge-join rules of references/spec.md, Bridges and multi-fact requests.
export const RULES: DocRule[] = [
  ["spec.md", "a bridge join carries the owner's dedupe rule", "`distinct_pairs` (each (row, target value) pair counts once), `equal_split` (each of n target values gets 1/n of the figure) or `weight`"],
  ["spec.md", "an approved bridge join needs the rule", "An approved bridge join (one with `through`) has a `through.dedupe` rule"],
  ["spec.md", "each hop of a bridge join obeys the schema-pair rule", "each obeys the schema-pair rule of Schema scope as a join of its own"],
  ["spec.md", "the compiler does not follow a bridge join yet", "`semlayer sql` refuses it as `no_join_path`, naming the bridge join"],
];

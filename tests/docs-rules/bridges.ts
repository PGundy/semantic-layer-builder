import type { DocRule } from "./index.ts";

// The bridge-join and multi-fact rules of references/spec.md, Bridges and multi-fact requests.
export const RULES: DocRule[] = [
  ["spec.md", "a bridge join carries the owner's dedupe rule", "`distinct_pairs` (each (row, target value) pair counts once), `equal_split` (each of n target values gets 1/n of the figure) or `weight`"],
  ["spec.md", "an approved bridge join needs the rule", "An approved bridge join (one with `through`) has a `through.dedupe` rule"],
  ["spec.md", "each hop of a bridge join obeys the schema-pair rule", "each obeys the schema-pair rule of Schema scope as a join of its own"],
  ["spec.md", "the compiler does not follow a bridge join yet", "`semlayer sql` refuses it as `no_join_path`, naming the bridge join"],
  ["spec.md", "check-join measures the bridge and writes its counts", "whose counts it writes under `evidence.through`"],
  ["spec.md", "bridge evidence holds counts only", "They are counts only, never a value of a table."],
  ["spec.md", "rows with no bridge row are a warning", "`semlayer validate` warns, `join.through_facts_unbridged`"],
  ["spec.md", "the bridge readback states the overlap", "says that totals by the target can add up to more than the overall total"],
  ["spec.md", "no bridge readback without the rule or the evidence", "so the owner never says yes to a bridge they were not shown"],
  ["spec.md", "a multi-fact request compiles one part per model", "It compiles in parts as a metric does (see Reference compiler): one CTE per model"],
  ["spec.md", "a multi-fact request never multiplies a total", "no part's rows are joined to another's, so neither total is multiplied"],
  ["spec.md", "a missing side is null, not 0", "null for a group its part has no rows for, never 0"],
  ["spec.md", "a dimension one model reaches is refused", "a dimension only one model reaches is refused, `no_shared_dimension`, naming the model, never cross joined"],
  ["spec.md", "a hidden part refuses the whole request", "refuses the whole request as `not_visible`, never a partial answer"],
  ["spec.md", "a multi-fact request takes no request segments", "a multi-fact request that names segments is refused, `join.multi_fact_segments`"],
  ["spec.md", "the grain shorthand reads the first measure", "A bare `:grain` field reads the default time dimension of the request's first measure, as in any request"],
  ["phases/joins.md", "the bridge interview asks for the dedupe rule", "ask the owner how a figure is shared among one row's values"],
  ["phases/joins.md", "the bridge readback is refused without the rule or the evidence", "`semlayer readback` refuses a bridge join without the rule or without that evidence"],
];

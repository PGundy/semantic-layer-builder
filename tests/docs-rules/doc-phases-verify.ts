import type { DocRule } from "./index.ts";

// The procedure rules references/phases/verify.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Status, verification and handoff.
  ["phases/verify.md", "coverage checklist at handoff", "Coverage is a checklist checked at handoff"],
  ["phases/verify.md", "golden requests list metrics in measures", "there is no `metrics` key"],
  // Review fixes.
  ["phases/verify.md", "coverage includes metrics and owner figures", "every approved measure and metric in at least one approved golden"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/verify.md", "a golden may pin a rule", "A golden may pin a rule rather than a figure"],
  ["phases/verify.md", "rule goldens request the trusted grain", "confirm its measured rows only when its `reference` says which rows were checked against a report; otherwise request only the trusted grain"],
  ["phases/verify.md", "approved golden with a draft field is rechecked", "then run `semlayer goldens check --name <g>`: if it passes, the recorded rows stand, and only changed rows need a new confirm"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["phases/verify.md", "every role needs a golden", "an approved golden that runs as each role in `access.yaml`, restricted or not (a golden with no `role` runs as `default_role`)"],
  ["phases/verify.md", "rounded ratios are agreed and written in reference", "show the unrounded value next to the report figure, agree with the owner that they match, and write the rounding in `reference`"],
  ["phases/verify.md", "tolerance guards drift, not rounding", "`tolerance` guards drift between runs, not rounding"],
  ["phases/verify.md", "whole numbers and grouped-by columns compare exactly", "whole numbers (counts, years) and the grouped-by columns always compare exactly"],
  // Goldens and access.
  ["phases/verify.md", "a gap to the report is not a tolerance", "agree any difference and write it in `reference`, then agree a tolerance for drift between runs"],
  ["phases/verify.md", "role goldens after access approval", "Confirm a golden that runs as a role after `access.yaml` is approved, or recheck it and read it back after every change to that role"],
  ["phases/verify.md", "a changed role or user is confirmed again", "changing `role` or `user` on an approved golden means confirming again on the owner's yes"],
  // Replacing a personal value, goldens under a draft access file, goldens without measures.
  ["phases/verify.md", "draft-access goldens stay valid", "one confirmed under a draft stays valid once access is approved when its role and user are unchanged and `semlayer goldens check` passes"],
  ["phases/verify.md", "a golden may have no measures", "a golden may have no measures, starting from its first dimension, which covers a row-filtered child model with no measures"],
  ["phases/verify.md", "row-filter joins without goldens in coverage", "`row_filter_joins_without_goldens` in status lists the gaps"],
  // Goldens are honest about what they test.
  ["phases/verify.md", "goldens compile the YAML", "`semlayer goldens check` compiles every approved golden's request from the current YAML"],
  ["phases/verify.md", "an approved edit fails its goldens", "fails every golden that uses it once the edit is approved again, and until then those goldens fail as refused"],
  ["phases/verify.md", "goldens are written with goldens new", "`semlayer goldens new --name <g> --question \"<question>\" --request <json>`"],
  ["phases/verify.md", "measures of several models combine on shared dimensions", "A request's measures may come from several models, each aggregated on its own and combined on the dimensions they share"],
];

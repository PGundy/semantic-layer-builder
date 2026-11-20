import type { DocRule } from "./index.ts";

// The procedure rules references/phases/handoff.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Status, verification and handoff.
  ["phases/handoff.md", "handoff names roles without goldens", "naming each role in `roles_without_goldens`"],
  ["phases/handoff.md", "removing a measure removes what uses it", "`semlayer remove-field` refuses while a draft metric or golden uses it, naming each, so change or remove those first"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/handoff.md", "handoff lists validate warnings", "every warning `semlayer validate` still prints, with the reason it stands"],
  ["phases/handoff.md", "handoff lists draft metrics and goldens", "every draft metric (`draft_metrics` in status), draft golden (`draft_goldens`) and draft field (`draft_fields`)"],
  ["phases/handoff.md", "done means the measurable phases", "`next_step` reaches `done` when the phases the CLI can measure are complete"],
  ["phases/handoff.md", "tick the checklist before the handoff", "Tick the coverage checklist, then give the owner the short summary below"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["phases/handoff.md", "handoff writes standing reasons into files", "Write that reason into the file the warning points at, so a resumed session leaves it"],
  // Goldens and access.
  ["phases/handoff.md", "the handoff says what applies to a draft access.yaml", "a draft `access.yaml`, saying what applies until it is approved"],
  ["phases/handoff.md", "N/A coverage lines in the handoff", "each line that does not apply, named N/A with the reason"],
  // Replacing a personal value, goldens under a draft access file, goldens without measures.
  ["phases/handoff.md", "the handoff names row-filter joins without goldens", "each entry of `row_filter_joins_without_goldens` from `semlayer status --json`"],
  // Handoff, suggestions, readbacks and resume.
  ["phases/handoff.md", "cross-source formulas in the handoff", "every cross-source metric's formula in words, with any figure the owner gave"],
  ["phases/handoff.md", "engineering waits tie to metrics", "each measure that waits on engineering (a missing column or view), tied to the metrics that need it"],
  ["phases/handoff.md", "the handoff names exceptions, not counts", "Name exceptions rather than counts: \"every detail except `products.launched_on`\""],
];

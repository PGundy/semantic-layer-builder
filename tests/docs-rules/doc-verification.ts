import type { DocRule } from "./index.ts";

// The procedure rules references/verification.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["verification.md", "goldens at any phase", "Draft goldens may be written at any phase"],
  ["verification.md", "explicit tolerance", "--tolerance 0"],
  ["verification.md", "--force only lifts the row limit", "`--force` lifts that limit and does nothing else"],
  ["verification.md", "request fields through to-one joins", "at most two hops"],
  ["verification.md", "confirm after measures are approved", "Confirm a golden only after the measures"],
  // Status, verification and handoff.
  ["verification.md", "coverage checklist", "### Coverage checklist, checked at handoff"],
  ["verification.md", "roles without goldens", "`roles_without_goldens` in `semlayer status --json`"],
  ["verification.md", "a golden pins definition joins for a restricted role", "definition joins apply whatever the role may see is pinned"],
  ["verification.md", "golden requests list metrics in measures", "there is no `metrics` key"],
  ["verification.md", "draft goldens may name unknown fields", "`semlayer validate` warns rather than errors"],
  ["verification.md", "golden SQL adds nothing", "no `round()` around a measure"],
  ["verification.md", "definition joins in golden SQL", "write two joins"],
  ["verification.md", "re-check after a revoke", "the recorded rows stand and no new confirm is needed"],
  ["verification.md", "goldens check needs every source", "Without `--source` it checks every source"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["verification.md", "a golden may pin a rule", "### A golden that pins a rule"],
  ["verification.md", "rule goldens request the trusted grain", "Otherwise request only the trusted grain"],
  ["verification.md", "round in golden SQL warns", "`semlayer validate` warns on `round(` in a golden's `cross_check_sql`"],
  ["verification.md", "approved golden with a draft field is rechecked", "approve the field after its readback, then run `semlayer goldens check --name <g>`: if it passes, the recorded rows stand; only rows that changed need a new confirm"],
  ["verification.md", "roles without goldens hold verify", "keeps `next_step` at `verify` until a golden that runs as that role is written and confirmed"],
  ["verification.md", "done does not tick the checklist", "it does not tick this list"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["verification.md", "a draft golden's missing measure is recorded", "Add an open question on the model that measure belongs to (`semlayer question add`), naming the golden"],
  ["verification.md", "a cast divisor is still a double on duckdb", "a cast divisor such as `/ 100::decimal(18, 2)` included"],
  ["verification.md", "every role needs a golden", "Every role in `access.yaml`, restricted or not, has at least one approved golden that runs as it"],
  ["verification.md", "rounded ratios are agreed and written in reference", "show the unrounded value next to the report figure, agree with the owner that they match, and write the rounding in `reference`"],
  ["verification.md", "tolerance guards drift, not rounding", "the tolerance guards drift between runs, not rounding"],
  ["verification.md", "tolerance covers figures with decimals", "The tolerance covers the golden's figures with decimals"],
  ["verification.md", "whole numbers and grouped-by columns compare exactly", "the columns the golden is grouped by always compare exactly, whatever the tolerance"],
  ["verification.md", "currency shows two decimals, display only", "shows measures with `format: currency` to two decimals; the recorded rows keep the full value"],
  ["verification.md", "fixing a warning on an approved item rechecks goldens", "After fixing a `semlayer validate` warning on an approved measure or golden"],
  // Who sees what is decided once, in the access phase (docs/PRD-hardening.md HR-9).
  ["verification.md", "a golden for span of control", "for a span-of-control row filter, one question as a manager"],
  ["verification.md", "a golden for each restriction", "for each restriction, one question as a role or user it allows"],
  // Keeping the layer current.
  ["verification.md", "goldens check after a schema change", "after a rerun of `semlayer introspect` that changed a modeled table"],
  // Restrictions, personal values.
  ["verification.md", "an allow.when golden needs no role", "a golden whose `user` holds the attribute"],
  // Goldens and access.
  ["verification.md", "role goldens after access approval", "Confirm a golden that runs as a role after `access.yaml` is approved"],
  ["verification.md", "a draft-access role golden is rechecked", "read back to the owner after every change to that role"],
  ["verification.md", "confirm records confirmed_as", "`confirmed_as: { role, user }`"],
  ["verification.md", "goldens without confirmed_as are confirmed again", "A golden approved before `confirmed_as` was recorded has none"],
  ["verification.md", "a gap to the report is not a tolerance", "is settled with the owner and written in `reference`; it is not a tolerance"],
  ["verification.md", "tolerance guards drift between runs", "agree the tolerance, which guards drift between later runs and the recorded rows"],
  ["verification.md", "a span-of-control golden names the id", "the golden's question naming the id, not the person"],
  ["verification.md", "validate checks goldens against access", "`semlayer validate` checks every golden's request against access as the user it runs as"],
  ["verification.md", "a changed role or user is confirmed again", "Changing `role` or `user` on an approved golden changes what it pins"],
  ["verification.md", "the row-filtered join line can be N/A", "The line is N/A, and named as such in the handoff with the reason, when no join the role may use reaches its row-filtered model"],
  // Warnings that never stand.
  ["verification.md", "round and literal division never stand", "Neither warning ever stands"],
  ["verification.md", "rounded rows fail until confirmed again", "Rows recorded rounded fail until the owner says yes to the unrounded figure"],
  // Profile privacy.
  ["verification.md", "personal values in goldens", "### Personal values in goldens"],
  ["verification.md", "expected rows are exempt", "A golden's `expected.rows` are exempt from the check: they are the answer as the golden's role, which may see the column"],
  // Replacing a personal value, goldens under a draft access file, goldens without measures.
  ["verification.md", "an id replacing a personal value needs no confirm", "Replacing a personal value with an id in an approved golden's `question` or `reference` changes no figure and needs no new confirm: edit it (`semlayer set golden:<g> reference` writes the `reference`) and run `semlayer goldens check`"],
  ["verification.md", "draft-access goldens stay valid", "such a golden stays valid, with no new confirm, when its `role` and `user` are unchanged and `semlayer goldens check` passes"],
  ["verification.md", "a golden may have no measures", "A golden may have no measures: it starts from its first dimension, which is how a row-filtered child model with no measures"],
  ["verification.md", "row-filter joins without goldens", "`row_filter_joins_without_goldens` in `semlayer status --json`"],
  // Goldens are honest about what they test.
  ["verification.md", "goldens run the compiler", "Goldens run the reference compiler (`spec.md`, Reference compiler)"],
  ["verification.md", "cross_check_sql disagreement is named", "requires both to give the recorded rows and names the one that differs"],
  ["verification.md", "keeping the SQL in step", "### Keeping the SQL in step with the YAML"],
  ["verification.md", "the rule warning", "this hand-written SQL may not apply <measure>'s rule"],
  ["verification.md", "measures of several models combine on shared dimensions", "aggregates each model on its own and combines them on the dimensions they share, so neither total repeats across the other's rows"],
  ["verification.md", "drift checks compile the YAML", "It compiles every approved golden's request from the current YAML"],
  // Time zones per type and dialect.
  ["verification.md", "golden SQL converts per type", "with the conversion its column's type needs"],
];

import type { DocRule } from "./index.ts";

// The procedure rules references/phases/interview.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["phases/interview.md", "deferral leaves scope", "semlayer scope --source <s> --exclude <table> --write"],
  ["phases/interview.md", "joins a join reference uses are checked first", "Check and read back any join a join reference uses (`phases/joins.md`) before reading back that measure or dimension"],
  ["phases/interview.md", "deferral names the table as semlayer tables prints it", "naming the table as `semlayer tables` prints it"],
  // Readbacks, figures and owner time.
  ["phases/interview.md", "an agreed rule is asked of the other measures", "ask in the same round trip whether it applies to the model's other measures"],
  ["phases/interview.md", "owner priorities override next_batch", "Owner priorities override it"],
  ["phases/interview.md", "status for the source the owner put first", "`semlayer status --source <s> --json` for the source the owner put first"],
  // Definition joins and access.
  ["phases/interview.md", "definition joins apply whatever the role", "it applies whatever the role may see, without row filters"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/interview.md", "engineering only when no construct expresses the rule", "Ask engineering for a column or view only when no supported construct (a join reference within two hops, or a filter that writes the rule out) can express the rule"],
  ["phases/interview.md", "otherwise wait for the tool", "wait for the tool and say so"],
  ["phases/interview.md", "removing a drafted field", "**Removing a drafted field** is `semlayer remove-field <s>.<m>.<field>`. It refuses while a metric, a golden or a restriction names the field, listing each"],
  ["phases/interview.md", "an approved field is removed only on a yes, with --force", "An approved field or join is removed only on the owner's yes, with `--force`."],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["phases/interview.md", "waiting for the tool is recorded", "write in the field's `description` why its warning stands"],
  // Who sees what is decided once, in the access phase (docs/PRD-hardening.md HR-9).
  ["phases/interview.md", "a table readback states who sees it and does not ask", "The readback states who will see the table once it is approved, and does not ask"],
  ["phases/interview.md", "a who-sees change is recorded as about access", "--verdict change --about access"],
  // Draft and approved access.
  ["phases/interview.md", "table readbacks during an access rewrite", "While `access.yaml` is being rewritten, the readback says who will see the table under the draft file"],
  // Time zones per type and dialect.
  ["phases/interview.md", "the stored zone is asked", "which zone its values are recorded in (`time_zone`"],
  // Heuristics.
  ["phases/interview.md", "a removed field's column is ignored", "It adds its column to the model's `ignored_columns` in the same edit"],
  // connection.views holds one table expression, so a rule needing an aggregate goes to engineering.
  ["phases/interview.md", "an aggregate needs the owner's engineers on every dialect", "needs a table or view the owner's engineers create, on every dialect"],
];

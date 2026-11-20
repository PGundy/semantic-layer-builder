import type { DocRule } from "./index.ts";

// The procedure rules references/phases/joins.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/joins.md", "a join is approved on a recorded reply", "record the owner's answer with `semlayer reply`, and on a yes approve it with `semlayer approve --target <s>.<m>.<j>`"],
  // Approval hashes and join fan-out.
  ["phases/joins.md", "fan-out overrides", "record their reason as `fanout_override: \"<reason>\"` on the join"],
];

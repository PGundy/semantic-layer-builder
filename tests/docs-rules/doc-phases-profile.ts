import type { DocRule } from "./index.ts";

// The procedure rules references/phases/profile.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Scope, profiles, new columns, pair tables.
  ["phases/profile.md", "profile state", "`yes`, `partial` (some columns profiled, but new or retyped ones not) or `no`"],
  // Profile privacy.
  ["phases/profile.md", "protected columns keep counts only", "keeps counts only: its null fraction and distinct count, and a min and max only for numbers and dates; its top values are not stored, not even hashed"],
  ["phases/profile.md", "protection is a heuristic; snapshots are reviewed", "The name rules are a heuristic: tell the owner to review `snapshots/` before committing them"],
  ["phases/profile.md", "redact after tagging", "after tagging a column already profiled, run `semlayer profile --source <s> --redact`"],
];

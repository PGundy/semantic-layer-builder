import type { DocRule } from "./index.ts";

// The procedure rules references/phases/scope.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Schema exports and the baseline.
  ["phases/scope.md", "scoping uses the baseline", "alongside the baseline's star-schema sketch and its noise and staging guesses"],
];

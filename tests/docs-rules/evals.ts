import type { DocRule } from "./index.ts";

// The eval harness rules of references/spec.md, Eval runs.
export const RULES: DocRule[] = [
  ["spec.md", "validate grader scores the final root", "**validate.** The final `semantic/` root passes validation"],
  ["spec.md", "validate grader lists issue codes", "with the issue `code` of `scripts/lib/issue-codes/`"],
];

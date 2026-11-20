import type { DocRule } from "./index.ts";

// The eval harness rules of references/spec.md, Eval runs.
export const RULES: DocRule[] = [
  ["spec.md", "validate grader scores the final root", "**validate.** The final `semantic/` root passes validation"],
  ["spec.md", "validate grader lists issue codes", "with the issue `code` of `scripts/lib/issue-codes/`"],
  ["spec.md", "smoke runs the PostgreSQL scenario only with its URL", "and `acme-pg-structured` when its URL variable (`PG_URL`) is set"],
  ["spec.md", "smoke does not compare a scenario it could not run", "is reported as not run, with the reason and the variable to set, is not compared, and keeps its baseline entry"],
];

import type { DocRule } from "./index.ts";

// The eval harness rules of references/spec.md, Eval runs.
export const RULES: DocRule[] = [
  ["spec.md", "validate grader scores the final root", "**validate.** The final `semantic/` root passes validation"],
  ["spec.md", "validate grader lists issue codes", "with the issue `code` of `scripts/lib/issue-codes/`"],
  ["spec.md", "smoke runs the PostgreSQL scenario only with its URL", "and `acme-pg-structured` and `acme-noisy-200` when their URL variable (`PG_URL`) is set"],
  ["spec.md", "smoke does not compare a scenario it could not run", "is reported as not run, with the reason and the variable to set, is not compared, and keeps its baseline entry"],
  ["spec.md", "the live gate compares with the sdk baseline", "`bun evals/smoke.ts --gate` is the pass or fail form of the comparison for live runs"],
  ["spec.md", "the live gate runs nothing without a key, package or baseline", "Before it creates a run directory or builds a driver it checks that the SDK package can be imported"],
  ["spec.md", "the live gate is not a required check", "is not a required check, and ends green with a notice when the key secret or the baseline is absent"],
];

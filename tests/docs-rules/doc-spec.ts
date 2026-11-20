import type { DocRule } from "./index.ts";

// The procedure rules references/spec.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // The SELECT-only role.
  ["spec.md", "reply --approve queries before it takes the lock", "`goldens confirm`, `reply --approve`, which confirms goldens, `setup`"],
  ["spec.md", "commands that take no lock include the role SQL and demo", "`setup --print-role-sql`. `demo` makes a new root and takes no lock on the current one."],
  ["spec.md", "BigQuery datasets are identifiers", "BigQuery: each dataset as a backtick-quoted identifier in its per-dataset block, and a name holding a backtick is refused"],
];

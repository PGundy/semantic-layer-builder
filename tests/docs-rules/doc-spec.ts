import type { DocRule } from "./index.ts";

// The procedure rules references/spec.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // The SELECT-only role.
  ["spec.md", "reply --approve queries before it takes the lock", "`goldens confirm`, `reply --approve`, which confirms goldens, `setup`"],
  ["spec.md", "commands that take no lock include the role SQL and demo", "`setup --print-role-sql`. `demo` makes a new root and takes no lock on the current one."],
  // Descriptions inside the approval hash.
  ["spec.md", "a description is part of an approval", "the `description` of a dimension, measure, join, model or metric (left out when unset or empty, so an item without one hashes as before descriptions counted)"],
  ["spec.md", "reflowing a description is no change", "every run of whitespace, line breaks included, is one space, so reflowing a block scalar or changing its indentation changes nothing"],
  ["spec.md", "approvals from before descriptions counted still count", "It counts as approved: the evaluator, the compiler and the golden checks treat it as current"],
  // An approval counts only with the owner's recorded yes.
  ["spec.md", "approved means the file, the hash and the owner's recorded yes", "an item is approved when its file says so, its hash matches its content (see Approval hashes), and the owner's latest answer to it in the ledger is a yes to it as it stands"],
  ["spec.md", "a project with no ledger keeps its approvals and is told once", "A project with no ledger at all (no `.semlayer/ledger.jsonl`, or an empty one) is read under the rule for approvals given before the ledger"],
  ["spec.md", "a stamp no yes backs is a draft whatever its date", "an item stamped approved that neither backs is a draft for every purpose, whatever its `approved_at`"],
  ["spec.md", "the owner's confirmation never runs inside apply", "It records the owner's answer, so `semlayer apply` never runs it"],
  ["spec.md", "BigQuery datasets are identifiers", "BigQuery: each dataset as a backtick-quoted identifier in its per-dataset block, and a name holding a backtick is refused"],
];

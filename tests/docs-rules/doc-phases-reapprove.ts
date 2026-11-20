import type { DocRule } from "./index.ts";

// The procedure rules references/phases/reapprove.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Approval hashes and join fan-out.
  ["phases/reapprove.md", "approvals record a hash", "`semlayer approve` records `approved_hash`"],
  ["phases/reapprove.md", "a changed approved item is read back", "never approve to clear the error"],
  ["phases/reapprove.md", "stamping hashes keeps the approver", "which records the hashes and keeps `approved_by` and `approved_at`"],
];

import type { DocRule } from "./index.ts";

// The procedure rules references/phases/reapprove.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Approval hashes and join fan-out.
  ["phases/reapprove.md", "approvals record a hash", "`semlayer approve` records `approved_hash`"],
  ["phases/reapprove.md", "a changed approved item is read back", "never approve to clear the error"],
  ["phases/reapprove.md", "stamping hashes keeps the approver", "which records the hashes and keeps `approved_by` and `approved_at`"],
  ["phases/reapprove.md", "a description is part of the approval", "and the item's description, since that is what a reader learns the figure means"],
  ["phases/reapprove.md", "approvals from before descriptions counted are brought forward on the owner's check", "`semlayer approve --stamp-hashes --confirm-unchanged`, which records each hash with its description as it stands"],
];

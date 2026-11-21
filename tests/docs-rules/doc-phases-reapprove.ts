import type { DocRule } from "./index.ts";

// The procedure rules references/phases/reapprove.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Approval hashes and join fan-out.
  ["phases/reapprove.md", "approvals record a hash", "`semlayer approve` records `approved_hash`"],
  ["phases/reapprove.md", "a changed approved item is read back", "never approve to clear the error"],
  ["phases/reapprove.md", "stamping hashes keeps the approver", "which records the hashes and keeps `approved_by` and `approved_at`"],
  ["phases/reapprove.md", "a description is part of the approval", "and the item's description, since that is what a reader learns the figure means"],
  ["phases/reapprove.md", "approvals from before descriptions counted are brought forward on the owner's check", "`semlayer approve --stamp-hashes --confirm-unchanged`, which records each hash with its description as it stands"],
  // An approval counts only with the owner's recorded yes.
  ["phases/reapprove.md", "a stamp with no recorded yes is a draft", "An approval counts only while the owner's yes to the item as it stands is in `.semlayer/ledger.jsonl`"],
  ["phases/reapprove.md", "earlier approvals are confirmed only on the owner's say-so", "Only when the owner says approvals given before the ledger stand as they are, run `semlayer approve --confirm-existing"],
];

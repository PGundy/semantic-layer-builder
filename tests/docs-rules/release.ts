import type { DocRule } from "./index.ts";

// The rules of iterating a layer (workstream H) the docs keep: one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "introspect keeps a drift record", "`semlayer introspect` keeps `.semlayer/drift.json`"],
  ["spec.md", "a retype stays open until the field is edited or approved again", "until the field is edited (its content hash changes) or approved again (a newer yes from the owner in the ledger)"],
  ["spec.md", "an unreadable table is told apart from a dropped one", "`unreadable` names those of them the database still holds but the role cannot read"],
  ["spec.md", "the record holds no value", "never a data value"],
  ["spec.md", "a failed introspect leaves the record", "A failed introspect leaves the record as it was"],
];

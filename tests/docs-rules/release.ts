import type { DocRule } from "./index.ts";

// The rules of iterating a layer (workstream H) the docs keep: one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "introspect keeps a drift record", "`semlayer introspect` keeps `.semlayer/drift.json`"],
  ["spec.md", "a retype stays open until the field is edited or approved again", "until the field is edited (its content hash changes) or approved again (a newer yes from the owner in the ledger)"],
  ["spec.md", "an unreadable table is told apart from a dropped one", "`unreadable` names those of them the database still holds but the role cannot read"],
  ["spec.md", "the record holds no value", "never a data value"],
  ["spec.md", "a failed introspect leaves the record", "A failed introspect leaves the record as it was"],
  ["spec.md", "the changelog is append-only", "Append-only. `appendEntry`"],
  ["spec.md", "a version must rise", "refuses a version that is not above the last entry's"],
  ["spec.md", "golden rows are recorded as the golden stores them", "Golden rows are recorded as the golden file stores them"],
  ["spec.md", "the hook refuses a hand edit of the changelog", "write `changelog.yaml`: it is append-only"],
  ["spec.md", "a never-released layer gets no message", "A layer with neither has never been released"],
  ["spec.md", "change status compares with the last release", "`semlayer change status` compares the layer as it stands with the last entry of `changelog.yaml`"],
  ["spec.md", "change status names the first release when there is none", "naming `semlayer change close --version 1.0`"],
  ["spec.md", "change status holds no data value", "The output holds refs, hashes and names, never a data value"],
];

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
  // The change round (H3).
  ["spec.md", "a second start is refused", "A second `change start` while the file exists is refused"],
  ["spec.md", "a layer is released before it is changed", "A layer is released first and changed after"],
  ["spec.md", "the hook refuses a hand edit of the open round", "write `.semlayer/change.json`: only `semlayer change start` writes it"],
  ["spec.md", "the round's file holds no data value", "never a data value or a connection detail"],
  ["spec.md", "a round replaces only done", "phase `change` replaces only `done`"],
  ["spec.md", "a finished layer is led to its first release or to a round", "with no changelog, recording the first release"],
  ["phases/change.md", "the card opens with its load line", "Load this card when `semlayer next` names phase `change`."],
  ["phases/change.md", "change only what was asked", "Make the edits the request needs and nothing else"],
  ["phases/change.md", "read back only items that changed", "Read back only the items that changed or were added, never the whole layer"],
  ["phases/change.md", "a changed approved item is a draft until the owner's yes", "A changed approved item goes back to draft, and stays draft until the owner's recorded yes"],
  ["phases/change.md", "the first release comes before any round", "A layer is released once, then changed in rounds"],
  ["phases/change.md", "start the round before the first edit", "Start the round before the first edit"],
  ["SKILL.md", "phase change routes to its card", "| `change` | `references/phases/change.md` |"],
  ["SKILL.md", "a change is a round that edits only what was asked", "an approved item you change is a draft until their recorded yes"],
];

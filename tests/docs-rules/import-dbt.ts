import type { DocRule } from "./index.ts";

// The rules of references/spec.md, dbt semantic import, and the two phase cards that name them.
export const RULES: DocRule[] = [
  ["spec.md", "--emit writes the edits file and nothing else", "It writes that file and nothing else: no layer file changes"],
  ["spec.md", "the emitted path is a new file inside the root, outside the layer", "must lie inside the semantic root as `baseline --out` must"],
  ["spec.md", "every emitted entry is a draft, never approved for the owner", "Every entry creates a draft; nothing here approves, confirms or answers for the owner"],
  ["spec.md", "an imported join is inferred", "An imported join carries origin `inferred`, so `check-join` and the owner's readback still gate it"],
  ["spec.md", "an undrafted model is listed with the draft command", "is listed, with `semlayer draft --source <s> --tables <table>` to run first"],
  ["spec.md", "a name already in the layer is left as it is", "so a second run emits nothing"],
  ["spec.md", "a manifest name passes the name rule", "A name becomes a field, join or metric name only if it matches `^[a-z][a-z0-9_]*$`"],
  ["spec.md", "an expr passes the role text check before it is emitted", "never emitted for `apply` to refuse"],
  ["spec.md", "a skipped filter skips the whole measure", "A skipped filter skips the whole measure, never leaving it unfiltered"],
  ["spec.md", "a join across an unapproved pair is listed with the pair commands", "`semlayer add-cross-schema` and the owner's approval of the pair"],
  ["phases/intake.md", "the manifest's semantic models come in through emit and apply", "--semantic --emit edits.json"],
  ["phases/intake.md", "imported items stay drafts until the owner's yes", "every item stays a draft"],
  ["phases/joins.md", "an imported join is checked before the owner is asked", "An imported join (origin `inferred`, described as from the dbt manifest)"],
];

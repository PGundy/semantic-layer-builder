import type { DocRule } from "./index.ts";

// The issue-code rules of SKILL.md and references/spec.md, Codes and errors.
export const RULES: DocRule[] = [
  ["SKILL.md", "branch on code and next, not text", "**Branch on `code` and `next`, not on text.**"],
  ["SKILL.md", "the code list is a command", "`semlayer validate --codes` lists the codes"],
  ["spec.md", "the prefix is the family", "the prefix is the family, whatever the file that registers it is called"],
  ["spec.md", "the code list is a command, not a table", "This section carries no table of codes, so the command is the list."],
  ["spec.md", "a code is added or retired, never renamed or reused", "A code is added or retired, never renamed or reused"],
  ["spec.md", "the metric family", "- `metric.*`: segments, the default time dimension, semi-additive measures and a golden's trailing window"],
  ["spec.md", "the join family", "- `join.*`: bridge joins, their dedupe rule and their evidence"],
  ["spec.md", "the release family", "- `release.*`: retyped columns in the drift record, `changelog.yaml` and `layer_version`"],
  ["spec.md", "--codes reads no layer", "It reads no layer and needs no `--root`."],
  ["spec.md", "the error envelope", "`{ \"error\": \"<message>\", \"code\": \"<code>\", \"next\": \"<command>\"? }`"],
];

import type { DocRule } from "./index.ts";

// The procedure rules references/phases/drift.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Keeping the layer current.
  ["phases/drift.md", "keeping the layer current", "# Phase card: drift, keeping the layer current"],
  ["phases/drift.md", "rerun introspect on a schedule", "on a schedule the owner picks"],
  ["phases/drift.md", "missing columns first", "**Missing columns first**"],
  // Conditions, role unions and what draft tags.
  ["phases/drift.md", "a retype is recorded as an open question", "changed from <from> to <to> on <date>; read back <fields>"],
];

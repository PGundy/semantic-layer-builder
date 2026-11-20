import type { DocRule } from "./index.ts";

// The procedure rules references/phases/drift.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Keeping the layer current.
  ["phases/drift.md", "keeping the layer current", "# Phase card: drift, keeping the layer current"],
  ["phases/drift.md", "rerun introspect on a schedule", "on a schedule the owner picks"],
  ["phases/drift.md", "missing columns first", "**Missing columns first**"],
  // A retyped column an approved field reads is warned until the field is edited or approved again.
  ["phases/drift.md", "a retype is warned on the field that reads it", "`semlayer validate` warns `release.column_retyped` on that field"],
];

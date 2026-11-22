import type { DocRule } from "./index.ts";

// The procedure rules references/phases/access.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  // Definition joins and access.
  ["phases/access.md", "comment-only edits need no new readback", "a comment-only edit is not a change"],
  // Review fixes.
  ["phases/access.md", "row-filtered targets of a dimension do not warn", "A dimension that reads a model the role row-filters shows every row's value and validate does not warn"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["phases/access.md", "open-question edits need no re-approval", "neither is deleting an answered open question or adding one, which you mention in the next message"],
  ["phases/access.md", "access is approved on a recorded reply", "record the answers and approve in one `semlayer reply --readback <id> --answers - --approve`; it approves the file only on a yes to the whole file"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["phases/access.md", "writing an answer into a role is a change", "writing its answer into roles, patterns, denials or row filters is a change"],
  // Who sees what is decided once, in the access phase (docs/PRD-hardening.md HR-9).
  ["phases/access.md", "who-sees changes come back in the access phase", "`semlayer next` lists those changes in this phase (`access_changes`"],
  ["phases/access.md", "every access rule has a command", "Every rule has a command; never edit `access.yaml` by hand"],
  ["phases/access.md", "access is open by default", "Access is open by default"],
  ["phases/access.md", "the exceptions question", "is there anything some people should not see?"],
  ["phases/access.md", "semlayer access in the readback", "Show the owner what people see with `semlayer access` (the default audience)"],
  ["phases/access.md", "row filters union across roles", "a held role with no filter on a model contributes every row"],
  ["phases/access.md", "default role asked open", "ask it open"],
  // Draft and approved access.
  ["phases/access.md", "tools serve only approved access", "Tools serve only an approved `access.yaml`"],
  ["phases/access.md", "a revoke says what applies", "the last approved version keeps applying where it is deployed until the new one is approved"],
  ["phases/access.md", "mode changes name who gains or loses", "state the old and new mode and who gains or loses visibility, naming the users who hold no role"],
  ["phases/access.md", "open questions block a draft's next step", "`{ phase: access, blocked_on: open_questions, command: semlayer access, after_owner_yes: false }`"],
  // Row filters through joins and child tables.
  ["phases/access.md", "row filters read through to-one joins", "A row filter's `expr` and a hierarchy's `column` may read join references"],
  ["phases/access.md", "child tables in the interview", "For each row-filtered model, list every model with a to-one join into it"],
  // Restrictions, personal values.
  ["phases/access.md", "prefer allow.when", "preferring a restriction's `allow.when` to a role made only to be named in `allow.roles`"],
  // Handoff, suggestions, readbacks and resume.
  ["phases/access.md", "the access readback is the whole file, and a no about any role voids its yes", "`semlayer readback` takes `access` and no single role. Walk the owner through each role in that readback, with its `semlayer access` view; a no or correction about any role voids the whole-file yes"],
  // Revoke keeps the last approval; semlayer access wording.
  ["phases/access.md", "an edit of an approved file keeps the sign-off", "makes it a draft again in the same write and keeps its sign-off as `last_approved`"],
];

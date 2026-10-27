import type { CommandSpec } from "../lib/command.ts";

// Commands load lazily so a broken or slow module never affects the others.
export const COMMANDS: Record<string, () => Promise<{ default: CommandSpec }>> = {
  init: () => import("./init.ts"),
  "add-source": () => import("./add-source.ts"),
  introspect: () => import("./introspect.ts"),
  import: () => import("./import.ts"),
  tables: () => import("./tables.ts"),
  scope: () => import("./scope.ts"),
  profile: () => import("./profile.ts"),
  draft: () => import("./draft.ts"),
  "check-join": () => import("./check-join.ts"),
  approve: () => import("./approve.ts"),
  validate: () => import("./validate.ts"),
  status: () => import("./status.ts"),
  run: () => import("./run.ts"),
  goldens: () => import("./goldens.ts"),
  access: () => import("./access.ts"),
};

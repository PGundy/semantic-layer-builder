import { READBACK_NEXT, accessEditLines, removeEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { UserError } from "../lib/errors.ts";

const spec: CommandSpec = {
  summary: "Remove a role from access.yaml, refusing while a restriction, default_role or golden names it.",
  usage: "remove-role <name>",
  options: {},
  positionals: true,
  writes: "whole",
  async run({ positionals }, ctx) {
    loadProject(ctx.root);
    if (positionals.length !== 1) throw new UserError("Usage: sl remove-role <name>.");
    const o = removeEntry(ctx.root, "role", positionals[0]);
    if (ctx.json) ctx.out(formatJson({ ...o, role: o.name }));
    else ctx.out([`Removed role ${o.name} from ${o.file}.`, ...accessEditLines(o, `sl access shows what its holders see without it; ${READBACK_NEXT}`)].join("\n"));
    return 0;
  },
};
export default spec;

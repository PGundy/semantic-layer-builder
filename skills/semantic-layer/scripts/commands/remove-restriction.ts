import { READBACK_NEXT, accessEditLines, removeEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { UserError } from "../lib/errors.ts";

const spec: CommandSpec = {
  summary: "Remove a restriction from access.yaml, so its targets are no longer limited by it.",
  usage: "remove-restriction <name>",
  options: {},
  positionals: true,
  writes: "whole",
  async run({ positionals }, ctx) {
    loadProject(ctx.root);
    if (positionals.length !== 1) throw new UserError("Usage: sl remove-restriction <name>.");
    const o = removeEntry(ctx.root, "restriction", positionals[0]);
    if (ctx.json) ctx.out(formatJson({ ...o, restriction: o.name }));
    else ctx.out([`Removed restriction ${o.name} from ${o.file}.`, ...accessEditLines(o, `sl access shows what the default audience sees again; ${READBACK_NEXT}`)].join("\n"));
    return 0;
  },
};
export default spec;

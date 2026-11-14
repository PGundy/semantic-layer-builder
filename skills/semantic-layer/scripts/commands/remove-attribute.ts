import { READBACK_NEXT, accessEditLines, removeEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { UserError } from "../lib/errors.ts";

const spec: CommandSpec = {
  summary: "Remove a user attribute from access.yaml, refusing while a condition, row filter or golden reads it.",
  usage: "remove-attribute <name>",
  options: {},
  positionals: true,
  writes: "whole",
  async run({ positionals }, ctx) {
    loadProject(ctx.root);
    if (positionals.length !== 1) throw new UserError("Usage: sl remove-attribute <name>.");
    const o = removeEntry(ctx.root, "attribute", positionals[0]);
    if (ctx.json) ctx.out(formatJson({ ...o, attribute: o.name }));
    else ctx.out([`Removed user attribute ${o.name} from ${o.file}.`, ...accessEditLines(o, `sl access shows what people see; ${READBACK_NEXT}`)].join("\n"));
    return 0;
  },
};
export default spec;

import { READBACK_NEXT, accessEditLines, removeRowFilter } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const spec: CommandSpec = {
  summary: "Remove a role's row filter on a model from access.yaml.",
  usage: "remove-row-filter --role <r> --model <source.model> [--index <n>]\n\n--index picks one when the role has several row filters on the model; without it they are listed.",
  options: { role: { type: "string" }, model: { type: "string" }, index: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const o = removeRowFilter(ctx.root, { role: str(values, "role"), model: str(values, "model"), index: str(values, "index") });
    const role = str(values, "role")!.trim();
    if (ctx.json) ctx.out(formatJson({ ...o, role }));
    else
      ctx.out(
        [`Removed a row filter on ${o.filter.model} from role ${role} in ${o.file}.`, ...accessEditLines(o, `sl access --roles ${role} shows what it sees; ${READBACK_NEXT}`)].join("\n"),
      );
    return 0;
  },
};
export default spec;

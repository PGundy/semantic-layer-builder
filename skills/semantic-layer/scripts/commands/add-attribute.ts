import { ATTRIBUTE_TYPES, accessEditLines, addEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const spec: CommandSpec = {
  summary: "Declare a user attribute in access.yaml, for conditions and row filters to read.",
  usage:
    `add-attribute --name <n> --type ${ATTRIBUTE_TYPES.join("|")} [--description <text>]\n\n` +
    "A condition reads it as user.<n>, a row filter as {{ user.<n> }}. A _list type holds several values.",
  options: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const o = addEntry(ctx.root, "attribute", str(values, "name"), { type: str(values, "type"), description: str(values, "description") });
    if (ctx.json) ctx.out(formatJson({ ...o, attribute: o.entry.name }));
    else
      ctx.out(
        [
          `Added user attribute ${o.entry.name} (${o.entry.type}) to ${o.file}.`,
          ...accessEditLines(o, `read it in a condition as user.${o.entry.name} (sl add-role --name <role> --assign-when "<condition>") or in a row filter as {{ user.${o.entry.name} }} (sl add-row-filter).`),
        ].join("\n"),
      );
    return 0;
  },
};
export default spec;

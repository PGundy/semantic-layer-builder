import { CONDITION_HELP, READBACK_NEXT, accessEditLines, addEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const spec: CommandSpec = {
  summary: "Add a restriction to access.yaml: metrics, models or fields only some roles or users may see.",
  usage:
    "add-restriction --name <n> --targets <ref>,... (--roles <role>,... | --when <condition>) [--description <text>]\n\n" +
    "A target is metric:<name>, source.model or source.model.field, with * globs (metric:finance_*, warehouse.payroll.*);\n" +
    "one that matches nothing is refused. The targets are visible only to holders of --roles or users for whom --when holds.\n" +
    CONDITION_HELP,
  options: {
    name: { type: "string" },
    targets: { type: "string", multiple: true },
    roles: { type: "string", multiple: true },
    when: { type: "string" },
    description: { type: "string" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const o = addEntry(ctx.root, "restriction", str(values, "name"), {
      description: str(values, "description"),
      targets: list(values, "targets"),
      "allow.roles": list(values, "roles"),
      "allow.when": str(values, "when"),
    });
    if (ctx.json) ctx.out(formatJson({ ...o, restriction: o.entry.name }));
    else ctx.out([`Added restriction ${o.entry.name} to ${o.file}.`, ...accessEditLines(o, `sl access shows what the default audience no longer sees; ${READBACK_NEXT}`)].join("\n"));
    return 0;
  },
};
export default spec;

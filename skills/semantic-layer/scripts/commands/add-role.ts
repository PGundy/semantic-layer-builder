import { CONDITION_HELP, READBACK_NEXT, accessEditLines, addEntry } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const LISTS = ["allow-models", "allow-tags", "deny-models", "deny-fields", "deny-tags"] as const;

const spec: CommandSpec = {
  summary: "Add a role to access.yaml: who holds it, and what it grants and denies.",
  usage:
    "add-role --name <n> [--description <text>] [--assign-when <condition>] [--allow-tags pii,sensitive] [--allow-models <pattern>,...]\n" +
    "       [--deny-models <pattern>,...] [--deny-fields <source.model.field>,...] [--deny-tags <tag>,...]\n\n" +
    `${CONDITION_HELP}\n` +
    "Every attribute a condition reads is declared first (sl add-attribute). --allow-models is the allowlist of closed mode.\n" +
    "Row filters are added to the role with sl add-row-filter; one key is changed with sl set access role:<n> <key> <value>.",
  options: {
    name: { type: "string" },
    description: { type: "string" },
    "assign-when": { type: "string" },
    ...(Object.fromEntries(LISTS.map((f) => [f, { type: "string", multiple: true }])) as Record<(typeof LISTS)[number], { type: "string"; multiple: true }>),
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const o = addEntry(ctx.root, "role", str(values, "name"), {
      description: str(values, "description"),
      assign_when: str(values, "assign-when"),
      ...Object.fromEntries(LISTS.map((f) => [f.replace("-", "."), list(values, f)])),
    });
    if (ctx.json) ctx.out(formatJson({ ...o, role: o.entry.name }));
    else ctx.out([`Added role ${o.entry.name} to ${o.file}.`, ...accessEditLines(o, `sl access --roles ${o.entry.name} shows what it sees; ${READBACK_NEXT}`)].join("\n"));
    return 0;
  },
};
export default spec;

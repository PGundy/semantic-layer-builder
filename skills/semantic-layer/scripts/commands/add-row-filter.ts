import { READBACK_NEXT, accessEditLines, addRowFilter } from "../lib/access-edit.ts";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const spec: CommandSpec = {
  summary: "Add a row filter to a role in access.yaml: the rows of a model its holders see.",
  usage:
    "add-row-filter --role <r> --model <source.model> --expr <sql predicate>\n" +
    "       sl add-row-filter --role <r> --model <source.model> --column <c> --via <source.model> --manager <c> --member <c> --user <attribute> [--exclude-self]\n\n" +
    "--expr reads the model's columns and <join>.<column> through its to-one joins; {{ user.<attribute> }} binds the user's value:\n" +
    '  --expr "region = {{ user.region }}"\n' +
    "The second form is a span of control: rows whose --column is the user's own id (--user, unless --exclude-self) or the id of\n" +
    "anyone below them in the closure model --via, which holds one row per --manager and --member pair at any depth.",
  options: {
    role: { type: "string" },
    model: { type: "string" },
    expr: { type: "string" },
    column: { type: "string" },
    via: { type: "string" },
    manager: { type: "string" },
    member: { type: "string" },
    user: { type: "string" },
    "exclude-self": { type: "boolean" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const text = (k: string) => str(values, k);
    const o = addRowFilter(ctx.root, {
      role: text("role"),
      model: text("model"),
      expr: text("expr"),
      column: text("column"),
      via: text("via"),
      manager: text("manager"),
      member: text("member"),
      user: text("user"),
      exclude_self: bool(values, "exclude-self"),
    });
    const role = text("role")!.trim();
    if (ctx.json) ctx.out(formatJson({ ...o, role }));
    else if (!o.changed) ctx.out(`Role ${role} already has that row filter on ${o.filter.model}; nothing changed. Next: sl status.`);
    else
      ctx.out(
        [`Added a row filter on ${o.filter.model} to role ${role} in ${o.file}.`, ...accessEditLines(o, `sl access --roles ${role} --user '<json of attributes>' shows the rows it leaves; ${READBACK_NEXT}`)].join("\n"),
      );
    return 0;
  },
};
export default spec;

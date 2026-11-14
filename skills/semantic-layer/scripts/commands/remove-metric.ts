import { isSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import { commitEdit, itemMap, locate, pathText, reapproveLines, referenceSites, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const spec: CommandSpec = {
  summary: "Remove a metric from metrics.yaml, refusing while a golden or access.yaml names it.",
  usage: "remove-metric <name | metric:<name>> [--force]",
  options: { force: { type: "boolean" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [raw, ...extra] = positionals;
    if (!raw || extra.length) throw new UserError("Usage: sl remove-metric <name> [--force], for example sl remove-metric average_order_value.");
    const name = raw.trim().replace(/^metric:/, "");
    const ref = `metric:${name}`;
    const loc = locate(ctx.root, ref);
    const approved = loc.item.status === "approved";
    const { sites } = referenceSites(ctx.root, { kind: "metric", name, source: String(loc.item.source ?? "") });
    if (sites.length) {
      const lines = sites.map((s) => `  - ${relFile(ctx.root, s.file)} ${pathText(s.path)}: ${s.from}`);
      throw new UserError(
        `Cannot remove ${ref}: ${sites.length === 1 ? "this names" : "these name"} it, so nothing was written:\n${lines.join("\n")}\n` +
          `Change or remove each reference first, then run this again; to change its name everywhere instead, use sl rename ${ref} <new_name>.`,
      );
    }
    if (approved && !bool(values, "force")) {
      throw new UserError(
        `${ref} is approved: removing it takes away a figure the owner signed off. Nothing was written. ` +
          `Ask the owner first, and only on their yes run sl remove-metric ${name} --force.`,
      );
    }
    const outcome = commitEdit(ctx.root, loc.file, `remove ${ref}`, (doc) => {
      const list = itemMap(doc, []).get("metrics", true);
      if (!isSeq(list)) throw new UserError(`Cannot edit metrics in ${relFile(ctx.root, loc.file)}: it is not a list.`);
      list.items.splice(Number(loc.path[1]), 1);
      // The last metric removed leaves an empty list, as the schema requires one.
      if (!list.items.length) list.flow = true;
    });
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, was_approved: approved }));
      return 0;
    }
    const lines = [`Removed metric ${name} from ${outcome.file}.`];
    if (approved) lines.push(`${ref} was approved: tell the owner it is removed.`);
    lines.push(...reapproveLines(outcome.reapprove));
    if (!outcome.reapprove.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

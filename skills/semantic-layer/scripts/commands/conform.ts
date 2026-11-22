import { isScalar } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { CONFORM_REF, conformedWords } from "../lib/conformed.ts";
import { commitEdit, itemMap, locate, placeKey, reapproveLines, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

const USAGE = "conform --source <s> --dimension <model>.<dimension> --to <model>.<dimension>";
const usage = (message: string) => new UserError(message, "semlayer conform --help", "usage");

const spec: CommandSpec = {
  summary: "Declare that a dimension of one model is the same as a dimension of another, so a request over both models groups them as one.",
  usage:
    `${USAGE}\n\n` +
    "Writes conforms_to on --dimension: semlayer conform --source warehouse --dimension refunds.refunded_on --to orders.order_date.\n" +
    "A request over the measures of both models then groups refunds by refunded_on where it names orders.order_date, and orders by order_date where it names\n" +
    "refunds.refunded_on; the column keeps the name the request gives it. It holds both ways and goes one hop: --to conforms to nothing itself.\n" +
    "The two must be of one type, time dimensions with a time grain in common, and in one schema or in schemas an approved pair joins.\n" +
    "conforms_to is part of the dimension's approval hash, and semlayer sql uses it once the dimension is approved: read it back and approve it on the owner's yes.\n" +
    "To remove it: semlayer set <s>.<model>.<dimension> conforms_to --unset.",
  options: { source: { type: "string" }, dimension: { type: "string" }, to: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, dim, to] = ["source", "dimension", "to"].map((k) => str(values, k)?.trim());
    if (!source || !dim || !to)
      throw usage(`Usage: semlayer ${USAGE}, for example semlayer conform --source warehouse --dimension refunds.refunded_on --to orders.order_date.`);
    for (const [flag, v] of [["dimension", dim], ["to", to]] as const)
      if (!CONFORM_REF.test(v)) throw usage(`--${flag} "${v}" is not <model>.<dimension>: write it as refunds.refunded_on, without the source.`);
    if (dim.split(".")[0] === to.split(".")[0])
      throw new UserError(`--dimension and --to are both dimensions of model ${dim.split(".")[0]}; a dimension conforms to one of another model. Nothing was written.`, "semlayer conform --help");
    const ref = `${source}.${dim}`;
    const loc = locate(ctx.root, ref);
    const target = locate(ctx.root, `${source}.${to}`);
    for (const [l, r] of [[loc, ref], [target, `${source}.${to}`]] as const)
      if (l.kind !== "dimension")
        throw new UserError(`${r} is a ${l.kind}, not a dimension; semlayer conform declares two dimensions the same. Nothing was written.`, `semlayer status`);
    const next = `semlayer readback --targets ${ref}`;
    if (loc.item.conforms_to === to) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, loc.file), reapprove: [], ref, conforms_to: to, next }));
      else ctx.out(`${ref} already conforms to ${to}; nothing changed. Next: semlayer status.`);
      return 0;
    }
    const outcome = commitEdit(ctx.root, loc.file, `set conforms_to on ${ref}`, (doc) => {
      const map = itemMap(doc, loc.path);
      const node = map.get("conforms_to", true);
      if (isScalar(node)) node.value = to;
      else placeKey(doc, map, "conforms_to", doc.createNode(to), [], ["status"]);
    });
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, conforms_to: to, next }));
      return 0;
    }
    const lines = [`Set conforms_to ${to} on ${ref} in ${outcome.file}. ${conformedWords(dim.split(".")[0]!, to)}`];
    lines.push(...reapproveLines(outcome.reapprove));
    lines.push(`Next: ${next} to read it back to the owner, and approve it only on their yes; semlayer sql uses it once ${ref} is approved.`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

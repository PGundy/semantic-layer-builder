import { isSeq, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { commitEdit, itemMap } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject, loadSource, paths } from "../lib/project.ts";
import { type CrossSchemaPair, crossSchemaPairs, splitKeyEnd } from "../lib/schema-scope.ts";

const USAGE = "remove-cross-schema --source <s> --from <schema> --to <schema> [--keys <table>.<column>=<table>.<column>[,...]]";

const spec: CommandSpec = {
  summary: "Remove a schema pair, or some of its keys, from a source.",
  usage:
    `${USAGE}\n\n` +
    "Without --keys the whole pair goes, a declined one included. With --keys only those keys go, each one the pair lists;\n" +
    "the pair goes back to draft, and a pair left with no key is removed. semlayer validate then names every join that\n" +
    "crossed on a removed key.",
  options: {
    source: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    keys: { type: "string", multiple: true },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [sourceName, from, to] = ["source", "from", "to"].map((k) => str(values, k)?.trim());
    if (!sourceName || !from || !to) throw new UserError(`Usage: semlayer ${USAGE}, for example semlayer remove-cross-schema --source warehouse --from sales --to crm.`);
    const source = loadSource(ctx.root, sourceName);
    const pairs = crossSchemaPairs(source);
    const index = pairs.findIndex((p) => p.from === from && p.to === to);
    if (index < 0) {
      const reversed = pairs.find((p) => p.from === to && p.to === from);
      throw new UserError(
        `sources/${sourceName}.yaml has no pair ${from} -> ${to}. Nothing was written. ` +
          (reversed ? `It declares ${to} -> ${from}: run semlayer remove-cross-schema --source ${sourceName} --from ${to} --to ${from}.` : `semlayer validate lists the pairs it holds under cross_schema.`),
      );
    }
    const prior = pairs[index]!;
    let removed: CrossSchemaPair["keys"] = prior.keys ?? [];
    let pair: CrossSchemaPair | undefined;
    const keyArgs = list(values, "keys");
    if (keyArgs.length) {
      const keys = [...(prior.keys ?? [])];
      removed = [];
      for (const arg of keyArgs) {
        const [left, right, ...rest] = arg.split("=").map((x) => x.trim());
        if (!left || !right || rest.length || !splitKeyEnd(left) || !splitKeyEnd(right))
          throw new UserError(`--keys takes <table>.<column>=<table>.<column> pairs separated by commas, such as orders.customer_id=customers.customer_id; got "${arg}". Nothing was written.`);
        const at = keys.findIndex((k) => k.from.toLowerCase() === left.toLowerCase() && k.to.toLowerCase() === right.toLowerCase());
        if (at < 0)
          throw new UserError(
            `The pair ${from} -> ${to} lists no key ${left}=${right}. Nothing was written. Its keys: ${(prior.keys ?? []).map((k) => `${k.from}=${k.to}`).join(", ") || "none"}.`,
          );
        removed.push(...keys.splice(at, 1));
      }
      if (keys.length) pair = { from, to, status: "draft", keys };
    }

    const file = paths(ctx.root).source(sourceName);
    const outcome = commitEdit(ctx.root, file, `remove cross-schema pair ${from} -> ${to}`, (doc) => {
      const root = itemMap(doc, []);
      const seq = root.get("cross_schema", true);
      if (!isSeq(seq)) return;
      const items = (seq as YAMLSeq).items;
      if (pair) items[index] = doc.createNode(pair);
      else items.splice(index, 1);
      if (!items.length) root.delete("cross_schema");
    });
    const next = pair ? `semlayer approve --target schema-pair:${sourceName}:${from}:${to} --by "<owner>"` : "semlayer validate";
    if (ctx.json) {
      ctx.out(formatJson({ changed: outcome.changed, file: outcome.file, removed_pair: !pair, removed_keys: removed, pair: pair ?? null, next }));
      return 0;
    }
    const lines = pair
      ? [
          `Removed ${removed.map((k) => `${k.from} = ${k.to}`).join(" and ")} from the pair ${from} -> ${to} in ${outcome.file}; the pair is a draft again.`,
          `Next: read the pair to the owner with semlayer readback --targets schema-pair:${sourceName}:${from}:${to}, and on their yes run ${next}; semlayer validate names any join that crossed on a removed key.`,
        ]
      : [`Removed the pair ${from} -> ${to} from ${outcome.file}.`, `Next: ${next} names any join that still crosses between ${from} and ${to}.`];
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

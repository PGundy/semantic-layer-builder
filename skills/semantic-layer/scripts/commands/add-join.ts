import { isSeq, type Node, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { commitEdit, type IgnoredRead, ignoredRefusal, itemMap, locate, oneLine, placeKey, reapproveLines } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { findTable } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadProject, loadSnapshot } from "../lib/project.ts";
import { findField } from "../lib/refs.ts";
import { type Model, NAME_PATTERN } from "../lib/types.ts";

const RELATIONSHIPS = ["many_to_one", "one_to_one", "one_to_many"];
const TYPES = ["left", "inner"];
// owner: the owner stated the join; inferred: the agent guessed it from names or matching values.
const ORIGINS = ["owner", "inferred"];

const USAGE =
  "add-join --source <s> --model <m> --name <join> --to <model> --keys <left>=<right>[,<left>=<right>] " +
  "[--relationship many_to_one|one_to_one|one_to_many] [--type left|inner] [--origin owner|inferred] [--description <text>]";

const spec: CommandSpec = {
  summary: "Add a draft join from one model to another of the same source, checking its key columns against the snapshot.",
  usage:
    `${USAGE}\n\n` +
    "--keys pairs a column of the model's table with a column of the target's: --keys ship_region=region_code.\n" +
    "--relationship is rows of this model per row of the target (default many_to_one); --type defaults to left;\n" +
    "--origin is owner (the owner stated it, the default) or inferred (guessed from names or values).\n" +
    "The join is written as a draft: semlayer check-join measures it, then it is read back and approved on the owner's yes.",
  options: {
    source: { type: "string" },
    model: { type: "string" },
    name: { type: "string" },
    to: { type: "string" },
    keys: { type: "string" },
    relationship: { type: "string" },
    type: { type: "string" },
    origin: { type: "string" },
    description: { type: "string" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, modelName, name, to, keysArg] = ["source", "model", "name", "to", "keys"].map((k) => str(values, k)?.trim());
    if (!source || !modelName || !name || !to || !keysArg) {
      throw new UserError(`Usage: semlayer ${USAGE}, for example semlayer add-join --source warehouse --model orders --name region --to regions --keys ship_region=region_code.`);
    }
    for (const [flag, v] of [["name", name], ["to", to]] as const)
      if (!NAME_PATTERN.test(v)) throw new UserError(`--${flag} "${v}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as ship_region.`);
    const relationship = str(values, "relationship")?.trim() ?? "many_to_one";
    if (!RELATIONSHIPS.includes(relationship)) throw new UserError(`--relationship is ${RELATIONSHIPS.join(", ")}, not ${relationship}: rows of this model per row of the target.`);
    const type = str(values, "type")?.trim();
    if (type !== undefined && !TYPES.includes(type)) throw new UserError(`--type is left or inner, not ${type}.`);
    const origin = str(values, "origin")?.trim() ?? "owner";
    if (!ORIGINS.includes(origin)) throw new UserError(`--origin is owner (the owner stated the join) or inferred (guessed from names or values), not ${origin}.`);
    const keys: { from: string; to: string }[] = [];
    for (const pair of keysArg.split(",")) {
      const [from, right, ...rest] = pair.split("=").map((x) => x.trim());
      if (!from || !right || rest.length) throw new UserError(`--keys takes <left column>=<right column> pairs separated by commas, such as ship_region=region_code; got "${pair.trim()}".`);
      if (keys.some((k) => k.from.toLowerCase() === from.toLowerCase() && k.to.toLowerCase() === right.toLowerCase())) continue;
      keys.push({ from, to: right });
    }

    const modelRef = `${source}.${modelName}`;
    const ref = `${modelRef}.${name}`;
    const loc = locate(ctx.root, modelRef);
    if (loc.kind !== "model") throw new UserError(`--source and --model name a model, such as --source warehouse --model orders; ${modelRef} is not one.`);
    const model = loc.model!;
    const taken = findField(model, name);
    if (taken) throw new UserError(`${modelRef} already has a ${taken.kind} "${name}": dimensions, measures and joins share one namespace. Nothing was written. Pick another --name.`);
    const models = listModels(ctx.root, source).map((l) => l.model);
    const target = models.find((m) => m.model === to);
    if (!target) {
      throw new UserError(
        `No model "${to}" in source ${source}, so there is nothing to join to. Nothing was written. ` +
          `semlayer status lists the models; a table without one is drafted with semlayer draft --source ${source} --tables <table>.`,
      );
    }

    // Each key column must be a column of its table in the snapshot, spelled as the snapshot has it.
    const snapshot = loadSnapshot(ctx.root, source);
    const warnings: string[] = [];
    const spell = (m: Model, side: "from" | "to") => {
      const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(m.table)) : undefined;
      if (!table) {
        warnings.push(`The snapshot has no table ${m.table}, so the key columns on it were not checked; run semlayer introspect --source ${source}, then semlayer validate.`);
        return;
      }
      for (const k of keys) {
        const col = table.columns.find((c) => c.name === k[side]) ?? table.columns.find((c) => c.name.toLowerCase() === k[side].toLowerCase());
        if (!col) throw new UserError(`${k[side]} is not a column of ${m.table} (model ${m.model}) in the snapshot. Nothing was written. Run semlayer tables --source ${source} to see its tables, or semlayer introspect --source ${source} if it is new.`);
        k[side] = col.name;
      }
    };
    spell(model, "from");
    spell(target, "to");
    const isIn = (m: Model, c: string) => (m.ignored_columns ?? []).map(String).find((x) => x.toLowerCase() === c.toLowerCase());
    const ignored: IgnoredRead[] = [];
    for (const k of keys) {
      for (const [m, c] of [[model, k.from], [target, k.to]] as const) {
        const listed = isIn(m, c);
        if (listed && !ignored.some((r) => r.model === m.model && r.column === listed)) ignored.push({ model: m.model, column: listed });
      }
    }
    if (ignored.length) throw ignoredRefusal(source, `The join ${ref}`, ignored);

    const description = str(values, "description");
    const join = {
      name,
      to,
      keys,
      relationship,
      ...(type !== undefined ? { type } : {}),
      origin,
      ...(description !== undefined && oneLine(description) ? { description: oneLine(description) } : {}),
      status: "draft",
    };
    const outcome = commitEdit(ctx.root, loc.file, `add join ${ref}`, (doc) => {
      const root = itemMap(doc, []);
      const node = doc.createNode(join) as Node;
      const list = root.get("joins", true);
      // Push into a non-empty list; a missing or empty one (joins: []) becomes a block list.
      if (isSeq(list) && (list as YAMLSeq).items.length) (list as YAMLSeq).items.push(node);
      else {
        const created = doc.createNode([]) as YAMLSeq;
        created.items.push(node);
        placeKey(doc, root, "joins", created, ["measures", "dimensions"]);
      }
    });
    const next = `semlayer check-join --source ${source} --model ${modelName} --join ${name}`;
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, join, warnings, next }));
      return 0;
    }
    const lines = [`Added draft join ${name} from ${modelRef} to ${to} on ${keys.map((k) => `${k.from} = ${k.to}`).join(" and ")} in ${outcome.file}.`];
    lines.push(...warnings, ...reapproveLines(outcome.reapprove));
    lines.push(`Next: ${next} measures it; then read it back to the owner (semlayer readback --targets ${ref}) and approve it only on their yes.`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

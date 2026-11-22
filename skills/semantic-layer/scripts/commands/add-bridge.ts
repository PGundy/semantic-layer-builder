import { isSeq, type Node, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { commitEdit, type IgnoredRead, ignoredRefusal, itemMap, locate, oneLine, placeKey, reapproveLines } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { classifyType, isNumeric } from "../lib/column-types.ts";
import { findTable } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import { findField } from "../lib/refs.ts";
import { backedPairs, crossSchemaLevel, schemaJoin, undeclaredPairError } from "../lib/schema-scope.ts";
import { readApprovalLedger } from "../lib/ledger.ts";
import { DEDUPE_RULES, type Dedupe, joinLegs, type Through } from "../lib/through.ts";
import { type Model, NAME_PATTERN } from "../lib/types.ts";

const ORIGINS = ["owner", "inferred"];

// A refusal over a flag the command does not take as written: code usage, next its help.
const usage = (message: string) => new UserError(message, "semlayer add-bridge --help", "usage");

const USAGE =
  "add-bridge --source <s> --model <m> --name <join> --to <target model> --through <bridge model> --keys <left>=<bridge column>[,...] " +
  "--through-keys <bridge column>=<target column>[,...] [--dedupe distinct_pairs|equal_split|weight] [--weight <bridge column>] " +
  "[--type left|inner] [--origin owner|inferred] [--description <text>]";

function pairs(flag: string, arg: string, example: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const pair of arg.split(",")) {
    const [from, to, ...rest] = pair.split("=").map((x) => x.trim());
    if (!from || !to || rest.length) throw usage(`${flag} takes <column>=<column> pairs separated by commas, such as ${example}; got "${pair.trim()}".`);
    if (!out.some((k) => k.from.toLowerCase() === from.toLowerCase() && k.to.toLowerCase() === to.toLowerCase())) out.push({ from, to });
  }
  return out;
}

const spec: CommandSpec = {
  summary: "Add a draft bridge join: a model reaches a target through a bridge model, checking its columns against the snapshot.",
  usage:
    `${USAGE}\n\n` +
    "A bridge join is for a many-valued attribute, such as the tags of an order, held in a bridge table with one row per (order, tag).\n" +
    "--keys pairs a column of the model's table with a column of the bridge's: --keys order_id=order_id.\n" +
    "--through-keys pairs a column of the bridge's table with a column of the target's: --through-keys tag_id=tag_id.\n" +
    "--dedupe is the owner's rule for sharing a figure among the target values of one row: distinct_pairs (each pair counts once; group totals add up to more than the total),\n" +
    "equal_split (each of n values gets 1/n) or weight (each gets its share of the bridge column named by --weight). It is optional on a draft and required to approve.\n" +
    "The join is written as a draft with relationship one_to_many; read it back to the owner and approve it only on their yes.",
  options: {
    source: { type: "string" },
    model: { type: "string" },
    name: { type: "string" },
    to: { type: "string" },
    through: { type: "string" },
    keys: { type: "string" },
    "through-keys": { type: "string" },
    dedupe: { type: "string" },
    weight: { type: "string" },
    type: { type: "string" },
    origin: { type: "string" },
    description: { type: "string" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, modelName, name, to, via, keysArg, throughArg] = ["source", "model", "name", "to", "through", "keys", "through-keys"].map((k) => str(values, k)?.trim());
    if (!source || !modelName || !name || !to || !via || !keysArg || !throughArg) {
      throw usage(
        `Usage: semlayer ${USAGE}, for example semlayer add-bridge --source warehouse --model orders --name tag --to tags --through order_tags --keys order_id=order_id --through-keys tag_id=tag_id.`,
      );
    }
    for (const [flag, v] of [["name", name], ["to", to], ["through", via]] as const)
      if (!NAME_PATTERN.test(v)) throw usage(`--${flag} "${v}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as order_tags.`);
    const type = str(values, "type")?.trim();
    if (type !== undefined && !["left", "inner"].includes(type)) throw usage(`--type is left or inner, not ${type}.`);
    const origin = str(values, "origin")?.trim() ?? "owner";
    if (!ORIGINS.includes(origin)) throw usage(`--origin is owner (the owner stated the join) or inferred (guessed from names or values), not ${origin}.`);
    const dedupe = str(values, "dedupe")?.trim();
    if (dedupe !== undefined && !(DEDUPE_RULES as readonly string[]).includes(dedupe))
      throw usage(`--dedupe is ${DEDUPE_RULES.join(", ")}, not ${dedupe}: it is how a figure is shared among the ${to} values of one ${modelName} row, and the owner chooses it.`);
    const weight = str(values, "weight")?.trim();
    if (dedupe === "weight" && !weight) throw usage("--dedupe weight needs --weight <bridge column>: the column of the bridge whose values share the figure.");
    if (weight && dedupe !== "weight") throw usage("--weight goes only with --dedupe weight.");
    const keys = pairs("--keys", keysArg, "order_id=order_id");
    const throughKeys = pairs("--through-keys", throughArg, "tag_id=tag_id");

    const modelRef = `${source}.${modelName}`;
    const ref = `${modelRef}.${name}`;
    const loc = locate(ctx.root, modelRef);
    if (loc.kind !== "model") throw new UserError(`--source and --model name a model, such as --source warehouse --model orders; ${modelRef} is not one.`, "semlayer status");
    const model = loc.model!;
    const taken = findField(model, name);
    if (taken) throw new UserError(`${modelRef} already has a ${taken.kind} "${name}": dimensions, measures and joins share one namespace. Nothing was written. Pick another --name.`, "semlayer add-bridge --help");
    const models = listModels(ctx.root, source).map((l) => l.model);
    const find = (n: string, what: string): Model => {
      const found = models.find((m) => m.model === n);
      if (!found) {
        throw new UserError(
          `No model "${n}" in source ${source}, so there is no ${what} to join through. Nothing was written. ` +
            `semlayer status lists the models; a table without one is drafted with semlayer draft --source ${source} --tables <table>.`,
          "semlayer status",
        );
      }
      return found;
    };
    const target = find(to, "target");
    const bridge = find(via, "bridge");
    if (via === modelName || via === to) throw new UserError(`The bridge must be a third model: --through ${via} is the ${via === to ? "target" : "model"} itself. Nothing was written. A bridge table holds one row per (${modelName}, ${to}) pair.`, "semlayer status");

    // Every column must be a column of its table in the snapshot, spelled as the snapshot has it.
    const snapshot = loadSnapshot(ctx.root, source);
    const warnings: string[] = [];
    const spell = (m: Model, list: { from: string; to: string }[], side: "from" | "to") => {
      const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(m.table)) : undefined;
      if (!table) {
        const note = `The snapshot has no table ${m.table}, so the columns on it were not checked; run semlayer introspect --source ${source}, then semlayer validate.`;
        if (!warnings.includes(note)) warnings.push(note);
        return undefined;
      }
      for (const k of list) {
        const col = table.columns.find((c) => c.name === k[side]) ?? table.columns.find((c) => c.name.toLowerCase() === k[side].toLowerCase());
        if (!col) throw new UserError(`${k[side]} is not a column of ${m.table} (model ${m.model}) in the snapshot. Nothing was written. Run semlayer tables --source ${source} to see its tables, or semlayer introspect --source ${source} if it is new.`, `semlayer tables --source ${source}`);
        k[side] = col.name;
      }
      return table;
    };
    spell(model, keys, "from");
    const bridgeTable = spell(bridge, keys, "to");
    spell(bridge, throughKeys, "from");
    spell(target, throughKeys, "to");
    let weightColumn = weight;
    if (weight) {
      const col = bridgeTable?.columns.find((c) => c.name.toLowerCase() === weight.toLowerCase());
      if (bridgeTable && !col) throw new UserError(`${weight} is not a column of ${bridge.table} (model ${bridge.model}) in the snapshot. Nothing was written. Run semlayer tables --source ${source} to see its columns.`, `semlayer tables --source ${source}`);
      if (col && !isNumeric(classifyType(col.type))) throw new UserError(`${col.name} is ${col.type}, not a number, so it cannot be a weight. Nothing was written. Pick a numeric column of ${bridge.table}.`, `semlayer tables --source ${source}`);
      weightColumn = col?.name ?? weight;
    }

    // Each hop is a join: one across schemas needs an approved pair that declares its keys (spec: Schema scope).
    const through: Through = { model: via, keys: throughKeys, ...(dedupe ? { dedupe: dedupe as Dedupe } : {}), ...(weightColumn ? { weight: weightColumn } : {}) };
    const sourceConfig = loadSource(ctx.root, source);
    const schemaPairs = backedPairs(sourceConfig, readApprovalLedger(ctx.root));
    for (const leg of joinLegs(model, { to, keys, through })) {
      const from = models.find((m) => m.model === leg.from)!;
      const far = models.find((m) => m.model === leg.to)!;
      const shape = schemaJoin(snapshot, String(from.table), String(far.table), leg.keys);
      if (shape && crossSchemaLevel(schemaPairs, shape, "draft")) throw undeclaredPairError(`The join ${ref} (${leg.from} to ${leg.to})`, source, shape, schemaPairs, `run this semlayer add-bridge again`);
    }

    const isIn = (m: Model, c: string) => (m.ignored_columns ?? []).map(String).find((x) => x.toLowerCase() === c.toLowerCase());
    const ignored: IgnoredRead[] = [];
    const reads: [Model, string][] = [
      ...keys.flatMap((k) => [[model, k.from], [bridge, k.to]] as [Model, string][]),
      ...throughKeys.flatMap((k) => [[bridge, k.from], [target, k.to]] as [Model, string][]),
      ...(weightColumn ? ([[bridge, weightColumn]] as [Model, string][]) : []),
    ];
    for (const [m, c] of reads) {
      const listed = isIn(m, c);
      if (listed && !ignored.some((r) => r.model === m.model && r.column === listed)) ignored.push({ model: m.model, column: listed });
    }
    if (ignored.length) throw ignoredRefusal(source, `The join ${ref}`, ignored);

    const description = str(values, "description");
    const join = {
      name,
      to,
      keys,
      relationship: "one_to_many",
      ...(type !== undefined ? { type } : {}),
      origin,
      ...(description !== undefined && oneLine(description) ? { description: oneLine(description) } : {}),
      through,
      status: "draft",
    };
    const outcome = commitEdit(ctx.root, loc.file, `add bridge join ${ref}`, (doc) => {
      const root = itemMap(doc, []);
      const node = doc.createNode(join) as Node;
      const list = root.get("joins", true);
      if (isSeq(list) && (list as YAMLSeq).items.length) (list as YAMLSeq).items.push(node);
      else {
        const created = doc.createNode([]) as YAMLSeq;
        created.items.push(node);
        placeKey(doc, root, "joins", created, ["measures", "dimensions"]);
      }
    });
    const next = dedupe
      ? `semlayer readback --targets ${ref}`
      : `ask the owner how a figure is shared among the ${to} values of one ${modelName} row (distinct_pairs, equal_split or weight), then semlayer remove-join --source ${source} --model ${modelName} --name ${name} and add-bridge again with --dedupe`;
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, join, warnings, next }));
      return 0;
    }
    const lines = [`Added draft bridge join ${name} from ${modelRef} to ${to} through ${via} in ${outcome.file}${dedupe ? `, with dedupe ${dedupe}` : ", with no dedupe rule yet"}.`];
    lines.push(...warnings, ...reapproveLines(outcome.reapprove));
    lines.push(
      dedupe
        ? `Next: ${next} to read it back to the owner, and approve it only on their yes. Requests grouped by a ${to} field are not compiled yet.`
        : `Next: ${next}. An approved bridge join needs the rule.`,
    );
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

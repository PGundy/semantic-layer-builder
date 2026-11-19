import { basename } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { locate, pathText, type RefSite, referenceSites, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { loadProject, paths, stem } from "../lib/project.ts";
import { readYamlIfExists } from "../lib/yaml.ts";
import removeField from "./remove-field.ts";

// What holds one place that reads through the join: a model's field (source.model.field), or a
// role's row filter in access.yaml; otherwise the file and path.
function holder(root: string, source: string, site: RefSite): string {
  const [section, index] = site.path;
  const doc = readYamlIfExists<Record<string, unknown>>(site.file) ?? {};
  const at = Array.isArray(doc[String(section)]) ? (doc[String(section)] as Record<string, unknown>[])[Number(index)] : undefined;
  const name = typeof at?.name === "string" ? at.name : undefined;
  if (name && (section === "dimensions" || section === "measures")) return `${source}.${stem(basename(site.file))}.${name} (its ${String(site.path[2])}: ${site.from})`;
  if (name && site.file === paths(root).access && section === "roles") return `a row filter of role ${name} in access.yaml (${site.from})`;
  return `${relFile(root, site.file)} ${pathText(site.path)}: ${site.from}`;
}

const spec: CommandSpec = {
  summary: "Remove a join from a model, refusing while a field or row filter reads through it.",
  usage: "remove-join --source <s> --model <m> --name <join> [--keep-column] [--force]",
  options: { source: { type: "string" }, model: { type: "string" }, name: { type: "string" }, "keep-column": { type: "boolean" }, force: { type: "boolean" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, model, name] = ["source", "model", "name"].map((k) => str(values, k)?.trim());
    if (!source || !model || !name) throw new UserError("Usage: semlayer remove-join --source <s> --model <m> --name <join> [--keep-column] [--force], for example semlayer remove-join --source warehouse --model orders --name region.");
    const ref = `${source}.${model}.${name}`;
    const loc = locate(ctx.root, ref);
    if (loc.kind !== "join") throw new UserError(`${ref} is a ${loc.kind}, not a join; semlayer remove-field ${ref} removes it.`);
    const { sites } = referenceSites(ctx.root, { kind: "join", source, model, name });
    if (sites.length) {
      throw new UserError(
        `Cannot remove ${ref}: ${sites.length === 1 ? "this reads" : "these read"} through it, so nothing was written:\n${sites.map((s) => `  - ${holder(ctx.root, source, s)}`).join("\n")}\n` +
          `Change or remove each first (semlayer set <field> expr|filter "<sql>", semlayer remove-field <field>, semlayer remove-row-filter), then run this again.`,
      );
    }
    if (loc.item.status === "approved" && !values.force) {
      throw new UserError(
        `${ref} is approved: removing it changes ${source}.${model} after the owner signed it off. Nothing was written. ` +
          `Ask the owner first, and only on their yes run semlayer remove-join --source ${source} --model ${model} --name ${name} --force.`,
      );
    }
    // The rest is semlayer remove-field's: an approved join needs --force on the owner's yes, and its key
    // columns that nothing else reads go to ignored_columns unless --keep-column.
    return removeField.run({ values: { force: values.force, "keep-column": values["keep-column"] }, positionals: [ref] }, ctx);
  },
};
export default spec;

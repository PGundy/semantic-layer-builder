import { isSeq, Scalar, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import { commitEdit, fieldColumns, itemMap, locate, pathText, placeKey, questionLines, readers, reapproveLines, referenceSites, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { findTable } from "../lib/naming.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import type { Model } from "../lib/types.ts";
import { heldValues } from "../lib/validate.ts";

const SECTIONS = { dimension: "dimensions", measure: "measures", join: "joins" } as const;

// Where a new ignored column goes: before the first entry that sorts after it, as sl ignore-column places it.
function placeOf(list: string[], column: string): number {
  const at = list.findIndex((x) => x > column);
  return at < 0 ? list.length : at;
}

const spec: CommandSpec = {
  summary: "Remove a dimension, measure or join, adding the columns only it read to ignored_columns.",
  usage: "remove-field <source.model.field> [--keep-column] [--force]",
  options: { "keep-column": { type: "boolean" }, force: { type: "boolean" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [ref, ...extra] = positionals;
    if (!ref || extra.length) throw new UserError("Usage: sl remove-field <source.model.field> [--keep-column] [--force], for example sl remove-field warehouse.orders.discount.");
    const loc = locate(ctx.root, ref);
    if (loc.kind !== "dimension" && loc.kind !== "measure" && loc.kind !== "join") {
      throw new UserError(`sl remove-field removes a dimension, measure or join (source.model.field); ${ref} is a ${loc.kind === "access" ? "file" : loc.kind}.`);
    }
    const kind = loc.kind;
    const [source, modelName] = ref.split(".") as [string, string];
    const modelRef = `${source}.${modelName}`;
    const name = String(loc.item.name);
    const approved = loc.item.status === "approved";
    const { sites } = referenceSites(ctx.root, { kind, source, model: modelName, name });
    if (sites.length) {
      const lines = sites.map((s) => `  - ${relFile(ctx.root, s.file)} ${pathText(s.path)}: ${s.from}`);
      throw new UserError(
        `Cannot remove ${ref}: ${sites.length === 1 ? "this names" : "these name"} it, so nothing was written:\n${lines.join("\n")}\n` +
          `Change or remove each reference first, then run this again; to change its name everywhere instead, use sl rename ${ref} <new_name>.`,
      );
    }

    if (approved && !bool(values, "force")) {
      throw new UserError(
        `${ref} is approved: removing it changes ${modelRef} after the owner signed it off. Nothing was written. ` +
          `Ask the owner first, and only on their yes run sl remove-field ${ref} --force.`,
      );
    }

    const model = loc.model!;
    const config = loadSource(ctx.root, source);
    const snapshot = loadSnapshot(ctx.root, source);
    const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(model.table)) : undefined;
    const section = SECTIONS[kind];
    const after = { ...model, [section]: (model[section] ?? []).filter((f) => f.name !== name) } as Model;
    const others = listModels(ctx.root, source).map((l) => l.model).filter((m) => m.model !== modelName);
    const ignored = (model.ignored_columns ?? []).map(String);
    const isIgnored = (c: string) => ignored.some((x) => x.toLowerCase() === c.toLowerCase());
    const columns = bool(values, "keep-column")
      ? []
      : fieldColumns(model, kind, loc.item, table, config.dialect).filter((c) => !isIgnored(c) && !readers(after, c, others, config.dialect).length);
    const nextIgnored = [...ignored];
    for (const c of columns) nextIgnored.splice(placeOf(nextIgnored, c), 0, c);
    const redact = columns.filter((c) => {
      const col = table?.columns.find((x) => x.name === c);
      return !!col && heldValues(col.profile, col.type) !== null;
    });

    const outcome = commitEdit(ctx.root, loc.file, `remove ${ref}`, (doc) => {
      const root = itemMap(doc, []);
      const list = root.get(section, true);
      if (!isSeq(list)) throw new UserError(`Cannot edit ${section} in ${relFile(ctx.root, loc.file)}: it is not a list.`);
      list.items.splice(Number(loc.path[1]), 1);
      if (!list.items.length && kind === "join") root.delete("joins");
      if (!columns.length) return;
      const node = root.get("ignored_columns", true);
      if (isSeq(node)) {
        const seq = node as YAMLSeq;
        for (const c of columns) seq.items.splice(placeOf(seq.items.map((i) => String((i as { value?: unknown }).value ?? i)), c), 0, new Scalar(c));
        return;
      }
      const created = doc.createNode(columns) as YAMLSeq;
      placeKey(doc, root, "ignored_columns", created, ["open_questions"], ["dimensions", "measures", "joins"]);
    });
    const result = { ref, kind, ignored_columns_added: columns, ignored_columns: columns.length ? nextIgnored : ignored, redact: redact.length > 0 };
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ...result, was_approved: approved }));
      return 0;
    }
    const lines = [`Removed ${kind} ${name} from ${modelRef} in ${outcome.file}.`];
    if (columns.length) lines.push(`Added ${columns.join(", ")} to ${modelRef}'s ignored_columns, so sl status and sl draft --new-columns skip ${columns.length === 1 ? "it" : "them"}.`);
    if (redact.length) lines.push(`The snapshot holds sample values of ${redact.join(", ")}, which ${redact.length === 1 ? "is" : "are"} protected now: run sl profile --source ${source} --redact to keep counts only.`);
    if (approved && model.status === "approved") {
      lines.push(
        `${ref} was approved, so ${modelRef} changed since the owner approved it: read ${modelRef} back to the owner as it now stands. ` +
          `Its approval covers its table, grain and keys, so it stays approved; if the owner withdraws it, run sl approve --target ${modelRef} --revoke.`,
      );
    } else if (approved) lines.push(`${ref} was approved: tell the owner it is removed, and read ${modelRef} back to them as it now stands before approving it (sl approve --target ${modelRef} --by "<owner>").`);
    lines.push(...questionLines(model, name, outcome.file));
    lines.push(...reapproveLines(outcome.reapprove));
    if (!approved && !outcome.reapprove.length && !redact.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

import { isSeq, Scalar, type YAMLSeq } from "yaml";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { commitEdit, itemMap, oneLine, placeKey, readers, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadModel, loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import { findTable } from "../lib/naming.ts";
import { heldValues } from "../lib/validate.ts";

// The index a new entry takes so a sorted list stays sorted: before the first entry after it.
function sortedIndex(items: string[], value: string): number {
  const i = items.findIndex((x) => x > value);
  return i < 0 ? items.length : i;
}

// --remove: takes the column out of ignored_columns (the key goes with its last entry), so a field,
// a filter or a join may read it; it adds no field. A column not listed changes nothing.
function unignore(ctx: CommandContext, path: string, ref: string, column: string, ignored: string[]): number {
  const listed = ignored.find((c) => c.toLowerCase() === column.toLowerCase());
  if (listed === undefined) {
    if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, path), reapprove: [], ref, column, ignored_columns: ignored, removed: true }));
    else ctx.out(`${column} is not in ${ref}'s ignored_columns; nothing changed. Next: semlayer status.`);
    return 0;
  }
  const outcome = commitEdit(ctx.root, path, `take ${listed} out of ${ref}'s ignored_columns`, (doc) => {
    const map = itemMap(doc, []);
    const node = map.get("ignored_columns", true);
    if (!isSeq(node)) return;
    node.items = node.items.filter((i) => String((i as { value?: unknown }).value ?? i) !== listed);
    if (!node.items.length) map.delete("ignored_columns");
  });
  const after = ignored.filter((c) => c !== listed);
  if (ctx.json) {
    ctx.out(formatJson({ ...outcome, ref, column: listed, ignored_columns: after, removed: true }));
    return 0;
  }
  ctx.out(
    [
      `Took ${listed} out of ${ref}'s ignored_columns in ${outcome.file}; no field was added.`,
      "Next: run the edit the owner asked for that reads it (semlayer set, semlayer add-field, semlayer add-join or semlayer check-rule), then semlayer validate.",
    ].join("\n"),
  );
  return 0;
}

const spec: CommandSpec = {
  summary: "Add a column to a model's ignored_columns (left out on purpose, so no field is drafted for it), or take it back out with --remove.",
  usage:
    "ignore-column --source <s> --model <m> --column <c> [--reason <text>]\n" +
    "       semlayer ignore-column --source <s> --model <m> --column <c> --remove   (takes the column out of ignored_columns, adding no field)",
  options: { source: { type: "string" }, model: { type: "string" }, column: { type: "string" }, reason: { type: "string" }, remove: { type: "boolean" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const source = str(values, "source");
    const modelName = str(values, "model");
    let column = str(values, "column")?.trim();
    if (!source || !modelName || !column) throw new UserError("--source, --model and --column are required: semlayer ignore-column --source <s> --model <m> --column <c>.");
    const reason = str(values, "reason") === undefined ? undefined : oneLine(str(values, "reason")!);
    const config = loadSource(ctx.root, source);
    const { path, model } = loadModel(ctx.root, source, modelName);
    const ref = `${source}.${modelName}`;
    if (bool(values, "remove")) {
      if (reason !== undefined) throw new UserError(`--reason records why a column is left out; --remove takes ${column} back in, so run it without --reason.`);
      return unignore(ctx, path, ref, column, (model.ignored_columns ?? []).map(String));
    }
    const snapshot = loadSnapshot(ctx.root, source);
    const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(model.table)) : undefined;
    // An ignored column is protected, so sample values the snapshot holds for it are redacted.
    let redact = false;
    if (table) {
      const col = table.columns.find((c) => c.name === column) ?? table.columns.find((c) => c.name.toLowerCase() === column!.toLowerCase());
      if (!col) throw new UserError(`${column} is not a column of ${model.table} in the snapshot. Run semlayer tables --source ${source} to see its tables, or semlayer introspect --source ${source} if it is new.`);
      column = col.name;
      redact = heldValues(col.profile, col.type) !== null;
    }
    const ignored = (model.ignored_columns ?? []).map(String);
    const result = { ref, column, ignored_columns: ignored };
    if (ignored.some((c) => c.toLowerCase() === column!.toLowerCase())) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, path), reapprove: [], ...result }));
      else ctx.out(`${column} is already in ${ref}'s ignored_columns; nothing changed. Next: semlayer status.`);
      return 0;
    }
    const others = listModels(ctx.root, source).map((l) => l.model).filter((m) => m.model !== modelName);
    const by = readers(model, column, others, config.dialect);
    if (by.length) {
      const fields = by.filter((b) => b.startsWith("dimension ") || b.startsWith("measure ")).map((b) => `${ref}.${b.split(" ")[1]}`);
      throw new UserError(
        `Cannot ignore ${column}: in ${ref} it is read by ${by.join(", ")}. ` +
          (fields.length
            ? `Remove the field first (semlayer remove-field ${fields.join(", then semlayer remove-field ")}), which also adds the column to ignored_columns once nothing else reads it.`
            : "A column a key reads is in use, so it stays; nothing was changed. Next: semlayer status."),
      );
    }
    const at = sortedIndex(ignored, column);
    const outcome = commitEdit(ctx.root, path, `ignore ${column} on ${ref}`, (doc) => {
      const map = itemMap(doc, []);
      const node = map.get("ignored_columns", true);
      const item = new Scalar(column);
      if (reason) item.comment = ` ${reason}`;
      if (isSeq(node)) {
        // A reason comment needs a block list; the flow list's trailing comment moves to its own
        // line under the key.
        if (reason && node.flow) {
          node.flow = false;
          if (node.comment) node.commentBefore = [node.commentBefore, node.comment].filter(Boolean).join("\n");
          node.comment = undefined;
        }
        (node as YAMLSeq).items.splice(at, 0, item);
        return;
      }
      const created = doc.createNode([]) as YAMLSeq;
      created.items.push(item);
      placeKey(doc, map, "ignored_columns", created, ["open_questions"], ["dimensions", "measures", "joins"]);
    });
    const after = [...ignored.slice(0, at), column, ...ignored.slice(at)];
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ...result, ignored_columns: after, ...(reason ? { reason } : {}), redact }));
      return 0;
    }
    const lines = [`Added ${column} to ${ref}'s ignored_columns in ${outcome.file}; semlayer status and semlayer draft --new-columns skip it now.`];
    if (redact) lines.push(`The snapshot holds sample values of ${column}, which is protected now: run semlayer profile --source ${source} --redact to keep counts only.`);
    else lines.push("Next: semlayer status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

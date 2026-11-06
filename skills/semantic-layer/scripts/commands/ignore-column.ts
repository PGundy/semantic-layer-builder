import { isSeq, Scalar, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { commitEdit, itemMap, oneLine, placeKey, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadModel, loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import { incomingKeyColumns, referencedColumns } from "../lib/snapshot-diff.ts";
import { findTable } from "../lib/naming.ts";
import type { Model, SnapshotTable } from "../lib/types.ts";
import { heldValues } from "../lib/validate.ts";

// What of the model reads `column`: its fields by kind and name, its join keys, its primary key and
// other models' joins to it, by the rules sl validate checks ignored_columns with.
function readers(model: Model, column: string, others: Model[], dialect: string | undefined): string[] {
  const one: SnapshotTable = { schema: null, name: model.model, kind: "table", columns: [{ name: column, type: "" }] };
  const joinNames = (model.joins ?? []).map((j) => ({ ...j, keys: [] }));
  const reads = (m: Partial<Model>, extra: string[] = []) =>
    referencedColumns({ ...model, dimensions: [], measures: [], primary_key: [], ...m } as Model, one, dialect as never, extra).length > 0;
  const out: string[] = [];
  for (const d of model.dimensions ?? []) if (reads({ dimensions: [d], joins: joinNames })) out.push(`dimension ${d.name}`);
  for (const m of model.measures ?? []) if (reads({ measures: [m], joins: joinNames })) out.push(`measure ${m.name}`);
  for (const j of model.joins ?? []) if (reads({ joins: [j] })) out.push(`the keys of join ${j.name}`);
  if (reads({ joins: joinNames, primary_key: model.primary_key })) out.push("the primary key");
  if (reads({ joins: joinNames }, incomingKeyColumns(model, others))) out.push("a join from another model");
  return out;
}

// The index a new entry takes so a sorted list stays sorted: before the first entry after it.
function sortedIndex(items: string[], value: string): number {
  const i = items.findIndex((x) => x > value);
  return i < 0 ? items.length : i;
}

const spec: CommandSpec = {
  summary: "Add a column to a model's ignored_columns: left out on purpose, so no field is drafted for it.",
  usage: "ignore-column --source <s> --model <m> --column <c> [--reason <text>]",
  options: { source: { type: "string" }, model: { type: "string" }, column: { type: "string" }, reason: { type: "string" } },
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const source = str(values, "source");
    const modelName = str(values, "model");
    let column = str(values, "column")?.trim();
    if (!source || !modelName || !column) throw new UserError("--source, --model and --column are required: sl ignore-column --source <s> --model <m> --column <c>.");
    const reason = str(values, "reason") === undefined ? undefined : oneLine(str(values, "reason")!);
    const config = loadSource(ctx.root, source);
    const { path, model } = loadModel(ctx.root, source, modelName);
    const ref = `${source}.${modelName}`;
    const snapshot = loadSnapshot(ctx.root, source);
    const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(model.table)) : undefined;
    // An ignored column is protected, so sample values the snapshot holds for it are redacted.
    let redact = false;
    if (table) {
      const col = table.columns.find((c) => c.name === column) ?? table.columns.find((c) => c.name.toLowerCase() === column!.toLowerCase());
      if (!col) throw new UserError(`${column} is not a column of ${model.table} in the snapshot. Run sl tables --source ${source} to see its tables, or sl introspect --source ${source} if it is new.`);
      column = col.name;
      redact = heldValues(col.profile, col.type) !== null;
    }
    const ignored = (model.ignored_columns ?? []).map(String);
    const result = { ref, column, ignored_columns: ignored };
    if (ignored.some((c) => c.toLowerCase() === column!.toLowerCase())) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, path), reapprove: [], ...result }));
      else ctx.out(`${column} is already in ${ref}'s ignored_columns; nothing changed. Next: sl status.`);
      return 0;
    }
    const others = listModels(ctx.root, source).map((l) => l.model).filter((m) => m.model !== modelName);
    const by = readers(model, column, others, config.dialect);
    if (by.length) {
      const fields = by.some((b) => b.startsWith("dimension ") || b.startsWith("measure "));
      throw new UserError(
        `Cannot ignore ${column}: in ${ref} it is read by ${by.join(", ")}. ` +
          (fields
            ? `Remove the field first, then ignore the column: sl remove-field is not in this version yet, so delete the field from ${relFile(ctx.root, path)} and run sl validate.`
            : "A column a key reads is in use, so it stays; nothing was changed. Next: sl status."),
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
    const lines = [`Added ${column} to ${ref}'s ignored_columns in ${outcome.file}; sl status and sl draft --new-columns skip it now.`];
    if (redact) lines.push(`The snapshot holds sample values of ${column}, which is protected now: run sl profile --source ${source} --redact to keep counts only.`);
    else lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

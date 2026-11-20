import { isMap, isSeq, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { commitEdit, fieldColumns, ignoredReads, ignoredRefusal, itemMap, locate, oneLine, placeKey, reapproveLines } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { findTable } from "../lib/naming.ts";
import { sqlNames } from "../lib/sql-names.ts";
import { readsText, sqlTextProblem } from "../lib/sql-text.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadProject, loadSnapshot, loadSource } from "../lib/project.ts";
import { findSegment, modelSegments, segmentNames } from "../lib/segments.ts";
import { NAME_PATTERN, PROTECTED_TAGS } from "../lib/types.ts";
import { heldValues } from "../lib/validate.ts";

const USAGE = "add-segment --source <s> --model <m> --name <segment> --filter <sql predicate> [--description <text>] [--replace]";
const usage = (message: string) => new UserError(message, "semlayer add-segment --help", "usage");

const spec: CommandSpec = {
  summary: "Add a named filter to a model (a segment) that its measures can name, checked as a measure filter is.",
  usage:
    `${USAGE}\n\n` +
    "A segment is a condition the owner states once, such as completed orders, that several measures of the model name instead of repeating it:\n" +
    "semlayer add-segment --source warehouse --model orders --name sales --filter \"status in ('completed', 'shipped')\".\n" +
    "The filter is checked as a measure filter is: the model's own columns and join references, one read-only expression, no subquery, no ignored column.\n" +
    "A measure names it with semlayer set <s>.<m>.<measure> segments '[sales]'. The filter is part of the approval hash of each measure that names it.\n" +
    "--replace changes the filter or description of a segment the model already declares. An approved measure that names the segment is then changed since its approval:\n" +
    "the output lists each by name, and each is read back and approved again only on the owner's yes.",
  options: { source: { type: "string" }, model: { type: "string" }, name: { type: "string" }, filter: { type: "string" }, description: { type: "string" }, replace: { type: "boolean" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, modelName, name] = ["source", "model", "name"].map((k) => str(values, k)?.trim());
    const filter = str(values, "filter") === undefined ? undefined : oneLine(str(values, "filter")!);
    if (!source || !modelName || !name || !filter) {
      throw usage(`Usage: semlayer ${USAGE}, for example semlayer add-segment --source warehouse --model orders --name sales --filter "status in ('completed', 'shipped')".`);
    }
    if (!NAME_PATTERN.test(name)) throw usage(`--name "${name}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as sales.`);
    const description = str(values, "description") === undefined ? undefined : oneLine(str(values, "description")!);
    const replace = bool(values, "replace");

    const modelRef = `${source}.${modelName}`;
    const ref = `${modelRef}.${name}`;
    let loc: ReturnType<typeof locate>;
    try {
      loc = locate(ctx.root, modelRef);
    } catch (e) {
      if (e instanceof UserError && !e.next) throw new UserError(e.message, "semlayer status", e.code);
      throw e;
    }
    if (loc.kind !== "model") throw new UserError(`--source and --model name a model, such as --source warehouse --model orders; ${modelRef} is not one.`, "semlayer status");
    const model = loc.model!;
    const existing = findSegment(model, name);
    if (existing && !replace) {
      throw new UserError(
        `${modelRef} already declares a segment "${name}" (filter: ${existing.filter}). Nothing was written. To change it, run this again with --replace; ` +
          "an approved measure that names it is then changed since its approval and is read back again. To keep it, pick another --name.",
        "semlayer add-segment --help",
        "segment_exists",
      );
    }
    if (!existing && replace) {
      throw new UserError(
        `${modelRef} declares no segment "${name}" to replace${modelSegments(model).length ? ` (its segments are ${modelSegments(model).map((s) => s.name).join(", ")})` : ""}. Nothing was written. Run this again without --replace to add it.`,
        "semlayer add-segment --help",
        "segment_missing",
      );
    }

    const config = loadSource(ctx.root, source);
    // One read-only expression with no subquery, as validate reads a measure filter, checked before its names are.
    const problem = readsText(config.dialect) ? sqlTextProblem(filter, "measure filter") : undefined;
    if (problem) throw new UserError(`The filter ${problem}. Nothing was written. A segment is one SQL predicate, as a measure filter is.`, "semlayer add-segment --help", "expr.not_one_expression");
    if (sqlNames(filter, config.dialect).subquery) {
      throw new UserError(
        "The filter has a subquery; a segment may name only this model's columns and <join>.<column> join references through many_to_one or one_to_one joins. Nothing was written. " +
          "For a rule that needs anything else, add a join to the model first (semlayer add-join --help).",
        "semlayer add-segment --help",
        "expr.subquery",
      );
    }
    // A dotted name that is neither a column nor a join is refused when the edit is validated, as it
    // is in a measure filter. A bare name is not judged here: SQL keywords and columns cannot be told
    // apart by name, so semlayer check-rule runs the filter against the database instead.
    const snapshot = loadSnapshot(ctx.root, source);
    const table = Array.isArray(snapshot?.tables) ? findTable(snapshot.tables, String(model.table)) : undefined;
    const warnings: string[] = [`To see the filter run against the database before a measure names it: semlayer check-rule --source ${source} --model ${modelName} --filter ${JSON.stringify(filter)}`];

    // A column the owner left out of the layer on purpose is not read through a segment either.
    const models = listModels(ctx.root, source).map((l) => l.model);
    const reads = ignoredReads(model, models, [filter]);
    if (reads.length) throw ignoredRefusal(source, `The segment ${ref}`, reads);

    // The measures of the model that name the segment now, approved ones first told apart by the commit's reapprove list.
    const users = (model.measures ?? []).filter((m) => segmentNames(m).includes(name)).map((m) => `${modelRef}.${m.name}`);
    const kept = description === undefined ? existing?.description : description;
    const entry: Record<string, unknown> = { name, filter, ...(kept ? { description: kept } : {}) };

    let outcome: ReturnType<typeof commitEdit>;
    try {
      outcome = commitEdit(ctx.root, loc.file, `${replace ? "replace" : "add"} segment ${ref}`, (doc) => {
        const root = itemMap(doc, []);
        const list = root.get("segments", true);
        if (existing) {
          if (!isSeq(list)) throw new UserError(`Cannot edit segments in ${loc.file}: it is not a list.`);
          const at = (list as YAMLSeq).items.findIndex((i) => isMap(i) && (i as YAMLMap).get("name") === name);
          const node = (list as YAMLSeq).items[at];
          if (!isMap(node)) throw new UserError(`Cannot edit segment ${name} in ${loc.file}: it is not a mapping.`);
          node.set("filter", filter);
          if (description !== undefined) {
            if (description) node.set("description", description);
            else node.delete("description");
          }
          return;
        }
        const node = doc.createNode(entry) as Node;
        if (isSeq(list) && (list as YAMLSeq).items.length) (list as YAMLSeq).items.push(node);
        else {
          const created = doc.createNode([]) as YAMLSeq;
          created.items.push(node);
          placeKey(doc, root, "segments", created, ["default_time_dimension", "ignored_columns", "primary_key"], ["dimensions", "measures", "joins"]);
        }
      });
    } catch (e) {
      // The validation refusal keeps its code and names the command that fixes the filter.
      if (e instanceof UserError && !e.next) throw new UserError(e.message, "semlayer add-segment --help", e.code);
      throw e;
    }

    // A protected measure's segment reads protected columns as the measure's filter does: counts only once redacted.
    const tagged = (t: unknown) => Array.isArray(t) && t.some((x) => (PROTECTED_TAGS as readonly string[]).includes(String(x)));
    const protectedUse = tagged(model.tags) || (model.measures ?? []).some((m) => segmentNames(m).includes(name) && tagged(m.tags));
    const redact =
      protectedUse &&
      fieldColumns(model, "measure", { name: "segment", agg: "count", filter }, table, config.dialect).some((c) => {
        const col = table?.columns.find((x) => x.name === c);
        return !!col && heldValues(col.profile, col.type) !== null;
      });

    const affected = outcome.reapprove;
    const next = affected.length ? `semlayer readback --targets ${affected.join(",")}` : users.length ? `semlayer readback --targets ${users.join(",")}` : `semlayer set ${modelRef}.<measure> segments '[${name}]'`;
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, segment: entry, replaced: !!existing, measures: users, affected, redact, warnings, next }));
      return 0;
    }
    const lines = [`${existing ? "Replaced" : "Added"} segment ${name} on ${modelRef} in ${outcome.file}: ${filter}.`];
    if (!existing) lines.push(`No measure names it yet: name it with semlayer set ${modelRef}.<measure> segments '[${name}]'.`);
    else if (!users.length) lines.push("No measure names it, so no approval is affected.");
    lines.push(...warnings);
    if (redact) lines.push(`A protected measure names it and the snapshot holds sample values of a column it reads: run semlayer profile --source ${source} --redact to keep counts only.`);
    lines.push(...reapproveLines(affected));
    lines.push(`Next: ${next}${affected.length || users.length ? ", read the conditions back to the owner, and approve each measure again only on their yes (semlayer approve --target <measure> --by \"<owner>\")" : ""}.`);
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

import { isSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { commitEdit, inTurnApply, itemMap, locate, reapproveLines } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { listGoldens, loadProject } from "../lib/project.ts";
import { parseRequestField } from "../lib/refs.ts";
import { findSegment, segmentNames } from "../lib/segments.ts";

const USAGE = "remove-segment --source <s> --model <m> --name <segment>";

const spec: CommandSpec = {
  summary: "Remove a segment from a model, refusing while a measure or a golden's request still names it.",
  usage:
    `${USAGE}\n\n` +
    "Refuses, naming each, while a measure of the model lists the segment in its segments or a golden's request names it as model.segment; take it out of each first\n" +
    "(semlayer set <s>.<m>.<measure> segments '[...]', semlayer goldens new for a request), then run this again.",
  options: { source: { type: "string" }, model: { type: "string" }, name: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [source, modelName, name] = ["source", "model", "name"].map((k) => str(values, k)?.trim());
    if (!source || !modelName || !name) {
      throw new UserError(`Usage: semlayer ${USAGE}, for example semlayer remove-segment --source warehouse --model orders --name sales.`, "semlayer remove-segment --help", "usage");
    }
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
    if (!findSegment(model, name)) {
      throw new UserError(`${modelRef} declares no segment "${name}". Nothing was written. Its segments are ${(model.segments ?? []).map((s) => s.name).join(", ") || "none"}.`, "semlayer status", "segment_missing");
    }

    const holders = [
      ...(model.measures ?? []).filter((m) => segmentNames(m).includes(name)).map((m) => `measure ${modelRef}.${m.name}${m.status === "approved" ? " (approved)" : ""}`),
      ...listGoldens(ctx.root).flatMap(({ path, golden }) => {
        const request = golden?.request;
        if (!request || request.source !== source) return [];
        const hit = (request.segments ?? []).some((s) => {
          const p = parseRequestField(s);
          return p?.model === modelName && p.field === name;
        });
        return hit ? [`golden ${golden.name ?? path}`] : [];
      }),
    ];
    if (holders.length) {
      const measures = (model.measures ?? []).filter((m) => segmentNames(m).includes(name));
      const edits = measures.map((m) => ["set", `${modelRef}.${m.name}`, "segments", `[${segmentNames(m).filter((n) => n !== name).join(", ")}]`]);
      throw new UserError(
        `Cannot remove ${ref}: ${holders.length === 1 ? "this names" : "these name"} it, so nothing was written:\n${holders.map((h) => `  - ${h}`).join("\n")}\n` +
          `Take it out of each first${edits.length ? ` (${inTurnApply(edits)})` : ""}; a golden's request is changed with semlayer goldens new, then run this again.`,
        `semlayer status`,
        "segment_in_use",
      );
    }

    const outcome = commitEdit(ctx.root, loc.file, `remove segment ${ref}`, (doc) => {
      const root = itemMap(doc, []);
      const list = root.get("segments", true);
      if (!isSeq(list)) throw new UserError(`Cannot edit segments in ${modelRef}: it is not a list.`);
      const at = model.segments!.findIndex((s) => s.name === name);
      list.items.splice(at, 1);
      if (!list.items.length) root.delete("segments");
    });
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ref, next: "semlayer status" }));
      return 0;
    }
    ctx.out([`Removed segment ${name} from ${modelRef} in ${outcome.file}.`, ...reapproveLines(outcome.reapprove), "Next: semlayer status."].join("\n"));
    return 0;
  },
};
export default spec;

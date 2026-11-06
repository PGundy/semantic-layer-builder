import type { CommandSpec } from "../lib/command.ts";
import { list } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { nextReadbackId, renderReadbacks, writePending } from "../lib/readback.ts";
import type { PendingReadback } from "../lib/types.ts";

const spec: CommandSpec = {
  summary: "Render a plain-English readback of approve targets and store it in .sl/pending/ for the owner's answer.",
  usage:
    "readback --targets <ref>,<ref>,...\n\n" +
    "Each ref is an approve target: source.model, source.model.field, metric:<name> or access. Writes\n" +
    ".sl/pending/<readback_id>.json with the numbered items and each item's content hash.",
  options: {
    targets: { type: "string", multiple: true },
  },
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const refs = list(values, "targets");
    if (!refs.length) {
      throw new UserError("--targets is required: a comma-separated list of source.model, source.model.field, metric:<name> or access. Run sl status to see them.");
    }
    const rendered = renderReadbacks(ctx.root, refs);
    const pending: PendingReadback = {
      readback_id: nextReadbackId(ctx.root),
      created_at: ctx.now().toISOString(),
      items: rendered.map((r, i) => ({ n: i + 1, target: r.target, kind: "approve" as const, text: r.text, content_hash: r.content_hash })),
    };
    const path = writePending(ctx.root, pending);
    if (ctx.json) {
      ctx.out(formatJson({ readback_id: pending.readback_id, path, items: pending.items }));
      return 0;
    }
    const lines = [`Readback ${pending.readback_id}, stored in ${path}. Read each item to the owner as written, ending with "Approve?".`, ""];
    for (const item of pending.items) {
      const [head, ...rest] = item.text.split("\n");
      lines.push(`${item.n}. ${head}`, ...rest.map((l) => `   ${l}`), "");
    }
    lines.push(
      "Only after the owner says yes to an item, approve it: " +
        pending.items.map((i) => `sl approve --target ${i.target} --by "<owner>"`).join("; ") +
        ". A no or a change goes into the YAML, then run sl readback again.",
    );
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

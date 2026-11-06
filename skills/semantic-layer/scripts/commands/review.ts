import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import {
  assertCurrent,
  buildReviewForm,
  loadPending,
  REVIEW_FORMATS,
  type ReviewFormat,
  renderReviewJson,
  renderReviewMarkdown,
  reviewPath,
} from "../lib/review.ts";
import { schemaIssues } from "../lib/validate.ts";
import { COMMANDS } from "./index.ts";

// sl review export: writes a pending readback as a form the owner fills in.
async function exportForm(values: OptionValues, ctx: CommandContext): Promise<number> {
  const id = str(values, "readback");
  if (!id) throw new UserError("sl review export needs --readback <readback_id>, such as rb_0001; sl readback prints it.");
  const format = str(values, "format");
  if (!format || !(REVIEW_FORMATS as readonly string[]).includes(format))
    throw new UserError(`sl review export needs --format md (for the owner to read and fill in) or --format json (for a tool).`);
  const pending = loadPending(ctx.root, id);
  assertCurrent(ctx.root, pending);
  const target = reviewPath(ctx.root, id, format as ReviewFormat, str(values, "out"), bool(values, "force"));
  const form = buildReviewForm(ctx.root, pending, ctx.now().toISOString());
  const issues = schemaIssues("review", form, "the review form");
  if (issues.length)
    throw new UserError(`The review form for ${id} would not be valid (${issues.map((x) => `${x.path || "(top)"} ${x.message}`).join("; ")}). Run sl validate to find the YAML that causes it, fix it, then export again.`);
  const text = format === "md" ? renderReviewMarkdown(form) : renderReviewJson(form);
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, text, { flag: bool(values, "force") ? "w" : "wx" });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    throw new UserError(`${target} was written by another run just now; pass --force to replace it, or --out <another path>.`);
  }
  const path = relative(ctx.root, target).split("\\").join("/");
  const record =
    "reply" in COMMANDS
      ? `record each answer with sl reply --readback ${id} --item <n> --text "<the owner's words>" --verdict yes|no|change`
      : `approve each item the owner marked yes with sl approve --target <target> --by "<owner>", and put a no or a change into the YAML, then run sl readback again`;
  const next = `Send ${path} to the owner to fill in. When the owner returns it, ${record}.`;
  if (ctx.json) {
    ctx.out(formatJson({ readback_id: id, format, path, item_count: form.items.length, question_count: form.questions.length, next }));
    return 0;
  }
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  ctx.out(`Wrote the review form for ${id} (${n(form.items.length, "item")}, ${n(form.questions.length, "open question")}) to ${path}.\n${next}`);
  return 0;
}

const SUBCOMMANDS: Record<string, (values: OptionValues, ctx: CommandContext) => Promise<number>> = { export: exportForm };

const spec: CommandSpec = {
  summary: "Write a pending readback as a form the owner fills in: a verdict and an answer per item, and the open questions.",
  usage:
    "review export --readback <readback_id> --format md|json [--out <path>] [--force]\n\n" +
    "Writes .sl/reviews/<readback_id>.<md|json>, or --out (a path inside the semantic root), never over an\n" +
    "existing file unless --force. Markdown is for the owner to fill in; JSON is for a tool.",
  options: {
    readback: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
  },
  positionals: true,
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [sub, ...extra] = positionals;
    const run = sub ? SUBCOMMANDS[sub] : undefined;
    if (!run || extra.length) throw new UserError(`Usage: sl review ${Object.keys(SUBCOMMANDS).join("|")} --readback <readback_id> --format md|json [--out <path>] [--force].`);
    return run(values, ctx);
  },
};
export default spec;

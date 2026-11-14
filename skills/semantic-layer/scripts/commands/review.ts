import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { bool, str } from "../lib/command.ts";
import { oneLine } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { writeFileAtomic } from "../lib/lock.ts";
import { LEDGER_FILE, ownerText } from "../lib/ledger.ts";
import { formatJson, plainText } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import {
  applyReview,
  assertCurrent,
  buildReviewForm,
  loadPending,
  readReviewFile,
  REVIEW_FORMATS,
  type ReviewFormat,
  renderReviewJson,
  renderReviewMarkdown,
  reviewPath,
} from "../lib/review.ts";
import { schemaIssues } from "../lib/validate.ts";

const USAGE =
  'Usage: sl review export --readback <readback_id> --format md|json [--out <path>] [--force], or sl review apply <file> --by "<owner>".';

// sl review export: writes a pending readback as a form the owner fills in.
async function exportForm(args: string[], values: OptionValues, ctx: CommandContext): Promise<number> {
  if (args.length) throw new UserError(USAGE);
  if (str(values, "by") !== undefined) throw new UserError('sl review export takes no --by; that flag is for sl review apply <file> --by "<owner>".');
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
    writeFileAtomic(target, text, { exclusive: !bool(values, "force") });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    throw new UserError(`${target} was written by another run just now; pass --force to replace it, or --out <another path>.`);
  }
  const path = relative(ctx.root, target).split("\\").join("/");
  const next = `Send ${path} to the owner to fill in. When the owner returns it, record the answers with sl review apply ${relative(ctx.cwd, target).split("\\").join("/") || target} --by "<owner>".`;
  if (ctx.json) {
    ctx.out(formatJson({ readback_id: id, format, path, item_count: form.items.length, question_count: form.questions.length, next }));
    return 0;
  }
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  ctx.out(`Wrote the review form for ${id} (${n(form.items.length, "item")}, ${n(form.questions.length, "open question")}) to ${path}.\n${next}`);
  return 0;
}

// sl review apply: records a filled form's answers in the ledger, as sl reply and sl question
// resolve do, refusing an item whose hash changed since export. It never approves.
async function applyForm(args: string[], values: OptionValues, ctx: CommandContext): Promise<number> {
  const byRaw = str(values, "by");
  if (args.length !== 1 || byRaw === undefined) throw new UserError(USAGE);
  for (const flag of ["readback", "format", "out", "force"])
    if (values[flag] !== undefined) throw new UserError(`sl review apply takes no --${flag}; the form names its readback. Usage: sl review apply <file> --by "<owner>".`);
  const by = ownerText(oneLine(byRaw)).text;
  if (!by) throw new UserError('--by is empty; give the name of the owner who filled in the form (--by "<owner>").');
  const form = readReviewFile(ctx.cwd, args[0]!);
  const r = applyReview(ctx.root, form, by, ctx.now().toISOString());
  const next = r.next_steps[0]!;
  if (ctx.json) {
    ctx.out(formatJson({ ...r, file: args[0], ledger_path: LEDGER_FILE, next }));
    return 0;
  }
  const item = (x: { item: number; target: string }) => `item ${x.item} (${x.target})`;
  const verdict = (v: string | null) => (v === null ? "no verdict" : `verdict ${v}`);
  const q = (x: { ref: string; question: string }) => {
    const t = plainText(x.question).replace(/\s+/g, " ").trim();
    return `${x.ref}: ${t.length > 100 ? `${t.slice(0, 99)}…` : t}`;
  };
  const lines = [`Applied ${args[0]}, ${by}'s review of ${r.readback_id}.`];
  const section = (head: string, rows: string[]) => rows.length && lines.push(head, ...rows.map((x) => `  - ${x}`));
  section(
    `Recorded in ${LEDGER_FILE}:`,
    r.recorded.map((e) => (e.kind === "reply" ? `${e.id}: ${item(e)}, ${verdict(e.verdict)}` : `${e.id}: resolved the open question of ${q({ ref: e.target, question: e.question })}`)),
  );
  section("Already recorded, so not recorded again:", r.already_recorded.map((x) => `${item(x)}, ${verdict(x.verdict)} (${x.id})`));
  section("Already resolved, so not recorded again:", r.questions_already_resolved.map((x) => `${q(x)} (${x.id})`));
  section("Refused, nothing recorded:", r.refused.map((x) => `${item(x)}: ${x.reason}`));
  section("Not open any more (resolved or edited since export), nothing recorded:", r.questions_not_found.map(q));
  section("Still needs an answer:", [...r.unanswered.items.map(item), ...r.unanswered.questions.map((x) => `open question of ${q(x)}`)]);
  if (!r.recorded.length) lines.push("Nothing was recorded.");
  if (r.redacted) lines.push("Warning: an answer held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential.");
  lines.push("This records answers only and approves nothing. Next:", ...r.next_steps.map((x) => `  - ${x}`));
  ctx.out(lines.join("\n"));
  return 0;
}

const SUBCOMMANDS: Record<string, (args: string[], values: OptionValues, ctx: CommandContext) => Promise<number>> = { export: exportForm, apply: applyForm };

const spec: CommandSpec = {
  summary: "Write a pending readback as a form the owner fills in, or record a filled form's answers in the ledger.",
  usage:
    "review export --readback <readback_id> --format md|json [--out <path>] [--force]\n" +
    '       review apply <file> --by "<owner>"\n\n' +
    "export writes .sl/reviews/<readback_id>.<md|json>, or --out (a path inside the semantic root), never over\n" +
    "an existing file unless --force. Markdown is for the owner to fill in; JSON is for a tool.\n" +
    "apply reads a filled form (.md or .json, from any path) and records each answer as sl reply and\n" +
    "sl question resolve do, refusing an item that changed since export. It never approves.",
  options: {
    readback: { type: "string" },
    format: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean" },
    by: { type: "string" },
  },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [sub, ...args] = positionals;
    const run = sub ? SUBCOMMANDS[sub] : undefined;
    if (!run) throw new UserError(USAGE);
    return run(args, values, ctx);
  },
};
export default spec;

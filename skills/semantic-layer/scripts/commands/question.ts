import { isSeq } from "yaml";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { commitEdit, itemMap, locate, oneLine, placeKey, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

// sl question add: appends an open question to a model's open_questions (a field's goes to its
// model, starting "<field>: ") or to access.yaml's top-level open_questions.
async function add(ref: string | undefined, values: OptionValues, ctx: CommandContext): Promise<number> {
  const raw = str(values, "text");
  if (!ref || raw === undefined) throw new UserError('Usage: sl question add <source.model | source.model.field | access> --text "<question>".');
  const text = oneLine(raw);
  if (!text) throw new UserError("--text is empty; write the question as the owner should read it.");
  const loc = locate(ctx.root, ref);
  if (loc.kind === "metric")
    throw new UserError("A metric has no open questions; ask it on the model of one of its measures (sl question add <source.model> --text ...).");
  const field = loc.kind === "model" || loc.kind === "access" ? undefined : String(loc.item.name);
  const question = field && !text.startsWith(`${field}: `) ? `${field}: ${text}` : text;
  const fileRef = field ? ref.split(".").slice(0, 2).join(".") : ref;
  const holder = field ? (loc.model as unknown as Record<string, unknown>) : loc.item;
  const current = Array.isArray(holder.open_questions) ? holder.open_questions.map(String) : [];
  const result = { ref, question, open_questions: current.includes(question) ? current : [...current, question] };
  if (current.includes(question)) {
    if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, loc.file), reapprove: [], ...result }));
    else ctx.out(`${fileRef} already has that open question; nothing changed. Next: sl status.`);
    return 0;
  }
  const outcome = commitEdit(ctx.root, loc.file, `add an open question to ${fileRef}`, (doc) => {
    const map = itemMap(doc, []);
    const node = map.get("open_questions", true);
    if (isSeq(node)) return void node.items.push(doc.createNode(question));
    if (loc.kind === "access") placeKey(doc, map, "open_questions", [question], []);
    else placeKey(doc, map, "open_questions", [question], [], ["ignored_columns", "dimensions", "measures", "joins"]);
  });
  if (ctx.json) {
    ctx.out(formatJson({ ...outcome, ...result }));
    return 0;
  }
  ctx.out(`Added an open question to ${fileRef} in ${outcome.file}: ${question}\nAsk the owner; sl status lists the open questions. Next: sl status.`);
  return 0;
}

const SUBCOMMANDS: Record<string, (ref: string | undefined, values: OptionValues, ctx: CommandContext) => Promise<number>> = { add };

const spec: CommandSpec = {
  summary: "Add an open question for the owner to a model or access.yaml.",
  usage: 'question add <source.model | source.model.field | access> --text "<question>"',
  options: { text: { type: "string" } },
  positionals: true,
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [sub, ref, ...extra] = positionals;
    const run = sub ? SUBCOMMANDS[sub] : undefined;
    if (!run || extra.length) throw new UserError(`Usage: sl question ${Object.keys(SUBCOMMANDS).join("|")} <ref> --text "<question>".`);
    return run(ref, values, ctx);
  },
};
export default spec;

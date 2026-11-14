import { readFileSync } from "node:fs";
import { isSeq } from "yaml";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { locateRole } from "../lib/access-edit.ts";
import { commitEdit, itemMap, type Located, locate, oneLine, placeKey, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { writeFileAtomic } from "../lib/lock.ts";
import { LEDGER_FILE, openLedger, ownerText } from "../lib/ledger.ts";
import { formatJson, plainText } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";

// The item a question ref names; access.roles.<role> is that role of access.yaml.
function holderOf(root: string, ref: string): Located {
  const role = locateRole(root, ref);
  return role ? { ref, kind: "access", ...role } : locate(root, ref);
}

// sl question add: appends an open question to a model's open_questions (a field's goes to its
// model, starting "<field>: "), to access.yaml's top-level open_questions, or to one role's.
async function add(ref: string | undefined, values: OptionValues, ctx: CommandContext): Promise<number> {
  const raw = str(values, "text");
  if (!ref || raw === undefined) throw new UserError('Usage: sl question add <source.model | source.model.field | access | access.roles.<role>> --text "<question>".');
  for (const flag of ["index", "match", "by"]) if (str(values, flag) !== undefined) throw new UserError(`sl question add takes no --${flag}; that flag is for sl question resolve.`);
  const text = oneLine(raw);
  if (!text) throw new UserError("--text is empty; write the question as the owner should read it.");
  const loc = holderOf(ctx.root, ref);
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
    const map = itemMap(doc, loc.kind === "access" ? loc.path : []);
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

const RESOLVE_USAGE = 'Usage: sl question resolve <source.model | source.model.field | access | access.roles.<role>> (--index <n> | --match "<text>") --text "<the owner\'s answer>" --by "<owner>".';

// sl question resolve: removes one open question (for source.model.field, one of the model's that
// starts "<field>: ") and records it with the owner's answer in the ledger. The YAML edit validates
// first; the ledger line is appended after it is written, and a failed append puts the file back.
async function resolveQuestion(ref: string | undefined, values: OptionValues, ctx: CommandContext): Promise<number> {
  const [raw, byRaw, index, match] = [str(values, "text"), str(values, "by"), str(values, "index"), str(values, "match")];
  if (!ref || raw === undefined || byRaw === undefined || (index === undefined) === (match === undefined)) throw new UserError(RESOLVE_USAGE);
  const loc = holderOf(ctx.root, ref);
  if (loc.kind === "metric") throw new UserError("A metric has no open questions; they are on the models of its measures (sl status lists them).");
  const field = loc.kind === "model" || loc.kind === "access" ? undefined : String(loc.item.name);
  const fileRef = field ? ref.split(".").slice(0, 2).join(".") : ref;
  const holder = field ? (loc.model as unknown as Record<string, unknown>) : loc.item;
  const current = Array.isArray(holder.open_questions) ? holder.open_questions.map(String) : [];
  const candidates = current.map((q, pos) => ({ q, pos })).filter((c) => !field || c.q.startsWith(`${field}: `));
  const listed = candidates.map((c, i) => `${i + 1}. ${plainText(c.q)}`).join("\n");
  const which = field ? `${fileRef} has no open question for ${field}` : `${fileRef} has no open questions`;
  if (!candidates.length) throw new UserError(`${which}; nothing to resolve. Run sl status to see the open questions.`);
  let picked: { q: string; pos: number }[];
  if (index !== undefined) {
    const n = /^\d+$/.test(index.trim()) ? Number(index.trim()) : 0;
    picked = n >= 1 && n <= candidates.length ? [candidates[n - 1]!] : [];
    if (!picked.length) throw new UserError(`--index is 1 to ${candidates.length} for ${ref}, whose open questions are:\n${listed}`);
  } else {
    const needle = oneLine(match!).toLowerCase();
    picked = needle ? candidates.filter((c) => oneLine(c.q).toLowerCase().includes(needle)) : [];
    if (picked.length !== 1)
      throw new UserError(`--match ${JSON.stringify(match)} matches ${picked.length ? `${picked.length} open questions` : "no open question"} of ${ref}; pass --index <n> or a longer --match. Its open questions are:\n${listed}`);
  }
  const { q, pos } = picked[0]!;
  const { text, redacted } = ownerText(raw);
  if (!text) throw new UserError("--text is empty; record the owner's answer as they gave it.");
  const by = ownerText(oneLine(byRaw)).text;
  if (!by) throw new UserError('--by is empty; give the name of the owner who answered (--by "<owner>").');
  const ledger = openLedger(ctx.root);
  const before = readFileSync(loc.file, "utf8");
  const outcome = commitEdit(ctx.root, loc.file, `resolve an open question of ${fileRef}`, (doc) => {
    const map = itemMap(doc, loc.kind === "access" ? loc.path : []);
    const node = map.get("open_questions", true);
    if (!isSeq(node) || node.items.length !== current.length) throw new UserError(`${relFile(ctx.root, loc.file)} changed while it was read; run this again.`);
    node.items.splice(pos, 1);
    if (!node.items.length) map.delete("open_questions");
  });
  const question = plainText(q).trim();
  let entry;
  try {
    entry = ledger.append({ kind: "question", target: ref, question, text, by, at: ctx.now().toISOString() });
  } catch (e) {
    writeFileAtomic(loc.file, before);
    throw new UserError(`Could not append to ${LEDGER_FILE} (${(e as Error).message}), so ${outcome.file} was put back as it was; nothing changed. Fix the ledger file and run this again.`);
  }
  const remaining = current.filter((_, i) => i !== pos);
  if (ctx.json) {
    ctx.out(formatJson({ ...outcome, ref, question, open_questions: remaining, ledger_id: entry.id, ledger_path: LEDGER_FILE, entry, redacted }));
    return 0;
  }
  const lines = [`Resolved an open question of ${fileRef} in ${outcome.file}: ${plainText(q)}`, `Recorded the owner's answer as ${entry.id} in ${LEDGER_FILE}.`];
  if (redacted) lines.push("Warning: the answer held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential.");
  lines.push(`If the answer changes the layer, make that change with a typed edit (sl set, sl tag, sl question add) and read it back with sl readback --targets ${fileRef}. Next: sl status.`);
  ctx.out(lines.join("\n"));
  return 0;
}

const SUBCOMMANDS: Record<string, (ref: string | undefined, values: OptionValues, ctx: CommandContext) => Promise<number>> = { add, resolve: resolveQuestion };

const spec: CommandSpec = {
  summary: "Add an open question for the owner to a model or access.yaml, or resolve one into the answer ledger.",
  usage:
    'question add <source.model | source.model.field | access | access.roles.<role>> --text "<question>"\n' +
    '       question resolve <source.model | source.model.field | access | access.roles.<role>> (--index <n> | --match "<text>") --text "<the owner\'s answer>" --by "<owner>"\n\n' +
    "resolve removes the question from the file and appends it, with the owner's answer, to .sl/ledger.jsonl.",
  options: { text: { type: "string" }, index: { type: "string" }, match: { type: "string" }, by: { type: "string" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [sub, ref, ...extra] = positionals;
    const run = sub ? SUBCOMMANDS[sub] : undefined;
    if (!run || extra.length) throw new UserError(`Usage: sl question ${Object.keys(SUBCOMMANDS).join("|")} <ref> --text "<text>"; resolve also takes --index <n> or --match "<text>", and --by "<owner>".`);
    return run(ref, values, ctx);
  },
};
export default spec;

import { readFileSync } from "node:fs";
import { type Document, isSeq } from "yaml";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { locateRole } from "../lib/access-edit.ts";
import { commitEdit, commitEdits, itemMap, type Located, locate, oneLine, placeKey, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { writeFileAtomic } from "../lib/lock.ts";
import { LEDGER_FILE, openLedger, ownerText } from "../lib/ledger.ts";
import { readJsonObject, unknownKeys } from "../lib/json-input.ts";
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
  for (const flag of ["index", "match", "by", "answers"]) if (str(values, flag) !== undefined) throw new UserError(`sl question add takes no --${flag}; that flag is for sl question resolve.`);
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
const ANSWERS_USAGE =
  'Usage: sl question resolve --answers <file | -> holding {"by": "<owner>", "answers": [{"target": "<ref>", "match": "<question text>", "text": "<the owner\'s answer>"}, ' +
  '{"target": "<ref>", "index": <n>, "text": "<the owner\'s answer>"}]}.';

// One open question picked for resolving: where it is held and its place in that list.
interface Picked {
  ref: string;
  loc: Located;
  fileRef: string;
  // The list as the file holds it, and the picked question's place in it.
  current: string[];
  q: string;
  pos: number;
}

// The open question of `ref` that --index or --match picks, as sl question resolve picks it.
function pickQuestion(root: string, ref: string, index: string | undefined, match: string | undefined): Picked {
  const loc = holderOf(root, ref);
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
  return { ref, loc, fileRef, current, ...picked[0]! };
}

// Removes the picked questions from one file's document, each from its list by its place there; a
// list emptied takes its key with it.
function removeQuestions(root: string, picks: Picked[]): (doc: Document) => void {
  return (doc) => {
    const lists = new Map<string, Picked[]>();
    for (const p of picks) {
      const key = JSON.stringify(p.loc.kind === "access" ? p.loc.path : []);
      lists.set(key, [...(lists.get(key) ?? []), p]);
    }
    for (const [key, mine] of lists) {
      const map = itemMap(doc, JSON.parse(key) as (string | number)[]);
      const node = map.get("open_questions", true);
      if (!isSeq(node) || node.items.length !== mine[0]!.current.length) throw new UserError(`${relFile(root, mine[0]!.loc.file)} changed while it was read; run this again.`);
      for (const p of [...mine].sort((a, b) => b.pos - a.pos)) node.items.splice(p.pos, 1);
      if (!node.items.length) map.delete("open_questions");
    }
  };
}

// sl question resolve: removes one open question (for source.model.field, one of the model's that
// starts "<field>: ") and records it with the owner's answer in the ledger. The YAML edit validates
// first; the ledger line is appended after it is written, and a failed append puts the file back.
async function resolveQuestion(ref: string | undefined, values: OptionValues, ctx: CommandContext): Promise<number> {
  const answers = str(values, "answers");
  if (answers !== undefined) {
    const mixed = ["text", "by", "index", "match"].filter((f) => str(values, f) !== undefined);
    if (ref !== undefined || mixed.length)
      throw new UserError(`--answers takes no ${[...(ref !== undefined ? ["<ref>"] : []), ...mixed.map((f) => `--${f}`)].join(", ")}: the answers file holds each question's ref, which question, and the owner's answer. Nothing was written. ${ANSWERS_USAGE}`);
    return resolveAnswers(answers, ctx);
  }
  const [raw, byRaw, index, match] = [str(values, "text"), str(values, "by"), str(values, "index"), str(values, "match")];
  if (!ref || raw === undefined || byRaw === undefined || (index === undefined) === (match === undefined)) throw new UserError(RESOLVE_USAGE);
  const { loc, fileRef, current, q, pos } = pickQuestion(ctx.root, ref, index, match);
  const { text, redacted } = ownerText(raw);
  if (!text) throw new UserError("--text is empty; record the owner's answer as they gave it.");
  const by = ownerText(oneLine(byRaw)).text;
  if (!by) throw new UserError('--by is empty; give the name of the owner who answered (--by "<owner>").');
  const ledger = openLedger(ctx.root);
  const before = readFileSync(loc.file, "utf8");
  const outcome = commitEdit(ctx.root, loc.file, `resolve an open question of ${fileRef}`, removeQuestions(ctx.root, [{ ref, loc, fileRef, current, q, pos }]));
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

// sl question resolve --answers: every entry is picked and checked first, all or nothing; then each
// file's questions are removed in one validated edit and one ledger line per question is appended
// in one write, each the line the single form writes. A failed append puts every file back.
async function resolveAnswers(file: string, ctx: CommandContext): Promise<number> {
  const data = await readJsonObject(ctx, "answers", file, ANSWERS_USAGE);
  const fail = (why: string): never => {
    throw new UserError(`${why} Nothing was written. Fix it and run the same command again. ${ANSWERS_USAGE}`);
  };
  const extra = unknownKeys(data, ["by", "answers"]);
  if (extra.length) fail(`The answers file has key(s) ${extra.join(", ")}; it holds only "by" and "answers".`);
  const by = typeof data.by === "string" ? ownerText(oneLine(data.by)).text : "";
  if (!by) fail('"by" is missing or empty; give the name of the owner who answered.');
  if (!Array.isArray(data.answers) || !data.answers.length) fail('"answers" is missing or empty; give one entry per question the owner answered.');
  const picks: (Picked & { text: string; redacted: boolean })[] = [];
  (data.answers as unknown[]).forEach((raw, i) => {
    const at = `Entry ${i + 1} of "answers"`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`${at} is not an object.`);
    const e = raw as Record<string, unknown>;
    const bad = unknownKeys(e, ["target", "match", "index", "text"]);
    if (bad.length) fail(`${at} has key(s) ${bad.join(", ")}; an entry holds "target", "match" or "index", and "text".`);
    if (typeof e.target !== "string" || !e.target.trim()) fail(`${at} has no "target"; give the ref the question is on (source.model, source.model.field, access or access.roles.<role>).`);
    if ((e.match === undefined) === (e.index === undefined)) fail(`${at} gives ${e.match === undefined ? "neither" : "both"} "match" and "index"; give one.`);
    if (e.match !== undefined && typeof e.match !== "string") fail(`${at} has a "match" that is not text.`);
    if (e.index !== undefined && !(typeof e.index === "number" && Number.isInteger(e.index))) fail(`${at} has an "index" that is not a whole number.`);
    const { text, redacted } = typeof e.text === "string" ? ownerText(e.text) : { text: "", redacted: false };
    if (!text) fail(`${at} has no "text"; record the owner's answer as they gave it.`);
    let p: Picked;
    try {
      p = pickQuestion(ctx.root, (e.target as string).trim(), e.index === undefined ? undefined : String(e.index), e.match as string | undefined);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return fail(`${at} (${e.target as string}): ${err.message.replace(/--(index|match)\b/g, '"$1"')}`);
    }
    const twice = picks.findIndex((o) => o.loc.file === p.loc.file && JSON.stringify(o.loc.kind === "access" ? o.loc.path : []) === JSON.stringify(p.loc.kind === "access" ? p.loc.path : []) && o.pos === p.pos);
    if (twice >= 0) fail(`${at} picks the same open question as entry ${twice + 1} (${plainText(p.q)}); give each question once.`);
    picks.push({ ...p, text, redacted });
  });
  const ledger = openLedger(ctx.root);
  const files = [...new Set(picks.map((p) => p.loc.file))];
  const before = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const what = `resolve ${picks.length} open question${picks.length === 1 ? "" : "s"}`;
  const outcome = commitEdits(ctx.root, files.map((f) => ({ file: f, edit: removeQuestions(ctx.root, picks.filter((p) => p.loc.file === f)) })), what);
  const at = ctx.now().toISOString();
  let entries;
  try {
    entries = ledger.appendAll(picks.map((p) => ({ kind: "question" as const, target: p.ref, question: plainText(p.q).trim(), text: p.text, by, at })));
  } catch (e) {
    for (const [f, text] of before) writeFileAtomic(f, text);
    throw new UserError(`Could not append to ${LEDGER_FILE} (${(e as Error).message}), so ${outcome.files.join(", ")} ${outcome.files.length === 1 ? "was" : "were"} put back as ${outcome.files.length === 1 ? "it was" : "they were"}; nothing changed. Fix the ledger file and run this again.`);
  }
  const redacted = picks.some((p) => p.redacted);
  if (ctx.json) {
    ctx.out(formatJson({ ...outcome, ids: entries.map((e) => e.id), ledger_path: LEDGER_FILE, entries, redacted }));
    return 0;
  }
  const span = entries.length === 1 ? entries[0]!.id : `${entries[0]!.id} to ${entries[entries.length - 1]!.id}`;
  const lines = [`Resolved ${picks.length} open question${picks.length === 1 ? "" : "s"} in ${outcome.files.join(", ")} and recorded ${by}'s answers as ${span} in ${LEDGER_FILE}:`];
  for (const p of picks) lines.push(`  - ${p.fileRef}: ${plainText(p.q)}`);
  if (redacted) lines.push("Warning: an answer held what looks like a credential; it was stored as [redacted]. Ask the owner to change that credential.");
  const refs = [...new Set(picks.map((p) => p.fileRef))];
  lines.push(`If an answer changes the layer, make those changes with one sl apply --file - and read them back with sl readback --targets ${refs.join(",")}. Next: sl status.`);
  ctx.out(lines.join("\n"));
  return 0;
}

const SUBCOMMANDS: Record<string, (ref: string | undefined, values: OptionValues, ctx: CommandContext) => Promise<number>> = { add, resolve: resolveQuestion };

const spec: CommandSpec = {
  summary: "Add an open question for the owner to a model or access.yaml, or resolve one into the answer ledger.",
  usage:
    'question add <source.model | source.model.field | access | access.roles.<role>> --text "<question>"\n' +
    '       question resolve <source.model | source.model.field | access | access.roles.<role>> (--index <n> | --match "<text>") --text "<the owner\'s answer>" --by "<owner>"\n' +
    "       question resolve --answers <file | ->\n\n" +
    "resolve removes the question from the file and appends it, with the owner's answer, to .sl/ledger.jsonl.\n" +
    "--answers resolves every question one owner turn answered: the file, or stdin with -, holds\n" +
    '  {"by": "<owner>", "answers": [{"target": "<ref>", "match": "<question text>", "text": "<the owner\'s answer>"},\n' +
    '                                {"target": "<ref>", "index": <n>, "text": "<the owner\'s answer>"}]}\n' +
    "each picked and resolved as the single form does, an \"index\" counting in each list as it stands before this command;\n" +
    "every entry is checked first, and all of them land or none do.",
  options: { text: { type: "string" }, index: { type: "string" }, match: { type: "string" }, by: { type: "string" }, answers: { type: "string", mcp: "omit" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const [sub, ref, ...extra] = positionals;
    const run = sub ? SUBCOMMANDS[sub] : undefined;
    if (!run || extra.length) throw new UserError(`Usage: sl question ${Object.keys(SUBCOMMANDS).join("|")} <ref> --text "<text>"; resolve also takes --index <n> or --match "<text>", and --by "<owner>", or --answers <file | -> alone.`);
    return run(ref, values, ctx);
  },
};
export default spec;

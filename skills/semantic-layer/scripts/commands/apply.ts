import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { accessDraftLines, batchEntry, issueLine, reapproveLines, runBatch, ValueRefusal, warningIssues } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { APPLY_COMMANDS, applyEntryRefusal } from "../lib/roles.ts";
import { COMMANDS } from "./index.ts";

const USAGE = 'Usage: semlayer apply --file <path>, or --file - to read stdin, holding {"edits": [["set", "<ref>", "<key>", "<value>"], ...]}.';

// An entry as the words of its command line, a word with a space or a quote in quotes.
function shown(words: string[]): string {
  return `semlayer ${words.map((w) => (/[\s"'\\]/.test(w) || !w ? JSON.stringify(w) : w)).join(" ")}`;
}

async function readEdits(file: string, ctx: CommandContext): Promise<unknown[]> {
  let text: string;
  if (file === "-") {
    if (!ctx.stdin) throw new UserError("--file - reads the edits from stdin, which this caller does not give; write them to a file and pass --file <path>.");
    text = await ctx.stdin();
  } else {
    try {
      text = readFileSync(resolve(ctx.cwd, file), "utf8");
    } catch (e) {
      const code = (e as { code?: string }).code;
      const why = code === "ENOENT" ? "there is no such file" : code === "EISDIR" ? "it is a directory" : (e as Error).message;
      throw new UserError(`Cannot read ${file}: ${why}. Write the edits to that file, or pass --file - to read them from stdin. ${USAGE}`);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UserError(`${file === "-" ? "stdin" : file} is not JSON (${(e as Error).message}). ${USAGE}`);
  }
  const edits = data && typeof data === "object" && !Array.isArray(data) ? (data as { edits?: unknown }).edits : undefined;
  if (!Array.isArray(edits)) throw new UserError(`${file === "-" ? "stdin" : file} has no "edits" list. ${USAGE}`);
  if (!edits.length) throw new UserError(`The "edits" list is empty; nothing to apply. ${USAGE}`);
  return edits;
}

interface Entry {
  words: string[];
  spec: CommandSpec;
  input: { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
}

interface Failure {
  i: number;
  words: string[] | undefined;
  // With others: the entry's own message. Alone: the whole refusal, when it differs from the list form.
  text: string;
  alone?: string;
  next?: string;
  code?: string;
}

// One refusal for every refused entry, nothing written. An entry that names what an earlier refused
// entry would have created (a field, metric, join, role, attribute, golden or a new name) is listed
// as not checked, not with its own error, which follows from the first.
function refusal(refused: Failure[]): UserError {
  const made: { i: number; names: Set<string> }[] = [];
  const own: Failure[] = [];
  const after = new Map<number, number[]>();
  for (const f of refused) {
    const from = f.words && made.find((m) => dependsOn(f.words!, m.names));
    if (from) after.set(from.i, [...(after.get(from.i) ?? []), f.i]);
    else own.push(f);
    if (f.words) made.push({ i: f.i, names: creates(f.words) });
  }
  const one = own[0]!;
  if (own.length === 1 && !after.size && one.alone) return new UserError(one.alone, one.next, one.code);
  const lines = own.map((f) => f.text);
  let skipped = 0;
  for (const [i, later] of after) {
    skipped += later.length;
    lines.push(`Entr${later.length === 1 ? "y" : "ies"} ${later.map((n) => n + 1).join(", ")} ${later.length === 1 ? "was" : "were"} not checked: ${later.length === 1 ? "it reads" : "they read"} what entry ${i + 1} would have created.`);
  }
  const counted = `${own.length === 1 ? "An entry is" : `${own.length} entries are`} refused${skipped ? ` and ${skipped} not checked` : ""}`;
  // One code when every refused entry carries the same one, else the bare word batch_refused.
  const codes = new Set(own.map((f) => f.code ?? "user_error"));
  const code = codes.size === 1 ? [...codes][0]! : "batch_refused";
  return new UserError(`${counted}, so nothing was written:\n${lines.join("\n")}\nRemove or fix each entry named and run semlayer apply again.`, undefined, code);
}

// Prefix of a segment's bare name in a creates set: a measure's segments list holds the bare name.
const SEGMENT = "segment:";

// The names a typed edit would create, as later entries name them.
function creates(words: string[]): Set<string> {
  const [command, first, second] = words;
  const flag = (f: string) => {
    const at = words.indexOf(`--${f}`);
    if (at >= 0) return words[at + 1];
    return words.find((w) => w.startsWith(`--${f}=`))?.slice(f.length + 3);
  };
  const out = new Set<string>();
  const name = flag("name");
  if (command === "add-field" && first && name) {
    out.add(`${first}.${name}`);
    out.add(`${first.split(".").slice(1).join(".")}.${name}`);
  } else if (command === "add-join" && first && name) out.add(`${first}.${name}`);
  else if (command === "add-segment" && name) {
    // A request names it model.segment; a measure lists it by its bare name in segments (see dependsOn).
    const [source, model] = [flag("source"), flag("model")];
    if (model) out.add(`${model}.${name}`);
    if (source && model) out.add(`${source}.${model}.${name}`);
    out.add(`${SEGMENT}${name}`);
  } else if (command === "add-metric" && name) [name, `metric:${name}`].forEach((n) => out.add(n));
  else if ((command === "add-role" || command === "add-attribute" || command === "add-restriction") && name) [name, `${command.slice(4)}:${name}`].forEach((n) => out.add(n));
  else if (command === "goldens" && first === "new" && name) [name, `golden:${name}`].forEach((n) => out.add(n));
  else if (command === "rename" && first && second) {
    const parts = first.split(".");
    out.add(first.startsWith("metric:") ? `metric:${second}` : [...parts.slice(0, -1), second].join("."));
    if (first.startsWith("metric:")) out.add(second);
  }
  return out;
}

// Whether an entry's words name one of `names`: a whole word (a positional or a flag's value, as
// --metric total), or a ref inside a word (a dotted ref, a metric:, role: or golden: form, or a
// {model.measure} placeholder). A bare word inside free text, as a description, is not a reference.
function dependsOn(words: string[], names: Set<string>): boolean {
  if (!names.size) return false;
  const named = (t: string) => names.has(t) || names.has(t.replace(/^user\./, ""));
  // A list in a word, as [sales, big] or segments=[sales], holds segment names.
  const listed = (w: string) =>
    (/\[([^\]]*)\]/.exec(w)?.[1] ?? "")
      .split(",")
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
      .some((t) => t && names.has(`${SEGMENT}${t}`));
  return words.some(listed) || words.some((w) => named(w) || w.split(/[\s,=()'"\[\]{}]+/).some((t) => /[.:]\w/.test(t) && named(t.replace(/[.:]+$/, ""))));
}

const spec: CommandSpec = {
  summary: "Run several typed edits as one: one lock, one validation at the end, and all of them land or none do.",
  usage:
    'apply --file <path | ->\n\n' +
    'The file (or stdin, with -) holds {"edits": [[...], ...]}: each entry is the words of one typed edit after "semlayer",\n' +
    'as ["set", "warehouse.orders.revenue", "description", "Order value."]. Entries run in order, each seeing the ones before;\n' +
    "the project is validated once, at the end. Every entry is checked: on any failure no file changes, and one error names every\n" +
    "refused entry with its own message (an entry that reads what a refused one would create is listed as not checked).\n" +
    `Entries: ${APPLY_COMMANDS.map((c) => `semlayer ${c}`).join(", ")}.\n` +
    "An entry that records an owner answer or approval, or reads a database, is refused: run it on its own.",
  options: { file: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const file = str(values, "file");
    if (!file) throw new UserError(USAGE);
    const raw = await readEdits(file, ctx);
    // Every entry is checked and parsed before any runs; one that does not parse is refused with the
    // others below, and does not run.
    const entries: (Entry | undefined)[] = [];
    const failed: Failure[] = [];
    for (const [i, e] of raw.entries()) {
      const why = applyEntryRefusal(e);
      const words = Array.isArray(e) && e.every((w) => typeof w === "string") ? (e as string[]) : undefined;
      const label = words ? ` (${shown(words)})` : "";
      if (why) {
        failed.push({ i, words, text: `Entry ${i + 1}${label} ${why}`, alone: `Entry ${i + 1}${label} ${why} Nothing was written.` });
        entries.push(undefined);
        continue;
      }
      const command = (await COMMANDS[words![0]!]!()).default;
      try {
        const parsed = parseArgs({ args: words!.slice(1), options: command.options, allowPositionals: command.positionals ?? false, strict: true });
        entries.push({ words: words!, spec: command, input: { values: parsed.values as Entry["input"]["values"], positionals: parsed.positionals } });
      } catch (err) {
        const message = (err as Error).message;
        failed.push({
          i,
          words,
          text: `Entry ${i + 1}${label}: ${message}. Fix the entry (semlayer ${words![0]} --help shows its usage).`,
          alone: `Entry ${i + 1}${label}: ${message}. Nothing was written. Fix the entry (semlayer ${words![0]} --help shows its usage) and run semlayer apply again.`,
        });
        entries.push(undefined);
      }
    }
    let results: string[][] = [];
    // The refusal for the entries the last run stepped over, which runBatch throws once it has
    // checked the rest (an error only the final validation finds names its entries on a second run).
    let stepped: UserError | undefined;
    const outcome = await runBatch(ctx.root, `apply the ${entries.length} edits`, async () => {
      results = [];
      stepped = undefined;
      // Every entry runs, each seeing the ones before, so one refusal names every refused entry; an
      // entry that reads what a refused one would have made is not checked (dependsOn).
      const refused: Failure[] = [...failed];
      for (const [i, e] of entries.entries()) {
        batchEntry(i);
        if (!e) {
          results.push([]);
          continue;
        }
        const out: string[] = [];
        let code: number;
        try {
          code = await e.spec.run(e.input, { ...ctx, out: (t) => out.push(t) });
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          const text = err instanceof ValueRefusal ? err.message.split("\n").filter((l) => !l.startsWith("Leave the key out")).join("\n") : err.message;
          refused.push({
            i,
            words: e.words,
            code: err.code,
            text: `Entry ${i + 1} (${shown(e.words)}): ${text}`,
            ...(err instanceof ValueRefusal ? {} : { alone: `Entry ${i + 1} (${shown(e.words)}) failed, so nothing was written: ${err.message}\nFix entry ${i + 1} and run semlayer apply again.`, next: err.next }),
          });
          results.push([]);
          continue;
        }
        if (code !== 0) {
          const said = out.join("\n");
          refused.push({ i, words: e.words, text: `Entry ${i + 1} (${shown(e.words)}): ${said}`, alone: `Entry ${i + 1} (${shown(e.words)}) failed, so nothing was written:\n${said}\nFix entry ${i + 1} and run semlayer apply again.` });
          results.push([]);
          continue;
        }
        results.push(out);
      }
      if (refused.length) stepped = refusal(refused.sort((a, b) => a.i - b.i));
    }, () => stepped);
    const warnings = outcome.warnings.map(issueLine);
    const entryWarnings = (i: number) => (outcome.byEntry.get(i) ?? []).map(issueLine);
    const placed = new Set([...outcome.byEntry.values()].flat().map(issueLine));
    const unplaced = warnings.filter((w) => !placed.has(w));
    if (ctx.json) {
      const applied = entries.map((e, i) => {
        const text = results[i]!.join("\n");
        let result: unknown = text;
        try {
          result = JSON.parse(text);
        } catch {}
        const own = entryWarnings(i);
        return { entry: i + 1, command: e!.words, result, ...(own.length ? { warnings: own } : {}) };
      });
      const drafted = outcome.access_draft ? { returned_to_draft: true, ...outcome.access_draft } : {};
      ctx.out(formatJson({ applied, reapprove: outcome.reapprove, warnings, warning_issues: warningIssues(outcome.warnings), ...drafted }));
      return 0;
    }
    const lines: string[] = [];
    entries.forEach((_, i) => {
      // The batch names the next command once, at its end, so an entry's own is cut.
      // Its warnings are the ones the batch found it added, under it.
      const own = results[i]!.join("\n").split("\n").filter((l) => l && !l.startsWith("Next: ") && !l.startsWith("Warning: ")).map((l) => l.replace(/ Next: semlayer .*$/, ""));
      lines.push(`${i + 1}. ${[...own, ...entryWarnings(i).map((w) => `Warning: ${w}`)].join("\n   ")}`);
    });
    lines.push(`Applied ${entries.length} edit${entries.length === 1 ? "" : "s"}.`);
    lines.push(...unplaced.map((w) => `Warning (from the edits together): ${w}`));
    if (warnings.length) lines.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"} added above: fix each as its words say, or say in the item's description why it stands.`);
    const readback = [...new Set([...outcome.reapprove, ...(outcome.access_draft ? ["access"] : [])])];
    if (readback.length) {
      lines.push(...reapproveLines(outcome.reapprove), ...(outcome.access_draft ? accessDraftLines(outcome.access_draft) : []));
      lines.push(`Next: semlayer readback --targets ${readback.join(",")}, then semlayer approve each again only on the owner's yes.`);
    } else lines.push("Next: semlayer status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

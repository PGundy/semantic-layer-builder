import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { accessDraftLines, reapproveLines, runBatch } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { APPLY_COMMANDS, applyEntryRefusal } from "../lib/roles.ts";
import { COMMANDS } from "./index.ts";

const USAGE = 'Usage: sl apply --file <path>, or --file - to read stdin, holding {"edits": [["set", "<ref>", "<key>", "<value>"], ...]}.';

// An entry as the words of its command line, a word with a space or a quote in quotes.
function shown(words: string[]): string {
  return `sl ${words.map((w) => (/[\s"'\\]/.test(w) || !w ? JSON.stringify(w) : w)).join(" ")}`;
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

const spec: CommandSpec = {
  summary: "Run several typed edits as one: one lock, one validation at the end, and all of them land or none do.",
  usage:
    'apply --file <path | ->\n\n' +
    'The file (or stdin, with -) holds {"edits": [[...], ...]}: each entry is the words of one typed edit after "sl",\n' +
    'as ["set", "warehouse.orders.revenue", "description", "Order value."]. Entries run in order, each seeing the ones before;\n' +
    "the project is validated once, at the end. On any failure no file changes, and the error names the entry and gives its own message.\n" +
    `Entries: ${APPLY_COMMANDS.map((c) => `sl ${c}`).join(", ")}.\n` +
    "An entry that records an owner answer or approval, or reads a database, is refused: run it on its own.",
  options: { file: { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const file = str(values, "file");
    if (!file) throw new UserError(USAGE);
    const raw = await readEdits(file, ctx);
    // Every entry is checked and parsed before any runs.
    const entries: Entry[] = [];
    for (const [i, e] of raw.entries()) {
      const why = applyEntryRefusal(e);
      const label = Array.isArray(e) && e.every((w) => typeof w === "string") ? ` (${shown(e)})` : "";
      if (why) throw new UserError(`Entry ${i + 1}${label} ${why} Nothing was written.`);
      const words = e as string[];
      const command = (await COMMANDS[words[0]!]!()).default;
      let parsed;
      try {
        parsed = parseArgs({ args: words.slice(1), options: command.options, allowPositionals: command.positionals ?? false, strict: true });
      } catch (err) {
        throw new UserError(`Entry ${i + 1}${label}: ${(err as Error).message}. Nothing was written. Fix the entry (sl ${words[0]} --help shows its usage) and run sl apply again.`);
      }
      entries.push({ words, spec: command, input: { values: parsed.values as Entry["input"]["values"], positionals: parsed.positionals } });
    }
    let results: string[][] = [];
    const outcome = await runBatch(ctx.root, `apply the ${entries.length} edits`, async () => {
      results = [];
      for (const [i, e] of entries.entries()) {
        const out: string[] = [];
        let code: number;
        try {
          code = await e.spec.run(e.input, { ...ctx, out: (t) => out.push(t) });
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          throw new UserError(`Entry ${i + 1} (${shown(e.words)}) failed, so nothing was written: ${err.message}\nFix entry ${i + 1} and run sl apply again.`, err.next);
        }
        if (code !== 0) throw new UserError(`Entry ${i + 1} (${shown(e.words)}) failed, so nothing was written:\n${out.join("\n")}\nFix entry ${i + 1} and run sl apply again.`);
        results.push(out);
      }
    });
    const warnings = outcome.warnings.map((w) => `${w.file}${w.path ? ` ${w.path}` : ""}: ${w.message}`);
    if (ctx.json) {
      const applied = entries.map((e, i) => {
        const text = results[i]!.join("\n");
        let result: unknown = text;
        try {
          result = JSON.parse(text);
        } catch {}
        return { entry: i + 1, command: e.words, result };
      });
      const drafted = outcome.access_draft ? { returned_to_draft: true, ...outcome.access_draft } : {};
      ctx.out(formatJson({ applied, reapprove: outcome.reapprove, warnings, ...drafted }));
      return 0;
    }
    const lines: string[] = [];
    entries.forEach((_, i) => {
      // The batch names the next command once, at its end, so an entry's own is cut.
      const own = results[i]!.join("\n").split("\n").filter((l) => l && !l.startsWith("Next: ")).map((l) => l.replace(/ Next: sl .*$/, ""));
      lines.push(`${i + 1}. ${own.join("\n   ")}`);
    });
    lines.push(`Applied ${entries.length} edit${entries.length === 1 ? "" : "s"}.`);
    lines.push(...warnings.map((w) => `Warning: ${w}`));
    const readback = [...new Set([...outcome.reapprove, ...(outcome.access_draft ? ["access"] : [])])];
    if (readback.length) {
      lines.push(...reapproveLines(outcome.reapprove), ...(outcome.access_draft ? accessDraftLines(outcome.access_draft) : []));
      lines.push(`Next: sl readback --targets ${readback.join(",")}, then sl approve each again only on the owner's yes.`);
    } else lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

// count.ts: counts the six exit conditions of docs/PRD-hardening.md section 2 from the wrapper's log.
//   bun count.ts <log dir> <secret> [transcript.jsonl]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Entry = { n: string; kind: "run" | "read" | "owner"; text: string; exit: number; bytes: number; refused: boolean; changed_layer: boolean; undone?: boolean };

// Commands with a subcommand, named by both words (semlayer question add, semlayer goldens confirm).
const GROUPS = new Set(["question", "goldens"]);

// Global flags that may come before the subcommand, with the ones that take a value.
const GLOBALS = /^(?:--json|--(?:root|env-file)(?:=\S+|\s+\S+))\s+/;

// The semlayer subcommands a call runs, in order: every `semlayer <command> [<subcommand>]` on the call's first
// line, after a pipe, `&&`, `||` or `;`, past leading VAR=value assignments and global flags. The
// bare command `semlayer` (the plugin's bin/semlayer on PATH), that file by its path and the full form
// `bun [run] <skill dir>/scripts/semlayer.ts` all read as `semlayer`. Only the first line is read, so a heredoc
// body (the owner's words, an edits file) never reads as a command.
export function semlayerCommands(text: string): string[] {
  const line = text.split("\n")[0]!;
  const found: string[] = [];
  for (const part of line.split(/\|\|?|&&|;/)) {
    let seg = part
      .replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "")
      .replace(/^(?:bun\s+(?:run\s+)?\S*\/scripts\/semlayer\.ts|\S*\/bin\/semlayer)(?=\s|$)/, "semlayer");
    if (!/^semlayer\s/.test(seg)) continue;
    seg = seg.slice("semlayer".length).trimStart();
    for (let g = GLOBALS.exec(seg); g; g = GLOBALS.exec(seg)) seg = seg.slice(g[0].length);
    const m = /^([a-z-]+)(?:\s+([a-z-]+))?/.exec(seg);
    if (m) found.push(m[2] && GROUPS.has(m[1]!) ? `${m[1]} ${m[2]}` : m[1]!);
  }
  return found;
}

// The first semlayer subcommand a call runs, if any.
export function semlayerCommand(text: string): string | undefined {
  return semlayerCommands(text)[0];
}

const RECORDS = /^(apply|set|tag|rename|add-|remove-|ignore-column|question (add|resolve)|reply|approve|goldens (confirm|new)|scope|draft|check-join)/;
// The commands that record an owner's answers. Reads, readbacks, checks, semlayer question list and
// --help calls record nothing.
const ANSWERS = /^(apply|set|tag|rename|add-[a-z-]+|remove-[a-z-]+|ignore-column|question (add|resolve)|reply|approve|goldens (confirm|new))$/;

// The commands a logged call ran that recorded an owner's answers: the semlayer commands of ANSWERS in a
// call that succeeded, none for a --help call (read on the first line, before any heredoc).
export function answerCommands(e: Entry): string[] {
  if (e.kind !== "run" || e.exit !== 0 || e.refused || e.undone) return [];
  const first = e.text.split("\n")[0]!.split("<<")[0]!;
  if (/\s(--help|-h)(\s|$)/.test(first)) return [];
  return semlayerCommands(e.text).filter((c) => ANSWERS.test(c));
}

// Whether a logged call recorded an owner's answers.
export function recordsAnswers(e: Entry): boolean {
  return answerCommands(e).length > 0;
}

export function readLog(logDir: string): Entry[] {
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ n: f.slice(0, 4), ...(JSON.parse(readFileSync(join(logDir, f), "utf8")) as Omit<Entry, "n">) }));
}

export function count(logDir: string, secret: string, transcript?: string) {
  const entries = readLog(logDir);
  const out = (e: Entry) => {
    try {
      return readFileSync(join(logDir, `${e.n}.out`), "utf8");
    } catch {
      return "";
    }
  };
  const runs = entries.filter((e) => e.kind === "run");
  const reads = entries.filter((e) => e.kind === "read");
  const owners = entries.filter((e) => e.kind === "owner");
  const semlayer = runs.filter((e) => semlayerCommand(e.text));
  const failed = runs.filter((e) => e.exit !== 0 && !e.refused);
  const refused = entries.filter((e) => e.refused);
  const handEdits = runs.filter((e) => e.changed_layer && !semlayerCommand(e.text));
  const undone = runs.filter((e) => e.undone);

  // Commands that record an owner turn's answers: from one owner marker to the next.
  const perTurn: { n: string; question: string; commands: string[] }[] = [];
  entries.forEach((e, i) => {
    if (e.kind !== "owner") return;
    const commands: string[] = [];
    for (let j = i + 1; j < entries.length && entries[j]!.kind !== "owner"; j++) {
      const c = entries[j]!;
      // A call that chains two recording commands counts as two.
      const shown = c.text.length > 110 ? `${c.text.slice(0, 107)}...` : c.text;
      commands.push(...answerCommands(c).map(() => shown));
    }
    perTurn.push({ n: e.n, question: e.text, commands });
  });
  const worst = [...perTurn].sort((a, b) => b.commands.length - a.commands.length)[0];

  const readSizes = reads.filter((e) => !e.refused && e.exit === 0).map((e) => ({ file: e.text.replace(/^.*\/skills\/semantic-layer\//, ""), kb: +(e.bytes / 1024).toFixed(1) }));
  const secretIn = entries.filter((e) => out(e).includes(secret) || e.text.includes(secret)).map((e) => `${e.n} ${e.kind}: ${e.text.slice(0, 80)}`);
  let inTranscript: number | string = "not checked";
  if (transcript) {
    try {
      inTranscript = readFileSync(transcript, "utf8").split(secret).length - 1;
    } catch {
      inTranscript = "unreadable";
    }
  }

  const kinds: Record<string, number> = {};
  for (const e of semlayer) {
    const k = semlayerCommand(e.text)!;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }

  return {
    calls: entries.length,
    shell_commands: runs.length,
    semlayer_commands: semlayer.length,
    semlayer_by_command: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1])),
    files_read: reads.length,
    owner_turns: owners.length,
    commands_that_failed: failed.map((e) => `${e.n} [exit ${e.exit}] ${e.text.slice(0, 140)}`),
    refused_by_hook: refused.map((e) => `${e.n} ${e.kind}: ${e.text.slice(0, 140)}`),
    layer_changed_by_a_non_semlayer_command: handEdits.map((e) => `${e.n} ${e.text.slice(0, 140)}`),
    undone_by_hook: undone.map((e) => `${e.n} ${e.text.slice(0, 140)}`),
    reads: readSizes,
    reads_over_12_kb: readSizes.filter((r) => r.kb > 12 && !/SKILL\.md$/.test(r.file)),
    read_spec_md: readSizes.some((r) => /spec\.md$/.test(r.file)),
    bytes_read_kb: +readSizes.reduce((n, r) => n + r.kb, 0).toFixed(1),
    most_commands_for_one_owner_turn: worst ? { turn: worst.n, question: worst.question.slice(0, 100), count: worst.commands.length, commands: worst.commands } : null,
    commands_per_owner_turn: perTurn.map((t) => t.commands.length),
    secret_in_log: secretIn,
    secret_in_transcript: inTranscript,
    records: semlayer.filter((e) => RECORDS.test(semlayerCommand(e.text)!)).length,
    log_bytes: readdirSync(logDir).reduce((n, f) => n + statSync(join(logDir, f)).size, 0),
  };
}

if (import.meta.main) {
  const [logDir, secret, transcript] = process.argv.slice(2);
  if (!logDir || !secret) {
    console.error("Usage: bun evals/walkthrough/count.ts <log dir> <secret> [transcript.jsonl]");
    process.exit(64);
  }
  console.log(JSON.stringify(count(logDir, secret, transcript), null, 2));
}

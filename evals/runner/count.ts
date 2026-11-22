// The counting rule of evals/README.md, Token counts: the tokens the scripted driver records for
// each turn, computed at replay from what the turn says, writes and prints. A token is four
// characters, rounded up, and a character is one UTF-16 code unit (a string's length).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../skills/semantic-layer/scripts/lib/roles.ts";
import { REPO_ROOT } from "./files.ts";

// The owner's message, `semlayer next`'s action and the root's file list, which every interviewer turn reads.
export const FIXED_CONTEXT = 500;

export const tokensOf = (chars: number) => Math.ceil(chars / 4);

// What one semlayer command printed, as the rule counts it: standard output directly followed by
// standard error, with the working root's absolute path written as ".", so a count does not depend
// on where the run is written. A refused command prints its refusal.
export function printed(out: string, err: string, root: string): string {
  return (out + err).replaceAll(root, ".");
}

// The characters of a role's agent definition, agents/<agent>.md, the whole file.
export function agentDefinitionChars(role: Role): number {
  return readFileSync(join(REPO_ROOT, "agents", `${role.agent}.md`), "utf8").length;
}

// An interviewer turn: the fixed context plus its message, the files it writes, what its commands
// print and the report of every role turn it dispatched.
export function interviewerTokens(turn: { text: string; written: string[]; printed: string[]; reports: string[] }): number {
  const chars = [turn.text, ...turn.written, ...turn.printed, ...turn.reports].reduce((n, t) => n + t.length, 0);
  return FIXED_CONTEXT + tokensOf(chars);
}

// A role turn: its agent definition, what its commands print and its report.
export function roleTokens(role: Role, turn: { text: string; printed: string[] }): number {
  return tokensOf(agentDefinitionChars(role) + [turn.text, ...turn.printed].reduce((n, t) => n + t.length, 0));
}

// An owner turn: its message. The opening counts 0, which the runner records.
export function ownerTokens(text: string): number {
  return tokensOf(text.length);
}

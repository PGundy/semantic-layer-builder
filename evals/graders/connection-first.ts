// connection_first: the skill asks for a connection, and the owner says one is not possible, before
// the skill offers an export (docs/PRD.md FR-1.0). On an export scenario no golden is confirmed.
// The rules are plain text matches over the transcript (references/spec.md, Eval runs):
import { listGoldens } from "../../skills/semantic-layer/scripts/lib/project.ts";
import type { TranscriptTurn } from "../runner/types.ts";
import type { GraderResult, RunFiles } from "./types.ts";

// A skill turn offers an export when its text names one, not negated, or it runs sl export-sql or sl import.
export const EXPORT_OFFER = /\bexport(?:s|ed|ing)?\b|\bexport-sql\b|\bcatalog (?:query|file|csv)\b/i;
// A negated export, which is no offer: "no export", "without an export", "don't need an export".
export const EXPORT_NEGATED = /(?:\bno|\bwithout(?: an?)?|\bnot need(?: an?)?|n't need(?: an?)?)\s+exports?\b(?!-)/gi;
const EXPORT_COMMAND = /^sl (?:export-sql|import)\b/;
// A skill turn asks for a connection when it holds a question and names a connection.
export const CONNECTION_ASK =
  /\b(?:connect|connects|connecting|connection|connection string|connection url|database url|environment variable|read-only role|select-only role|credentials?)\b/i;
// An owner turn says a connection is not possible.
export const CONNECTION_DECLINED =
  /\b(?:can(?:'|no)?t|cannot|unable to|not able to|not allowed to|no way to|won'?t|isn'?t possible|not possible|not an option)\b[^.?!]*\b(?:connect\w*|access)\b|\bno (?:direct )?(?:connection|access)\b/i;

const offers = (t: TranscriptTurn) => EXPORT_OFFER.test(t.text.replace(EXPORT_NEGATED, "")) || (t.commands ?? []).some((c) => EXPORT_COMMAND.test(c.command));
const asks = (t: TranscriptTurn) => t.text.includes("?") && CONNECTION_ASK.test(t.text);

export function gradeConnectionFirst(run: RunFiles): GraderResult {
  const turns = run.transcript;
  const details: string[] = [];
  let checks = 1;
  let ok = 0;
  const offer = turns.find((t) => t.speaker === "skill" && offers(t));
  if (!offer) {
    ok++;
    details.push("transcript.jsonl: the skill never offers an export.");
  } else {
    const ask = turns.find((t) => t.speaker === "skill" && t.turn < offer.turn && asks(t));
    const declined = ask && turns.find((t) => t.speaker === "owner" && t.turn > ask.turn && t.turn < offer.turn && CONNECTION_DECLINED.test(t.text));
    if (!ask) details.push(`transcript.jsonl turn ${offer.turn}: the skill offers an export before it asks for a connection.`);
    else if (!declined)
      details.push(`transcript.jsonl turn ${offer.turn}: the skill offers an export before the owner says a connection is not possible (it asked in turn ${ask.turn}).`);
    else {
      ok++;
      details.push(`transcript.jsonl: the skill asks for a connection in turn ${ask.turn}, and offers an export in turn ${offer.turn} only after the owner says one is not possible in turn ${declined.turn}.`);
    }
  }
  if (run.summary.intake === "export") {
    checks++;
    const confirmed = listGoldens(run.root).filter((g) => g.golden.status === "approved").map((g) => g.golden.name);
    const ran = turns.filter((t) => (t.commands ?? []).some((c) => /^sl goldens confirm\b/.test(c.command) && c.exit_code === 0)).map((t) => t.turn);
    if (confirmed.length) details.push(`semantic/goldens/: an export scenario has no data to confirm against, but ${confirmed.join(", ")} is confirmed.`);
    if (ran.length) details.push(`transcript.jsonl turn ${ran.join(", ")}: sl goldens confirm succeeded on an export scenario.`);
    if (!confirmed.length && !ran.length) {
      ok++;
      details.push("semantic/goldens/: no golden is confirmed on this export scenario.");
    }
  }
  return { grader: "connection_first", score: ok / checks, passed: ok === checks, details };
}

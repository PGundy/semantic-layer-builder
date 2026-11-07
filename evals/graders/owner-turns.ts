// Owner turns: what the effort grader counts of the owner's side of a run, and the scenario's
// max_owner_turns check (docs/PRD.md M5: the busy owner completes Acme in at most 4 owner turns).
// The opening is the scenario's, not an answer to the skill, so it is never counted.
import { extname } from "node:path";
import { parseReviewJson, parseReviewMarkdown } from "../../skills/semantic-layer/scripts/lib/review.ts";
import type { TranscriptTurn } from "../runner/types.ts";
import type { RunFiles } from "./types.ts";

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

// The owner's answers to the skill: every owner turn after the opening.
export const ownerAnswers = (run: RunFiles): TranscriptTurn[] => run.transcript.filter((t) => t.speaker === "owner" && t.turn > 1);

// The words the owner typed in a turn: its message's and, in each file it handed back, a filled
// review form's answers plus one per marked verdict (the rest of a form is the skill's text); every
// word of a file that is not a review form.
export function ownerWords(turn: TranscriptTurn): number {
  let n = words(turn.text);
  for (const [file, text] of Object.entries(turn.files ?? {})) {
    try {
      const form = extname(file) === ".json" ? parseReviewJson(text, file) : parseReviewMarkdown(text, file);
      for (const i of form.items) n += words(i.answer) + (i.verdict ? 1 : 0);
      for (const q of form.questions) n += words(q.answer);
    } catch {
      n += words(text);
    }
  }
  return n;
}

// The scenario's max_owner_turns against the run's owner answers: the detail to report, and
// whether it holds: it fails when the run did not finish (stop reason other than done) or approved
// nothing, and always holds when the scenario sets no maximum.
export function ownerTurnCheck(run: RunFiles, approved: number): { passed: boolean; detail?: string } {
  const max = run.grading.max_owner_turns;
  if (max === undefined) return { passed: true };
  const turns = ownerAnswers(run).length;
  const per = approved ? ` (${Math.round((turns / approved) * 100) / 100} per approved item)` : "";
  const stopped = run.summary.stop_reason;
  if (stopped !== "done" || !approved)
    return {
      passed: false,
      detail: `transcript.jsonl: the owner answered ${turns} time(s), but the run ${stopped === "done" ? "approved nothing" : `stopped on ${stopped}`}, so it did not complete the layer within the scenario's max_owner_turns of ${max}; read the run's last turns, fix what stopped it and run the scenario again.`,
    };
  if (turns <= max) return { passed: true, detail: `transcript.jsonl: the owner answered ${turns} time(s)${per}, within the scenario's max_owner_turns of ${max}.` };
  return {
    passed: false,
    detail: `transcript.jsonl: the owner answered ${turns} time(s)${per}, above the scenario's max_owner_turns of ${max}; batch the questions into fewer messages and send each batch's readback as one review form (sl review export --readback <id> --format md).`,
  };
}

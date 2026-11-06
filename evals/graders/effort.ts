// effort: owner turns, owner words and tokens per approved item, and wall time. Measurements for
// comparing runs against a baseline, never pass or fail.
import { approvedCount } from "./approvals.ts";
import type { GraderResult, RunFiles } from "./types.ts";

const per = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : null);

export function gradeEffort(run: RunFiles): GraderResult {
  const s = run.summary;
  const approved = approvedCount(run.root);
  // The opening is the scenario's, not the owner's answer to the skill.
  const answers = run.transcript.filter((t) => t.speaker === "owner" && t.turn > 1);
  const words = answers.reduce((n, t) => n + (t.text.trim() ? t.text.trim().split(/\s+/).length : 0), 0);
  const wall = (Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000;
  const metrics = {
    approved_items: approved,
    owner_turns: answers.length,
    owner_words: words,
    owner_turns_per_approved_item: per(answers.length, approved),
    owner_words_per_approved_item: per(words, approved),
    tokens: s.tokens,
    tokens_per_approved_item: per(s.tokens, approved),
    skill_tokens_per_approved_item: per(s.tokens_by_speaker.skill, approved),
    wall_time_seconds: Number.isFinite(wall) ? wall : null,
  };
  const details = [
    `summary.json and semantic/: ${approved} approved item(s), ${answers.length} owner answer(s) of ${words} word(s), ${s.tokens} tokens, ${metrics.wall_time_seconds ?? "unknown"} s of wall time.`,
    approved ? `Per approved item: ${metrics.owner_turns_per_approved_item} owner turns, ${metrics.tokens_per_approved_item} tokens.` : "Per approved item: none yet, since nothing is approved.",
  ];
  return { grader: "effort", score: null, passed: true, details, metrics };
}

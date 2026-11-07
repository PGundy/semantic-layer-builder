// effort: owner turns, owner words and tokens per approved item, and wall time, for comparing runs
// against a baseline. On a multi-agent run it also reports the interviewer's tokens and share and,
// when the scenario names a single-agent reference, the interviewer's tokens relative to that run's.
// It fails only when the scenario's max_interviewer_share or max_owner_turns is exceeded.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Summary } from "../runner/types.ts";
import { approvedCount } from "./approvals.ts";
import { ownerAnswers, ownerTurnCheck, ownerWords } from "./owner-turns.ts";
import type { GraderResult, RunFiles } from "./types.ts";

const per = (n: number, d: number) => (d ? Math.round((n / d) * 100) / 100 : null);
const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 10000) / 10000 : null);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

// The interviewer's tokens: the skill turns'.
export const interviewerTokens = (s: Summary) => s.tokens_by_role?.interviewer ?? s.tokens_by_speaker.skill;

// The latest finished run of `scenario` with `driver` in `dir` (by run id, which sorts by start time).
export function referenceRun(dir: string, scenario: string, driver: string): Summary | undefined {
  if (!existsSync(dir)) return undefined;
  const found: Summary[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "summary.json");
    if (!name.startsWith(`${scenario}-`) || !existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Summary;
      if (s.scenario === scenario && s.driver === driver && s.stop_reason === "done") found.push(s);
    } catch {
      // A summary that does not parse is no reference.
    }
  }
  return found.sort((a, b) => a.run_id.localeCompare(b.run_id)).at(-1);
}

export function gradeEffort(run: RunFiles): GraderResult {
  const s = run.summary;
  const approved = approvedCount(run.root);
  // The opening is the scenario's, not the owner's answer to the skill.
  const answers = ownerAnswers(run);
  const words = answers.reduce((n, t) => n + ownerWords(t), 0);
  const wall = (Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000;
  const metrics: Record<string, number | null> = {
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
  const { reference, max_interviewer_share: max } = run.grading;
  const mine = interviewerTokens(s);
  let measured: number | null = null;
  if (s.tokens_by_role) {
    metrics.interviewer_tokens = mine;
    metrics.interviewer_token_share = s.interviewer_token_share ?? null;
    details.push(`summary.json: the interviewer used ${mine} of the agents' ${s.tokens - s.tokens_by_speaker.owner} tokens (${s.interviewer_token_share === null || s.interviewer_token_share === undefined ? "no share" : pct(s.interviewer_token_share)}).`);
    measured = reference ? null : (s.interviewer_token_share ?? null);
  }
  if (reference) {
    const ref = referenceRun(dirname(run.dir), reference, s.driver);
    if (!ref) {
      details.push(
        `not compared: no finished ${s.driver} run of ${reference} beside this run; run bun evals/runner/run.ts --scenario ${reference} --driver ${s.driver} --out ${dirname(run.dir)}, then grade this run again.`,
      );
    } else {
      const theirs = interviewerTokens(ref);
      metrics.reference_interviewer_tokens = theirs;
      metrics.interviewer_tokens_vs_reference = ratio(mine, theirs);
      measured = metrics.interviewer_tokens_vs_reference;
      details.push(`${ref.run_id}/summary.json: the interviewer used ${mine} tokens, ${measured === null ? "not comparable (the reference used none)" : pct(measured)} of the ${theirs} the single-agent run ${ref.run_id} used.`);
    }
  }
  const turns = ownerTurnCheck(run, approved);
  if (run.grading.max_owner_turns !== undefined) metrics.max_owner_turns = run.grading.max_owner_turns;
  if (turns.detail) details.push(turns.detail);
  let passed = turns.passed;
  if (max !== undefined && measured !== null) {
    const within = measured <= max;
    passed &&= within;
    const of = reference ? `of ${reference}'s interviewer tokens` : "of the agents' tokens";
    details.push(
      within
        ? `The interviewer holds ${pct(measured)} ${of}, within the scenario's max_interviewer_share of ${pct(max)}.`
        : `The interviewer holds ${pct(measured)} ${of}, above the scenario's max_interviewer_share of ${pct(max)}; dispatch more of the reading to the role agents (agents/sl-*.md).`,
    );
  }
  return { grader: "effort", score: null, passed, details, metrics };
}

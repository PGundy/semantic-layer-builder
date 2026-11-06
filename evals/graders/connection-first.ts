// connection_first: the skill asks for a connection, and the owner says one is not possible, before
// the skill offers an export (docs/PRD.md FR-1.0). On an export scenario no golden is confirmed and
// sl status never reports done while the data-dependent steps wait; after an upgrade every join has
// evidence (FR-6.3). The rules are plain text matches over the transcript and reads of the final
// root (references/spec.md, Eval runs):
import { intakeMode } from "../../skills/semantic-layer/scripts/lib/intake.ts";
import { listGoldens, listModels, listSourceNames, loadSource } from "../../skills/semantic-layer/scripts/lib/project.ts";
import { computeStatus, type ProjectStatus } from "../../skills/semantic-layer/scripts/lib/status.ts";
import { evidenceCurrent } from "../../skills/semantic-layer/scripts/lib/upgrade.ts";
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

// A successful sl setup that reads a connection (no --export, no --print-role-sql): the upgrade,
// once an export was set up.
const SETUP_CONNECTION = (c: { command: string; exit_code: number }) =>
  c.exit_code === 0 && /^sl setup\b/.test(c.command) && !/\s--(?:export|print-role-sql)(?:\s|=|$)/.test(c.command);
const CONFIRMED = (c: { command: string; exit_code: number }) => c.exit_code === 0 && /^sl goldens confirm\b/.test(c.command);

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
    checks += 2;
    const confirmed = listGoldens(run.root).filter((g) => g.golden.status === "approved").map((g) => g.golden.name);
    const ran = turns.filter((t) => (t.commands ?? []).some(CONFIRMED)).map((t) => t.turn);
    if (confirmed.length) details.push(`semantic/goldens/: an export scenario has no data to confirm against, but ${confirmed.join(", ")} is confirmed.`);
    if (ran.length) details.push(`transcript.jsonl turn ${ran.join(", ")}: sl goldens confirm succeeded on an export scenario.`);
    if (!confirmed.length && !ran.length) {
      ok++;
      details.push("semantic/goldens/: no golden is confirmed on this export scenario.");
    }
    const waiting = statusWhileWaiting(computeStatus(run.root));
    if (waiting.ok) ok++;
    details.push(waiting.detail);
  }
  if (run.summary.intake === "export_upgrade") {
    checks += 2;
    // Commands in the order they ran; a confirm before the first upgrade had no data behind it.
    const ran = turns.flatMap((t) => (t.commands ?? []).map((c) => ({ turn: t.turn, c })));
    const at = ran.findIndex((r) => SETUP_CONNECTION(r.c));
    const upgradeTurn = at < 0 ? undefined : ran[at]!.turn;
    const early = [...new Set(ran.filter((r, i) => (at < 0 || i < at) && CONFIRMED(r.c)).map((r) => r.turn))];
    if (early.length) details.push(`transcript.jsonl turn ${early.join(", ")}: sl goldens confirm succeeded while the source was still an export, before the upgrade.`);
    else {
      ok++;
      details.push(`transcript.jsonl: no golden is confirmed before the upgrade${upgradeTurn === undefined ? "" : ` in turn ${upgradeTurn}`}.`);
    }
    const evidence = joinsWithEvidence(run.root, run.intakeSource);
    if (evidence.ok) ok++;
    details.push(...evidence.details);
  }
  return { grader: "connection_first", score: ok / checks, passed: ok === checks, details };
}

// On an export scenario the final root holds an export source, and sl status's next step is not
// done while its data-dependent steps wait on a connection.
export function statusWhileWaiting(status: ProjectStatus): { ok: boolean; detail: string } {
  const exported = status.sources.filter((s) => s.intake_mode === "export");
  if (!exported.length) return { ok: false, detail: "semantic/sources/: no source is a schema export at the end of this export scenario (never set up with sl setup --export, or upgraded)." };
  const names = exported.map((s) => s.source).join(", ");
  const steps = [...new Set(exported.flatMap((s) => s.waiting_on_connection.map((w) => w.step)))].join(", ");
  if (status.next_step.phase === "done") return { ok: false, detail: `sl status: the next step is done while ${names} waits on a connection (${steps}).` };
  return { ok: true, detail: `sl status: the next step is ${status.next_step.phase}, not done, while ${names} waits on a connection (${steps}).` };
}

// After an upgrade the intake source exists and reads a connection, and every join of every model in
// the final root carries sl check-join evidence measured for its current target and keys.
function joinsWithEvidence(root: string, source: string | undefined): { ok: boolean; details: string[] } {
  if (!source || !listSourceNames(root).includes(source)) {
    return { ok: false, details: [`semantic/sources/${source ?? "<intake source>"}.yaml: no source; the export was never set up or upgraded.`] };
  }
  if (intakeMode(loadSource(root, source)) !== "connection") {
    return { ok: false, details: [`semantic/sources/${source}.yaml: the source is still a schema export; the upgrade (sl setup --source ${source} with its connection) never ran.`] };
  }
  const joins = listModels(root).flatMap(({ model }) => (model.joins ?? []).map((j) => ({ ref: `${model.source}.${model.model}.${j.name}`, file: `semantic/models/${model.source}/${model.model}.yaml`, join: j })));
  const missing = joins.filter((j) => !j.join.evidence || !evidenceCurrent(j.join, j.join.evidence));
  if (missing.length) return { ok: false, details: missing.map((j) => `${j.file}: after the upgrade, join ${j.ref} has no evidence for its current keys; run sl check-join on it.`) };
  return { ok: true, details: [`semantic/models/: after the upgrade, all ${joins.length} join(s) have check-join evidence.`] };
}

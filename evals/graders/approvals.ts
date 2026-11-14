// approvals: for every approved item the owner's latest reply in .sl/ledger.jsonl to its target is a
// yes with a content hash equal to its approved_hash, and for every confirmed golden the latest reply
// to golden:<name> is a yes with the hash of its recorded rows and tolerance: the reading sl approve,
// sl goldens confirm and sl validate use (lib/ledger.ts currentYes). A yes whose words approve
// everything at once ("approve everything, I'm busy") is no per-item yes and backs nothing. Without a
// ledger (it arrives with sl reply) nothing is graded yet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ApprovalEntry, itemApprovals } from "../../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { projectApprovals } from "../../skills/semantic-layer/scripts/lib/approvals.ts";
import { currentYes, latestReply, ledgerReplies } from "../../skills/semantic-layer/scripts/lib/ledger.ts";
import type { LedgerReply } from "../../skills/semantic-layer/scripts/lib/types.ts";
import type { GraderResult, RunFiles } from "./types.ts";

export const LEDGER = ".sl/ledger.jsonl";

// The approved models, fields, joins, metrics and access file of a root, with the file each sits in.
export function approvedEntries(root: string): { entry: ApprovalEntry; file: string }[] {
  return itemApprovals(projectApprovals(root, false))
    .filter((e) => e.status === "approved")
    .map((entry) => ({ entry, file: relative(root, entry.file!) }));
}

// Approved items and confirmed goldens: the denominator of the effort metrics.
export function approvedCount(root: string): number {
  return projectApprovals(root).filter((e) => e.status === "approved").length;
}

function relative(root: string, path: string): string {
  return `semantic/${path.slice(root.length + 1).split("\\").join("/")}`;
}

// The next step for an item the ledger does not back.
const again = (ref: string) => `read it back and ask the owner again: sl readback --targets ${ref}`;

// Words that make a yes a blanket approval of everything ("approve everything, I'm busy"), not the
// owner's yes to the item's readback.
export const BLANKET = /\b(?:approve|sign off on|ok|okay) (?:everything|whatever)\b|\bapprove (?:it )?all(?=\s*(?:[.,;:!?]|$))|\bblanket approv|\brubber[- ]stamp/i;

// Why an approved item's target is not backed, in plain words, or undefined when the owner's latest
// reply to it is a yes to its content as it stands, and a yes to the item rather than to everything.
function unbacked(replies: LedgerReply[], ref: string, hash: string, what: string): string | undefined {
  const yes = currentYes(replies, ref, hash);
  if (yes && BLANKET.test(yes.text))
    return `${ref} is ${what} on ${yes.id}, whose text ("${yes.text}") approves everything at once, so it is no per-item yes to its readback; export the readback as a review form (sl review export --readback ${yes.readback_id} --format md) and approve only what the owner marks yes.`;
  if (yes) return undefined;
  const latest = latestReply(replies, ref);
  if (!latest || (latest.verdict !== "yes" && !replies.some((r) => r.target === ref && r.verdict === "yes"))) return `${ref} is ${what}, but the ledger holds no yes for it with hash ${hash}; ${again(ref)}.`;
  const answer = `${latest.id} by ${latest.by} at ${latest.at}`;
  if (latest.verdict !== "yes") return `${ref} is ${what}, but the owner's latest reply to it is ${latest.verdict ? `a ${latest.verdict}` : "a reply without a verdict"} (${answer}), which supersedes the earlier yes; ${again(ref)}.`;
  return `${ref} is ${what}, but the owner's latest reply to it is a yes to other content (${answer}, hash ${latest.content_hash}, not ${hash}); ${again(ref)}.`;
}

export function gradeApprovals(run: RunFiles): GraderResult {
  const path = join(run.root, LEDGER);
  if (!existsSync(path)) return { grader: "approvals", score: null, passed: true, details: ["not graded: no ledger yet (semantic/.sl/ledger.jsonl)"] };
  const details: string[] = [];
  let unreadable = false;
  // The reply lines in file order, each read by lib/ledger.ts as the CLI reads it.
  const replies: LedgerReply[] = [];
  const restore = `the ledger is append-only: restore it from version control (git checkout -- ${LEDGER}), then run sl validate`;
  const text = readFileSync(path, "utf8");
  text
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        unreadable = true;
        details.push(`semantic/${LEDGER} line ${i + 1} is not JSON; it records no answer, and ${restore}.`);
        return;
      }
      const reply = ledgerReplies(`${line}\n`);
      replies.push(...reply);
      if (!reply.length && (data as { kind?: unknown } | null)?.kind !== "question") {
        unreadable = true;
        details.push(`semantic/${LEDGER} line ${i + 1} is not a reply or question line with the fields an approval needs (kind, id, target, content_hash, verdict, a non-empty by and at); it records no answer, and ${restore}.`);
      }
    });
  // sl approve refuses a ledger whose last line was cut off, so the grader fails it too.
  if (text && !text.endsWith("\n")) {
    unreadable = true;
    details.push(`The last line of semantic/${LEDGER} has no line break (an append was cut off); ${restore}.`);
  }
  // Each approved item and confirmed golden as its target, the hash its yes must carry, and its file.
  const approved = projectApprovals(run.root)
    .filter((e) => e.status === "approved")
    .map((e) =>
      e.kind === "golden"
        ? { ref: e.ref, hash: e.hash, file: relative(run.root, e.file!), what: "confirmed" }
        : { ref: e.ref, hash: typeof e.item.approved_hash === "string" ? e.item.approved_hash.trim() : "", file: relative(run.root, e.file!), what: "approved" },
    );
  if (!approved.length) return { grader: "approvals", score: null, passed: !unreadable, details: [...details, "not graded: nothing is approved"] };
  let ok = 0;
  for (const { ref, hash, file, what } of approved) {
    const why = hash ? unbacked(replies, ref, hash, what) : `${ref} is approved without an approved_hash, so no ledger yes can match it; ${again(ref)}.`;
    if (why) details.push(`${file}: ${why}`);
    else ok++;
  }
  if (ok === approved.length && !unreadable) details.push(`All ${ok} approved item(s) have the owner's latest reply as a yes with a matching hash.`);
  return { grader: "approvals", score: ok / approved.length, passed: ok === approved.length && !unreadable, details };
}

// approvals: every approved item has a yes in .sl/ledger.jsonl for its target with a content hash
// equal to its approved_hash. Without a ledger (it arrives with sl reply) nothing is graded yet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accessEntry, type ApprovalEntry, metricEntries, modelEntries } from "../../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { listGoldens, listModels, loadAccess, loadMetrics, loadSource } from "../../skills/semantic-layer/scripts/lib/project.ts";
import type { Dialect } from "../../skills/semantic-layer/scripts/lib/types.ts";
import type { GraderResult, RunFiles } from "./types.ts";

export const LEDGER = ".sl/ledger.jsonl";

// The approved models, fields, joins, metrics and access file of a root, with the file each sits in.
export function approvedEntries(root: string): { entry: ApprovalEntry; file: string }[] {
  const models = listModels(root);
  const out: { entry: ApprovalEntry; file: string }[] = [];
  for (const { path, model } of models) {
    let dialect: Dialect | undefined;
    try {
      dialect = loadSource(root, model.source).dialect;
    } catch {
      dialect = undefined;
    }
    const lookup = (name: string) => models.find((m) => m.model.source === model.source && m.model.model === name)?.model;
    for (const entry of modelEntries(model.source, model, lookup, dialect)) out.push({ entry, file: relative(root, path) });
  }
  for (const entry of metricEntries(loadMetrics(root).metrics)) out.push({ entry, file: "semantic/metrics.yaml" });
  const access = accessEntry(loadAccess(root));
  if (access) out.push({ entry: access, file: "semantic/access.yaml" });
  return out.filter((x) => x.entry.item.status === "approved");
}

// Approved items and confirmed goldens: the denominator of the effort metrics.
export function approvedCount(root: string): number {
  return approvedEntries(root).length + listGoldens(root).filter((g) => g.golden.status === "approved").length;
}

function relative(root: string, path: string): string {
  return `semantic/${path.slice(root.length + 1).split("\\").join("/")}`;
}

interface LedgerLine {
  target?: unknown;
  content_hash?: unknown;
  verdict?: unknown;
}

export function gradeApprovals(run: RunFiles): GraderResult {
  const path = join(run.root, LEDGER);
  if (!existsSync(path)) return { grader: "approvals", score: null, passed: true, details: ["not graded: no ledger yet (semantic/.sl/ledger.jsonl)"] };
  const details: string[] = [];
  const yes = new Set<string>();
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const e = JSON.parse(line) as LedgerLine;
        if (e.verdict === "yes" && typeof e.target === "string" && typeof e.content_hash === "string") yes.add(`${e.target}\0${e.content_hash}`);
      } catch {
        details.push(`semantic/${LEDGER} line ${i + 1} is not JSON; it records no answer.`);
      }
    });
  const approved = approvedEntries(run.root);
  if (!approved.length) return { grader: "approvals", score: null, passed: !details.length, details: [...details, "not graded: nothing is approved"] };
  let ok = 0;
  for (const { entry, file } of approved) {
    const hash = typeof entry.item.approved_hash === "string" ? entry.item.approved_hash.trim() : "";
    if (!hash) details.push(`${file}: ${entry.ref} is approved without an approved_hash, so no ledger yes can match it.`);
    else if (!yes.has(`${entry.ref}\0${hash}`)) details.push(`${file}: ${entry.ref} is approved, but the ledger holds no yes for it with hash ${hash}.`);
    else ok++;
  }
  if (ok === approved.length) details.push(`All ${ok} approved item(s) have a ledger yes with a matching hash.`);
  return { grader: "approvals", score: ok / approved.length, passed: ok === approved.length && !details.some((d) => d.includes("is not JSON")), details };
}

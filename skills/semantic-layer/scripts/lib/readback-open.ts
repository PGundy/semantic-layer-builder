// The items of the pending readbacks (.semlayer/pending/) that still wait for the owner's answer, as
// semlayer next asks them and semlayer status counts them (spec: .semlayer/pending/<readback_id>.json).
// It reads files only and writes nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestReply } from "./ledger.ts";
import { paths } from "./project.ts";
import { PENDING_DIR } from "./readback.ts";
import { schemaIssues } from "./schema.ts";
import type { TargetState } from "./status.ts";
import type { LedgerReply, PendingReadback, ReadbackItem } from "./types.ts";

// The readbacks in .semlayer/pending/, oldest first; a file that is not a valid readback is skipped (semlayer validate reports it).
export function pendingReadbacks(root: string): PendingReadback[] {
  const dir = join(root, PENDING_DIR);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .map((f) => /^(rb_(\d{4,}))\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[2]) - Number(b[2]));
  return ids.flatMap((m) => {
    try {
      const data = JSON.parse(readFileSync(join(dir, m[0]), "utf8")) as PendingReadback;
      return schemaIssues("pending", data, m[0]).length || data.readback_id !== m[1] ? [] : [data];
    } catch {
      return [];
    }
  });
}

// The hash a target read back with `stored` has now, or null when it is gone. A golden's hash covers
// rows only a run gives, so while its file exists the hash a readback stored stands, as semlayer reply reads it.
export function hashNow(root: string, targets: ReadonlyMap<string, TargetState>, target: string, stored: string): string | null {
  const golden = /^golden:([a-z][a-z0-9_]*)$/.exec(target)?.[1];
  if (golden) return existsSync(paths(root).golden(golden)) ? stored : null;
  return targets.get(target)?.hash ?? null;
}

// Whether the owner's latest reply to the target, in any readback, gave a verdict on it with this
// content hash. A later reply without a verdict, or one to other content, leaves the target open: the
// one rule approval, the declined check, the open items and the done readbacks all read.
export function answered(replies: LedgerReply[], target: string, hash: string | null): boolean {
  const r = latestReply(replies, target);
  return !!r && r.verdict !== null && r.content_hash === hash;
}

const order = (id: string) => Number(id.slice(3));

// The reply that settles an item of an older readback: the owner's latest reply to the same target is a
// verdict recorded against a newer readback that holds the target with that hash, and the target still
// has that hash (a confirmed golden its confirmed hash; a draft golden's stands while its file exists).
// Only a recorded reply supersedes an item, never text in a file.
function supersedingReply(root: string, targets: ReadonlyMap<string, TargetState>, replies: LedgerReply[], pending: PendingReadback[], p: PendingReadback, item: ReadbackItem): LedgerReply | undefined {
  const r = latestReply(replies, item.target);
  if (!r || r.verdict === null || order(r.readback_id) <= order(p.readback_id)) return undefined;
  const newer = pending.find((x) => x.readback_id === r.readback_id);
  if (!newer?.items.some((i) => i.n === r.item && i.target === item.target && i.content_hash === r.content_hash)) return undefined;
  const now = item.target.startsWith("golden:") && targets.has(item.target) ? targets.get(item.target)!.hash : hashNow(root, targets, item.target, r.content_hash);
  return now === r.content_hash ? r : undefined;
}

export interface OpenReadback {
  readback: PendingReadback;
  // Its items still as they were read back.
  current: ReadbackItem[];
  // Those the owner has not answered and no answer to a newer readback of the same target settles.
  open: ReadbackItem[];
}

// Every pending readback, oldest first, with its current and open items.
export function openReadbacks(root: string, targets: ReadonlyMap<string, TargetState>, replies: LedgerReply[]): OpenReadback[] {
  const pending = pendingReadbacks(root);
  return pending.map((p) => {
    const current = p.items.filter((i) => hashNow(root, targets, i.target, i.content_hash) === i.content_hash);
    const open = current.filter((i) => !answered(replies, i.target, i.content_hash) && !supersedingReply(root, targets, replies, pending, p, i));
    return { readback: p, current, open };
  });
}

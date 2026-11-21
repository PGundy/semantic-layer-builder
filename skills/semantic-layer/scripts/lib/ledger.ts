// The answer ledger, .semlayer/ledger.jsonl under the semantic root: one JSON object per line, added by
// semlayer reply and semlayer question resolve, whose earlier lines never change. Each line holds the owner's
// words, with credentials redacted, never data values. The commands that add a line hold the root's
// lock (lib/lock.ts) from reading the ledger for the next id to writing the line.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { redactCredentials } from "./credentials.ts";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";
import { plainText } from "./output.ts";
import { PENDING_DIR } from "./readback.ts";
import type { ApprovalLedger } from "./approval-hash.ts";
import type { LedgerConfirm, LedgerEntry, LedgerQuestion, LedgerReply, PendingReadback } from "./types.ts";
import { schemaIssues } from "./schema.ts";

export const LEDGER_FILE = ".semlayer/ledger.jsonl";
// The owner-named step that confirms approvals given before the ledger recorded their yes.
export const CONFIRM_EXISTING = 'semlayer approve --confirm-existing --by "<owner>" --reply "<owner\'s words>"';
const ID = /^ans_(\d{4,})$/;
const RESTORE = `restore it from version control (git checkout -- ${LEDGER_FILE}), then run semlayer validate`;

// Owner text as stored: line breaks and tabs as spaces, control characters and ANSI escapes removed,
// then every credential lib/credentials.ts recognises replaced by [redacted].
export function ownerText(raw: string): { text: string; redacted: boolean } {
  return redactCredentials(plainText(raw.replace(/\r\n|[\r\n\t]/g, " ")).trim());
}

// A pending readback by id, checked against its schema.
export function readPending(root: string, id: string): PendingReadback {
  const rel = `${PENDING_DIR.split("\\").join("/")}/${id}.json`;
  const file = join(root, rel);
  if (!/^rb_\d{4,}$/.test(id) || !existsSync(file))
    throw new UserError(`There is no readback ${JSON.stringify(id)} in ${PENDING_DIR.split("\\").join("/")}/. Read the item to the owner first with semlayer readback --targets <ref>, and use the readback id it prints.`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UserError(`${rel} is not valid JSON; run semlayer validate, then semlayer readback --targets <ref> again.`, "semlayer validate");
  }
  if (schemaIssues("pending", data, rel).length) throw new UserError(`${rel} does not match its schema; run semlayer validate, then semlayer readback --targets <ref> again.`, "semlayer validate");
  return data as PendingReadback;
}

// One ledger line: the entry with its keys sorted, so the same answer always writes the same bytes.
export function ledgerLine(entry: LedgerEntry | LedgerConfirm): string {
  const obj = entry as unknown as Record<string, unknown>;
  return `${JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])))}\n`;
}

// .semlayer may be a link to a directory inside the root; a link that points nowhere is refused, since
// creating its target could write anywhere. The ledger file itself is never a link (see openLedger).
function assertInside(root: string, path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  if (!existsSync(path)) throw new UserError(`Refusing to write ${LEDGER_FILE}: ${path} is a symbolic link to nothing, which could point outside the semantic root ${resolve(root)}. Nothing was written. Remove the link and run this again.`);
  const r = realpathSync(root);
  const p = realpathSync(path);
  if (p !== r && !p.startsWith(r + sep)) throw new UserError(`Refusing to write ${LEDGER_FILE}: ${path} resolves outside the semantic root ${resolve(root)}. Nothing was written.`);
}

// An entry before the ledger gives it an id.
export type NewLedgerEntry = Omit<LedgerReply, "id"> | Omit<LedgerQuestion, "id">;

export interface LedgerAppender {
  // The id the next line gets.
  id: string;
  // Appends the entry under that id, creating .semlayer/ and the file when missing.
  append(entry: NewLedgerEntry): LedgerEntry;
  // Appends the entries in order under that id and the ones after it, in one write: all of them
  // land or none do. Each line is the one append would write for its entry.
  appendAll(entries: NewLedgerEntry[]): LedgerEntry[];
  // Appends the owner's confirmation of earlier approvals (semlayer approve --confirm-existing) under that id.
  appendConfirm(entry: Omit<LedgerConfirm, "id">): LedgerConfirm;
}

// Checks that the ledger can take a line (inside the root, a file whose every line is a JSON object
// and whose last line ends) and returns the id the next line gets. Nothing is written until append.
export function openLedger(root: string): LedgerAppender {
  const file = join(root, LEDGER_FILE);
  assertInside(root, dirname(file));
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new UserError(`Refusing to write ${LEDGER_FILE}: it is a symbolic link, and the ledger is a plain file inside the semantic root. Nothing was written. Replace the link with the file it points to and run this again.`);
  if (existsSync(dirname(file)) && !statSync(dirname(file)).isDirectory()) throw new UserError(`${dirname(LEDGER_FILE)} is not a directory, so the answer cannot be recorded; nothing was written. Move it aside and run this again.`);
  let max = 0;
  if (existsSync(file)) {
    if (!lstatSync(file).isFile()) throw new UserError(`${LEDGER_FILE} is not a file, so the answer cannot be recorded; nothing was written. Move it aside and run this again.`);
    const text = readFileSync(file, "utf8");
    if (text && !text.endsWith("\n")) throw new UserError(`The last line of ${LEDGER_FILE} has no line break (an append was cut off); nothing was written. The ledger is append-only: ${RESTORE}.`, "semlayer validate");
    text.split("\n").slice(0, -1).forEach((line, i) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        data = undefined;
      }
      if (typeof data !== "object" || data === null || Array.isArray(data))
        throw new UserError(`Line ${i + 1} of ${LEDGER_FILE} is not a JSON object; nothing was written. The ledger is append-only: ${RESTORE}.`, "semlayer validate");
      const m = ID.exec(String((data as { id?: unknown }).id));
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  const idAt = (k: number) => `ans_${String(max + 1 + k).padStart(4, "0")}`;
  const write = <T extends LedgerEntry | LedgerConfirm>(entries: Omit<T, "id">[]): T[] => {
    const full = entries.map((entry, k) => ({ ...entry, id: idAt(k) }) as T);
    mkdirSync(dirname(file), { recursive: true });
    // The ledger with the new lines replaces the file in one rename, so a cut-off write leaves it
    // whole. A link put at the path after openLedger's check is refused here, and one put there
    // after this check is replaced by the rename, never followed.
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new UserError(`${LEDGER_FILE} is no longer a plain file inside the semantic root, so the answer was not recorded; nothing was written. Run semlayer validate, then run this again.`);
    writeFileAtomic(file, (stat ? readFileSync(file, "utf8") : "") + full.map(ledgerLine).join(""), { replaceLink: true });
    return full;
  };
  return {
    id: idAt(0),
    append: (entry) => write<LedgerEntry>([entry])[0]!,
    appendAll: (entries) => (entries.length ? write<LedgerEntry>(entries) : []),
    appendConfirm: (entry) => write<LedgerConfirm>([entry])[0]!,
  };
}

// A value for a suggested shell command, in double quotes.
export function shellQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

// Lookups ------------------------------------------------------------------------------------------

// A reply line as approval reads it: kind reply, with the fields an approval needs in their shape.
function isReply(data: unknown): data is LedgerReply {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    d.kind === "reply" &&
    typeof d.id === "string" &&
    typeof d.target === "string" &&
    typeof d.content_hash === "string" &&
    typeof d.by === "string" &&
    d.by.trim() !== "" &&
    typeof d.at === "string" &&
    d.at.trim() !== "" &&
    (d.verdict === null || d.verdict === "yes" || d.verdict === "no" || d.verdict === "change") &&
    (d.about === undefined || (d.about === "access" && d.verdict === "change"))
  );
}

// A confirm line as approval reads it: kind confirm, a non-empty by and at, and each target with its hash.
function isConfirm(data: unknown): data is LedgerConfirm {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    d.kind === "confirm" &&
    typeof d.id === "string" &&
    typeof d.by === "string" &&
    d.by.trim() !== "" &&
    typeof d.at === "string" &&
    d.at.trim() !== "" &&
    Array.isArray(d.targets) &&
    d.targets.every((t) => typeof t === "object" && t !== null && typeof (t as { target?: unknown }).target === "string" && typeof (t as { content_hash?: unknown }).content_hash === "string")
  );
}

// The kind: reply lines of ledger text, in file order. Strict, as semlayer approve reads it, a line that is
// not JSON, a reply line without the fields an approval needs, or a last line without a line break
// is an error, since skipping it could let an earlier yes stand over a later no. Otherwise such lines
// are skipped (semlayer validate reports them on its own).
export function ledgerReplies(text: string, strict = false): LedgerReply[] {
  return ledgerAnswers(text, strict).filter((e): e is LedgerReply => e.kind === "reply");
}

// The kind: reply and kind: confirm lines of ledger text, in file order, read as ledgerReplies reads them.
export function ledgerAnswers(text: string, strict = false): (LedgerReply | LedgerConfirm)[] {
  const fail = (why: string) => {
    throw new UserError(`${LEDGER_FILE} cannot be read: ${why}, so no approval can rely on it; nothing was approved. ${RESTORE[0]!.toUpperCase()}${RESTORE.slice(1)}.`, "semlayer validate");
  };
  if (strict && text && !text.endsWith("\n")) fail("its last line has no line break (an append was cut off)");
  const out: (LedgerReply | LedgerConfirm)[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      if (strict) fail(`line ${i + 1} is not JSON`);
      return;
    }
    const kind = typeof data === "object" && data !== null ? (data as { kind?: unknown }).kind : undefined;
    if (isReply(data) || isConfirm(data)) out.push(data);
    else if (strict && kind === "confirm") fail(`line ${i + 1} is a confirm line without the fields an approval needs (a non-empty by and at, and targets each with a target and a content_hash)`);
    else if (strict && kind === "reply") fail(`line ${i + 1} is a reply line without the fields an approval needs (a non-empty by and at, a target, a content_hash, a verdict; about only as access on a change)`);
    else if (strict && kind !== "question") fail(`line ${i + 1} is not a reply, question or confirm line`);
  });
  return out;
}

// The reply lines of ledger text as every reader counts them: read strictly, as semlayer approve reads
// them, or none with the reason when a line would make semlayer approve refuse, so a yes approve would not
// accept counts nowhere.
export function countedReplies(text: string): { replies: LedgerReply[]; problem: string | null } {
  try {
    return { replies: ledgerReplies(text, true), problem: null };
  } catch (e) {
    if (e instanceof UserError) return { replies: [], problem: e.message };
    throw e;
  }
}

// The semantic root's ledger as semlayer status, semlayer next and the typed edits count it: readReplies, or no
// replies with the reason semlayer approve would give for refusing it.
export function ledgerState(root: string): { replies: LedgerReply[]; problem: string | null } {
  try {
    return { replies: readReplies(root), problem: null };
  } catch (e) {
    if (e instanceof UserError) return { replies: [], problem: e.message };
    throw e;
  }
}

// The kind: reply lines of the semantic root's ledger (none when it has no ledger), read strictly.
export function readReplies(root: string): LedgerReply[] {
  const file = join(root, LEDGER_FILE);
  if (!existsSync(file)) return [];
  // The ledger, and the .semlayer directory holding it, must lie inside the semantic root, not behind a link.
  if (!lstatSync(dirname(file)).isDirectory() || !lstatSync(file).isFile()) throw new UserError(`${LEDGER_FILE} is not a plain file inside the semantic root (the ledger or its .semlayer directory is a link, or the ledger is not a file), so no approval can rely on it; nothing was approved. ${RESTORE[0]!.toUpperCase()}${RESTORE.slice(1)}.`);
  return ledgerReplies(readFileSync(file, "utf8"), true);
}

// The owner's latest reply to a target: the last reply line for it, whatever its verdict, so a later
// no, change or reply without a verdict overrides an earlier yes. A change to who sees the item
// (about: access) is not a reply to its content: it is settled in the access phase, and is skipped.
export function latestReply(replies: LedgerReply[], target: string): LedgerReply | undefined {
  for (let i = replies.length - 1; i >= 0; i--) if (replies[i]!.target === target && replies[i]!.about === undefined) return replies[i];
  return undefined;
}

// The owner's changes to who sees an item (semlayer reply --about access) that are still open: no yes to
// access.yaml was recorded after them. That yes follows a readback of the whole file, so it settles them.
export function openAccessChanges(replies: LedgerReply[]): LedgerReply[] {
  let settled = -1;
  replies.forEach((r, i) => {
    if (r.target === "access" && r.about === undefined && r.verdict === "yes") settled = i;
  });
  return replies.filter((r, i) => r.about === "access" && i > settled);
}

// Whether the owner's latest reply to a target is a yes to the content it has as it stands.
export function currentYes(replies: LedgerReply[], target: string, hash: string): LedgerReply | undefined {
  const r = latestReply(replies, target);
  return r && r.verdict === "yes" && r.content_hash === hash ? r : undefined;
}

// The ledger as approvals read it (approval-hash.ts ApprovalLedger), from its text (undefined when the
// project has none): each target's latest answer about its content, read strictly, so a ledger
// semlayer approve would refuse backs nothing. An empty file is no ledger.
export function approvalLedger(text: string | undefined): ApprovalLedger {
  const latest: ApprovalLedger["latest"] = new Map();
  if (text === undefined || text.trim() === "") return { present: false, latest };
  let answers: (LedgerReply | LedgerConfirm)[] = [];
  let unreadable = false;
  try {
    answers = ledgerAnswers(text, true);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    unreadable = true;
  }
  let confirmedBefore = false;
  for (const a of answers) {
    if (a.kind === "confirm") confirmedBefore = true;
    if (a.kind === "confirm") for (const t of a.targets) latest.set(t.target, { confirmed: t.content_hash });
    else if (a.about === undefined) latest.set(a.target, { reply: a });
  }
  return { present: true, latest, ...(unreadable ? { unreadable } : {}), ...(confirmedBefore ? { confirmedBefore } : {}) };
}

// The semantic root's ledger as approvals read it. A ledger that is not a plain file inside the root
// is present and backs nothing.
export function readApprovalLedger(root: string): ApprovalLedger {
  const file = join(root, LEDGER_FILE);
  if (!lstatSync(file, { throwIfNoEntry: false })) return approvalLedger(undefined);
  if (!lstatSync(dirname(file)).isDirectory() || !lstatSync(file).isFile()) return { present: true, latest: new Map(), unreadable: true };
  return approvalLedger(readFileSync(file, "utf8"));
}

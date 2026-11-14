// The answer ledger, .sl/ledger.jsonl under the semantic root: one JSON object per line, appended by
// sl reply and sl question resolve and never rewritten. Each line holds the owner's words, with
// credentials redacted, never data values.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { redactCredentials } from "./credentials.ts";
import { UserError } from "./errors.ts";
import { plainText } from "./output.ts";
import { PENDING_DIR } from "./readback.ts";
import type { LedgerEntry, LedgerQuestion, LedgerReply, PendingReadback } from "./types.ts";
import { schemaIssues } from "./schema.ts";

export const LEDGER_FILE = ".sl/ledger.jsonl";
const ID = /^ans_(\d{4,})$/;
const RESTORE = `restore it from version control (git checkout -- ${LEDGER_FILE}), then run sl validate`;

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
    throw new UserError(`There is no readback ${JSON.stringify(id)} in ${PENDING_DIR.split("\\").join("/")}/. Read the item to the owner first with sl readback --targets <ref>, and use the readback id it prints.`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UserError(`${rel} is not valid JSON; run sl validate, then sl readback --targets <ref> again.`, "sl validate");
  }
  if (schemaIssues("pending", data, rel).length) throw new UserError(`${rel} does not match its schema; run sl validate, then sl readback --targets <ref> again.`, "sl validate");
  return data as PendingReadback;
}

// One ledger line: the entry with its keys sorted, so the same answer always writes the same bytes.
export function ledgerLine(entry: LedgerEntry): string {
  const obj = entry as unknown as Record<string, unknown>;
  return `${JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]])))}\n`;
}

// .sl may be a link to a directory inside the root; a link that points nowhere is refused, since
// creating its target could write anywhere. The ledger file itself is never a link (see openLedger).
function assertInside(root: string, path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  if (!existsSync(path)) throw new UserError(`Refusing to write ${LEDGER_FILE}: ${path} is a symbolic link to nothing, which could point outside the semantic root ${resolve(root)}. Nothing was written. Remove the link and run this again.`);
  const r = realpathSync(root);
  const p = realpathSync(path);
  if (p !== r && !p.startsWith(r + sep)) throw new UserError(`Refusing to write ${LEDGER_FILE}: ${path} resolves outside the semantic root ${resolve(root)}. Nothing was written.`);
}

// Append without following a link at the file, so a link put there after openLedger's check still
// cannot send the line elsewhere.
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

// An entry before the ledger gives it an id.
export type NewLedgerEntry = Omit<LedgerReply, "id"> | Omit<LedgerQuestion, "id">;

export interface LedgerAppender {
  // The id the next line gets.
  id: string;
  // Appends the entry under that id, creating .sl/ and the file when missing.
  append(entry: NewLedgerEntry): LedgerEntry;
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
    if (text && !text.endsWith("\n")) throw new UserError(`The last line of ${LEDGER_FILE} has no line break (an append was cut off); nothing was written. The ledger is append-only: ${RESTORE}.`, "sl validate");
    text.split("\n").slice(0, -1).forEach((line, i) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        data = undefined;
      }
      if (typeof data !== "object" || data === null || Array.isArray(data))
        throw new UserError(`Line ${i + 1} of ${LEDGER_FILE} is not a JSON object; nothing was written. The ledger is append-only: ${RESTORE}.`, "sl validate");
      const m = ID.exec(String((data as { id?: unknown }).id));
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  const id = `ans_${String(max + 1).padStart(4, "0")}`;
  return {
    id,
    append(entry) {
      const full = { ...entry, id } as LedgerEntry;
      mkdirSync(dirname(file), { recursive: true });
      const fd = openSync(file, APPEND_FLAGS, 0o644);
      try {
        writeSync(fd, ledgerLine(full));
      } finally {
        closeSync(fd);
      }
      return full;
    },
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
    (d.verdict === null || d.verdict === "yes" || d.verdict === "no" || d.verdict === "change")
  );
}

// The kind: reply lines of ledger text, in file order. Strict, as sl approve reads it, a line that is
// not JSON, a reply line without the fields an approval needs, or a last line without a line break
// is an error, since skipping it could let an earlier yes stand over a later no. Otherwise such lines
// are skipped (sl validate reports them on its own).
export function ledgerReplies(text: string, strict = false): LedgerReply[] {
  const fail = (why: string) => {
    throw new UserError(`${LEDGER_FILE} cannot be read: ${why}, so no approval can rely on it; nothing was approved. ${RESTORE[0]!.toUpperCase()}${RESTORE.slice(1)}.`, "sl validate");
  };
  if (strict && text && !text.endsWith("\n")) fail("its last line has no line break (an append was cut off)");
  const out: LedgerReply[] = [];
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
    if (isReply(data)) out.push(data);
    else if (strict && kind === "reply") fail(`line ${i + 1} is a reply line without the fields an approval needs (a non-empty by and at, a target, a content_hash, a verdict)`);
    else if (strict && kind !== "question") fail(`line ${i + 1} is not a reply or question line`);
  });
  return out;
}

// The kind: reply lines of the semantic root's ledger (none when it has no ledger), read strictly.
export function readReplies(root: string): LedgerReply[] {
  const file = join(root, LEDGER_FILE);
  if (!existsSync(file)) return [];
  // The ledger, and the .sl directory holding it, must lie inside the semantic root, not behind a link.
  if (!lstatSync(dirname(file)).isDirectory() || !lstatSync(file).isFile()) throw new UserError(`${LEDGER_FILE} is not a plain file inside the semantic root (the ledger or its .sl directory is a link, or the ledger is not a file), so no approval can rely on it; nothing was approved. ${RESTORE[0]!.toUpperCase()}${RESTORE.slice(1)}.`);
  return ledgerReplies(readFileSync(file, "utf8"), true);
}

// The owner's latest reply to a target: the last reply line for it, whatever its verdict, so a later
// no, change or reply without a verdict overrides an earlier yes.
export function latestReply(replies: LedgerReply[], target: string): LedgerReply | undefined {
  for (let i = replies.length - 1; i >= 0; i--) if (replies[i]!.target === target) return replies[i];
  return undefined;
}

// Whether the owner's latest reply to a target is a yes to the content it has as it stands.
export function currentYes(replies: LedgerReply[], target: string, hash: string): LedgerReply | undefined {
  const r = latestReply(replies, target);
  return r && r.verdict === "yes" && r.content_hash === hash ? r : undefined;
}

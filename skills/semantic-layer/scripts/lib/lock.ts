// One writer at a time under a semantic root, and whole-file writes (spec: Locking and whole-file writes).
//
// The lock is the file .sl/lock, created exclusively and holding the pid, command and start time of
// the command that writes. A command holds it while it reads, changes and writes; a second writer
// waits, then fails naming the holder. A lock whose process is gone is taken over. Every write goes
// to a temporary file beside its target and is renamed into place, so a reader, or a command that
// starts after a writer was killed, never sees half a file.
import { closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { UserError } from "./errors.ts";

export const LOCK_FILE = ".sl/lock";
export const DEFAULT_LOCK_WAIT_MS = 30_000;
const TEMP_SUFFIX = ".sl-tmp";

// Whole-file writes -----------------------------------------------------------------------------

// The temporary file a write to `path` goes through: a dot file beside it, named for this process,
// whose name no directory listing of the layer reads (none ends in .yaml, .yml or .json). A very
// long file name is cut, so the temporary name stays within a file system's limit.
export function tempPath(path: string, pid = process.pid): string {
  return join(dirname(path), `.${basename(path).slice(0, 200)}.${pid}${TEMP_SUFFIX}`);
}

export interface WriteOptions {
  // Write only where nothing is: an existing file, or a link, fails with code EEXIST.
  exclusive?: boolean;
  // Replace a symbolic link at the path with the file, where the default writes the file it points to.
  replaceLink?: boolean;
}

// Writes a whole file: the data goes to a temporary file in the same directory, which is then
// renamed over the path, so the path holds the previous bytes or the new ones and never a part.
// `data` may come in pieces (a snapshot is written in batches). An existing file keeps its mode.
// The temporary file is always a new plain file: whatever is at its path (a killed writer's file, a
// link someone put there) is removed first and never written through.
export function writeFileAtomic(path: string, data: string | Uint8Array | Iterable<string>, opts: WriteOptions = {}): void {
  let target = path;
  const link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  if (link && opts.exclusive) throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
  if (link && !opts.replaceLink) {
    try {
      target = realpathSync(path);
    } catch {
      // A link to nothing: the write creates the file it names, as a plain write does.
      return writeFileSync(path, typeof data === "string" || data instanceof Uint8Array ? data : [...data].join(""));
    }
  }
  const temp = tempPath(target);
  const mode = statSync(target, { throwIfNoEntry: false })?.mode;
  rmSync(temp, { force: true });
  const fd = openSync(temp, "wx");
  try {
    try {
      if (mode !== undefined) fchmodSync(fd, mode & 0o777);
      for (const piece of typeof data === "string" || data instanceof Uint8Array ? [data] : data) {
        const bytes = typeof piece === "string" ? Buffer.from(piece) : piece;
        for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
      }
    } finally {
      closeSync(fd);
    }
    if (opts.exclusive) createFrom(temp, target);
    else renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

// Puts the finished temporary file at a path that must be free. A hard link is created only where
// nothing is; a file system without hard links gets a check and a rename.
function createFrom(temp: string, target: string): void {
  try {
    linkSync(temp, target);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
    if (lstatSync(target, { throwIfNoEntry: false })) throw Object.assign(new Error(`EEXIST: file already exists, open '${target}'`), { code: "EEXIST" });
    return renameSync(temp, target);
  }
  unlinkSync(temp);
}

// Removes the temporary files a killed writer left under the root. They are harmless (no command
// reads them), and they are named for the writer's process, so only its files go.
function sweepTemps(dir: string, pid: number): void {
  const mine = `.${pid}${TEMP_SUFFIX}`;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) sweepTemps(join(dir, e.name), pid);
    else if (e.isFile() && e.name.startsWith(".") && e.name.endsWith(mine)) rmSync(join(dir, e.name), { force: true });
  }
}

// The lock --------------------------------------------------------------------------------------

export interface LockHolder {
  pid: number;
  // The sl command that holds the lock, by name alone: its arguments can hold the owner's words.
  command: string;
  // When it took the lock, an ISO timestamp from the command's clock.
  started: string;
}

interface Held {
  root: string;
  text: string;
  count: number;
  // The .sl directory, when taking the lock created it: removed again if the command leaves it empty.
  made?: string;
}

// The locks this process holds, by lock file path. A second request for one of them, from the same
// command or from another running in this process (the MCP server, a test), shares it.
const held = new Map<string, Held>();
// Roots whose .gitignore is known to name the lock.
const ignored = new Set<string>();

// How long a writer waits for the lock: SL_LOCK_WAIT_MS, or 30 seconds.
export function lockWaitMs(env: Record<string, string | undefined>): number {
  const raw = env.SL_LOCK_WAIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_LOCK_WAIT_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) throw new UserError(`SL_LOCK_WAIT_MS is the number of milliseconds a command waits for another to finish writing, not ${JSON.stringify(raw)}. Unset it or set a number, then run the command again.`);
  return ms;
}

// The directory that holds the lock: the root's .sl, created when missing (`made`). Null when .sl
// is not a directory inside the root (a link that leads outside it or to nothing, a file): no lock
// is taken there, since nothing is written outside the semantic root, and the command's own checks
// refuse it.
function lockDir(root: string): { dir: string; made: boolean } | null {
  const dir = join(root, dirname(LOCK_FILE));
  try {
    const made = !lstatSync(dir, { throwIfNoEntry: false });
    if (made) mkdirSync(dir, { recursive: true });
    const real = realpathSync(dir);
    return statSync(real).isDirectory() && real.startsWith(realpathSync(root) + sep) ? { dir: real, made } : null;
  } catch {
    return null;
  }
}

// What is at the lock path: its holder when it reads as one, and how long ago it was written.
// Undefined when nothing is there (released meanwhile). Anything but a plain file (a link, a
// directory) is a lock that cannot be read: it is never read through.
function readHolder(path: string): { holder: LockHolder | null; ageMs: number } | undefined {
  let stat;
  try {
    stat = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return { holder: null, ageMs: 0 };
  }
  if (!stat) return undefined;
  let holder: LockHolder | null = null;
  try {
    const data = stat.isFile() ? (JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder> | null) : null;
    if (data && typeof data.pid === "number" && Number.isInteger(data.pid) && data.pid > 0) holder = { pid: data.pid, command: String(data.command ?? ""), started: String(data.started ?? "") };
  } catch {
    holder = null;
  }
  return { holder, ageMs: Date.now() - stat.mtimeMs };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

// A lock is stale when its process is gone. One naming this process that this process does not hold
// was left by an earlier process with the same pid. One that cannot be read is being written (the
// holder creates it, then fills it), unless it has stayed that way for two seconds.
function stale(path: string, found: { holder: LockHolder | null; ageMs: number }): boolean {
  if (!found.holder) return found.ageMs > 2000;
  return found.holder.pid === process.pid ? !held.has(path) : !alive(found.holder.pid);
}

// Removes a stale lock. Two commands can find the same stale lock at once, and the slower must not
// remove the lock the faster then took: the removal happens under a second exclusive file, where the
// lock is read again. A takeover file left by a command killed inside these few lines is removed
// after five seconds. Returns whether the caller can try for the lock again at once: not when
// another command is clearing it, or when what is there cannot be removed (a directory), which the
// caller then waits on and names like any held lock.
function clearStale(root: string, path: string): boolean {
  const guard = `${path}.takeover`;
  let fd: number;
  try {
    fd = openSync(guard, "wx");
  } catch {
    const at = statSync(guard, { throwIfNoEntry: false })?.mtimeMs;
    if (at !== undefined && Date.now() - at > 5000) rmSync(guard, { force: true });
    return false;
  }
  try {
    const found = readHolder(path);
    if (found && stale(path, found)) {
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
      if (found.holder) sweepTemps(root, found.holder.pid);
    }
    return true;
  } finally {
    closeSync(fd);
    rmSync(guard, { force: true });
  }
}

function busy(path: string, holder: LockHolder | null, waitMs: number): UserError {
  const who = holder ? `sl ${holder.command} (process ${holder.pid}${holder.started ? `, started ${holder.started}` : ""})` : "another sl command";
  const stuck = holder ? `if process ${holder.pid} is no longer an sl command` : "if no sl command is running";
  return new UserError(
    `${who} is writing to this semantic layer and still held ${path} after ${waitMs} ms, so nothing was written. ` +
      `Run this command again once it has finished; ${stuck}, remove ${path} first.`,
  );
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let exitHooked = false;

function dropAll(): void {
  for (const [path, h] of held) {
    try {
      if (readFileSync(path, "utf8") === h.text) unlinkSync(path);
    } catch {
      // gone already
    }
  }
  held.clear();
}

// A signal that ends the process releases the locks first, then ends it as the signal would have.
function onSignal(signal: NodeJS.Signals): void {
  dropAll();
  for (const s of SIGNALS) process.off(s, onSignal);
  process.kill(process.pid, signal);
}

function release(path: string): void {
  const h = held.get(path);
  if (!h || --h.count > 0) return;
  // The rule that keeps the lock out of git is written while the lock is still held.
  if (!ignored.has(h.root)) {
    ignoreLock(h.root);
    ignored.add(h.root);
  }
  held.delete(path);
  try {
    if (readFileSync(path, "utf8") === h.text) unlinkSync(path);
    // A command that failed before it wrote anything leaves no empty .sl behind.
    if (h.made) rmdirSync(h.made);
  } catch {
    // gone already, or .sl holds the command's files
  }
  if (!held.size) for (const s of SIGNALS) process.off(s, onSignal);
}

// Takes the root's lock for `who` and returns its release, which is safe to call more than once.
// Waits up to `waitMs` for another process to release it, then throws a UserError naming the holder.
// The lock is also released when the process exits or is ended by a signal.
export async function acquireLock(root: string, who: { command: string; started: string }, waitMs = DEFAULT_LOCK_WAIT_MS): Promise<() => void> {
  const at = lockDir(root);
  if (!at) return () => {};
  const path = join(at.dir, basename(LOCK_FILE));
  let made = at.made;
  const text = `${JSON.stringify({ pid: process.pid, command: who.command, started: who.started } satisfies LockHolder)}\n`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const mine = held.get(path);
    if (mine) {
      mine.count++;
      break;
    }
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Another command removed the .sl it had made and left empty: make it again.
      if (code === "ENOENT" && lockDir(root)) {
        made = true;
        continue;
      }
      if (code !== "EEXIST")
        throw new UserError(`Cannot create the lock file ${path} (${(e as Error).message}), so nothing was written. Make the directory writable and run this command again.`);
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      held.set(path, { root, text, count: 1, ...(made ? { made: at.dir } : {}) });
      // A takeover file whose command was killed inside clearStale guards nothing now: the lock is live.
      rmSync(`${path}.takeover`, { force: true });
      if (!exitHooked) {
        exitHooked = true;
        process.on("exit", dropAll);
      }
      if (held.size === 1) for (const s of SIGNALS) process.on(s, onSignal);
      break;
    }
    const found = readHolder(path);
    if (!found) continue;
    if (stale(path, found) && clearStale(root, path)) continue;
    if (Date.now() >= deadline) throw busy(join(root, LOCK_FILE), found.holder, waitMs);
    await new Promise((done) => setTimeout(done, Math.max(1, Math.min(deadline - Date.now(), 5 + Math.random() * 20))));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(path);
  };
}

// Adds .sl/lock to the root's .gitignore, creating the file when the root has none: sl init calls
// it, and a root made before gets the rule when its first locked command ends. A .gitignore that is
// a link, or cannot be written, is left alone.
export function ignoreLock(root: string): void {
  const file = join(root, ".gitignore");
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return;
    const text = stat ? readFileSync(file, "utf8") : "";
    if (text.split(/\r?\n/).some((l) => l.trim() === LOCK_FILE)) return;
    writeFileAtomic(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${LOCK_FILE}\n`);
  } catch {
    // The rule is a convenience: a root whose .gitignore cannot be written still locks.
  }
}

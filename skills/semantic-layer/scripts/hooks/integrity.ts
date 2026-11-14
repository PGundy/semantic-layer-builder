#!/usr/bin/env bun
// The plugin's before-and-after comparison of the answer ledger, and its refusal to read a
// connection's env file (spec: Hand edits). guard-edits.ts calls runBefore from its PreToolUse run;
// plugin.json runs this file after a Bash call or one of the MCP server's sl tools (PostToolUse and
// PostToolUseFailure) and before one of those MCP tools.
//
// Before a Bash call that is neither a plain sl command nor a git-only command, the hook copies
// .sl/ledger.jsonl and .sl/pending/ of every semantic root it can find into its state directory.
// After the call it compares. A difference no sl or git command could have made is put back and
// reported; one made while sl or git ran at the same time is left and reported. A call whose
// after-check never ran is compared at the next before-call. The state directory is
// ${CLAUDE_PLUGIN_DATA}/ledger-guard, or a private directory under the system temp directory.
// An error of the hook's own never refuses a call: it warns on stderr and lets the call through.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { commandStart, SHELLS, tokenize } from "./shell-writes.ts";

type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// The path with links resolved, for a file that may not exist yet.
export function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync.native(cur), ...rest);
}

// The nearest directory holding semantic.yaml at or above `p`.
export function semanticRoot(p: string): string | undefined {
  for (let dir = p; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "semantic.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

// --- Shell commands --------------------------------------------------------------------------

type Word = { word: string; dynamic: boolean; pattern?: boolean };

interface Simple {
  words: Word[];
  // The files it reads through < and writes through > and its kin.
  reads: Word[];
  writes: Word[];
  // Heredoc bodies and <<< strings on its stdin.
  stdin: string[];
}

const SEPARATORS = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")"]);

// The simple commands of a command line, the text of each $(...) and `...` in it, and whether it
// leaves a command running (&).
function parseShell(command: string): { commands: Simple[]; subs: string[]; background: boolean } {
  const subs: string[] = [];
  const toks = tokenize(command, subs);
  const commands: Simple[] = [];
  let cur: Simple = { words: [], reads: [], writes: [], stdin: [] };
  let background = false;
  const flush = () => {
    if (cur.words.length || cur.reads.length || cur.writes.length) commands.push(cur);
    cur = { words: [], reads: [], writes: [], stdin: [] };
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if ("word" in t) {
      cur.words.push(t);
      continue;
    }
    if (SEPARATORS.has(t.op)) {
      if (t.op === "&") background = true;
      flush();
      continue;
    }
    if (t.body !== undefined) cur.stdin.push(t.body);
    if (t.op === "<<" || t.op === "<<-") continue;
    const target = toks[i + 1];
    if (!target || !("word" in target)) continue;
    i++;
    if (t.op === "<<<") cur.stdin.push(target.word);
    else if ((t.op === ">&" || t.op === "<&") && /^(\d+-?|-)$/.test(target.word)) continue;
    else if (t.op === "<" || t.op === "<&") cur.reads.push(target);
    else if (t.op === "<>") cur.reads.push(target), cur.writes.push(target);
    else cur.writes.push(target);
  }
  flush();
  return { commands, subs, background };
}

// The directories a `cd` or `pushd` may leave the shell in, added to `dirs`; false when it cannot be followed.
function follow(args: Word[], dirs: string[]): boolean {
  const to = args.filter((a) => !a.word.startsWith("-"));
  if (to.length > 1 || args.some((a) => a.dynamic || a.word === "-")) return false;
  for (const d of [...dirs]) {
    const next = resolve(d, expandHome(to[0]?.word ?? "~"));
    if (dirs.length < 8 && !dirs.includes(next)) dirs.push(next);
  }
  return true;
}

// --- The env file ----------------------------------------------------------------------------

const SECRET = "This file holds the connection secret. sl reads it itself, and you never need its contents. To check the connection, run sl setup --source <s>.";
const READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "source", ".", "tac", "nl", "od", "xxd", "strings", "base64", "bat"]);
const GREPS = new Set(["grep", "egrep", "fgrep", "rg"]);
// Shell words that stand before a command's name: `if [ -f .env ]; then cat .env; fi`, `{ cat .env; }`.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc"]);
const SCAN_HINT = "To search the other files, name a subdirectory or add --exclude='.env*'.";
const isEnvName = (name: string) => /^\.env(\..+)?$/.test(name) && name !== ".env.example";

// Whether a directory is a semantic root or directly holds one.
function nearRoot(dir: string): boolean {
  if (existsSync(join(dir, "semantic.yaml")) || existsSync(join(dir, "semantic", "semantic.yaml"))) return true;
  try {
    return readdirSync(dir, { withFileTypes: true }).slice(0, 500).some((e) => !e.isFile() && existsSync(join(dir, e.name, "semantic.yaml")));
  } catch {
    return false;
  }
}

// Whether a file is an env file a semantic root would load: .env or .env.<name> (not .env.example)
// in a semantic root or the directory holding one, or the file SL_ENV_FILE names. sl's own lookup
// is lib/env-file.ts; this is the short path rule the hook needs, and it reads no file.
function isEnvFile(abs: string, cwd: string, env: Env): boolean {
  if (!existsSync(abs)) return false;
  const real = realPath(abs);
  if (env.SL_ENV_FILE && realPath(resolve(cwd, expandHome(env.SL_ENV_FILE))) === real) return true;
  return [abs, real].some((p) => isEnvName(basename(p)) && nearRoot(dirname(p)));
}

// The env files in a directory, for a pattern or a recursive search that names the directory,
// less those whose name the search leaves out (`skip`).
function envFilesIn(dir: string, cwd: string, env: Env, pattern?: string, skip?: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const glob = pattern === undefined ? undefined : new Bun.Glob(pattern);
  return names.filter((n) => isEnvName(n) && (!glob || glob.match(n)) && !skip?.(n)).map((n) => join(dir, n)).filter((p) => isEnvFile(p, cwd, env));
}

// Where a simple command's name sits: past its assignments and prefixes (commandStart) and past the
// shell keywords before it (`then`, `do`, `{`, `!`, `function <name>`).
function nameAt(words: Word[]): number {
  for (let k = 0; ; k++) {
    k += commandStart(words.slice(k));
    const w = words[k];
    if (!w || w.dynamic) return k;
    if (w.word === "function") k++;
    else if (!KEYWORDS.has(w.word)) return k;
  }
}

// The files a grep is given: not its options, the values of -e, -f, -A, -B, -C and -m, or the
// pattern, which is its first plain argument unless -e or -f gave one.
function grepFiles(args: Word[]): Word[] {
  const plain: Word[] = [];
  let pattern = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!.word;
    if (/^(-[A-Za-z]*[ef]|--regexp(=|$)|--file(=|$))/.test(w)) pattern = true;
    if (/^(-[A-Za-z]*[efABCm]|--regexp|--file|--exclude|--include)$/.test(w)) i++;
    else if (!w.startsWith("-") || w === "-") plain.push(args[i]!);
  }
  return pattern ? plain : plain.slice(1);
}

type Skip = (name: string) => boolean;

interface EnvRead {
  file: string;
  // Found by a recursive search of its directory, not named by the command.
  scan: boolean;
}

// The env files a shell command reads with cat, head, tail, less, more, grep, sed, awk, source, "."
// and their kin, or through <, also inside $(...), `...`, `sh -c` strings, a shell's heredoc and eval.
function envFilesRead(command: string, cwd: string, env: Env, depth = 0, bases: string[] = [cwd]): EnvRead[] {
  const { commands, subs } = parseShell(command);
  const dirs = [...bases];
  const out: EnvRead[] = [];
  const named = (files: string[]) => out.push(...files.map((file) => ({ file, scan: false })));
  const scanned = (dir: string, skip: Skip) => out.push(...envFilesIn(dir, cwd, env, undefined, skip).map((file) => ({ file, scan: true })));
  const nested = (text: string) => depth < 3 && out.push(...envFilesRead(text, cwd, env, depth + 1, dirs));
  // `skip` is set for a recursive grep: the file names its --exclude and --include leave out.
  const read = (w: Word, skip?: Skip) => {
    if (w.dynamic) return;
    const p = expandHome(w.word);
    for (const abs of isAbsolute(p) ? [p] : dirs.map((d) => resolve(d, p))) {
      // An unquoted pattern matches a dot file only when its last part starts with a dot.
      if (w.pattern && /[*?[{]/.test(basename(abs)) && !/[*?[{]/.test(dirname(abs))) {
        if (basename(abs).startsWith(".")) named(envFilesIn(dirname(abs), cwd, env, basename(abs)));
      } else if (isEnvFile(abs, cwd, env)) named([abs]);
      else if (skip && existsSync(abs) && statSync(abs).isDirectory()) scanned(abs, skip);
    }
  };
  for (const c of commands) {
    for (const w of c.reads) read(w);
    const k = nameAt(c.words);
    const cmd = c.words[k];
    if (!cmd || cmd.dynamic) continue;
    const name = basename(cmd.word);
    const args = c.words.slice(k + 1);
    if (name === "cd" || name === "pushd") follow(args, dirs);
    else if (SHELLS.has(name)) {
      const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.word));
      if (at >= 0 && args[at + 1]) nested(args[at + 1]!.word);
      else c.stdin.forEach(nested);
    } else if (name === "eval") nested(args.map((a) => a.word).join(" "));
    else if (READERS.has(name)) {
      const files = GREPS.has(name) ? grepFiles(args) : args.filter((a) => !a.word.startsWith("-") || a.word === "-");
      // A recursive grep reads the dot files of the directories it is given; rg skips them.
      const recursive = GREPS.has(name) && name !== "rg" && args.some((a) => /^-[A-Za-z]*[rR]/.test(a.word) || /^--(dereference-)?recursive$/.test(a.word));
      const globs = (flag: string) => args.flatMap((a, i) => (a.word === flag ? [args[i + 1]?.word ?? ""] : a.word.startsWith(`${flag}=`) ? [a.word.slice(flag.length + 1)] : []));
      const [exclude, include] = [globs("--exclude"), globs("--include")];
      const matches = (n: string, patterns: string[]) => patterns.some((x) => new Bun.Glob(x).match(n));
      const skip = recursive ? (n: string) => matches(n, exclude) || (include.length > 0 && !matches(n, include)) : undefined;
      for (const f of files) read(f, skip);
      if (skip && !files.length) for (const d of dirs) scanned(d, skip);
    }
  }
  subs.forEach(nested);
  return out;
}

// The refusal for a Read call or a shell command that reads an env file, or undefined.
export function envFileRefusal(tool: string, input: Obj, cwd: string, env: Env = process.env): string | undefined {
  let reads: EnvRead[] = [];
  if (tool === "Read" && typeof input.file_path === "string" && input.file_path) {
    const abs = resolve(cwd, expandHome(input.file_path));
    if (isEnvFile(abs, cwd, env)) reads = [{ file: abs, scan: false }];
  } else if (tool === "Bash" && typeof input.command === "string") reads = envFilesRead(input.command, cwd, env);
  // One line per file; a file the command names is not also reported as found by a search.
  const files = [...new Set(reads.map((r) => r.file))].slice(0, 5);
  if (!files.length) return undefined;
  const line = (f: string) => `- it reads ${f}. ${SECRET}${reads.some((r) => r.file === f && !r.scan) ? "" : ` ${SCAN_HINT}`}`;
  return [`semantic-layer: refused ${tool === "Read" ? "Read" : "this shell command"}:`, ...files.map(line)].join("\n");
}

// --- What a Bash call is -----------------------------------------------------------------------

// The CLI entry this hook ships with.
const SL_ENTRY = join(import.meta.dir, "..", "sl.ts");
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SL_VARIABLE = /^(SL_[A-Z0-9_]+|SEMANTIC_ROOT)=/;
// Commands that write no file themselves, so sl or git may be joined or piped to them. tee writes
// the files it names: guard-edits.ts has checked those it can read, and one it cannot is not quiet.
const QUIET = new Set(["head", "tail", "grep", "wc", "cat", "jq", "cut", "tr", "echo", "printf", "ls", "pwd", "test", "[", "sleep", "true", "false", "exit", "tee"]);
// git subcommands that bring commits or committed files into the working tree, and those that never change it.
const GIT_MOVES = new Set(["pull", "merge", "rebase", "checkout", "switch", "restore", "reset", "revert", "cherry-pick", "stash"]);
const GIT_STAYS = new Set(["fetch", "status", "add", "commit", "log", "diff", "show", "branch", "push", "remote", "tag", "rev-parse"]);

// Whether a simple command runs this plugin's sl: `bun [run] <sl.ts> ...` with the path written out
// and naming the entry from every directory the shell may be in, or an `sl` on PATH that is the entry.
function isSl(first: Word, args: Word[], dirs: string[]): boolean {
  if (first.dynamic) return false;
  const entry = realPath(SL_ENTRY);
  if (first.word === "sl") {
    const found = Bun.which("sl");
    return found !== null && realPath(found) === entry;
  }
  if (first.word !== "bun" && !(isAbsolute(first.word) && realPath(first.word) === realPath(process.execPath))) return false;
  const path = args[args[0]?.word === "run" ? 1 : 0];
  if (!path || path.dynamic || path.pattern) return false;
  const p = expandHome(path.word);
  return (isAbsolute(p) ? [p] : dirs.map((d) => resolve(d, p))).every((x) => realPath(x) === entry);
}

// The subcommand of a git command, read past -C <dir>; undefined when another option comes first.
function gitSubcommand(args: Word[]): string | undefined {
  let i = 0;
  while (args[i]?.word === "-C" && args[i + 1] && !args[i + 1]!.dynamic) i += 2;
  const sub = args[i];
  return sub && !sub.dynamic && !sub.word.startsWith("-") ? sub.word : undefined;
}

interface Call {
  // "sl": every simple command is this plugin's sl, a git command, a cd or a command that writes no
  // file, with no $(...) or `...`, and at least one is sl. "git": the same with no sl and at least one
  // git command that moves commits. "other": anything else.
  kind: "sl" | "git" | "other";
  // It may leave a program running after the call returns.
  background: boolean;
  // The call's working directory and every directory a cd in it names.
  dirs: string[];
  // What it ran besides, for the report of a change that was undone.
  ran: Ran;
}

interface Ran {
  // The command text names sl: this plugin's, an alias, or sl.ts behind a variable.
  sl: boolean;
  // A git command in it moves commits.
  git: boolean;
}
const NAMES_SL = /(^|[\s;&|(`'"=\/])sl(\.ts)?(\s|["']|$)/;

function classify(command: string, cwd: string): Call {
  const { commands, subs, background } = parseShell(command);
  const dirs = [cwd];
  let trusted = subs.length === 0;
  let sl = false;
  let moves = false;
  let detached = background;
  for (const c of commands) {
    if (c.writes.some((w) => w.dynamic)) trusted = false;
    let k = 0;
    for (; k < c.words.length && ASSIGNMENT.test(c.words[k]!.word); k++) if (!SL_VARIABLE.test(c.words[k]!.word) || c.words[k]!.dynamic) trusted = false;
    const first = c.words[k];
    if (!first) continue;
    const args = c.words.slice(k + 1);
    if (!first.dynamic && first.word === "cd") {
      if (!follow(args, dirs)) trusted = false;
    } else if (isSl(first, args, dirs)) sl = true;
    else if (!first.dynamic && first.word === "git") {
      const sub = gitSubcommand(args);
      if (sub !== undefined && GIT_MOVES.has(sub)) moves = true;
      else if (sub === undefined || !GIT_STAYS.has(sub)) trusted = false;
      // --output sends what git prints to a file of any name, and a variable may hold that option.
      if (args.some((a) => a.dynamic || a.word.startsWith("--output"))) trusted = false;
    } else if (first.dynamic || !QUIET.has(first.word) || (first.word === "tee" && args.some((a) => a.dynamic))) {
      trusted = false;
      if (/^(nohup|setsid|disown)$/.test(basename(first.word))) detached = true;
    }
  }
  const ran = { sl: sl || NAMES_SL.test(command), git: moves };
  return { kind: trusted && sl ? "sl" : trusted && moves ? "git" : "other", background: detached, dirs, ran };
}

// --- Semantic roots ----------------------------------------------------------------------------

// The semantic roots a call may touch, nearest first: the root at or above the call's working
// directory, each directory a cd names and the project directory; SEMANTIC_ROOT; the root at or
// above every path the command text names; and the roots directly inside those directories.
function findRoots(cwd: string, dirs: string[], command: string, env: Env): string[] {
  const out = new Set<string>();
  const above = new Map<string, string | undefined>();
  const add = (p: string) => {
    const walked: string[] = [];
    let root: string | undefined;
    for (let dir = p; ; dir = dirname(dir)) {
      if (above.has(dir)) root = above.get(dir);
      else if (existsSync(join(dir, "semantic.yaml"))) root = dir;
      else if (dirname(dir) !== dir) {
        walked.push(dir);
        continue;
      }
      break;
    }
    for (const d of walked) above.set(d, root);
    if (root) out.add(realPath(root));
  };
  const from = [...new Set([...dirs, ...(env.CLAUDE_PROJECT_DIR ? [env.CLAUDE_PROJECT_DIR] : [])])];
  from.forEach(add);
  if (env.SEMANTIC_ROOT) add(resolve(cwd, env.SEMANTIC_ROOT));
  for (const m of [...new Set(command.match(/[A-Za-z0-9_.~@+\/-]+/g) ?? [])].slice(0, 64)) for (const d of dirs) add(resolve(d, expandHome(m)));
  for (const d of from) {
    add(join(d, "semantic"));
    try {
      for (const e of readdirSync(d, { withFileTypes: true }).slice(0, 500)) if (!e.isFile() && e.name !== "node_modules" && e.name !== ".git") add(join(d, e.name));
    } catch {
      continue;
    }
  }
  return [...out].slice(0, 16);
}

// --- State -------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;
// The longest a call is taken to be still running when its after-check has not come.
const IN_FLIGHT_MS = 10 * 60_000;
const STALE_MS = 60_000;

export interface Options {
  // The clock, in milliseconds (default Date.now()).
  now?: number;
  stateDir?: string;
  env?: Env;
}

export interface Outcome {
  // true: the hook exits 2, which shows the message to the agent (and, before a call, refuses it).
  block: boolean;
  message?: string;
}

// Where the hook keeps its copies: the plugin's data directory, or a directory of this user's in the temp directory.
export function stateDir(env: Env = process.env): string {
  if (env.CLAUDE_PLUGIN_DATA) return join(env.CLAUDE_PLUGIN_DATA, "ledger-guard");
  let who = "user";
  try {
    who = String(userInfo().uid);
  } catch {
    who = "user";
  }
  return join(tmpdir(), `semantic-layer-guard-${who}`);
}

// Creates the state directory, readable by this user only; throws when another user could write it.
function openState(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && (st.uid !== uid || (st.mode & 0o022) !== 0))) throw new Error(`${dir} is not a directory only this user can write`);
}

// One entry of the state directory, named by its file name alone:
//   <started>-<stream>-<key>.snap   a directory: the copies of one call, and meta.json
//   <started>-<stream>-<key>.sl     sl or git is running (a marker, empty)
//   <started>-<ended>-<key>.done    sl or git ran from started to ended
// `stream` names the agent that made the call: one agent's calls that write run one after another.
interface Entry {
  name: string;
  kind: "snap" | "sl" | "done";
  started: number;
  ended?: number;
  stream?: string;
  key: string;
}

function entries(dir: string, now: number): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    const live = /^(\d+)-([0-9a-f]{12})-([0-9a-f]{32})\.(snap|sl)$/.exec(name);
    const done = /^(\d+)-(\d+)-([0-9a-f]{32})\.done$/.exec(name);
    // A copy being made or settled by a hook call that died is removed.
    const part = /^\.(?:new|claim)-(\d+)-/.exec(name);
    if (live) out.push({ name, kind: live[4] as "snap" | "sl", started: Number(live[1]), stream: live[2]!, key: live[3]! });
    else if (done) out.push({ name, kind: "done", started: Number(done[1]), ended: Number(done[2]), key: done[3]! });
    else if (part && now - Number(part[1]) > STALE_MS) rmSync(join(dir, name), { recursive: true, force: true });
  }
  return out.sort((a, b) => a.started - b.started || (a.name < b.name ? -1 : 1));
}

const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);

// A call's key, the same before and after it: its tool_use_id, or its session, tool and input.
function keyOf(input: Obj): string {
  const id = typeof input.tool_use_id === "string" && input.tool_use_id ? `id\0${input.tool_use_id}` : `call\0${String(input.session_id ?? "")}\0${String(input.tool_name)}\0${JSON.stringify(input.tool_input)}`;
  return hash(id, 32);
}

const streamOf = (input: Obj) => hash(`${String(input.session_id ?? "")}\0${String(input.agent_id ?? "")}`, 12);

// --- Copy, compare, put back ---------------------------------------------------------------------

type Kind = "file" | "other" | "none";

interface RootCopy {
  root: string;
  ledger: Kind;
  // The files of .sl/pending/ (null: no such directory) and its entries that are not files.
  pending: string[] | null;
  other: string[];
}

interface Meta {
  // Compared once more at the next before-call, since the command may still be writing.
  keep: boolean;
  ran: Ran;
  roots: RootCopy[];
}

interface Diff {
  at: number;
  root: string;
  // .sl/ledger.jsonl or .sl/pending/<file>
  rel: string;
  // "linked": the same bytes under a second name (a hard link), through which a later command
  // could write the file without naming it.
  what: "changed" | "deleted" | "added" | "linked";
}

function kindOf(p: string): Kind {
  try {
    return lstatSync(p).isFile() ? "file" : "other";
  } catch {
    return "none";
  }
}

function pendingNames(root: string): string[] | null {
  try {
    return readdirSync(join(root, ".sl", "pending")).sort();
  } catch {
    return null;
  }
}

function copyRoot(root: string, into: string): RootCopy {
  mkdirSync(join(into, "pending"), { recursive: true });
  const ledger = kindOf(join(root, ".sl", "ledger.jsonl"));
  if (ledger === "file") copyFileSync(join(root, ".sl", "ledger.jsonl"), join(into, "ledger.jsonl"));
  const names = pendingNames(root);
  const pending: string[] = [];
  const other: string[] = [];
  for (const n of names ?? []) {
    if (kindOf(join(root, ".sl", "pending", n)) !== "file") other.push(n);
    else {
      copyFileSync(join(root, ".sl", "pending", n), join(into, "pending", n));
      pending.push(n);
    }
  }
  return { root, ledger, pending: names === null ? null : pending, other };
}

function sameBytes(a: string, b: string): boolean {
  return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
}

// What differs now from the copies in `from`.
function differences(meta: Meta, from: string): Diff[] {
  const out: Diff[] = [];
  meta.roots.forEach((r, at) => {
    const copy = join(from, String(at));
    const diff = (rel: string, was: Kind) => {
      const file = join(r.root, rel);
      const now = kindOf(file);
      const same = () => (sameBytes(file, join(copy, rel.slice(".sl/".length))) ? (statSync(file).nlink > 1 ? "linked" : undefined) : "changed");
      const what = was === "none" ? (now === "none" ? undefined : "added") : now === "none" ? "deleted" : now === "other" ? "changed" : same();
      if (what) out.push({ at, root: r.root, rel, what });
    };
    if (r.ledger !== "other") diff(".sl/ledger.jsonl", r.ledger);
    for (const n of r.pending ?? []) diff(`.sl/pending/${n}`, "file");
    for (const n of pendingNames(r.root) ?? []) if (!r.pending?.includes(n) && !r.other.includes(n)) diff(`.sl/pending/${n}`, "none");
  });
  return out;
}

// Puts one file back as it was copied, or removes one that was added. The file put back is a new
// one, so a second name the old one was given no longer leads to it. It writes only under the
// root's .sl directory, and not through a link that leads out of the root.
function putBack(d: Diff, from: string): void {
  const target = join(d.root, d.rel);
  const root = realPath(d.root);
  const parent = realPath(dirname(target));
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error(`${dirname(d.rel)} leads outside the semantic root`);
  if (d.what === "added") return rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.restore-${process.pid}`;
  copyFileSync(join(from, String(d.at), d.rel.slice(".sl/".length)), part);
  if (kindOf(target) === "other") rmSync(target, { recursive: true, force: true });
  renameSync(part, target);
}

const UNDONE = "semantic-layer: A command changed the answer ledger outside sl, and the change was undone. An owner's answer is recorded only with sl reply, after the owner answers.";
const LEFT =
  "semantic-layer: The answer ledger changed while sl or git ran at the same time as another command, so the change could not be attributed and was left as it is. " +
  "Run sl validate, and record an owner's answer only with sl reply, after the owner answers.";
const ON_ITS_OWN = "on its own, with its path written out (bun <skill dir>/scripts/sl.ts <command>) and joined to no other program";
// What follows the list of files, by what the call ran besides the program that may have forged the change.
const RAN_SL =
  "- This call also ran sl, whose writes cannot be told from the other program's: what sl wrote to the ledger was removed with the rest, and a layer file it edited was not put back. " +
  `Run the sl command again ${ON_ITS_OWN}, then sl validate. sl reply, sl question resolve and sl review apply record an owner's answer; ` +
  "if an open question was resolved, it is now gone from its file without its answer, so add it again first with sl question add.";
const RAN_GIT =
  "- This call also ran git. If its pull or merge brought ledger lines in, they were removed with the rest: get them back with git checkout -- <file> for each file listed above, " +
  "run in the semantic root on its own. Run it only after such a pull or merge, since it replaces the file with the committed one.";
const ALONE = `- sl reply, sl question resolve and sl review apply record an owner's answer. If one of them made that change (run through a script or a variable), run it again ${ON_ITS_OWN}.`;
const EARLIER = "This was found before the current call";

function listed(diffs: Diff[], word: (d: Diff) => string): string[] {
  const roots = [...new Set(diffs.map((d) => d.root))];
  return roots.map((root) => `- in ${root}: ${diffs.filter((d) => d.root === root).slice(0, 8).map((d) => `${d.rel} (${word(d)})`).join(", ")}`);
}

// Whether sl or git ran at any time since the call of `snap` started. A marker with no end from the
// same agent, started earlier, is a call that ended without its after-check; from another agent it
// may still be running.
function overlapped(all: Entry[], snap: Entry, now: number): boolean {
  return all.some((m) => (m.kind === "done" ? m.ended! > snap.started : m.kind === "sl" && (m.started >= snap.started || (m.stream !== snap.stream && now - m.started < IN_FLIGHT_MS))));
}

// Settles a copy that differs from the files: puts them back, or leaves them when sl or git ran
// meanwhile. Returns what to tell the agent, or undefined when another hook call took the copy.
function settle(dir: string, snap: Entry, diffs: Diff[], all: Entry[], now: number, ran: Ran | undefined): string | undefined {
  const claimed = join(dir, `.claim-${now}-${process.pid}-${snap.name}`);
  try {
    renameSync(join(dir, snap.name), claimed);
  } catch {
    return undefined;
  }
  try {
    if (overlapped(all, snap, now)) return [LEFT, ...listed(diffs, (d) => d.what)].join("\n");
    const failed: string[] = [];
    for (const d of diffs) {
      try {
        putBack(d, claimed);
      } catch (e) {
        failed.push(`- could not put back ${d.rel} in ${d.root} (${(e as Error).message}). Restore it from version control (git checkout -- ${d.rel}), then run sl validate.`);
      }
    }
    const done = (d: Diff) => (d.what === "added" ? "added, now removed" : d.what === "linked" ? "given a second name, now a file of its own again" : `${d.what}, now restored`);
    const advice = [...(ran?.sl ? [RAN_SL] : []), ...(ran?.git ? [RAN_GIT] : [])];
    return [UNDONE, ...listed(diffs, done), ...failed, ...(advice.length ? advice : [ALONE])].join("\n");
  } finally {
    rmSync(claimed, { recursive: true, force: true });
  }
}

function readMeta(dir: string, snap: Entry): Meta {
  return JSON.parse(readFileSync(join(dir, snap.name, "meta.json"), "utf8")) as Meta;
}

// Removes the markers no copy can still need, and the state directory once it is empty.
function tidy(dir: string, now: number): void {
  const all = entries(dir, now);
  const first = Math.min(...all.filter((e) => e.kind === "snap").map((e) => e.started));
  for (const e of all) if (e.kind === "done" && e.ended! <= first) rmSync(join(dir, e.name), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    return;
  }
}

// Compares every earlier copy with the files, at the start of a before-call from the agent `stream`.
// A copy that differs is settled. One that does not is dropped when its call is over: it came from
// the same agent, or it is older than a call runs. Returns what to tell the agent.
function sweep(dir: string, now: number, stream: string): string[] {
  const all = entries(dir, now);
  const reports: string[] = [];
  for (const e of all) {
    const path = join(dir, e.name);
    try {
      if (now - e.started > DAY_MS) rmSync(path, { recursive: true, force: true });
      else if (e.kind === "snap") {
        const meta = readMeta(dir, e);
        const diffs = differences(meta, path);
        if (diffs.length) {
          const report = settle(dir, e, diffs, all, now, meta.ran);
          if (report) reports.push(report);
        } else if (e.stream === stream || now - e.started > IN_FLIGHT_MS) rmSync(path, { recursive: true, force: true });
      } else if (e.kind === "sl") {
        // The same agent's earlier sl call is over; when it ended is not known, so it counts up to now.
        if (e.stream === stream) renameSync(path, join(dir, `${e.started}-${now}-${e.key}.done`));
        else if (now - e.started > IN_FLIGHT_MS) rmSync(path, { force: true });
      }
    } catch {
      // A copy that cannot be read or compared is dropped, so it does not fail every later call.
      rmSync(path, { recursive: true, force: true });
    }
  }
  return reports;
}

// Records the call that is about to run: a marker for sl and git, copies for any other Bash call.
function record(input: Obj, dir: string, now: number, stream: string, env: Env): void {
  const tool = String(input.tool_name);
  const args = input.tool_input;
  const key = keyOf(input);
  const mark = () => {
    openState(dir);
    writeFileSync(join(dir, `${now}-${stream}-${key}.sl`), "");
  };
  // One of the MCP server's tools runs sl.
  if (/^mcp__.*__sl_[a-z0-9_]+$/.test(tool)) return mark();
  if (tool !== "Bash" || !isObject(args) || typeof args.command !== "string") return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const call = classify(args.command, cwd);
  if (call.kind !== "other") return mark();
  const roots = findRoots(cwd, call.dirs, args.command, env);
  if (!roots.length) return;
  openState(dir);
  const part = join(dir, `.new-${now}-${process.pid}-${key}`);
  mkdirSync(part);
  const meta: Meta = { keep: call.background || args.run_in_background === true, ran: call.ran, roots: roots.map((root, at) => copyRoot(root, join(part, String(at)))) };
  writeFileSync(join(part, "meta.json"), JSON.stringify(meta));
  renameSync(part, join(dir, `${now}-${stream}-${key}.snap`));
}

function parseInput(stdin: string): Obj | undefined {
  try {
    const input: unknown = JSON.parse(stdin);
    return isObject(input) && typeof input.tool_name === "string" ? input : undefined;
  } catch {
    return undefined;
  }
}

const warning = (e: unknown): Outcome => ({ block: false, message: `semantic-layer hook: could not compare the answer ledger (${(e as Error).message}); not checked.` });

// The before half, for a PreToolUse call given as the hook's stdin: earlier copies are compared
// first, and a difference found there stops this call with the report. With `note`, the call is then
// recorded; guard-edits.ts passes false for a call it refuses.
export function runBefore(stdin: string, note = true, opts: Options = {}): Outcome {
  try {
    const input = parseInput(stdin);
    if (!input) return { block: false };
    const now = opts.now ?? Date.now();
    const env = opts.env ?? process.env;
    const dir = opts.stateDir ?? stateDir(env);
    const stream = streamOf(input);
    const reports = sweep(dir, now, stream);
    if (!reports.length && note) record(input, dir, now, stream, env);
    tidy(dir, now);
    // A call guard-edits.ts refuses carries its own reason and is not to be run again as it is.
    return reports.length ? { block: true, message: [...reports, note ? `${EARLIER}, which was not run. Run it again.` : `${EARLIER}.`].join("\n") } : { block: false };
  } catch (e) {
    return warning(e);
  }
}

// The after half, for a PostToolUse or PostToolUseFailure call: an sl or git marker gets its end,
// and a copy is compared with the files.
export function runAfter(stdin: string, opts: Options = {}): Outcome {
  try {
    const input = parseInput(stdin);
    if (!input) return { block: false };
    const now = opts.now ?? Date.now();
    const dir = opts.stateDir ?? stateDir(opts.env ?? process.env);
    const key = keyOf(input);
    const all = entries(dir, now);
    const mine = all.find((e) => e.key === key && e.kind !== "done");
    let message: string | undefined;
    if (mine?.kind === "sl") renameSync(join(dir, mine.name), join(dir, `${mine.started}-${now}-${key}.done`));
    else if (mine) {
      const meta = readMeta(dir, mine);
      const diffs = differences(meta, join(dir, mine.name));
      if (diffs.length) message = settle(dir, mine, diffs, all, now, meta.ran);
      else if (!meta.keep) rmSync(join(dir, mine.name), { recursive: true, force: true });
    }
    tidy(dir, now);
    return message ? { block: true, message } : { block: false };
  } catch (e) {
    return warning(e);
  }
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const event = parseInput(stdin)?.hook_event_name;
  const outcome =
    event === "PreToolUse"
      ? runBefore(stdin)
      : event === "PostToolUse" || event === "PostToolUseFailure"
        ? runAfter(stdin)
        : { block: false, message: "semantic-layer hook: the hook input names no tool call before or after which to compare the answer ledger; not checked." };
  if (outcome.message) process.stderr.write(`${outcome.message}\n`);
  process.exit(outcome.block ? 2 : 0);
}

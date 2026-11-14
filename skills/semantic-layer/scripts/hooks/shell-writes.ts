// The files a shell command plainly writes, for the hand-edit hook (spec: Hand edits). It reads the
// command the way a shell splits it (quotes, escapes, operators, redirections, heredocs, braces, `cd`)
// and reports the targets of redirections, tee, in-place sed, perl, yq and awk, cp, mv, install, ln,
// rsync, patch, rm, unlink, shred, truncate and dd of=, also after a shell keyword (`then`, `do`, `{`,
// `!`), in a function body and inside $(...), `...`, `sh -c` strings, heredocs given to a shell and
// `eval`. It is
// a first check, not a sandbox: a program that writes files itself (a script, python -c, git) is not
// seen, and the CLI's own checks remain the guarantee.
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export interface ShellWrite {
  // The path as written, resolved against the working directory when it holds no variable.
  path: string;
  // Whether the path holds a variable or a command substitution, so it could not be resolved.
  dynamic: boolean;
  // The command or operator that writes it, for the refusal message.
  how: string;
}

// A `<<` or `<<-` operator carries its heredoc's body once the tokenizer has read it, and whether
// its delimiter was quoted (<<'EOF'), so the shell expands nothing in the body.
// A word is `pattern` when it holds an unquoted *, ?, [ or {, which the shell may expand into other words.
type Tok = { op: string; body?: string; quoted?: boolean } | { word: string; dynamic: boolean; pattern?: boolean };

const OPS = ["&>>", "<<<", "<<-", ";;", "&&", "||", "|&", ">>", ">|", "&>", ">&", "<&", "<>", "<<", ";", "&", "|", "(", ")", ">", "<"];

// Where a `...` or a $(...) whose ` or ( is at s[i] ends, just past its closing character.
function substitution(s: string, i: number): number {
  const close = s[i] === "`" ? "`" : ")";
  let depth = 1;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'" && close === ")") {
      const q = s.indexOf("'", j + 1);
      if (q < 0) return s.length;
      j = q;
    } else if (c === "(" && close === ")") depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return s.length;
}

// A $'...' string whose $ is at s[i]: its text with the escapes bash decodes, where it ends, and
// whether it held an escape this reader does not decode (so the word cannot be read).
function ansiC(s: string, i: number): { text: string; end: number; unread: boolean } {
  const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  let text = "";
  let unread = false;
  let j = i + 2;
  for (; j < s.length && s[j] !== "'"; j++) {
    if (s[j] !== "\\") {
      text += s[j];
      continue;
    }
    const e = s[++j] ?? "";
    const hex = /^x([0-9A-Fa-f]{1,2})/.exec(s.slice(j));
    const oct = /^[0-7]{1,3}/.exec(s.slice(j));
    if (e in simple) text += simple[e];
    else if (hex) {
      text += String.fromCharCode(parseInt(hex[1]!, 16));
      j += hex[0].length - 1;
    } else if (oct) {
      text += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
      j += oct[0].length - 1;
    } else unread = true;
  }
  return { text, end: Math.min(j + 1, s.length), unread };
}

// A heredoc's delimiter word starting at s[i], read the way bash reads it: quotes and backslashes are
// removed and make it quoted (<<\EOF, <<E"O"F and <<'EOF' all end at a line EOF, and expand nothing).
// Undefined when the word holds what this reader does not follow ($'...', $"...", $(...), `...`).
function heredocWord(s: string, i: number): { delim: string; quoted: boolean; end: number } | undefined {
  let delim = "";
  let quoted = false;
  let j = i;
  while (j < s.length && !/[\s;&|<>()]/.test(s[j]!)) {
    const c = s[j]!;
    if (c === "`" || (c === "$" && /['"(]/.test(s[j + 1] ?? ""))) return undefined;
    if (c === "\\") {
      if (s[j + 1] !== "\n") {
        quoted = true;
        delim += s[j + 1] ?? "";
      }
      j += 2;
    } else if (c === "'" || c === '"') {
      const close = s.indexOf(c, j + 1);
      if (close < 0) return undefined;
      const text = s.slice(j + 1, close);
      if (c === '"' && /[\\`]|\$\(/.test(text)) return undefined;
      quoted = true;
      delim += text;
      j = close + 1;
    } else {
      delim += c;
      j++;
    }
  }
  return delim ? { delim, quoted, end: j } : undefined;
}

// The command's tokens; the text inside each $(...) and `...` it holds is added to `subs`.
export function tokenize(s: string, subs: string[] = []): Tok[] {
  const out: Tok[] = [];
  let word = "";
  let inWord = false;
  let dynamic = false;
  let pattern = false;
  const heredocs: { delim: string; strip: boolean; quoted: boolean; tok: { op: string; body?: string; quoted?: boolean } }[] = [];
  const sub = (at: number, j: number) => subs.push(s.slice(at + (s[at] === "`" ? 1 : 2), s[j - 1] === (s[at] === "`" ? "`" : ")") ? j - 1 : j));
  const end = () => {
    if (inWord) out.push(pattern ? { word, dynamic, pattern } : { word, dynamic });
    word = "";
    inWord = false;
    dynamic = false;
    pattern = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\n") {
      end();
      out.push({ op: ";" });
      i++;
      // Skip the bodies of heredocs opened on the line just ended.
      for (const h of heredocs.splice(0)) {
        const body: string[] = [];
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          let line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length : nl + 1;
          // Under an unquoted delimiter bash joins a line ending in \ to the next before it compares.
          while (!h.quoted && /(^|[^\\])(\\\\)*\\$/.test(line) && i < s.length) {
            const next = s.indexOf("\n", i);
            line = line.slice(0, -1) + s.slice(i, next < 0 ? s.length : next);
            i = next < 0 ? s.length : next + 1;
          }
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          body.push(line);
        }
        h.tok.body = body.join("\n");
      }
      continue;
    }
    if (c === " " || c === "\t") {
      end();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] !== "\n") word += s[i + 1] ?? "";
      inWord = inWord || s[i + 1] !== "\n";
      i += 2;
      continue;
    }
    if (c === "$" && s[i + 1] === "'") {
      const a = ansiC(s, i);
      word += a.text;
      inWord = true;
      dynamic = dynamic || a.unread;
      i = a.end;
      continue;
    }
    // $"..." is translated by the locale, so its text is not certain: read it as a "..." that is dynamic.
    if (c === "$" && s[i + 1] === '"') {
      dynamic = true;
      i++;
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      word += s.slice(i + 1, close < 0 ? s.length : close);
      inWord = true;
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`\n'.includes(s[i + 1] ?? "")) {
          word += s[i + 1] === "\n" ? "" : s[i + 1];
          i += 2;
        } else if (s[i] === "`" || (s[i] === "$" && s[i + 1] === "(")) {
          const j = substitution(s, s[i] === "`" ? i : i + 1);
          sub(i, j);
          word += s.slice(i, j);
          dynamic = true;
          i = j;
        } else {
          if (s[i] === "$" && /[A-Za-z_{0-9@*#?!$-]/.test(s[i + 1] ?? "")) dynamic = true;
          word += s[i++];
        }
      }
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      const j = substitution(s, c === "`" ? i : i + 1);
      sub(i, j);
      word += s.slice(i, j);
      inWord = true;
      dynamic = true;
      i = j;
      continue;
    }
    if (c === "$" && /[A-Za-z_{0-9@*#?!$-]/.test(s[i + 1] ?? "")) dynamic = true;
    const op = OPS.find((o) => s.startsWith(o, i));
    // A file descriptor number written just before a redirection belongs to it (2>file).
    if (op && /^[<>&]/.test(op) && inWord && /^\d+$/.test(word) && !dynamic) {
      word = "";
      inWord = false;
    }
    if (op) {
      end();
      const tok: { op: string; body?: string; quoted?: boolean } = { op };
      out.push(tok);
      i += op.length;
      if (op === "<<" || op === "<<-") {
        while (s[i] === " " || s[i] === "\t") i++;
        const d = heredocWord(s, i);
        if (d) {
          heredocs.push({ delim: d.delim, strip: op === "<<-", quoted: d.quoted, tok });
          tok.quoted = d.quoted;
          i = d.end;
        }
      }
      continue;
    }
    if (/[*?[{]/.test(c)) pattern = true;
    word += c;
    inWord = true;
    i++;
  }
  end();
  return out;
}

const SEPARATORS = new Set([";", ";;", "&&", "||", "|", "|&", "&", "(", ")"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const PREFIXES = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "xargs", "stdbuf", "timeout"]);

function isWord(t: Tok | undefined): t is { word: string; dynamic: boolean } {
  return t !== undefined && "word" in t;
}

type Word = { word: string; dynamic: boolean };

// The arguments a simple command writes to, and how to name the command in a refusal.
function argTargets(name: string, args: Word[]): { targets: Word[]; how: string } {
  const plain = args.filter((a) => !a.word.startsWith("-") || a.word === "-");
  const opts = args.filter((a) => a.word.startsWith("-")).map((a) => a.word);
  const after = (flag: string) => {
    const i = args.findIndex((a) => a.word === flag);
    return i >= 0 && args[i + 1] ? [args[i + 1]!] : [];
  };
  const longValue = (flag: string) =>
    args.filter((a) => a.word.startsWith(`${flag}=`)).map((a) => ({ word: a.word.slice(flag.length + 1), dynamic: a.dynamic }));
  switch (name) {
    case "tee":
    case "rm":
    case "unlink":
    case "shred":
      return { targets: plain, how: name };
    case "truncate":
      return { targets: plain.filter((a) => !after("-s").includes(a) && !after("-r").includes(a)), how: name };
    case "sed":
      // The script and every file count: a script read as a path never names a layer file.
      return opts.some((o) => /^-[A-Za-z]*i/.test(o) || o.startsWith("--in-place")) ? { targets: plain, how: "sed -i" } : { targets: [], how: name };
    case "perl":
      // -i among bundled switches, not inside the value of -M, -m or -I (-Mstrict is a read).
      return opts.some((o) => /^-[A-HJ-LN-Za-hj-ln-z0-9]*i/.test(o)) ? { targets: plain, how: "perl -i" } : { targets: [], how: name };
    case "patch":
      return { targets: [...plain, ...after("-o")], how: "patch" };
    case "yq":
      return opts.some((o) => o === "-i" || o === "--inplace" || /^-[A-Za-z]*i$/.test(o)) ? { targets: plain, how: "yq -i" } : { targets: [], how: name };
    case "awk":
    case "gawk":
      return after("-i").some((a) => a.word === "inplace") ? { targets: plain, how: `${name} -i inplace` } : { targets: [], how: name };
    case "mv":
      return { targets: [...plain, ...after("-t"), ...longValue("--target-directory")], how: "mv" };
    case "cp":
    case "install":
    case "ln":
    case "rsync": {
      const dir = [...after("-t"), ...longValue("--target-directory")];
      return { targets: dir.length ? dir : plain.length >= 2 ? [plain[plain.length - 1]!] : [], how: name };
    }
    case "dd":
      return { targets: longValue("of"), how: "dd of=" };
    default:
      return { targets: [], how: name };
  }
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
}

// The words a brace expansion makes of `w` ({a,b}/x is a/x and b/x), nested groups included.
function braces(w: string, n = 0): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
  if (!m || n > 4) return [w];
  return m[1]!.split(",").flatMap((alt) => braces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), n + 1));
}

// Options of a command prefix that take the next word as their value (sudo -u <user>).
const PREFIX_VALUES: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S"],
  xargs: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"],
  timeout: ["-s", "-k"],
  nice: ["-n"],
  time: ["-f", "-o"],
};
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// Where a simple command's own name sits among its words: after its variable assignments and after
// command prefixes (sudo -u x, env A=b, timeout 5) with their options.
function commandStart(words: { word: string }[]): number {
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.word)) k++;
  while (k < words.length && PREFIXES.has(basename(words[k]!.word))) {
    const values = PREFIX_VALUES[basename(words[k]!.word)] ?? [];
    k++;
    while (k < words.length && (words[k]!.word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.word) || /^\d+[smhd]?$/.test(words[k]!.word)))
      k += values.includes(words[k]!.word) ? 2 : 1;
  }
  return k;
}

// Shell words that stand before a command's name: `if [ -f x ]; then rm x; fi`, `{ rm x; }`.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc"]);

// Where a simple command's name sits: past its assignments and prefixes (commandStart) and past the
// shell keywords before it (`then`, `do`, `{`, `!`, `function <name>`).
export function nameAt(words: { word: string; dynamic: boolean }[]): number {
  for (let k = 0; ; k++) {
    k += commandStart(words.slice(k));
    const w = words[k];
    if (!w || w.dynamic) return k;
    if (w.word === "function") k++;
    else if (!KEYWORDS.has(w.word)) return k;
  }
}

// Every file the command plainly writes. A relative path is resolved against `cwd` and against every
// directory a `cd` or `pushd` earlier in the command names, since a subshell, `cd -` or `popd` may
// have left the shell in any of them. `depth` bounds nested shell strings.
export function shellWrites(command: string, cwd: string, depth = 0, bases: string[] = [cwd]): ShellWrite[] {
  const subs: string[] = [];
  const toks = tokenize(command, subs);
  const out: ShellWrite[] = [];
  const dirs = [...bases];
  const push = (w: Word, how: string) => {
    for (const each of w.dynamic ? [w.word] : braces(w.word)) {
      const p = expandHome(each);
      if (w.dynamic || isAbsolute(p)) out.push({ path: p, dynamic: w.dynamic, how });
      else for (const d of dirs) out.push({ path: resolve(d, p), dynamic: false, how });
    }
  };
  const nested = (text: string) => depth < 3 && out.push(...shellWrites(text, dirs[0]!, depth + 1, dirs));
  let i = 0;
  while (i < toks.length) {
    const words: Word[] = [];
    const stdin: string[] = [];
    for (; i < toks.length; i++) {
      const t = toks[i]!;
      if (!isWord(t)) {
        if (SEPARATORS.has(t.op)) break;
        if (t.body !== undefined) stdin.push(t.body);
        const target = toks[i + 1];
        if (isWord(target)) {
          i++;
          if (t.op === "<<<") stdin.push(target.word);
          const dup = t.op === ">&" && (/^\d+-?$/.test(target.word) || target.word === "-");
          if ((WRITE_REDIRECTS.has(t.op) || t.op === ">&") && !dup) push(target, `the redirection ${t.op}`);
        }
        continue;
      }
      words.push(t);
    }
    i++;
    const k = nameAt(words);
    const cmd = words[k];
    if (!cmd) continue;
    const name = basename(cmd.word);
    const args = words.slice(k + 1);
    if (name === "cd" || name === "pushd") {
      const to = args.find((a) => !a.word.startsWith("-"))?.word ?? (args.some((a) => a.word === "-") ? undefined : "~");
      if (to !== undefined && !args.some((a) => a.dynamic))
        for (const d of [...dirs]) {
          const next = resolve(d, expandHome(to));
          if (dirs.length < 8 && !dirs.includes(next)) dirs.push(next);
        }
      continue;
    }
    if (SHELLS.has(name)) {
      // sh -c '<command>' (also -ec, -e -c), or a shell reading its commands from a heredoc.
      let j = 0;
      let c = false;
      for (; j < args.length && /^[-+]/.test(args[j]!.word); j++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[j]!.word)) c = true;
        if (args[j]!.word === "-o" || args[j]!.word === "+o") j++;
      }
      if (c && args[j]) nested(args[j]!.word);
      else if (!args[j]) stdin.forEach(nested);
      continue;
    }
    if (name === "eval") {
      nested(args.map((a) => a.word).join(" "));
      continue;
    }
    const { targets, how } = argTargets(name, args);
    for (const t of targets) push(t, how);
  }
  // The commands inside $(...) and `...` run in the same shell's directory.
  subs.forEach(nested);
  return out;
}

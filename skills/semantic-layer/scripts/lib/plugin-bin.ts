// The plugin's bin/semlayer, and whether a bare `semlayer` on a PATH is that file (spec: Hand edits,
// Which command is semlayer). semlayer doctor reports it, and the hooks count a bare `semlayer` in a
// shell command as this plugin's CLI only when it is.
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

// The plugin root this file ships in, its bin/ directory and its bin/semlayer.
export const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
export const PLUGIN_BIN_DIR = join(PLUGIN_ROOT, "bin");
export const PLUGIN_BIN = join(PLUGIN_BIN_DIR, "semlayer");
// The SHA-256 of the bin/semlayer this plugin version ships; tests/bare-semlayer.test.ts keeps it current.
export const PLUGIN_BIN_SHA256 = "b9df39889e7cd440268bbe32d3ad2d9b5a8a8f4164261866ae04f5a92616812b";

const real = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Why the plugin's own bin/semlayer cannot be trusted as shipped, or undefined when it can: it is a
// file of its own (not a link) inside the plugin root CLAUDE_PLUGIN_ROOT names, executable, with the
// bytes this plugin version ships.
export function pluginBinProblem(env: Env = process.env): string | undefined {
  const root = real(PLUGIN_ROOT);
  if (env.CLAUDE_PLUGIN_ROOT && real(resolve(env.CLAUDE_PLUGIN_ROOT)) !== root) return `CLAUDE_PLUGIN_ROOT names ${env.CLAUDE_PLUGIN_ROOT}, not the plugin these hooks ship in (${PLUGIN_ROOT})`;
  try {
    if (!lstatSync(PLUGIN_BIN).isFile()) return `${PLUGIN_BIN} is not a plain file`;
  } catch {
    return `${PLUGIN_BIN} does not exist`;
  }
  if (!executable(PLUGIN_BIN)) return `${PLUGIN_BIN} is not executable (chmod +x it)`;
  const sha = createHash("sha256").update(readFileSync(PLUGIN_BIN)).digest("hex");
  if (sha !== PLUGIN_BIN_SHA256) return `${PLUGIN_BIN} is not the file this plugin version ships`;
  return undefined;
}

export interface BareSemlayer {
  // True when the first semlayer along the PATH, with the plugin's bin/ last as Claude Code adds it,
  // is the plugin's own bin/semlayer as shipped.
  ok: boolean;
  // The semlayer the shell would run, or null when none is found.
  found: string | null;
  // Why it is not the plugin's, in plain words, when ok is false.
  reason?: string;
}

// Which `semlayer` a shell with this PATH runs. Claude Code places the plugin's bin/ after the
// user's own PATH entries, so it is looked in last. A relative or empty PATH entry depends on the
// directory the shell is in, so none may come before the file found. With `pluginBinLast` false the
// PATH is read as it is (semlayer doctor, for a person's own shell).
export function bareSemlayer(env: Env = process.env, pluginBinLast = true): BareSemlayer {
  const dirs = [...(env.PATH ? env.PATH.split(delimiter) : []), ...(pluginBinLast ? [PLUGIN_BIN_DIR] : [])];
  let found: string | null = null;
  for (const d of dirs) {
    if (!d || !isAbsolute(d)) return { ok: false, found: null, reason: `PATH holds the directory "${d}", which depends on where the shell is` };
    if (executable(join(d, "semlayer"))) {
      found = join(d, "semlayer");
      break;
    }
  }
  if (!found) return { ok: false, found: null, reason: "no semlayer is on PATH" };
  if (real(found) !== real(PLUGIN_BIN)) return { ok: false, found, reason: `the first semlayer on PATH is ${found}, not the plugin's ${PLUGIN_BIN}` };
  const problem = pluginBinProblem(env);
  return problem ? { ok: false, found, reason: problem } : { ok: true, found };
}

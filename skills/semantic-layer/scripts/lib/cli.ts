import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMMANDS } from "../commands/index.ts";
import type { CommandContext } from "./command.ts";
import { checkEnvFileFlag, commandEnv, type ConnectionUse } from "./env-file.ts";
import { UserError } from "./errors.ts";
import { resetEditWarnings, withEditWarnings } from "./edit.ts";
import { acquireLock, lockWaitMs } from "./lock.ts";
import { paths, resolveRoot } from "./project.ts";

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  // Standard input, for a command that reads it (semlayer apply --file -).
  stdin?: () => Promise<string>;
}

export const GLOBAL_OPTIONS = {
  root: { type: "string" },
  "env-file": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

// The line every command's --help ends with.
export const GLOBAL_HELP = "Every command also takes --root <dir> (or SEMANTIC_ROOT), --env-file <path> (or SEMLAYER_ENV_FILE) and --json.";

// A command's --json object with connection_from added: where the first connection it opened came from.
function withConnectionFrom(text: string, uses: ConnectionUse[]): string {
  if (!uses.length) return text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || "connection_from" in value) return text;
  return JSON.stringify({ ...value, connection_from: uses[0]!.from }, null, text.includes("\n") ? 2 : undefined);
}

function clock(env: Record<string, string | undefined>): () => Date {
  const fixed = env.SEMLAYER_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (Number.isNaN(d.getTime())) throw new UserError(`SEMLAYER_NOW is not a valid date: ${fixed}`);
    return () => new Date(d.getTime());
  }
  return () => new Date();
}

async function usage(io: CliIO): Promise<void> {
  const lines = ["Usage: semlayer <command> [flags]", GLOBAL_HELP, ""];
  // The summaries start in one column, past the longest command name.
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  for (const [name, load] of Object.entries(COMMANDS)) {
    try {
      lines.push(`  ${name.padEnd(width)} ${(await load()).default.summary}`);
    } catch {
      lines.push(`  ${name.padEnd(width)} (unavailable)`);
    }
  }
  io.out(lines.join("\n"));
}

// A failed command's --json object on stdout: the message, a stable code and, where there is one, the
// command that fixes it (schemas/cli-error.schema.json).
export interface CliError {
  error: string;
  code: string;
  next?: string;
}

function envelope(error: string, code: string, next?: string): string {
  const body: CliError = { error, code, ...(next !== undefined ? { next } : {}) };
  return JSON.stringify(body, null, 2);
}

// Runs one CLI invocation and returns its exit code. Tests call this directly.
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  // Read before the flags are parsed, so a usage error and an unknown command answer in JSON too.
  const end = argv.indexOf("--");
  const json = (end === -1 ? argv : argv.slice(0, end)).includes("--json");
  if (!name || name === "help" || name === "--help" || name === "-h") {
    await usage(io);
    return name ? 0 : 1;
  }
  const load = COMMANDS[name];
  if (!load) {
    const message = `Unknown command "${name}". Run \`semlayer help\` for the list.`;
    if (json) io.out(envelope(message, "usage", "semlayer help"));
    io.err(message);
    return 1;
  }
  // Whether the command printed to stdout: a failure after its own output adds no second object.
  let printed = false;
  const out = (text: string) => {
    printed = true;
    io.out(text);
  };
  resetEditWarnings();
  const releases: (() => void)[] = [];
  try {
    const spec = (await load()).default;
    const parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...spec.options },
      allowPositionals: spec.positionals ?? false,
      strict: true,
    });
    const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
    if (values.help) {
      out(`${spec.summary}\n\nUsage: semlayer ${spec.usage}\n\n${GLOBAL_HELP}`);
      return 0;
    }
    // Each connection a command opens is said once on stderr; with --json the output carries the first as connection_from instead.
    const uses: ConnectionUse[] = [];
    const lookup = {
      cwd: io.cwd,
      envFile: values["env-file"] as string | undefined,
      onConnection: (use: ConnectionUse) => {
        if (uses.some((u) => u.source === use.source)) return;
        uses.push(use);
        if (!json) io.err(use.line);
      },
    };
    checkEnvFileFlag(io.env, lookup);
    const root = resolveRoot(values.root as string | undefined, io.env, io.cwd);
    const now = clock(io.env);
    const lock = async () => {
      const release = await acquireLock(root, { command: name, started: now().toISOString() }, lockWaitMs(io.env));
      releases.push(release);
      return release;
    };
    const ctx: CommandContext = {
      root,
      cwd: io.cwd,
      env: commandEnv(io.env, lookup),
      json,
      now,
      // A typed edit's output carries the warnings it added (lib/edit.ts withEditWarnings).
      out: json ? (text) => out(withConnectionFrom(withEditWarnings(text, true), uses)) : (text) => out(withEditWarnings(text, false)),
      err: io.err,
      lock,
      stdin: io.stdin,
    };
    const input = { values, positionals: parsed.positionals };
    // A command that reads, changes and writes holds the root's lock from before its first read.
    // Outside a semantic root there is nothing to guard, and no .semlayer directory is made for a lock.
    const writes = typeof spec.writes === "function" ? spec.writes(input) : spec.writes;
    if (writes === "whole" && existsSync(paths(root).project)) await lock();
    return await spec.run(input, ctx);
  } catch (e) {
    // A refusal is one plain line on stderr; with --json it is also one {error, code, next?} object
    // on stdout, unless the command already printed its own.
    const report = json && !printed;
    if (e instanceof UserError) {
      if (report) out(envelope(e.message, e.code, e.next));
      io.err(`semlayer ${name}: ${e.message}`);
      return 1;
    }
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      if (report) out(envelope((e as Error).message, "usage", `semlayer ${name} --help`));
      io.err(`semlayer ${name}: ${(e as Error).message}`);
      return 1;
    }
    if (report) out(envelope(e instanceof Error ? e.message : String(e), "internal"));
    io.err(`semlayer ${name}: unexpected error: ${(e as Error).stack ?? e}`);
    return 2;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMMANDS } from "../commands/index.ts";
import type { CommandContext } from "./command.ts";
import { checkEnvFileFlag, commandEnv, type ConnectionUse } from "./env-file.ts";
import { UserError } from "./errors.ts";
import { acquireLock, lockWaitMs } from "./lock.ts";
import { paths, resolveRoot } from "./project.ts";

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const GLOBAL_OPTIONS = {
  root: { type: "string" },
  "env-file": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

// The line every command's --help ends with.
export const GLOBAL_HELP = "Every command also takes --root <dir> (or SEMANTIC_ROOT), --env-file <path> (or SL_ENV_FILE) and --json.";

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
  const fixed = env.SL_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (Number.isNaN(d.getTime())) throw new UserError(`SL_NOW is not a valid date: ${fixed}`);
    return () => new Date(d.getTime());
  }
  return () => new Date();
}

async function usage(io: CliIO): Promise<void> {
  const lines = ["Usage: sl <command> [flags]", GLOBAL_HELP, ""];
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

// Runs one CLI invocation and returns its exit code. Tests call this directly.
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    await usage(io);
    return name ? 0 : 1;
  }
  const load = COMMANDS[name];
  if (!load) {
    io.err(`Unknown command "${name}". Run \`sl help\` for the list.`);
    return 1;
  }
  let json = false;
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
    json = values.json === true;
    if (values.help) {
      io.out(`${spec.summary}\n\nUsage: sl ${spec.usage}\n\n${GLOBAL_HELP}`);
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
      out: json ? (text) => io.out(withConnectionFrom(text, uses)) : io.out,
      err: io.err,
      lock,
    };
    const input = { values, positionals: parsed.positionals };
    // A command that reads, changes and writes holds the root's lock from before its first read.
    // Outside a semantic root there is nothing to guard, and no .sl directory is made for a lock.
    const writes = typeof spec.writes === "function" ? spec.writes(input) : spec.writes;
    if (writes === "whole" && existsSync(paths(root).project)) await lock();
    return await spec.run(input, ctx);
  } catch (e) {
    if (e instanceof UserError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      // A refusal is one plain line on stderr. One that carries the command that fixes it (a
      // malformed file, a directory with no layer) is also, with --json, one JSON object on stdout.
      const next = e instanceof UserError ? e.next : undefined;
      if (json && next) io.out(JSON.stringify({ error: (e as Error).message, next }, null, 2));
      io.err(`sl ${name}: ${(e as Error).message}`);
      return 1;
    }
    io.err(`sl ${name}: unexpected error: ${(e as Error).stack ?? e}`);
    return 2;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

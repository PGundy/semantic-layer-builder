import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { COMMANDS } from "../commands/index.ts";
import type { CommandContext } from "./command.ts";
import { UserError } from "./errors.ts";
import { acquireLock, lockWaitMs } from "./lock.ts";
import { paths, resolveRoot } from "./project.ts";

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

const GLOBAL_OPTIONS = {
  root: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

// The line every command's --help ends with.
export const GLOBAL_HELP = "Every command also takes --root <dir> (or SEMANTIC_ROOT) and --json.";

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
      io.out(`${spec.summary}\n\nUsage: sl ${spec.usage}\n\n${GLOBAL_HELP}`);
      return 0;
    }
    const root = resolveRoot(values.root as string | undefined, io.env, io.cwd);
    const now = clock(io.env);
    const lock = async () => {
      const release = await acquireLock(root, { command: name, started: now().toISOString() }, lockWaitMs(io.env));
      releases.push(release);
      return release;
    };
    const ctx: CommandContext = { root, cwd: io.cwd, env: io.env, json: values.json === true, now, out: io.out, err: io.err, lock };
    const input = { values, positionals: parsed.positionals };
    // A command that reads, changes and writes holds the root's lock from before its first read.
    // Outside a semantic root there is nothing to guard, and no .sl directory is made for a lock.
    const writes = typeof spec.writes === "function" ? spec.writes(input) : spec.writes;
    if (writes === "whole" && existsSync(paths(root).project)) await lock();
    return await spec.run(input, ctx);
  } catch (e) {
    if (e instanceof UserError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`sl ${name}: ${(e as Error).message}`);
      return 1;
    }
    io.err(`sl ${name}: unexpected error: ${(e as Error).stack ?? e}`);
    return 2;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

import { parseArgs } from "node:util";
import { COMMANDS } from "../commands/index.ts";
import type { CommandContext } from "./command.ts";
import { UserError } from "./errors.ts";
import { resolveRoot } from "./project.ts";

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
    const ctx: CommandContext = {
      root: resolveRoot(values.root as string | undefined, io.env, io.cwd),
      cwd: io.cwd,
      env: io.env,
      json: values.json === true,
      now: clock(io.env),
      out: io.out,
      err: io.err,
    };
    return await spec.run({ values, positionals: parsed.positionals }, ctx);
  } catch (e) {
    if (e instanceof UserError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`sl ${name}: ${(e as Error).message}`);
      return 1;
    }
    io.err(`sl ${name}: unexpected error: ${(e as Error).stack ?? e}`);
    return 2;
  }
}

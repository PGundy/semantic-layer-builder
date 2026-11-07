// What the MCP server never passes and what each role may call (spec: MCP server, Agent roles).
// The server and the plugin's MCP hook (guard.ts) both read these, so a tool call is held to the
// same rules the Bash hook applies to `sl` on the command line.
import { DENIED_FLAGS, OWNER_COMMANDS, type Role, slRefusal } from "../lib/roles.ts";
import { DENIED_OPTIONS, POSITIONALS_ARG } from "./schema.ts";

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The argument of a tool call that names a denied option, in any spelling (show-protected,
// show_protected, --showProtected), or a positional that reads as the flag (`positionals`), or
// undefined when there is none.
export function deniedArgument(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const key = Object.keys(args).find((k) => DENIED_OPTIONS.some((o) => squash(o) === squash(k)));
  if (key !== undefined) return key;
  const positionals = (args as Record<string, unknown>)[POSITIONALS_ARG];
  const flag = (p: unknown) => DENIED_FLAGS.some((f) => String(p) === f || String(p).startsWith(`${f}=`));
  return Array.isArray(positionals) && positionals.some(flag) ? POSITIONALS_ARG : undefined;
}

export function deniedMessage(tool: string, key: string): string {
  const what = key === POSITIONALS_ARG ? `a positional in "${key}"` : `"${key}"`;
  return (
    `${tool} refused: ${what} asks for --show-protected, which the semantic-layer MCP server never passes ` +
    `(invariant 3: protected values stay masked; only the owner prints them, by hand, in a terminal). Call ${tool} again without it.`
  );
}

// Whether the role runs some form of the command, so the server lists its tool.
export function roleListsCommand(role: Role, command: string): boolean {
  if (!role.owner && (OWNER_COMMANDS as readonly string[]).includes(command)) return false;
  if (role.commands === "every") return true;
  return role.commands.some((c) => c === command || c.startsWith(`${command} `));
}

// Why the role may not call the command's tool with these arguments, or undefined when it may.
// A subcommand is the first positional, as argvOf passes it; nothing after it is read as a flag.
export function roleCallRefusal(role: Role, command: string, args: unknown): string | undefined {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const positionals = Array.isArray(a[POSITIONALS_ARG]) ? (a[POSITIONALS_ARG] as unknown[]) : [];
  const sub = positionals.length ? [String(positionals[0])] : [];
  // The closing "--" keeps slRefusal from reading a positional --help as the help flag.
  return slRefusal(role, [command, ...sub, "--"]);
}

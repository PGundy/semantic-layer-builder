// The roles of a multi-agent run (spec: Roles): what each may run and do. This table is the one
// source: the plugin's agents/<agent>.md files, the spec's Roles table and the PreToolUse hook's role
// check all follow it, and tests/agent-roles.test.ts holds them to it.

export const ROLE_NAMES = ["interviewer", "connector_runner", "batch_analyst", "readback_verifier", "golden_builder"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface Role {
  name: RoleName;
  // How the spec's table names the role.
  title: string;
  // The frontmatter name of agents/<agent>.md; Claude Code may report it as "<plugin>:<agent>".
  agent: string;
  // The sl commands the role may run: "every", or "<command>" and "<command> <subcommand>" entries.
  commands: "every" | readonly string[];
  // "sl_only": every command of a Bash call must be an sl invocation the role may run (or a cd);
  // "any": other shell commands are left to the hook's other checks.
  shell: "sl_only" | "any";
  // "none": no Edit, MultiEdit, Write or NotebookEdit at all; "outside_layer": none on a file inside a semantic root.
  edits: "none" | "outside_layer";
  // Whether the role talks to the owner, and so may record their answers (sl reply) and act on them.
  owner: boolean;
  may: readonly string[];
  may_not: readonly string[];
}

// The commands that act on the owner's answers: only a role that talks to the owner runs them.
export const OWNER_COMMANDS = ["reply", "approve", "goldens confirm"] as const;
// Flags no role passes: --show-protected is for the owner, run by hand (invariant 3).
export const DENIED_FLAGS = ["--show-protected"] as const;

export const ROLES: Record<RoleName, Role> = {
  interviewer: {
    name: "interviewer",
    title: "Interviewer",
    agent: "sl-interviewer",
    commands: "every",
    shell: "any",
    edits: "outside_layer",
    owner: true,
    may: [
      "talk to the owner",
      "run sl next, sl readback, sl reply, sl approve, sl goldens confirm and every other sl command",
      "dispatch tasks to the other roles",
    ],
    may_not: [
      "pass --show-protected to any sl command, or run raw SQL against protected columns",
      "edit a file inside the semantic root by hand (YAML changes go through typed edits)",
    ],
  },
  connector_runner: {
    name: "connector_runner",
    title: "Connector runner",
    agent: "sl-connector-runner",
    commands: ["results add", "results status"],
    shell: "sl_only",
    edits: "none",
    owner: false,
    may: [
      "run the queries of the plan in its task through the warehouse connector, read-only",
      "store each result with sl results add and check the plan with sl results status",
    ],
    may_not: ["approve, confirm or record a reply", "talk to the owner", "work on a plan other than the one in its task", "edit files", "run any other shell command"],
  },
  batch_analyst: {
    name: "batch_analyst",
    title: "Batch analyst",
    agent: "sl-batch-analyst",
    commands: ["brief"],
    shell: "sl_only",
    edits: "none",
    owner: false,
    may: ["read sl brief --batch packets", "propose question lists and draft wording for the interviewer"],
    may_not: ["approve, confirm or record a reply", "talk to the owner", "edit files", "run any other shell command"],
  },
  readback_verifier: {
    name: "readback_verifier",
    title: "Readback verifier",
    agent: "sl-readback-verifier",
    commands: ["readback"],
    shell: "sl_only",
    edits: "none",
    owner: false,
    may: ["compare a drafted owner message with sl readback output", "report missing or extra clauses"],
    may_not: ["approve, confirm or record a reply", "talk to the owner", "edit files", "run any other shell command"],
  },
  golden_builder: {
    name: "golden_builder",
    title: "Golden builder",
    agent: "sl-golden-builder",
    commands: ["goldens new", "goldens run", "goldens check", "sql"],
    shell: "sl_only",
    edits: "none",
    owner: false,
    may: [
      "write a draft golden for a figure the owner gave with sl goldens new",
      "compile it with sl sql and run it with sl goldens run or sl goldens check",
      "report a match or the gap",
    ],
    may_not: ["confirm goldens, approve or record a reply", "talk to the owner", "edit files", "run any other shell command"],
  },
};

// The role an agent_type names: the agent's frontmatter name, alone or after a plugin's "<plugin>:"
// prefix (the last ":"-separated part counts). Any other agent, and no agent_type, is no role.
export function roleOf(agentType: unknown): Role | undefined {
  if (typeof agentType !== "string" || !agentType) return undefined;
  const name = agentType.slice(agentType.lastIndexOf(":") + 1);
  return Object.values(ROLES).find((r) => r.agent === name);
}

// The sl commands a role may run, as a reader sees them ("sl results add, sl results status").
export function commandList(role: Role): string {
  return role.commands === "every" ? "every sl command" : role.commands.map((c) => `sl ${c}`).join(", ");
}

// Why `role` may not run sl with these arguments (the words after sl.ts), or undefined when it may.
export function slRefusal(role: Role, args: readonly string[]): string | undefined {
  const [name, sub] = args;
  if (!name || name.startsWith("-")) return `it runs sl without a command first; the ${role.title.toLowerCase()} may run ${commandList(role)}.`;
  const flag = args.find((a) => DENIED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
  if (flag) return `it passes ${flag.split("=")[0]} to sl ${name}; protected values are for the owner to print by hand, so no agent passes it. Run the command without it.`;
  // --help prints the usage and runs nothing; after "--" it would be an argument instead.
  if ((args.includes("--help") || args.includes("-h")) && !args.includes("--")) return undefined;
  const full = sub && !sub.startsWith("-") ? `${name} ${sub}` : name;
  if (!role.owner && (OWNER_COMMANDS as readonly string[]).some((c) => c === name || c === full))
    return `sl ${full} acts on the owner's recorded answers, and only the interviewer, who talks to the owner, runs it. Report back to the interviewer instead; the ${role.title.toLowerCase()} may run ${commandList(role)}.`;
  if (role.commands === "every") return undefined;
  if (role.commands.includes(name) || role.commands.includes(full)) return undefined;
  const needsSub = role.commands.some((c) => c.startsWith(`${name} `));
  if (needsSub && (!sub || sub.startsWith("-")))
    return `sl ${name} needs its subcommand right after the command name (${role.commands.filter((c) => c.startsWith(`${name} `)).map((c) => `sl ${c}`).join(", ")}).`;
  return `the ${role.title.toLowerCase()} may not run sl ${full}; it may run ${commandList(role)}.`;
}

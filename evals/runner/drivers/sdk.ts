// Plays both sides with the Claude Agent SDK. The package is not a dependency of this repository:
// it is imported only when this driver is selected, and its absence is a plain message.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES, roleOf, slRefusal } from "../../../skills/semantic-layer/scripts/lib/roles.ts";
import { REPO_ROOT } from "../files.ts";
import { redactSecrets } from "../redact.ts";
import type { AgentRole, CommandRun, Driver, OwnerTurnInput, RoleTurn, SkillTurnInput } from "../types.ts";
import { EvalError } from "../types.ts";
import { refuseSkillTool, SKILL_DIR, SKILL_TOOLS, SL } from "./guard.ts";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
// The line the skill agent ends its message with when the session is over.
export const DONE_MARKER = "[[done]]";

const SKILL_MD = join(SKILL_DIR, "SKILL.md");
// Tools neither agent gets.
const OTHER_TOOLS = ["WebFetch", "WebSearch", "Task", "NotebookEdit", "MultiEdit", "TodoWrite", "KillShell", "BashOutput"];
// The tool the interviewer dispatches a role agent with; the SDK has named it Task and Agent.
const DISPATCH_TOOLS = ["Task", "Agent"];
// The agent names the role agents take tasks under, as agents/sl-*.md name them.
const ROLE_AGENTS = Object.values(ROLES)
  .filter((r) => r.name !== "interviewer")
  .map((r) => r.agent);

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string };
type SdkMessage = {
  type?: string;
  subtype?: string;
  result?: unknown;
  usage?: Record<string, unknown>;
  errors?: unknown;
  parent_tool_use_id?: string | null;
  message?: { id?: string; content?: unknown; usage?: Record<string, unknown> };
};
type QueryFn = (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export interface SdkDriverOptions {
  model?: string;
  // "multi": the skill agent is the interviewer and may dispatch the role agents of agents/sl-*.md.
  agents?: "single" | "multi";
  env?: Record<string, string | undefined>;
  // Replaced in tests; defaults to a dynamic import.
  importer?: (name: string) => Promise<unknown>;
}

const missingPackage = () =>
  new EvalError(
    `The sdk driver needs the package ${SDK_PACKAGE}, which this repository does not install. ` +
      `Install it locally with \`bun add --no-save ${SDK_PACKAGE}\`, set ANTHROPIC_API_KEY, and rerun; ` +
      "or run with --driver scripted.",
  );

export async function sdkDriver(opts: SdkDriverOptions = {}): Promise<Driver> {
  const env = opts.env ?? process.env;
  let mod: unknown;
  try {
    // A variable name keeps the typechecker and bundler from resolving the optional package.
    const name = SDK_PACKAGE;
    mod = await (opts.importer ?? ((n: string) => import(n)))(name);
  } catch {
    throw missingPackage();
  }
  const query = (mod as { query?: unknown }).query;
  if (typeof query !== "function") throw missingPackage();
  if (!env.ANTHROPIC_API_KEY) {
    throw new EvalError("The sdk driver needs ANTHROPIC_API_KEY set in the environment (never in a file). Export it and rerun, or run with --driver scripted.");
  }
  return makeDriver(query as QueryFn, opts.model, opts.agents === "multi");
}

function tokensOf(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const keys = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  return keys.reduce((n, k) => n + (typeof usage[k] === "number" ? (usage[k] as number) : 0), 0);
}

// Text of a tool result's content: a string, or its text blocks.
const resultText = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? (content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : "";
const blocks = (m: SdkMessage): Block[] => (Array.isArray(m.message?.content) ? (m.message!.content as Block[]) : []);
// "sl <args>" for a Bash command that runs the CLI, as a transcript writes it: without a leading
// `cd <dir> &&` and without --root; any other command comes back trimmed.
function slCommand(command: string): string {
  const c = command.trim().replace(/^cd\s+\S+\s*&&\s*/, "");
  if (!c.startsWith(`bun ${SL} `)) return command.trim();
  return `sl ${c.slice(SL.length + 5)}`.replace(/\s+--root(?:=|\s+)\S+/g, "").trim();
}

// Runs one query and returns its final text and the tokens it used. In a multi-agent query, each task
// the interviewer dispatched comes back as a role turn: the role its subagent_type names, the tokens
// of the subagent's own messages (parent_tool_use_id), its sl commands and the result it returned;
// the interviewer keeps the query's tokens less the roles'.
async function ask(query: QueryFn, prompt: string, options: Record<string, unknown>): Promise<{ text: string; tokens: number; dispatches: RoleTurn[] }> {
  const tasks = new Map<string, RoleTurn>();
  const pending = new Map<string, { role: RoleTurn; command: string }>();
  const counted = new Set<string>();
  for await (const m of query({ prompt, options })) {
    const parent = m.parent_tool_use_id ? tasks.get(m.parent_tool_use_id) : undefined;
    if (m.type === "assistant") {
      // One API response can come as several messages sharing its id and usage: count it once.
      const id = m.message?.id;
      if (parent && !(id && counted.has(id))) parent.tokens += tokensOf(m.message?.usage);
      if (id) counted.add(id);
      for (const b of blocks(m)) {
        if (b.type !== "tool_use" || !b.id) continue;
        const role = roleOf(b.input?.subagent_type);
        if (!parent && DISPATCH_TOOLS.includes(b.name ?? "") && role && role.name !== "interviewer") tasks.set(b.id, { agent: role.name as AgentRole, text: "", tokens: 0 });
        const command = slCommand(String(b.input?.command ?? ""));
        if (parent && b.name === "Bash" && command.startsWith("sl ")) pending.set(b.id, { role: parent, command });
      }
    }
    if (m.type === "user") {
      for (const b of blocks(m)) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const task = !parent ? tasks.get(b.tool_use_id) : undefined;
        if (task) task.text = resultText(b.content);
        const run = pending.get(b.tool_use_id);
        if (run) (run.role.commands ??= []).push({ command: run.command, exit_code: b.is_error ? 1 : 0 } satisfies CommandRun);
      }
    }
    if (m.type !== "result") continue;
    if (m.subtype !== "success") {
      const detail = Array.isArray(m.errors) && m.errors.length ? `: ${redactSecrets(m.errors.map(String).join("; "))}` : "";
      throw new EvalError(`The agent SDK stopped with ${m.subtype ?? "an error"}${detail}. Fix the cause and rerun, or raise the scenario's budgets.`);
    }
    const dispatches = [...tasks.values()];
    const roles = dispatches.reduce((n, d) => n + d.tokens, 0);
    return { text: typeof m.result === "string" ? m.result : "", tokens: Math.max(0, tokensOf(m.usage) - roles), dispatches };
  }
  throw new EvalError("The agent SDK returned no result message; check the SDK version and rerun.");
}

// The role agents' definitions for the SDK's agents option, from agents/sl-*.md (the interviewer is
// the main agent): the frontmatter's description, the body as the prompt with the CLI's path, and
// its tools less any that edit files or dispatch, since only the interviewer does either.
export function agentDefinitions(dir = join(REPO_ROOT, "agents")): Record<string, { description: string; prompt: string; tools: string[] }> {
  const out: Record<string, { description: string; prompt: string; tools: string[] }> = {};
  for (const file of readdirSync(dir).filter((f) => /^sl-.*\.md$/.test(f)).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) continue;
    const front = Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
    const role = roleOf(front.name);
    if (!role || role.name === "interviewer") continue;
    const listed = front.tools ? front.tools.split(",").map((t: string) => t.trim()) : SKILL_TOOLS;
    out[front.name!] = {
      description: front.description ?? "",
      prompt: `${m[2]!.trim()}\n\nThe sl CLI here is \`bun ${SL} <command> --root .\`, run in the semantic root, the current directory.`,
      tools: listed.filter((t: string) => SKILL_TOOLS.includes(t) && t !== "Write" && t !== "Edit"),
    };
  }
  return out;
}

function skillPrompt(input: SkillTurnInput): string {
  return [
    "Files in the semantic root (the current directory):",
    ...Object.keys(input.files).map((f) => `- ${f}`),
    "",
    "The data owner's latest message:",
    input.owner_message,
  ].join("\n");
}

// The block an owner reply hands a file back in: a line <<<file shared/<name>, the file, a line >>>.
const FILE_BLOCK = /^<<<file (\S+)\n([\s\S]*?)\n>>>[ \t]*$/gm;

function ownerPrompt(input: OwnerTurnInput): string {
  const lines = input.history.map((t) => `${t.speaker === "owner" ? "You" : "Agent"}: ${t.text}`);
  const forms = Object.entries(input.forms ?? {});
  const handed = forms.length
    ? [
        "",
        "The review forms the agent has written for you, each between its <<<form and >>> lines:",
        ...forms.flatMap(([path, text]) => [`<<<form ${path}`, text.trimEnd(), ">>>"]),
        "",
        "To hand a form back filled in, copy it whole, mark the boxes and write your answers as it says, and put it in your reply between a line `<<<file shared/<name>.md` (`.json` for a JSON form) and a line `>>>`. Change nothing else in it.",
      ]
    : [];
  return ["The conversation so far:", ...lines, ...handed, "", "Reply to the agent's last message as the owner. Write only your reply."].join("\n");
}

// An owner reply split into its text and the files it hands back (FILE_BLOCK).
export function ownerReply(reply: string): { text: string; files?: Record<string, string> } {
  const files: Record<string, string> = {};
  const text = reply.replace(FILE_BLOCK, (_, path: string, body: string) => ((files[path] = `${body}\n`), "")).trim();
  return Object.keys(files).length ? { text, files } : { text };
}

// Why a role agent's call is refused, or undefined: it edits no files and dispatches nothing, and runs
// only the sl commands its role may (lib/roles.ts). The interviewer, the query's own agent, is held
// to the skill agent's guard alone.
export function refuseRoleTool(agentType: unknown, tool: string, input: Record<string, unknown>): string | undefined {
  const role = roleOf(agentType);
  if (!role || role.name === "interviewer") return undefined;
  if (tool === "Write" || tool === "Edit" || DISPATCH_TOOLS.includes(tool)) return `The ${role.title.toLowerCase()} may not use ${tool}: only the interviewer edits files and dispatches tasks.`;
  if (tool !== "Bash") return undefined;
  const args = (slCommand(String(input.command ?? "")).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"));
  const why = args[0] === "sl" ? slRefusal(role, args.slice(1)) : undefined;
  return why ? `Running "${String(input.command)}" is refused: ${why}` : undefined;
}

// A subagent is one of the four role agents of a multi-agent run, or none may act: the SDK's own
// agents (general-purpose and the like) are refused every call.
function refuseAgent(agentType: unknown, multi: boolean): string | undefined {
  if (agentType === undefined || agentType === null || agentType === "") return undefined;
  const role = roleOf(agentType);
  if (multi && role && role.name !== "interviewer") return undefined;
  return `The agent ${String(agentType)} is not one of the role agents (${ROLE_AGENTS.join(", ")}), so it may not act here; dispatch a role agent with the Task tool instead.`;
}

// The interviewer dispatches only in a multi-agent run, and only to a role agent by its name.
function refuseDispatch(tool: string, input: Record<string, unknown>, multi: boolean): string | undefined {
  if (!multi) return `The ${tool} tool is not available in a single-agent run; do the work yourself with ${SKILL_TOOLS.join(", ")}.`;
  const name = input.subagent_type;
  const role = roleOf(name);
  if (role && role.name !== "interviewer" && name === role.agent) return undefined;
  return `Dispatching ${name === undefined ? "a task with no subagent_type" : `"${String(name)}"`} is refused: only the role agents ${ROLE_AGENTS.join(", ")} take tasks.`;
}

// A PreToolUse hook that denies a call the guard refuses, before it runs. In a multi-agent run the
// interviewer may also dispatch tasks, and each role agent is held to its role.
export function guardHook(root: string, multi = false) {
  return async (input: { tool_name?: string; tool_input?: unknown; agent_type?: unknown }) => {
    const tool = String(input.tool_name);
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const interviewerDispatch = DISPATCH_TOOLS.includes(tool) && !input.agent_type;
    const reason =
      refuseAgent(input.agent_type, multi) ??
      (interviewerDispatch ? refuseDispatch(tool, args, multi) : (refuseRoleTool(input.agent_type, tool, args) ?? refuseSkillTool(tool, args, root)));
    return reason === undefined
      ? {}
      : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };
}

function makeDriver(query: QueryFn, model: string | undefined, multi = false): Driver {
  const base = { settingSources: [], ...(model ? { model } : {}) };
  return {
    async skillTurn(input) {
      const system =
        `You are the interviewer agent building a semantic layer with a data owner. Read ${SKILL_MD} and follow it. ` +
        `The semantic root is the current directory; run the CLI as \`bun ${SL} <command> --root .\`, starting with sl status. ` +
        `You may read only the current directory and ${SKILL_DIR}, and write only in the current directory. ` +
        "You remember nothing from earlier turns: the files and the owner's latest message are all you have. " +
        (multi
          ? "Dispatch tasks to the role agents (sl-batch-analyst, sl-readback-verifier, sl-golden-builder, sl-connector-runner) with the Task tool, as agents/sl-interviewer.md says, and keep the owner's words and every approval to yourself. "
          : "") +
        `Reply with your next message to the owner. When the layer is done or the session should end, end the message with the line ${DONE_MARKER}.`;
      const r = await ask(query, skillPrompt(input), {
        ...base,
        cwd: input.root,
        systemPrompt: system,
        allowedTools: multi ? [...SKILL_TOOLS, ...DISPATCH_TOOLS] : SKILL_TOOLS,
        disallowedTools: multi ? OTHER_TOOLS.filter((t) => !DISPATCH_TOOLS.includes(t)) : OTHER_TOOLS,
        ...(multi ? { agents: agentDefinitions() } : {}),
        // Every tool call passes the guard, which keeps reads and writes inside the root.
        hooks: { PreToolUse: [{ hooks: [guardHook(input.root, multi)] }] },
        maxTurns: 60,
      });
      const done = r.text.includes(DONE_MARKER);
      return { text: r.text.replaceAll(DONE_MARKER, "").trim(), tokens: r.tokens, done, ...(r.dispatches.length ? { dispatches: r.dispatches } : {}) };
    },
    async ownerTurn(input) {
      const system = `${input.persona_prompt}\n\nYour private brief follows. Answer from it; never paste it.\n\n${input.brief}`;
      const r = await ask(query, ownerPrompt(input), {
        ...base,
        systemPrompt: system,
        allowedTools: [],
        disallowedTools: [...SKILL_TOOLS, ...OTHER_TOOLS],
        maxTurns: 1,
      });
      return { ...ownerReply(r.text), tokens: r.tokens };
    },
  };
}

// Plays both sides with the Claude Agent SDK. The package is not a dependency of this repository:
// it is imported only when this driver is selected, and its absence is a plain message.
import { join } from "node:path";
import { redactSecrets } from "../redact.ts";
import type { Driver, OwnerTurnInput, SkillTurnInput } from "../types.ts";
import { EvalError } from "../types.ts";
import { refuseSkillTool, SKILL_DIR, SKILL_TOOLS, SL } from "./guard.ts";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
// The line the skill agent ends its message with when the session is over.
export const DONE_MARKER = "[[done]]";

const SKILL_MD = join(SKILL_DIR, "SKILL.md");
// Tools neither agent gets.
const OTHER_TOOLS = ["WebFetch", "WebSearch", "Task", "NotebookEdit", "MultiEdit", "TodoWrite", "KillShell", "BashOutput"];

type SdkMessage = { type?: string; subtype?: string; result?: unknown; usage?: Record<string, unknown>; errors?: unknown };
type QueryFn = (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

export interface SdkDriverOptions {
  model?: string;
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
  return makeDriver(query as QueryFn, opts.model);
}

function tokensOf(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const keys = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  return keys.reduce((n, k) => n + (typeof usage[k] === "number" ? (usage[k] as number) : 0), 0);
}

// Runs one query and returns its final text and the tokens it used.
async function ask(query: QueryFn, prompt: string, options: Record<string, unknown>): Promise<{ text: string; tokens: number }> {
  for await (const m of query({ prompt, options })) {
    if (m.type !== "result") continue;
    if (m.subtype !== "success") {
      const detail = Array.isArray(m.errors) && m.errors.length ? `: ${redactSecrets(m.errors.map(String).join("; "))}` : "";
      throw new EvalError(`The agent SDK stopped with ${m.subtype ?? "an error"}${detail}. Fix the cause and rerun, or raise the scenario's budgets.`);
    }
    return { text: typeof m.result === "string" ? m.result : "", tokens: tokensOf(m.usage) };
  }
  throw new EvalError("The agent SDK returned no result message; check the SDK version and rerun.");
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

function ownerPrompt(input: OwnerTurnInput): string {
  const lines = input.history.map((t) => `${t.speaker === "owner" ? "You" : "Agent"}: ${t.text}`);
  return ["The conversation so far:", ...lines, "", "Reply to the agent's last message as the owner. Write only your reply."].join("\n");
}

// A PreToolUse hook that denies a call the guard refuses, before it runs.
export function guardHook(root: string) {
  return async (input: { tool_name?: string; tool_input?: unknown }) => {
    const reason = refuseSkillTool(String(input.tool_name), (input.tool_input ?? {}) as Record<string, unknown>, root);
    return reason === undefined
      ? {}
      : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };
}

function makeDriver(query: QueryFn, model: string | undefined): Driver {
  const base = { settingSources: [], ...(model ? { model } : {}) };
  return {
    async skillTurn(input) {
      const system =
        `You are the interviewer agent building a semantic layer with a data owner. Read ${SKILL_MD} and follow it. ` +
        `The semantic root is the current directory; run the CLI as \`bun ${SL} <command> --root .\`, starting with sl status. ` +
        `You may read only the current directory and ${SKILL_DIR}, and write only in the current directory. ` +
        "You remember nothing from earlier turns: the files and the owner's latest message are all you have. " +
        `Reply with your next message to the owner. When the layer is done or the session should end, end the message with the line ${DONE_MARKER}.`;
      const r = await ask(query, skillPrompt(input), {
        ...base,
        cwd: input.root,
        systemPrompt: system,
        allowedTools: SKILL_TOOLS,
        disallowedTools: OTHER_TOOLS,
        // Every tool call passes the guard, which keeps reads and writes inside the root.
        hooks: { PreToolUse: [{ hooks: [guardHook(input.root)] }] },
        maxTurns: 60,
      });
      const done = r.text.includes(DONE_MARKER);
      return { text: r.text.replaceAll(DONE_MARKER, "").trim(), tokens: r.tokens, done };
    },
    async ownerTurn(input) {
      const system = `${input.persona_prompt}\n\nYour private brief follows. Answer from it; never paste it.\n\n${input.brief}`;
      return ask(query, ownerPrompt(input), {
        ...base,
        systemPrompt: system,
        allowedTools: [],
        disallowedTools: [...SKILL_TOOLS, ...OTHER_TOOLS],
        maxTurns: 1,
      });
    },
  };
}

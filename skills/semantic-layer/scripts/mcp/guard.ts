#!/usr/bin/env bun
// The plugin's PreToolUse hook on the semantic-layer MCP server's tools (spec: Agent roles). The
// server runs as one role for the whole session, so this hook holds each role agent's tool calls to
// its own role, as guard-edits.ts holds its Bash calls, and refuses --show-protected from anyone.
// Exit 0 allows the call; exit 2 refuses it with the reason on stderr.
import { COMMANDS } from "../commands/index.ts";
import { commandList, roleOf } from "../lib/roles.ts";
import { deniedArgument, deniedMessage, roleCallRefusal } from "./limits.ts";
import { toolName } from "./schema.ts";

export interface McpVerdict {
  allow: boolean;
  message?: string;
}

// The sl command an MCP tool name runs: the part after the last "__" (Claude Code names a tool
// mcp__<server>__<tool>) is sl_<command>, with - as _.
export function commandOfTool(tool: string): string | undefined {
  const bare = tool.slice(tool.lastIndexOf("__") + 2);
  return Object.keys(COMMANDS).find((c) => toolName(c) === bare);
}

export function checkMcpCall(stdin: string): McpVerdict {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    return { allow: true, message: "semantic-layer MCP hook: the hook input is not a JSON object; not checked." };
  }
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const command = commandOfTool(tool);
  if (!command) return { allow: true };
  const args = input.tool_input ?? {};
  const denied = deniedArgument(args);
  if (denied !== undefined) return { allow: false, message: `semantic-layer: ${deniedMessage(tool, denied)}` };
  const role = roleOf(input.agent_type);
  if (!role) return { allow: true };
  const why = roleCallRefusal(role, command, args);
  if (!why) return { allow: true };
  const list = commandList(role);
  const may = why.includes(list) ? "" : `\nIt may run ${list}.`;
  return { allow: false, message: `semantic-layer: refused ${tool} for the ${role.title.toLowerCase()} (${role.agent}):\n- ${why}${may}` };
}

if (import.meta.main) {
  const verdict = checkMcpCall(await Bun.stdin.text());
  if (verdict.message) process.stderr.write(`${verdict.message}\n`);
  process.exit(verdict.allow ? 0 : 2);
}

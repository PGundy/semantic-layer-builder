#!/usr/bin/env bun
// The semantic-layer CLI as an MCP server: JSON-RPC 2.0 over stdio, one JSON message per line.
// Each CLI command is one tool; a call runs the command in-process with --json in the server's
// semantic root. stdout carries protocol messages only; logs go to stderr.
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { COMMANDS } from "../commands/index.ts";
import { runCli } from "../lib/cli.ts";
import type { CommandSpec } from "../lib/command.ts";
import { resolveRoot } from "../lib/project.ts";
import { argvOf, ROOT_ARG, schemaValidator, toolOf, type Tool } from "./schema.ts";

export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
const SERVER_INFO = { name: "semantic-layer", title: "Semantic layer builder", version: "0.1.0" };

// JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type Id = string | number | null;
export type Message = Record<string, unknown>;

export interface ServerOptions {
  root: string;
  cwd: string;
  env: Record<string, string | undefined>;
  log: (text: string) => void;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  command: string;
  spec: CommandSpec;
  tool: Tool;
  validate: ValidateFunction;
}

// The path a root names, with links resolved where it exists, so two spellings of one directory compare equal.
function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function plainErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => {
      if (e.keyword === "additionalProperties") return `unknown argument "${(e.params as { additionalProperty: string }).additionalProperty}"`;
      const at = e.instancePath ? `"${e.instancePath.slice(1).replaceAll("/", ".")}"` : "the arguments";
      return `${at} ${e.message ?? "is invalid"}`;
    })
    .join("; ");
}

export class Server {
  private entries: Promise<Map<string, Entry>> | undefined;
  // Tool calls run one at a time, in the order they arrive, so two commands never write the same file at once.
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;

  constructor(private readonly opts: ServerOptions) {
    this.root = resolve(opts.root);
  }

  // Every discovered command, by tool name. A command that fails to load is logged and left out.
  private tools(): Promise<Map<string, Entry>> {
    this.entries ??= (async () => {
      const ajv = schemaValidator();
      const out = new Map<string, Entry>();
      for (const [command, load] of Object.entries(COMMANDS)) {
        try {
          const spec = (await load()).default;
          const tool = toolOf(command, spec);
          out.set(tool.name, { command, spec, tool, validate: ajv.compile(tool.inputSchema) });
        } catch (e) {
          this.opts.log(`sl ${command} is unavailable as a tool: ${(e as Error).message}`);
        }
      }
      return out;
    })();
    return this.entries;
  }

  // The response to one message, or null for a notification.
  async handle(msg: unknown): Promise<Message | null> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      return failure(null, INVALID_REQUEST, "Each message must be one JSON-RPC 2.0 object; batches are not supported.");
    }
    const m = msg as Message;
    const hasId = "id" in m;
    if (hasId && m.id !== null && typeof m.id !== "string" && typeof m.id !== "number") {
      return failure(null, INVALID_REQUEST, 'A request "id" must be a string, a number or null.');
    }
    const id = (hasId ? m.id : null) as Id;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      // A response from the client (to a request this server never sends) needs no answer.
      if (m.jsonrpc === "2.0" && hasId && ("result" in m || "error" in m)) return null;
      return failure(id, INVALID_REQUEST, 'A request needs "jsonrpc": "2.0" and a "method".');
    }
    if (!hasId) return null; // notifications/initialized, notifications/cancelled and any other notification
    const params = "params" in m ? m.params : {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) return failure(id, INVALID_PARAMS, '"params" must be an object.');
    try {
      return { jsonrpc: "2.0", id, result: await this.dispatch(m.method, params as Message) };
    } catch (e) {
      if (e instanceof RpcError) return failure(id, e.code, e.message);
      this.opts.log(`internal error in ${m.method}: ${(e as Error).stack ?? e}`);
      return failure(id, INTERNAL_ERROR, `Internal error: ${(e as Error).message}`);
    }
  }

  private async dispatch(method: string, params: Message): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion: typeof asked === "string" && SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: `Each tool runs one sl command with --json in the semantic root ${this.root}. Start with sl_status, which names the next step. A call cannot name another root: to work in one, start the server again with --root <dir>. Pass absolute paths for file flags; relative ones resolve from the server's working directory.`,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: [...(await this.tools()).values()].map((e) => e.tool) };
      case "tools/call": {
        const run = this.queue.then(() => this.call(params));
        this.queue = run.catch(() => undefined);
        return run;
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Unknown method "${method}". This server answers initialize, ping, tools/list and tools/call.`);
    }
  }

  private async call(params: Message): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool "name". Call tools/list for the tools.');
    const entry = (await this.tools()).get(name);
    if (!entry) throw new RpcError(INVALID_PARAMS, `Unknown tool "${name}". Call tools/list for the tools.`);
    const args = params.arguments ?? {};
    if (!entry.validate(args)) {
      throw new RpcError(INVALID_PARAMS, `Invalid arguments for ${name}: ${plainErrors(entry.validate.errors)}. Call tools/list for the arguments it takes.`);
    }
    const a = args as Message;
    const asked = a[ROOT_ARG];
    if (typeof asked === "string" && canonical(resolve(this.opts.cwd, asked)) !== canonical(this.root)) {
      throw new RpcError(
        INVALID_PARAMS,
        `This server works only in the semantic root ${this.root}; leave out "root" to use it. To work in another root, start the server again with --root <dir>.`,
      );
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argvOf(entry.command, entry.spec, a, this.root), {
      cwd: this.opts.cwd,
      env: this.opts.env,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });
    const content = [out.join("\n"), err.join("\n")].filter((t) => t !== "").map((text) => ({ type: "text", text }));
    if (!content.length) content.push({ type: "text", text: code === 0 ? "{}" : `sl ${entry.command} exited with code ${code}.` });
    return code === 0 ? { content } : { content, isError: true };
  }
}

function failure(id: Id, code: number, message: string): Message {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const USAGE = `Usage: bun skills/semantic-layer/scripts/mcp/server.ts [--root <dir>]

Serves every sl command as an MCP tool over stdio. The semantic root is --root, else SEMANTIC_ROOT,
else ./semantic; a tool call cannot name another root.`;

// Reads one JSON-RPC message per line from stdin and writes each response as one line to stdout.
async function main(): Promise<number> {
  const log = (t: string) => process.stderr.write(`${t}\n`);
  let flags: { root?: string; help?: boolean };
  try {
    flags = parseArgs({ args: process.argv.slice(2), options: { root: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true }).values;
  } catch (e) {
    log(`sl mcp: ${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Anything that prints with console.log during a call goes to stderr, never into the protocol stream.
  const write = process.stdout.write.bind(process.stdout);
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  const server = new Server({ root: resolveRoot(flags.root, process.env, process.cwd()), cwd: process.cwd(), env: process.env, log });
  log(`sl mcp: serving the semantic root ${server.root} over stdio`);
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write(`${JSON.stringify(failure(null, PARSE_ERROR, "A line is not valid JSON. Send one JSON-RPC message per line."))}\n`);
      continue;
    }
    const p = server.handle(msg).then((res) => {
      if (res) write(`${JSON.stringify(res)}\n`);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  return 0;
}

if (import.meta.main) process.exit(await main());

// The MCP server's limits (spec: MCP server, Protected values and Roles): no tool passes
// --show-protected, --role limits the tools to one role's commands, and the plugin's MCP hook holds
// role agents to their roles. Calls go to an in-process Server; startup flags to a subprocess.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { ROLE_NAMES, type RoleName } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { checkMcpCall, commandOfTool } from "../skills/semantic-layer/scripts/mcp/guard.ts";
import { argvOf, inputSchema, toolName } from "../skills/semantic-layer/scripts/mcp/schema.ts";
import { INVALID_PARAMS, type Message, Server } from "../skills/semantic-layer/scripts/mcp/server.ts";
import { FIXED_NOW, tempRoot } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const SERVER = join(REPO, "skills", "semantic-layer", "scripts", "mcp", "server.ts");
const ACME = join(REPO, "examples", "acme", "semantic");

type Msg = Record<string, any>;
const t = tempRoot();
beforeAll(() => cpSync(ACME, t.root, { recursive: true }));
afterAll(() => t.cleanup());

function server(role?: RoleName): Server {
  return new Server({ root: t.root, cwd: t.dir, env: { ...process.env, SL_NOW: FIXED_NOW }, log: () => {}, ...(role ? { role } : {}) });
}
let nextId = 1;
async function request(s: Server, method: string, params: Message = {}): Promise<Msg> {
  return (await s.handle({ jsonrpc: "2.0", id: nextId++, method, params })) as Msg;
}
const call = (s: Server, name: string, args: Message = {}) => request(s, "tools/call", { name, arguments: args });
async function listed(s: Server): Promise<Msg[]> {
  return (await request(s, "tools/list")).result.tools as Msg[];
}

// The tools each role lists, written out from the spec's Roles table.
const EXPECTED: Record<Exclude<RoleName, "interviewer">, string[]> = {
  connector_runner: ["sl_results"],
  batch_analyst: ["sl_brief"],
  readback_verifier: ["sl_readback"],
  golden_builder: ["sl_goldens", "sl_sql"],
};

describe("--show-protected", () => {
  test("no tool schema has it, for any command or role, and argvOf never writes it", async () => {
    for (const [command, load] of Object.entries(COMMANDS)) {
      const spec = (await load()).default;
      expect(Object.keys(inputSchema(spec).properties!)).not.toContain("show-protected");
      expect(argvOf(command, spec, { "show-protected": true }, t.root)).not.toContain("--show-protected");
    }
    for (const role of ROLE_NAMES) {
      for (const tool of await listed(server(role))) {
        expect(Object.keys(tool.inputSchema.properties).some((k) => /show.?protected/i.test(k))).toBe(false);
      }
    }
    const run = (await listed(server())).find((x) => x.name === "sl_run")!;
    expect(run.description).toContain("This server never passes --show-protected: protected values stay masked (invariant 3).");
  });

  test("a crafted call naming it, in any spelling, is refused with a plain error naming invariant 3", async () => {
    const s = server();
    for (const key of ["show-protected", "show_protected", "showProtected", "--show-protected", "SHOW_PROTECTED"]) {
      for (const [tool, args] of [
        ["sl_run", { source: "warehouse", sql: "select 1" }],
        ["sl_goldens", { positionals: ["run"], name: "g" }],
      ] as const) {
        const r = await call(s, tool, { ...args, [key]: true });
        expect(r.result).toBeUndefined();
        expect(r.error.code).toBe(INVALID_PARAMS);
        expect(r.error.message).toContain(`"${key}" asks for --show-protected`);
        expect(r.error.message).toContain("invariant 3");
        expect(r.error.message).toContain(`Call ${tool} again without it.`);
      }
    }
    // Refused for every role, before the role check.
    const g = await call(server("golden_builder"), "sl_status", { show_protected: false });
    expect(g.error.message).toContain("invariant 3");
  });

  test("a positional that reads --show-protected stays a value after --, never a flag", async () => {
    const spec = (await COMMANDS.goldens!()).default;
    const argv = argvOf("goldens", spec, { positionals: ["run", "--show-protected"] }, t.root);
    expect(argv.indexOf("--show-protected")).toBeGreaterThan(argv.indexOf("--"));
  });

  test("a positional that reads --show-protected is refused as invariant 3, with no role hint", async () => {
    for (const role of [undefined, "golden_builder"] as const) {
      for (const positionals of [["--show-protected"], ["run", "--show-protected=1"]]) {
        const r = await call(server(role), "sl_goldens", { positionals });
        expect(r.error.code).toBe(INVALID_PARAMS);
        expect(r.error.message).toContain('a positional in "positionals" asks for --show-protected');
        expect(r.error.message).toContain("invariant 3");
        expect(r.error.message).not.toContain("--role");
      }
    }
  });
});

describe("--role", () => {
  test("the default, the interviewer, lists every command; the others only their own", async () => {
    const all = Object.keys(COMMANDS).map(toolName).sort();
    expect((await listed(server())).map((x) => x.name).sort()).toEqual(all);
    expect((await listed(server("interviewer"))).map((x) => x.name).sort()).toEqual(all);
    for (const [role, tools] of Object.entries(EXPECTED)) {
      const got = await listed(server(role as RoleName));
      expect(`${role}: ${got.map((x) => x.name).sort().join(",")}`).toBe(`${role}: ${[...tools].sort().join(",")}`);
      for (const tool of got) expect(tool.description).toContain(`(--role ${role}) and accepts only`);
    }
    const golden = (await listed(server("golden_builder"))).find((x) => x.name === "sl_goldens")!;
    expect(golden.description).toContain("accepts only sl goldens new, sl goldens run, sl goldens check, sl sql.");
  });

  test("initialize says which role the server runs as", async () => {
    const init = (s: Server) => request(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } });
    expect((await init(server())).result.instructions).toContain("Start with sl_status");
    expect((await init(server("batch_analyst"))).result.instructions).toContain("runs as the batch analyst and serves only sl brief");
  });

  test("a call outside the role is refused with a plain error naming the role and --role, and nothing runs", async () => {
    for (const role of Object.keys(EXPECTED) as RoleName[]) {
      const r = await call(server(role), "sl_status");
      expect(r.error.code).toBe(INVALID_PARAMS);
      expect(r.error.message).toContain(`sl_status refused: this server runs as the`);
      expect(r.error.message).toContain(`(--role ${role})`);
      expect(r.error.message).toContain("may not run sl status");
      expect(r.error.message).toContain("start the server again with --role <role>");
    }
  });

  test("owner commands are the interviewer's only; a subcommand outside the role is refused", async () => {
    for (const role of Object.keys(EXPECTED) as RoleName[]) {
      for (const [tool, args] of [
        ["sl_reply", { readback: "000000000000", item: "1", text: "yes", verdict: "yes", by: "Test Owner" }],
        ["sl_approve", { target: "warehouse.orders" }],
        ["sl_goldens", { positionals: ["confirm"], name: "g" }],
      ] as const) {
        const r = await call(server(role), tool, args);
        expect(`${role} ${tool}: ${r.error?.code}`).toBe(`${role} ${tool}: ${INVALID_PARAMS}`);
        expect(r.error.message).toContain("only the interviewer");
      }
    }
    const golden = server("golden_builder");
    expect((await call(golden, "sl_goldens", { positionals: ["list"] })).error.message).toContain("may not run sl goldens list");
    expect((await call(golden, "sl_goldens", { positionals: ["--help", "confirm"] })).error.message).toContain("needs its subcommand");
    expect((await call(server("connector_runner"), "sl_results", { plan: "abc" })).error.message).toContain("needs its subcommand");
  });

  test("a call the role runs reaches the command", async () => {
    const golden = await call(server("golden_builder"), "sl_goldens", { positionals: ["check"] });
    expect(golden.error).toBeUndefined();
    expect(golden.result.content[0].type).toBe("text");
    const runner = await call(server("connector_runner"), "sl_results", { positionals: ["status"], plan: "000000000000" });
    expect(runner.error).toBeUndefined();
    expect(runner.result.isError).toBe(true); // no such plan: the command's own plain error
    const verifier = await call(server("readback_verifier"), "sl_readback", { targets: ["warehouse.nope"] });
    expect(verifier.error).toBeUndefined();
    const reply = await call(server(), "sl_reply", { readback: "000000000000", item: "1", text: "no", verdict: "no", by: "Test Owner" });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true); // no such readback: the command's own plain error
  });

  test("a role that is not one of lib/roles.ts exits 1 with the usage; --help names --role", () => {
    const bad = Bun.spawnSync(["bun", SERVER, "--root", t.root, "--role", "owner"], { stdin: "ignore" });
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout.toString()).toBe("");
    expect(bad.stderr.toString()).toContain(`--role is one of ${ROLE_NAMES.join(", ")}, not "owner".`);
    const help = Bun.spawnSync(["bun", SERVER, "--help"], { stdin: "ignore" });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("[--role <role>]");
    expect(help.stdout.toString()).toContain("No tool takes --show-protected.");
  });

  test("the flag reaches a server process: tools/list and the startup log reflect it", async () => {
    const proc = Bun.spawn(["bun", SERVER, "--root", t.root, "--role", "readback_verifier"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect((JSON.parse(out.trim()).result.tools as Msg[]).map((x) => x.name)).toEqual(["sl_readback"]);
    expect(await new Response(proc.stderr).text()).toContain("as the readback verifier");
  });
});

describe("the plugin's MCP hook", () => {
  const PLUGIN_TOOL = (tool: string) => `mcp__plugin_semantic-layer-builder_semantic-layer__${tool}`;
  const hook = (tool: string, agent: string | undefined, input: unknown = {}) =>
    checkMcpCall(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...(agent ? { agent_type: agent } : {}) }));

  test("reads the command from the tool name, whatever the server is called", () => {
    expect(commandOfTool(PLUGIN_TOOL("sl_check_join"))).toBe("check-join");
    expect(commandOfTool("mcp__semantic-layer__sl_status")).toBe("status");
    expect(commandOfTool("mcp__semantic-layer__sl_nope")).toBeUndefined();
  });

  test("holds each role agent to its role, with or without the plugin prefix", () => {
    const runner = "semantic-layer-builder:sl-connector-runner";
    const refused = hook(PLUGIN_TOOL("sl_reply"), runner, { readback: "abc", item: "1", verdict: "yes" });
    expect(refused.allow).toBe(false);
    expect(refused.message).toContain(`refused ${PLUGIN_TOOL("sl_reply")} for the connector runner (sl-connector-runner)`);
    expect(refused.message).toContain("only the interviewer");
    expect(refused.message).toContain("the connector runner may run sl results add, sl results status.");
    expect(refused.message).not.toContain("It may run");
    expect(hook(PLUGIN_TOOL("sl_status"), "sl-connector-runner").allow).toBe(false);
    expect(hook(PLUGIN_TOOL("sl_results"), runner, { positionals: ["add"], plan: "abc" }).allow).toBe(true);
    expect(hook(PLUGIN_TOOL("sl_goldens"), "sl-golden-builder", { positionals: ["confirm"] }).allow).toBe(false);
    expect(hook(PLUGIN_TOOL("sl_goldens"), "sl-golden-builder", { positionals: ["run"] }).allow).toBe(true);
    expect(hook(PLUGIN_TOOL("sl_approve"), "semantic-layer-builder:sl-interviewer").allow).toBe(true);
  });

  test("names the role's commands once, and odd tool_input shapes do not open a role's limits", () => {
    const status = hook(PLUGIN_TOOL("sl_status"), "sl-golden-builder");
    expect(status.message!.split("sl goldens new, sl goldens run, sl goldens check, sl sql").length - 1).toBe(1);
    for (const input of ["confirm", null, { positionals: "confirm" }]) expect(hook(PLUGIN_TOOL("sl_goldens"), "sl-golden-builder", input).allow).toBe(false);
    expect(hook(PLUGIN_TOOL("sl_approve"), "sl-readback-verifier", null).allow).toBe(false);
    expect(hook(PLUGIN_TOOL("sl_readback"), "sl-batch-analyst").allow).toBe(false);
    expect(hook(PLUGIN_TOOL("sl_goldens"), "sl-golden-builder", { positionals: ["--show-protected"] }).message).toContain("invariant 3");
  });

  test("refuses --show-protected from every caller; leaves other agents and other tools alone", () => {
    for (const agent of [undefined, "sl-interviewer", "general-purpose"]) {
      const v = hook(PLUGIN_TOOL("sl_run"), agent, { source: "warehouse", show_protected: true });
      expect(v.allow).toBe(false);
      expect(v.message).toContain("invariant 3");
    }
    expect(hook(PLUGIN_TOOL("sl_approve"), undefined)).toEqual({ allow: true });
    expect(hook(PLUGIN_TOOL("sl_approve"), "general-purpose")).toEqual({ allow: true });
    expect(hook("mcp__warehouse__query", "sl-connector-runner", { show_protected: true })).toEqual({ allow: true });
    expect(checkMcpCall("not json").allow).toBe(true);
  });
});

describe("the docs", () => {
  const flat = (p: string) => readFileSync(join(REPO, p), "utf8").replace(/\s+/g, " ");

  test("the spec's MCP server section documents --role and the --show-protected refusal", () => {
    const spec = flat("skills/semantic-layer/references/spec.md");
    const section = spec.slice(spec.indexOf("## MCP server"), spec.indexOf("## CLI"));
    expect(section).toContain("`bun skills/semantic-layer/scripts/mcp/server.ts [--root <dir>] [--role <role>]`");
    expect(section).toContain("refused before the role and argument checks with error `-32602` naming invariant 3");
    for (const role of ROLE_NAMES) expect(section).toContain(`\`${role}\``);
    expect(section).toContain("`mcpServers` registers one MCP server, `semantic-layer`");
    expect(section).toContain("`bun scripts/mcp/guard.ts`");
  });

  test("docs/plugin.md says the plugin starts the server as the interviewer and how to pick a role", () => {
    const doc = flat("docs/plugin.md");
    expect(doc).toContain("The plugin starts the MCP server as the interviewer");
    expect(doc).toContain("--role golden_builder");
    expect(doc).toContain("Keep `semantic-layer` in the name of a server you add by hand");
    expect(doc).toContain("`skills/semantic-layer/scripts/mcp/guard.ts`");
  });
});

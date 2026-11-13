import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { ROLES } from "../skills/semantic-layer/scripts/lib/roles.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { tempDir } from "./helpers.ts";

// The Claude Code plugin as a package (spec: Claude Code plugin; docs/plugin.md): its manifests, the
// paths and hook commands they name, the agents, the hooks and the MCP server run from a copy of the
// plugin's files as Claude Code installs it, and, with the claude CLI on PATH, Claude Code's own checks.

const REPO = join(import.meta.dir, "..");
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(join(REPO, path), "utf8")) as Json;
const text = (path: string): string => readFileSync(join(REPO, path), "utf8");

const plugin = readJson(".claude-plugin/plugin.json");
const market = readJson(".claude-plugin/marketplace.json");
const entries = market.plugins as Json[];

// The fields Claude Code reads (code.claude.com/docs/en/plugins/manifest-reference, marketplace-reference).
const PLUGIN_FIELDS = [
  "$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords",
  "metadata", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "defaultEnabled",
  "dependencies", "settings", "userConfig", "types", "channels", "skills", "commands", "agents", "hooks", "mcpServers",
  "lspServers", "outputStyles", "workflows", "experimental",
];
const MARKET_FIELDS = ["$schema", "name", "owner", "plugins", "description", "version", "metadata", "forceRemoveDeletedPlugins", "allowCrossMarketplaceDependenciesOn", "renames"];
const LISTING_ONLY = ["icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"];
const ENTRY_FIELDS = [
  "name", "source", "description", "version", "category", "tags", "strict", "relevance", "dependencies", "defaultEnabled",
  "displayName", "metadata", "headers", "headersHelper", ...PLUGIN_FIELDS.filter((f) => !LISTING_ONLY.includes(f) && f !== "$schema"),
];
const COMPONENT_KEYS = ["skills", "commands", "agents", "outputStyles", "workflows", "lspServers", "mcpServers"];
const HOOK_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
// The PreToolUse matcher of the MCP hook, and the names Claude Code gives the plugin server's tools.
const MCP_MATCHER = "mcp__.*semantic-layer.*__sl_.*";
const MCP_TOOL = (tool: string) => `mcp__plugin_semantic-layer-builder_semantic-layer__${tool}`;
const INSTALL = "bun install --frozen-lockfile --production";
const PLUGIN_ID = `${String(entries[0]?.name)}@${String(market.name)}`;

interface HookCommand {
  event: string;
  matcher: string | undefined;
  command: string;
  timeout: unknown;
}
function hookCommands(): HookCommand[] {
  const out: HookCommand[] = [];
  for (const [event, groups] of Object.entries((plugin.hooks ?? {}) as Record<string, Json[]>)) {
    for (const g of groups) {
      for (const h of g.hooks as Json[]) {
        expect(h.type).toBe("command");
        out.push({ event, matcher: g.matcher as string | undefined, command: String(h.command), timeout: h.timeout });
      }
    }
  }
  return out;
}
// The script a hook command runs: the quoted ${CLAUDE_PLUGIN_ROOT}/... argument, relative to the plugin root.
function hookScript(command: string): string {
  const m = /^(?:bun|sh) "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"$`\\]+)"$/.exec(command);
  if (!m) throw new Error(`hook command ${command} is not bun or sh with one quoted \${CLAUDE_PLUGIN_ROOT}/<script> argument`);
  return m[1]!;
}
const hookFor = (event: string): HookCommand => {
  const h = hookCommands().find((x) => x.event === event);
  if (!h) throw new Error(`plugin.json registers no ${event} hook`);
  return h;
};

function frontmatter(path: string): Json {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
  if (!m) throw new Error(`${path} has no frontmatter`);
  return parseYamlText(m[1]!, path) as Json;
}

// The files a clone of the repository holds, which is what Claude Code copies into its plugin cache.
function packageFiles(): string[] {
  const r = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().split("\0").filter((f) => f && existsSync(join(REPO, f)) && statSync(join(REPO, f)).isFile());
}

describe("the manifests", () => {
  test("plugin.json has only documented fields, a kebab-case name, a version and its metadata", () => {
    for (const k of Object.keys(plugin)) expect(PLUGIN_FIELDS).toContain(k);
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(plugin.description).length).toBeGreaterThan(40);
    expect((plugin.author as Json).name).toBeTruthy();
    for (const url of [plugin.homepage, plugin.repository, (plugin.author as Json).url]) expect(new URL(String(url)).protocol).toBe("https:");
    expect(plugin.license).toBe("MIT");
    expect(text("LICENSE").startsWith("MIT License")).toBe(true);
    const keywords = plugin.keywords as string[];
    expect(keywords.length).toBeGreaterThan(0);
    expect(new Set(keywords).size).toBe(keywords.length);
    for (const k of keywords) expect(k).toMatch(/^[a-z0-9-]+$/);
  });

  test("the plugin's version is the packages' and the MCP server's", () => {
    expect(readJson("package.json").version).toBe(plugin.version);
    expect(readJson("skills/semantic-layer/package.json").version).toBe(plugin.version);
    const info = /const SERVER_INFO = \{[^}]*version: "([^"]+)"/.exec(text("skills/semantic-layer/scripts/mcp/server.ts"));
    expect(info?.[1]).toBe(String(plugin.version));
  });

  test("marketplace.json has only documented fields and lists this plugin at the marketplace root", () => {
    for (const k of Object.keys(market)) expect(MARKET_FIELDS).toContain(k);
    expect(market.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(String(market.name)).not.toMatch(/claude|anthropic|official/i);
    expect((market.owner as Json).name).toBeTruthy();
    expect(String(market.description).length).toBeGreaterThan(20);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    for (const k of Object.keys(entry)) expect(ENTRY_FIELDS).toContain(k);
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe("./");
    expect(entry.version).toBeUndefined(); // plugin.json's version is the one Claude Code reads
    expect(existsSync(join(REPO, String(entry.source), ".claude-plugin", "plugin.json"))).toBe(true);
    expect(String(entry.description).length).toBeGreaterThan(20);
  });

  test("every path they name starts with ./, stays inside the plugin root and exists", () => {
    const paths: string[] = [String(entries[0]!.source)];
    for (const k of COMPONENT_KEYS) {
      const v = plugin[k];
      if (typeof v === "string") paths.push(v);
      else if (Array.isArray(v)) paths.push(...v.filter((x): x is string => typeof x === "string"));
    }
    for (const h of hookCommands()) paths.push(`./${hookScript(h.command)}`);
    expect(paths.length).toBeGreaterThan(2);
    for (const p of paths) {
      expect(p.startsWith("./")).toBe(true);
      expect(p.split("/")).not.toContain("..");
      const abs = resolve(REPO, p);
      expect(abs === REPO || abs.startsWith(REPO + sep)).toBe(true);
      expect(existsSync(abs)).toBe(true);
    }
  });
});

describe("what Claude Code discovers", () => {
  test("the one skill, skills/semantic-layer/SKILL.md, from the default skills/ directory", () => {
    expect(plugin.skills).toBeUndefined();
    const skills = readdirSync(join(REPO, "skills")).filter((d) => existsSync(join(REPO, "skills", d, "SKILL.md")));
    expect(skills).toEqual(["semantic-layer"]);
    const front = frontmatter(join(REPO, "skills", "semantic-layer", "SKILL.md"));
    expect(front.name).toBe("semantic-layer");
    expect(String(front.description).length).toBeGreaterThan(40);
  });

  test("every agents/*.md, from the default agents/ directory: one per role, named after its file", () => {
    // An "agents" key would replace the default scan, so every file must then be listed.
    const files = readdirSync(join(REPO, "agents")).filter((f) => f.endsWith(".md")).sort();
    const listed = plugin.agents === undefined ? files : (plugin.agents as string[]).map((p) => p.replace(/^\.\/agents\//, ""));
    expect([...listed].sort()).toEqual(files);
    expect(files).toEqual(Object.values(ROLES).map((r) => `${r.agent}.md`).sort());
    for (const f of files) expect(frontmatter(join(REPO, "agents", f)).name).toBe(f.replace(/\.md$/, ""));
  });

  test("the PreToolUse hooks cover the edit tools and Bash, and the MCP server's tools; the SessionStart hook has no matcher", () => {
    const pre = hookFor("PreToolUse");
    expect(new Set(String(pre.matcher).split("|"))).toEqual(new Set(HOOK_TOOLS));
    expect(hookScript(pre.command)).toBe("skills/semantic-layer/scripts/hooks/guard-edits.ts");
    const pres = hookCommands().filter((h) => h.event === "PreToolUse");
    expect(pres.length).toBe(2);
    expect(pres[1]!.matcher).toBe(MCP_MATCHER);
    expect(hookScript(pres[1]!.command)).toBe("skills/semantic-layer/scripts/mcp/guard.ts");
    const matches = (name: string) => new RegExp(`^(?:${MCP_MATCHER})$`).test(name);
    expect(matches(MCP_TOOL("sl_reply"))).toBe(true);
    expect(matches("mcp__semantic-layer__sl_status")).toBe(true); // the server added by hand as docs/plugin.md shows
    for (const t of [...HOOK_TOOLS, "mcp__warehouse__query", "mcp__semantic-layer__other"]) expect(matches(t)).toBe(false);
    const start = hookFor("SessionStart");
    expect(start.matcher).toBeUndefined();
    expect(hookScript(start.command)).toBe("skills/semantic-layer/scripts/hooks/check-install.sh");
    expect(Object.keys(plugin.hooks as Json).sort()).toEqual(["PreToolUse", "SessionStart"]);
    for (const h of hookCommands()) {
      expect(typeof h.timeout).toBe("number");
      expect(h.command).not.toContain("${user_config");
      expect(statSync(join(REPO, hookScript(h.command))).isFile()).toBe(true);
    }
  });

  test("one MCP server is registered in plugin.json, the server as the interviewer, and no .mcp.json", () => {
    expect(plugin.mcpServers).toEqual({
      "semantic-layer": { command: "bun", args: [`${ROOT_VAR}/skills/semantic-layer/scripts/mcp/server.ts`, "--role", ROLES.interviewer.name] },
    });
    expect(existsSync(join(REPO, ".mcp.json"))).toBe(false);
    expect(entries[0]!.mcpServers).toBeUndefined();
  });
});

describe("the package's files", () => {
  const files = packageFiles();
  const isText = (f: string) => !/\.(parquet|duckdb|png|jpg|gz)$/.test(f);

  test("name no absolute path from this machine", () => {
    const home = homedir();
    const machine = [REPO, realpathSync(REPO), ...(home.length > 1 ? [home + sep] : [])];
    const generic = /(?:^|[\s"'`(=:])(?:\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|\/root\/|[A-Za-z]:\\Users\\)/;
    const found: string[] = [];
    expect(files.length).toBeGreaterThan(50);
    for (const f of files.filter(isText)) {
      const body = readFileSync(join(REPO, f), "utf8");
      if (body.includes("\0")) continue;
      if (machine.some((p) => body.includes(p)) || generic.test(body)) found.push(f);
    }
    expect(found).toEqual([]);
  });

  test("hold no credential, outside tests/, evals/ and fixtures/", () => {
    // The plugin's copy holds every file, examples/ connection configs, scripts/ and .github/ included.
    // tests/, evals/ and fixtures/ hold synthetic credentials on purpose, to test that they are refused
    // and redacted; the plugin loads none of them. CI's throwaway Postgres service is postgres:postgres.
    // Placeholders such as user:...@ are not credentials.
    const shipped = files.filter((f) => isText(f) && !/^(tests|evals|fixtures)\//.test(f));
    for (const f of [".claude-plugin/plugin.json", "agents/sl-interviewer.md", ".github/workflows/ci.yml", "scripts/verify.sh"]) expect(shipped).toContain(f);
    expect(shipped.some((f) => /^examples\/[^/]+\/semantic\/sources\/[^/]+\.yaml$/.test(f))).toBe(true);
    const tokens = /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/;
    const urlCredential = /[a-z][a-z0-9+.-]*:\/\/([^\s/'"`@:]+):([^\s/'"`@]+)@/g;
    const placeholder = /^(?:\.\.\.|\*+|<[^>]*>|\$\{?[A-Z_]+\}?|\[redacted\])$/;
    const ciService = (f: string, user: string, pass: string) => f === ".github/workflows/ci.yml" && user === "postgres" && pass === "postgres";
    const found: string[] = [];
    for (const f of shipped) {
      const body = readFileSync(join(REPO, f), "utf8");
      if (tokens.test(body)) found.push(`${f}: a token`);
      for (const m of body.matchAll(urlCredential)) {
        if (!placeholder.test(m[2]!) && !ciService(f, m[1]!, m[2]!)) found.push(`${f}: a URL with a password`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("the docs", () => {
  const docs = ["README.md", "docs/plugin.md"].map((d) => [d, text(d)] as const);

  test("show the install with this marketplace's and plugin's names, and the hook's install command", () => {
    const repo = new URL(String(plugin.repository)).pathname.slice(1);
    for (const [, body] of docs) {
      expect(body).toContain(`claude plugin marketplace add ${repo}`);
      expect(body).toContain(`claude plugin install ${PLUGIN_ID}`);
      expect(body).toContain(`/plugin marketplace add ${repo}`);
      expect(body).toContain(`/plugin install ${PLUGIN_ID}`);
      expect(body).toContain(`cd "<plugin root>" && ${INSTALL}`);
      expect(body).toContain(`claude plugin details ${String(plugin.name)}`);
      expect(body).toContain(`claude --agent ${String(plugin.name)}:${ROLES.interviewer.agent}`);
    }
    expect(text("skills/semantic-layer/scripts/hooks/check-install.sh")).toContain(INSTALL);
  });

  test("name every agent the plugin ships, and only those", () => {
    const agents = Object.values(ROLES).map((r) => r.agent);
    for (const [name, body] of docs) {
      const named = new Set([...body.matchAll(/\bsl-[a-z]+(?:-[a-z]+)*/g)].map((m) => m[0]));
      for (const a of agents) expect(`${name}: ${named.has(a)}`).toBe(`${name}: true`);
      for (const a of named) expect(agents).toContain(a);
    }
  });

  test("the MCP server path they give exists in the plugin", () => {
    expect(text("docs/plugin.md")).toContain('bun "<plugin root>/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic"');
    expect(existsSync(join(REPO, "skills", "semantic-layer", "scripts", "mcp", "server.ts"))).toBe(true);
  });
});

// A copy of the package's files in a directory whose name has a space, as Claude Code copies a
// plugin into its cache: no node_modules until the user runs the install the SessionStart hook names.
let dir: string;
let copy: string;
let project: string;
beforeAll(() => {
  dir = tempDir("plugin");
  copy = join(dir, "plugin root");
  project = join(dir, "project");
  for (const f of packageFiles()) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    cpSync(join(REPO, f), join(copy, f));
  }
  mkdirSync(join(project, "semantic"), { recursive: true });
  writeFileSync(join(project, "semantic", "semantic.yaml"), "name: plugintest\n");
});

interface Ran {
  code: number;
  out: string;
  err: string;
}
// Runs a hook command as Claude Code does: through sh, with ${CLAUDE_PLUGIN_ROOT} substituted and exported.
function runHook(command: string, input: string, env: Record<string, string | undefined> = {}): Ran {
  const r = Bun.spawnSync(["sh", "-c", command.replaceAll(ROOT_VAR, copy)], {
    cwd: project,
    stdin: new TextEncoder().encode(input),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: copy, CLAUDE_PROJECT_DIR: project, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const sessionStart = (env: Record<string, string | undefined> = {}) =>
  runHook(hookFor("SessionStart").command, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: project }), env);
function message(r: Ran): string {
  expect(r.code).toBe(0);
  const o = JSON.parse(r.out) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(o.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(o.hookSpecificOutput.additionalContext).toBe(o.systemMessage);
  return o.systemMessage;
}
// PATH without any directory that holds a bun.
const pathWithoutBun = () =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d && !existsSync(join(d, "bun")))
    .join(delimiter);
const installCommand = () => `cd '${copy}' && ${INSTALL}`;

describe("an installed copy of the plugin", () => {
  test("before the install, SessionStart names the exact install command and exits 0", () => {
    const text = message(sessionStart());
    expect(text).toContain(`Run: ${installCommand()}`);
    expect(text).toContain(`bun '${join(copy, "skills", "semantic-layer", "scripts", "sl.ts")}' --help`);
    expect(text).toContain("again after each plugin update");
  });

  test("without bun on PATH, SessionStart says where to get it, then the install command", () => {
    const text = message(sessionStart({ PATH: pathWithoutBun() }));
    expect(text).toContain("bun is not on PATH");
    expect(text).toContain("https://bun.sh");
    expect(text).toContain(installCommand());
  });

  test("with a bun older than 1.4, SessionStart says to upgrade it", () => {
    const fake = join(dir, "old-bun");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "bun"), "#!/bin/sh\necho 1.3.9\n");
    chmodSync(join(fake, "bun"), 0o755);
    const text = message(sessionStart({ PATH: `${fake}${delimiter}${pathWithoutBun()}` }));
    expect(text).toContain("the bun on PATH is 1.3.9");
    expect(text).toContain("bun upgrade");
  });

  test("the command it names installs the dependencies; then SessionStart prints nothing", () => {
    const r = Bun.spawnSync(["sh", "-c", installCommand()], { cwd: project, env: process.env });
    expect(r.exitCode).toBe(0);
    const after = sessionStart();
    expect(after).toEqual({ code: 0, out: "", err: "" });
    const help = Bun.spawnSync(["bun", join(copy, "skills", "semantic-layer", "scripts", "sl.ts"), "--help"], { cwd: project });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Usage: sl <command>");
  }, 180_000);

  test("its PreToolUse hook refuses a write to the ledger and allows a file outside any semantic root", () => {
    const pre = hookFor("PreToolUse").command;
    const call = (file: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file, content: "{}\n" }, cwd: project });
    const refused = runHook(pre, call(join(project, "semantic", ".sl", "ledger.jsonl")));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("ledger");
    const allowed = runHook(pre, call(join(project, "notes.txt")));
    expect(allowed).toEqual({ code: 0, out: "", err: "" });
  }, 30_000);

  test("the MCP server plugin.json registers starts in the project, serves ./semantic as the interviewer, and refuses --show-protected", async () => {
    const def = (plugin.mcpServers as Record<string, { command: string; args: string[] }>)["semantic-layer"]!;
    const server = Bun.spawn([def.command, ...def.args.map((a) => a.replaceAll(ROOT_VAR, copy))], {
      cwd: project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: copy, CLAUDE_PROJECT_DIR: project, SEMANTIC_ROOT: undefined },
    });
    const send = (m: Json) => server.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-test", version: "1" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sl_run", arguments: { source: "x", sql: "select 1", "show-protected": true } } });
    await server.stdin.end();
    const out = await new Response(server.stdout).text();
    expect(await server.exited).toBe(0);
    const byId = new Map((out.trim().split("\n").map((l) => JSON.parse(l)) as Json[]).map((m) => [m.id, m]));
    expect(String((byId.get(1)!.result as Json).instructions)).toContain(join(project, "semantic"));
    const tools = (byId.get(2)!.result as Json).tools as Json[];
    expect(tools.map((t) => t.name)).toContain("sl_approve");
    for (const t of tools) expect(Object.keys((t.inputSchema as Json).properties as Json)).not.toContain("show-protected");
    expect(String((byId.get(3)!.error as Json).message)).toContain("invariant 3");
    expect(await new Response(server.stderr).text()).toContain("as the interviewer");
  }, 60_000);

  test("its MCP hook refuses a role agent's call outside its role and allows the interviewer's", () => {
    const mcpHook = hookCommands().find((h) => h.event === "PreToolUse" && h.matcher === MCP_MATCHER)!.command;
    const call = (tool: string, agent?: string, input: Json = {}) =>
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: MCP_TOOL(tool), tool_input: input, cwd: project, ...(agent ? { agent_type: agent } : {}) });
    const runner = `${String(plugin.name)}:${ROLES.connector_runner.agent}`;
    const refused = runHook(mcpHook, call("sl_reply", runner, { readback: "rb", item: "1", verdict: "yes" }));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("only the interviewer");
    expect(runHook(mcpHook, call("sl_results", runner, { positionals: ["status"], plan: "abc" })).code).toBe(0);
    expect(runHook(mcpHook, call("sl_reply", `${String(plugin.name)}:${ROLES.interviewer.agent}`))).toEqual({ code: 0, out: "", err: "" });
    expect(runHook(mcpHook, call("sl_run", undefined, { show_protected: true })).code).toBe(2);
  }, 30_000);

  test("the MCP server the docs name starts from it and answers initialize, tools/list and a call", async () => {
    const server = Bun.spawn(["bun", join(copy, "skills", "semantic-layer", "scripts", "mcp", "server.ts"), "--root", join(project, "semantic")], {
      cwd: project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (m: Json) => server.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sl_status", arguments: {} } });
    await server.stdin.end();
    const out = await new Response(server.stdout).text();
    expect(await server.exited).toBe(0);
    const byId = new Map((out.trim().split("\n").map((l) => JSON.parse(l)) as Json[]).map((m) => [m.id, m.result as Json]));
    const init = byId.get(1)!;
    expect(init.protocolVersion).toBe("2025-06-18");
    expect((init.serverInfo as Json).version).toBe(plugin.version);
    expect((byId.get(2)!.tools as Json[]).map((t) => t.name)).toContain("sl_status");
    const status = byId.get(3)!;
    expect(status.isError).not.toBe(true);
    expect(JSON.parse(String(((status.content as Json[])[0] as Json).text))).toBeTruthy();
  }, 60_000);
});

// The SessionStart hook alone, in plugin roots that hold only its script and, where named, stub dependencies.
describe("the SessionStart hook's edge cases", () => {
  const HOOK = "skills/semantic-layer/scripts/hooks/check-install.sh";
  const DEPS = ["yaml", "ajv", "@duckdb/node-api"];
  function hookRoot(name: string, deps: string[] = [], under = ""): string {
    const root = join(dir, "edge", name);
    mkdirSync(dirname(join(root, HOOK)), { recursive: true });
    cpSync(join(REPO, HOOK), join(root, HOOK));
    for (const d of deps) {
      mkdirSync(join(root, under, "node_modules", d), { recursive: true });
      writeFileSync(join(root, under, "node_modules", d, "package.json"), "{}");
    }
    return root;
  }
  function withBun(version: string): string {
    const bin = join(dir, "edge", `bun-${version.replace(/[^A-Za-z0-9.-]/g, "_") || "empty"}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho '${version}'\n`);
    chmodSync(join(bin, "bun"), 0o755);
    return `${bin}${delimiter}${pathWithoutBun()}`;
  }
  function run(root: string, PATH = process.env.PATH): Ran {
    const r = Bun.spawnSync(["sh", join(root, HOOK)], { cwd: dir, env: { ...process.env, PATH } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test.each(["1.4.0", "1.4.4", "1.10.0", "2.0.0", "1.4.0-canary.20260101+abc"])("bun %s with the dependencies installed: it prints nothing", (v) => {
    expect(run(hookRoot(`ok-${v}`, DEPS), withBun(v))).toEqual({ code: 0, out: "", err: "" });
  });

  test.each(["1.3.99", "0.9.0", "garbage", ""])("bun %p: it says to upgrade, as valid JSON", (v) => {
    expect(message(run(hookRoot(`old-${v || "empty"}`, DEPS), withBun(v)))).toContain("bun upgrade");
  });

  test("dependencies under the skill's node_modules count as installed; one missing names the install", () => {
    expect(run(hookRoot("skill-deps", DEPS, "skills/semantic-layer"))).toEqual({ code: 0, out: "", err: "" });
    expect(message(run(hookRoot("partial", ["yaml", "ajv"])))).toContain(INSTALL);
  });

  test("for a root with quotes, a backslash, $, a space and control characters, the JSON parses and its cd reaches the root", () => {
    const root = hookRoot(`we'ird "dir" \\ $HOME x\u001b\u0007y`);
    const text = message(run(root));
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    const plain = hookRoot(`we'ird "dir" \\ $HOME x`);
    const cd = /Run: (cd .*?) && bun install/.exec(message(run(plain)))?.[1];
    expect(cd).toBeTruthy();
    const pwd = Bun.spawnSync(["sh", "-c", `${cd!} && pwd`], { cwd: dir });
    expect(pwd.stdout.toString().trim()).toBe(plain);
  });
});

describe("the docs' links", () => {
  test("every relative link in README.md and docs/plugin.md resolves, and each in-page anchor exists", () => {
    const missing: string[] = [];
    for (const doc of ["README.md", "docs/plugin.md"]) {
      const body = text(doc);
      for (const m of body.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (!/^[a-z]+:/.test(m[1]!) && !existsSync(join(REPO, dirname(doc), m[1]!))) missing.push(`${doc}: ${m[1]!}`);
      }
      const slugs = [...body.matchAll(/^#+ (.+)$/gm)].map((h) => h[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
      for (const m of body.matchAll(/\]\(#([^)]+)\)/g)) if (!slugs.includes(m[1]!)) missing.push(`${doc}: #${m[1]!}`);
    }
    expect(missing).toEqual([]);
  });
});

// Claude Code's own checks, when its CLI is installed (CI does not install it).
const claude = Bun.which("claude");
const why = claude ? "" : " (skipped: the claude CLI is not on PATH)";
function runClaude(args: string[], timeout = 60_000): Ran {
  // A fresh HOME, so the user's own plugins and settings neither change the result nor change.
  const home = mkdtempSync(join(dir, "home-"));
  const r = Bun.spawnSync([claude!, ...args], { cwd: dir, env: { ...process.env, HOME: home }, timeout });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe(`Claude Code's checks${why}`, () => {
  test.skipIf(!claude)("claude plugin validate --strict passes on the marketplace and the plugin manifest", () => {
    for (const target of [copy, join(copy, ".claude-plugin", "plugin.json")]) {
      const r = runClaude(["plugin", "validate", "--strict", target]);
      expect(`${target}: ${r.code}\n${r.out}${r.err}`).toContain(`${target}: 0`);
      expect(r.out).toContain("Validation passed");
    }
  }, 120_000);

  test.skipIf(!claude)("claude plugin details lists the skill, the five agents, both hooks and the MCP server", () => {
    const r = runClaude(["--plugin-dir", copy, "plugin", "details", String(plugin.name)]);
    expect(r.code).toBe(0);
    const flat = r.out.replace(/[ \t]+/g, " ");
    expect(flat).toContain(`${String(plugin.name)} ${String(plugin.version)}`);
    expect(flat).toContain("Skills (1) semantic-layer");
    const agents = /Agents \(5\) ([^\n]+)/.exec(flat)?.[1]?.split(", ").map((a) => a.trim()).sort();
    expect(agents).toEqual(Object.values(ROLES).map((x) => x.agent).sort());
    expect(flat).toMatch(/Hooks \(2\) PreToolUse, SessionStart/);
    expect(flat).toContain("MCP servers (1) semantic-layer");
  }, 120_000);

  test.skipIf(!claude)("every claude command the docs show exists", () => {
    const shown = new Set<string>();
    for (const d of ["README.md", "docs/plugin.md", "CONTRIBUTING.md"]) {
      for (const m of text(d).matchAll(/\bclaude ((?:plugin|mcp) (?:marketplace )?[a-z]+)/g)) shown.add(m[1]!);
    }
    expect([...shown].sort()).toEqual(
      ["mcp add", "mcp remove", "plugin details", "plugin install", "plugin list", "plugin marketplace add", "plugin validate"].sort(),
    );
    for (const s of shown) {
      const r = runClaude([...s.split(" "), "--help"]);
      expect(`${s}: ${r.code}`).toBe(`${s}: 0`);
    }
    const help = runClaude(["--help"]).out;
    for (const flag of ["--agent <agent>", "--plugin-dir <path>"]) expect(help).toContain(flag);
  }, 180_000);
});

// The MCP server (PRD FR-7.1): every sl command as a tool, spoken to as a subprocess over stdio.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { argvOf, inputSchema, schemaValidator, toolName } from "../skills/semantic-layer/scripts/mcp/schema.ts";
import { PROTOCOL_VERSION } from "../skills/semantic-layer/scripts/mcp/server.ts";
import { FIXED_NOW, sl, tempRoot } from "./helpers.ts";

const SERVER = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "mcp", "server.ts");
const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

type Msg = Record<string, any>;

// A client for one server process: sends a message per line and reads one response per line.
class Client {
  readonly proc;
  readonly lines: string[] = [];
  private waiting = new Map<number | string | null, (m: Msg) => void>();
  private buffer = "";
  private nextId = 1;
  private reading: Promise<void>;

  constructor(args: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
    this.proc = Bun.spawn(["bun", SERVER, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env, SL_NOW: FIXED_NOW, ...env },
    });
    this.reading = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.lines.push(line);
        const msg = JSON.parse(line) as Msg;
        const done = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        done?.(msg);
      }
    }
  }

  send(raw: string): void {
    this.proc.stdin.write(`${raw}\n`);
    this.proc.stdin.flush();
  }

  // Sends a raw line and waits for the response carrying `id`.
  rawRequest(raw: string, id: number | string | null): Promise<Msg> {
    const p = new Promise<Msg>((done) => this.waiting.set(id, done));
    this.send(raw);
    return p;
  }

  request(method: string, params?: unknown): Promise<Msg> {
    const id = this.nextId++;
    return this.rawRequest(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), id);
  }

  notify(method: string, params?: unknown): void {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  call(name: string, args?: Record<string, unknown>): Promise<Msg> {
    return this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
  }

  async close(): Promise<{ code: number; stderr: string }> {
    this.proc.stdin.end();
    const code = await this.proc.exited;
    await this.reading;
    return { code, stderr: await new Response(this.proc.stderr).text() };
  }
}

const t = tempRoot();
let client: Client;

beforeAll(async () => {
  cpSync(ACME, t.root, { recursive: true });
  client = new Client(["--root", t.root]);
});

afterAll(async () => {
  await client.close();
  t.cleanup();
});

describe("the handshake", () => {
  test("initialize answers with the protocol version, the tools capability and the server info", async () => {
    const r = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(r.error).toBeUndefined();
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.serverInfo).toMatchObject({ name: "semantic-layer", version: "0.1.0" });
    expect(r.result.instructions).toContain("sl_status");
  });

  test("an unknown protocol version is answered with the server's own", async () => {
    const r = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } });
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });

  test("notifications/initialized gets no response; ping answers an empty result", async () => {
    const before = client.lines.length;
    client.notify("notifications/initialized");
    const r = await client.request("ping");
    expect(r.result).toEqual({});
    // The only line written since is the ping's response.
    expect(client.lines.slice(before).map((l) => JSON.parse(l).id)).toEqual([r.id]);
  });
});

describe("tools/list", () => {
  test("lists one tool per discovered command, each with a valid input schema", async () => {
    const r = await client.request("tools/list");
    const tools = r.result.tools as { name: string; description: string; inputSchema: Msg }[];
    expect(tools.map((x) => x.name).sort()).toEqual(Object.keys(COMMANDS).map(toolName).sort());
    const ajv = schemaValidator();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^sl_[a-z0-9_]+$/);
      expect(tool.description).toContain("Usage: sl ");
      expect(tool.inputSchema.type).toBe("object");
      expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
    }
    const status = tools.find((x) => x.name === "sl_status")!;
    expect(Object.keys(status.inputSchema.properties).sort()).toEqual(["root", "source"]);
    expect(status.inputSchema.additionalProperties).toBe(false);
    const goldens = tools.find((x) => x.name === "sl_goldens")!.inputSchema;
    expect(goldens.properties.positionals).toEqual(expect.objectContaining({ type: "array", items: { type: "string" } }));
    expect(tools.find((x) => x.name === "sl_check_join")).toBeDefined();
  });

  test("a command's flags map to strings, booleans and arrays for repeatable flags", async () => {
    const scope = inputSchema((await COMMANDS.scope!()).default);
    expect(scope.properties!.source).toMatchObject({ type: "string" });
    expect(scope.properties!.write).toMatchObject({ type: "boolean" });
    expect(scope.properties!.include).toMatchObject({ type: "array", items: { type: "string" } });
    expect(scope.properties!.positionals).toBeUndefined();
  });

  test("no command takes a flag named like an argument the server adds", async () => {
    for (const load of Object.values(COMMANDS)) {
      const options = Object.keys((await load()).default.options);
      for (const reserved of ["root", "json", "help", "positionals"]) expect(options).not.toContain(reserved);
    }
  });
});

describe("tools/call", () => {
  test("sl_status returns the same JSON as `sl status --json`", async () => {
    const r = await client.call("sl_status", {});
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content).toHaveLength(1);
    expect(r.result.content[0].type).toBe("text");
    const cli = await sl(t.root, ["status", "--json"]);
    expect(cli.code).toBe(0);
    expect(JSON.parse(r.result.content[0].text)).toEqual(cli.json());
    expect(r.result.content[0].text).toBe(cli.out);
  });

  test("flags and positionals reach the command; missing arguments mean none", async () => {
    const bySource = await client.call("sl_status", { source: "lake" });
    expect(bySource.result.content[0].text).toBe((await sl(t.root, ["status", "--source", "lake", "--json"])).out);
    const noArgs = await client.call("sl_validate");
    expect(noArgs.result.content[0].text).toBe((await sl(t.root, ["validate", "--json"])).out);
    const goldens = await client.call("sl_goldens", { positionals: ["check"], name: "revenue_2025", source: "warehouse" });
    const cli = await sl(t.root, ["goldens", "check", "--name", "revenue_2025", "--source", "warehouse", "--json"]);
    expect(goldens.result.content.map((c: Msg) => c.text).join("\n")).toBe([cli.out, cli.err].filter(Boolean).join("\n"));
    expect(goldens.result.isError === true).toBe(cli.code !== 0);
  });

  test("a non-zero exit returns isError with the plain error text", async () => {
    const r = await client.call("sl_status", { source: "nope" });
    const cli = await sl(t.root, ["status", "--source", "nope", "--json"]);
    expect(cli.code).not.toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content.map((c: Msg) => c.text).join("\n")).toBe([cli.out, cli.err].filter(Boolean).join("\n"));
    expect(r.result.content.at(-1).text).toStartWith("sl status: ");
  });

  test("approve behaves as the CLI: refused without the owner's recorded yes, and nothing is written", async () => {
    const before = readFileSync(join(t.root, "access.yaml"), "utf8");
    const r = await client.call("sl_approve", { target: "access", by: "Dana" });
    const cli = await sl(t.root, ["approve", "--target", "access", "--by", "Dana", "--json"]);
    expect(r.result.isError === true).toBe(cli.code !== 0);
    expect(r.result.content.map((c: Msg) => c.text).join("\n")).toBe([cli.out, cli.err].filter(Boolean).join("\n"));
    expect(readFileSync(join(t.root, "access.yaml"), "utf8")).toBe(before);
  });

  test("an argument value that looks like a flag stays a value", async () => {
    const r = await client.call("sl_status", { source: "--root=/" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content.at(-1).text).toContain("--root=/");
    const spec = (await COMMANDS.set!()).default;
    expect(argvOf("set", spec, { positionals: ["--root=/", "x"], unset: true }, "/r")).toEqual([
      "set",
      "--unset",
      "--json",
      "--root=/r",
      "--",
      "--root=/",
      "x",
    ]);
  });
});

describe("errors", () => {
  test("an unknown tool is a JSON-RPC invalid-params error", async () => {
    const r = await client.call("sl_frobnicate", {});
    expect(r.result).toBeUndefined();
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toBe('Unknown tool "sl_frobnicate". Call tools/list for the tools.');
  });

  test("bad arguments are JSON-RPC invalid-params errors naming the argument", async () => {
    const wrongType = await client.call("sl_status", { source: 5 });
    expect(wrongType.error.code).toBe(-32602);
    expect(wrongType.error.message).toContain('"source" must be string');
    const unknown = await client.call("sl_status", { bogus: "x" });
    expect(unknown.error.code).toBe(-32602);
    expect(unknown.error.message).toContain('unknown argument "bogus"');
    const positionals = await client.call("sl_status", { positionals: ["x"] });
    expect(positionals.error.message).toContain('unknown argument "positionals"');
    const notObject = await client.call("sl_status", ["x"] as unknown as Record<string, unknown>);
    expect(notObject.error.code).toBe(-32602);
    const noName = await client.request("tools/call", {});
    expect(noName.error.code).toBe(-32602);
  });

  test("an unknown method, an invalid request and a line that is not JSON get JSON-RPC errors", async () => {
    const method = await client.request("resources/list");
    expect(method.error.code).toBe(-32601);
    expect(method.error.message).toContain("tools/call");
    const invalid = await client.rawRequest(JSON.stringify({ id: 99, method: "ping" }), 99);
    expect(invalid.error.code).toBe(-32600);
    const batch = await client.rawRequest(JSON.stringify([{ jsonrpc: "2.0", id: 98, method: "ping" }]), null);
    expect(batch.error.code).toBe(-32600);
    const parse = await client.rawRequest("{not json", null);
    expect(parse.error.code).toBe(-32700);
    // The server keeps serving after each of them.
    expect((await client.request("ping")).result).toEqual({});
  });

  test("an id that is not a string, a number or null is an invalid request; params that are not an object are invalid params", async () => {
    for (const bad of [true, { a: 1 }, [1]]) {
      const r = await client.rawRequest(JSON.stringify({ jsonrpc: "2.0", id: bad, method: "ping" }), null);
      expect(r.error.code).toBe(-32600);
      expect(r.error.message).toContain('"id" must be a string, a number or null');
    }
    for (const params of ["x", [1], 5, null]) {
      const r = await client.rawRequest(JSON.stringify({ jsonrpc: "2.0", id: "p", method: "initialize", params }), "p");
      expect(r.error.code).toBe(-32602);
    }
    const nullId = await client.rawRequest(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }), null);
    expect(nullId.result).toEqual({});
    const stringId = await client.rawRequest(JSON.stringify({ jsonrpc: "2.0", id: "s", method: "ping" }), "s");
    expect(stringId.result).toEqual({});
  });

  test("json and help are not arguments", async () => {
    expect((await client.call("sl_status", { json: true })).error.code).toBe(-32602);
    expect((await client.call("sl_status", { help: true })).error.code).toBe(-32602);
  });

  test("a tools/call sent as a notification runs nothing", async () => {
    const fresh = tempRoot();
    mkdirSync(fresh.dir, { recursive: true });
    const c = new Client(["--root", fresh.root]);
    try {
      c.notify("tools/call", { name: "sl_init", arguments: { name: "x" } });
      expect((await c.request("ping")).result).toEqual({});
      expect(c.lines.length).toBe(1);
      expect(existsSync(join(fresh.root, "semantic.yaml"))).toBe(false);
    } finally {
      await c.close();
      fresh.cleanup();
    }
  });
});

describe("the semantic root", () => {
  test("a call naming a root outside the server's root is refused and nothing runs", async () => {
    const other = tempRoot();
    try {
      const r = await client.call("sl_init", { name: "elsewhere", root: other.root });
      expect(r.error.code).toBe(-32602);
      expect(r.error.message).toContain(`This server works only in the semantic root ${t.root}`);
      expect(r.error.message).toContain("--root <dir>");
      expect(existsSync(join(other.root, "semantic.yaml"))).toBe(false);
      for (const root of [join(t.root, ".."), join(t.root, "models"), "/"]) {
        expect((await client.call("sl_status", { root })).error.code).toBe(-32602);
      }
    } finally {
      other.cleanup();
    }
  });

  test("naming the server's own root, through a link or not, is accepted", async () => {
    const link = join(t.dir, "link");
    symlinkSync(t.root, link);
    for (const root of [t.root, link]) {
      const r = await client.call("sl_status", { root });
      expect(r.error).toBeUndefined();
      expect(r.result.isError).toBeUndefined();
    }
  });

  test("a relative --root and a relative root argument resolve from the server's working directory; an empty root is refused", async () => {
    const c = new Client(["--root", "semantic"], { SEMANTIC_ROOT: "/nonexistent" }, t.dir);
    try {
      for (const root of ["semantic", t.root, `${t.root}/`, `${t.root}/models/..`]) expect((await c.call("sl_status", { root })).error).toBeUndefined();
      for (const root of ["", `${t.root}/../semantic2`]) expect((await c.call("sl_status", { root })).error.code).toBe(-32602);
    } finally {
      const { stderr } = await c.close();
      expect(stderr).toContain(`serving the semantic root ${t.root} over stdio`);
    }
  });

  test("SEMANTIC_ROOT sets the root when --root is absent", async () => {
    const c = new Client([], { SEMANTIC_ROOT: t.root });
    try {
      const r = await c.call("sl_status", {});
      expect(r.result.content[0].text).toBe((await sl(t.root, ["status", "--json"])).out);
      expect((await c.call("sl_status", { root: t.dir })).error.code).toBe(-32602);
    } finally {
      await c.close();
    }
  });

  test("init through the server writes a new project inside its root", async () => {
    const fresh = tempRoot();
    mkdirSync(fresh.dir, { recursive: true });
    const c = new Client(["--root", fresh.root]);
    try {
      const r = await c.call("sl_init", { name: "fresh" });
      expect(r.result.isError).toBeUndefined();
      expect(existsSync(join(fresh.root, "semantic.yaml"))).toBe(true);
    } finally {
      await c.close();
      fresh.cleanup();
    }
  });
});

describe("stdout", () => {
  test("carries only protocol messages; logs go to stderr", async () => {
    const dir = tempRoot();
    cpSync(ACME, dir.root, { recursive: true });
    // A command that warns: a postgres source whose variable is unset.
    writeFileSync(join(dir.root, "sources", "pg.yaml"), "source: pg\ndialect: postgres\nconnection:\n  env: SL_TEST_UNSET_URL\n");
    const c = new Client(["--root", dir.root], { SL_TEST_UNSET_URL: undefined });
    try {
      await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } });
      c.notify("notifications/initialized");
      await c.request("tools/list");
      await c.call("sl_status", {});
      await c.call("sl_introspect", { source: "pg" });
      await c.call("sl_validate", {});
      await c.call("sl_nope", {});
      const { code, stderr } = await c.close();
      expect(code).toBe(0);
      expect(c.lines.length).toBe(6);
      for (const line of c.lines) {
        const msg = JSON.parse(line);
        expect(msg.jsonrpc).toBe("2.0");
        expect("result" in msg || "error" in msg).toBe(true);
      }
      expect(stderr).toContain(`sl mcp: serving the semantic root ${dir.root} over stdio`);
    } finally {
      dir.cleanup();
    }
  });

  test("a bad startup flag exits 1 with the usage on stderr and nothing on stdout", async () => {
    const proc = Bun.spawnSync(["bun", SERVER, "--bogus"], { stdin: "ignore" });
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.stderr.toString()).toContain("Usage: bun skills/semantic-layer/scripts/mcp/server.ts [--root <dir>]");
  });
});

describe("the docs", () => {
  const repo = join(import.meta.dir, "..");
  const flat = (p: string) => readFileSync(join(repo, p), "utf8").replace(/\s+/g, " ");

  test("the spec documents the server, its protocol version, tool names and root rule", () => {
    const spec = flat("skills/semantic-layer/references/spec.md");
    const section = spec.slice(spec.indexOf("## MCP server"), spec.indexOf("## CLI"));
    expect(section.length).toBeGreaterThan(500);
    expect(section).toContain("`bun skills/semantic-layer/scripts/mcp/server.ts [--root <dir>]`");
    expect(section).toContain(`\`protocolVersion\` \`${PROTOCOL_VERSION}\``);
    expect(section).toContain("named `sl_<command>` with `-` as `_`");
    expect(section).toContain("any other is refused with an invalid-params error naming the server's root, and nothing runs");
    expect(section).toContain("stdout carries only protocol messages");
    expect(section).toContain("a command that prints nothing gives one `text` item");
    expect(section).toContain("so pass absolute paths");
  });

  test("the README shows how to start the server", () => {
    const readme = flat("README.md");
    expect(readme).toContain("### As an MCP server");
    expect(readme).toContain("bun skills/semantic-layer/scripts/mcp/server.ts --root /path/to/semantic");
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.mcp).toBe("bun skills/semantic-layer/scripts/mcp/server.ts");
  });
});

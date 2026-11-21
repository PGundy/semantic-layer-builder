// One writer at a time, and whole-file writes (docs/PRD-hardening.md HR-3; spec: Locking and whole-file
// writes). The acceptance tests spawn real semlayer processes in parallel; the rest hold the lock from a
// live helper process, or leave the lock a dead one would, and run commands against it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { acquireLock, DEFAULT_LOCK_WAIT_MS, lockWaitMs, tempPath, writeFileAtomic } from "../skills/semantic-layer/scripts/lib/lock.ts";
import type { Golden, LedgerEntry, Model, QueryPlan, Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readJson, readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { Server } from "../skills/semantic-layer/scripts/mcp/server.ts";
import { duckdbSource, FIXED_NOW, initProject, semlayer, tempDir as sharedTempDir } from "./helpers.ts";

const SCRIPTS = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts");
const SEMLAYER = join(SCRIPTS, "semlayer.ts");
const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const BUSY = "is writing to this semantic layer";
const WHO = { command: "test", started: FIXED_NOW };

const temps: string[] = [];
const procs: { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }[] = [];
let helpers = "";

beforeAll(() => {
  helpers = sharedTempDir("lock-helpers");
  temps.push(helpers);
  const lib = JSON.stringify(join(SCRIPTS, "lib", "lock.ts"));
  // Takes the lock as a command named by argv[3] would, says so, then stays alive or exits (argv[4]).
  writeFileSync(
    join(helpers, "hold.ts"),
    `import { writeSync } from "node:fs";
import { acquireLock } from ${lib};
await acquireLock(process.argv[2]!, { command: process.argv[3]!, started: "${FIXED_NOW}" });
writeSync(1, "held\\n");
if (process.argv[4] === "exit") process.exit(0);
setInterval(() => {}, 1000);
`,
  );
  // A writer stopped half-way through a whole-file write: it holds the lock, has written the first
  // piece of the new file to the temporary file, and never reaches the rename.
  writeFileSync(
    join(helpers, "half-write.ts"),
    `import { writeSync } from "node:fs";
import { acquireLock, writeFileAtomic } from ${lib};
await acquireLock(process.argv[2]!, { command: "set", started: "${FIXED_NOW}" });
writeFileAtomic(process.argv[3]!, (function* () {
  yield "half of the new ";
  writeSync(1, "writing\\n");
  Bun.sleepSync(120_000);
  yield "file\\n";
})());
`,
  );
});

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
});

afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = sharedTempDir("lock");
  temps.push(dir);
  return dir;
}

// A copy of the Acme example layer.
function acme(): string {
  const root = join(tempDir(), "semantic");
  cpSync(ACME, root, { recursive: true });
  return root;
}

const lockFile = (root: string) => join(root, ".semlayer", "lock");
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

// Runs semlayer as its own process.
async function spawnSl(root: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string; ms: number }> {
  const started = performance.now();
  const p = Bun.spawn([process.execPath, SEMLAYER, ...args, "--root", root], { env: { ...process.env, SEMLAYER_NOW: FIXED_NOW, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, ms: performance.now() - started };
}

// Starts a helper script and resolves once it has printed `ready`.
async function helper(script: string, args: string[], ready: string) {
  const p = Bun.spawn([process.execPath, join(helpers, script), ...args], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  procs.push(p);
  const reader = p.stdout.getReader();
  let seen = "";
  while (!seen.includes(ready)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  if (!seen.includes(ready)) throw new Error(`${script} ended before it printed ${ready}`);
  return p;
}

// A live process, not semlayer's, that holds the root's lock as the command `command` would.
const holder = (root: string, command = "draft") => helper("hold.ts", [root, command], "held");

// The pid of a process that has ended.
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

function writeLock(root: string, pid: number, command = "draft"): string {
  mkdirSync(join(root, ".semlayer"), { recursive: true });
  const text = `${JSON.stringify({ pid, command, started: FIXED_NOW })}\n`;
  writeFileSync(lockFile(root), text);
  return text;
}

// Every dimension and measure of the Acme warehouse, as semlayer set targets with the file that holds each.
function acmeFields(root: string): { ref: string; file: string; kind: "dimensions" | "measures"; name: string }[] {
  const dir = join(root, "models", "warehouse");
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const m = readYaml<Model>(join(dir, f));
      return (["dimensions", "measures"] as const).flatMap((kind) => (m[kind] ?? []).map((x) => ({ ref: `warehouse.${m.model}.${x.name}`, file: join(dir, f), kind, name: x.name })));
    });
}

function description(field: { file: string; kind: "dimensions" | "measures"; name: string }): string | undefined {
  return readYaml<Model>(field.file)[field.kind]!.find((x) => x.name === field.name)!.description;
}

// semlayer validate on a layer whose approved fields `edited` had their descriptions changed: the only
// errors are those fields' changed approvals, since a description is part of what the owner approves.
async function validExceptEdited(root: string, edited: string[]): Promise<void> {
  const { issues } = (await semlayer(root, ["validate", "--json"])).json<{ issues: { level: string; code: string; message: string }[] }>();
  for (const i of issues.filter((x) => x.level === "error")) expect({ code: i.code, edited: edited.includes(i.message.split(" ")[0]!) }).toEqual({ code: "approval.hash_changed", edited: true });
}

// The parallel tests are about every edit landing, so a slow machine gets a long wait for its turn.
const PATIENT = { SEMLAYER_LOCK_WAIT_MS: "120000" };

describe("acceptance: parallel writers (real processes)", () => {
  test(
    "20 parallel semlayer set calls on different fields all land",
    async () => {
      const root = acme();
      const fields = acmeFields(root).slice(0, 20);
      expect(fields).toHaveLength(20);
      // Several of the 20 share a file, where an unlocked read, change and write loses edits.
      expect(new Set(fields.map((f) => f.file)).size).toBeLessThan(10);
      const runs = await Promise.all(fields.map((f, i) => spawnSl(root, ["set", f.ref, "description", `Parallel edit ${i}.`], PATIENT)));
      for (const r of runs) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      fields.forEach((f, i) => expect(description(f)).toBe(`Parallel edit ${i}.`));
      expect(existsSync(lockFile(root))).toBe(false);
      await validExceptEdited(root, fields.map((f) => f.ref));
    },
    120_000,
  );

  test(
    "20 parallel semlayer reply calls give 20 distinct ids and a ledger that validates",
    async () => {
      const root = acme();
      const rb = await semlayer(root, ["readback", "--targets", "warehouse.orders.revenue,warehouse.products,warehouse.orders,warehouse.customers", "--json"]);
      expect(rb.code).toBe(0);
      const { readback_id } = rb.json<{ readback_id: string }>();
      const runs = await Promise.all(
        Array.from({ length: 20 }, (_, i) => spawnSl(root, ["reply", "--readback", readback_id, "--item", String((i % 4) + 1), "--text", `Answer ${i}.`, "--verdict", "yes", "--by", "Dana Ruiz"], PATIENT)),
      );
      for (const r of runs) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      const text = read(root, join(".semlayer", "ledger.jsonl"));
      expect(text.endsWith("\n")).toBe(true);
      const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
      // Ids are allocated under the lock: 20 of them, each once, in file order.
      expect(lines.map((l) => l.id)).toEqual(Array.from({ length: 20 }, (_, i) => `ans_${String(i + 1).padStart(4, "0")}`));
      expect(new Set(lines.map((l) => l.text)).size).toBe(20);
      const validate = await semlayer(root, ["validate", "--json"]);
      expect(validate.code).toBe(0);
      expect(validate.json<{ issues: { file: string }[] }>().issues.filter((i) => i.file.includes("ledger"))).toEqual([]);
    },
    120_000,
  );

  test(
    "parallel writers that find a stale lock take it over one at a time, and every edit lands",
    async () => {
      const root = acme();
      writeLock(root, await deadPid());
      const fields = acmeFields(root).slice(0, 8);
      const runs = await Promise.all(fields.map((f, i) => spawnSl(root, ["set", f.ref, "description", `After the takeover ${i}.`], PATIENT)));
      for (const r of runs) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      fields.forEach((f, i) => expect(description(f)).toBe(`After the takeover ${i}.`));
      expect(readdirSync(join(root, ".semlayer"))).toEqual([]);
    },
    120_000,
  );
});

describe("a lock held by a live process", () => {
  test(
    "a second writer waits SEMLAYER_LOCK_WAIT_MS, then fails naming the holding command and pid",
    async () => {
      const root = acme();
      const h = await holder(root, "draft");
      const held = read(root, join(".semlayer", "lock"));
      expect(JSON.parse(held)).toEqual({ pid: h.pid, command: "draft", started: FIXED_NOW });
      const before = read(root, join("models", "warehouse", "orders.yaml"));
      const r = await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Never written."], { SEMLAYER_LOCK_WAIT_MS: "200" });
      expect(r.code).toBe(1);
      expect(r.ms).toBeGreaterThanOrEqual(200);
      expect(r.err.trim()).toBe(
        `semlayer set: semlayer draft (process ${h.pid}, started ${FIXED_NOW}) ${BUSY} and still held ${lockFile(root)} after 200 ms, so nothing was written. ` +
          `Run this command again once it has finished; if process ${h.pid} is no longer a semlayer command, remove ${lockFile(root)} first.`,
      );
      expect(read(root, join("models", "warehouse", "orders.yaml"))).toBe(before);
      // The holder's lock is untouched.
      expect(read(root, join(".semlayer", "lock"))).toBe(held);
    },
    60_000,
  );

  test(
    "a second writer that waits goes on as soon as the holder is done",
    async () => {
      const root = acme();
      const h = await holder(root);
      const waiting = spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Written after the wait."], { SEMLAYER_LOCK_WAIT_MS: "30000" });
      await Bun.sleep(400);
      expect(existsSync(lockFile(root))).toBe(true);
      h.kill("SIGTERM");
      const r = await waiting;
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(r.ms).toBeGreaterThanOrEqual(400);
      expect(read(root, join("models", "warehouse", "orders.yaml"))).toContain("Written after the wait.");
      expect(existsSync(lockFile(root))).toBe(false);
    },
    60_000,
  );

  test(
    "status, next and validate succeed, and no read-only command or preview waits",
    async () => {
      const root = acme();
      await holder(root);
      const held = read(root, join(".semlayer", "lock"));
      for (const args of [["status"], ["status", "--json"], ["next"], ["next", "--json"], ["validate"]]) {
        const r = await spawnSl(root, args, { SEMLAYER_LOCK_WAIT_MS: "0" });
        expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 0, err: "" });
      }
      const readers = [
        ["access", "--roles", "analyst"],
        ["baseline", "--source", "warehouse"],
        ["brief", "--source", "warehouse", "--batch", "1"],
        ["check-join", "--source", "warehouse", "--all", "--no-write"],
        ["check-rule", "--source", "warehouse", "--model", "orders", "--filter", "status = 'completed'"],
        ["export-sql", "--dialect", "postgres"],
        ["goldens", "check", "--name", "revenue_2025"],
        ["goldens", "run", "--name", "revenue_2025"],
        ["results", "status", "--plan", "0123456789ab"],
        ["run", "--source", "warehouse", "--sql", "select 1"],
        ["scope", "--source", "warehouse", "--include", "dim_*"],
        ["setup", "--print-role-sql", "--dialect", "postgres", "--schemas", "acme"],
        ["sql", "--request", join(root, "goldens", "revenue_2025.yaml")],
        ["tables", "--source", "warehouse"],
      ];
      for (const args of readers) {
        const r = await semlayer(root, args, { SEMLAYER_LOCK_WAIT_MS: "0" });
        expect({ args, busy: (r.out + r.err).includes(BUSY) }).toEqual({ args, busy: false });
      }
      expect(read(root, join(".semlayer", "lock"))).toBe(held);
    },
    60_000,
  );

  test("every command that reads, changes and writes waits for it before it does anything", async () => {
    const root = acme();
    await holder(root, "import");
    const files = tree(root);
    // The lock is taken before the arguments are read, so the bare command is enough.
    const writers = [
      ["add-field"],
      ["add-join"],
      ["add-metric"],
      ["add-source"],
      ["approve"],
      ["baseline", "--source", "warehouse", "--out", "baseline.md"],
      ["check-join", "--emit-sql"],
      ["check-rule", "--emit-sql"],
      ["draft"],
      ["goldens", "new"],
      ["goldens", "run", "--emit-sql"],
      ["goldens", "confirm", "--emit-sql"],
      ["goldens", "check", "--emit-sql"],
      ["ignore-column"],
      ["import"],
      ["init", "--name", "again"],
      ["introspect", "--emit-sql"],
      ["profile", "--emit-sql"],
      ["profile", "--redact"],
      ["question", "add"],
      ["remove-field"],
      ["remove-join"],
      ["remove-metric"],
      ["rename"],
      ["reply"],
      ["results", "add"],
      ["review", "export"],
      ["review", "apply"],
      ["scope", "--write"],
      ["scope", "--to-file", "tables.txt"],
      ["set"],
      ["tag"],
      // These query first, or number what they store, and take the lock when they come to write.
      ["readback", "--targets", "warehouse.orders.revenue"],
      ["setup", "--source", "scratch", "--dialect", "duckdb", "--database", ":memory:"],
    ];
    for (const args of writers) {
      const r = await semlayer(root, args, { SEMLAYER_LOCK_WAIT_MS: "0" });
      expect({ args, code: r.code, busy: r.err.includes(`semlayer import (process`) && r.err.includes(BUSY) }).toEqual({ args, code: 1, busy: true });
    }
    expect(tree(root)).toEqual(files);
  });

  test("every command declares whether it writes", async () => {
    for (const [name, load] of Object.entries(COMMANDS)) {
      const { writes } = (await load()).default;
      expect({ name, declared: typeof writes === "function" || writes === false || writes === "whole" || writes === "late" }).toEqual({ name, declared: true });
    }
  });

  test("the MCP server's tool calls take the same lock", async () => {
    const root = acme();
    const h = await holder(root, "profile");
    const server = new Server({ root, cwd: root, env: { ...process.env, SEMLAYER_NOW: FIXED_NOW, SEMLAYER_LOCK_WAIT_MS: "100" }, log: () => {} });
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    const edit = { positionals: ["warehouse.orders.revenue", "description", "Set through the MCP server."] };
    const refused = await call("semlayer_set", edit);
    expect(refused.isError).toBe(true);
    expect(refused.content.map((c) => c.text).join("\n")).toContain(`semlayer set: semlayer profile (process ${h.pid}, started ${FIXED_NOW}) ${BUSY}`);
    expect(read(root, join("models", "warehouse", "orders.yaml"))).not.toContain("Set through the MCP server.");
    // A read-only tool answers while the lock is held.
    expect((await call("semlayer_status", {})).isError).toBeUndefined();

    h.kill("SIGTERM");
    await h.exited;
    const done = await call("semlayer_set", edit);
    expect(done.isError).toBeUndefined();
    expect(read(root, join("models", "warehouse", "orders.yaml"))).toContain("Set through the MCP server.");
    expect(existsSync(lockFile(root))).toBe(false);
  });
});

// Every file under a directory, relative to it, with its contents.
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, tree(p, base));
    else out[p.slice(base.length + 1)] = readFileSync(p, "utf8");
  }
  return out;
}

describe("taking and releasing the lock", () => {
  test("it is released when the command ends, when it fails and when the process exits or is signalled", async () => {
    const root = acme();
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Fine."])).code).toBe(0);
    expect(existsSync(lockFile(root))).toBe(false);
    const bad = await semlayer(root, ["set", "warehouse.orders.revenue", "type", "not-a-type"]);
    expect(bad.code).toBe(1);
    expect(existsSync(lockFile(root))).toBe(false);

    const exits = await helper("hold.ts", [root, "draft", "exit"], "held");
    expect(await exits.exited).toBe(0);
    expect(existsSync(lockFile(root))).toBe(false);

    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const h = await holder(root);
      expect(existsSync(lockFile(root))).toBe(true);
      h.kill(signal);
      await h.exited;
      // The process ends as the signal ends it, with the lock gone.
      expect((h as unknown as { signalCode: string | null }).signalCode).toBe(signal);
      expect(existsSync(lockFile(root))).toBe(false);
    }
  });

  test("it is reentrant inside one process, and gone only when every holder has released it", async () => {
    const root = acme();
    const first = await acquireLock(root, WHO, 0);
    const started = performance.now();
    const second = await acquireLock(root, { command: "other", started: FIXED_NOW }, 0);
    expect(performance.now() - started).toBeLessThan(50);
    // A command run in this process shares it too.
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Inside."], { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    expect(JSON.parse(read(root, join(".semlayer", "lock")))).toEqual({ pid: process.pid, ...WHO });
    second();
    second();
    expect(existsSync(lockFile(root))).toBe(true);
    first();
    expect(existsSync(lockFile(root))).toBe(false);
  });

  test("a stale lock is taken over: a dead process, this pid from an earlier process, and one never filled in", async () => {
    const root = acme();
    const edit = (n: number) => ["set", "warehouse.orders.revenue", "description", `Takeover ${n}.`];
    const stale = [await deadPid(), process.pid];
    for (const [n, pid] of stale.entries()) {
      writeLock(root, pid);
      const r = await semlayer(root, edit(n), { SEMLAYER_LOCK_WAIT_MS: "0" });
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(read(root, join("models", "warehouse", "orders.yaml"))).toContain(`Takeover ${n}.`);
      expect(readdirSync(join(root, ".semlayer"))).toEqual([]);
    }
    // A takeover file left by a command killed while it cleared a stale lock goes with the next lock taken.
    writeFileSync(`${lockFile(root)}.takeover`, "");
    expect((await semlayer(root, edit(9), { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    expect(readdirSync(join(root, ".semlayer"))).toEqual([]);
    // A lock file with nothing readable in it is a holder between creating and filling it, for two seconds.
    mkdirSync(join(root, ".semlayer"), { recursive: true });
    writeFileSync(lockFile(root), "");
    const fresh = await semlayer(root, edit(2), { SEMLAYER_LOCK_WAIT_MS: "50" });
    expect(fresh.code).toBe(1);
    expect(fresh.err).toContain(`semlayer set: another semlayer command ${BUSY} and still held ${lockFile(root)} after 50 ms`);
    expect(fresh.err).toContain(`if no semlayer command is running, remove ${lockFile(root)} first.`);
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockFile(root), old, old);
    expect((await semlayer(root, edit(3), { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    expect(read(root, join("models", "warehouse", "orders.yaml"))).toContain("Takeover 3.");
    expect(existsSync(lockFile(root))).toBe(false);
  });

  test("a link or a directory at .semlayer/lock is a lock that cannot be read: never followed, and the wait still ends", async () => {
    const root = acme();
    const outside = tempDir();
    const edit = (n: number) => ["set", "warehouse.orders.revenue", "description", `Not a file ${n}.`];
    const old = new Date(Date.now() - 10_000);
    mkdirSync(join(root, ".semlayer"));
    // A link to nothing: the writer waits its SEMLAYER_LOCK_WAIT_MS and fails in plain words, creating nothing outside.
    symlinkSync(join(outside, "nowhere"), lockFile(root));
    const waited = await spawnSl(root, edit(0), { SEMLAYER_LOCK_WAIT_MS: "100" });
    expect(waited.code).toBe(1);
    expect(waited.err).toContain(`semlayer set: another semlayer command ${BUSY} and still held ${lockFile(root)} after 100 ms`);
    // After two seconds it is stale: the link is removed and the command writes.
    lutimesSync(lockFile(root), old, old);
    expect((await semlayer(root, edit(1), { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    expect(readdirSync(outside)).toEqual([]);

    // A link to a file outside the root that reads as a live holder: the file is not read as the lock, nor removed.
    const elsewhere = join(outside, "lock");
    writeFileSync(elsewhere, `${JSON.stringify({ pid: process.ppid, command: "draft", started: FIXED_NOW })}\n`);
    mkdirSync(join(root, ".semlayer"), { recursive: true });
    symlinkSync(elsewhere, lockFile(root));
    lutimesSync(lockFile(root), old, old);
    expect((await semlayer(root, edit(2), { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    expect(read(root, join("models", "warehouse", "orders.yaml"))).toContain("Not a file 2.");
    expect(readFileSync(elsewhere, "utf8")).toContain('"command":"draft"');
    expect(readdirSync(join(root, ".semlayer"))).toEqual([]);

    // A directory cannot be taken over: the command fails when its wait ends, with the usual message and no stack.
    mkdirSync(lockFile(root));
    utimesSync(lockFile(root), old, old);
    const dir = await spawnSl(root, edit(3), { SEMLAYER_LOCK_WAIT_MS: "100" });
    expect(dir.code).toBe(1);
    expect(dir.err.trim()).toBe(
      `semlayer set: another semlayer command ${BUSY} and still held ${lockFile(root)} after 100 ms, so nothing was written. ` +
        `Run this command again once it has finished; if no semlayer command is running, remove ${lockFile(root)} first.`,
    );
    expect(read(root, join("models", "warehouse", "orders.yaml"))).not.toContain("Not a file 3.");
  });

  test("SEMLAYER_LOCK_WAIT_MS defaults to 30 seconds and must be a number", async () => {
    expect(DEFAULT_LOCK_WAIT_MS).toBe(30_000);
    expect(lockWaitMs({})).toBe(30_000);
    expect(lockWaitMs({ SEMLAYER_LOCK_WAIT_MS: "250" })).toBe(250);
    const root = acme();
    const r = await semlayer(root, ["set", "warehouse.orders.revenue", "description", "x"], { SEMLAYER_LOCK_WAIT_MS: "soon" });
    expect(r.code).toBe(1);
    expect(r.err).toContain('SEMLAYER_LOCK_WAIT_MS is the number of milliseconds a command waits for another to finish writing, not "soon"');
  });

  test("a command outside a semantic root takes no lock and leaves nothing behind", async () => {
    const dir = tempDir();
    const r = await semlayer(join(dir, "semantic"), ["set", "warehouse.orders.revenue", "description", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No semantic layer at");
    expect(readdirSync(dir)).toEqual([]);
    // A root without a .semlayer directory gets none from a command that fails before it writes.
    const root = acme();
    expect(existsSync(join(root, ".semlayer"))).toBe(false);
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "type", "not-a-type"])).code).toBe(1);
    expect((await semlayer(root, ["readback", "--targets", "warehouse.nope"])).code).toBe(1);
    expect(existsSync(join(root, ".semlayer"))).toBe(false);
  });

  // Invariant 6: tools write only inside the semantic root.
  test("a .semlayer that leads outside the semantic root, or nowhere, gets no lock file", async () => {
    const root = acme();
    const outside = tempDir();
    symlinkSync(outside, join(root, ".semlayer"));
    const release = await acquireLock(root, WHO, 0);
    expect(readdirSync(outside)).toEqual([]);
    release();
    expect((await semlayer(root, ["set", "warehouse.orders.revenue", "description", "Still edited."])).code).toBe(0);
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(root, ".semlayer"));
    symlinkSync(join(outside, "nowhere"), join(root, ".semlayer"));
    (await acquireLock(root, WHO, 0))();
    expect(readdirSync(outside)).toEqual([]);
  });

  test("taking and releasing the lock adds well under 20 ms to a command", async () => {
    const root = acme();
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      (await acquireLock(root, WHO))();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const [median, worst] = [times[100]!, times[199]!];
    console.log(`lock: take and release, 200 runs: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`);
    expect(median).toBeLessThan(20);
    // The first of a process also writes the .gitignore rule; a takeover reads the stale lock and sweeps.
    writeLock(root, await deadPid());
    const t = performance.now();
    (await acquireLock(root, WHO))();
    const takeover = performance.now() - t;
    // One measurement, reported and not asserted: a loaded machine can stretch a single run.
    console.log(`lock: take over a stale lock and release: ${takeover.toFixed(3)} ms`);
    expect(existsSync(lockFile(root))).toBe(false);
  });
});

describe(".semlayer/lock is ignored by git", () => {
  test("semlayer init writes the rule", async () => {
    const root = join(tempDir(), "semantic");
    await initProject(root);
    expect(read(root, ".gitignore")).toBe("# Query plans and their results, written by --emit-sql and semlayer results add.\n.semlayer/plans/\n.semlayer/lock\n.semlayer/lock.takeover\n*.semlayer-tmp\n");
    // The next locked command finds it and adds nothing.
    expect((await semlayer(root, ["add-source", "--name", "wh", "--dialect", "duckdb"])).code).toBe(0);
    expect(read(root, ".gitignore")).toBe("# Query plans and their results, written by --emit-sql and semlayer results add.\n.semlayer/plans/\n.semlayer/lock\n.semlayer/lock.takeover\n*.semlayer-tmp\n");
  });

  test("a root made before gets it on its first locked command, once, and read-only commands leave it alone", async () => {
    const root = acme();
    writeFileSync(join(root, ".gitignore"), "# ours\n.semlayer/plans/");
    for (const args of [["status"], ["validate"], ["next"]]) expect((await semlayer(root, args)).code).toBe(0);
    expect(read(root, ".gitignore")).toBe("# ours\n.semlayer/plans/");
    expect((await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "First locked command."])).code).toBe(0);
    expect(read(root, ".gitignore")).toBe("# ours\n.semlayer/plans/\n.semlayer/lock\n.semlayer/lock.takeover\n*.semlayer-tmp\n");
    expect((await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Second."])).code).toBe(0);
    expect(read(root, ".gitignore")).toBe("# ours\n.semlayer/plans/\n.semlayer/lock\n.semlayer/lock.takeover\n*.semlayer-tmp\n");

    // A root with no .gitignore gets one.
    rmSync(join(root, ".gitignore"));
    expect((await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Third."])).code).toBe(0);
    expect(read(root, ".gitignore")).toBe(".semlayer/lock\n.semlayer/lock.takeover\n*.semlayer-tmp\n");
  });

  test("a .gitignore that is a link is left alone", async () => {
    const root = acme();
    const outside = tempDir();
    writeFileSync(join(outside, "ignore"), "# elsewhere\n");
    rmSync(join(root, ".gitignore"));
    symlinkSync(join(outside, "ignore"), join(root, ".gitignore"));
    expect((await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Edited."])).code).toBe(0);
    expect(readFileSync(join(outside, "ignore"), "utf8")).toBe("# elsewhere\n");
  });
});

describe("whole-file writes", () => {
  test("a write replaces the file in one step, keeps its mode and leaves no temporary file", () => {
    const dir = tempDir();
    const file = join(dir, "a.yaml");
    writeFileAtomic(file, "one\n");
    chmodSync(file, 0o600);
    writeFileAtomic(file, ["two", "\n"]);
    writeFileAtomic(file, new TextEncoder().encode("three\n"));
    expect(readFileSync(file, "utf8")).toBe("three\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["a.yaml"]);
  });

  test("an exclusive write fails with EEXIST where a file or a link is, changing nothing", () => {
    const dir = tempDir();
    const file = join(dir, "a.json");
    writeFileAtomic(file, "first\n", { exclusive: true });
    symlinkSync(join(dir, "nowhere"), join(dir, "link.json"));
    for (const taken of [file, join(dir, "link.json")]) {
      let code: unknown;
      try {
        writeFileAtomic(taken, "second\n", { exclusive: true });
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("EEXIST");
    }
    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(readdirSync(dir).sort()).toEqual(["a.json", "link.json"]);
  });

  test("a link is written through by default and replaced on request; a failed write removes its temporary file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "real.yaml"), "old\n");
    symlinkSync(join(dir, "real.yaml"), join(dir, "link.yaml"));
    writeFileAtomic(join(dir, "link.yaml"), "through\n");
    expect(readFileSync(join(dir, "real.yaml"), "utf8")).toBe("through\n");
    writeFileAtomic(join(dir, "link.yaml"), "replaced\n", { replaceLink: true });
    expect(readFileSync(join(dir, "real.yaml"), "utf8")).toBe("through\n");
    expect(readFileSync(join(dir, "link.yaml"), "utf8")).toBe("replaced\n");

    const failing = function* () {
      yield "part";
      throw new Error("disk full");
    };
    expect(() => writeFileAtomic(join(dir, "real.yaml"), failing())).toThrow("disk full");
    expect(readFileSync(join(dir, "real.yaml"), "utf8")).toBe("through\n");
    expect(readdirSync(dir).sort()).toEqual(["link.yaml", "real.yaml"]);
  });

  // Invariant 6: tools write only inside the semantic root. semlayer runs in this process here, as it does
  // in the MCP server, so the name of the temporary file a write goes through is known beforehand.
  test("a link planted at a write's temporary path is removed, never written through or moved into place", async () => {
    const root = acme();
    const outside = tempDir();
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "outside the root\n");
    const plant = (target: string, to = victim) => {
      mkdirSync(join(target, ".."), { recursive: true });
      symlinkSync(to, tempPath(target));
    };
    const plain = (file: string) => expect({ file, plain: lstatSync(file).isFile() }).toEqual({ file, plain: true });

    // A model file, edited by semlayer set.
    const model = join(root, "models", "warehouse", "orders.yaml");
    plant(model);
    const set = await semlayer(root, ["set", "warehouse.orders.order_count", "description", "Counted inside the root."]);
    expect({ code: set.code, err: set.err }).toEqual({ code: 0, err: "" });
    plain(model);
    expect(readFileSync(model, "utf8")).toContain("Counted inside the root.");

    // A stored readback (a file that must be new) and the ledger, through a link to a file and a link to nothing.
    const pending = join(root, ".semlayer", "pending", "rb_0001.json");
    const ledger = join(root, ".semlayer", "ledger.jsonl");
    plant(pending);
    plant(ledger, join(outside, "nowhere"));
    const rb = await semlayer(root, ["readback", "--targets", "warehouse.orders.revenue", "--json"]);
    expect({ code: rb.code, id: rb.json<{ readback_id: string }>().readback_id }).toEqual({ code: 0, id: "rb_0001" });
    const reply = await semlayer(root, ["reply", "--readback", "rb_0001", "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect({ code: reply.code, err: reply.err }).toEqual({ code: 0, err: "" });
    plain(pending);
    plain(ledger);
    expect(readFileSync(ledger, "utf8")).toContain('"id":"ans_0001"');

    // Nothing outside the root changed or appeared, and no temporary file is left inside it.
    expect(readFileSync(victim, "utf8")).toBe("outside the root\n");
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
    expect(Object.keys(tree(root)).filter((f) => f.endsWith(".semlayer-tmp"))).toEqual([]);
    await validExceptEdited(root, ["warehouse.orders.order_count"]);
  });

  test(
    "a writer killed mid-write leaves the previous file intact, and its temporary file and lock break no later command",
    async () => {
      const root = acme();
      const target = join(root, "models", "warehouse", "orders.yaml");
      const before = readFileSync(target, "utf8");
      const writer = await helper("half-write.ts", [root, target], "writing");
      const temp = tempPath(target, writer.pid);
      expect(readFileSync(temp, "utf8")).toBe("half of the new ");
      writer.kill("SIGKILL");
      await writer.exited;

      // The file is whole, with its previous bytes; the temporary file and the lock are what the kill left.
      expect(readFileSync(target, "utf8")).toBe(before);
      expect(existsSync(temp)).toBe(true);
      expect(JSON.parse(read(root, join(".semlayer", "lock"))).pid).toBe(writer.pid);

      // Read-only commands neither read the temporary file nor mind the dead writer's lock.
      for (const args of [["validate"], ["status"], ["next"], ["tables", "--source", "warehouse"]]) {
        const r = await spawnSl(root, args);
        expect({ args, code: r.code, err: r.err }).toEqual({ args, code: 0, err: "" });
      }
      expect(readFileSync(target, "utf8")).toBe(before);

      // The next writer takes the dead writer's lock over, removes its temporary file and writes.
      const r = await spawnSl(root, ["set", "warehouse.orders.revenue", "description", "Written after the kill."], { SEMLAYER_LOCK_WAIT_MS: "0" });
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
      expect(description({ file: target, kind: "measures", name: "revenue" })).toBe("Written after the kill.");
      expect(readFileSync(target, "utf8")).not.toContain("half of the new");
      expect(existsSync(temp)).toBe(false);
      expect(readdirSync(join(root, "models", "warehouse")).filter((f) => f.startsWith("."))).toEqual([]);
      expect(readdirSync(join(root, ".semlayer"))).toEqual([]);
      await validExceptEdited(root, ["warehouse.orders.revenue"]);
    },
    60_000,
  );
});

// A FIFO stands in for the database: a command given --results <fifo> blocks reading it exactly
// where a live run waits for its queries, and goes on when the test writes the rows.
function fifo(dir: string): string {
  const path = join(dir, "results.fifo");
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  return path;
}

describe("commands that query a database", () => {
  test(
    "semlayer profile holds no lock while its queries run, and writes into the snapshot as it then is",
    async () => {
      const dir = tempDir();
      const root = join(dir, "semantic");
      await initProject(root);
      await duckdbSource(root, dir, "wh", [
        "create table customers as select range + 1 as customer_id, 'c' || range as name from range(10)",
        "create table orders as select range + 1 as order_id, (range % 10) + 1 as customer_id from range(20)",
      ]);
      expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
      const emitted = await semlayer(root, ["profile", "--source", "wh", "--tables", "customers", "--emit-sql"]);
      expect(emitted.code).toBe(0);
      const instance = await DuckDBInstance.create(join(dir, "wh.duckdb"));
      const conn = await instance.connect();
      const results: Record<string, unknown[]> = {};
      for (const q of emitted.json<QueryPlan>().queries) results[q.id] = (await conn.runAndReadAll(q.sql)).getRowObjectsJson();
      conn.closeSync();
      instance.closeSync();

      const pipe = fifo(dir);
      const profiling = spawnSl(root, ["profile", "--source", "wh", "--tables", "customers", "--results", pipe]);
      // Opening the FIFO for writing returns once semlayer has opened it to read its results.
      const feed = await open(pipe, "w");
      expect(existsSync(lockFile(root))).toBe(false);
      // Another writer runs meanwhile, without waiting: it profiles the other table into the same snapshot.
      const other = await semlayer(root, ["profile", "--source", "wh", "--tables", "orders"], { SEMLAYER_LOCK_WAIT_MS: "0" });
      expect({ code: other.code, err: other.err }).toEqual({ code: 0, err: "" });
      await feed.writeFile(JSON.stringify(results));
      await feed.close();
      const r = await profiling;
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });

      // Both profiles are in the snapshot: the first run read it again under the lock before writing.
      const tables = readJson<Snapshot>(join(root, "snapshots", "wh.json")).tables;
      expect(tables.map((t) => [t.name, typeof t.profiled_at])).toEqual([["customers", "string"], ["orders", "string"]]);
      expect(existsSync(lockFile(root))).toBe(false);
    },
    60_000,
  );

  // Invariant 5: nothing is approved without a recorded owner yes.
  test(
    "semlayer goldens confirm records nothing when the owner's reply changes while its query runs",
    async () => {
      const root = acme();
      const dir = tempDir();
      const name = "revenue_2025";
      const goldenFile = join(root, "goldens", `${name}.yaml`);
      const golden = readYaml<Golden>(goldenFile);
      const plan = (await semlayer(root, ["goldens", "confirm", "--name", name, "--emit-sql"])).json<QueryPlan>();
      const results = JSON.stringify(Object.fromEntries(plan.queries.map((q) => [q.id, golden.expected!.rows])));
      const resultsFile = join(dir, "results.json");
      writeFileSync(resultsFile, results);
      const rb = await semlayer(root, ["readback", "--targets", `golden:${name}`, "--results", resultsFile, "--json"]);
      expect(rb.code).toBe(0);
      const reply = (verdict: string) => semlayer(root, ["reply", "--readback", rb.json<{ readback_id: string }>().readback_id, "--item", "1", "--text", `${verdict}.`, "--verdict", verdict, "--by", "Dana Ruiz"]);
      expect((await reply("yes")).code).toBe(0);
      const before = readFileSync(goldenFile, "utf8");

      const pipe = fifo(dir);
      const confirming = spawnSl(root, ["goldens", "confirm", "--name", name, "--results", pipe]);
      const feed = await open(pipe, "w");
      // The yes was read before the query; the owner's no arrives while it runs.
      expect(existsSync(lockFile(root))).toBe(false);
      expect((await reply("no")).code).toBe(0);
      await feed.writeFile(results);
      await feed.close();
      const r = await confirming;
      expect(r.code).toBe(1);
      expect(r.err).toContain(`Golden "${name}" or the owner's reply to it changed while its query ran, so nothing was recorded. Run semlayer goldens confirm --name ${name} --results ${pipe} again.`);
      expect(readFileSync(goldenFile, "utf8")).toBe(before);
      expect(existsSync(lockFile(root))).toBe(false);

      // With the yes standing, the same confirm from the same rows records it.
      expect((await reply("yes")).code).toBe(0);
      const again = await semlayer(root, ["goldens", "confirm", "--name", name, "--results", resultsFile]);
      expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
    },
    60_000,
  );

  test("a query command that finds the lock held when it comes to write fails then, with nothing written", async () => {
    const dir = tempDir();
    const root = join(dir, "semantic");
    await initProject(root);
    await duckdbSource(root, dir, "wh", [
      "create table customers (customer_id integer primary key, name varchar)",
      "insert into customers select range + 1, 'c' || range from range(10)",
      "create table orders (order_id integer primary key, customer_id integer references customers (customer_id))",
      "insert into orders select range + 1, (range % 10) + 1 from range(20)",
    ]);
    expect((await semlayer(root, ["introspect", "--source", "wh"])).code).toBe(0);
    // The declared foreign key drafts the join orders.customer, for semlayer check-join to measure.
    expect((await semlayer(root, ["draft", "--source", "wh"])).code).toBe(0);
    await holder(root, "set");
    const files = tree(root);
    // Measuring without writing needs no lock.
    expect((await semlayer(root, ["check-join", "--source", "wh", "--all", "--no-write"], { SEMLAYER_LOCK_WAIT_MS: "0" })).code).toBe(0);
    for (const args of [["introspect", "--source", "wh"], ["profile", "--source", "wh"], ["check-join", "--source", "wh", "--all"]]) {
      const r = await semlayer(root, args, { SEMLAYER_LOCK_WAIT_MS: "0" });
      expect({ args, code: r.code, busy: r.err.includes(`semlayer set (process`) && r.err.includes(BUSY) }).toEqual({ args, code: 1, busy: true });
    }
    expect(tree(root)).toEqual(files);
  });
});

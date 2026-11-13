// Connections from an env file (docs/PRD-hardening.md HR-4): the lookup order, values as written,
// the prefix form, the messages, the .gitignore lines, the validate errors and the MCP server.
import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFailure, type DriverConnection, driverConnection } from "../skills/semantic-layer/scripts/lib/adapters/postgres.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import {
  type ConnectionResolution,
  type Env,
  type EnvLookup,
  ignoreEnvFiles,
  parseEnvFile,
  processEnvironment,
  readConnection,
  resolveConnection,
} from "../skills/semantic-layer/scripts/lib/env-file.ts";
import { loadSource } from "../skills/semantic-layer/scripts/lib/project.ts";
import type { SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { applySourceState } from "../skills/semantic-layer/scripts/lib/setup.ts";
import { editYamlText, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { Server } from "../skills/semantic-layer/scripts/mcp/server.ts";
import { assertLocalPg, FIXED_NOW, PG_URL, tempDir, uniqueSchema } from "./helpers.ts";

const SCRIPTS = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts");
const SL = join(SCRIPTS, "sl.ts");
const SERVER = join(SCRIPTS, "mcp", "server.ts");

// A synthetic password with every character a URL would need encoded, and one a shell would expand.
const PASSWORD = "p@ss#w/rd$HOME";
const USER = "reader_h4";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A project directory with a semantic root in it and a second directory to run from.
function project(): { dir: string; root: string; elsewhere: string } {
  const base = tempDir("env");
  dirs.push(base);
  const dir = join(base, "proj");
  const elsewhere = join(base, "elsewhere");
  mkdirSync(dir);
  mkdirSync(elsewhere);
  return { dir, root: join(dir, "semantic"), elsewhere };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

// Runs the CLI in-process from `cwd`, with only the variables given.
async function cli(cwd: string, args: string[], env: Env = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { cwd, env: { SL_NOW: FIXED_NOW, ...env }, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// The environment of a spawned CLI or server: nothing of this process's but what it needs to run.
const BARE_ENV = { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), HOME: "/root", SL_NOW: FIXED_NOW };

// Runs `bun sl.ts` as people do, so Bun loads the working directory's .env before the CLI starts.
function spawnCli(cwd: string, args: string[], env: Record<string, string> = {}): Run {
  const p = Bun.spawnSync([process.execPath, SL, ...args], { cwd, env: { ...BARE_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// The same without blocking this process, for a run that talks to a server this process runs.
async function spawnCliAsync(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const p = Bun.spawn([process.execPath, SL, ...args], { cwd, env: { ...BARE_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

// A server that speaks the start of the Postgres protocol on 127.0.0.1: it has no TLS, asks for a
// cleartext password, records what the client sent in `seen` and then refuses the password.
function fakePostgres(): { port: number; seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const message = (type: string, body: Buffer) => {
    const out = Buffer.alloc(5 + body.length);
    out.write(type);
    out.writeInt32BE(4 + body.length, 1);
    body.copy(out, 5);
    return out;
  };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const buf = Buffer.from(data);
        if (buf.length === 8 && buf.readInt32BE(4) === 80877103) {
          seen.push("ssl request");
          socket.write("N");
        } else if (buf[0] === 0x70) {
          seen.push(`password:${buf.subarray(5, buf.length - 1).toString()}`);
          socket.write(message("E", Buffer.from(`SFATAL\0C28P01\0Mpassword authentication failed for user "${USER}"\0\0`)));
          socket.end();
        } else {
          const fields = buf.subarray(8).toString().split("\0");
          seen.push(`startup:user=${fields[fields.indexOf("user") + 1]},database=${fields[fields.indexOf("database") + 1]}`);
          const cleartext = Buffer.alloc(4);
          cleartext.writeInt32BE(3);
          socket.write(message("R", cleartext));
        }
      },
    },
  });
  return { port: server.port, seen, stop: () => server.stop(true) };
}

// The password the driver holds for a connection.
const password = (conn: DriverConnection): unknown => {
  const held = (conn.sql.options as { password?: unknown }).password;
  return typeof held === "function" ? (held as () => unknown)() : held;
};

const urlSource = (name = "lake", variable = "LAKE_URL"): SourceConfig => ({ source: name, dialect: "postgres", connection: { env: variable } });
const prefixSource = (prefix: string, name = "lake"): SourceConfig => ({ source: name, dialect: "postgres", connection: { env_prefix: prefix } });

function initRoot(root: string, source: SourceConfig): void {
  mkdirSync(join(root, "sources"), { recursive: true });
  writeYaml(join(root, "semantic.yaml"), { version: 1, name: "acme" });
  writeYaml(join(root, "sources", `${source.source}.yaml`), source);
}

// The value a variable resolves to and where from, as the adapter reads it.
function value(root: string, env: Env, opts: EnvLookup, variable = "LAKE_URL"): { value: string | undefined; resolution: ConnectionResolution } {
  const r = readConnection(root, urlSource("lake", variable), env, opts);
  return { value: r.values[variable], resolution: r.resolution };
}

describe("the env file format", () => {
  test("KEY=value, export, quotes, comments and blank lines; nothing is expanded", () => {
    const vars = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=postgres://u:p@h:5432/db?sslmode=require",
        "export EXPORTED=one",
        "  SPACED =  two words  ",
        "SINGLE='pa$$HOME # kept'",
        'DOUBLE="a\\nb $HOME"',
        "DOLLAR=pa$$HOME",
        "BRACED=${HOME}/x",
        "HASH=p@ss#w/rd",
        "COMMENTED=value # a comment",
        'QUOTED_THEN_COMMENT="x y" # why',
        "BACKSLASH=a\\$b",
        "EMPTY=",
        "UNTERMINATED='abc",
        "not a line",
        "LAST=1",
        "LAST=2",
      ].join("\r\n"),
    );
    expect(Object.fromEntries(vars)).toEqual({
      PLAIN: "postgres://u:p@h:5432/db?sslmode=require",
      EXPORTED: "one",
      SPACED: "two words",
      SINGLE: "pa$$HOME # kept",
      DOUBLE: "a\\nb $HOME",
      DOLLAR: "pa$$HOME",
      BRACED: "${HOME}/x",
      HASH: "p@ss#w/rd",
      COMMENTED: "value",
      QUOTED_THEN_COMMENT: "x y",
      BACKSLASH: "a\\$b",
      EMPTY: "",
      UNTERMINATED: "'abc",
      LAST: "2",
    });
  });
});

describe("the lookup order", () => {
  test("the environment, then the named file, then .env beside the root, then .env in the working directory", () => {
    const p = project();
    const named = join(p.elsewhere, "named.env");
    writeFileSync(named, "LAKE_URL=from-named\n");
    writeFileSync(join(p.dir, ".env"), "LAKE_URL=from-beside-root\n");
    writeFileSync(join(p.elsewhere, ".env"), "LAKE_URL=from-cwd\n");
    const lookup = { cwd: p.elsewhere, envFile: named };

    // 1. A variable set in the process wins over every file (decision HD3).
    const first = value(p.root, { LAKE_URL: "from-process" }, lookup);
    expect(first.value).toBe("from-process");
    expect(first.resolution).toMatchObject({ status: "ok", from: { kind: "environment" }, variables: ["LAKE_URL"], described: "LAKE_URL from the environment" });

    // 2. The named file, by --env-file or by SL_ENV_FILE, relative to the working directory.
    const second = value(p.root, {}, lookup);
    expect(second.value).toBe("from-named");
    expect(second.resolution).toMatchObject({ status: "ok", from: { kind: "env_file", path: named }, described: `LAKE_URL from ${named}` });
    expect(value(p.root, { SL_ENV_FILE: "named.env" }, { cwd: p.elsewhere }).value).toBe("from-named");
    writeFileSync(join(p.elsewhere, "other.env"), "LAKE_URL=from-other\n");
    expect(value(p.root, { SL_ENV_FILE: named }, { cwd: p.elsewhere, envFile: "other.env" }).value).toBe("from-other");

    // 3. The .env in the directory that holds the semantic root.
    const third = value(p.root, {}, { cwd: p.elsewhere });
    expect(third.value).toBe("from-beside-root");
    expect(third.resolution).toMatchObject({ from: { kind: "env_file", path: join(p.dir, ".env") } });

    // 4. The .env in the working directory, last.
    rmSync(join(p.dir, ".env"));
    const fourth = value(p.root, {}, { cwd: p.elsewhere });
    expect(fourth.value).toBe("from-cwd");
    expect(fourth.resolution).toMatchObject({ from: { kind: "env_file", path: join(p.elsewhere, ".env") } });

    // A file that does not set the variable, or sets it to nothing, is passed over.
    writeFileSync(named, "OTHER=x\nLAKE_URL=\n");
    expect(value(p.root, {}, lookup).value).toBe("from-cwd");
    expect(value(p.root, { LAKE_URL: "" }, lookup).value).toBe("from-cwd");
  });

  test("a named file that does not exist is an error, for the flag and for SL_ENV_FILE", async () => {
    const p = project();
    initRoot(p.root, urlSource());
    writeFileSync(join(p.dir, ".env"), "LAKE_URL=postgres://u@127.0.0.1:1/db\n");
    const missing = join(p.elsewhere, "nope.env");
    expect(() => resolveConnection(p.root, urlSource(), {}, { cwd: p.elsewhere, envFile: "nope.env" })).toThrow(`--env-file names ${missing}, which is not a file`);
    expect(() => resolveConnection(p.root, urlSource(), { SL_ENV_FILE: missing }, { cwd: p.elsewhere })).toThrow(`SL_ENV_FILE names ${missing}, which is not a file`);
    // The flag is checked on every command, before it runs.
    const status = await cli(p.elsewhere, ["status", "--root", p.root, "--env-file", "nope.env"]);
    expect(status.code).toBe(1);
    expect(status.err).toContain(`--env-file names ${missing}, which is not a file`);
    expect(status.err).toContain("run the same command again");
    const run = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select 1", "--root", p.root], { SL_ENV_FILE: missing });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`SL_ENV_FILE names ${missing}, which is not a file`);
  });

  test("the parts of a prefix are looked up one by one", () => {
    const p = project();
    writeFileSync(join(p.dir, ".env"), `LAKE_HOST=db.internal\nLAKE_USER=${USER}\nLAKE_PASSWORD='${PASSWORD}'\nLAKE_DATABASE=acme\n`);
    const r = readConnection(p.root, prefixSource("LAKE_"), { LAKE_HOST: "shell.internal" }, { cwd: p.elsewhere });
    expect(r.values).toEqual({ LAKE_HOST: "shell.internal", LAKE_USER: USER, LAKE_PASSWORD: PASSWORD, LAKE_DATABASE: "acme" });
    expect(r.resolution).toEqual({
      status: "ok",
      from: { kind: "env_file", path: join(p.dir, ".env") },
      variables: ["LAKE_HOST", "LAKE_USER", "LAKE_PASSWORD", "LAKE_DATABASE"],
      described: `LAKE_HOST from the environment; LAKE_USER, LAKE_PASSWORD, LAKE_DATABASE from ${join(p.dir, ".env")}`,
    });
    // The resolution a command routes on carries no value.
    expect(JSON.stringify(resolveConnection(p.root, prefixSource("LAKE_"), {}, { cwd: p.elsewhere }))).not.toContain("p@ss");
  });

  test("a source that names no variable has nothing to resolve", () => {
    const p = project();
    expect(resolveConnection(p.root, { source: "lake", dialect: "duckdb", connection: { database: ":memory:" } }, {})).toEqual({ status: "ok", from: null, variables: [], described: "" });
    expect(() => resolveConnection(p.root, { source: "lake", dialect: "postgres", connection: { env: "A", env_prefix: "B" } }, {})).toThrow("has both connection.env and connection.env_prefix");
  });
});

describe("a value arrives as written", () => {
  test("pa$$HOME is the same from the working directory's .env and from a named file", () => {
    const p = project();
    writeFileSync(join(p.elsewhere, ".env"), "LAKE_URL=pa$$HOME\n");
    writeFileSync(join(p.elsewhere, "named.env"), "LAKE_URL=pa$$HOME\n");
    expect(value(p.root, {}, { cwd: p.elsewhere }).value).toBe("pa$$HOME");
    expect(value(p.root, {}, { cwd: p.dir, envFile: join(p.elsewhere, "named.env") }).value).toBe("pa$$HOME");
  });

  test("what Bun loaded from the working directory's .env is passed over; what the shell set wins", () => {
    const p = project();
    writeFileSync(join(p.dir, ".env"), ["LAKE_URL=pa$$HOME", "QUOTED='a${HOME}b'", "ESCAPED=a\\$b", "DEFAULTED=${NO_SUCH_SL_VAR:-x}y", "PLAIN=same", "SHELL_SET=file$HOME"].join("\n"));
    // The process environment as Bun leaves it: each value loaded from the file, with $NAME expanded.
    const bun = { HOME: "/root", LAKE_URL: "pa$/root", QUOTED: "a/rootb", ESCAPED: "a$b", DEFAULTED: "xy", PLAIN: "same", SHELL_SET: "from-the-shell" };
    const env = processEnvironment(bun, p.dir);
    // The environment itself is unchanged: only the connection lookup passes over the marked names.
    expect(env).toEqual(bun);
    const lookup = { cwd: p.dir };
    for (const [name, written] of [["LAKE_URL", "pa$$HOME"], ["QUOTED", "a${HOME}b"], ["ESCAPED", "a\\$b"], ["DEFAULTED", "${NO_SUCH_SL_VAR:-x}y"], ["PLAIN", "same"]] as const) {
      const r = readConnection(p.root, urlSource("lake", name), env, lookup);
      expect(r.values[name]).toBe(written);
      expect(r.resolution).toMatchObject({ from: { kind: "env_file", path: join(p.dir, ".env") } });
    }
    const shell = readConnection(p.root, urlSource("lake", "SHELL_SET"), env, lookup);
    expect(shell.values.SHELL_SET).toBe("from-the-shell");
    expect(shell.resolution).toMatchObject({ from: { kind: "environment" } });
    // The same for every file Bun loads there, each name marked with the file that wins it.
    writeFileSync(join(p.dir, ".env.local"), "LAKE_URL=local$$HOME\nONLY_LOCAL=l$HOME\n");
    writeFileSync(join(p.dir, ".env.test.local"), "ONLY_TEST=t$HOME\n");
    const more = processEnvironment({ HOME: "/root", LAKE_URL: "local$/root", ONLY_LOCAL: "l/root", ONLY_TEST: "t/root", SHELL_SET: "from-the-shell" }, p.dir);
    expect(readConnection(p.root, urlSource(), more, lookup).values.LAKE_URL).toBe("pa$$HOME");
    for (const [name, file] of [["ONLY_LOCAL", ".env.local"], ["ONLY_TEST", ".env.test.local"]] as const) {
      const r = resolveConnection(p.root, urlSource("lake", name), more, lookup);
      expect(r).toMatchObject({ status: "unset", variables: [name], looked_at: [join(p.dir, ".env")] });
      expect((r as { message: string }).message).toContain(`${join(p.dir, file)} holds a line for it, but the CLI does not read that file: run the same command with --env-file ${join(p.dir, file)} to use it.\nOr ask the owner to add this line to`);
      expect(readConnection(p.root, urlSource("lake", name), more, { ...lookup, envFile: file }).values[name]).toBe(name === "ONLY_LOCAL" ? "l$HOME" : "t$HOME");
    }
    rmSync(join(p.dir, ".env.local"));
    rmSync(join(p.dir, ".env.test.local"));
    // A named file now comes before the working directory's .env, which Bun's loading had put first.
    writeFileSync(join(p.elsewhere, "named.env"), "LAKE_URL=from-named\n");
    expect(readConnection(p.root, urlSource(), env, { cwd: p.dir, envFile: join(p.elsewhere, "named.env") }).values.LAKE_URL).toBe("from-named");
  });

  test("bun sl.ts: .env.local and a mode's file are Bun's, not the lookup's: never \"the environment\", never ahead of a named file", () => {
    const setup = ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "LAKE_"];
    for (const file of [".env.local", ".env.development", ".env.development.local"]) {
      const p = project();
      const loaded = join(p.dir, file);
      writeFileSync(loaded, "LAKE_HOST=/nonexistent/loaded$$HOME\nLAKE_USER=reader\nLAKE_DATABASE=acme\n");
      // Alone, the file sets nothing for the lookup: the message names it and the flag that reads it.
      const alone = spawnCli(p.dir, setup);
      expect(alone.code).toBe(1);
      expect(alone.err).not.toContain("from the environment");
      expect(alone.err).toContain(`LAKE_HOST, LAKE_USER and LAKE_DATABASE are not set. Looked in the environment, then in ${join(p.dir, ".env")} (no such file).`);
      expect(alone.err).toContain(`${loaded} holds a line for these, but the CLI does not read that file: run the same command with --env-file ${loaded} to use it.\nOr ask the owner to add these lines to ${join(p.dir, ".env")}`);
      // Named, it is read as written.
      const named = spawnCli(p.dir, [...setup, "--env-file", file]);
      expect(named.err).toContain(`cannot reach the database at /nonexistent/loaded$$HOME port 5432 (LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${loaded})`);
      // Another named file, and the .env beside the root, come before it.
      writeFileSync(join(p.dir, "named.env"), "LAKE_HOST=/nonexistent/named\nLAKE_USER=reader\nLAKE_DATABASE=acme\n");
      expect(spawnCli(p.dir, [...setup, "--env-file", "named.env"]).err).toContain(`cannot reach the database at /nonexistent/named port 5432 (LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${join(p.dir, "named.env")})`);
      writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/dot-env\nLAKE_USER=reader\nLAKE_DATABASE=acme\n");
      expect(spawnCli(p.dir, setup).err).toContain(`cannot reach the database at /nonexistent/dot-env port 5432 (LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")})`);
      // A variable really set in the shell still wins (decision HD3).
      expect(spawnCli(p.dir, setup, { LAKE_HOST: "/nonexistent/from-the-shell" }).err).toContain("cannot reach the database at /nonexistent/from-the-shell port 5432 (LAKE_HOST from the environment;");
    }
    // NODE_ENV picks the mode's file; .env.local is not loaded under test.
    const p = project();
    writeFileSync(join(p.dir, ".env.production"), "LAKE_HOST=/nonexistent/production$$HOME\nLAKE_USER=reader\nLAKE_DATABASE=acme\n");
    const production = spawnCli(p.dir, setup, { NODE_ENV: "production" });
    expect(production.err).not.toContain("from the environment");
    expect(production.err).toContain(`${join(p.dir, ".env.production")} holds a line for these`);
  });

  test("bun sl.ts: pa$$HOME reaches the driver unchanged from a .env in the working directory and from --env-file", () => {
    const p = project();
    // The host is a socket directory that does not exist, so the message that names it needs no network.
    const lines = "export LAKE_HOST=/nonexistent/pa$$HOME\nLAKE_PORT=6543\nLAKE_USER=reader\nLAKE_DATABASE=acme\n";
    const setup = ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "LAKE_"];
    writeFileSync(join(p.dir, ".env"), lines);
    const here = spawnCli(p.dir, setup);
    expect(here.code).toBe(1);
    expect(here.err).toContain(`Connection for source "lake": LAKE_HOST, LAKE_PORT, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")}`);
    expect(here.err).toContain(`cannot reach the database at /nonexistent/pa$$HOME port 6543 (LAKE_HOST, LAKE_PORT, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")})`);

    writeFileSync(join(p.elsewhere, "named.env"), lines);
    rmSync(join(p.dir, ".env"));
    const named = spawnCli(p.elsewhere, [...setup, "--root", p.root, "--env-file", "named.env"]);
    expect(named.err).toContain(`from ${join(p.elsewhere, "named.env")}`);
    expect(named.err).toContain("cannot reach the database at /nonexistent/pa$$HOME port 6543 (LAKE_HOST");

    // A variable really set in the shell wins over the working directory's .env (decision HD3).
    writeFileSync(join(p.dir, ".env"), lines);
    const shell = spawnCli(p.dir, setup, { LAKE_HOST: "/nonexistent/from-the-shell" });
    expect(shell.err).toContain(`LAKE_HOST from the environment; LAKE_PORT, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")}`);
    expect(shell.err).toContain("cannot reach the database at /nonexistent/from-the-shell port 6543 (LAKE_HOST from the environment;");
  });

  test("--root from another directory finds the .env beside the root", () => {
    const p = project();
    writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/beside-root\nLAKE_USER=reader\nLAKE_DATABASE=acme\n");
    const r = spawnCli(p.elsewhere, ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "LAKE_", "--root", p.root]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Connection for source "lake": LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")}`);
    expect(r.err).toContain(`cannot reach the database at /nonexistent/beside-root port 5432 (LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")})`);
    // SEMANTIC_ROOT points at the root the same way.
    const viaEnv = spawnCli(p.elsewhere, ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "LAKE_"], { SEMANTIC_ROOT: p.root });
    expect(viaEnv.err).toContain("cannot reach the database at /nonexistent/beside-root port 5432");
  });
});

describe("the prefix form", () => {
  test("the parts go to the driver as options, the password as written, and no URL is built", () => {
    const p = project();
    writeFileSync(join(p.dir, ".env"), `PGHOST=db.internal\nPGPORT=6432\nPGUSER=${USER}\nPGPASSWORD='${PASSWORD}'\nPGDATABASE=acme\nPGSSLMODE=require\n`);
    const { values } = readConnection(p.root, prefixSource("PG"), {}, { cwd: p.elsewhere });
    const conn = driverConnection(prefixSource("PG"), values, 5000);
    expect(conn.options).toEqual({
      adapter: "postgres",
      max: 1,
      prepare: false,
      connection: { default_transaction_read_only: "on", statement_timeout: 5000, TimeZone: "UTC" },
      hostname: "db.internal",
      port: 6432,
      username: USER,
      password: expect.any(Function),
      database: "acme",
      tls: "require",
    });
    expect(password(conn)).toBe(PASSWORD);
    expect(conn.options).not.toHaveProperty("url");
    expect(conn.target).toEqual({ host: "db.internal", port: "6432" });
    // An unquoted password keeps its @, # and / too.
    writeFileSync(join(p.dir, ".env"), "LAKE_HOST=h\nLAKE_USER=u\nLAKE_PASSWORD=p@ss#w/rd\nLAKE_DATABASE=d\n");
    const lake = driverConnection(prefixSource("LAKE_"), readConnection(p.root, prefixSource("LAKE_"), {}, {}).values, 5000);
    expect(lake.options).toMatchObject({ hostname: "h", port: 5432, username: "u", database: "d", tls: "disable" });
    expect(password(lake)).toBe("p@ss#w/rd");
  });

  test("without <PREFIX>PASSWORD the driver holds an empty password, whatever PGPASSWORD, DATABASE_URL and POSTGRES_URL say", () => {
    // The driver reads these from the real process environment and puts them in place of an empty password.
    const ambient = { PGPASSWORD: "other-pg-secret", DATABASE_URL: "postgres://app:app-db-secret@prod.internal:5432/app", POSTGRES_URL: "postgres://app:app-pg-secret@prod.internal:5432/app" };
    const before = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    try {
      const parts = { LAKE_HOST: "db.internal", LAKE_USER: USER, LAKE_DATABASE: "acme" };
      const none = driverConnection(prefixSource("LAKE_"), parts, 5000);
      expect(password(none)).toBe("");
      expect(none.sql.options).toMatchObject({ hostname: "db.internal", port: 5432, username: USER, database: "acme" });
      expect(password(driverConnection(prefixSource("LAKE_"), { ...parts, LAKE_PASSWORD: PASSWORD }, 5000))).toBe(PASSWORD);
      // The driver's own behaviour this guards against: a plain empty password is replaced.
      expect(new SQL({ adapter: "postgres", hostname: "db.internal", username: USER, database: "acme", password: "" }).options.password).not.toBe("");
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("bun sl.ts: the password on the wire is the source's own, as written, or empty; never one from the working directory's .env", async () => {
    const p = project();
    initRoot(p.root, prefixSource("LAKE_"));
    const server = fakePostgres();
    try {
      // An application's .env: its own database URL and libpq password sit beside the source's parts.
      const app = "DATABASE_URL=postgres://app:app-db-secret@prod.internal:5432/app\nPGPASSWORD=other-pg-secret\n";
      const parts = `LAKE_HOST=127.0.0.1\nLAKE_PORT=${server.port}\nLAKE_USER=${USER}\nLAKE_DATABASE=acme\n`;
      writeFileSync(join(p.dir, ".env"), app + parts);
      const none = await spawnCliAsync(p.dir, ["run", "--source", "lake", "--sql", "select 1"]);
      expect(server.seen).toEqual([`startup:user=${USER},database=acme`, "password:"]);
      // Any other refusal: the driver's words scrubbed, and what to do next.
      expect(none.err).toContain(
        `sl run: Source "lake": cannot connect to the database at 127.0.0.1 port ${server.port} (LAKE_HOST, LAKE_PORT, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")}): ` +
          'password authentication failed for user "[redacted]". Ask the owner to check the values of those variables, then run the same command again.',
      );

      server.seen.length = 0;
      writeFileSync(join(p.dir, ".env"), `${app}${parts}LAKE_PASSWORD='${PASSWORD}'\n`);
      const given = await spawnCliAsync(p.dir, ["run", "--source", "lake", "--sql", "select 1"]);
      expect(server.seen).toEqual([`startup:user=${USER},database=acme`, `password:${PASSWORD}`]);
      for (const text of [none.err, none.out, given.err, given.out]) for (const secret of ["app-db-secret", "other-pg-secret", "p@ss", USER]) expect(text).not.toContain(secret);

      // A server without TLS, asked for it: how to turn it off.
      server.seen.length = 0;
      writeFileSync(join(p.dir, ".env"), `${parts}LAKE_SSLMODE=require\n`);
      const tls = await spawnCliAsync(p.dir, ["run", "--source", "lake", "--sql", "select 1"]);
      expect(server.seen).toEqual(["ssl request"]);
      expect(tls.err).toContain(`the database at 127.0.0.1 port ${server.port} (LAKE_HOST, LAKE_PORT, LAKE_USER, LAKE_DATABASE, LAKE_SSLMODE from ${join(p.dir, ".env")}) does not take encrypted connections. Ask the owner to set LAKE_SSLMODE=disable, or take that line out, then run the same command again.`);
    } finally {
      server.stop();
    }
  });

  test("a port or an SSL mode that cannot be one is refused without echoing a secret", () => {
    const parts = { XHOST: "h", XUSER: "u", XDATABASE: "d", XPASSWORD: PASSWORD };
    expect(() => driverConnection(prefixSource("X"), { ...parts, XPORT: "54x" }, 1)).toThrow('Source "lake": XPORT must be a port number such as 5432');
    expect(() => driverConnection(prefixSource("X"), { ...parts, XSSLMODE: "yes" }, 1)).toThrow("XSSLMODE must be one of disable, allow, prefer, require, verify-ca, verify-full");
  });

  test("sl setup --env-prefix writes connection.env_prefix; --env with it, and another dialect, are refused", async () => {
    const p = project();
    const both = await cli(p.dir, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL", "--env-prefix", "LAKE_"]);
    expect(both.code).toBe(1);
    expect(both.err).toContain("a source has one or the other. Run sl setup again with one of them.");
    const duck = await cli(p.dir, ["setup", "--source", "lake", "--dialect", "duckdb", "--env-prefix", "LAKE_"]);
    expect(duck.err).toContain("--env-prefix names the parts of a postgres connection");
    const value = await cli(p.dir, ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "postgres://u:secret-pw@h/db"]);
    expect(value.err).toContain("--env-prefix takes the start of the variable names, not a value");
    expect(value.err).not.toContain("secret-pw");
    expect(existsSync(p.root)).toBe(false);
  });

  test.skipIf(!PG_URL)("connects to live Postgres from the parts, and --env then replaces the prefix", async () => {
    assertLocalPg(PG_URL);
    const url = new URL(PG_URL!);
    const p = project();
    const schema = uniqueSchema("sl_env");
    const db = new SQL({ url: PG_URL!, max: 1 });
    await db.unsafe(`create schema ${schema}; create table ${schema}.orders (id int primary key, total numeric)`);
    try {
      await live(p, url, schema);
    } finally {
      await db.unsafe(`drop schema ${schema} cascade`);
      await db.close();
    }
  });

  async function live(p: ReturnType<typeof project>, url: URL, schema: string): Promise<void> {
    // The private cluster listens on a unix socket: the host is its directory. Its local auth is trust,
    // so the password is sent as written but cannot be proven right here.
    writeFileSync(
      join(p.dir, ".env"),
      `H4_HOST=${url.searchParams.get("host")}\nH4_PORT=${url.port}\nH4_USER=${decodeURIComponent(url.username)}\nH4_PASSWORD='${PASSWORD}'\nH4_DATABASE=${url.pathname.slice(1)}\nLAKE_URL=${PG_URL}\n`,
    );
    const setup = await cli(p.elsewhere, ["setup", "--source", "lake", "--dialect", "postgres", "--env-prefix", "H4_", "--schemas", schema, "--root", p.root, "--json"]);
    // With --json the place is in the output, and stderr holds only the warning about the test server's superuser.
    expect(setup.err).not.toContain("Connection for source");
    expect(setup.code).toBe(0);
    const json = JSON.parse(setup.out) as { connection_from: unknown; snapshot: { read: boolean; tables: number }; source: { changes: { connection: string[] } } };
    expect(json.connection_from).toEqual({ kind: "env_file", path: join(p.dir, ".env") });
    expect(json.snapshot.read).toBe(true);
    expect(json.snapshot.tables).toBe(1);
    expect(json.source.changes.connection).toEqual(["env_prefix"]);
    expect(loadSource(p.root, "lake").connection).toEqual({ env_prefix: "H4_" });
    for (const text of [setup.out, setup.err, readFileSync(join(p.root, "sources", "lake.yaml"), "utf8"), readFileSync(join(p.root, "snapshots", "lake.json"), "utf8")]) {
      expect(text).not.toContain("p@ss");
    }

    // Every command that connects says where the connection came from: one line, or connection_from with --json.
    const plain = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select current_database() as db", "--root", p.root]);
    expect(plain.code).toBe(0);
    expect(plain.err.split("\n")[0]).toBe(`Connection for source "lake": H4_HOST, H4_PORT, H4_USER, H4_PASSWORD, H4_DATABASE from ${join(p.dir, ".env")}`);
    expect(plain.out).not.toContain("Connection for source");
    const run = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select current_database() as db", "--root", p.root, "--json"]);
    expect(run.code).toBe(0);
    expect((JSON.parse(run.out) as { connection_from: unknown; row_count: number }).connection_from).toEqual({ kind: "env_file", path: join(p.dir, ".env") });
    expect(run.out).toStartWith('{\n  "columns": [');

    // The URL form from the same file, then from the process, which wins.
    const viaUrl = await cli(p.elsewhere, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL", "--root", p.root]);
    expect(viaUrl.code).toBe(0);
    expect(loadSource(p.root, "lake").connection).toEqual({ env: "LAKE_URL" });
    expect(viaUrl.err).toContain(`Connection for source "lake": LAKE_URL from ${join(p.dir, ".env")}`);
    expect(viaUrl.err).not.toContain(PG_URL!);
    const fromProcess = await cli(p.elsewhere, ["introspect", "--source", "lake", "--root", p.root, "--json"], { LAKE_URL: PG_URL });
    expect(fromProcess.code).toBe(0);
    expect(fromProcess.err).not.toContain("Connection for source");
    expect((JSON.parse(fromProcess.out) as { connection_from: unknown }).connection_from).toEqual({ kind: "environment" });

    // The libpq form of a socket URL, with no host before the path, connects: the driver reads the URL.
    const socketUrl = `postgres://${url.username}@/${url.pathname.slice(1)}?host=${url.searchParams.get("host")}&port=${url.port}`;
    expect(URL.canParse(socketUrl)).toBe(false);
    const socket = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select 1 as one", "--root", p.root, "--json"], { LAKE_URL: socketUrl });
    expect(socket.err).not.toContain("does not hold a valid");
    expect(socket.code).toBe(0);
    expect((JSON.parse(socket.out) as { rows: unknown[] }).rows).toEqual([{ one: 1 }]);
  }
});

describe("messages", () => {
  // No message may hold the password, the user name or the URL they came in.
  function expectNoCredential(text: string): void {
    for (const secret of [PASSWORD, "p@ss", "p%40ss", USER, `${USER}:`]) expect(text).not.toContain(secret);
  }

  test("an unset URL variable: the variable, the files looked at and the line to add", async () => {
    const p = project();
    initRoot(p.root, urlSource());
    // Another variable of the file holds a password, which no message repeats.
    writeFileSync(join(p.elsewhere, ".env"), `OTHER_URL=postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal:5432/acme\n`);
    const r = resolveConnection(p.root, urlSource(), {}, { cwd: p.elsewhere });
    expect(r).toEqual({
      status: "unset",
      variables: ["LAKE_URL"],
      looked_at: [join(p.dir, ".env"), join(p.elsewhere, ".env")],
      line_to_add: "LAKE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require",
      add_to: join(p.dir, ".env"),
      message:
        `Source "lake": LAKE_URL is not set. Looked in the environment, then in ${join(p.dir, ".env")} (no such file), ${join(p.elsewhere, ".env")} (not set there).\n` +
        `Ask the owner to add this line to ${join(p.dir, ".env")} with the real values in place of each <...> (the values stay out of the chat), or to set the variable in the shell, then run the same command again:\n` +
        "  LAKE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require",
    });
    const run = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select 1", "--root", p.root]);
    expect(run.code).toBe(1);
    expect(run.err).toBe(`sl run: ${(r as { message: string }).message}`);
    expectNoCredential(run.err);
    // With a named file, the line goes there.
    const named = resolveConnection(p.root, urlSource(), {}, { cwd: p.elsewhere, envFile: ".env" });
    expect(named).toMatchObject({ status: "unset", add_to: join(p.elsewhere, ".env"), looked_at: [join(p.elsewhere, ".env"), join(p.dir, ".env")] });
  });

  test("unset parts of a prefix: every line for a fresh start, else only the missing ones", () => {
    const p = project();
    const fresh = resolveConnection(p.root, prefixSource("PG"), {}, {});
    expect(fresh).toMatchObject({
      status: "unset",
      variables: ["PGHOST", "PGUSER", "PGDATABASE"],
      line_to_add: "PGHOST=<host>\nPGPORT=5432\nPGUSER=<user>\nPGPASSWORD=<password>\nPGDATABASE=<database>\nPGSSLMODE=require",
    });
    expect((fresh as { message: string }).message).toContain('Source "lake": PGHOST, PGUSER and PGDATABASE are not set.');
    expect((fresh as { message: string }).message).toContain(`Ask the owner to add these lines to ${join(p.dir, ".env")}`);
    writeFileSync(join(p.dir, ".env"), `LAKE_HOST=db.internal\nLAKE_USER=${USER}\nLAKE_PASSWORD='${PASSWORD}'\n`);
    const partial = resolveConnection(p.root, prefixSource("LAKE_"), {}, {});
    expect(partial).toMatchObject({ status: "unset", variables: ["LAKE_DATABASE"], line_to_add: "LAKE_DATABASE=<database>" });
    expect((partial as { message: string }).message).toContain(`LAKE_DATABASE is not set. Looked in the environment, then in ${join(p.dir, ".env")} (not set there).`);
    expectNoCredential(JSON.stringify(partial));
  });

  test("sl setup with an unset variable writes nothing under the root, and the .gitignore lines first", async () => {
    const p = project();
    const r = await cli(p.dir, ["setup", "--source", "lake", "--dialect", "postgres", "--env", "LAKE_URL"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Source "lake": LAKE_URL is not set. Looked in the environment, then in ${join(p.dir, ".env")} (no such file).`);
    expect(r.err).toContain("  LAKE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require");
    expect(r.err).toContain("so nothing was written under the semantic root.");
    expect(existsSync(p.root)).toBe(false);
    expect(readFileSync(join(p.dir, ".gitignore"), "utf8")).toContain(".env\n.env.*\n!.env.example\n");
  });

  test("an unreachable server: its host and port, and the network path to check", async () => {
    const p = project();
    initRoot(p.root, urlSource());
    // Port 1 on this machine refuses at once.
    writeFileSync(join(p.dir, ".env"), `LAKE_URL=postgres://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/acme\n`);
    const url = await cli(p.elsewhere, ["run", "--source", "lake", "--sql", "select 1", "--root", p.root]);
    expect(url.code).toBe(1);
    expect(url.err).toContain(
      `sl run: Source "lake": cannot reach the database at 127.0.0.1 port 1 (LAKE_URL from ${join(p.dir, ".env")}). Check the host and port with the owner, and the network path from this machine: ` +
        "a VPN that must be on, or an allowlist that must include this machine's address. Then run the same command again.",
    );
    expect(url.err.split("\n")[0]).toBe(`Connection for source "lake": LAKE_URL from ${join(p.dir, ".env")}`);
    expectNoCredential(url.err + url.out);

    writeYaml(join(p.root, "sources", "lake.yaml"), prefixSource("LAKE_"));
    writeFileSync(join(p.dir, ".env"), `LAKE_HOST=127.0.0.1\nLAKE_PORT=1\nLAKE_USER=${USER}\nLAKE_PASSWORD='${PASSWORD}'\nLAKE_DATABASE=acme\n`);
    const parts = await cli(p.elsewhere, ["introspect", "--source", "lake", "--root", p.root]);
    expect(parts.code).toBe(1);
    expect(parts.err).toContain('Source "lake": cannot reach the database at 127.0.0.1 port 1 (LAKE_HOST, LAKE_PORT, LAKE_USER, LAKE_PASSWORD, LAKE_DATABASE from');
    expect(parts.err).toContain("Check the host and port with the owner");
    expectNoCredential(parts.err + parts.out);
    // A timeout reads the same.
    const timeout = connectFailure("lake", Object.assign(new Error("Connection timed out"), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }), driverConnection(urlSource(), { LAKE_URL: "postgres://u:p@db.internal/acme" }, 1), "LAKE_URL from the environment");
    expect(timeout.message).toContain("cannot reach the database at db.internal port 5432 (LAKE_URL from the environment). Check");
  });

  test("a server that requires SSL: add sslmode=require, or <PREFIX>SSLMODE=require", () => {
    const refused = (host: string) => Object.assign(new Error(`no pg_hba.conf entry for host "${host}", user "${USER}", database "acme", no encryption`), { code: "ERR_POSTGRES_SERVER_ERROR" });
    const url = connectFailure("lake", refused("10.0.0.7"), driverConnection(urlSource(), { LAKE_URL: `postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal:6432/acme` }, 1), "LAKE_URL from /work/.env");
    expect(url.message).toBe(
      'Source "lake": the database at db.internal port 6432 (LAKE_URL from /work/.env) accepts only encrypted connections. Ask the owner to add sslmode=require to the URL in LAKE_URL (it then ends ?sslmode=require), then run the same command again.',
    );
    const parts = connectFailure("lake", refused("10.0.0.7"), driverConnection(prefixSource("PG"), { PGHOST: "db.internal", PGUSER: USER, PGPASSWORD: PASSWORD, PGDATABASE: "acme" }, 1), "PGHOST from the environment");
    expect(parts.message).toBe(
      'Source "lake": the database at db.internal port 5432 (PGHOST from the environment) accepts only encrypted connections. Ask the owner to add the line PGSSLMODE=require beside PGHOST, then run the same command again.',
    );
    for (const m of [url.message, parts.message]) expectNoCredential(m);
    // Other servers' words for the same refusal.
    for (const text of ['no pg_hba.conf entry for host "h", user "u", database "d", SSL off', "SSL connection is required. Please specify SSL options and retry.", "connection is insecure (try using `sslmode=require`)"]) {
      expect(connectFailure("lake", new Error(text), driverConnection(urlSource(), { LAKE_URL: "postgres://u@h/d" }, 1), "LAKE_URL from the environment").message).toContain("accepts only encrypted connections");
    }
  });

  test("any other driver message has the password and the user name scrubbed", () => {
    const text = `password authentication failed for user "${USER}" (tried ${PASSWORD} at postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal/acme)`;
    const url = connectFailure("lake", new Error(text), driverConnection(urlSource(), { LAKE_URL: `postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal/acme` }, 1), "LAKE_URL from the environment");
    expect(url.message).toStartWith('Source "lake": cannot connect to the database at db.internal port 5432 (LAKE_URL from the environment): password authentication failed for user "[redacted]"');
    expectNoCredential(url.message);
    const parts = connectFailure("lake", new Error(text), driverConnection(prefixSource("PG"), { PGHOST: "db.internal", PGUSER: USER, PGPASSWORD: PASSWORD, PGDATABASE: "acme" }, 1), "PGHOST from the environment");
    expectNoCredential(parts.message);
  });

  test("the URL is the driver's to read: the server it names is the one it connects to, and a value it refuses is never echoed", () => {
    const read = (url: string) => driverConnection(urlSource(), { LAKE_URL: url }, 1);
    const enc = encodeURIComponent(PASSWORD);
    // A unix socket, with and without a host before the path; ?host= and ?port= win, as in the driver.
    expect(read(`postgres://${USER}:${enc}@/acme?host=/var/run/postgresql`).target).toEqual({ host: "/var/run/postgresql", port: "5432" });
    expect(read(`postgres://${USER}@localhost:6543/acme?host=/tmp/pg`).target).toEqual({ host: "/tmp/pg", port: "6543" });
    expect(read(`postgresql://${USER}:${enc}@db.internal/acme?host=other.internal&port=7777`).target).toEqual({ host: "other.internal", port: "7777" });
    // The scrub list holds the password as the driver uses it and as the URL writes it.
    const conn = read(`postgres://${USER}:${enc}@db.internal/acme`);
    expect(conn.secrets).toEqual([`postgres://${USER}:${enc}@db.internal/acme`, PASSWORD, enc]);
    expect(conn.users).toEqual([USER, USER]);
    expect(password(conn)).toBe(PASSWORD);

    // A URL the driver refuses (a password with a bare /) is named by its variable, with what to do.
    for (const bad of [`postgres://${USER}:pa/${PASSWORD}@db.internal/acme`, " "]) {
      let message = "";
      try {
        read(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(
        'Source "lake": LAKE_URL does not hold a valid Postgres connection URL. It reads like postgres://<user>:<password>@<host>:5432/<database>?sslmode=require, ' +
          "with any @, / or # of the password percent-encoded (sl setup --env-prefix takes a password as written); ask the owner to correct it, then run the same command again.",
      );
    }
    // Of a value that does not start as a Postgres URL the driver makes a host: no message names it.
    for (const pasted of [PASSWORD, "hunter2secret", `${USER}:${enc}@db.internal:5432/acme`]) {
      const loose = read(pasted);
      expect(loose.target).toEqual({ host: "the host LAKE_URL names", port: "" });
      const refusedAt = connectFailure("lake", Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" }), loose, "LAKE_URL from /work/.env").message;
      expect(refusedAt).toStartWith('Source "lake": cannot reach the database at the host LAKE_URL names (LAKE_URL from /work/.env). Check the host and port');
      expectNoCredential(refusedAt);
      expect(refusedAt).not.toContain("hunter2");
      expectNoCredential(connectFailure("lake", new Error(`could not connect with ${pasted}`), loose, "LAKE_URL from /work/.env").message);
    }
  });

  test("a server without TLS, and any other refusal, say what to do next", () => {
    const noTls = Object.assign(new Error("Server does not support SSL"), { code: "ERR_POSTGRES_TLS_NOT_AVAILABLE" });
    const url = driverConnection(urlSource(), { LAKE_URL: `postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal/acme?sslmode=require` }, 1);
    expect(connectFailure("lake", noTls, url, "LAKE_URL from /work/.env").message).toBe(
      'Source "lake": the database at db.internal port 5432 (LAKE_URL from /work/.env) does not take encrypted connections. Ask the owner to take sslmode out of the URL in LAKE_URL, then run the same command again.',
    );
    const other = connectFailure("lake", new Error(`database "nope" does not exist.`), url, "LAKE_URL from /work/.env").message;
    expect(other).toBe(
      'Source "lake": cannot connect to the database at db.internal port 5432 (LAKE_URL from /work/.env): database "nope" does not exist. Ask the owner to check the values of those variables, then run the same command again.',
    );
  });
});

describe(".gitignore beside the semantic root", () => {
  const LINES = ".env\n.env.*\n!.env.example\n";

  test("sl init writes the lines, once, and nothing else outside the root (invariant 6)", async () => {
    const p = project();
    expect((await cli(p.dir, ["init", "--name", "acme"])).code).toBe(0);
    const file = join(p.dir, ".gitignore");
    const first = readFileSync(file, "utf8");
    expect(first).toBe(`# Env files hold connection secrets; sl init and sl setup keep them out of version control.\n${LINES}`);
    // The directory that holds the root gains that one file and the root; the root keeps its own .gitignore.
    expect(readdirSync(p.dir).sort()).toEqual([".gitignore", "semantic"]);
    expect(readFileSync(join(p.root, ".gitignore"), "utf8")).toContain(".sl/plans/");
    ignoreEnvFiles(p.root);
    expect(readFileSync(file, "utf8")).toBe(first);
  });

  test("an existing .gitignore keeps its lines and gains only the ones it lacks", async () => {
    const p = project();
    const file = join(p.dir, ".gitignore");
    writeFileSync(file, "# the owner's\nnode_modules/\n.env");
    expect((await cli(p.dir, ["setup", "--source", "lake", "--dialect", "duckdb", "--database", ":memory:"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# the owner's\nnode_modules/\n.env\n.env.*\n!.env.example\n");
    expect((await cli(p.dir, ["setup", "--source", "lake", "--dialect", "duckdb", "--database", ":memory:"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# the owner's\nnode_modules/\n.env\n.env.*\n!.env.example\n");
    expect(readdirSync(p.dir).sort()).toEqual([".gitignore", "semantic"]);
    // The exception is written again after the pattern it excepts.
    writeFileSync(file, "!.env.example\n.env\n");
    ignoreEnvFiles(p.root);
    expect(readFileSync(file, "utf8")).toBe("!.env.example\n.env\n.env.*\n!.env.example\n");
  });

  test("git ignores .env and .env.local and keeps .env.example", () => {
    const p = project();
    ignoreEnvFiles(p.root);
    if (Bun.spawnSync(["git", "init", "-q"], { cwd: p.dir }).exitCode !== 0) return;
    const ignored = (name: string) => Bun.spawnSync(["git", "check-ignore", "-q", name], { cwd: p.dir }).exitCode === 0;
    expect([ignored(".env"), ignored(".env.local"), ignored(".env.example")]).toEqual([true, true, false]);
  });
});

describe("sl validate", () => {
  test("an env file under the semantic root is an error; .env.example is not", async () => {
    const p = project();
    initRoot(p.root, urlSource());
    expect(validateProject(p.root).filter((i) => i.level === "error")).toEqual([]);
    writeFileSync(join(p.root, ".env"), "LAKE_URL=x\n");
    writeFileSync(join(p.root, "sources", ".env.local"), "LAKE_URL=x\n");
    writeFileSync(join(p.root, ".env.example"), "LAKE_URL=\n");
    const errors = validateProject(p.root).filter((i) => i.level === "error");
    expect(errors.map((e) => e.file)).toEqual([".env", "sources/.env.local"]);
    expect(errors[0]!.message).toBe(
      `an env file inside the semantic root, where no secret is kept: move it to ${join(p.dir, ".env")} (sl reads it there and keeps it out of version control), then run sl validate again`,
    );
    const r = await cli(p.dir, ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(".env\n  error   an env file inside the semantic root");
  });

  test("an env file the lookup reads that git tracks is an error; untracked, or outside a repository, it is not", async () => {
    const p = project();
    initRoot(p.root, urlSource());
    writeFileSync(join(p.dir, ".env"), "LAKE_URL=x\n");
    writeFileSync(join(p.elsewhere, "named.env"), "LAKE_URL=y\n");
    // No repository: skipped quietly.
    expect((await cli(p.dir, ["validate", "--json"])).out).toContain('"ok": true');
    const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).exitCode;
    if (git(p.dir, "init", "-q") !== 0) return;
    // In a repository but not tracked.
    expect((await cli(p.dir, ["validate"])).code).toBe(0);
    expect(git(p.dir, "add", "-f", ".env")).toBe(0);
    const tracked = await cli(p.dir, ["validate", "--json"]);
    expect(tracked.code).toBe(1);
    expect((JSON.parse(tracked.out) as { issues: unknown[] }).issues).toEqual([
      {
        level: "error",
        file: "../.env",
        path: "",
        message: `git tracks this env file, so the secrets in it are in the repository: run git -C ${p.dir} rm --cached .env and commit, have the owner rotate the credentials it held, then run sl validate again (sl setup keeps .env out of version control)`,
      },
    ]);
    // The named file is checked in its own repository.
    expect(git(p.dir, "rm", "-q", "--cached", ".env")).toBe(0);
    expect(git(p.elsewhere, "init", "-q")).toBe(0);
    expect(git(p.elsewhere, "add", "named.env")).toBe(0);
    expect((await cli(p.dir, ["validate"])).code).toBe(0);
    const named = await cli(p.dir, ["validate", "--env-file", join(p.elsewhere, "named.env")]);
    expect(named.code).toBe(1);
    expect(named.out).toContain("../../elsewhere/named.env\n  error   git tracks this env file");
  });

  test("a connection has env or env_prefix, not both", () => {
    const p = project();
    initRoot(p.root, { source: "lake", dialect: "postgres", connection: { env: "LAKE_URL", env_prefix: "LAKE_" } });
    expect(validateProject(p.root).filter((i) => i.level === "error")).toEqual([
      {
        level: "error",
        file: "sources/lake.yaml",
        path: "connection",
        message: "has both env and env_prefix; a source names one variable that holds the URL or a prefix for the parts, not both: keep one (sl setup --source lake --dialect postgres --env <VAR> or --env-prefix <PREFIX> writes it)",
      },
    ]);
    writeYaml(join(p.root, "sources", "lake.yaml"), prefixSource("LAKE_"));
    expect(validateProject(p.root)).toEqual([]);
    writeYaml(join(p.root, "sources", "lake.yaml"), { source: "lake", dialect: "postgres", connection: { env_prefix: "not a prefix" } });
    expect(validateProject(p.root).filter((i) => i.level === "error").map((i) => i.path)).toEqual(["connection.env_prefix"]);
  });

  test("sl setup's edit sets one of env and env_prefix and removes the other, keeping the rest of the file", () => {
    const before = "# the owner's file\nsource: lake\ndialect: postgres\nconnection:\n  env: LAKE_URL\nintake:\n  mode: connection # kept\n";
    const prefixed = editYamlText(before, (doc) => applySourceState(doc, { envPrefix: "LAKE_", mode: "connection" }), "sources/lake.yaml");
    expect(prefixed).toBe("# the owner's file\nsource: lake\ndialect: postgres\nconnection:\n  env_prefix: LAKE_\nintake:\n  mode: connection # kept\n");
    expect(editYamlText(prefixed, (doc) => applySourceState(doc, { env: "LAKE_URL", mode: "connection" }), "sources/lake.yaml")).toBe(before);
  });
});

describe("the MCP server", () => {
  const call = (server: Server, id: number, name: string, args: Record<string, unknown>) =>
    server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as Promise<{ result: { content: { text: string }[]; isError?: true } }>;
  const text = (r: { result: { content: { text: string }[] } }) => r.result.content.map((c) => c.text).join("\n");

  test("a .env written after the server started is read by the next call", async () => {
    const p = project();
    initRoot(p.root, prefixSource("LAKE_"));
    const server = new Server({ root: p.root, cwd: p.dir, env: processEnvironment({ SL_NOW: FIXED_NOW }, p.dir), log: () => {} });
    const before = await call(server, 1, "sl_run", { source: "lake", sql: "select 1" });
    expect(before.result.isError).toBe(true);
    expect(text(before)).toContain("LAKE_HOST, LAKE_USER and LAKE_DATABASE are not set.");
    writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/written-later\nLAKE_USER=u\nLAKE_DATABASE=d\n");
    const after = await call(server, 2, "sl_run", { source: "lake", sql: "select 1" });
    expect(text(after)).toContain(`cannot reach the database at /nonexistent/written-later port 5432 (LAKE_HOST, LAKE_USER, LAKE_DATABASE from ${join(p.dir, ".env")})`);
    // And a change to it by the call after that.
    writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/changed\nLAKE_USER=u\nLAKE_DATABASE=d\n");
    expect(text(await call(server, 3, "sl_run", { source: "lake", sql: "select 1" }))).toContain("cannot reach the database at /nonexistent/changed port 5432");
  });

  test("the server process: a .env Bun loaded at start does not hide the file as it is now", async () => {
    const p = project();
    initRoot(p.root, prefixSource("LAKE_"));
    writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/at-start$$HOME\nLAKE_USER=u\nLAKE_DATABASE=d\n");
    const proc = Bun.spawn([process.execPath, SERVER, "--root", p.root], { cwd: p.dir, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: BARE_ENV });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const ask = async (id: number): Promise<string> => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sl_run", arguments: { source: "lake", sql: "select 1" } } })}\n`);
      proc.stdin.flush();
      while (!buffer.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the server closed its output");
        buffer += decoder.decode(value, { stream: true });
      }
      const line = buffer.slice(0, buffer.indexOf("\n"));
      buffer = buffer.slice(line.length + 1);
      return text(JSON.parse(line) as { result: { content: { text: string }[] } });
    };
    try {
      expect(await ask(1)).toContain("cannot reach the database at /nonexistent/at-start$$HOME port 5432");
      writeFileSync(join(p.dir, ".env"), "LAKE_HOST=/nonexistent/rewritten\nLAKE_USER=u\nLAKE_DATABASE=d\n");
      expect(await ask(2)).toContain("cannot reach the database at /nonexistent/rewritten port 5432");
    } finally {
      proc.stdin.end();
      await proc.exited;
    }
  });

  test.skipIf(!PG_URL)("live: the first call finds no variable, the owner writes .env, the second connects", async () => {
    assertLocalPg(PG_URL);
    const p = project();
    initRoot(p.root, urlSource());
    const server = new Server({ root: p.root, cwd: p.elsewhere, env: { SL_NOW: FIXED_NOW }, log: () => {} });
    const before = await call(server, 1, "sl_run", { source: "lake", sql: "select 41 + 1 as answer" });
    expect(before.result.isError).toBe(true);
    expect(text(before)).toContain("LAKE_URL is not set");
    writeFileSync(join(p.dir, ".env"), `LAKE_URL='${PG_URL}'\n`);
    const after = await call(server, 2, "sl_run", { source: "lake", sql: "select 41 + 1 as answer" });
    expect(after.result.isError).toBeUndefined();
    const json = JSON.parse(after.result.content[0]!.text) as { rows: unknown[]; connection_from: unknown };
    expect(json.rows).toEqual([{ answer: 42 }]);
    expect(json.connection_from).toEqual({ kind: "env_file", path: join(p.dir, ".env") });
    expect(text(after)).not.toContain(PG_URL!);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { SourceConfig } from "../skills/semantic-layer/scripts/lib/types.ts";

export const FIXED_NOW = "2026-01-15T12:00:00.000Z";

export interface CliRun {
  code: number;
  out: string;
  err: string;
  json<T = unknown>(): T;
}

// Runs the CLI in-process against a semantic root, with a fixed clock.
export async function sl(root: string, args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--root", root], {
    cwd: root,
    env: { SL_NOW: FIXED_NOW, ...env },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  const o = out.join("\n");
  return { code, out: o, err: err.join("\n"), json: <T,>() => JSON.parse(o) as T };
}

// A fresh semantic root in a temp directory, removed by the returned cleanup.
export function tempRoot(): { root: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sl-test-"));
  const root = join(dir, "semantic");
  return { root, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Initializes a project and returns its root.
export async function initProject(root: string, name = "test"): Promise<void> {
  const r = await sl(root, ["init", "--name", name]);
  if (r.code !== 0) throw new Error(r.err);
}

// Writes a DuckDB database file built from SQL statements and a source pointing at it.
export async function duckdbSource(root: string, dir: string, name: string, statements: string[]): Promise<SourceConfig> {
  const dbPath = join(dir, `${name}.duckdb`);
  const instance = await DuckDBInstance.create(dbPath);
  const c = await instance.connect();
  for (const s of statements) await c.run(s);
  c.closeSync();
  instance.closeSync();
  const source: SourceConfig = { source: name, dialect: "duckdb", connection: { database: dbPath } };
  writeYaml(join(root, "sources", `${name}.yaml`), source);
  return source;
}

// The Postgres URL for live tests, or undefined to skip them. Start one with scripts/pg-local.sh.
export const PG_URL = process.env.PG_URL;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Whether a Postgres URL reaches a server on this machine: host localhost, 127.0.0.1 or ::1, or a
// unix socket (a host, or a host= query parameter, that is a path starting with "/").
export function isLocalPg(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const queryHost = parsed.searchParams.get("host");
  if (queryHost !== null) return queryHost.startsWith("/") || LOCAL_HOSTS.has(queryHost);
  const host = decodeURIComponent(parsed.hostname);
  return host === "" || host.startsWith("/") || LOCAL_HOSTS.has(host);
}

// Throws unless `url` reaches a local Postgres or SL_TEST_ALLOW_REMOTE=1 is set. Every live test
// calls it before it creates or drops a schema, so the suite never drops schemas in a remote
// database that PG_URL happens to name.
export function assertLocalPg(url: string | undefined, env: Record<string, string | undefined> = process.env): void {
  if (!url) throw new Error("PG_URL is not set.");
  if (env.SL_TEST_ALLOW_REMOTE === "1" || isLocalPg(url)) return;
  throw new Error(
    "PG_URL does not point at localhost, 127.0.0.1, ::1 or a unix socket; live tests create and drop schemas there. " +
      "Point it at a scratch server (scripts/pg-local.sh), or set SL_TEST_ALLOW_REMOTE=1 to run them against it anyway.",
  );
}

// A schema name no other live test uses: the prefix, the process id and a random suffix.
export function uniqueSchema(prefix: string): string {
  return `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

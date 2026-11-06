import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { CHANGED_SINCE_APPROVAL, evaluateAccess } from "../skills/semantic-layer/scripts/lib/access.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import type { CompileResult } from "../skills/semantic-layer/scripts/lib/compiler/index.ts";
import { readYaml, writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
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

// The owner's yes in a test copy: sl approve approves again each of `refs`, by default every approved
// item the access evaluator treats as a draft because it changed since its approval. Throws unless
// each is approved and current afterwards. Returns the refs it approved.
export async function reapprove(root: string, refs: string[] = evaluateAccess(root).changed_since_approval): Promise<string[]> {
  for (const ref of refs) {
    const r = await approveWithYes(root, ["--target", ref, "--by", "Test Owner"]);
    if (r.code !== 0) throw new Error(`sl approve --target ${ref}: ${r.err}`);
  }
  const left = evaluateAccess(root).changed_since_approval.filter((r) => refs.includes(r));
  if (left.length) throw new Error(`still changed since approval: ${left.join(", ")}`);
  return refs;
}

// Asserts that a compile was refused only because the measure or dimension `field` (model.field)
// of `source` changed since its approval, naming the command that approves it again.
export function expectRefusedAsChanged(r: CompileResult, source: string, field: string): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect([...new Set(r.refusals.map((x) => `${x.code} ${x.ref}`))]).toEqual([`not_visible ${field}`]);
  for (const x of r.refusals) expect(x.message).toContain(`${CHANGED_SINCE_APPROVAL} (sl approve --target ${source}.${field} --by "<owner>" after the owner's yes)`);
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

export interface ReplyOptions {
  // The owner who answers (default Dana).
  by?: string;
  // yes (the default), no, change, or null for words without a verdict.
  verdict?: "yes" | "no" | "change" | null;
  // The clock the readback and reply run with (default FIXED_NOW).
  now?: string;
}

// Reads targets back and records the owner's answer to each item, as the skill does before
// sl approve; returns the readback id.
export async function recordReply(root: string, targets: string | string[], opts: ReplyOptions = {}): Promise<string> {
  const env = opts.now ? { SL_NOW: opts.now } : {};
  const rb = await sl(root, ["readback", "--targets", ([] as string[]).concat(targets).join(","), "--json"], env);
  if (rb.code !== 0) throw new Error(rb.err);
  const { readback_id, items } = rb.json<{ readback_id: string; items: { n: number }[] }>();
  const verdict = opts.verdict === undefined ? "yes" : opts.verdict;
  for (const item of items) {
    const args = ["reply", "--readback", readback_id, "--item", String(item.n), "--text", "Yes, that's right.", "--by", opts.by ?? "Dana"];
    if (verdict !== null) args.push("--verdict", verdict);
    const r = await sl(root, args, env);
    if (r.code !== 0) throw new Error(r.err);
  }
  return readback_id;
}

// A model ref and the refs of its dimensions, measures and joins, read from its file.
export function refsUnder(root: string, ref: string): string[] {
  const [source, model] = ref.split(".") as [string, string];
  const m = readYaml<Record<string, { name: string }[] | undefined>>(join(root, "models", source, `${model}.yaml`));
  return [ref, ...(["dimensions", "measures", "joins"] as const).flatMap((k) => (m[k] ?? []).map((f) => `${ref}.${f.name}`))];
}

// sl approve as the skill runs it: first the owner's yes to the target (and, with --recursive, to
// every field of the model) is read back and recorded, by --by (default Dana).
export async function approveWithYes(root: string, args: string[], opts: Omit<ReplyOptions, "verdict"> = {}): Promise<CliRun> {
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const target = at("--target");
  if (target && !args.includes("--revoke")) await recordReply(root, args.includes("--recursive") ? refsUnder(root, target) : target, { by: at("--by")?.trim() || "Dana", ...opts });
  return sl(root, ["approve", ...args]);
}

// sl goldens confirm as the skill runs it: first the golden is read back with the same --tolerance,
// --results and --plan, and the owner's answer recorded, by --by (default Dana). With --emit-sql
// nothing is recorded, so no readback is made.
export async function confirmWithYes(root: string, args: string[], opts: ReplyOptions = {}, env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const name = at("--name");
  if (name && !args.includes("--emit-sql")) {
    const pass = ["--tolerance", "--results", "--plan"].flatMap((f) => (at(f) === undefined ? [] : [f, at(f)!]));
    const rb = await sl(root, ["readback", "--targets", `golden:${name}`, ...pass, "--json"], { ...env, ...(opts.now ? { SL_NOW: opts.now } : {}) });
    if (rb.code === 0) {
      const id = rb.json<{ readback_id: string }>().readback_id;
      const verdict = opts.verdict === undefined ? "yes" : opts.verdict;
      const reply = ["reply", "--readback", id, "--item", "1", "--text", "Yes, those rows match.", "--by", opts.by ?? (at("--by")?.trim() || "Dana")];
      if (verdict !== null) reply.push("--verdict", verdict);
      const r = await sl(root, reply, opts.now ? { SL_NOW: opts.now } : {});
      if (r.code !== 0) throw new Error(r.err);
    }
  }
  return sl(root, ["goldens", "confirm", ...args], env);
}

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canRun, openAdapter, type Adapter } from "../lib/adapters/index.ts";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { commandEnv, envFiles, resolveConnection, setsVariable, trackedEnvFiles } from "../lib/env-file.ts";
import { nextAction } from "../lib/next.ts";
import { formatJson } from "../lib/output.ts";
import { bareSemlayer, PLUGIN_BIN_DIR, PLUGIN_ROOT } from "../lib/plugin-bin.ts";
import { listSourceNames, loadProject, loadSource, paths } from "../lib/project.ts";
import { connectionFacts, factLines, type ConnectionFacts } from "../lib/provider-facts.ts";
import { roleNote } from "../lib/role-sql.ts";
import { actionText, type StepAction } from "../lib/status.ts";
import type { SourceConfig } from "../lib/types.ts";

// What semlayer doctor checks (spec: CLI, semlayer doctor). Every line says what it found in plain words;
// a line that is not ok names the command or the line that fixes it. No line carries a value of a
// connection variable: a connection is described by variable and file names only.
export const MIN_BUN = "1.4.0";
const PACKAGES = ["yaml", "ajv", "@duckdb/node-api"];
// How long the connection check waits, and the statement timeout it gives the database.
const CONNECT_MS = 15_000;
const STATEMENT_MS = 5_000;

type Status = "ok" | "warn" | "fail" | "skip";
interface Check {
  check: string;
  status: Status;
  text: string;
  fix?: string;
  // The tool cannot run until this is fixed: semlayer doctor exits 1.
  blocking?: boolean;
}

// What a Postgres connection reported about its server (lib/provider-facts.ts), by source.
type SourceFacts = ConnectionFacts & { source: string };

const UNKNOWN_FACTS: ConnectionFacts = { server_version: null, server_version_num: null, tls: "unknown", tls_protocol: null, pooled: "unknown" };

const MARK: Record<Status, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]", skip: "[--]  " };
const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
export const INSTALL_COMMAND = `cd ${quote(PLUGIN_ROOT)} && bun install --frozen-lockfile --production`;

export function olderThan(version: string, min: string): boolean {
  const [a, b] = [version, min].map((v) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if (a![i]! !== b![i]!) return a![i]! < b![i]!;
  return false;
}

// The packages no node_modules under `dirs` holds. They are looked for on disk, as bin/semlayer and
// session-start.sh do: Bun's resolver would fall back to its auto-install, which needs the network
// and does not follow bun.lock.
export function missingPackages(dirs: string[] = [join(PLUGIN_ROOT, "skills", "semantic-layer"), PLUGIN_ROOT]): string[] {
  return PACKAGES.filter((p) => !dirs.some((d) => existsSync(join(d, "node_modules", p, "package.json"))));
}

async function runtimeChecks(): Promise<Check[]> {
  const out: Check[] = [];
  out.push(
    olderThan(Bun.version, MIN_BUN)
      ? { check: "bun", status: "fail", text: `Bun ${Bun.version} is older than ${MIN_BUN}, which semlayer needs.`, fix: "bun upgrade, then start a new session", blocking: true }
      : { check: "bun", status: "ok", text: `Bun ${Bun.version} (${MIN_BUN} or later is needed).` },
  );
  const missing = missingPackages();
  let native: string | undefined;
  if (!missing.length) {
    try {
      await import("@duckdb/node-api");
    } catch (e) {
      native = (e as Error).message;
    }
  }
  out.push(
    missing.length || native
      ? {
          check: "packages",
          status: "fail",
          text: missing.length ? `These packages are not installed: ${missing.join(", ")}.` : `DuckDB's native module does not load (${native}).`,
          fix: INSTALL_COMMAND,
          blocking: true,
        }
      : { check: "packages", status: "ok", text: `${PACKAGES.join(", ")} are installed under ${PLUGIN_ROOT}.` },
  );
  return out;
}

// Opens the source's connection read-only and runs one trivial query, with short timeouts.
async function connect(ctx: CommandContext, source: SourceConfig): Promise<{ adapter?: Adapter; error?: string; deadline?: number }> {
  const env = commandEnv(ctx.env, {});
  const set = Number(env.SEMLAYER_STATEMENT_TIMEOUT_MS);
  env.SEMLAYER_STATEMENT_TIMEOUT_MS = String(Number.isInteger(set) && set > 0 ? Math.min(set, STATEMENT_MS) : STATEMENT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CONNECT_MS / 1000} seconds`)), CONNECT_MS);
  });
  let adapter: Adapter | undefined;
  const deadline = Date.now() + CONNECT_MS;
  try {
    adapter = await Promise.race([openAdapter(ctx.root, source, env, { warn: () => {} }), timeout]);
    await Promise.race([adapter.query("select 1 as ok"), timeout]);
    return { adapter, deadline };
  } catch (e) {
    await adapter?.close().catch(() => {});
    return { error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function sourceChecks(ctx: CommandContext, name: string, usedFiles: Set<string>, facts: SourceFacts[]): Promise<Check[]> {
  let source: SourceConfig;
  try {
    source = loadSource(ctx.root, name);
  } catch (e) {
    return [{ check: `source ${name}`, status: "fail", text: (e as Error).message, fix: `fix sources/${name}.yaml as the message says, then semlayer doctor` }];
  }
  const check = `connection ${name}`;
  const named = Boolean(source.connection?.env || source.connection?.env_prefix !== undefined);
  if (source.dialect === "postgres" && !named) {
    return [{ check, status: "skip", text: `Source "${name}" has no connection; it was read from a schema export.`, fix: `semlayer setup --source ${name} --dialect postgres --env <VAR> when a connection is possible` }];
  }
  if (!canRun(source)) return [{ check, status: "skip", text: `Source "${name}" is ${source.dialect}; semlayer does not connect to it, and its queries run through --emit-sql.` }];
  const out: Check[] = [];
  let res: ReturnType<typeof resolveConnection>;
  try {
    res = resolveConnection(ctx.root, source, ctx.env);
  } catch (e) {
    return [{ check, status: "fail", text: (e as Error).message }];
  }
  if (res.status === "unset") {
    const example = join(dirname(res.add_to), ".env.example");
    const text = existsSync(example) ? readFileSync(example, "utf8") : "";
    const copy = res.variables.every((v) => setsVariable(text, v)) ? ` ${example} holds ${res.variables.length > 1 ? "these lines" : "this line"}: copy it to ${res.add_to} and fill in the values.` : "";
    return [{ check, status: "fail", text: `Source "${name}": ${res.variables.join(", ")} ${res.variables.length > 1 ? "are" : "is"} set nowhere.${copy}`, fix: `the owner adds to ${res.add_to}, with the real values: ${res.line_to_add.split("\n").join("; ")}` }];
  }
  if (res.from?.kind === "env_file" && res.from.path) usedFiles.add(res.from.path);
  out.push({ check, status: "ok", text: source.dialect === "duckdb" ? `Source "${name}" is a DuckDB source and needs no connection variable.` : `Source "${name}" reads ${res.described}.` });
  const { adapter, error, deadline } = await connect(ctx, source);
  if (!adapter) {
    out.push({ check: `query ${name}`, status: "fail", text: `Source "${name}": the connection does not work: ${error}`, fix: `fix what the message names, then semlayer doctor` });
    return out;
  }
  out.push({ check: `query ${name}`, status: "ok", text: `Source "${name}" answered a read-only query.` });
  const report = adapter.roleReport;
  if (adapter.dialect === "postgres") {
    // The facts share the 15 seconds of the connection; past them they stay unknown and the run goes on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ConnectionFacts>((resolve) => {
      timer = setTimeout(() => resolve(UNKNOWN_FACTS), Math.max(0, (deadline ?? Date.now()) - Date.now()));
    });
    const f = await Promise.race([connectionFacts(adapter), late]).finally(() => clearTimeout(timer));
    facts.push({ source: name, ...f });
    const [server, pooled] = factLines(name, f);
    out.push({ check: `server ${name}`, status: "ok", text: server! }, { check: `pooler ${name}`, status: "ok", text: pooled! });
  }
  await adapter.close().catch(() => {});
  if (report) {
    out.push(
      report.least_privilege
        ? { check: `role ${name}`, status: "ok", text: `Source "${name}" connects as ${report.role}, which can only read.` }
        : { check: `role ${name}`, status: "warn", text: `Source "${name}" connects as ${report.role}, which can do more than read (${report.warnings.map((w) => w.replace(/^Warning: /, "")).join(" ")}).`, fix: roleNote(source, report) },
    );
  }
  return out;
}

// Whether git keeps the env files the connections read out of version control.
function gitChecks(ctx: CommandContext, used: Set<string>): Check[] {
  const tracked = new Set(trackedEnvFiles(ctx.root, ctx.env));
  const files = [...new Set([...used, ...envFiles(ctx.root, ctx.env).filter((f) => existsSync(f))])];
  return files.map((file) => {
    if (tracked.has(file)) return { check: "env file", status: "fail", text: `${file} is tracked by git, so its secret goes out with every push.`, fix: `git -C ${quote(dirname(file))} rm --cached ${quote(basename(file))}, commit, and ask the owner to change the password it holds` };
    const r = spawnSync("git", ["-C", dirname(file), "check-ignore", "-q", "--", basename(file)], { stdio: "ignore" });
    if (r.status === 0) return { check: "env file", status: "ok", text: `${file} is kept out of git.` };
    const inRepo = spawnSync("git", ["-C", dirname(file), "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0;
    if (!inRepo) return { check: "env file", status: "ok", text: `${file} is not in a git repository.` };
    return { check: "env file", status: "warn", text: `${file} is not ignored by git.`, fix: `add the lines .env, .env.* and !.env.example to ${join(dirname(file), ".gitignore")}` };
  });
}

function pathCheck(ctx: CommandContext): Check {
  const bare = bareSemlayer(ctx.env, false);
  if (bare.ok) return { check: "command", status: "ok", text: `semlayer on this PATH is the plugin's own (${bare.found}).` };
  if (!bare.found) return { check: "command", status: "skip", text: "semlayer is not on this shell's PATH; Claude Code puts it on the agent's.", fix: "the line below, to run it yourself" };
  return { check: "command", status: "warn", text: `A bare semlayer here is not the plugin's: ${bare.reason}. The hooks then treat it as another program.`, fix: `remove or rename ${bare.found}, or run bun ${quote(join(PLUGIN_ROOT, "skills", "semantic-layer", "scripts", "semlayer.ts"))} <command>` };
}

// The permission rule a person may add so Claude Code stops asking before each semlayer command, and
// the settings files it can go in. semlayer prints it and never writes it.
export const PERMISSION_RULE = "Bash(semlayer *)";
export const PERMISSION_FILES = [
  { file: ".claude/settings.local.json", scope: "this project, not committed" },
  { file: ".claude/settings.json", scope: "this project, shared" },
  { file: "~/.claude/settings.json", scope: "every project" },
];
const permissionLine = `To stop Claude Code asking before each semlayer command, you may add the rule ${PERMISSION_RULE} under permissions.allow in ${PERMISSION_FILES.map((f) => `${f.file} (${f.scope})`).join(", ").replace(/, ([^,]*)$/, " or $1")}; semlayer never adds it.`;

// The first answering postgres source's facts as top-level keys; null for each when there is none.
function topFacts(facts: SourceFacts[]) {
  const f = facts[0];
  return { server_version: f?.server_version ?? null, server_version_num: f?.server_version_num ?? null, tls: f?.tls ?? null, tls_protocol: f?.tls_protocol ?? null, pooled: f?.pooled ?? null };
}

const spec: CommandSpec = {
  summary: "Check that semlayer can run here: Bun, packages, the project, each connection and its role, git, the command on PATH, and the next step.",
  usage:
    "doctor\n\n" +
    "Read-only. One line per check with a mark ([ok], [warn], [fail], [--]); each line that is not ok names its fix.\n" +
    "Connections are named by variable and file, never by value; each runs one read-only query with a short timeout.\n" +
    "Exits 1 only when Bun or the packages stop semlayer from running. --json: { ok, checks: [{ check, status, text, fix? }],\n" +
    "shell_line, permission_rule: { rule, files: [{ file, scope }] }, next, server_version, server_version_num, tls, tls_protocol, pooled,\n" +
    "connections: [{ source, server_version, server_version_num, tls, tls_protocol, pooled }] }. On postgres each connection also prints its server version,\n" +
    "whether it is encrypted (read from the server) and a labelled guess whether a pooler is in the way; the top-level keys repeat the first postgres\n" +
    "source that answered and are null when none did (a DuckDB source has none).",
  options: {},
  writes: false,
  async run(_input, ctx) {
    const checks = await runtimeChecks();
    const facts: SourceFacts[] = [];
    const runs = !checks.some((c) => c.blocking);
    const has = existsSync(paths(ctx.root).project);
    if (!has) checks.push({ check: "project", status: "skip", text: `No semantic layer at ${ctx.root} yet.`, fix: "the Next line below (semlayer next)" });
    else {
      let project: string | undefined;
      try {
        project = loadProject(ctx.root).name;
      } catch (e) {
        checks.push({ check: "project", status: "fail", text: (e as Error).message });
      }
      if (project !== undefined) {
        checks.push({ check: "project", status: "ok", text: `Semantic layer ${project} at ${ctx.root}.` });
        const used = new Set<string>();
        if (runs) for (const name of listSourceNames(ctx.root)) checks.push(...(await sourceChecks(ctx, name, used, facts)));
        checks.push(...gitChecks(ctx, used));
      }
    }
    checks.push(pathCheck(ctx));
    const shellLine = `export PATH="$PATH":${quote(PLUGIN_BIN_DIR)}`;
    let next: { command: string; why: string } | null = null;
    try {
      const a = nextAction(ctx.root, ctx.env);
      next = { command: actionText(a.action as StepAction), why: a.why };
    } catch (e) {
      next = null;
      checks.push({ check: "next", status: "fail", text: `semlayer next cannot say the next step: ${(e as Error).message}` });
    }
    const ok = runs;
    if (ctx.json) ctx.out(formatJson({ ok, checks: checks.map(({ blocking: _b, ...c }) => c), shell_line: shellLine, permission_rule: { rule: PERMISSION_RULE, files: PERMISSION_FILES }, next, ...topFacts(facts), connections: facts }));
    else {
      const lines = checks.map((c) => `${MARK[c.status]} ${c.text}${c.fix ? `\n       Fix: ${c.fix}` : ""}`);
      // An installed plugin lives in a folder named for its version, so the line goes stale on an update.
      const versioned = /[\\/]plugins[\\/]cache[\\/]/.test(PLUGIN_ROOT) ? " (that folder belongs to this plugin version: after a plugin update, run semlayer doctor again for the new line)" : "";
      lines.push("", `To run semlayer in your own terminal, add this line to your shell profile: ${shellLine}${versioned}`, permissionLine);
      if (next) lines.push(`Next: ${next.command} (${next.why})`);
      ctx.out(lines.join("\n"));
    }
    return ok ? 0 : 1;
  },
};
export default spec;

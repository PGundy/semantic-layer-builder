// Where a source's connection variables come from (spec: Connection variables and env files): the
// process environment first, then the env file named by --env-file or SL_ENV_FILE, then .env in
// the directory that holds the semantic root, then .env in the working directory. The files are
// read here, as written: nothing in a value is expanded. No function here returns or prints a
// value except readConnection, which hands the values to the adapter.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { UserError } from "./errors.ts";
import type { SourceConfig } from "./types.ts";

export type Env = Record<string, string | undefined>;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const LINE = new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=(.*)$`);

// The text after the = of an env file line, as written: a value wholly inside single or double
// quotes loses the quotes and nothing else; any other value ends at a # that follows white space.
function literal(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    const end = text.indexOf(quote, 1);
    if (end > 0 && /^\s*(#.*)?$/.test(text.slice(end + 1))) return text.slice(1, end);
  }
  return text.replace(/\s+#.*$/, "").trim();
}

function entries(text: string): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.trimStart().startsWith("#") ? null : LINE.exec(line);
    if (m) out.push({ name: m[1]!, raw: m[2]! });
  }
  return out;
}

// The variables of an env file: KEY=value lines with an optional leading "export", optional single
// or double quotes around the value, # comments and blank lines. A later line for a name replaces
// an earlier one. Nothing is expanded: a $ or a backslash stays as written.
export function parseEnvFile(text: string): Map<string, string> {
  return new Map(entries(text).map((e) => [e.name, literal(e.raw)]));
}

// The env files Bun loads from the working directory into process.env before a script runs, the
// one that wins first. NODE_ENV picks one of the three modes; every mode is listed here.
const BUN_FILES = [".env.development.local", ".env.production.local", ".env.test.local", ".env.local", ".env.development", ".env.production", ".env.test", ".env"];

// What Bun makes of an env file line when it loads one of those files into process.env:
// quotes of any kind removed, an unquoted value cut at the first #, \n and \r in double quotes,
// then \$ unescaped and $NAME, ${NAME} and ${NAME:-default} replaced from the environment.
function bunValue(raw: string, env: Env): string {
  let text = raw.trim();
  const quote = text[0];
  let end = -1;
  if (quote === "'" || quote === '"' || quote === "`") {
    for (let i = 1; i < text.length && end < 0; i++) {
      if (text[i] === "\\" && quote === '"') i++;
      else if (text[i] === quote) end = i;
    }
  }
  if (end > 0) {
    text = text.slice(1, end);
    if (quote === '"') text = text.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  } else {
    const hash = text.indexOf("#");
    text = (hash < 0 ? text : text.slice(0, hash)).trim();
  }
  return text.replace(/\\\$|\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}|\$([A-Za-z0-9_]+)/g, (all, braced?: string, fallback?: string, bare?: string) =>
    all === "\\$" ? "$" : env[braced ?? bare ?? ""] || (fallback ?? ""),
  );
}

function readIfFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export interface ConnectionFrom {
  kind: "environment" | "env_file";
  // The env file, for kind env_file.
  path?: string;
}

// One connection a command opened: the source, and where its variables came from.
export interface ConnectionUse {
  source: string;
  from: ConnectionFrom;
  // The sentence a command prints, without any value.
  line: string;
}

// What the lookup needs beyond the environment: the working directory, the --env-file path, who
// to tell when a connection is opened, and the variables Bun loaded, each with the file it came
// from (processEnvironment).
export interface EnvLookup {
  cwd?: string;
  envFile?: string;
  onConnection?: (use: ConnectionUse) => void;
  bunLoaded?: ReadonlyMap<string, string>;
}

const LOOKUPS = new WeakMap<Env, EnvLookup>();

// A copy of `env` that carries `lookup` to resolveConnection, so every command that is handed the
// environment resolves its connections from the same working directory and --env-file.
export function commandEnv(env: Env, lookup: EnvLookup): Env {
  const copy = { ...env };
  LOOKUPS.set(copy, { ...LOOKUPS.get(env), ...lookup });
  return copy;
}

// The process environment, knowing which variables the shell did not set. Bun loads the working
// directory's env files (BUN_FILES) into process.env before any script runs, with $NAME in a value
// expanded. A variable whose value is what Bun's loading of one of those files gives is marked
// here, and the lookup below passes over it: the files are read in their place in the order, and
// the value arrives as written. A variable the shell set to anything else is not marked, and wins.
// Call it once, when the process starts.
export function processEnvironment(env: Env, cwd: string): Env {
  const bunLoaded = new Map<string, string>();
  for (const file of BUN_FILES) {
    const path = join(cwd, file);
    const text = readIfFile(path);
    const lines = new Map((text === null ? [] : entries(text)).map((e) => [e.name, e.raw]));
    for (const [name, raw] of lines) if (!bunLoaded.has(name) && env[name] !== undefined && env[name] === bunValue(raw, env)) bunLoaded.set(name, path);
  }
  return commandEnv(env, { bunLoaded });
}

function lookupOf(env: Env, opts?: EnvLookup): EnvLookup {
  return { ...LOOKUPS.get(env), ...opts };
}

// The env file a flag or SL_ENV_FILE names, which must exist.
function namedFile(env: Env, lookup: EnvLookup): string | null {
  const flag = lookup.envFile;
  const named = flag ?? (env.SL_ENV_FILE || undefined);
  if (named === undefined) return null;
  const path = resolve(lookup.cwd ?? process.cwd(), named);
  if (readIfFile(path) === null) {
    throw new UserError(
      `${flag !== undefined ? "--env-file" : "SL_ENV_FILE"} names ${path}, which is not a file. Give the path of the env file that holds the connection variables, ` +
        "or leave it out to read the .env beside the semantic root, then run the same command again.",
    );
  }
  return path;
}

// The .env beside the semantic root: the one sl init and sl setup keep out of version control.
export function rootEnvFile(root: string): string {
  return join(dirname(resolve(root)), ".env");
}

// The env files the lookup reads, in order, whether or not they exist: the named one, the .env
// beside the semantic root, the .env in the working directory.
export function envFiles(root: string, env: Env, opts?: EnvLookup): string[] {
  const lookup = lookupOf(env, opts);
  const named = namedFile(env, lookup);
  const files = [...(named ? [named] : []), rootEnvFile(root), ...(lookup.cwd ? [join(resolve(lookup.cwd), ".env")] : [])];
  return [...new Set(files)];
}

// Refuses a --env-file that names no file, before a command runs.
export function checkEnvFileFlag(env: Env, lookup: EnvLookup): void {
  if (lookup.envFile !== undefined) namedFile(env, lookup);
}

interface Hit {
  value: string;
  from: ConnectionFrom;
}

interface Found {
  hits: Map<string, Hit>;
  // Each env file looked at, and whether it exists.
  files: { path: string; exists: boolean }[];
}

// Each of `names` from the first place that sets it to something: the environment, then each env file.
function find(names: string[], root: string, env: Env, opts?: EnvLookup): Found {
  const bunLoaded = lookupOf(env, opts).bunLoaded;
  const files = envFiles(root, env, opts).map((path) => {
    const text = readIfFile(path);
    return { path, exists: text !== null, vars: text === null ? new Map<string, string>() : parseEnvFile(text) };
  });
  const hits = new Map<string, Hit>();
  for (const name of names) {
    if (env[name] && !bunLoaded?.has(name)) hits.set(name, { value: env[name], from: { kind: "environment" } });
    else {
      const file = files.find((f) => f.vars.get(name));
      if (file) hits.set(name, { value: file.vars.get(name)!, from: { kind: "env_file", path: file.path } });
    }
  }
  return { hits, files: files.map(({ path, exists }) => ({ path, exists })) };
}

// Where a variable is set, without its value; undefined when nothing sets it.
export function variableFrom(name: string, root: string, env: Env, opts?: EnvLookup): ConnectionFrom | undefined {
  return find([name], root, env, opts).hits.get(name)?.from;
}

// The parts connection.env_prefix names, each read from <prefix><PART>.
export const PREFIX_PARTS = ["HOST", "PORT", "USER", "PASSWORD", "DATABASE", "SSLMODE"] as const;
const REQUIRED_PARTS: readonly string[] = ["HOST", "USER", "DATABASE"];
const PLACEHOLDERS: Record<string, string> = { HOST: "<host>", PORT: "5432", USER: "<user>", PASSWORD: "<password>", DATABASE: "<database>", SSLMODE: "require" };
export const URL_PLACEHOLDER = "postgres://<user>:<password>@<host>:5432/<database>?sslmode=require";

export type ConnectionResolution =
  | {
      status: "ok";
      // Null when the source names no variable: a DuckDB source, or one the CLI does not connect to.
      from: ConnectionFrom | null;
      // The variables read.
      variables: string[];
      // "LAKE_URL from /path/.env", for the line a command prints; empty when from is null.
      described: string;
    }
  | {
      status: "unset";
      // The variables nothing sets.
      variables: string[];
      // The env files looked at, in order, after the environment.
      looked_at: string[];
      // The line, or lines, the owner adds, with placeholders for the values.
      line_to_add: string;
      // The env file to add them to.
      add_to: string;
      // The whole message, in plain language.
      message: string;
    };

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

function describe(names: string[], hits: Map<string, Hit>): string {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const from = hits.get(n)!.from;
    const where = from.kind === "environment" ? "the environment" : from.path!;
    groups.set(where, [...(groups.get(where) ?? []), n]);
  }
  return [...groups].map(([where, vars]) => `${vars.join(", ")} from ${where}`).join("; ");
}

// The values of a source's connection variables, by name, with where they came from. Only the
// adapter calls this; everything else calls resolveConnection, which carries no value.
export function readConnection(root: string, source: SourceConfig, env: Env, opts?: EnvLookup): { resolution: ConnectionResolution; values: Record<string, string> } {
  const variable = source.connection?.env;
  const prefix = source.connection?.env_prefix;
  if (source.dialect !== "postgres" || (!variable && prefix === undefined)) return { resolution: { status: "ok", from: null, variables: [], described: "" }, values: {} };
  if (variable && prefix !== undefined) {
    throw new UserError(`Source "${source.source}" has both connection.env and connection.env_prefix; keep one: sl setup --source ${source.source} --dialect postgres --env <VAR> or --env-prefix <PREFIX> writes it.`);
  }
  const names = variable ? [variable] : PREFIX_PARTS.map((p) => `${prefix}${p}`);
  const required = variable ? [variable] : REQUIRED_PARTS.map((p) => `${prefix}${p}`);
  const { hits, files } = find(names, root, env, opts);
  const missing = required.filter((n) => !hits.has(n));
  const values = Object.fromEntries([...hits].map(([n, h]) => [n, h.value]));
  if (!missing.length) {
    const read = names.filter((n) => hits.has(n));
    const file = read.map((n) => hits.get(n)!.from).find((f) => f.kind === "env_file");
    return { resolution: { status: "ok", from: file ?? { kind: "environment" }, variables: read, described: describe(read, hits) }, values };
  }
  // With nothing of a prefix set, the lines name every part; otherwise only the missing ones.
  const lines = variable
    ? [`${variable}=${URL_PLACEHOLDER}`]
    : PREFIX_PARTS.filter((p) => (hits.size ? missing.includes(`${prefix}${p}`) : true)).map((p) => `${prefix}${p}=${PLACEHOLDERS[p]}`);
  const named = lookupOf(env, opts).envFile ?? (env.SL_ENV_FILE || undefined);
  const addTo = named === undefined ? rootEnvFile(root) : files[0]!.path;
  const looked = files.map((f) => `${f.path} (${f.exists ? "not set there" : "no such file"})`).join(", ");
  const many = lines.length > 1;
  // A file Bun loaded a missing variable from, which the lookup does not read.
  const bunLoaded = lookupOf(env, opts).bunLoaded;
  const unread = missing.map((n) => bunLoaded?.get(n)).find((p) => p !== undefined && !files.some((f) => f.path === p));
  const message =
    `Source "${source.source}": ${listed(missing)} ${missing.length > 1 ? "are" : "is"} not set. Looked in the environment, then in ${looked}.\n` +
    (unread ? `${unread} holds a line for ${missing.length > 1 ? "these" : "it"}, but the CLI does not read that file: run the same command with --env-file ${unread} to use it.\nOr ask` : "Ask") +
    ` the owner to add ${many ? "these lines" : "this line"} to ${addTo} with the real values in place of each <...> (the values stay out of the chat), ` +
    `or to set ${many ? "the variables" : "the variable"} in the shell, then run the same command again:\n` +
    lines.map((l) => `  ${l}`).join("\n");
  return { resolution: { status: "unset", variables: missing, looked_at: files.map((f) => f.path), line_to_add: lines.join("\n"), add_to: addTo, message }, values };
}

// Where a source's connection comes from, without connecting and without any value: ok with the
// place, or unset with the variables, the files looked at and the line to add.
export function resolveConnection(root: string, source: SourceConfig, env: Env, opts?: EnvLookup): ConnectionResolution {
  return readConnection(root, source, env, opts).resolution;
}

// Tells the command that a connection was opened, so it prints where the connection came from.
export function noteConnection(source: string, resolution: ConnectionResolution, env: Env, opts?: EnvLookup): void {
  if (resolution.status !== "ok" || !resolution.from) return;
  lookupOf(env, opts).onConnection?.({ source, from: resolution.from, line: `Connection for source "${source}": ${resolution.described}` });
}

// The lines that keep env files out of version control, .env.example aside.
export const ENV_IGNORE = [".env", ".env.*", "!.env.example"];

// Adds ENV_IGNORE to the .gitignore of the directory that holds the semantic root, creating the
// file when there is none and appending only the lines it lacks; nothing when that directory does
// not exist yet. This is the one file a command writes outside the semantic root.
export function ignoreEnvFiles(root: string): void {
  const dir = dirname(resolve(root));
  if (!existsSync(dir)) return;
  const file = join(dir, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  const have = new Set((text ?? "").split(/\r?\n/).map((l) => l.trim()));
  const missing = ENV_IGNORE.filter((l) => !have.has(l));
  if (!missing.length) return;
  // The exception only holds after the pattern it excepts.
  if (missing.includes(".env.*") && !missing.includes("!.env.example")) missing.push("!.env.example");
  const lines = `${missing.join("\n")}\n`;
  if (text === null) writeFileSync(file, `# Env files hold connection secrets; sl init and sl setup keep them out of version control.\n${lines}`);
  else appendFileSync(file, `${text.endsWith("\n") || !text ? "" : "\n"}${lines}`);
}

const isEnvFileName = (name: string) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example");

// The env files under the semantic root, as paths relative to it. sl validate reports each: a
// secret is never kept inside the root.
export function envFilesInRoot(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return names.filter((n) => isEnvFileName(basename(n))).map((n) => n.split("\\").join("/")).sort();
}

// Of the env files the lookup reads, those git tracks. Empty when a file is in no repository or git
// is not installed.
export function trackedEnvFiles(root: string, env: Env, opts?: EnvLookup): string[] {
  return envFiles(root, env, opts).filter((path) => {
    if (readIfFile(path) === null) return false;
    try {
      return spawnSync("git", ["-C", dirname(path), "ls-files", "--error-unmatch", "--", basename(path)], { stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  });
}

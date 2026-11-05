// Checks on the statements a DuckDB source runs on every connection. A source file is executable
// configuration: a cloned or shared semantic directory runs its setup statements and views on the
// machine of whoever opens the source. connection.setup is limited to an allowlist and each
// connection.views relation must be one table expression; the DuckDB adapter refuses a source that
// fails (assertSourceSafe) and sl validate reports it as an error (sourceSafetyIssues). Messages
// name where the problem is, never the statement, which may hold a secret.
import { isAbsolute, resolve } from "node:path";
import { UserError } from "./errors.ts";
import { statements, tokenize, type Token } from "./sql-guard.ts";

// Core extensions a setup statement may INSTALL or LOAD by name.
export const SETUP_EXTENSIONS = new Set(["httpfs", "aws", "azure", "parquet", "json", "icu", "iceberg", "delta", "excel", "spatial", "inet"]);

// Settings a setup statement may SET: performance, output and remote-storage settings that hold no
// credential and open no file access.
export const SETUP_SETTINGS = new Set([
  "threads",
  "worker_threads",
  "memory_limit",
  "max_memory",
  "preserve_insertion_order",
  "default_order",
  "default_null_order",
  "enable_progress_bar",
  "enable_progress_bar_print",
  "enable_object_cache",
  "binary_as_string",
  "http_timeout",
  "http_retries",
  "http_retry_wait_ms",
  "http_keep_alive",
  "s3_region",
  "s3_endpoint",
  "s3_url_style",
  "s3_use_ssl",
  "secret_directory",
  "errors_as_json",
  "integer_division",
]);

// CREATE SECRET: the providers that read credentials from the environment, and the options a
// secret may set besides them. Any other option (KEY_ID, SECRET, SESSION_TOKEN, CONNECTION_STRING,
// ACCOUNT_KEY, ...) would hold a literal credential.
const SECRET_PROVIDERS = new Set(["credential_chain", "managed_identity"]);
const SECRET_OPTIONS = new Set(["type", "provider", "chain", "region", "scope", "endpoint", "url_style", "use_ssl", "account_name", "profile", "validation", "refresh", "url_compatibility_mode"]);

// Table functions a view may read through.
export const VIEW_FUNCTIONS = new Set([
  "read_parquet",
  "parquet_scan",
  "read_csv",
  "read_csv_auto",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
  "iceberg_scan",
  "delta_scan",
  "read_xlsx",
]);
// Table functions whose path names a directory (a table's root) rather than files.
const DIRECTORY_FUNCTIONS = new Set(["iceberg_scan", "delta_scan"]);

function isName(t: Token | undefined): boolean {
  return t?.kind === "word" || t?.kind === "ident";
}

function isLiteral(t: Token | undefined): boolean {
  return t?.kind === "string" || t?.kind === "number" || (t?.kind === "word" && ["true", "false", "null", "on", "off"].includes(t.text));
}

// The one statement `text` holds, or a reason it holds none or several.
function oneStatement(text: string): Token[] | string {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (e) {
    return (e as Error).message.replace(/^The query/, "it");
  }
  const all = statements(tokens);
  if (all.length !== 1) return all.length ? "it holds more than one statement" : "it is empty";
  return all[0]!;
}

// Why a setup statement is not allowed, or undefined when it is: INSTALL or LOAD of a core
// extension (SETUP_EXTENSIONS), SET of a safe setting (SETUP_SETTINGS) to a literal, or CREATE
// SECRET with an environment provider (SECRET_PROVIDERS) and no literal credential.
export function setupProblem(stmt: string): string | undefined {
  const s = oneStatement(stmt);
  if (typeof s === "string") return s;
  const w = (i: number) => (s[i]?.kind === "word" ? s[i]!.text : undefined);
  const head = w(0);
  if (head === "install" || head === "load") {
    const ext = s[1];
    const name = ext?.kind === "word" || ext?.kind === "string" || ext?.kind === "ident" ? ext.text.toLowerCase() : undefined;
    if (s.length !== 2 || !name || !SETUP_EXTENSIONS.has(name)) {
      return `${head.toUpperCase()} names one core extension (${[...SETUP_EXTENSIONS].join(", ")}) and nothing else`;
    }
    return undefined;
  }
  if (head === "set") {
    let i = 1;
    if (["session", "local", "global"].includes(w(i) ?? "")) i++;
    const setting = isName(s[i]) ? s[i]!.text.toLowerCase() : undefined;
    if (!setting || !SETUP_SETTINGS.has(setting)) return `SET may change only these settings: ${[...SETUP_SETTINGS].join(", ")}`;
    i++;
    if (!(s[i]?.text === "=" || w(i) === "to")) return "SET needs = or TO and one value";
    i++;
    if (s[i]?.text === "-" && s[i + 1]?.kind === "number") i++;
    if (!isLiteral(s[i]) || s.length !== i + 1) return "SET takes one literal value";
    return undefined;
  }
  if (head === "create") {
    let i = 1;
    if (w(i) === "or" && w(i + 1) === "replace") i += 2;
    if (w(i) === "persistent") return "CREATE SECRET may not be PERSISTENT: it would write the secret to disk";
    if (w(i) === "temp" || w(i) === "temporary") i++;
    if (w(i) !== "secret") return "setup may run only INSTALL, LOAD, SET and CREATE SECRET";
    i++;
    if (w(i) === "if" && w(i + 1) === "not" && w(i + 2) === "exists") i += 3;
    if (isName(s[i]) && s[i + 1]?.text === "(") i++;
    if (s[i]?.text !== "(" || s[s.length - 1]?.text !== ")") return "CREATE SECRET takes a parenthesized option list";
    const options = new Map<string, string>();
    let j = i + 1;
    while (j < s.length - 1) {
      const key = isName(s[j]) ? s[j]!.text.toLowerCase() : undefined;
      const value = s[j + 1];
      if (!key || !(isLiteral(value) || isName(value))) return "CREATE SECRET options are a name and one value each";
      if (!SECRET_OPTIONS.has(key)) {
        return `CREATE SECRET may set only ${[...SECRET_OPTIONS].join(", ")}; a credential comes from a provider that reads the environment`;
      }
      options.set(key, value!.text.toLowerCase());
      j += 2;
      if (s[j]?.text === ",") j++;
      else if (j !== s.length - 1) return "CREATE SECRET options are separated by commas";
    }
    const provider = options.get("provider");
    if (!provider || !SECRET_PROVIDERS.has(provider)) {
      return `CREATE SECRET needs PROVIDER ${[...SECRET_PROVIDERS].join(" or ")}, which reads credentials from the environment`;
    }
    return undefined;
  }
  return "setup may run only INSTALL, LOAD, SET and CREATE SECRET";
}

export type ViewRelation =
  | { kind: "table"; name: string[] }
  | { kind: "function"; name: string; paths: string[] };

// The path literals of a table-function view, with their offsets in the relation text.
function pathTokens(s: Token[]): Token[] {
  if (s[2]?.kind === "string") return [s[2]];
  const out: Token[] = [];
  for (let i = 3; s[i]?.kind === "string"; i += s[i + 1]?.text === "," ? 2 : 1) out.push(s[i]!);
  return out;
}

// Skips one literal value of a table function's named argument: a literal, or a list or struct of
// literals ([..], {..}, with : and , between). Returns the index after it, or -1.
function skipValue(s: Token[], i: number): number {
  if (s[i]?.text === "-" && s[i + 1]?.kind === "number") return i + 2;
  if (isLiteral(s[i])) return i + 1;
  const open = s[i]?.text;
  if (open !== "[" && open !== "{") return -1;
  const close = open === "[" ? "]" : "}";
  let j = i + 1;
  while (j < s.length && s[j]?.text !== close) {
    if (s[j]?.kind === "op" && (s[j]!.text === "," || s[j]!.text === ":")) {
      j++;
      continue;
    }
    if (isName(s[j]) && s[j + 1]?.text === ":") {
      j++;
      continue;
    }
    const k = skipValue(s, j);
    if (k < 0) return -1;
    j = k;
  }
  return s[j]?.text === close ? j + 1 : -1;
}

// A view relation read as one table expression: a table name (up to catalog.schema.table), or a
// table function of VIEW_FUNCTIONS over a path or a list of paths with literal named arguments.
// Anything else, such as a subquery, another function or a second clause, is a reason string.
export function parseViewRelation(relation: string): ViewRelation | string {
  const s = oneStatement(relation);
  if (typeof s === "string") return s;
  if (isName(s[0]) && s[1]?.text !== "(") {
    const name: string[] = [s[0]!.text];
    let i = 1;
    while (s[i]?.text === "." && isName(s[i + 1]) && name.length < 3) {
      name.push(s[i + 1]!.text);
      i += 2;
    }
    if (i !== s.length) return "a view is one table name or one table function, with nothing after it";
    if (name.length === 1 && name[0] === "select") return "a view may not be a subquery";
    return { kind: "table", name };
  }
  if (s[0]?.kind !== "word" || s[1]?.text !== "(" || s[s.length - 1]?.text !== ")") {
    return `a view is one table name or one call to ${[...VIEW_FUNCTIONS].join(", ")}`;
  }
  const fn = s[0].text;
  if (!VIEW_FUNCTIONS.has(fn)) return `a view may read only through ${[...VIEW_FUNCTIONS].join(", ")}`;
  const paths: string[] = [];
  let i = 2;
  if (s[i]?.kind === "string") {
    paths.push(s[i]!.text);
    i++;
  } else if (s[i]?.text === "[") {
    i++;
    while (s[i]?.kind === "string") {
      paths.push(s[i]!.text);
      i++;
      if (s[i]?.text === ",") i++;
    }
    if (s[i]?.text !== "]") return `${fn} takes a path or a list of paths first`;
    i++;
  } else return `${fn} takes a path or a list of paths first`;
  if (!paths.length) return `${fn} takes a path or a list of paths first`;
  const end = s.length - 1;
  while (i < end) {
    if (s[i]?.text !== ",") return `${fn}'s other arguments are name = literal pairs`;
    i++;
    if (!isName(s[i]) || !(s[i + 1]?.text === "=" || (s[i + 1]?.text === ":" && s[i + 2]?.text === "="))) {
      return `${fn}'s other arguments are name = literal pairs`;
    }
    i += s[i + 1]?.text === "=" ? 2 : 3;
    const k = skipValue(s, i);
    if (k < 0) return `${fn}'s named arguments take literal values only`;
    i = k;
  }
  return { kind: "function", name: fn, paths };
}

export interface SourceSafetyIssue {
  // connection.setup[<i>] or connection.views.<name>.
  path: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The setup statements and views of a DuckDB source's connection that the adapter would refuse.
// Other dialects, and values of the wrong shape (left to the schema check), give no issue.
export function sourceSafetyIssues(source: unknown): SourceSafetyIssue[] {
  if (!isRecord(source) || source.dialect !== "duckdb" || !isRecord(source.connection)) return [];
  const out: SourceSafetyIssue[] = [];
  const { setup, views } = source.connection;
  const list = typeof setup === "string" ? [setup] : Array.isArray(setup) ? setup : [];
  list.forEach((stmt, i) => {
    if (typeof stmt !== "string") return;
    const problem = setupProblem(stmt);
    const path = typeof setup === "string" ? "connection.setup" : `connection.setup[${i}]`;
    if (problem) out.push({ path, message: `is not an allowed setup statement: ${problem}.` });
  });
  if (isRecord(views)) {
    for (const [name, relation] of Object.entries(views)) {
      if (typeof relation !== "string") continue;
      const parsed = parseViewRelation(relation);
      if (typeof parsed === "string") out.push({ path: `connection.views.${name}`, message: `is not one table expression: ${parsed}.` });
    }
  }
  return out;
}

// Throws a UserError naming every setup statement and view of the source that is not allowed.
export function assertSourceSafe(source: { source?: unknown } & Record<string, unknown>): void {
  const issues = sourceSafetyIssues(source);
  if (!issues.length) return;
  throw new UserError(
    `Source "${String(source.source)}" runs statements it may not run on connect:\n` +
      issues.map((i) => `  ${i.path} ${i.message}`).join("\n") +
      "\nA source file is executable configuration: review sources/ like code. See references/spec.md (Sources).",
  );
}

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i;
const GLOB_CHAR = /[*?[{]/;

export interface ViewFiles {
  // Directory prefixes (ending in "/") the views read: a glob's directory before its first
  // wildcard, or a table function's table root.
  directories: string[];
  // Single files the views read.
  files: string[];
}

function addPath(out: ViewFiles, root: string, path: string, directory: boolean): void {
  const abs = absolute(root, path);
  const parts = abs.split("/");
  const wild = parts.findIndex((p) => GLOB_CHAR.test(p));
  if (wild >= 0) out.directories.push(`${parts.slice(0, wild).join("/")}/`);
  else if (directory) out.directories.push(abs.endsWith("/") ? abs : `${abs}/`);
  else out.files.push(abs);
}

// The files and directories a DuckDB source's views read, resolved from the semantic root: what
// the adapter allows once it turns off other file access. A view over a table name reads none.
export function viewFiles(root: string, source: { connection?: { views?: Record<string, string> } }): ViewFiles {
  const out: ViewFiles = { directories: [], files: [] };
  for (const relation of Object.values(source.connection?.views ?? {})) {
    if (typeof relation !== "string") continue;
    const parsed = parseViewRelation(relation);
    if (typeof parsed === "string" || parsed.kind !== "function") continue;
    for (const p of parsed.paths) addPath(out, root, p, DIRECTORY_FUNCTIONS.has(parsed.name));
  }
  return { directories: [...new Set(out.directories)].sort(), files: [...new Set(out.files)].sort() };
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function absolute(root: string, path: string): string {
  return REMOTE.test(path) || isAbsolute(path) ? path : resolve(root, path);
}

// A view relation with each relative path resolved from the semantic root, as the adapter creates
// the view: DuckDB checks file access against the path as written, so a relative path would not
// match the absolute paths it allows. A relation that is not a table-function view is returned as is.
export function resolvedRelation(root: string, relation: string): string {
  const parsed = parseViewRelation(relation);
  if (typeof parsed === "string" || parsed.kind !== "function") return relation;
  const tokens = oneStatement(relation);
  if (typeof tokens === "string") return relation;
  let out = relation;
  for (const t of pathTokens(tokens).reverse()) out = `${out.slice(0, t.pos)}${quoteLiteral(absolute(root, t.text))}${out.slice(t.end)}`;
  return out;
}

// Whether a glob pattern stays inside the files and directories a source's views read.
export function globInsideViews(root: string, source: { connection?: { views?: Record<string, string> } }, pattern: string): boolean {
  const { directories, files } = viewFiles(root, source);
  const abs = absolute(root, pattern);
  if (abs.split("/").some((p) => p === "..")) return false;
  return files.includes(abs) || directories.some((d) => abs.startsWith(d));
}

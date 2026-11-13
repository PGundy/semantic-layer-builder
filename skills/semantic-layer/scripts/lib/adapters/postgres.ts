import { SQL } from "bun";
import { dirname } from "node:path";
import { redactCredentials, REDACTED } from "../credentials.ts";
import { noteConnection, readConnection, URL_PLACEHOLDER } from "../env-file.ts";
import { UserError } from "../errors.ts";
import type { SourceConfig } from "../types.ts";
import { formatDate, formatTimestamp, normalizeDecimal, normalizeInteger } from "./normalize.ts";
import { intakeSchemas, schemaFilter } from "../intake.ts";
import { roleSqlSchemasFlag } from "../role-sql.ts";
import type { Adapter, AdapterOptions, QueryResult, RoleReport } from "./types.ts";

const INT_OIDS = new Set([20, 21, 23, 26]);
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;

export const DEFAULT_STATEMENT_TIMEOUT_MS = 120000;

function convert(v: unknown, oid: number | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (oid !== undefined && INT_OIDS.has(oid)) return normalizeInteger(v);
  if (oid === NUMERIC_OID) return normalizeDecimal(v);
  if (v instanceof Date) {
    if (oid === DATE_OID) return formatDate(v);
    if (oid === TIMESTAMPTZ_OID) return `${formatTimestamp(v)}+00`;
    if (oid === TIMESTAMP_OID) return formatTimestamp(v);
    return v.toISOString();
  }
  if (typeof v === "bigint") return normalizeInteger(v);
  return v;
}

// SL_STATEMENT_TIMEOUT_MS as whole milliseconds, DEFAULT_STATEMENT_TIMEOUT_MS when unset.
export function statementTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!/^\s*\d+\s*$/.test(raw)) throw new UserError(`SL_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds; got "${raw}".`);
  return Number(raw);
}

// The startup settings every connection opens with, so a reconnect keeps them.
export function startupSettings(timeoutMs: number): Record<string, string | number> {
  return { default_transaction_read_only: "on", statement_timeout: timeoutMs, TimeZone: "UTC" };
}

// The role, whether it is a superuser and the server-file roles it is a member of.
const ROLE_SQL = `select current_user as role,
  coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
  coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r
    where r.rolname in ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program')
      and pg_has_role(current_user, r.oid, 'MEMBER')), '') as server_file_roles`;

// Per schema outside the system schemas: whether the role may use it and create in it, and
// whether it may read any table or view and write any table of it. SELECT, INSERT and UPDATE
// count a grant on any one column as well as on the whole table.
const SCHEMAS_SQL = `select n.nspname as schema,
  has_schema_privilege(n.oid, 'USAGE') as can_use,
  has_schema_privilege(n.oid, 'CREATE') as can_create,
  coalesce(bool_or(has_any_column_privilege(c.oid, 'SELECT')), false) as can_select,
  coalesce(bool_or(has_any_column_privilege(c.oid, 'INSERT')) filter (where c.relkind in ('r', 'p')), false) as can_insert,
  coalesce(bool_or(has_any_column_privilege(c.oid, 'UPDATE')) filter (where c.relkind in ('r', 'p')), false) as can_update,
  coalesce(bool_or(has_table_privilege(c.oid, 'DELETE')) filter (where c.relkind in ('r', 'p')), false) as can_delete,
  coalesce(bool_or(has_table_privilege(c.oid, 'TRUNCATE')) filter (where c.relkind in ('r', 'p')), false) as can_truncate
from pg_namespace n
left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p', 'v', 'm', 'f')
where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
group by n.oid, n.nspname
order by n.nspname`;

const WRITES = [
  ["can_insert", "INSERT"],
  ["can_update", "UPDATE"],
  ["can_delete", "DELETE"],
  ["can_truncate", "TRUNCATE"],
  ["can_create", "CREATE"],
] as const;

// Catalog names in a warning, without control characters.
const clean = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

function names(list: string[], max = 3): string {
  const shown = list.slice(0, max).map(clean);
  return list.length > max ? `${shown.join(", ")} and ${list.length - max} more` : shown.join(", ");
}

// The role report from the two queries' rows, with its warning: superuser alone when the role is
// one (it can do everything else), else each thing it can do beyond reading the intake schemas.
// schemas is an error message when the per-schema query failed: the report then says so and never
// claims least privilege.
export function buildRoleReport(source: SourceConfig, role: Record<string, unknown>, measured: Record<string, unknown>[] | { error: string }): RoleReport {
  const schemas = Array.isArray(measured) ? measured : [];
  let intake: string[] = [];
  try {
    intake = intakeSchemas(source);
  } catch {
    intake = [];
  }
  const inIntake = schemaFilter(source, intake);
  const write = schemas
    .map((r) => ({ schema: String(r.schema), privileges: WRITES.filter(([k]) => r[k] === true).map(([, p]) => p) as string[] }))
    .filter((w) => w.privileges.length > 0);
  const readable = schemas.filter((r) => r.can_use === true && r.can_select === true).map((r) => String(r.schema));
  const beyond = intake.length && Array.isArray(measured) ? readable.filter((x) => !inIntake(x)) : null;
  const superuser = role.superuser === true;
  const serverRoles = String(role.server_file_roles ?? "").split(",").filter(Boolean);
  const parts: string[] = [];
  if (write.length) parts.push(`can write (${write.slice(0, 3).map((w) => `${w.privileges.join(", ")} on ${clean(w.schema)}`).join("; ")}${write.length > 3 ? `; and ${write.length - 3} more schemas` : ""})`);
  if (serverRoles.length) parts.push(`is a member of ${serverRoles.join(", ")}`);
  if (beyond?.length) parts.push(`reads schemas outside intake.schemas (${names(beyond)})`);
  const warnings: string[] = [];
  const name = source.source;
  if (superuser) warnings.push(`Warning: source "${name}" connects as a superuser. Queries run read-only, but connect with a SELECT-only role.`);
  else if (!Array.isArray(measured)) {
    warnings.push(
      `Warning: source "${name}": the CLI could not measure what its role can do on each schema (${clean(measured.error)}). Queries run read-only; ` +
        `to be sure the role only reads, connect with the role sl setup --print-role-sql --dialect postgres --schemas ${roleSqlSchemasFlag(intake)} prints.`,
    );
  } else if (parts.length) {
    const flag = roleSqlSchemasFlag(intake);
    warnings.push(
      `Warning: source "${name}" connects as a role that ${parts.join(", ")}. Queries run read-only, but connect with a SELECT-only role ` +
        `limited to the schemas the layer reads: sl setup --print-role-sql --dialect postgres --schemas ${flag} prints the statements.`,
    );
  }
  return {
    dialect: "postgres",
    role: clean(String(role.role ?? "")),
    superuser,
    write_privileges: write,
    server_file_roles: serverRoles,
    readable_schemas: readable,
    beyond_intake: beyond,
    least_privilege: !superuser && !parts.length && Array.isArray(measured),
    schemas_measured: Array.isArray(measured),
    warnings,
  };
}

// Warnings already given, per warning function, so a command that opens a source several times
// warns once.
const warned = new WeakMap<(m: string) => void, Set<string>>();
const stderr = (m: string) => {
  process.stderr.write(`${m}\n`);
};

function warnOnce(warn: (m: string) => void, key: string, message: string): void {
  const seen = warned.get(warn) ?? new Set<string>();
  if (seen.has(key)) return;
  seen.add(key);
  warned.set(warn, seen);
  warn(message);
}

// What the driver is given for a source: the URL of connection.env as it is, or the parts of
// connection.env_prefix as options, so a password is used as written and never put in a URL.
// `sql` is the driver's client built from `options`, not yet connected. `target` is the host and
// port a message names; no message may hold one of `secrets`, or one of `users` as a word.
export interface DriverConnection {
  options: Record<string, unknown>;
  sql: SQL;
  target: { host: string; port: string };
  secrets: string[];
  users: string[];
  // How to turn TLS on, for a server that requires it, and off, for one that has none.
  sslHint: string;
  noSslHint: string;
}

const SSL_MODES = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];

export function driverConnection(source: SourceConfig, values: Record<string, string>, timeoutMs: number): DriverConnection {
  const base = { adapter: "postgres", max: 1, prepare: false, connection: startupSettings(timeoutMs) };
  const refuse = (what: string) => new UserError(`Source "${source.source}": ${what}; ask the owner to correct it, then run the same command again.`);
  const variable = source.connection?.env;
  if (variable) {
    const url = values[variable]!;
    const invalid = () => refuse(`${variable} does not hold a valid Postgres connection URL. It reads like ${URL_PLACEHOLDER}, with any @, / or # of the password percent-encoded (sl setup --env-prefix takes a password as written)`);
    // The driver judges the URL, so every form it takes works, a unix socket's among them. A blank
    // one it would replace with DATABASE_URL.
    if (!url.trim()) throw invalid();
    const options = { ...base, url };
    let sql: SQL;
    try {
      sql = new SQL(options as SQL.Options);
    } catch {
      throw invalid();
    }
    // The driver's own reading says which server, user and password it uses. Its host and port
    // are named only for a value that starts as a Postgres URL: of anything else (a password
    // pasted alone) the driver makes a host.
    const read = sql.options as { hostname?: unknown; port?: unknown; path?: unknown; username?: unknown; password?: unknown };
    const written = URL.canParse(url) ? new URL(url) : null;
    const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    return {
      options,
      sql,
      target: /^postgres(ql)?:\/\//i.test(url) ? { host: read.path ? dirname(text(read.path)) : text(read.hostname), port: text(read.port) } : { host: `the host ${variable} names`, port: "" },
      secrets: [url, text(read.password), written?.password ?? ""],
      users: [text(read.username), written?.username ?? ""],
      sslHint: `add sslmode=require to the URL in ${variable} (it then ends ?sslmode=require)`,
      noSslHint: `take sslmode out of the URL in ${variable}`,
    };
  }
  const prefix = source.connection?.env_prefix ?? "";
  const part = (name: string) => values[`${prefix}${name}`];
  const port = part("PORT") ?? "5432";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw refuse(`${prefix}PORT must be a port number such as 5432`);
  const sslmode = part("SSLMODE");
  if (sslmode !== undefined && !SSL_MODES.includes(sslmode)) throw refuse(`${prefix}SSLMODE must be one of ${SSL_MODES.join(", ")}`);
  const password = part("PASSWORD") ?? "";
  // Every field is given, so the driver takes none from DATABASE_URL or the PG* variables. The
  // password is a function because the driver replaces an empty one with PGPASSWORD or the
  // password of DATABASE_URL, which would send another server's password to this one.
  const options = { ...base, hostname: part("HOST"), port: Number(port), username: part("USER"), password: () => password, database: part("DATABASE"), tls: sslmode ?? "disable" };
  let sql: SQL;
  try {
    sql = new SQL(options as SQL.Options);
  } catch {
    throw refuse(`${prefix}HOST, or a variable beside it, does not hold a value a Postgres connection takes`);
  }
  return {
    options,
    sql,
    target: { host: part("HOST")!, port },
    secrets: [password],
    users: [part("USER")!],
    sslHint: `add the line ${prefix}SSLMODE=require beside ${prefix}HOST`,
    noSslHint: `set ${prefix}SSLMODE=disable, or take that line out`,
  };
}

// A driver message with the connection's secrets, its user name where it stands as a word, and
// anything else that reads like a credential replaced by [redacted].
function scrub(text: string, conn: DriverConnection): string {
  let out = text;
  for (const s of new Set(conn.secrets)) if (s) out = out.split(s).join(REDACTED);
  for (const u of new Set(conn.users)) {
    if (u) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g"), REDACTED);
  }
  return redactCredentials(out).text;
}

const UNREACHABLE = /^ERR_POSTGRES_CONNECTION_(REFUSED|TIMEOUT)$/;
const NEEDS_SSL = /no encryption|SSL off|SSL connection is required|sslmode=require|connection is insecure/i;
const NO_SSL = /does not support SSL/i;

// The message for a connection that failed to open: an unreachable server by host and port, a
// server that accepts only encrypted connections with how to turn TLS on, one that has no TLS
// with how to turn it off, anything else with the driver's words scrubbed. `described` says where
// the variables came from; no message names a value but the host and the port.
export function connectFailure(source: string, e: unknown, conn: DriverConnection, described: string): UserError {
  const code = String((e as { code?: unknown }).code ?? "");
  const text = e instanceof Error ? e.message : String(e);
  const at = `${conn.target.host}${conn.target.port ? ` port ${conn.target.port}` : ""} (${described})`;
  if (UNREACHABLE.test(code)) {
    return new UserError(
      `Source "${source}": cannot reach the database at ${at}. Check the host and port with the owner, and the network path from this machine: ` +
        "a VPN that must be on, or an allowlist that must include this machine's address. Then run the same command again.",
    );
  }
  if (NEEDS_SSL.test(text)) {
    return new UserError(
      `Source "${source}": the database at ${at} accepts only encrypted connections. Ask the owner to ${conn.sslHint}, then run the same command again.`,
    );
  }
  if (NO_SSL.test(text)) {
    return new UserError(`Source "${source}": the database at ${at} does not take encrypted connections. Ask the owner to ${conn.noSslHint}, then run the same command again.`);
  }
  return new UserError(
    `Source "${source}": cannot connect to the database at ${at}: ${scrub(text, conn).replace(/\.$/, "")}. Ask the owner to check the values of those variables, then run the same command again.`,
  );
}

// Opens a Postgres source read-only by construction. Every connection starts with
// default_transaction_read_only=on, the statement timeout and TimeZone=UTC as startup settings,
// so a reconnect keeps them. Each query runs alone over the extended protocol, which refuses
// several statements in one call, inside BEGIN TRANSACTION READ ONLY and is always rolled back,
// so nothing it sets outlives it. The connection variables come from the environment or an env
// file (lib/env-file.ts), and the command is told which. On connect it measures what the role can
// do (buildRoleReport) and warns once, without refusing, when the role is a superuser, can write,
// is a member of a server-file role or reads schemas outside intake.schemas.
export async function openPostgres(root: string, source: SourceConfig, env: Record<string, string | undefined>, opts: AdapterOptions = {}): Promise<Adapter> {
  if (!source.connection?.env && source.connection?.env_prefix === undefined) {
    throw new UserError(
      `Source "${source.source}" names no connection variable. Run sl setup --source ${source.source} --dialect postgres --env <VAR> (the variable that holds its connection URL) or --env-prefix <PREFIX> (for <PREFIX>HOST, <PREFIX>USER and the rest).`,
    );
  }
  const { resolution, values } = readConnection(root, source, env);
  if (resolution.status === "unset") throw new UserError(resolution.message);
  const conn = driverConnection(source, values, statementTimeout(env.SL_STATEMENT_TIMEOUT_MS));
  noteConnection(source.source, resolution, env);
  const sql = conn.sql;

  async function run(text: string): Promise<QueryResult> {
    const conn = await sql.reserve();
    let result: Record<string, unknown>[] & { columns?: { name: string; type: number }[] };
    try {
      await conn.unsafe("BEGIN TRANSACTION READ ONLY");
      try {
        result = (await conn`${conn.unsafe(text)}`) as typeof result;
      } finally {
        await conn.unsafe("ROLLBACK").catch(() => {});
      }
    } finally {
      conn.release();
    }
    const meta = result.columns ?? [];
    const columns = meta.length ? meta.map((c) => c.name) : Object.keys(result[0] ?? {});
    const oids = new Map(meta.map((c) => [c.name, c.type]));
    const rows = [...result].map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of columns) out[col] = convert(row[col], oids.get(col));
      return out;
    });
    return { columns, rows };
  }

  // The first query proves the connection; the per-schema one reads the whole catalog, so its
  // failure (a timeout on a large catalog) leaves the report unmeasured instead of failing.
  let role: Record<string, unknown>;
  try {
    role = (await run(ROLE_SQL)).rows[0] ?? {};
  } catch (e) {
    await sql.close().catch(() => {});
    throw connectFailure(source.source, e, conn, resolution.described);
  }
  const measured = await run(SCHEMAS_SQL).then(
    (r) => r.rows,
    (e: Error) => ({ error: e.message }),
  );
  const report = buildRoleReport(source, role, measured);
  for (const w of report.warnings) warnOnce(opts.warn ?? stderr, `${source.source}\u0000${w}`, w);
  return {
    dialect: "postgres",
    roleReport: report,
    query: run,
    async close() {
      await sql.close();
    },
  };
}

import { SQL } from "bun";
import { UserError } from "../errors.ts";
import type { SourceConfig } from "../types.ts";
import { formatDate, formatTimestamp, normalizeDecimal, normalizeInteger } from "./normalize.ts";
import type { Adapter, AdapterOptions, QueryResult } from "./types.ts";

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

// Whether the role is a superuser, and whether it may write to any table outside the system
// schemas or to the server's files.
const PRIVILEGES_SQL = `select
  coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
  exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      and has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
  ) or exists (
    select 1 from pg_roles r where r.rolname in ('pg_write_server_files', 'pg_execute_server_program', 'pg_read_server_files')
      and pg_has_role(current_user, r.oid, 'MEMBER')
  ) as can_write`;

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

// Opens a Postgres source read-only by construction. Every connection starts with
// default_transaction_read_only=on, the statement timeout and TimeZone=UTC as startup settings,
// so a reconnect keeps them. Each query runs alone over the extended protocol, which refuses
// several statements in one call, inside BEGIN TRANSACTION READ ONLY and is always rolled back,
// so nothing it sets outlives it. On connect it warns once, without refusing, when the role is a
// superuser or can write.
export async function openPostgres(_root: string, source: SourceConfig, env: Record<string, string | undefined>, opts: AdapterOptions = {}): Promise<Adapter> {
  const varName = source.connection?.env;
  if (!varName) throw new UserError(`Source "${source.source}": set connection.env to the name of the env var holding its connection URL.`);
  const url = env[varName];
  if (!url) throw new UserError(`Source "${source.source}": env var ${varName} is not set.`);
  const timeout = statementTimeout(env.SL_STATEMENT_TIMEOUT_MS);
  let sql: SQL;
  try {
    sql = new SQL({ url, max: 1, prepare: false, connection: startupSettings(timeout) });
  } catch {
    throw new UserError(`Source "${source.source}": ${varName} does not hold a valid Postgres connection URL.`);
  }

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

  let privileges: QueryResult;
  try {
    privileges = await run(PRIVILEGES_SQL);
  } catch (e) {
    await sql.close().catch(() => {});
    throw new UserError(`Source "${source.source}": cannot connect using ${varName}: ${(e as Error).message}`);
  }
  const row = privileges.rows[0] ?? {};
  if (row.superuser === true || row.can_write === true) {
    const what = row.superuser === true ? "a superuser" : "a role that can write";
    warnOnce(
      opts.warn ?? stderr,
      `${source.source}\u0000${what}`,
      `Warning: source "${source.source}" connects as ${what}. Queries run read-only, but connect with a SELECT-only role.`,
    );
  }
  return {
    dialect: "postgres",
    query: run,
    async close() {
      await sql.close();
    },
  };
}

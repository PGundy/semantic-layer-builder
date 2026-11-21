import type { Adapter } from "./adapters/index.ts";

// What a Postgres connection says about the server it reached (spec: CLI, semlayer doctor). Each fact is
// read through the adapter's own query() - the one place queries run, read-only with the statement
// timeout - and is reduced to a value that names no host, user, database or project.
export interface ConnectionFacts {
  // "<major>.<minor>" from server_version_num, never the server's own text (managed services add
  // their own build names there); null when the server did not answer.
  server_version: string | null;
  server_version_num: number | null;
  // Whether this session is encrypted, from pg_stat_ssl for pg_backend_pid(): the hop between the
  // server and whoever connects to it, which behind a pooler is the pooler's hop. "unknown" when the
  // role cannot read it.
  tls: boolean | "unknown";
  tls_protocol: string | null;
  // A guess, never a measurement, and it changes nothing semlayer does. "yes" when statements run one
  // after another reported different backend pids, or when the server connection was opened longer ago
  // than this run can have lasted (both read from the server, no local clock); either only a pooler
  // that reuses server connections does. "unknown" otherwise (a direct connection and a pooler that
  // opened a fresh server connection look the same).
  pooled: "yes" | "unknown";
}

export const PROBE_STATEMENTS = 4;
// Longer than doctor's whole run (15 seconds), so a direct connection opened by this run is never older.
export const REUSED_AFTER_SECONDS = 30;
const TLS_PROTOCOL = /^(TLSv1(\.[0-3])?|SSLv3)$/;

// "16.3" from 160003; versions before 10 are not supported, so only the two-part form is read.
export function versionFromNum(num: number): string | null {
  if (!Number.isInteger(num) || num < 100000) return null;
  return `${Math.floor(num / 10000)}.${num % 10000}`;
}

export async function connectionFacts(adapter: Adapter, reusedAfterSeconds = REUSED_AFTER_SECONDS): Promise<ConnectionFacts> {
  const facts: ConnectionFacts = { server_version: null, server_version_num: null, tls: "unknown", tls_protocol: null, pooled: "unknown" };
  const pids = new Set<unknown>();
  try {
    const row = (await adapter.query("select current_setting('server_version_num') as num, pg_backend_pid() as pid")).rows[0];
    const num = Number(row?.num);
    if (Number.isInteger(num)) {
      facts.server_version_num = num;
      facts.server_version = versionFromNum(num);
    }
    pids.add(row?.pid);
    for (let i = 1; i < PROBE_STATEMENTS; i++) pids.add((await adapter.query("select pg_backend_pid() as pid")).rows[0]?.pid);
    if (pids.size > 1 && !pids.has(undefined)) facts.pooled = "yes";
  } catch {
    // The facts stay as they were: unknown.
  }
  if (facts.pooled === "unknown") {
    try {
      const row = (await adapter.query("select extract(epoch from (clock_timestamp() - backend_start)) as age from pg_stat_activity where pid = pg_backend_pid()")).rows[0];
      if (Number(row?.age) > reusedAfterSeconds) facts.pooled = "yes";
    } catch {
      // pg_stat_activity unreadable: the pid evidence stands alone.
    }
  }
  try {
    const row = (await adapter.query("select ssl, version from pg_stat_ssl where pid = pg_backend_pid()")).rows[0];
    if (typeof row?.ssl === "boolean") {
      facts.tls = row.ssl;
      if (row.ssl && typeof row.version === "string" && TLS_PROTOCOL.test(row.version)) facts.tls_protocol = row.version;
    }
  } catch {
    // pg_stat_ssl unreadable: tls stays unknown.
  }
  return facts;
}

// The facts in plain words, one line each, for doctor's text output.
export function factLines(name: string, f: ConnectionFacts): string[] {
  const version = f.server_version ? `PostgreSQL ${f.server_version} (version number ${f.server_version_num})` : "an unknown PostgreSQL version";
  const tls = f.tls === "unknown" ? "Whether the connection is encrypted could not be read with this role." : f.tls ? `The connection is encrypted${f.tls_protocol ? ` (${f.tls_protocol})` : ""}.` : "The connection is not encrypted.";
  const pooled = f.pooled === "yes" ? "A guess: the connection goes through a pooler, because the server connection is older than this run or consecutive statements ran on different ones." : "A guess, from the server connection being new and consecutive statements reporting one: no pooler was seen, but one that opened a fresh server connection looks the same.";
  return [`Source "${name}" runs on ${version}. ${tls}`, `Source "${name}": ${pooled}`];
}

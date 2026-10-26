import { SQL } from "bun";
import { UserError } from "../errors.ts";
import type { SourceConfig } from "../types.ts";
import { formatDate, formatTimestamp, normalizeDecimal, normalizeInteger } from "./normalize.ts";
import type { Adapter, QueryResult } from "./types.ts";

const INT_OIDS = new Set([20, 21, 23, 26]);
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;

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

export async function openPostgres(_root: string, source: SourceConfig, env: Record<string, string | undefined>): Promise<Adapter> {
  const varName = source.connection?.env;
  if (!varName) throw new UserError(`Source "${source.source}": set connection.env to the name of the env var holding its connection URL.`);
  const url = env[varName];
  if (!url) throw new UserError(`Source "${source.source}": env var ${varName} is not set.`);
  const timeout = Number(env.SL_STATEMENT_TIMEOUT_MS ?? 120000);
  const sql = new SQL({ url, max: 1 });
  try {
    await sql.unsafe("SET default_transaction_read_only = on");
    await sql.unsafe("SET TIME ZONE 'UTC'");
    await sql.unsafe(`SET statement_timeout = ${Math.max(0, Math.floor(timeout))}`);
  } catch (e) {
    await sql.close().catch(() => {});
    throw new UserError(`Source "${source.source}": cannot connect using ${varName}: ${(e as Error).message}`);
  }
  return {
    dialect: "postgres",
    async query(text: string): Promise<QueryResult> {
      const result = (await sql.unsafe(text)) as unknown as Record<string, unknown>[] & {
        columns?: { name: string; type: number }[];
      };
      const meta = result.columns ?? [];
      const columns = meta.length ? meta.map((c) => c.name) : Object.keys(result[0] ?? {});
      const oids = new Map(meta.map((c) => [c.name, c.type]));
      const rows = [...result].map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of columns) out[col] = convert(row[col], oids.get(col));
        return out;
      });
      return { columns, rows };
    },
    async close() {
      await sql.close();
    },
  };
}

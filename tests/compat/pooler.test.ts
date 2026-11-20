// A Postgres source through PgBouncer in transaction mode. The live tests run when
// SEMLAYER_TEST_POOLER_URL names the pooler and PG_URL the server behind it, as
// scripts/compat-network.sh and the CI `compat-network` job set them; the test straight to the server
// runs whenever PG_URL is set, and the message tests always run.
// Through the pooler, setup, introspect and profile succeed, the statement timeout cancels a long
// query, and a write is refused: every query runs in its own read-only transaction, which a pooled
// server connection cannot lose.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { openAdapter } from "../../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { connectFailure, driverConnection, openPostgres } from "../../skills/semantic-layer/scripts/lib/adapters/postgres.ts";
import type { Snapshot, SourceConfig } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "../helpers.ts";

const POOLER_URL = process.env.SEMLAYER_TEST_POOLER_URL;
const live = Boolean(POOLER_URL && PG_URL);
const schema = uniqueSchema("t_compat_pooler");
const source: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "SEMLAYER_TEST_POOLER" } };
let pg: SQL | undefined;
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

beforeAll(async () => {
  if (!live) return;
  assertLocalPg(PG_URL);
  assertLocalPg(POOLER_URL);
  pg = new SQL({ url: PG_URL!, max: 1 });
  for (const s of [
    `create schema ${schema}`,
    `create table ${schema}.customers (customer_id integer primary key, region text not null)`,
    `create table ${schema}.orders (order_id integer primary key, customer_id integer references ${schema}.customers, amount_cents bigint not null)`,
    `insert into ${schema}.customers select g, case when g % 2 = 0 then 'north' else 'south' end from generate_series(1, 20) g`,
    `insert into ${schema}.orders select g, 1 + g % 20, 100 * g from generate_series(1, 60) g`,
    `analyze ${schema}.customers`,
    `analyze ${schema}.orders`,
  ]) await pg.unsafe(s);
});

afterAll(async () => {
  if (!pg) return;
  await pg.unsafe(`drop schema if exists ${schema} cascade`);
  await pg.close();
});

// The pooler's own reading of a setting on a fresh client connection, with no startup settings.
async function pooledSetting(name: string): Promise<string> {
  const raw = new SQL({ url: POOLER_URL!, max: 1, prepare: false });
  try {
    return String(Object.values(((await raw.unsafe(`show ${name}`)) as Record<string, unknown>[])[0]!)[0]);
  } finally {
    await raw.close();
  }
}

const orderCount = async () => Number(((await pg!.unsafe(`select count(*)::int as n from ${schema}.orders`)) as { n: number }[])[0]!.n);

describe("through PgBouncer in transaction mode", () => {
  test.skipIf(!live)("setup, introspect and profile succeed, and no output holds the URL or its password", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const env = { SEMLAYER_TEST_POOLER: POOLER_URL! };
    const setup = await semlayer(t.root, ["setup", "--source", "pg", "--dialect", "postgres", "--env", "SEMLAYER_TEST_POOLER", "--schemas", schema, "--json"], env);
    expect(setup.err).not.toContain("cannot connect");
    expect(setup.code).toBe(0);
    expect(setup.json<{ snapshot: { read: boolean; tables: number } }>().snapshot).toMatchObject({ read: true, tables: 2 });
    const introspect = await semlayer(t.root, ["introspect", "--source", "pg"], env);
    expect(introspect.code).toBe(0);
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "pg.json"), "utf8")) as Snapshot;
    expect(snap.tables.map((x) => x.name).sort()).toEqual(["customers", "orders"]);
    expect(snap.tables.find((x) => x.name === "orders")!.foreign_keys?.map((fk) => fk.columns)).toEqual([["customer_id"]]);
    const profile = await semlayer(t.root, ["profile", "--source", "pg", "--json"], env);
    expect(profile.code).toBe(0);
    const profiled = profile.json<{ profiled: { table: string; row_count: number }[] }>().profiled;
    expect(profiled.map((p) => [p.table, p.row_count]).sort()).toEqual([
      [`${schema}.customers`, 20],
      [`${schema}.orders`, 60],
    ]);
    const password = decodeURIComponent(new URL(POOLER_URL!).password);
    for (const r of [setup, introspect, profile]) {
      for (const text of [r.out, r.err]) {
        expect(text).not.toContain(POOLER_URL!);
        expect(text).not.toContain(password);
      }
    }
  });

  test.skipIf(!live)("a sleep past SEMLAYER_STATEMENT_TIMEOUT_MS is cancelled, and the timeout stays inside its transaction", async () => {
    const a = await openAdapter(tempRoot().root, source, { SEMLAYER_TEST_POOLER: POOLER_URL, SEMLAYER_STATEMENT_TIMEOUT_MS: "500" }, { warn: () => {} });
    try {
      const started = Date.now();
      await expect(a.query("select pg_sleep(5)")).rejects.toThrow("statement timeout");
      expect(Date.now() - started).toBeLessThan(4000);
      expect((await a.query("show statement_timeout")).rows).toEqual([{ statement_timeout: "500ms" }]);
      expect((await a.query("show transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
      expect((await a.query("show TimeZone")).rows).toEqual([{ TimeZone: "UTC" }]);
    } finally {
      await a.close();
    }
    // The server connection the pooler hands the next client keeps no timeout.
    expect(await pooledSetting("statement_timeout")).toBe("0");
  });

  test.skipIf(!live)("a write is refused, also after a query turns the session's read-only default off", async () => {
    const before = await orderCount();
    const a = await openAdapter(tempRoot().root, source, { SEMLAYER_TEST_POOLER: POOLER_URL }, { warn: () => {} });
    try {
      await expect(a.query(`create table ${schema}.should_fail (x int)`)).rejects.toThrow("read-only transaction");
      await expect(a.query(`insert into ${schema}.orders values (1000, 1, 1)`)).rejects.toThrow("read-only transaction");
      await expect(a.query(`with x as (delete from ${schema}.orders returning 1) select count(*) from x`)).rejects.toThrow("read-only transaction");
      // The session default goes off on the shared server connection; the next query's own
      // transaction is still read-only.
      await a.query("select set_config('default_transaction_read_only', 'off', false)");
      await expect(a.query(`update ${schema}.orders set amount_cents = 0`)).rejects.toThrow("read-only transaction");
      // Whether or not the server lets a query ask for read-write, the next query is read-only again.
      await a.query("set transaction read write").catch(() => {});
      await expect(a.query(`truncate ${schema}.orders`)).rejects.toThrow("read-only transaction");
    } finally {
      await a.close();
    }
    expect(await orderCount()).toBe(before);
    const made = (await pg!.unsafe(`select count(*)::int as n from pg_tables where schemaname = '${schema}' and tablename = 'should_fail'`)) as { n: number }[];
    expect(made[0]!.n).toBe(0);
  });

  // The startup default is what a pooler that ignores the parameter loses. With none sent, only
  // BEGIN TRANSACTION READ ONLY stands between a query and a write.
  test.skipIf(!live)("a write is refused when the connection carries no read-only startup default", async () => {
    const before = await orderCount();
    const a = await openPostgres(tempRoot().root, source, { SEMLAYER_TEST_POOLER: POOLER_URL }, { warn: () => {} }, { TimeZone: "UTC" });
    try {
      // The session default is off, so only the query's own transaction is read-only.
      const raw = new SQL({ url: POOLER_URL!, max: 1, prepare: false });
      try {
        expect(Object.values(((await raw.unsafe("show default_transaction_read_only")) as Record<string, unknown>[])[0]!)[0]).toBe("off");
      } finally {
        await raw.close();
      }
      expect((await a.query("show transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
      await expect(a.query(`create table ${schema}.should_fail (x int)`)).rejects.toThrow("read-only transaction");
      await expect(a.query(`insert into ${schema}.orders values (1001, 1, 1)`)).rejects.toThrow("read-only transaction");
      await expect(a.query(`update ${schema}.orders set amount_cents = 0`)).rejects.toThrow("read-only transaction");
      await expect(a.query(`delete from ${schema}.orders`)).rejects.toThrow("read-only transaction");
    } finally {
      await a.close();
    }
    expect(await orderCount()).toBe(before);
  });

  test.skipIf(!live)("the pooler refuses statement_timeout as a startup parameter, and the message names the setting that lets it pass", async () => {
    // The startup parameter run() no longer sends, as the driver sends it.
    const raw = new SQL({ url: POOLER_URL!, max: 1, prepare: false, connection: { statement_timeout: 1000 } } as SQL.Options);
    const error = await raw.unsafe("select 1").then(
      () => null,
      (e: unknown) => e,
    );
    await raw.close().catch(() => {});
    expect(error).not.toBeNull();
    const conn = driverConnection(source, { SEMLAYER_TEST_POOLER: POOLER_URL! }, 1000);
    const refusal = connectFailure("pg", error, conn, "SEMLAYER_TEST_POOLER from the environment");
    expect(refusal.code).toBe("source.pooler_startup_parameter");
    expect(refusal.message).toContain("refuses the startup parameter statement_timeout");
    expect(refusal.message).toContain("ignore_startup_parameters");
    expect(refusal.message).toContain("run the same command again");
    expect(refusal.message).not.toContain(POOLER_URL!);
    expect(refusal.message).not.toContain(decodeURIComponent(new URL(POOLER_URL!).password));
    await conn.sql.close().catch(() => {});
  });
});

describe("straight to the server", () => {
  test.skipIf(!PG_URL)("each query's transaction is read-only and carries the statement timeout, which a sleep past it meets", async () => {
    const a = await openAdapter(tempRoot().root, { ...source, connection: { env: "PG_URL" } }, { PG_URL, SEMLAYER_STATEMENT_TIMEOUT_MS: "300" }, { warn: () => {} });
    try {
      expect((await a.query("show transaction_read_only")).rows).toEqual([{ transaction_read_only: "on" }]);
      expect((await a.query("show statement_timeout")).rows).toEqual([{ statement_timeout: "300ms" }]);
      await expect(a.query("select pg_sleep(3)")).rejects.toThrow("statement timeout");
      await expect(a.query("create table should_fail_direct (x int)")).rejects.toThrow("read-only transaction");
    } finally {
      await a.close();
    }
  });
});

describe("a pooler's refusal of a startup parameter", () => {
  const USER = "pool_reader";
  const PASSWORD = "p0ol-s3cret";
  const url = `postgres://${USER}:${encodeURIComponent(PASSWORD)}@pool.internal:6432/acme`;

  test("names the parameter, the pooler setting and the next step, and carries its code", () => {
    const conn = driverConnection(source, { SEMLAYER_TEST_POOLER: url }, 1000);
    const e = Object.assign(new Error("unsupported startup parameter: default_transaction_read_only"), { code: "ERR_POSTGRES_SERVER_ERROR" });
    const refusal = connectFailure("pg", e, conn, "SEMLAYER_TEST_POOLER from /work/.env");
    expect(refusal.code).toBe("source.pooler_startup_parameter");
    expect(refusal.message).toBe(
      'Source "pg": the connection pooler at pool.internal port 6432 (SEMLAYER_TEST_POOLER from /work/.env) refuses the startup parameter default_transaction_read_only. ' +
        "Every query also runs in a read-only transaction, so the pooler may ignore it: ask the owner to add default_transaction_read_only to ignore_startup_parameters " +
        "in the pooler's settings (pgbouncer.ini for PgBouncer), or for the server's own port instead of the pooler's, then run the same command again.",
    );
  });

  test("the message holds no URL, user or password, whatever the driver's text holds", () => {
    const parts = driverConnection(
      { source: "pg", dialect: "postgres", connection: { env_prefix: "PG" } },
      { PGHOST: "pool.internal", PGPORT: "6432", PGUSER: USER, PGPASSWORD: PASSWORD, PGDATABASE: "acme" },
      1000,
    );
    for (const conn of [driverConnection(source, { SEMLAYER_TEST_POOLER: url }, 1000), parts]) {
      for (const text of [`unsupported startup parameter: ${USER}`, `unsupported startup parameter: "options" in ${url} for ${USER} with ${PASSWORD}`]) {
        const m = connectFailure("pg", new Error(text), conn, "the environment").message;
        expect(m).not.toContain(url);
        expect(m).not.toContain(PASSWORD);
        expect(m).not.toMatch(new RegExp(`\\b${USER}\\b`));
      }
    }
  });

  test("a driver text with no parameter after the colon names no parameter", () => {
    const conn = driverConnection(source, { SEMLAYER_TEST_POOLER: url }, 1000);
    const m = connectFailure("pg", new Error("FATAL: unsupported startup parameter in options: statement_timeout"), conn, "the environment");
    expect(m.code).not.toBe("source.pooler_startup_parameter");
  });
});

describe("a blank CA file setting", () => {
  test("is read as unset, in a URL and in a prefix variable", () => {
    const noCa = { source: "pg", dialect: "postgres", connection: { env_prefix: "PG" } } as SourceConfig;
    expect(() => driverConnection(noCa, { PGHOST: "db.internal", PGUSER: "u", PGDATABASE: "d", PGSSLMODE: "require", PGSSLROOTCERT: "  " }, 1000)).not.toThrow();
    expect(() => driverConnection(source, { SEMLAYER_TEST_POOLER: "postgres://u:p@db.internal:5432/d?sslmode=require&sslrootcert=" }, 1000)).not.toThrow();
  });
});

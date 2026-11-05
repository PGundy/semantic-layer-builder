import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openAdapter } from "../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { UserError } from "../skills/semantic-layer/scripts/lib/errors.ts";
import { errorMessage, executePlan } from "../skills/semantic-layer/scripts/lib/plan.ts";
import { assertReadOnly } from "../skills/semantic-layer/scripts/lib/sql-guard.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, PG_URL, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const TYPED =
  "select 42::bigint as b, 1.5::numeric(10,2) as d, 2.5::double precision as f, date '2025-01-02' as dt, " +
  "timestamp '2025-01-02 03:04:05' as ts, 'x' as s, true as bo, null as n";
const EXPECTED = { b: 42, d: 1.5, f: 2.5, dt: "2025-01-02", ts: "2025-01-02 03:04:05", s: "x", bo: true, n: null };

describe("adapters normalize values the same way", () => {
  test("duckdb", async () => {
    const a = await openAdapter("/tmp", { source: "x", dialect: "duckdb" }, {});
    try {
      expect((await a.query(TYPED)).rows).toEqual([EXPECTED]);
    } finally {
      await a.close();
    }
  });

  test.skipIf(!PG_URL)("postgres, read-only", async () => {
    const a = await openAdapter("/tmp", { source: "x", dialect: "postgres", connection: { env: "PG_URL" } }, { PG_URL });
    try {
      expect((await a.query(TYPED)).rows).toEqual([EXPECTED]);
      await expect(a.query("create table should_fail (x int)")).rejects.toThrow();
    } finally {
      await a.close();
    }
  });

  test("duckdb file database: a view over a table reads, writes and setting changes are refused", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer)", "insert into orders values (1), (2)"]);
    const a = await openAdapter(t.root, { ...source, connection: { ...source.connection, setup: ["SET threads=2"], views: { o: "main.orders" } } }, {});
    try {
      expect((await a.query("select count(*) as n from o")).rows).toEqual([{ n: 2 }]);
      expect((await a.query("select current_setting('threads') as n")).rows).toEqual([{ n: 2 }]);
      await expect(a.query("insert into orders values (3)")).rejects.toThrow("INSERT");
      await expect(a.query("set threads = 4")).rejects.toThrow();
      await expect(a.query("select 1; select 2")).rejects.toThrow("Run one statement at a time.");
    } finally {
      await a.close();
    }
  });

  test("non-runnable dialects explain the emit-sql path", async () => {
    await expect(openAdapter("/tmp", { source: "x", dialect: "snowflake" }, {})).rejects.toThrow("--emit-sql");
  });
});

describe("read-only guard", () => {
  test.each(["select 1", "with a as (select 1) select * from a", "describe orders", "select 'drop table x' as s", "select id as comment, x as load from t"])("allows %s", (q) => {
    expect(() => assertReadOnly(q)).not.toThrow();
  });
  test.each([
    "drop table x",
    "select 1; select 2",
    "insert into t values (1)",
    "with a as (delete from t returning *) select 1",
    "attach 'x.db'",
    "explain analyze select 1",
    "explain delete from t",
  ])(
    "refuses %s",
    (q) => {
      expect(() => assertReadOnly(q)).toThrow();
    },
  );
});

describe("database errors are user errors", () => {
  async function project() {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer)", "insert into orders values (1)"]);
    return t;
  }

  test("sl run on duckdb: a SQL error exits 1 with Query failed and no stack", async () => {
    const t = await project();
    const r = await sl(t.root, ["run", "--source", "wh", "--sql", "select nope from orders"]);
    expect(r.code).toBe(1);
    expect(r.err).toStartWith("sl run: Query failed: ");
    expect(r.err).toContain("nope");
    expect(r.err).not.toContain("unexpected error");
    expect(r.err).not.toMatch(/\n\s+at /);
    const ok = await sl(t.root, ["run", "--source", "wh", "--sql", "select count(*) as n from orders", "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json<{ rows: unknown[] }>().rows).toEqual([{ n: 1 }]);
  });

  test.skipIf(!PG_URL)("sl run on postgres: a syntax error exits 1 with Query failed and no stack", async () => {
    const t = await project();
    writeYaml(join(t.root, "sources", "pg.yaml"), { source: "pg", dialect: "postgres", connection: { env: "PG_URL" } });
    const r = await sl(t.root, ["run", "--source", "pg", "--sql", "select to_char(now(), 'YYYY') month from"], { PG_URL });
    expect(r.code).toBe(1);
    // The test server's role is a superuser, so the connection warning comes first.
    const [warning, error] = r.err.split("\n");
    expect(warning).toBe('Warning: source "pg" connects as a superuser. Queries run read-only, but connect with a SELECT-only role.');
    expect(error).toStartWith("sl run: Query failed: ");
    expect(r.err).toContain("syntax error");
    expect(r.err).not.toContain("unexpected error");
    expect(r.err).not.toContain(PG_URL!);
    expect(r.err).toContain('syntax error at or near "month" (at character 31: "month from")');
  });

  test.skipIf(!PG_URL)("executePlan on postgres names the error position with a query excerpt", async () => {
    const t = await project();
    const source = { source: "pg", dialect: "postgres" as const, connection: { env: "PG_URL" } };
    const sql = "select nope_column_with_a_long_name, 1 as x from pg_class";
    const plan = { command: "test", source: "pg", dialect: "postgres" as const, queries: [{ id: "q1", purpose: "A broken query", sql }] };
    const err = await executePlan(plan, { root: t.root, source, env: { PG_URL } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message.split("\n")[0]).toBe(
      'Query failed: column "nope_column_with_a_long_name" does not exist (at character 8: "nope_column_with_a_l…")',
    );
  });

  test("errorMessage adds a driver's position and an excerpt only when the error carries one", () => {
    const withPosition = Object.assign(new Error("syntax error"), { position: "8" });
    expect(errorMessage(withPosition, "select\n  from\t\tx where")).toBe('syntax error (at character 8: "from x where")');
    expect(errorMessage(withPosition)).toBe("syntax error (at character 8)");
    expect(errorMessage(Object.assign(new Error("bad"), { position: 99 }), "select 1")).toBe("bad (at character 99)");
    expect(errorMessage(Object.assign(new Error("bad"), { position: 3 }), "ab   ")).toBe("bad (at character 3)");
    for (const position of [undefined, null, "", "x", 0, -1, 1.5]) {
      expect(errorMessage(Object.assign(new Error("bad"), { position }), "select 1")).toBe("bad");
    }
    const emoji = "select '\u{1F600}\u{1F600}\u{1F600}' || nosuch";
    expect(errorMessage(Object.assign(new Error("bad"), { position: 17 }), emoji)).toBe('bad (at character 17: "nosuch")');
    expect(errorMessage(Object.assign(new Error("bad"), { position: 23 }), emoji)).toBe("bad (at character 23)");
    expect(errorMessage(new Error(""))).toBe("Error");
    expect(errorMessage("plain")).toBe("plain");
  });

  test("executePlan turns a failing query into a UserError that names the query", async () => {
    const t = await project();
    const source = { source: "wh", dialect: "duckdb" as const, connection: { database: join(t.dir, "wh.duckdb") } };
    const plan = { command: "test", source: "wh", dialect: "duckdb" as const, queries: [{ id: "q1", purpose: "A broken query", sql: "select nope from orders" }] };
    const err = await executePlan(plan, { root: t.root, source, env: {} }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserError);
    const message = (err as Error).message;
    expect(message.split("\n")[0]).toStartWith("Query failed: ");
    expect(message.split("\n")[0]).toContain("nope");
    expect(message).toEndWith('\nQuery "q1" (A broken query):\nselect nope from orders');
  });
});

describe("timestamptz values render in UTC whatever the process time zone", () => {
  async function project() {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", [
      "create table orders (id integer, created_at timestamptz)",
      "insert into orders values (1, '2025-01-01 00:30:00+00')",
    ]);
    return t;
  }
  const SQL = "select current_setting('TimeZone') as tz, date_trunc('day', created_at) as d, created_at from orders";
  const UTC_ROW = { tz: "UTC", d: "2025-01-01 00:00:00+00", created_at: "2025-01-01 00:30:00+00" };

  test("sl run and executePlan reset the DuckDB client's local offset", async () => {
    const t = await project();
    const { DuckDBTimestampTZValue } = await import("@duckdb/node-api");
    const before = DuckDBTimestampTZValue.timezoneOffsetInMinutes;
    try {
      DuckDBTimestampTZValue.timezoneOffsetInMinutes = -240;
      const r = await sl(t.root, ["run", "--source", "wh", "--sql", SQL, "--json"]);
      expect(r.code).toBe(0);
      expect(r.json<{ rows: unknown[] }>().rows).toEqual([UTC_ROW]);

      DuckDBTimestampTZValue.timezoneOffsetInMinutes = 330;
      const source = { source: "wh", dialect: "duckdb" as const, connection: { database: join(t.dir, "wh.duckdb") } };
      const plan = { command: "test", source: "wh", dialect: "duckdb" as const, queries: [{ id: "q", purpose: "tz", sql: SQL }] };
      expect((await executePlan(plan, { root: t.root, source, env: {} })).q).toEqual([UTC_ROW]);
    } finally {
      DuckDBTimestampTZValue.timezoneOffsetInMinutes = before;
    }
  });

  test("the CLI under TZ=America/New_York prints +00 values", async () => {
    const t = await project();
    const cli = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "sl.ts");
    const proc = Bun.spawnSync([process.execPath, cli, "run", "--source", "wh", "--sql", SQL, "--json", "--root", t.root], {
      env: { ...process.env, TZ: "America/New_York" },
      cwd: t.root,
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).rows).toEqual([UTC_ROW]);
  });
});

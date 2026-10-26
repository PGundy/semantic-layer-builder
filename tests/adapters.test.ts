import { describe, expect, test } from "bun:test";
import { openAdapter } from "../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { assertReadOnly } from "../skills/semantic-layer/scripts/lib/sql-guard.ts";
import { PG_URL } from "./helpers.ts";

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

  test("non-runnable dialects explain the emit-sql path", async () => {
    await expect(openAdapter("/tmp", { source: "x", dialect: "snowflake" }, {})).rejects.toThrow("--emit-sql");
  });
});

describe("read-only guard", () => {
  test.each(["select 1", "with a as (select 1) select * from a", "describe orders", "select 'drop table x' as s"])("allows %s", (q) => {
    expect(() => assertReadOnly(q)).not.toThrow();
  });
  test.each(["drop table x", "select 1; select 2", "insert into t values (1)", "with a as (delete from t returning *) select 1", "attach 'x.db'"])(
    "refuses %s",
    (q) => {
      expect(() => assertReadOnly(q)).toThrow();
    },
  );
});

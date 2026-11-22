// What semlayer doctor reports about the server it reached (spec: CLI, semlayer doctor): version, whether
// this session is encrypted, and the labelled guess whether a pooler is in the way. Runs on whatever
// PG_URL names; the TLS and pooler cases run when scripts/compat-network.sh's variables are set, as
// tests/compat/tls.test.ts and pooler.test.ts do.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectionFacts, factLines, versionFromNum } from "../../skills/semantic-layer/scripts/lib/provider-facts.ts";
import { openAdapter } from "../../skills/semantic-layer/scripts/lib/adapters/index.ts";
import type { SourceConfig } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { PG_URL, semlayer, serverVersionNum, tempRoot } from "../helpers.ts";

const ACME = join(import.meta.dir, "..", "..", "examples", "acme", "semantic");
const TLS_URL = process.env.SEMLAYER_TEST_TLS_URL;
const CA = process.env.SEMLAYER_TEST_TLS_CA;
const POOLER_URL = process.env.SEMLAYER_TEST_POOLER_URL;

interface Facts {
  server_version: string | null;
  server_version_num: number | null;
  tls: boolean | "unknown" | null;
  tls_protocol: string | null;
  pooled: "yes" | "unknown" | null;
  connections: { source: string; server_version: string; tls: unknown; pooled: unknown }[];
  ok: boolean;
  shell_line: string;
  next: unknown;
  checks: { check: string; status: string; text: string }[];
}
async function doctor(env: Record<string, string>) {
  const json = await semlayer(ACME, ["doctor", "--json"], env);
  const plain = await semlayer(ACME, ["doctor"], env);
  return { d: json.json<Facts>(), plain: plain.out, all: json.out + json.err + plain.out + plain.err };
}

describe("versionFromNum", () => {
  test("reduces server_version_num to major.minor and refuses what it cannot read", () => {
    expect(versionFromNum(160003)).toBe("16.3");
    expect(versionFromNum(130014)).toBe("13.14");
    expect(versionFromNum(90624)).toBeNull();
    expect(versionFromNum(Number.NaN)).toBeNull();
  });
});

describe("factLines", () => {
  test("says each fact in plain words and labels the pooler line a guess", () => {
    const [a, b] = factLines("w", { server_version: "16.3", server_version_num: 160003, tls: true, tls_protocol: "TLSv1.3", pooled: "unknown" });
    expect(a).toBe('Source "w" runs on PostgreSQL 16.3 (version number 160003). The connection is encrypted (TLSv1.3).');
    expect(b).toContain("A guess");
    expect(factLines("w", { server_version: null, server_version_num: null, tls: "unknown", tls_protocol: null, pooled: "yes" }).join("\n")).toContain("could not be read");
  });
});

describe("doctor on a DuckDB source", () => {
  test("holds the new keys as null and keeps every old key", async () => {
    const { d } = await doctor({});
    expect(d).toMatchObject({ server_version: null, server_version_num: null, tls: null, tls_protocol: null, pooled: null, connections: [] });
    for (const k of ["ok", "checks", "shell_line", "permission_rule", "next"]) expect(d).toHaveProperty(k);
  });
});

describe("doctor on a local PostgreSQL", () => {
  test.skipIf(!PG_URL)("holds server_version and tls, keeps every old key, and prints the three facts in words", async () => {
    const { d, plain, all } = await doctor({ WAREHOUSE_URL: PG_URL! });
    const num = await serverVersionNum(PG_URL!);
    expect(d.server_version_num).toBe(num);
    expect(d.server_version).toBe(`${Math.floor(num / 10000)}.${num % 10000}`);
    expect(d.tls).toBe(false);
    expect(d.tls_protocol).toBeNull();
    expect(d.pooled).toBe("unknown");
    expect(d.connections).toMatchObject([{ source: "warehouse", server_version: d.server_version, tls: false, pooled: "unknown" }]);
    for (const k of ["ok", "checks", "shell_line", "permission_rule", "next"]) expect(d).toHaveProperty(k);
    expect(d.checks.map((c) => c.check)).toEqual(expect.arrayContaining(["bun", "packages", "project", "connection warehouse", "query warehouse", "role warehouse", "command"]));
    expect(plain).toContain(`Source "warehouse" runs on PostgreSQL ${d.server_version} (version number ${num}). The connection is not encrypted.`);
    expect(plain).toContain('Source "warehouse": A guess');
    expect(all).not.toContain(PG_URL!);
  });

  test.skipIf(!PG_URL)("the pooled guess fires on a server connection older than the limit and not on a new one", async () => {
    const source: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "SEMLAYER_TEST_PG" } };
    const a = await openAdapter(tempRoot().root, source, { SEMLAYER_TEST_PG: PG_URL }, { warn: () => {} });
    try {
      await a.query("select 1");
      expect((await connectionFacts(a)).pooled).toBe("unknown");
      await Bun.sleep(1500);
      expect((await connectionFacts(a, 1)).pooled).toBe("yes");
    } finally {
      await a.close();
    }
  });

  test.skipIf(!PG_URL)("reads the facts through the adapter's own read-only query", async () => {
    const source: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "SEMLAYER_TEST_PG" } };
    const a = await openAdapter(tempRoot().root, source, { SEMLAYER_TEST_PG: PG_URL }, { warn: () => {} });
    try {
      const f = await connectionFacts(a);
      expect(f).toMatchObject({ tls: false, pooled: "unknown" });
      const rejects = { query: async (sql: string) => (/pg_stat_ssl/.test(sql) ? Promise.reject(new Error("permission denied")) : a.query(sql)) } as typeof a;
      expect((await connectionFacts(rejects)).tls).toBe("unknown");
    } finally {
      await a.close();
    }
  });
});

describe("doctor through the TLS and pooler containers", () => {
  test.skipIf(!(TLS_URL && CA))("a TLS-only server: tls is true and names the protocol", async () => {
    const u = new URL(TLS_URL!);
    u.searchParams.set("sslmode", "verify-ca");
    u.searchParams.set("sslrootcert", CA!);
    const { d, plain } = await doctor({ WAREHOUSE_URL: u.toString() });
    expect(d.tls).toBe(true);
    expect(d.tls_protocol).toMatch(/^TLSv1\.[23]$/);
    expect(plain).toContain("The connection is encrypted (TLSv1.");
  });

  test.skipIf(!POOLER_URL)("PgBouncer in transaction mode: a server connection other clients opened earlier is seen as pooled, and the run is unchanged", async () => {
    const source: SourceConfig = { source: "pool", dialect: "postgres", connection: { env: "SEMLAYER_TEST_POOL" } };
    const open = () => openAdapter(tempRoot().root, source, { SEMLAYER_TEST_POOL: POOLER_URL }, { warn: () => {} });
    const warm = await open();
    await warm.query("select 1");
    await warm.close();
    await Bun.sleep(3000);
    const a = await open();
    try {
      expect((await connectionFacts(a, 2)).pooled).toBe("yes");
    } finally {
      await a.close();
    }
    const { d, plain } = await doctor({ WAREHOUSE_URL: POOLER_URL! });
    expect(d.checks.find((c) => c.check === "query warehouse")?.status).toBe("ok");
    expect(["yes", "unknown"]).toContain(d.pooled as string);
    expect(plain).toContain('Source "warehouse": A guess');
  });
});

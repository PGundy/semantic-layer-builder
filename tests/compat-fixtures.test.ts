// The provider kit (docs/compat/postgres.md, scripts/compat-provider.sh): the fixture it writes is built
// from an allowlist and checked once more before it is written; the committed fixtures match that
// allowlist, hold no host, URL or address, and are the rows of the provider table. All values here are
// synthetic.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixture, checkFixture, FIXTURES_DIR, fixtureFiles, leaks, looksLikeLeak, outputPath, providerTable, runProvider, secretsOf, URL_VARIABLE } from "../scripts/compat-provider.ts";
import { PG_URL, tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, FIXTURES_DIR);
const FAKE = "postgres://svc_reader_q7:pw-Zx81-hidden@db.abcdwxyzprojref.example-cloud.test:6543/appdb_distinct?sslmode=require";
const counts = { tables: 2, views: 1, columns: 7, foreign_keys: 1 };
const conn = { source: "provider", server_version: "16.3", server_version_num: 160003, tls: true, tls_protocol: "TLSv1.3", pooled: "unknown" };
// A doctor --json that names the host, user, database and password in every text field it has.
const hostile = {
  ok: true,
  checks: [
    { check: "role provider", status: "ok", text: "connects as svc_reader_q7 to db.abcdwxyzprojref.example-cloud.test", fix: "pw-Zx81-hidden" },
    { check: "query provider", status: "ok", text: "appdb_distinct 10.1.2.3 postgres://u:p@h/d" },
  ],
  connections: [{ ...conn, source: "appdb_distinct", server_version_string: "16.3 (abcdwxyzprojref build)" }],
  next: { command: "semlayer draft", why: "db.abcdwxyzprojref.example-cloud.test" },
};

describe("the fixture is built from an allowlist", () => {
  test("a doctor output full of the URL's parts yields a fixture with none of them, nor an address", () => {
    const f = buildFixture("neon", hostile, counts);
    expect(checkFixture(f)).toEqual([]);
    expect(f).toEqual({ fixture: 1, provider: "neon", server_version: "16.3", server_version_num: 160003, tls: true, tls_protocol: "TLSv1.3", pooled: "unknown", read_only_role: true, catalog: counts });
    expect(leaks(f, secretsOf(FAKE))).toEqual([]);
    const text = JSON.stringify(f);
    for (const s of ["svc_reader_q7", "pw-Zx81-hidden", "abcdwxyzprojref", "appdb_distinct", "example-cloud", "10.1.2.3", "://"]) expect(text).not.toContain(s);
  });

  test("a value outside the allowed sets becomes unknown, never text", () => {
    const f = buildFixture("rds", { checks: [], connections: [{ ...conn, tls: "db.host.test", pooled: "10.0.0.1", tls_protocol: 7 }] }, counts);
    expect(f).toMatchObject({ tls: "unknown", pooled: "unknown", tls_protocol: null, read_only_role: null });
  });

  test("no connection in doctor's output is an error, not an empty fixture", () => {
    expect(() => buildFixture("rds", { checks: [], connections: [] }, counts)).toThrow("did not answer");
  });
});

describe("the final check fails closed", () => {
  const good = buildFixture("neon", hostile, counts);
  const secrets = secretsOf(FAKE);
  test("each part of the URL, an address and a URL in any field is a leak", () => {
    for (const bad of ["svc_reader_q7", "pw-Zx81-hidden", "appdb_distinct", "db.abcdwxyzprojref.example-cloud.test", "192.168.0.7", "fe80::1:2", "https://example.org/x", "abcdwxyzprojref.supabase.co"]) {
      expect(leaks({ ...good, tls_protocol: bad }, secrets).length).toBeGreaterThan(0);
      expect(leaks({ ...good, catalog: { ...good.catalog, [bad]: 1 } }, secrets).length).toBeGreaterThan(0);
    }
    expect(leaks(good, secrets)).toEqual([]);
  });

  test("a short part is matched as a whole string, not inside any word", () => {
    const short = secretsOf("postgres://ab:cd@h:5432/xy");
    expect(leaks(good, short)).toEqual([]);
    expect(leaks({ ...good, provider: "ab" }, short).length).toBeGreaterThan(0);
  });

  test("looksLikeLeak accepts the values a fixture holds", () => {
    for (const ok of ["16.3", "TLSv1.3", "cloud-sql", "unknown", "yes"]) expect(looksLikeLeak(ok)).toBe(false);
  });

  test.skipIf(!PG_URL)("a build that leaks stops the run with nothing written and no value said", async () => {
    const fx = tempDir();
    const out = join(fx, "leak-probe.json");
    const user = decodeURIComponent(new URL(PG_URL!).username);
    const said: string[] = [];
    const code = await runProvider(["other", "public", out], { [URL_VARIABLE]: PG_URL! }, { say: (t) => said.push(t), fixturesDir: fx, build: () => ({ ...good, provider: "other", tls_protocol: user }) });
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(said.join("\n")).toContain("No fixture was written");
    expect(said.join("\n")).not.toContain(PG_URL!);
  });
});

describe("the script's arguments", () => {
  test("refuses a provider outside the list, an output outside the fixtures folder, and an unset URL", async () => {
    const said: string[] = [];
    const say = (t: string) => said.push(t);
    expect(await runProvider(["acme-cloud", "public", join(FIXTURES, "x.json")], { [URL_VARIABLE]: FAKE }, { say })).toBe(2);
    expect(await runProvider(["other", "public", join(REPO, "x.json")], { [URL_VARIABLE]: FAKE }, { say })).toBe(2);
    expect(await runProvider(["other", "public", join(FIXTURES, "x.json")], {}, { say })).toBe(2);
    expect(await runProvider(["other", "public", join(FIXTURES, "x.json")], { [URL_VARIABLE]: "not a url" }, { say })).toBe(2);
    expect(said.join("\n")).not.toContain("not a url");
    expect(outputPath(join(FIXTURES, "../../../etc/x.json"))).toBeUndefined();
    expect(outputPath(join(FIXTURES, "sub/x.json"))).toBeUndefined();
    expect(outputPath(join(FIXTURES, "neon.json"))).toBe(join(FIXTURES, "neon.json"));
  });
});

describe("a run against the local PostgreSQL", () => {
  test.skipIf(!PG_URL)("writes a fixture with none of the URL's parts, and says it is safe to commit", async () => {
    const fx = tempDir();
    const out = join(fx, "probe-run.json");
    const said: string[] = [];
    const admin = new SQL(PG_URL!);
    try {
      await admin.unsafe("drop schema if exists zzv_probe cascade");
      await admin.unsafe("create schema zzv_probe");
      await admin.unsafe("create table zzv_probe.t (id int primary key)");
      const code = await runProvider(["local", "zzv_probe", out], { [URL_VARIABLE]: PG_URL! }, { say: (t) => said.push(t), fixturesDir: fx, makeTemp: tempDir });
      expect(code).toBe(0);
      const f = JSON.parse(readFileSync(out, "utf8"));
      expect(checkFixture(f)).toEqual([]);
      expect(leaks(f, secretsOf(PG_URL!))).toEqual([]);
      expect(said.join("\n")).toContain("safe to commit");
      expect(said.join("\n")).not.toContain(PG_URL!);
    } finally {
      await admin.unsafe("drop schema if exists zzv_probe cascade");
      await admin.close();
    }
  });

  test.skipIf(!PG_URL)("a schema with no visible table or view writes nothing and names the fix", async () => {
    const fx = tempDir();
    const out = join(fx, "none.json");
    const said: string[] = [];
    const code = await runProvider(["other", "zz_no_such_schema", out], { [URL_VARIABLE]: PG_URL! }, { say: (t) => said.push(t), fixturesDir: fx, makeTemp: tempDir });
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(said.join("\n")).toContain("--print-role-sql");
  });

  test.skipIf(!PG_URL)("a URL that does not work writes nothing, prints no part of it and names the commands that show why", async () => {
    const u = new URL(PG_URL!);
    const bad = `postgres://zzuserqq:zzpassqq@${u.host}/zzdbqq${u.search}`;
    const fx = tempDir();
    const out = join(fx, "bad.json");
    const said: string[] = [];
    const code = await runProvider(["other", "public", out], { [URL_VARIABLE]: bad }, { say: (t) => said.push(t), fixturesDir: fx, makeTemp: tempDir });
    const text = said.join("\n");
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
    for (const s of ["zzuserqq", "zzpassqq", "zzdbqq", bad]) expect(text).not.toContain(s);
    expect(text).toContain("semlayer setup --source provider");
    expect(text).toContain("semlayer doctor");
  });
});

describe("a SELECT-only role on a synthetic schema", () => {
  test.skipIf(!PG_URL)("gives exact counts, read_only_role true, and none of the role, password or names", async () => {
    const admin = new SQL(PG_URL!);
    const u = new URL(PG_URL!);
    const fx = tempDir();
    const out = join(fx, "role.json");
    try {
      await admin.unsafe("drop schema if exists zzv_shop cascade");
      await admin.unsafe("drop role if exists zzv_reader_77");
      await admin.unsafe("create schema zzv_shop");
      await admin.unsafe("create table zzv_shop.customer (id int primary key, nm text)");
      await admin.unsafe("create table zzv_shop.orders (id int primary key, customer_id int references zzv_shop.customer(id), amt numeric(10,2))");
      await admin.unsafe("create view zzv_shop.v_orders as select id, amt from zzv_shop.orders");
      await admin.unsafe("create role zzv_reader_77 login password 'zzv_Secret_pw_91'");
      await admin.unsafe("grant usage on schema zzv_shop to zzv_reader_77");
      await admin.unsafe("grant select on all tables in schema zzv_shop to zzv_reader_77");
      const url = `postgres://zzv_reader_77:zzv_Secret_pw_91@${u.host}${u.pathname}${u.search}`;
      const said: string[] = [];
      expect(await runProvider(["local", "zzv_shop", out], { [URL_VARIABLE]: url }, { say: (t) => said.push(t), fixturesDir: fx, makeTemp: tempDir })).toBe(0);
      const text = readFileSync(out, "utf8");
      const f = JSON.parse(text);
      expect(f.catalog).toEqual({ tables: 2, views: 1, columns: 7, foreign_keys: 1 });
      expect(f.read_only_role).toBe(true);
      for (const s of ["zzv_reader_77", "zzv_Secret_pw_91", "zzv_shop", "customer", "orders"]) {
        expect(text).not.toContain(s);
        expect(said.join("\n")).not.toContain(s);
      }
    } finally {
      await admin.unsafe("drop schema if exists zzv_shop cascade");
      await admin.unsafe("drop owned by zzv_reader_77").catch(() => {});
      await admin.unsafe("drop role if exists zzv_reader_77");
      await admin.close();
    }
  });
});

describe("a host given as a query parameter", () => {
  test("is a secret too", () => {
    const s = secretsOf("postgres://u:p@localhost/db?host=abc.pooler.example.test,def.example.test&hostaddr=10.0.0.5");
    expect(s).toEqual(expect.arrayContaining(["abc.pooler.example.test", "def.example.test", "10.0.0.5"]));
  });
});

describe("the committed fixtures", () => {
  const files = fixtureFiles();
  test("there is at least the local worked example, and every fixture matches the allowlist schema", () => {
    expect(files).toContain("local.json");
    expect(files.filter((f) => !f.endsWith(".json"))).toEqual([]);
    for (const f of files) {
      const text = readFileSync(join(FIXTURES, f), "utf8");
      const value = JSON.parse(text);
      expect({ file: f, problems: checkFixture(value) }).toEqual({ file: f, problems: [] });
      expect({ file: f, leaks: leaks(value, []) }).toEqual({ file: f, leaks: [] });
      expect(text.includes("://")).toBe(false);
    }
  });

  test("docs/compat/postgres.md lists exactly the fixtures present", () => {
    const doc = readFileSync(join(REPO, "docs", "compat", "postgres.md"), "utf8");
    const m = /<!-- provider-table:start -->\n([\s\S]*?)\n<!-- provider-table:end -->/.exec(doc);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(providerTable());
    const rows = m![1]!.split("\n").slice(2).map((r) => /^\| `([^`]+)`/.exec(r)?.[1]);
    expect(rows).toEqual(files);
  });

  test("a provider other than local appears only with its fixture", () => {
    const doc = readFileSync(join(REPO, "docs", "compat", "postgres.md"), "utf8");
    const table = /<!-- provider-table:start -->\n([\s\S]*?)\n<!-- provider-table:end -->/.exec(doc)![1]!;
    for (const p of ["supabase", "neon", "rds", "cloud-sql"]) if (!files.some((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")).provider === p)) expect(table).not.toContain(`| ${p} |`);
  });
});

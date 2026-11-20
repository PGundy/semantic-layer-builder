import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { CHINOOK_SCRIPT, CHINOOK_TABLES, loadChinook, splitStatements } from "../fixtures/chinook/load-postgres.ts";
import { assertLocalPg, initProject, PG_URL, semlayer, tempRoot, uniqueSchema } from "./helpers.ts";

const SHA256 = "e3fde5c1a5b51a2a91429a702c9ca6e69ba56e6c7f5e112724d70c3d03db695e";

describe("the vendored Chinook script", () => {
  test("has the pinned hash, read as bytes", () => {
    expect(createHash("sha256").update(readFileSync(CHINOOK_SCRIPT)).digest("hex")).toBe(SHA256);
  });

  test("the licence file is unchanged", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../fixtures/chinook/LICENSE.md", import.meta.url))).digest("hex")).toBe(
      "5064d720db431474b0a0b0cef9d2b5e362b6c6f80602b35c6443b07cbc979f77",
    );
  });

  test("splits into statements without the database lines", () => {
    const all = splitStatements(readFileSync(CHINOOK_SCRIPT, "utf8"));
    expect(all.some((s) => /^create table album/i.test(s))).toBe(true);
    expect(all.filter((s) => /^insert into invoice \(/i.test(s)).length).toBe(1);
    expect(all.filter((s) => /^\\/.test(s)).length).toBe(0);
  });

  test("the loader refuses a schema name that is not a plain identifier", async () => {
    await expect(loadChinook("postgres://unused", 'x"; drop schema public; --')).rejects.toThrow("invalid schema name");
    await expect(loadChinook("postgres://unused", "Upper")).rejects.toThrow("invalid schema name");
  });
});

describe("loadChinook on a live Postgres", () => {
  test.skipIf(!PG_URL)("fills a schema, supports setup and validate, and leaves nothing behind", async () => {
    assertLocalPg(PG_URL);
    const schema = uniqueSchema("chinook");
    const pg = new SQL({ url: PG_URL!, max: 1 });
    const t = tempRoot();
    try {
      const { rows } = await loadChinook(PG_URL!, schema);
      expect(Object.keys(rows).sort()).toEqual([...CHINOOK_TABLES].sort());
      expect(rows.invoice).toBe(412);
      expect(rows.playlist_track).toBe(8715);
      const range = (await pg.unsafe(
        `SELECT min(invoice_date)::date::text AS first, max(invoice_date)::date::text AS last FROM "${schema}".invoice`,
      )) as { first: string; last: string }[];
      expect(range[0]).toEqual({ first: "2021-01-01", last: "2025-12-22" });

      await initProject(t.root);
      const env = { PG_URL };
      const setup = await semlayer(t.root, ["setup", "--source", "chinook", "--dialect", "postgres", "--env", "PG_URL", "--schemas", schema, "--json"], env);
      expect(setup.err).toBe("");
      expect(setup.code).toBe(0);
      const snap = JSON.parse(readFileSync(`${t.root}/snapshots/chinook.json`, "utf8")) as { tables: { schema: string; name: string }[] };
      expect(snap.tables.filter((x) => x.schema === schema).map((x) => x.name).sort()).toEqual([...CHINOOK_TABLES].sort());
      const v = await semlayer(t.root, ["validate", "--json"], env);
      expect(v.code).toBe(0);
    } finally {
      t.cleanup();
      await pg.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const left = (await pg.unsafe(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${schema}'`)) as { n: number }[];
      await pg.close();
      expect(left[0]!.n).toBe(0);
    }
  });
});

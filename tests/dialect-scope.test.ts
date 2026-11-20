import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { semlayer, tempDir } from "./helpers.ts";

// The product offers Postgres, with DuckDB for sample data and files; the other dialects' code is kept
// (references/other-dialects.md) but no longer offered to a new user.
const SKILL_DIR = join(import.meta.dir, "..", "skills", "semantic-layer");
const OTHER = /\b(snowflake|bigquery|databricks|redshift|mysql|sql ?server)\b/i;

describe("the first turn offers Postgres and DuckDB only", () => {
  test("semlayer next --json on a fresh project names postgres and duckdb, and no other dialect", async () => {
    const dir = tempDir();
    const root = join(dir, "semantic");
    for (const args of [["next", "--json"], ["next"]]) {
      const r = await semlayer(root, args);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/\bPostgres\b/);
      expect(r.out).toMatch(/\bDuckDB\b/);
      expect(r.out).not.toMatch(OTHER);
    }
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("the intake card names no other dialect, and other-dialects.md holds what moved", () => {
    const card = readFileSync(join(SKILL_DIR, "references", "phases", "intake.md"), "utf8");
    expect(card.match(OTHER)?.[0] ?? "").toBe("");
    expect(card).toContain("`references/other-dialects.md`");
    const other = readFileSync(join(SKILL_DIR, "references", "other-dialects.md"), "utf8");
    for (const heading of ["## The query-plan protocol", "### Snowflake", "### BigQuery", "### Databricks"]) expect(other).toContain(heading);
    const intake = readFileSync(join(SKILL_DIR, "references", "intake.md"), "utf8");
    for (const heading of ["## The query-plan protocol", "### Snowflake", "### BigQuery", "### Databricks"]) expect(intake).not.toContain(heading);
    for (const kept of ["### Time zones, every dialect", "### Postgres"]) expect(intake).toContain(kept);
  });

  test("the README offers no agent-tool intake path", () => {
    const readme = readFileSync(join(SKILL_DIR, "..", "..", "README.md"), "utf8");
    expect(readme).not.toContain("through the agent's own warehouse tool");
  });
});

describe("the other dialects' code is kept", () => {
  test("export-sql --dialect mysql still prints its catalog query and the import", async () => {
    const dir = tempDir();
    const root = join(dir, "semantic");
    const r = await semlayer(root, ["export-sql", "--dialect", "mysql", "--json"]);
    expect(r.code).toBe(0);
    const j = r.json<{ dialect: string; sql: string; run_hint: string }>();
    expect(j.dialect).toBe("mysql");
    expect(j.sql).toBe(readFileSync(join(SKILL_DIR, "references", "exports", "mysql.sql"), "utf8"));
    expect(j.run_hint).toContain("semlayer import --source");
  });
});

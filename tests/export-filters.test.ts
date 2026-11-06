import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadPostgres } from "../fixtures/acme/load-postgres.ts";
import { EXPORT_DIALECTS, EXPORTS_DIR, type ExportDialect, exportSql } from "../skills/semantic-layer/scripts/commands/export-sql.ts";
import { applyTableFilter, portableRegex } from "../skills/semantic-layer/scripts/lib/export-filters.ts";
import { filterInScope } from "../skills/semantic-layer/scripts/lib/patterns.ts";
import type { Snapshot } from "../skills/semantic-layer/scripts/lib/types.ts";
import { assertLocalPg, initProject, PG_URL, sl, tempRoot, uniqueSchema } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const raw = (d: string) => readFileSync(join(EXPORTS_DIR, `${d}.sql`), "utf8");

// The fixed pattern set of the golden tests: an exact name, a glob, a qualified glob with ?,
// a quoted case-exact part next to a case-insensitive one, regexes (one qualified), and
// an exact name holding a quote and a backslash.
const INCLUDE = ["orders", "fct_*", "analytics.dim_?", '"Sales".fct_*', "re:stg_(orders|customers)\\d*"];
const EXCLUDE = ["*_tmp", '"Archive"', "re:.*\\.bak_\\d+", "o'brien\\x"];

// The filter lines a query holds, from each sl:table-filter opening line to its ")".
function block(sql: string): string[] {
  const out: string[] = [];
  let on = false;
  for (const l of sql.split("\n")) {
    if (/-- sl:table-filter: (include|exclude)$/.test(l)) on = true;
    if (on) out.push(l);
    if (on && /^\s*\)$/.test(l)) on = false;
  }
  return out;
}

const header = (sql: string) => {
  const lines = sql.split("\n");
  const at = lines.indexOf("-- Table filter (sl export-sql --include/--exclude). The query reads table definitions only, never table data.");
  const end = lines.findIndex((l, i) => i > at && !l.startsWith("--"));
  return lines.slice(at, end);
};

// A case-insensitive letter is lowered only where the dialect's lower() changes A-Z alone
// (Postgres under the C collation) or the pattern has no i or k (which lower() also makes
// from İ and the Kelvin sign); elsewhere it is a class of its cases in a case-sensitive regex.
const GOLDEN: Record<ExportDialect, string[]> = {
  postgres: [
    "    and (  -- sl:table-filter: include",
    "      lower(c.relname collate \"C\") in ('orders')",
    "      or lower(c.relname collate \"C\") like 'fct!_%' escape '!'",
    "      or lower((n.nspname || '.' || c.relname) collate \"C\") like 'analytics.dim!__' escape '!'",
    "      or (n.nspname || '.' || c.relname) ~ '^(Sales[.][fF][cC][tT]_.*)$'",
    "      or c.relname ~ '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$'",
    "    )",
    "    and not (  -- sl:table-filter: exclude",
    "      lower(c.relname collate \"C\") like '%!_tmp' escape '!'",
    "      or c.relname in ('Archive')",
    "      or (n.nspname || '.' || c.relname) ~ '^(.*[.][bB][aA][kK]_[0-9]+)$'",
    "      or lower(c.relname collate \"C\") in (E'o''brien\\\\x')",
    "    )",
  ],
  redshift: [
    "    and (  -- sl:table-filter: include",
    "      c.relname ~ '^([oO][rR][dD][eE][rR][sS])$'",
    "      or c.relname ~ '^([fF][cC][tT]_.*)$'",
    "      or (n.nspname || '.' || c.relname) ~ '^([aA][nN][aA][lL][yY][tT][iI][cC][sS][.][dD][iI][mM]_.)$'",
    "      or (n.nspname || '.' || c.relname) ~ '^(Sales[.][fF][cC][tT]_.*)$'",
    "      or c.relname ~ '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$'",
    "    )",
    "    and not (  -- sl:table-filter: exclude",
    "      c.relname ~ '^(.*_[tT][mM][pP])$'",
    "      or c.relname in ('Archive')",
    "      or (n.nspname || '.' || c.relname) ~ '^(.*[.][bB][aA][kK]_[0-9]+)$'",
    "    )",
  ],
  mysql: [
    "  and not (  -- sl:table-filter: exclude",
    "    convert(lower(c.table_name) using utf8mb4) collate utf8mb4_bin like '%!_tmp' escape '!'",
    "    or convert(c.table_name using utf8mb4) collate utf8mb4_bin like 'Archive' escape '!'",
    "  )",
  ],
  sqlserver: [
    "    and not (  -- sl:table-filter: exclude",
    "      o.name collate Latin1_General_100_BIN2 like N'%!_[tT][mM][pP]' escape '!'",
    "      or o.name collate Latin1_General_100_BIN2 like N'Archive' escape '!'",
    "      or o.name collate Latin1_General_100_BIN2 like N'[oO]''[bB][rR][iI][eE][nN]\\[xX]' escape '!'",
    "    )",
  ],
  snowflake: [
    "  and (  -- sl:table-filter: include",
    "    regexp_like(c.table_name, '^([oO][rR][dD][eE][rR][sS])$')",
    "    or regexp_like(c.table_name, '^([fF][cC][tT]_.*)$')",
    "    or regexp_like((c.table_schema || '.' || c.table_name), '^([aA][nN][aA][lL][yY][tT][iI][cC][sS][.][dD][iI][mM]_.)$')",
    "    or regexp_like((c.table_schema || '.' || c.table_name), '^(Sales[.][fF][cC][tT]_.*)$')",
    "    or regexp_like(c.table_name, '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$')",
    "  )",
    "  and not (  -- sl:table-filter: exclude",
    "    regexp_like(c.table_name, '^(.*_[tT][mM][pP])$')",
    "    or c.table_name in ('Archive')",
    "    or regexp_like((c.table_schema || '.' || c.table_name), '^(.*[.][bB][aA][kK]_[0-9]+)$')",
    "  )",
  ],
  bigquery: [
    "where (  -- sl:table-filter: include",
    "  regexp_contains(c.table_name, '^([oO][rR][dD][eE][rR][sS])$')",
    "  or regexp_contains(c.table_name, '^([fF][cC][tT]_.*)$')",
    "  or regexp_contains((c.table_schema || '.' || c.table_name), '^([aA][nN][aA][lL][yY][tT][iI][cC][sS][.][dD][iI][mM]_.)$')",
    "  or regexp_contains((c.table_schema || '.' || c.table_name), '^(Sales[.][fF][cC][tT]_.*)$')",
    "  or regexp_contains(c.table_name, '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$')",
    ")",
    "and not (  -- sl:table-filter: exclude",
    "  regexp_contains(c.table_name, '^(.*_[tT][mM][pP])$')",
    "  or c.table_name in ('Archive')",
    "  or regexp_contains((c.table_schema || '.' || c.table_name), '^(.*[.][bB][aA][kK]_[0-9]+)$')",
    ")",
  ],
  databricks: [
    "  and (  -- sl:table-filter: include",
    "    c.table_name rlike '^([oO][rR][dD][eE][rR][sS])$'",
    "    or c.table_name rlike '^([fF][cC][tT]_.*)$'",
    "    or (c.table_schema || '.' || c.table_name) rlike '^([aA][nN][aA][lL][yY][tT][iI][cC][sS][.][dD][iI][mM]_.)$'",
    "    or (c.table_schema || '.' || c.table_name) rlike '^(Sales[.][fF][cC][tT]_.*)$'",
    "    or c.table_name rlike '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$'",
    "  )",
    "  and not (  -- sl:table-filter: exclude",
    "    c.table_name rlike '^(.*_[tT][mM][pP])$'",
    "    or c.table_name in ('Archive')",
    "    or (c.table_schema || '.' || c.table_name) rlike '^(.*[.][bB][aA][kK]_[0-9]+)$'",
    "  )",
  ],
  duckdb: [
    "where (  -- sl:table-filter: include",
    "  lower(r.table_name) in ('orders')",
    "  or lower(r.table_name) like 'fct!_%' escape '!'",
    "  or regexp_matches((r.table_schema || '.' || r.table_name), '^([aA][nN][aA][lL][yY][tT][iI][cC][sS][.][dD][iI][mM]_.)$')",
    "  or regexp_matches((r.table_schema || '.' || r.table_name), '^(Sales[.][fF][cC][tT]_.*)$')",
    "  or regexp_matches(r.table_name, '^([sS][tT][gG]_([oO][rR][dD][eE][rR][sS]|[cC][uU][sS][tT][oO][mM][eE][rR][sS])[0-9]*)$')",
    ")",
    "and not (  -- sl:table-filter: exclude",
    "  lower(r.table_name) like '%!_tmp' escape '!'",
    "  or r.table_name in ('Archive')",
    "  or regexp_matches((r.table_schema || '.' || r.table_name), '^(.*[.][bB][aA][kK]_[0-9]+)$')",
    ")",
  ],
};

describe("export filters: golden SQL per dialect", () => {
  test.each([...EXPORT_DIALECTS])("%s", (d) => {
    const r = exportSql(d, [], { include: INCLUDE, exclude: EXCLUDE });
    expect(block(r.sql)).toEqual(GOLDEN[d]);
    expect(r.sql.startsWith("-- Schema export for ")).toBe(true);
    // The filter replaces the marker line; nothing else of the query changes.
    expect(r.sql).not.toContain("-- sl:table-filter: sl export-sql");
  });

  test("the header lists what the query applies and what sl import applies, with the import line", () => {
    const pg = exportSql("postgres", [], { include: INCLUDE, exclude: EXCLUDE });
    expect(header(pg.sql)).toEqual([
      "-- Table filter (sl export-sql --include/--exclude). The query reads table definitions only, never table data.",
      "-- In this query, at the lines marked sl:table-filter:",
      ...INCLUDE.map((p) => `--   include ${p}`),
      ...EXCLUDE.map((p) => `--   exclude ${p}`),
    ]);
    expect(pg.filters).toEqual({
      pushed: [
        { kind: "include", pattern: "orders", method: "in" },
        { kind: "include", pattern: "fct_*", method: "like" },
        { kind: "include", pattern: "analytics.dim_?", method: "like" },
        { kind: "include", pattern: '"Sales".fct_*', method: "regex" },
        { kind: "include", pattern: "re:stg_(orders|customers)\\d*", method: "regex" },
        { kind: "exclude", pattern: "*_tmp", method: "like" },
        { kind: "exclude", pattern: '"Archive"', method: "in" },
        { kind: "exclude", pattern: "re:.*\\.bak_\\d+", method: "regex" },
        { kind: "exclude", pattern: "o'brien\\x", method: "in" },
      ],
      deferred: [],
      import_command: null,
    });
    expect(pg.run_hint).toEndWith("then import it: sl import --source <source> --file schema.csv");

    // MySQL: a regex, and a quoted part next to a case-insensitive one, are left to sl import;
    // one include it cannot express takes the other includes with it, an exclude goes alone.
    const my = exportSql("mysql", [], { include: INCLUDE, exclude: EXCLUDE });
    const importLine =
      "sl import --source <source> --file schema.tsv --include 'orders' --include 'fct_*' --include 'analytics.dim_?' " +
      `--include '"Sales".fct_*' --include 're:stg_(orders|customers)\\d*' --exclude 're:.*\\.bak_\\d+' --exclude 'o'\\''brien\\x'`;
    expect(header(my.sql)).toEqual([
      "-- Table filter (sl export-sql --include/--exclude). The query reads table definitions only, never table data.",
      "-- In this query, at the lines marked sl:table-filter:",
      "--   exclude *_tmp",
      '--   exclude "Archive"',
      "-- Left out of this query, so it reads more table definitions; sl import applies them (mysql):",
      "--   include orders: another include cannot be expressed in mysql SQL, and includes are applied together",
      "--   include fct_*: another include cannot be expressed in mysql SQL, and includes are applied together",
      '--   include analytics.dim_?: it has a case-insensitive "i", and mysql\'s lower() also makes i from İ',
      '--   include "Sales".fct_*: it mixes a quoted, case-exact part with a case-insensitive one, which one mysql comparison cannot express',
      "--   include re:stg_(orders|customers)\\d*: MySQL's REGEXP follows the name column's collation and differs between MySQL and MariaDB versions",
      "--   exclude re:.*\\.bak_\\d+: MySQL's REGEXP follows the name column's collation and differs between MySQL and MariaDB versions",
      "--   exclude o'brien\\x: it has a backslash, which a MySQL string reads differently under the NO_BACKSLASH_ESCAPES SQL mode",
      `-- Import with: ${importLine}`,
    ]);
    expect(my.filters!.import_command).toBe(importLine);
    expect(my.run_hint).toEndWith(`then import it: ${importLine}`);
    expect(my.filters!.deferred.map((x) => x.pattern)).toEqual([...INCLUDE, "re:.*\\.bak_\\d+", "o'brien\\x"]);

    const ms = exportSql("sqlserver", [], { include: ["re:fct_.*"], exclude: [] });
    expect(ms.filters!.deferred).toEqual([{ kind: "include", pattern: "re:fct_.*", reason: "SQL Server has no regular expressions" }]);
    expect(block(ms.sql)).toEqual([]);
    expect(ms.sql).toContain("-- sl:table-filter: sl export-sql --include/--exclude writes the table filter here");
  });

  test("a quoted part alone compares case included; a regex dialect reads a mixed pattern case-exactly", () => {
    expect(block(exportSql("mysql", [], { include: ['"Sales"."FctX"'] }).sql)[1]).toBe(
      "    convert(concat(c.table_schema, '.', c.table_name) using utf8mb4) collate utf8mb4_bin like 'Sales.FctX' escape '!'",
    );
    expect(block(exportSql("sqlserver", [], { include: ['"Fct"*'] }).sql)[1]).toBe("      o.name collate Latin1_General_100_BIN2 like N'Fct%' escape '!'");
    expect(block(exportSql("postgres", [], { include: ['"Fct"*'] }).sql)[1]).toBe("      c.relname like 'Fct%' escape '!'");
    // A case-insensitive letter outside ASCII is matched through a class of its cases.
    expect(block(exportSql("duckdb", [], { include: ["café_*"] }).sql)[1]).toBe("  regexp_matches(r.table_name, '^([cC][aA][fF][Éé]_.*)$')");
    expect(block(exportSql("sqlserver", [], { include: ["café_*"] }).sql)[1]).toBe("      o.name collate Latin1_General_100_BIN2 like N'[cC][aA][fF][Éé]!_%' escape '!'");
    expect(exportSql("mysql", [], { include: ["café_*"] }).filters!.deferred[0]!.reason).toContain("outside ASCII");
    // A Greek letter matches its variant forms, as the grammar does (σ, ς and Σ; μ, µ and Μ).
    expect(block(exportSql("postgres", [], { exclude: ["σ*", "μ"] }).sql).slice(1, 3)).toEqual([
      "      c.relname ~ '^([Σςσ].*)$'",
      "      or c.relname ~ '^([µΜμ])$'",
    ]);
    // A backslash is left to sl import where a setting decides how a string literal reads it.
    for (const d of ["mysql", "databricks"] as const) {
      const r = exportSql(d, [], { exclude: ['"A\\b"', "x_*"] });
      expect(r.filters!.deferred.map((x) => x.pattern)).toEqual(['"A\\b"']);
      expect(r.filters!.deferred[0]!.reason).toMatch(/backslash.*(NO_BACKSLASH_ESCAPES|escapedStringLiterals)/);
    }
    expect(exportSql("snowflake", [], { exclude: ['"A\\b"'] }).filters!.pushed).toHaveLength(1);
    // SQL Server's LIKE reads [ as a class: it is escaped.
    expect(block(exportSql("sqlserver", [], { exclude: ["a[b]_*"] }).sql)[1]).toBe(
      "      o.name collate Latin1_General_100_BIN2 like N'[aA]![[bB]]!_%' escape '!'",
    );
  });
});

describe("export filters: regexes every dialect reads the same way", () => {
  test.each([
    ["dim_(cust|prod)s?", "[dD][iI][mM]_([cC][uU][sS][tT]|[pP][rR][oO][dD])[sS]?"],
    ["fct_\\d{2,4}", "[fF][cC][tT]_[0-9]{2,4}"],
    ["(?:a|b)\\w+?", "([aA]|[bB])[A-Za-z0-9_]+"],
    ["[a-z\\d_.-]+", "[a-z0-9_.A-Z-]+"],
    ["[^0-9]x\\.y\\$", "[^0-9][xX][.][yY][$]"],
    ["[^a-c]", "[^a-cA-C]"],
    ["[Z-a]", "[Z-aAz]"],
    ["_{3}", "_{3}"],
    ["a{x}", "[aA][{][xX][}]"],
  ])("%s becomes %s", (body, re) => {
    expect(portableRegex(body)).toEqual({ re });
  });

  test.each([
    ["a\\sb", 'the escape "\\s"'],
    ["(?=a)b", 'a "(?" group (a lookaround, a named group or flags)'],
    ["(a)\\1", 'the escape "\\1"'],
    ["a\\bb", 'the escape "\\b"'],
    ["(a|)", "an empty alternative"],
    ["a|", "an empty alternative"],
    ["a{300}", "a repeat count over 255"],
    ["café", "a character outside ASCII"],
    ["[]a]", "a class that opens with ]"],
    ["[a\\]]", '"]" in a class'],
    ["a\\\\b", 'a literal "[", "]", "\\" or "^"'],
  ])("%s is deferred: %s", (body, problem) => {
    expect(portableRegex(body)).toEqual({ problem });
  });

  test("a regex none of the regex dialects can read is deferred everywhere, with all includes", () => {
    for (const d of EXPORT_DIALECTS) {
      const r = exportSql(d, [], { include: ["fct_*", "re:(?!tmp_).*"], exclude: ["*_tmp"] });
      expect(r.filters!.deferred.map((x) => x.pattern)).toEqual(["fct_*", "re:(?!tmp_).*"]);
      expect(r.filters!.pushed.map((x) => `${x.kind} ${x.pattern}`)).toEqual(["exclude *_tmp"]);
    }
  });
});

// SQL text with comments and string literals removed, per dialect: what remains is code.
function code(d: ExportDialect, sql: string): string {
  const backslash = !["duckdb", "sqlserver"].includes(d);
  const lit = backslash ? /E?'(?:[^'\\]|\\.|'')*'/g : /N?'(?:[^']|'')*'/g;
  return sql
    .split("\n")
    .map((l) => {
      // Strip literals first, so a "--" inside one is not read as a comment.
      const s = l.replace(lit, "''");
      const i = s.indexOf("--");
      return i < 0 ? s : s.slice(0, i);
    })
    .join("\n");
}

const INJECTION = ["x'); drop table t; --", "a\\'b", "*/ or 1=1 --", "re:it'[.]s", "re:a\\'b", '"q\'"."x\\"'];

describe("export filters: the catalog-only contract over filtered output", () => {
  test.each([...EXPORT_DIALECTS])("%s: the filtered query is the catalog query plus predicates on its name columns", (d) => {
    for (const [include, exclude] of [
      [INCLUDE, EXCLUDE],
      [INJECTION, INJECTION],
    ] as const) {
      const { sql } = exportSql(d, [], { include: [...include], exclude: [...exclude] });
      // Taking out the header and the filter lines gives back the file, marker line aside.
      const lines = sql.split("\n");
      const head = header(sql);
      const start = lines.indexOf(head[0]!);
      expect(lines[start - 1]).toBe("--");
      const rest = [...lines.slice(0, start - 1), ...lines.slice(start + head.length)];
      const filt = block(rest.join("\n"));
      const without = rest.join("\n").replace(filt.join("\n"), "MARKER");
      expect(without).toBe(raw(d).replace(/^[ \t]*-- sl:table-filter: .*$/m, "MARKER"));
      // The filter's code, outside its string literals, uses only name columns and operators.
      const words = new Set(code(d, filt.join("\n")).match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? []);
      const allowed = new Set([
        "and", "or", "not", "where", "in", "like", "escape", "lower", "rlike", "regexp_like", "regexp_contains", "regexp_matches",
        "convert", "using", "utf8mb4", "collate", "utf8mb4_bin", "Latin1_General_100_BIN2", "concat", "N", "E", "C",
        "n.nspname", "c.relname", "c.table_schema", "c.table_name", "s.name", "o.name", "r.table_schema", "r.table_name",
      ]);
      expect([...words].filter((w) => !allowed.has(w))).toEqual([]);
      // No statement writes, and the query still reads only what the catalog query reads.
      expect(code(d, sql)).not.toMatch(/\b(insert\s+into|update\s+\S+\s+set|delete\s+from|merge\s+into|create\s|drop\s|alter\s|truncate\s|grant\s|copy\s)/i);
      // Every comment line the header adds is one line: a pattern cannot end it.
      for (const l of head) expect(l.startsWith("--")).toBe(true);
    }
  });

  test("a pattern holding a line break or control character is refused", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    for (const p of ["a\nselect 1", "a\rb", "a b"]) {
      expect(() => applyTableFilter("postgres", raw("postgres"), [p], [], "sl import")).toThrow(/line break or control character/);
      const r = await sl(t.root, ["export-sql", "--dialect", "postgres", "--include", p]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("write it on one line and run the command again");
    }
    const bad = await sl(t.root, ["export-sql", "--dialect", "postgres", "--exclude", "re:(a+)+"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Fix the pattern and run the command again");
  });
});

describe("sl export-sql --include/--exclude", () => {
  test("prints the filtered query, and on stderr the run line and the sl import that applies the rest", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["export-sql", "--dialect", "sqlserver", "--include", "fct_*,dim_*", "--include", "re:a,b", "--exclude", "*_tmp"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(exportSql("sqlserver", [], { include: ["fct_*", "dim_*", "re:a,b"], exclude: ["*_tmp"] }).sql.trimEnd());
    const cmd = "sl import --source <source> --file schema.csv --include 'fct_*' --include 'dim_*' --include 're:a,b'";
    expect(r.err.split("\n")).toEqual([
      `Save this as export.sql, run sqlcmd -S <server> -d <database> -i export.sql -f 65001 -s, -W > schema.csv, then import it: ${cmd}`,
      `3 patterns cannot be written in sqlserver SQL, so the export reads those table definitions too (never table data); the query's header says why. Apply them when you import: ${cmd}`,
    ]);
    const j = await sl(t.root, ["export-sql", "--dialect", "postgres", "--include", "fct_*", "--json"]);
    expect(j.err).toBe("");
    const out = j.json<Record<string, unknown>>();
    expect(Object.keys(out)).toEqual(["dialect", "sql", "run_hint", "filters"]);
    expect(out.filters).toEqual({ pushed: [{ kind: "include", pattern: "fct_*", method: "like" }], deferred: [], import_command: null });
    // A shell quote in a pattern stays inside its quoted argument.
    const q = exportSql("mysql", [], { include: ["re:o'b.*"] });
    expect(q.filters!.import_command).toBe("sl import --source <source> --file schema.tsv --include 're:o'\\''b.*'");
  });
});

// The table names a run of an export query returns, as schema.table.
const names = (rows: { table_schema: unknown; table_name: unknown }[]) => [...new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`))].sort();
const split = (q: string) => ({ schema: q.slice(0, q.lastIndexOf(".")), name: q.slice(q.lastIndexOf(".") + 1) });

const ACME = join(import.meta.dir, "..", "fixtures", "acme", "data");

// Selections run live against the full export: each must return exactly the tables the
// grammar selects from it (patterns.ts), and the expected names are spelled out too.
describe("export filters: duckdb, live on the Acme lake", () => {
  test("include and exclude patterns return exactly the selected tables, and a deferred pattern applies on import", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const instance = await DuckDBInstance.create(join(t.dir, "lake.duckdb"));
    const c = await instance.connect();
    const lake = join(ACME, "lake");
    for (const s of [
      `create view web_events as select * from read_parquet('${lake}/web_events/*.parquet')`,
      `create view sessions as select * from read_parquet('${lake}/sessions.parquet')`,
      `create view marketing_spend as select * from read_parquet('${lake}/marketing_spend.parquet')`,
      `create view web_events_2024_archive as select * from read_parquet('${lake}/web_events_2024_archive.parquet')`,
      `create view tmp_session_dedupe as select * from read_parquet('${lake}/tmp_session_dedupe.parquet')`,
      `create schema "Arch"`,
      `create table "Arch"."WebHits" (id integer)`,
      `create table "Arch"."it's" (id integer)`,
      `create table "Arch"."a\\'b" (id integer)`,
    ])
      await c.run(s);
    const run = async (include: string[], exclude: string[]) => {
      const { sql } = exportSql("duckdb", [], { include, exclude });
      return names((await c.runAndReadAll(sql)).getRowObjectsJson() as { table_schema: unknown; table_name: unknown }[]);
    };
    const all = await run([], []);
    expect(all).toEqual([
      "Arch.WebHits", "Arch.a\\'b", "Arch.it's", "main.marketing_spend", "main.sessions", "main.tmp_session_dedupe", "main.web_events",
      "main.web_events_2024_archive",
    ]);
    const cases: [string[], string[], string[]][] = [
      [["web_*", "SESSIONS", "re:marketing_.*"], ["*_archive"], ["main.marketing_spend", "main.sessions", "main.web_events"]],
      [["re:.*\\.web.*"], ["re:main\\..*_\\d{4}_.*"], ["Arch.WebHits", "main.web_events"]],
      [['"Arch".*'], ['"WebHits"'], ["Arch.a\\'b", "Arch.it's"]],
      [['"arch".*', '"webhits"'], [], []],
      [['"Arch".WEB*'], [], ["Arch.WebHits"]],
      [["*"], ["re:tmp_.*", "web_events?2024*"], ["Arch.WebHits", "Arch.a\\'b", "Arch.it's", "main.marketing_spend", "main.sessions", "main.web_events"]],
      [["it's", "a\\'b"], [], ["Arch.a\\'b", "Arch.it's"]],
      [INJECTION, [], ["Arch.a\\'b"]],
    ];
    for (const [include, exclude, expected] of cases) {
      const got = await run(include, exclude);
      expect({ include, exclude, got }).toEqual({ include, exclude, got: expected });
      expect(got).toEqual(filterInScope({ include, exclude }, all.map(split)).map((x) => `${x.schema}.${x.name}`));
    }
    // Every injection attempt stays a literal, and the tables are still there.
    expect(await run([], INJECTION)).toEqual(all.filter((n) => n !== "Arch.a\\'b"));

    // A lookahead is not pushed: the export reads every table and sl import applies it.
    const include = ["re:(?!tmp_)[a-z_]+", "sessions"];
    const exp = exportSql("duckdb", [], { include, exclude: ["*_archive"] });
    expect(exp.filters!.deferred.map((x) => x.pattern)).toEqual(include);
    const sql = exp.sql.trim().replace(/;$/, "");
    const csv = join(t.dir, "schema.csv");
    await c.run(`copy (${sql}) to '${csv}' (header, delimiter ',')`);
    c.closeSync();
    instance.closeSync();
    await initProject(t.root);
    writeFileSync(join(t.root, "sources", "lake.yaml"), "source: lake\ndialect: duckdb\n");
    const args = exp.filters!.deferred.flatMap((x) => [`--${x.kind}`, x.pattern]);
    expect(exp.filters!.import_command).toBe("sl import --source <source> --file schema.csv --include 're:(?!tmp_)[a-z_]+' --include 'sessions'");
    const r = await sl(t.root, ["import", "--source", "lake", "--file", csv, ...args, "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.json<{ filters: unknown }>().filters).toEqual({ include, exclude: [], kept: 4, dropped: 3 });
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "lake.json"), "utf8")) as Snapshot;
    expect(snap.tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["Arch.WebHits", "main.marketing_spend", "main.sessions", "main.web_events"]);
  });
});

describe("export filters: postgres, live on the Acme warehouse", () => {
  const live = Boolean(PG_URL);
  let schema = "";
  let pg: SQL | undefined;

  beforeAll(async () => {
    if (!live) return;
    assertLocalPg(PG_URL);
    schema = uniqueSchema("t_export_filters");
    await loadPostgres(PG_URL!, ACME, schema);
    pg = new SQL({ url: PG_URL!, max: 1 });
    for (const s of [`create table ${schema}."FctMixed" (id int)`, `create table ${schema}.fctmixed (id int)`, `create table ${schema}."a\\'b" (id int)`])
      await pg.unsafe(s);
  });

  afterAll(async () => {
    if (!pg) return;
    await pg.unsafe(`drop schema if exists ${schema} cascade`);
    await pg.close();
  });

  test.skipIf(!live)(
    "include and exclude patterns return exactly the selected tables",
    async () => {
      const run = async (include: string[], exclude: string[]) => {
        const { sql } = exportSql("postgres", [schema], { include, exclude });
        return names((await pg!.unsafe(sql)) as { table_schema: unknown; table_name: unknown }[]).map((n) => n.slice(schema.length + 1));
      };
      const everything = await run([], []);
      expect(everything).toHaveLength(23);
      const q = (n: string) => `${schema}.${n}`;
      const cases: [string[], string[], string[]][] = [
        [["fct_*", "dim_*"], ["*_archive", "*_test"], ["dim_currency", "dim_customers", "dim_products", "dim_regions", "fct_order_items", "fct_orders", "fct_refunds"]],
        [[`${schema}.stg_*`, "re:raw_(shopify|stripe)_.*"], [], ["raw_shopify_orders", "raw_stripe_charges", "stg_customers", "stg_orders"]],
        [["re:.*_\\d{8}", "re:.*\\.audit_log"], [], ["audit_log", "report_daily_sales_20250101"]],
        [['"FctMixed"'], [], ["FctMixed"]],
        [["fctmixed"], [], ["FctMixed", "fctmixed"]],
        [['"Fct"*'], [], ["FctMixed"]],
        [['"FctM"IXED', '"fct"*'], ["fct_*"], ["FctMixed", "fctmixed"]],
        [["*"], ["re:(fct|dim)_.*", "*tmp*", "*_????????", '"FctMixed"', "fctmixed"], [
          "a\\'b", "audit_log", "orders_backup_2024", "raw_shopify_orders", "raw_stripe_charges", "schema_migrations", "stg_customers",
          "stg_orders",
        ]],
        [INJECTION, [], ["a\\'b"]],
      ];
      for (const [include, exclude, expected] of cases) {
        const got = await run(include, exclude);
        expect({ include, exclude, got }).toEqual({ include, exclude, got: expected });
        const selected = filterInScope({ include, exclude }, everything.map((n) => ({ schema, name: n })));
        expect(got).toEqual(selected.map((x) => x.name));
      }
      expect((await run([], INJECTION)).map(q)).toEqual(everything.filter((n) => n !== "a\\'b").map(q));
      expect(((await pg!.unsafe(`select count(*)::int as n from ${schema}.fct_orders`)) as { n: number }[])[0]!.n).toBe(5000);
    },
    60_000,
  );
});

describe("sl import --include/--exclude", () => {
  const rows = ["shop.fct_orders", "shop.fct_orders_bak", "shop.dim_customers", "shop.tmp_x", "Other.Notes"].flatMap((q) => {
    const { schema, name } = split(q);
    return [
      { table_schema: schema, table_name: name, column_name: "id", data_type: "integer", is_nullable: "NO", ordinal_position: 1 },
      { table_schema: schema, table_name: name, column_name: "note", data_type: "text", is_nullable: "YES", ordinal_position: 2 },
    ];
  });

  test("keeps only the matching tables and reports how many it dropped", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeFileSync(join(t.root, "sources", "wh.yaml"), "source: wh\ndialect: postgres\n");
    const file = join(t.dir, "schema.json");
    writeFileSync(file, JSON.stringify(rows));
    const r = await sl(t.root, ["import", "--source", "wh", "--file", file, "--include", "fct_*,dim_*", "--include", '"Other".*', "--exclude", "*_bak", "--exclude", "re:nothing_\\d+"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Imported 3 tables and 6 columns");
    expect(r.out).toContain("Kept the 3 tables matching --include and --exclude; dropped 2 others from the file.");
    expect(r.out).toContain(`Pattern "re:nothing_\\d+" matches no table in ${file}.`);
    const snap = JSON.parse(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")) as Snapshot;
    expect(snap.tables.map((x) => `${x.schema}.${x.name}`)).toEqual(["Other.Notes", "shop.dim_customers", "shop.fct_orders"]);

    const j = await sl(t.root, ["import", "--source", "wh", "--file", file, "--exclude", '"other".*', "--json"]);
    expect(j.code).toBe(0);
    const out = j.json<{ tables: number; filters: unknown; changes: { tables_added: string[] } }>();
    expect(out.tables).toBe(5);
    expect(out.filters).toEqual({ include: [], exclude: ['"other".*'], kept: 5, dropped: 0 });
    expect(out.changes.tables_added).toEqual(["shop.fct_orders_bak", "shop.tmp_x"]);
    // Without the flags the output keeps its keys.
    const plain = await sl(t.root, ["import", "--source", "wh", "--file", file, "--json"]);
    expect(Object.keys(plain.json<object>())).not.toContain("filters");
  });

  test("refuses a selection that keeps nothing, and a pattern that is not usable", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeFileSync(join(t.root, "sources", "wh.yaml"), "source: wh\ndialect: postgres\n");
    const file = join(t.dir, "schema.json");
    writeFileSync(file, JSON.stringify(rows));
    const none = await sl(t.root, ["import", "--source", "wh", "--file", file, "--include", "nope_*"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain(`No table in ${file} matches --include and --exclude, so nothing was imported.`);
    expect(none.err).toContain("run sl import again");
    const bad = await sl(t.root, ["import", "--source", "wh", "--file", file, "--include", "re:(a+)+"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Fix the pattern and run the command again");
  });
});

// Names whose case folding differs between engines: Greek variant forms (σ ς Σ, μ µ Μ), the
// Kelvin sign and İ (which SQL's lower() and regex flags fold to k and i, and the grammar
// does not), ß, accents, and the characters LIKE and regexes treat as special.
const ODD = [
  "Orders", "orders", "ORD_ERS", "ordXers", "a%b", "a_b", "aXb", "a!b", "a.b", "x'y", "back\\slash", "spa ce", "Ωmega", "ωmega",
  "ςigma", "σigma", "Σigma", "Kelvin", "kelvin", "İstanbul", "istanbul", "straße", "STRASSE", "tab[1]", "caret^", "dollar$",
  "brace{2}", "émile", "Émile", "x-y", "_lead", "123", "µnit", "μnit", "Μnit",
];
const ODD_PATTERNS = [
  "*", "orders", "ORD?ERS", "ord_ers", "a%b", "a_b", "a!b", "a?b", '"a.b"', '"Orders"', '"Ord"*', "ωmega", "σigma", "kelvin", "k*",
  "istanbul", "i*", "*s*", "straße", "émile", "tab[1]", "caret^", "dollar$", "brace{2}", "x'y", "back\\slash", "spa ce", "μnit", "µnit",
  "re:orders", "re:ORD.ERS", "re:[a-z]+", "re:[^a-z]+", "re:\\w+", "re:\\W.*", "re:a\\.b", "re:dollar\\$", "re:brace\\{2\\}", "re:x'y",
  "re:[Z-a]+", "re:.{3}", "re:k.*", "re:[A-Z].*", "re:[x-]+y", "re:a|b|orders", "re:_.*", "re:[%!_]+.*",
];

// Every pattern, as an include and as an exclude, returns from a live query exactly what the
// grammar selects once sl import applies what was deferred.
async function disagreements(d: "duckdb" | "postgres", schema: string, tables: string[], query: (sql: string) => Promise<{ table_name: unknown }[]>) {
  const run = async (include: string[], exclude: string[]) => {
    const r = exportSql(d, d === "postgres" ? [schema] : [], { include, exclude });
    const got = [...new Set((await query(r.sql)).map((x) => String(x.table_name)))].map((name) => ({ schema, name }));
    const later = r.filters?.deferred ?? [];
    const pick = (k: string) => later.filter((x) => x.kind === k).map((x) => x.pattern);
    return filterInScope({ include: pick("include"), exclude: pick("exclude") }, got).map((x) => x.name).sort();
  };
  const all = await run([], []);
  expect(all).toEqual([...tables].sort());
  const out: unknown[] = [];
  for (const p of ODD_PATTERNS) {
    for (const [include, exclude] of [[[p], []], [[], [p]]]) {
      const want = filterInScope({ include, exclude }, all.map((name) => ({ schema, name }))).map((x) => x.name).sort();
      const got = await run(include!, exclude!);
      if (JSON.stringify(got) !== JSON.stringify(want)) out.push({ include, exclude, extra: got.filter((x) => !want.includes(x)), missing: want.filter((x) => !got.includes(x)) });
    }
  }
  return out;
}

describe("export filters: unusual names, live", () => {
  test("duckdb", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const c = await instance.connect();
    // DuckDB compares identifiers case-insensitively, so a name differing only in case is left out.
    const made: string[] = [];
    for (const t of ODD) {
      if (made.some((m) => m.toLowerCase() === t.toLowerCase())) continue;
      await c.run(`create table "${t}" (id integer)`);
      made.push(t);
    }
    const found = await disagreements("duckdb", "main", made, async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson() as never);
    c.closeSync();
    expect(found).toEqual([]);
  });

  // An ICU database, where lower() and ~* fold the Kelvin sign to k as most UTF-8 databases do.
  const live = Boolean(PG_URL);
  const db = uniqueSchema("t_export_icu");
  let admin: SQL | undefined;
  let pg: SQL | undefined;
  beforeAll(async () => {
    if (!live) return;
    assertLocalPg(PG_URL);
    admin = new SQL({ url: PG_URL!, max: 1 });
    await admin.unsafe(`create database ${db} template template0 encoding 'UTF8' locale_provider icu icu_locale 'und' locale 'C'`);
    const url = new URL(PG_URL!);
    url.pathname = `/${db}`;
    pg = new SQL({ url: url.toString(), max: 1 });
    await pg.unsafe("create schema odd");
    for (const t of ODD) await pg.unsafe(`create table odd."${t}" (id int)`);
  });
  afterAll(async () => {
    await pg?.close();
    await admin?.unsafe(`drop database if exists ${db}`);
    await admin?.close();
  });

  test.skipIf(!live)("postgres", async () => {
    expect(await disagreements("postgres", "odd", ODD, async (sql) => (await pg!.unsafe(sql)) as never)).toEqual([]);
  }, 60_000);
});

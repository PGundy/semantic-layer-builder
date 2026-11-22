// Loads the Chinook sample database (version 1.4.5, vendored unmodified beside this file) into one
// Postgres schema. Drops and recreates that schema, runs the script's table, index and data statements
// inside it, and returns the row count per table. The script's own DROP DATABASE, CREATE DATABASE and
// \c lines are skipped, so no other schema or database is touched.
//
//   PG_URL=postgres://... bun fixtures/chinook/load-postgres.ts [schema]
//
// The default schema is chinook. The script is read as text and its statements go to Postgres;
// nothing here runs it in a shell.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

export const CHINOOK_SCRIPT = join(import.meta.dir, "Chinook_PostgreSql.sql");
export const CHINOOK_TABLES = [
  "album",
  "artist",
  "customer",
  "employee",
  "genre",
  "invoice",
  "invoice_line",
  "media_type",
  "playlist",
  "playlist_track",
  "track",
] as const;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const SKIPPED = /^(drop\s+database|create\s+database|\\c\b)/i;

// Splits a script into statements at semicolons outside single-quoted strings, comments and psql
// meta-commands (a line starting with a backslash ends at the line end).
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < script.length) {
    const ch = script[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < script.length && !(script[j] === "'" && script[j + 1] !== "'")) j += script[j] === "'" ? 2 : 1;
      cur += script.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      i = end < 0 ? script.length : end + 2;
    } else if (ch === "-" && script[i + 1] === "-") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
    } else if (ch === "\\" && cur.trim() === "") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? script.length : end;
    } else if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface LoadResult {
  schema: string;
  rows: Record<string, number>;
}

export async function loadChinook(url: string, schema = "chinook"): Promise<LoadResult> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name ${schema}`);
  const statements = splitStatements(readFileSync(CHINOOK_SCRIPT, "utf8")).filter((s) => !SKIPPED.test(s));
  const quoted = `"${schema}"`;
  const sql = new SQL({ url, max: 1 });
  const rows: Record<string, number> = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      await tx.unsafe(`CREATE SCHEMA ${quoted}`);
      await tx.unsafe(`SET LOCAL search_path = ${quoted}`);
      for (const s of statements) await tx.unsafe(s);
      for (const t of CHINOOK_TABLES) {
        const r = (await tx.unsafe(`SELECT count(*)::int AS n FROM ${quoted}."${t}"`)) as { n: number }[];
        rows[t] = r[0]!.n;
      }
    });
    await sql.unsafe(`ANALYZE ${CHINOOK_TABLES.map((t) => `${quoted}."${t}"`).join(", ")}`);
  } finally {
    await sql.close();
  }
  return { schema, rows };
}

if (import.meta.main) {
  const url = process.env.PG_URL;
  if (!url) {
    console.error("Set PG_URL to the Postgres connection URL.");
    process.exit(1);
  }
  const schema = process.argv[2] ?? "chinook";
  if (!SCHEMA_NAME.test(schema)) {
    console.error("Schema must match [a-z_][a-z0-9_]*");
    process.exit(1);
  }
  const result = await loadChinook(url, schema);
  const total = Object.values(result.rows).reduce((s, n) => s + n, 0);
  console.log(`Loaded ${Object.keys(result.rows).length} tables, ${total} rows, into schema ${result.schema}.`);
}

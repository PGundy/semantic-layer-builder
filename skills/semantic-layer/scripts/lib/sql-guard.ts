import { UserError } from "./errors.ts";

const READ_START = /^(select|with|values|table|explain|describe|desc|show|summarize|from)\b/i;
const WRITE_WORD =
  /\b(insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|copy|attach|detach|install|load|vacuum|call|export|import|set|reset|pragma|checkpoint|comment)\b/i;

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

// Rejects anything but a single read-only statement. The adapters also open
// read-only connections; this check gives a clear message before the database does.
export function assertReadOnly(sql: string): void {
  const body = stripCommentsAndStrings(sql).trim().replace(/;\s*$/, "");
  if (!body) throw new UserError("Empty query.");
  if (body.includes(";")) throw new UserError("Run one statement at a time.");
  if (!READ_START.test(body)) throw new UserError("Only read-only queries run here: SELECT, WITH, EXPLAIN, DESCRIBE, SHOW or SUMMARIZE.");
  const m = body.match(WRITE_WORD);
  if (m && !/^explain\b/i.test(body)) {
    throw new UserError(`Refusing a query containing "${m[1]}": only read-only queries run here.`);
  }
}

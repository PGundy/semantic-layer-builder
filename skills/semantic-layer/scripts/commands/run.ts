import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Adapter, QueryResult } from "../lib/adapters/index.ts";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { errorMessage, openQueryAdapter } from "../lib/plan.ts";
import { formatJson, formatTable } from "../lib/output.ts";
import { loadSource } from "../lib/project.ts";
import { assertReadOnly } from "../lib/sql-guard.ts";

// Runs the query, turning a database error (a typo, an unknown column) into a plain UserError.
async function queryOrFail(adapter: Adapter, sql: string): Promise<QueryResult> {
  try {
    return await adapter.query(sql);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`Query failed: ${errorMessage(e)}`);
  }
}

const spec: CommandSpec = {
  summary: "Run one read-only query against a duckdb or postgres source.",
  usage: "run --source <source> (--sql <query> | --file <path>) [--limit <n>]",
  options: { source: { type: "string" }, sql: { type: "string" }, file: { type: "string" }, limit: { type: "string" } },
  async run({ values }, ctx) {
    const sourceName = str(values, "source");
    if (!sourceName) throw new UserError("--source is required.");
    const inline = str(values, "sql");
    const file = str(values, "file");
    if (!inline === !file) throw new UserError("Pass exactly one of --sql or --file.");
    const sql = inline ?? readFileSync(resolve(ctx.cwd, file!), "utf8");
    assertReadOnly(sql);
    const limit = Number(str(values, "limit") ?? 100);
    const adapter = await openQueryAdapter(ctx.root, loadSource(ctx.root, sourceName), ctx.env);
    try {
      const { columns, rows } = await queryOrFail(adapter, sql);
      const shown = rows.slice(0, limit);
      if (ctx.json) ctx.out(formatJson({ columns, rows: shown, row_count: rows.length, truncated: rows.length > shown.length }));
      else {
        ctx.out(formatTable(shown, columns));
        ctx.out(`(${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > shown.length ? `, showing ${shown.length}` : ""})`);
      }
    } finally {
      await adapter.close();
    }
    return 0;
  },
};
export default spec;

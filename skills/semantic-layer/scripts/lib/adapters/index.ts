import { UserError } from "../errors.ts";
import type { SourceConfig } from "../types.ts";
import { RUNNABLE_DIALECTS } from "../types.ts";
import type { Adapter, AdapterOptions } from "./types.ts";

export type { Adapter, AdapterOptions, QueryResult } from "./types.ts";

export function canRun(source: SourceConfig): boolean {
  return RUNNABLE_DIALECTS.includes(source.dialect);
}

// Opens a connection for a duckdb or postgres source that runs only read-only statements.
export async function openAdapter(
  root: string,
  source: SourceConfig,
  env: Record<string, string | undefined>,
  opts: AdapterOptions = {},
): Promise<Adapter> {
  switch (source.dialect) {
    case "duckdb": {
      const { openDuckDB } = await import("./duckdb.ts");
      return openDuckDB(root, source, opts);
    }
    case "postgres": {
      const { openPostgres } = await import("./postgres.ts");
      return openPostgres(root, source, env, opts);
    }
    default:
      throw new UserError(
        `Source "${source.source}" is ${source.dialect}, which this CLI does not connect to. ` +
          "Use --emit-sql, run the queries with your own tool, then pass --results <file>.",
      );
  }
}

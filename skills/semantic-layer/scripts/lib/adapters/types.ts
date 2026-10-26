import type { Dialect, ResultRows } from "../types.ts";

// Values come back normalized: integers and decimals as numbers (or a string when
// an integer exceeds 2^53), dates as "YYYY-MM-DD", timestamps as
// "YYYY-MM-DD HH:MM:SS[.fff]" and timestamps with a time zone in UTC with "+00".
export interface QueryResult {
  columns: string[];
  rows: ResultRows;
}

export interface Adapter {
  dialect: Dialect;
  query(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

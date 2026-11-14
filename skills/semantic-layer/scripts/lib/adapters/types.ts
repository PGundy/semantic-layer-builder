import type { Dialect, ResultRows } from "../types.ts";

// Values come back normalized: integers and decimals as numbers (or a string when
// an integer exceeds 2^53), dates as "YYYY-MM-DD", timestamps as
// "YYYY-MM-DD HH:MM:SS[.fff]" and timestamps with a time zone in UTC with "+00".
export interface QueryResult {
  columns: string[];
  rows: ResultRows;
}

// What the role a connection logs in as can do beyond reading, measured on connect (Postgres):
// sl setup and sl introspect --json report it as role_report. Schema names come from the catalog.
export interface RoleReport {
  dialect: Dialect;
  role: string;
  superuser: boolean;
  // Per schema, the write privileges the role holds: INSERT, UPDATE, DELETE or TRUNCATE on any of
  // its tables, and CREATE on the schema itself.
  write_privileges: { schema: string; privileges: string[] }[];
  // Of pg_read_server_files, pg_write_server_files and pg_execute_server_program, those the role is a member of.
  server_file_roles: string[];
  // Schemas the role can use and read a table or view of.
  readable_schemas: string[];
  // The readable_schemas outside the source's intake.schemas; null when intake.schemas lists none
  // or the schemas were not measured.
  beyond_intake: string[] | null;
  // True when none of the above go beyond reading the intake schemas.
  least_privilege: boolean;
  // False when the per-schema query failed: write_privileges and readable_schemas are then empty
  // and unknown, and least_privilege is false.
  schemas_measured: boolean;
  // Plain-language warnings, the same the CLI prints on connect.
  warnings: string[];
}

export interface Adapter {
  dialect: Dialect;
  // Postgres: what the role can do, measured on connect.
  roleReport?: RoleReport;
  // Runs one read-only statement; anything else is refused with a UserError or fails in the database.
  query(sql: string): Promise<QueryResult>;
  // DuckDB: stops the statement running on the connection, which then fails.
  interrupt?(): void;
  close(): Promise<void>;
}

export interface AdapterOptions {
  // Where a warning about the connection goes, such as a role that can write; stderr by default.
  warn?: (message: string) => void;
}

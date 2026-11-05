// Prints a dialect's canonical schema export query (references/exports/<dialect>.sql), with
// the schema filter applied when --schemas is given. Reads no database and needs no project.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";

export const EXPORT_DIALECTS = ["postgres", "redshift", "mysql", "sqlserver", "snowflake", "bigquery", "databricks", "duckdb"] as const;
export type ExportDialect = (typeof EXPORT_DIALECTS)[number];

export const EXPORTS_DIR = join(import.meta.dir, "..", "..", "references", "exports");

// How to run the saved query (as export.sql) and where its result lands.
const RUN: Record<ExportDialect, { command: string; output: string }> = {
  postgres: { command: 'psql -X "$DATABASE_URL" --csv -f export.sql > schema.csv', output: "schema.csv" },
  redshift: { command: 'psql -X "host=<cluster> port=5439 dbname=<db> user=<user>" --csv -f export.sql > schema.csv', output: "schema.csv" },
  mysql: { command: "mysql --batch --raw -h <host> -u <user> -p <database> < export.sql > schema.tsv", output: "schema.tsv" },
  sqlserver: { command: "sqlcmd -S <server> -d <database> -i export.sql -f 65001 -s, -W > schema.csv", output: "schema.csv" },
  snowflake: {
    command: "snowsql -d <database> -f export.sql -o output_format=csv -o header=true -o timing=false -o friendly=false > schema.csv",
    output: "schema.csv",
  },
  bigquery: { command: "bq --quiet query --use_legacy_sql=false --format=csv --max_rows=1000000 < export.sql > schema.csv", output: "schema.csv" },
  databricks: { command: "run export.sql in the Databricks SQL editor and download the result as schema.csv", output: "schema.csv" },
  duckdb: { command: "duckdb <database>.duckdb -csv < export.sql > schema.csv", output: "schema.csv" },
};

const FILTER_LINE = /^(\s*)--\s*and\s+(.+?)\s+in\s*\(.*\)\s*--\s*sl:schema-filter.*$/m;
const DATASET_BLOCK = /^[ \t]*-- sl:per-dataset\n([\s\S]*?)^[ \t]*-- sl:end-per-dataset$/gm;
const DATASET_TOKEN = "`my_dataset`";

// Rejects a schema name a string literal or quoted identifier could not hold safely in every
// dialect: control characters and backslashes (an escape character in MySQL, Snowflake,
// BigQuery and Databricks literals).
function checkName(name: string): string {
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new UserError(`Schema "${name}" holds a backslash or control character; edit the filter line by hand.`);
  return name;
}

function literal(dialect: ExportDialect, value: string): string {
  if (dialect === "databricks") return `'${value.replace(/'/g, "\\'")}'`;
  if (dialect === "sqlserver") return `N'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

// True when a name has letters of only one case, so it reads as an unquoted identifier.
function oneCase(name: string): boolean {
  return name === name.toUpperCase() || name === name.toLowerCase();
}

// The predicate a filter line holds for the given schemas, over the column it names.
function predicate(dialect: ExportDialect, column: string, schemas: string[]): string {
  const lits = (names: string[]) => names.map((s) => literal(dialect, s)).join(", ");
  if (dialect === "snowflake") {
    // An unquoted name is stored in uppercase, so every name matches its uppercase form; a
    // mixed-case name may also be a quoted identifier, so it matches exactly as well.
    const folded = [...new Set(schemas.map((s) => s.toUpperCase()))];
    const exact = schemas.filter((s) => !oneCase(s));
    const parts = [...(folded.length ? [`upper(${column}) in (${lits(folded)})`] : []), ...(exact.length ? [`${column} in (${lits(exact)})`] : [])];
    return parts.length === 1 ? parts[0]! : `(${parts.join(" or ")})`;
  }
  if (dialect === "databricks") return `${column} in (${lits(schemas.map((s) => s.toLowerCase()))})`;
  return `${column} in (${lits(schemas)})`;
}

// A BigQuery dataset, or project.dataset, as a quoted path.
function datasetPath(name: string): string {
  if (name.includes("`")) throw new UserError(`Dataset "${name}" holds a backtick.`);
  const dot = name.lastIndexOf(".");
  const parts = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name];
  if (parts.some((p) => p === "")) throw new UserError(`Dataset "${name}" is not a dataset or project.dataset.`);
  return parts.map((p) => `\`${p}\``).join(".");
}

// Applies --schemas to a dialect's export query.
export function applySchemas(dialect: ExportDialect, sql: string, schemas: string[]): string {
  if (!schemas.length) return sql;
  schemas.forEach(checkName);
  if (dialect === "bigquery") {
    const paths = schemas.map(datasetPath);
    return sql.replace(DATASET_BLOCK, (_, body: string) => {
      const blocks = paths.map((p) => body.replace(/\n$/, "").split(DATASET_TOKEN).join(p));
      return blocks.join("\n  union all\n");
    });
  }
  const m = FILTER_LINE.exec(sql);
  if (!m) throw new UserError(`The ${dialect} export has no sl:schema-filter line.`);
  const [line, indent, column] = m;
  return sql.replace(line, () => `${indent}and ${predicate(dialect, column!, schemas)}  -- sl:schema-filter`);
}

export function exportSql(dialect: ExportDialect, schemas: string[] = []): { sql: string; run_hint: string } {
  const sql = applySchemas(dialect, readFileSync(join(EXPORTS_DIR, `${dialect}.sql`), "utf8"), schemas);
  const run = RUN[dialect];
  const datasets = dialect === "bigquery" && !schemas.length ? " (replace `my_dataset` first, or pass --schemas)" : "";
  const run_hint = `Save this as export.sql${datasets}, run ${run.command}, then import it: sl import --source <source> --file ${run.output}`;
  return { sql, run_hint };
}

const spec: CommandSpec = {
  summary: "Print a read-only catalog query that exports a database's schema for sl import.",
  usage:
    `export-sql --dialect ${EXPORT_DIALECTS.join("|")} [--schemas a,b]\n\n` +
    "  Prints the query on stdout and, on stderr, how to run it and import the result. The query reads only the\n" +
    "  catalog and returns one row per column: table_schema, table_name, table_type, table_comment, row_count,\n" +
    "  column_name, ordinal_position, data_type, is_nullable, column_comment, is_primary_key, pk_ordinal, fk_name,\n" +
    "  fk_ordinal, references_schema, references_table, references_column.\n" +
    "  --schemas  restrict the export to these schemas (BigQuery: the datasets to read, dataset or project.dataset).\n" +
    "  --json     print { dialect, sql, run_hint }.",
  options: {
    dialect: { type: "string" },
    schemas: { type: "string", multiple: true },
  },
  async run({ values }, ctx) {
    const dialect = str(values, "dialect");
    if (!dialect) throw new UserError(`--dialect is required: one of ${EXPORT_DIALECTS.join(", ")}.`);
    if (!(EXPORT_DIALECTS as readonly string[]).includes(dialect)) {
      throw new UserError(`Unknown dialect "${dialect}": use one of ${EXPORT_DIALECTS.join(", ")}.`);
    }
    const schemas = [...new Set(list(values, "schemas"))];
    const { sql, run_hint } = exportSql(dialect as ExportDialect, schemas);
    if (ctx.json) {
      ctx.out(formatJson({ dialect, sql, run_hint }));
      return 0;
    }
    ctx.out(sql.trimEnd());
    ctx.err(run_hint);
    return 0;
  },
};
export default spec;

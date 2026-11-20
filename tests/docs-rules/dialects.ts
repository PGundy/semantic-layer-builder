import type { DocRule } from "./index.ts";

// The dialect scope: the first turn asks about Postgres, with DuckDB for sample data and files, and the
// other warehouses' material lives in references/other-dialects.md, marked not supported for new work.
export const RULES: DocRule[] = [
  // The intake card names Postgres and DuckDB only.
  ["phases/intake.md", "the first turn asks which Postgres database", "**Which Postgres database?** Ask which database it is: a Postgres database is `--dialect postgres`"],
  ["phases/intake.md", "DuckDB only for sample data and files", "DuckDB (`--dialect duckdb`) is only for sample data or files such as Parquet and CSV"],
  ["phases/intake.md", "one pointer to the other dialects", "Load `references/other-dialects.md` only when the owner's database is neither: it is not supported for new work"],
  ["phases/intake.md", "the intake card names no other dialect", /^(?![\s\S]*\b(snowflake|bigquery|databricks|redshift|mysql|sql ?server)\b)/i],
  ["phases/intake.md", "the export path offers postgres and duckdb", "prints the read-only catalog query for their database (postgres, or duckdb for a DuckDB file; `references/exports/<d>.sql`)"],
  ["phases/intake.md", "import names the saved file", "`semlayer setup --source <s> --dialect <d> --export <the saved file> --reason \"<why>\"` (`schema.csv`) imports it"],
  // Moved from doc-phases-intake.ts with the sentences they pin.
  ["other-dialects.md", "import names the saved file", "`semlayer setup --source <s> --dialect <d> --export <the saved file> --reason \"<why>\"` (`schema.csv`, or `schema.tsv` from MySQL) imports it"],
  ["other-dialects.md", "MySQL and SQL Server stop at the baseline", "for MySQL and SQL Server only the export and the baseline are supported"],
  // The file says what it is.
  ["other-dialects.md", "not supported for new work", "# Other dialects: not supported for new work"],
  ["other-dialects.md", "the owner is told before work starts", "tell the owner it is not supported for new work before you start"],
  ["other-dialects.md", "the dialect list moved from the intake card", "Snowflake, BigQuery or Databricks is `--dialect`, which `semlayer setup` needs, and Redshift is `postgres`; MySQL and SQL Server have the schema export only"],
  ["other-dialects.md", "the query-plan protocol moved from intake.md", "## The query-plan protocol"],
  // Moved from doc-intake.ts with the query-plan protocol and the warehouse notes.
  ["other-dialects.md", "protected top values are not selected", "The plan does not select the top values of a column protected by its tag or name"],
  ["other-dialects.md", "profile results files are deleted", "Delete the results file once the command has finished"],
  ["other-dialects.md", "redact queries nothing", "`semlayer profile --source <s> --redact`, which queries nothing"],
  ["other-dialects.md", "BigQuery profiles warn about cost", "prints a cost warning before the plan"],
  ["other-dialects.md", "BigQuery samples by percent", "`TABLESAMPLE SYSTEM (p PERCENT)`"],
  // The profile card points at the moved protocol, not at intake.
  ["phases/profile.md", "emit-sql and results point at other-dialects.md", "use `--emit-sql` and `--results` as in `references/other-dialects.md`"],
  // The default path points at the file only for a database that is neither postgres nor duckdb.
  ["SKILL.md", "the topic table points other databases to other-dialects.md", "a database that is neither, not supported for new work, loads `references/other-dialects.md` instead"],
  ["intake.md", "the agent's own SQL tool is not supported for new work", "not supported for new work (`other-dialects.md`)"],
  ["spec.md", "other exports are kept but unsupported", "The `mysql`, `sqlserver` and `redshift` exports are kept but unsupported"],
];

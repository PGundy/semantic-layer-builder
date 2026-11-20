# Other dialects: not supported for new work

The product builds a layer on a Postgres database, with DuckDB for sample data and files (Parquet, CSV). Everything in this file is for other databases: Snowflake, BigQuery, Databricks, Redshift, MySQL and SQL Server. Their code and export queries are kept and work as described here, but they get no new work, a new owner is not offered them, and nothing new in the tool is designed or tested for them. Load this file only when the owner's database is one of them; tell the owner it is not supported for new work before you start.

## Which database

Snowflake, BigQuery or Databricks is `--dialect`, which `semlayer setup` needs, and Redshift is `postgres`; MySQL and SQL Server have the schema export only (below), with no live connection.

- **The agent's own SQL tool** (snowflake, bigquery, databricks, or any source the CLI cannot reach): `semlayer introspect --source <s> --emit-sql`, run each query with your warehouse connector or CLI, save `{"<id>": [rows]}`, then `semlayer introspect --source <s> --results <file>` (The query-plan protocol, below). BigQuery: ask which datasets matter first and add `--schemas <dataset>,<dataset>`.

## Schema exports of other databases

`semlayer export-sql --dialect <d>` prints the read-only catalog query for every database it has one for (postgres, redshift, mysql, sqlserver, snowflake, bigquery, databricks, duckdb; `references/exports/<d>.sql`); the run line for each is in `intake.md` (Schema export). Then `semlayer setup --source <s> --dialect <d> --export <the saved file> --reason "<why>"` (`schema.csv`, or `schema.tsv` from MySQL) imports it. A Redshift, MySQL or SQL Server source is registered as `postgres`; for MySQL and SQL Server only the export and the baseline are supported, since every expression the layer writes is Postgres SQL that no tool may run on their database as is.

## The query-plan protocol

Use this whenever the CLI cannot run the queries itself. The same steps work for `introspect`, `profile` and `check-join`.

1. **Emit the plan.** The command prints a JSON plan and stops:

   ```
   semlayer introspect --source wh --emit-sql > <scratch>/introspect-plan.json
   ```

   ```json
   { "command": "introspect", "source": "wh", "dialect": "snowflake",
     "queries": [{ "id": "columns", "purpose": "Columns and types", "sql": "select ..." }] }
   ```

   Keep scratch files outside the semantic root: results can hold sample values from the owner's data.

2. **Run each query** exactly as written, read-only, with whatever tool reaches the source: an MCP warehouse connector, `snowsql`, `bq`, `psql`, the Databricks SQL tool. Run them in order; each is independent. Snowflake and Databricks introspection reads the unqualified `information_schema`, so run the plan in a session whose current database (Snowflake: `USE DATABASE <db>`, or `snowsql -d <db>`) or catalog (Databricks: `USE CATALOG <c>`) is the one this source models.

3. **Save the results** as one JSON object mapping each query `id` to its array of row objects:

   ```json
   {
     "tables": [
       { "table_schema": "ANALYTICS", "table_name": "FCT_ORDERS", "table_kind": "table", "row_count": 10000, "description": null }
     ],
     "columns": [
       { "table_schema": "ANALYTICS", "table_name": "FCT_ORDERS", "column_name": "STATUS", "data_type": "TEXT" }
     ]
   }
   ```

   Copy the ids, and the output column names, from the plan you emitted: they differ by command and dialect (a Postgres introspect plan also has `primary_keys` and `foreign_keys`). Every id in the plan needs an entry, even if it returned no rows (`[]`). Column names may be in any case; the CLI lowercases them. If your tool returns a header plus arrays of values, turn each row into an object keyed by column name. Keep values as the tool returned them.

4. **Finish the command** with the same flags plus the results file:

   ```
   semlayer introspect --source wh --results <scratch>/introspect-results.json
   ```

**Resuming a plan one result at a time.** `--emit-sql` also stores the plan under the semantic root and prints its `plan_id` and each query's `max_rows`. Instead of one results file, store each query's rows as you get them, a JSON array of row objects, then finish with `--plan`:

```
semlayer results add --plan <plan_id> --query columns --file <scratch>/columns.json
semlayer results status --plan <plan_id>
semlayer introspect --source wh --plan <plan_id>
```

`semlayer results status` lists what remains and, once every result is in, prints the command that finishes. Run each query with a row limit of its `max_rows`: a result of exactly that many rows is refused as possibly cut off. The stored plans and results live in `.semlayer/plans/`, which is gitignored; `semlayer profile --plan` removes its plan once the snapshot is written, and an abandoned profile plan is deleted by hand (`.semlayer/plans/<plan_id>.json` and `.semlayer/plans/<plan_id>/`). A golden result with a protected column is not stored: finish that golden with `--results <file>`. The finish command leaves out `--root`; add it back if you passed one. A plan that no longer matches what the command would run (the snapshot or flags changed) is refused: emit a new one.

If a query fails because of a dialect detail (a function name, quoting, permissions on one schema), fix only that query, keep its `id` and the names of its output columns, and tell the owner what you changed. If the owner's user cannot read some schema, scope it out rather than guess.

Profiles and join checks produce one query per table or join. For a large source, profile in batches (`semlayer profile --source wh --tables a,b,c --emit-sql`) so each results file stays small. A profile results file can hold raw sample values; the snapshot keeps none for a protected column: only its null fraction and distinct count, and a `min` and `max` only for a number or a date (`spec.md`, Profiles of protected columns). The plan does not select the top values of a column protected by its tag or name, so those never pass through your tool; a column that only its profile shows to be protected (near-unique text) is stripped after the results come back. Delete the results file once the command has finished, and never copy its values into the snapshot or any other file under the semantic root. A column tagged after it was profiled is redacted with `semlayer profile --source <s> --redact`, which queries nothing.


## Dialect notes

### Snowflake

- Run queries with a Snowflake MCP connector or `snowsql -c <connection> -q "<sql>" -o output_format=json -o friendly=false -o timing=false`.
- Unquoted identifiers are stored uppercase. Use names exactly as `semlayer tables` prints them in scope patterns; matching is case-insensitive anyway.
- A warehouse must be running and queries cost credits. Set `profile.sample_rows` (for example `100000`) in the source file before profiling large tables (a hand write: `SKILL.md`, Hand edits); the plan then uses `sample (n rows)`, and a table's top-value queries read one sample.
- Ask which database to model; one source per database keeps names short.

### BigQuery

- Run queries with a BigQuery MCP connector or `bq query --use_legacy_sql=false --format=json --max_rows=100000 '<sql>'`. Use `bq query --dry_run` to see bytes scanned before a costly profile.
- Datasets play the role of schemas. Name the datasets to read with `semlayer introspect --source bq --schemas analytics,marts --emit-sql`; without `--schemas`, introspect reads the source's `intake.schemas`, or when that lists none, the datasets named in its `scope.include` patterns (such as `analytics.*`) and its `scope.tables_file` entries. Ask the owner which datasets matter before the first introspect: a project can hold hundreds.
- Datasets passed together in `--schemas` must be in the same location; introspect datasets from other regions in separate runs.
- BigQuery bills by bytes scanned, and `limit` does not reduce that. `semlayer profile` on a BigQuery source prints a cost warning before the plan: dry-run each query (`bq query --dry_run --use_legacy_sql=false '<sql>'`) and tell the owner the bytes before running any. With `profile.sample_rows` the plan samples with `TABLESAMPLE SYSTEM (p PERCENT)`, the percentage computed from the table's row estimate, and every column's top values come from one query over that sample, so a table costs a few scans rather than one per column. Profile only the in-scope tables, one batch at a time, and prefer partitioned tables' recent partitions when the owner agrees.
- `bq --format=json` returns numbers as strings; save them as returned.

### Databricks

- Run queries with the Databricks SQL tool or MCP connector against a SQL warehouse, or `databricks api post /api/2.0/sql/statements` with a `warehouse_id`.
- Unity Catalog names are `catalog.schema.table`. Ask which catalog to model; one source per catalog is simplest.
- A stopped SQL warehouse takes a minute to start; run the first query and wait before assuming a failure.
- Set `profile.sample_rows` for large Delta tables; the plan uses `tablesample (n rows)`.


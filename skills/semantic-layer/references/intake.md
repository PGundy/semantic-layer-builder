# Intake: getting a source's tables into a snapshot

Every later phase reads `snapshots/<source>.json`. There are three ways to fill it, plus a manual fallback. Pick per source; a project can mix them.

| Path | When | Commands |
|---|---|---|
| Live | duckdb or postgres, and the CLI can reach it | `sl introspect`, `sl profile`, `sl check-join` run their queries |
| Agent's own SQL tool | snowflake, bigquery, databricks, or any source the CLI cannot reach but you can query | same commands with `--emit-sql`, then `--results <file>` |
| Shared context | no query access yet; the owner can share an export, a dbt project or DDL | `sl import` |
| Manual | none of the above fits | you write the snapshot JSON by hand |

Ask the owner which tool you can use to reach each source before choosing. Prefer a path with query access: profiles and join checks need it, and imports carry structure only.

## Connections without secrets

The CLI reads a connection URL from an environment variable whose name the source file stores. The URL itself never goes in a file, in chat or in a command line you print.

```
sl add-source --name warehouse --dialect postgres --env WAREHOUSE_URL
```

Add a one-line `description` to `sources/warehouse.yaml` by hand, in the owner's words ("Read replica of the order system").

Then ask the owner to set the variable themselves in the shell that runs the CLI, for example `export WAREHOUSE_URL=postgres://readonly_user:...@host:5432/db`, or in a `.env` file that is outside the semantic root and ignored by version control. Recommend a read-only database user. If the owner pastes a URL or password into the chat, do not repeat it or write it to a file, and suggest they rotate it.

For a warehouse dialect the CLI does not connect at all, so `--env` is optional: your own connector holds the credentials.

### DuckDB sources and lakes of files

A DuckDB source can be an in-memory database with views over files, or a `.duckdb` file:

```
sl add-source --name lake --dialect duckdb \
  --view "web_events=read_parquet('../data/lake/web_events/*.parquet')" \
  --view "sessions=read_parquet('../data/lake/sessions.parquet')"
sl add-source --name local --dialect duckdb --database ../data/analytics.duckdb
```

Relative paths resolve from the semantic root. For cloud storage, add `connection.setup` statements to `sources/<source>.yaml` by hand (see `spec.md`), for example `INSTALL httpfs`, `LOAD httpfs` and `CREATE SECRET (TYPE s3, PROVIDER credential_chain)`, which picks up credentials from the environment or the owner's AWS profile. Never write a key into `setup`.

**Finding the datasets in a folder.** When you do not yet know what a lake folder holds, register the source without views and list its files:

```
sl add-source --name lake --dialect duckdb
sl run --source lake --sql "select file from glob('../data/lake/**')"
```

The path in `glob` is relative to the semantic root, like a view's. Read the listing for datasets: a folder of yearly or dated Parquet files is one dataset, so its view reads them all with a glob (`read_parquet('../data/lake/web_events/*.parquet')`); a single file is one view. Make one view per dataset, including the ones that look like noise (archives, `tmp` copies, dated exports), so `sl tables --groups` flags them and the owner excludes them in scoping. Show the owner the dataset names, not the file list.

**Adding or changing a view later.** Edit `connection.views` in `sources/<source>.yaml` in place, one `name: relation` line per dataset, then rerun `sl introspect --source <source>`. There is no need to delete the source file or rerun `add-source`. A view for a dataset the owner rules out can simply be removed from the list. `sl validate` reports an error, naming the key and never the value, when `connection.database`, `connection.setup` or `connection.views` holds something that looks like a credential, so a hand edit cannot put a key in the repo unnoticed.

The views of an in-memory DuckDB source live in schema `main`: `sl tables` prints `main.web_events`. A scope pattern without a dot (`web_*`) matches the view name, and `main.*` matches them all; the source name (`lake.*`) matches nothing.

`connection.views` is also where a DuckDB source holds a rule the model YAML cannot express (a customer's first order). A Postgres or warehouse source has no such place: such a rule needs a view or table the owner's engineers create, so say so as soon as one comes up (`interview-guide.md`). Ask engineering for one only when no supported construct (a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source) can express the rule.

## Live intake

```
sl introspect --source warehouse
sl tables --source warehouse
```

`introspect` captures schemas, tables, columns, types, declared keys and row estimates. Rerun it when the owner adds tables or says tables changed, and on the schedule the owner agreed. A rerun prints what changed since the previous snapshot, tables added and removed and columns added, removed and retyped, and `--json` carries it as `changes`; `sl import` does the same when a source already has a snapshot. What to do with each change is in `interview-guide.md` (Keeping the layer current). Views, including every view of a DuckDB lake, have no row count yet; introspect says so ("5 views have no row count yet; sl profile measures them.") and `sl tables` shows `?` until `sl profile` runs. When the owner needs sizes to choose a focus, profile the candidate tables first or count one with `sl run --source <s> --sql "select count(*) from <view>"`. Then go to scoping.

Do this in the first turn of a new project, right after `sl init` and `sl add-source` and before asking any scoping question (SKILL.md Phase 0): a later turn resumes only from what is written under the semantic root.

## The query-plan protocol

Use this whenever the CLI cannot run the queries itself. The same steps work for `introspect`, `profile` and `check-join`.

1. **Emit the plan.** The command prints a JSON plan and stops:

   ```
   sl introspect --source wh --emit-sql > <scratch>/introspect-plan.json
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
   sl introspect --source wh --results <scratch>/introspect-results.json
   ```

If a query fails because of a dialect detail (a function name, quoting, permissions on one schema), fix only that query, keep its `id` and the names of its output columns, and tell the owner what you changed. If the owner's user cannot read some schema, scope it out rather than guess.

Profiles and join checks produce one query per table or join. For a large source, profile in batches (`sl profile --source wh --tables a,b,c --emit-sql`) so each results file stays small.

## Dialect notes

### Time zones, every dialect

The CLI runs every query with the session time zone UTC, so a time grain over a timestamp-with-time-zone column (`timestamptz` in Postgres, `TIMESTAMP WITH TIME ZONE` in DuckDB, `TIMESTAMP_TZ` and `TIMESTAMP_LTZ` in Snowflake) buckets in UTC, and goldens are recorded that way. When you run a plan with your own tool, set the session to UTC first: Snowflake `alter session set timezone = 'UTC'`, Databricks `SET TIME ZONE 'UTC'`; BigQuery truncates in UTC unless a function is given a zone. A dimension that must follow another zone converts in its `expr` (Postgres and DuckDB: `created_at at time zone 'America/New_York'`); the interview asks which zone "a day" means for every time dimension (`interview-guide.md`).

### Snowflake

- Run queries with a Snowflake MCP connector or `snowsql -c <connection> -q "<sql>" -o output_format=json -o friendly=false -o timing=false`.
- Unquoted identifiers are stored uppercase. Use names exactly as `sl tables` prints them in scope patterns; matching is case-insensitive anyway.
- A warehouse must be running and queries cost credits. Set `profile.sample_rows` (for example `100000`) in the source file before profiling large tables; the plan then uses `sample (n rows)`.
- Ask which database to model; one source per database keeps names short.

### BigQuery

- Run queries with a BigQuery MCP connector or `bq query --use_legacy_sql=false --format=json --max_rows=100000 '<sql>'`. Use `bq query --dry_run` to see bytes scanned before a costly profile.
- Datasets play the role of schemas. Name the datasets to read with `sl introspect --source bq --schemas analytics,marts --emit-sql`; without `--schemas`, introspect reads the datasets named in the source's `scope.include` patterns (such as `analytics.*`). Ask the owner which datasets matter before the first introspect: a project can hold hundreds.
- Datasets passed together in `--schemas` must be in the same location; introspect datasets from other regions in separate runs.
- BigQuery bills by bytes scanned, and `limit` does not reduce that. Profile only the in-scope tables, one batch at a time, and prefer partitioned tables' recent partitions when the owner agrees.
- `bq --format=json` returns numbers as strings; save them as returned.

### Databricks

- Run queries with the Databricks SQL tool or MCP connector against a SQL warehouse, or `databricks api post /api/2.0/sql/statements` with a `warehouse_id`.
- Unity Catalog names are `catalog.schema.table`. Ask which catalog to model; one source per catalog is simplest.
- A stopped SQL warehouse takes a minute to start; run the first query and wait before assuming a failure.
- Set `profile.sample_rows` for large Delta tables; the plan uses `tablesample (n rows)`.

## Shared context: `sl import`

When the owner can share files but not access, build the snapshot from them. Import gives structure (tables, columns, types, sometimes keys and descriptions) but no profile. Profiling and join checks still need the live or query-plan path later; until then, ask the owner for example values when the interview needs them.

### information_schema export

The owner runs one query and shares the result file:

```
sl import --source wh --format information_schema --file columns.csv
```

The file is a CSV with a header row, or a JSON array of row objects; header names are case-insensitive. Ask for one row per column with at least these columns: `table_schema`, `table_name`, `table_type`, `column_name`, `ordinal_position`, `data_type`, `is_nullable`, and a description column where the dialect has one. Add `table_catalog` when the export spans several databases or catalogs, and a `row_count` column where the dialect has one. If the import reports a missing column, adjust the query's aliases.

Postgres:

```sql
select c.table_schema, c.table_name, t.table_type, c.column_name, c.ordinal_position,
       c.data_type, c.udt_name, c.is_nullable, pd.description
from information_schema.columns c
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
left join pg_catalog.pg_attribute a
  on a.attrelid = format('%I.%I', c.table_schema, c.table_name)::regclass and a.attname = c.column_name
left join pg_catalog.pg_description pd on pd.objoid = a.attrelid and pd.objsubid = a.attnum
where c.table_schema not in ('pg_catalog', 'information_schema')
order by 1, 2, 5;
```

Export with `psql "$WAREHOUSE_URL" -c "\copy (<query>) to 'columns.csv' with csv header"`.

Snowflake (per database):

```sql
select c.table_schema, c.table_name, t.table_type, c.column_name, c.ordinal_position,
       c.data_type, c.is_nullable, c.comment as description, t.row_count
from <db>.information_schema.columns c
join <db>.information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema <> 'INFORMATION_SCHEMA'
order by 1, 2, 5;
```

BigQuery (per dataset, or per region with `` `region-us`.INFORMATION_SCHEMA.COLUMNS ``):

```sql
select c.table_schema, c.table_name, t.table_type, c.column_name, c.ordinal_position,
       c.data_type, c.is_nullable, p.description
from `<project>.<dataset>.INFORMATION_SCHEMA.COLUMNS` c
join `<project>.<dataset>.INFORMATION_SCHEMA.TABLES` t using (table_schema, table_name)
left join `<project>.<dataset>.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` p
  on p.table_name = c.table_name and p.column_name = c.column_name and p.field_path = c.column_name
order by 1, 2, 5;
```

Databricks (per catalog):

```sql
select c.table_schema, c.table_name, t.table_type, c.column_name, c.ordinal_position,
       c.full_data_type as data_type, c.is_nullable, c.comment as description
from <catalog>.information_schema.columns c
join <catalog>.information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema <> 'information_schema'
order by 1, 2, 5;
```

### dbt manifest

```
sl import --source wh --format dbt_manifest --file target/manifest.json --catalog target/catalog.json
```

The manifest carries models, sources, descriptions, column docs and tests (a `unique` plus `not_null` test suggests a key; a `relationships` test suggests a join). Column types and row counts live in `catalog.json`, which `dbt docs generate` writes; ask the owner to run it and share both files, and pass the catalog with `--catalog`. Without it the import still works but has no types or row counts. dbt descriptions are a head start for the interview, not approvals: still read each one back.

### DDL

```
sl import --source wh --format ddl --file schema.sql
```

Ways to get DDL: `pg_dump --schema-only --no-owner "$WAREHOUSE_URL" > schema.sql` for Postgres; `select get_ddl('database', '<db>')` for Snowflake; `select ddl from <dataset>.INFORMATION_SCHEMA.TABLES` for BigQuery; `show create table <name>` per table for Databricks. DDL gives declared keys and comments but usually no row counts.

## Manual path

When the owner can only describe tables, share a spreadsheet of columns or paste a few screenshots, write `snapshots/<source>.json` yourself following the snapshot format in `spec.md`:

- `"snapshot_version": 1`, the source's name and dialect, `"method": "manual"`, `captured_at` as the current UTC time in ISO format.
- One entry per table with `schema` (or `null`), `name`, `kind`, `row_count` (or `null` if unknown), and `columns` in their real order with `name`, `type` and `nullable` where known. Omit `profile`.
- Tables sorted by qualified name. Put only facts the owner gave you; leave unknowns `null` rather than guessing.

Then run `sl tables --source <s>` to confirm the CLI reads it and `sl validate`. Tell the owner that measures drafted from a manual snapshot need extra care at readback because nothing has been measured.

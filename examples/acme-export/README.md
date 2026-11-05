# Starting from a schema export

This example starts where many owners do: with a schema export rather than a database connection. Nothing in it reads table data.

1. Get the export query for your database and run it. For Postgres:

   ```sh
   bun skills/semantic-layer/scripts/sl.ts export-sql --dialect postgres --schemas acme > export.sql
   psql -X "$DATABASE_URL" --csv -f export.sql > schema.csv
   ```

   `export.sql` here is that query, and `schema.csv` is its output for the synthetic Acme warehouse (`fixtures/acme`, after `evolve.sql`): one row per column, with table and column comments, row estimates, and primary and foreign keys. The same command prints a query for MySQL, SQL Server, Snowflake, BigQuery, Databricks, Redshift and DuckDB.

2. Import it and write the baseline brief:

   ```sh
   cd examples/acme-export
   S="bun ../../skills/semantic-layer/scripts/sl.ts"
   $S init --name acme_export --root semantic
   $S add-source --name warehouse --dialect postgres --env WAREHOUSE_URL --root semantic
   $S import --source warehouse --file schema.csv --root semantic
   $S baseline --source warehouse --root semantic --out baseline.md
   ```

3. Read [`semantic/baseline.md`](semantic/baseline.md). It sketches the star schema, says what each table probably is and what one row probably means, lists relationships with fan-out warnings, candidate measures (with units such as cents), candidate splits including attributes reached through joins, columns that should not be splits, and the questions to ask the owner first. Every line is a guess for the owner to confirm. The skill opens the conversation with a short version of it, and then scopes, profiles and drafts from there.

The warehouse has 22 tables, more than the focus threshold, so the brief covers the top 12 and its next step is to agree a scope before profiling or drafting.

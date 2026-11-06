-- Schema export for Snowflake, for `sl import`.
--
-- Reads only metadata (the current database's INFORMATION_SCHEMA, SHOW PRIMARY KEYS and SHOW
-- IMPORTED KEYS): no table data is read and nothing is written, and it uses no warehouse
-- compute beyond the final SELECT over metadata. Returns one row per column, with its table's
-- type, comment and row count, its primary key position and the foreign keys it belongs to (a
-- column in several foreign keys appears once per key). It is one statement: the ->> flow
-- operator passes each SHOW result on, and in the final SELECT $1 is SHOW IMPORTED KEYS (one
-- statement back) and $2 is SHOW PRIMARY KEYS (two back).
--
-- Run it in the database to export and save CSV:
--   snowsql -a <account> -u <user> -d <database> -f snowflake.sql \
--     -o output_format=csv -o header=true -o timing=false -o friendly=false > schema.csv
-- (In Snowsight, run it and download the results as CSV.) Then import it:
--   sl import --source <source> --file schema.csv
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas,
-- or print this query with the filter applied: sl export-sql --dialect snowflake --schemas a,b
-- (unquoted names are stored in uppercase).
--
-- Restrict tables: sl export-sql --include/--exclude prints this query with a table filter at the
-- line marked sl:table-filter (a pattern the dialect cannot express is applied by sl import).
--
-- row_count is INFORMATION_SCHEMA.TABLES.ROW_COUNT; it is empty for views.
show primary keys in database
->> show imported keys in database
->> select
  c.table_schema as "table_schema",
  c.table_name as "table_name",
  t.table_type as "table_type",
  t.comment as "table_comment",
  t.row_count as "row_count",
  c.column_name as "column_name",
  c.ordinal_position as "ordinal_position",
  case
    when c.data_type = 'NUMBER' and c.numeric_precision is not null
      then 'NUMBER(' || c.numeric_precision || ',' || coalesce(c.numeric_scale, 0) || ')'
    else c.data_type
  end as "data_type",
  c.is_nullable as "is_nullable",
  c.comment as "column_comment",
  case when pk."column_name" is null then 'false' else 'true' end as "is_primary_key",
  pk."key_sequence" as "pk_ordinal",
  fk."fk_name" as "fk_name",
  fk."key_sequence" as "fk_ordinal",
  fk."pk_schema_name" as "references_schema",
  fk."pk_table_name" as "references_table",
  fk."pk_column_name" as "references_column"
from information_schema.columns c
join information_schema.tables t
  on t.table_catalog = c.table_catalog and t.table_schema = c.table_schema and t.table_name = c.table_name
left join $2 pk
  on pk."database_name" = c.table_catalog and pk."schema_name" = c.table_schema
  and pk."table_name" = c.table_name and pk."column_name" = c.column_name
left join $1 fk
  on fk."fk_database_name" = c.table_catalog and fk."fk_schema_name" = c.table_schema
  and fk."fk_table_name" = c.table_name and fk."fk_column_name" = c.column_name
where c.table_schema <> 'INFORMATION_SCHEMA'
  -- and c.table_schema in ('PUBLIC')  -- sl:schema-filter: uncomment and list the schemas to export
  -- sl:table-filter: sl export-sql --include/--exclude writes the table filter here
order by 1, 2, 7, 13;

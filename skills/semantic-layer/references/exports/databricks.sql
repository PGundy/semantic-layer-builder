-- Schema export for Databricks (Unity Catalog), for `sl import`.
--
-- Reads only the current catalog's information_schema: no table data is read and nothing is
-- written. Returns one row per column, with its table's type and comment, its primary key position
-- and the foreign keys it belongs to (a column in several foreign keys appears once per key;
-- Unity Catalog keys are informational). information_schema has no row counts, so row_count is
-- empty; sl profile measures them.
--
-- Run it in the catalog to export (USE CATALOG <catalog>, or pick it in the SQL editor) and save
-- CSV: in the Databricks SQL editor, run it and download the results as CSV, or with the
-- Databricks CLI or any JDBC/ODBC client that writes CSV. Then import it:
--   sl import --source <source> --file schema.csv
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas, or
-- print this query with the filter applied: sl export-sql --dialect databricks --schemas a,b
-- (Unity Catalog stores schema names in lowercase).
--
-- Restrict tables: sl export-sql --include/--exclude prints this query with a table filter at the
-- line marked sl:table-filter (a pattern the dialect cannot express is applied by sl import).
with pk as (
  select k.table_schema, k.table_name, k.column_name, k.ordinal_position as pk_ordinal
  from information_schema.table_constraints tc
  join information_schema.key_column_usage k
    on k.constraint_catalog = tc.constraint_catalog and k.constraint_schema = tc.constraint_schema
    and k.constraint_name = tc.constraint_name
  where tc.constraint_type = 'PRIMARY KEY'
),
fk_cols as (
  select k.constraint_catalog, k.constraint_schema, k.constraint_name, k.table_schema, k.table_name, k.column_name,
    k.ordinal_position, k.position_in_unique_constraint,
    rc.unique_constraint_catalog, rc.unique_constraint_schema, rc.unique_constraint_name,
    count(*) over (partition by k.constraint_catalog, k.constraint_schema, k.constraint_name) as key_columns
  from information_schema.table_constraints tc
  join information_schema.key_column_usage k
    on k.constraint_catalog = tc.constraint_catalog and k.constraint_schema = tc.constraint_schema
    and k.constraint_name = tc.constraint_name
  join information_schema.referential_constraints rc
    on rc.constraint_catalog = tc.constraint_catalog and rc.constraint_schema = tc.constraint_schema
    and rc.constraint_name = tc.constraint_name
  where tc.constraint_type = 'FOREIGN KEY'
),
-- The referenced column is the column at the same position in the key the foreign key points at;
-- constraint_column_usage covers a single-column key whose referenced key is not visible here.
fk as (
  select f.table_schema, f.table_name, f.column_name, f.constraint_name as fk_name, f.ordinal_position as fk_ordinal,
    coalesce(u.table_schema, cu.table_schema) as references_schema,
    coalesce(u.table_name, cu.table_name) as references_table,
    coalesce(u.column_name, cu.column_name) as references_column
  from fk_cols f
  left join information_schema.key_column_usage u
    on u.constraint_catalog = f.unique_constraint_catalog and u.constraint_schema = f.unique_constraint_schema
    and u.constraint_name = f.unique_constraint_name and u.ordinal_position = f.position_in_unique_constraint
  left join information_schema.constraint_column_usage cu
    on f.key_columns = 1 and cu.constraint_catalog = f.constraint_catalog and cu.constraint_schema = f.constraint_schema
    and cu.constraint_name = f.constraint_name
    and not (cu.table_schema = f.table_schema and cu.table_name = f.table_name and cu.column_name = f.column_name)
  where coalesce(u.column_name, cu.column_name) is not null
)
select
  c.table_schema as table_schema,
  c.table_name as table_name,
  t.table_type as table_type,
  t.comment as table_comment,
  cast(null as bigint) as row_count,
  c.column_name as column_name,
  c.ordinal_position as ordinal_position,
  coalesce(c.full_data_type, c.data_type) as data_type,
  c.is_nullable as is_nullable,
  c.comment as column_comment,
  case when pk.column_name is null then 'false' else 'true' end as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  fk.fk_name as fk_name,
  fk.fk_ordinal as fk_ordinal,
  fk.references_schema as references_schema,
  fk.references_table as references_table,
  fk.references_column as references_column
from information_schema.columns c
join information_schema.tables t
  on t.table_catalog = c.table_catalog and t.table_schema = c.table_schema and t.table_name = c.table_name
left join pk on pk.table_schema = c.table_schema and pk.table_name = c.table_name and pk.column_name = c.column_name
left join fk on fk.table_schema = c.table_schema and fk.table_name = c.table_name and fk.column_name = c.column_name
where c.table_schema <> 'information_schema'
  -- and lower(c.table_schema) in ('default')  -- sl:schema-filter: uncomment and list the schemas to export
  -- sl:table-filter: sl export-sql --include/--exclude writes the table filter here
order by table_schema, table_name, ordinal_position, fk_name;

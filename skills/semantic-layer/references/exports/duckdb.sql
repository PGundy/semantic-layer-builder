-- Schema export for DuckDB (1.1 or later), for `sl import`.
--
-- Reads only DuckDB's catalog functions (duckdb_tables(), duckdb_views(), duckdb_columns(),
-- duckdb_constraints()): no table data is read and nothing is written. Returns one row per
-- column, with its table's type, comment and size estimate, its primary key position and the
-- foreign keys it belongs to (a column in several foreign keys appears once per key). It covers
-- the current database; a table in another attached database has the schema <database>.<schema>.
--
-- Run it and save CSV:
--   duckdb warehouse.duckdb -csv < duckdb.sql > schema.csv
-- Then import it:
--   sl import --source <source> --file schema.csv
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas,
-- or print this query with the filter applied: sl export-sql --dialect duckdb --schemas a,b
--
-- row_count is duckdb_tables().estimated_size; it is empty for views.
with rel as (
  select database_name, schema_name, table_name, 'BASE TABLE' as table_type, comment as table_comment,
    estimated_size as row_count
  from duckdb_tables()
  where not internal and not temporary
  union all
  select database_name, schema_name, view_name, 'VIEW', comment, cast(null as bigint)
  from duckdb_views()
  where not internal and not temporary
),
named as (
  select *,
    case when database_name = current_database() then schema_name else database_name || '.' || schema_name end as table_schema
  from rel
  where database_name not in ('system', 'temp')
    and schema_name not in ('information_schema', 'pg_catalog')
    -- and schema_name in ('main')  -- sl:schema-filter: uncomment and list the schemas to export
),
pk as (
  select database_name, schema_name, table_name, constraint_column_names[k.i] as column_name, k.i as pk_ordinal
  from duckdb_constraints() as dc, range(1, len(dc.constraint_column_names) + 1) as k(i)
  where constraint_type = 'PRIMARY KEY'
),
-- DuckDB foreign keys reference a table in the same schema.
fk as (
  select database_name, schema_name, table_name, constraint_column_names[k.i] as column_name,
    constraint_name as fk_name, k.i as fk_ordinal, referenced_table as references_table,
    referenced_column_names[k.i] as references_column
  from duckdb_constraints() as dc, range(1, len(dc.constraint_column_names) + 1) as k(i)
  where constraint_type = 'FOREIGN KEY'
)
select
  r.table_schema as table_schema,
  r.table_name as table_name,
  r.table_type as table_type,
  r.table_comment as table_comment,
  r.row_count as row_count,
  c.column_name as column_name,
  c.column_index as ordinal_position,
  c.data_type as data_type,
  case when c.is_nullable then 'YES' else 'NO' end as is_nullable,
  c.comment as column_comment,
  case when pk.column_name is null then 'false' else 'true' end as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  fk.fk_name as fk_name,
  fk.fk_ordinal as fk_ordinal,
  case when fk.fk_name is not null then r.table_schema end as references_schema,
  fk.references_table as references_table,
  fk.references_column as references_column
from named r
join duckdb_columns() c
  on c.database_name = r.database_name and c.schema_name = r.schema_name and c.table_name = r.table_name
left join pk
  on pk.database_name = r.database_name and pk.schema_name = r.schema_name and pk.table_name = r.table_name
  and pk.column_name = c.column_name
left join fk
  on fk.database_name = r.database_name and fk.schema_name = r.schema_name and fk.table_name = r.table_name
  and fk.column_name = c.column_name
order by r.table_schema, r.table_name, c.column_index, fk.fk_name;

-- Schema export for MySQL (5.7 or later) and MariaDB, for `sl import`.
--
-- Reads only information_schema: no table data is read and nothing is written. Returns one row
-- per column, with its table's type, comment and row estimate, its primary key position and the
-- foreign keys it belongs to (a column in several foreign keys appears once per key).
--
-- Run it and save the tab-separated result (--raw keeps comments as written; the query quotes
-- the names, comments and types so the file reads as CSV with a tab delimiter):
--   mysql --batch --raw -h <host> -u <user> -p <database> < mysql.sql > schema.tsv
-- Then import it:
--   sl import --source <source> --file schema.tsv
--
-- Restrict schemas (databases): uncomment the line marked sl:schema-filter below and list them,
-- or print this query with the filter applied: sl export-sql --dialect mysql --schemas a,b
--
-- row_count is information_schema.tables.table_rows: an estimate for InnoDB, empty for views.
-- mysql --batch prints NULL for an empty value; sl import reads it as empty.
select
  concat('"', replace(c.table_schema, '"', '""'), '"') as table_schema,
  concat('"', replace(c.table_name, '"', '""'), '"') as table_name,
  t.table_type as table_type,
  case when t.table_type = 'VIEW' or t.table_comment = '' then null
    else concat('"', replace(t.table_comment, '"', '""'), '"') end as table_comment,
  case when t.table_type = 'VIEW' then null else t.table_rows end as row_count,
  concat('"', replace(c.column_name, '"', '""'), '"') as column_name,
  c.ordinal_position as ordinal_position,
  concat('"', replace(c.column_type, '"', '""'), '"') as data_type,
  c.is_nullable as is_nullable,
  case when c.column_comment = '' then null
    else concat('"', replace(c.column_comment, '"', '""'), '"') end as column_comment,
  case when pk.column_name is null then 'false' else 'true' end as is_primary_key,
  pk.ordinal_position as pk_ordinal,
  concat('"', replace(fk.constraint_name, '"', '""'), '"') as fk_name,
  fk.ordinal_position as fk_ordinal,
  concat('"', replace(fk.referenced_table_schema, '"', '""'), '"') as references_schema,
  concat('"', replace(fk.referenced_table_name, '"', '""'), '"') as references_table,
  concat('"', replace(fk.referenced_column_name, '"', '""'), '"') as references_column
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
left join information_schema.key_column_usage pk
  on pk.table_schema = c.table_schema and pk.table_name = c.table_name and pk.column_name = c.column_name
  and pk.constraint_name = 'PRIMARY'
left join information_schema.key_column_usage fk
  on fk.table_schema = c.table_schema and fk.table_name = c.table_name and fk.column_name = c.column_name
  and fk.referenced_table_name is not null
where c.table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
  and t.table_type in ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED')
  -- and c.table_schema in ('shop')  -- sl:schema-filter: uncomment and list the schemas to export
order by c.table_schema, c.table_name, c.ordinal_position, fk.constraint_name;

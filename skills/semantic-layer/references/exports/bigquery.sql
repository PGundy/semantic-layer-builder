-- Schema export for BigQuery (GoogleSQL), for `sl import`.
--
-- Reads only metadata (each dataset's INFORMATION_SCHEMA views and __TABLES__): no table data is
-- read and nothing is written; metadata queries scan no table bytes. Returns one row per column,
-- with its table's type, description and row count, its primary key position and the foreign keys
-- it belongs to (a column in several foreign keys appears once per key; BigQuery keys are
-- unenforced). table_schema is the dataset.
--
-- Datasets: INFORMATION_SCHEMA is read per dataset, and each block between sl:per-dataset and
-- sl:end-per-dataset reads `my_dataset`. Replace `my_dataset` with your dataset (or
-- `project`.`dataset`), or print the query for several datasets, with each block repeated and
-- joined by UNION ALL: sl export-sql --dialect bigquery --schemas ds1,ds2
-- All datasets in one query must share a location.
--
-- Run it and save CSV:
--   bq --quiet query --use_legacy_sql=false --format=csv --max_rows=1000000 < bigquery.sql > schema.csv
-- (bq reads the query from stdin; passed as an argument, its opening "--" comment reads as a flag.)
-- Then import it:
--   sl import --source <source> --file schema.csv
--
-- row_count is __TABLES__.row_count; it is empty for views and external tables.
-- A foreign key of several columns is paired with its referenced columns through the referenced
-- table's primary key, so export every dataset a key points into: a multi-column key into a
-- dataset left out of the query is not listed.
with
cols as (
  -- sl:per-dataset
  select table_schema, table_name, column_name, ordinal_position, data_type, is_nullable
  from `my_dataset`.INFORMATION_SCHEMA.COLUMNS
  -- sl:end-per-dataset
),
fields as (
  -- sl:per-dataset
  select table_schema, table_name, column_name, description
  from `my_dataset`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS
  where field_path = column_name
  -- sl:end-per-dataset
),
tabs as (
  -- sl:per-dataset
  select table_schema, table_name, table_type
  from `my_dataset`.INFORMATION_SCHEMA.TABLES
  -- sl:end-per-dataset
),
opts as (
  -- sl:per-dataset
  select table_schema, table_name, option_value
  from `my_dataset`.INFORMATION_SCHEMA.TABLE_OPTIONS
  where option_name = 'description'
  -- sl:end-per-dataset
),
counts as (
  -- sl:per-dataset
  select dataset_id as table_schema, table_id as table_name, row_count
  from `my_dataset`.__TABLES__
  -- sl:end-per-dataset
),
tc as (
  -- sl:per-dataset
  select constraint_schema, constraint_name, table_schema, table_name, constraint_type
  from `my_dataset`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  -- sl:end-per-dataset
),
kcu as (
  -- sl:per-dataset
  select constraint_schema, constraint_name, table_schema, table_name, column_name, ordinal_position, position_in_unique_constraint
  from `my_dataset`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  -- sl:end-per-dataset
),
ccu as (
  -- sl:per-dataset
  select constraint_schema, constraint_name, table_schema, table_name, column_name
  from `my_dataset`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
  -- sl:end-per-dataset
),
pk as (
  select k.table_schema, k.table_name, k.column_name, k.ordinal_position as pk_ordinal
  from tc
  join kcu k
    on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name
    and k.table_schema = tc.table_schema and k.table_name = tc.table_name
  where tc.constraint_type = 'PRIMARY KEY'
),
fk_cols as (
  select k.constraint_schema, k.constraint_name, k.table_schema, k.table_name, k.column_name,
    k.ordinal_position, k.position_in_unique_constraint,
    count(*) over (partition by k.table_schema, k.table_name, k.constraint_name) as key_columns
  from tc
  join kcu k
    on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name
    and k.table_schema = tc.table_schema and k.table_name = tc.table_name
  where tc.constraint_type = 'FOREIGN KEY'
),
-- CONSTRAINT_COLUMN_USAGE lists a foreign key's referenced columns without their order; each is
-- paired with its key column through the referenced primary key's position, or directly when the
-- key has one column.
fk as (
  select f.table_schema, f.table_name, f.column_name, f.constraint_name as fk_name, f.ordinal_position as fk_ordinal,
    u.table_schema as references_schema, u.table_name as references_table, u.column_name as references_column
  from fk_cols f
  join ccu u on u.constraint_schema = f.constraint_schema and u.constraint_name = f.constraint_name
  left join pk p on p.table_schema = u.table_schema and p.table_name = u.table_name and p.column_name = u.column_name
  where f.key_columns = 1 or p.pk_ordinal = f.position_in_unique_constraint
)
select
  c.table_schema as table_schema,
  c.table_name as table_name,
  t.table_type as table_type,
  json_value(o.option_value) as table_comment,
  case when t.table_type in ('BASE TABLE', 'CLONE', 'SNAPSHOT') then n.row_count end as row_count,
  c.column_name as column_name,
  c.ordinal_position as ordinal_position,
  c.data_type as data_type,
  c.is_nullable as is_nullable,
  d.description as column_comment,
  if(pk.column_name is null, 'false', 'true') as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  fk.fk_name as fk_name,
  fk.fk_ordinal as fk_ordinal,
  fk.references_schema as references_schema,
  fk.references_table as references_table,
  fk.references_column as references_column
from cols c
join tabs t on t.table_schema = c.table_schema and t.table_name = c.table_name
left join fields d on d.table_schema = c.table_schema and d.table_name = c.table_name and d.column_name = c.column_name
left join opts o on o.table_schema = c.table_schema and o.table_name = c.table_name
left join counts n on n.table_schema = c.table_schema and n.table_name = c.table_name
left join pk on pk.table_schema = c.table_schema and pk.table_name = c.table_name and pk.column_name = c.column_name
left join fk on fk.table_schema = c.table_schema and fk.table_name = c.table_name and fk.column_name = c.column_name
order by table_schema, table_name, ordinal_position, fk_name;

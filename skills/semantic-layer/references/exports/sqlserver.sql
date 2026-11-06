-- Schema export for Microsoft SQL Server (2012 or later) and Azure SQL, for `sl import`.
--
-- Reads only the catalog views (sys.objects, sys.columns, sys.indexes, sys.foreign_keys,
-- sys.partitions, sys.extended_properties): no table data is read and nothing is written. Returns
-- one row per column, with its table's type, MS_Description comment and row count, its primary key
-- position and the foreign keys it belongs to (a column in several foreign keys appears once per key).
--
-- Run it and save CSV (-f 65001 writes UTF-8, -s, sets the comma separator, -W trims padding;
-- the query quotes the names, comments and types, so commas inside them survive):
--   sqlcmd -S <server> -d <database> -i sqlserver.sql -f 65001 -s, -W > schema.csv
-- Then import it:
--   sl import --source <source> --file schema.csv
-- sl import skips the dashed line under sqlcmd's header and reads NULL as empty.
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas,
-- or print this query with the filter applied: sl export-sql --dialect sqlserver --schemas a,b
--
-- Restrict tables: sl export-sql --include/--exclude prints this query with a table filter at the
-- line marked sl:table-filter (a pattern the dialect cannot express is applied by sl import).
--
-- row_count sums sys.partitions.rows over the heap or clustered index; it is empty for views.
-- Comments are cut at 1,900 characters, so a quoted comment stays within nvarchar(4000).
set nocount on;

with rel as (
  select o.object_id, s.name as table_schema, o.name as table_name,
    case o.type when 'V' then 'VIEW' else 'BASE TABLE' end as table_type,
    case when o.type = 'U' then (
      select sum(p.rows) from sys.partitions p where p.object_id = o.object_id and p.index_id in (0, 1)
    ) end as row_count
  from sys.objects o
  join sys.schemas s on s.schema_id = o.schema_id
  where o.type in ('U', 'V') and o.is_ms_shipped = 0
    and s.name not in ('sys', 'INFORMATION_SCHEMA')
    -- and s.name in (N'dbo')  -- sl:schema-filter: uncomment and list the schemas to export
    -- sl:table-filter: sl export-sql --include/--exclude writes the table filter here
),
pk as (
  select ic.object_id, ic.column_id, ic.key_ordinal as pk_ordinal
  from sys.indexes i
  join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
  where i.is_primary_key = 1 and ic.key_ordinal > 0
),
fk as (
  select fkc.parent_object_id as object_id, fkc.parent_column_id as column_id, f.name as fk_name,
    fkc.constraint_column_id as fk_ordinal,
    object_schema_name(fkc.referenced_object_id) as references_schema,
    object_name(fkc.referenced_object_id) as references_table,
    col_name(fkc.referenced_object_id, fkc.referenced_column_id) as references_column
  from sys.foreign_keys f
  join sys.foreign_key_columns fkc on fkc.constraint_object_id = f.object_id
)
select
  '"' + replace(r.table_schema, '"', '""') + '"' as table_schema,
  '"' + replace(r.table_name, '"', '""') + '"' as table_name,
  r.table_type as table_type,
  '"' + replace(cast(left(cast(tp.value as nvarchar(max)), 1900) as nvarchar(1900)), '"', '""') + '"' as table_comment,
  r.row_count as row_count,
  '"' + replace(c.name, '"', '""') + '"' as column_name,
  c.column_id as ordinal_position,
  '"' + case
    when ty.name in ('varchar', 'char', 'varbinary', 'binary')
      then ty.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length as varchar(10)) end + ')'
    when ty.name in ('nvarchar', 'nchar')
      then ty.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length / 2 as varchar(10)) end + ')'
    when ty.name in ('decimal', 'numeric')
      then ty.name + '(' + cast(c.precision as varchar(10)) + ',' + cast(c.scale as varchar(10)) + ')'
    when ty.name in ('datetime2', 'datetimeoffset', 'time')
      then ty.name + '(' + cast(c.scale as varchar(10)) + ')'
    else ty.name
  end + '"' as data_type,
  case when c.is_nullable = 1 then 'YES' else 'NO' end as is_nullable,
  '"' + replace(cast(left(cast(cp.value as nvarchar(max)), 1900) as nvarchar(1900)), '"', '""') + '"' as column_comment,
  case when pk.column_id is null then 'false' else 'true' end as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  '"' + replace(fk.fk_name, '"', '""') + '"' as fk_name,
  fk.fk_ordinal as fk_ordinal,
  '"' + replace(fk.references_schema, '"', '""') + '"' as references_schema,
  '"' + replace(fk.references_table, '"', '""') + '"' as references_table,
  '"' + replace(fk.references_column, '"', '""') + '"' as references_column
from rel r
join sys.columns c on c.object_id = r.object_id
join sys.types ty on ty.user_type_id = c.user_type_id
left join sys.extended_properties tp
  on tp.class = 1 and tp.major_id = r.object_id and tp.minor_id = 0 and tp.name = 'MS_Description'
left join sys.extended_properties cp
  on cp.class = 1 and cp.major_id = r.object_id and cp.minor_id = c.column_id and cp.name = 'MS_Description'
left join pk on pk.object_id = r.object_id and pk.column_id = c.column_id
left join fk on fk.object_id = r.object_id and fk.column_id = c.column_id
order by r.table_schema, r.table_name, c.column_id, fk.fk_name;

-- Schema export for Amazon Redshift, for `sl import`.
--
-- Reads only the system catalog (pg_catalog, on the leader node): no table data is read and
-- nothing is written. Returns one row per column, with its table's type, comment and row
-- estimate, its primary key position and the foreign keys it belongs to (a column in several
-- foreign keys appears once per key). Redshift keeps primary and foreign keys as informational
-- constraints; they are read from pg_constraint, pairing each key column with the referenced
-- column at the same position of the constraint's key arrays.
--
-- Run it and save CSV (psql 12 or later):
--   psql -X "host=<cluster> port=5439 dbname=<db> user=<user>" --csv -f redshift.sql > schema.csv
-- (-X skips ~/.psqlrc, whose settings, such as \pset null, would change the CSV.)
-- Then import it:
--   sl import --source <source> --file schema.csv
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas,
-- or print this query with the filter applied: sl export-sql --dialect redshift --schemas a,b
--
-- Restrict tables: sl export-sql --include/--exclude prints this query with a table filter at the
-- line marked sl:table-filter (a pattern the dialect cannot express is applied by sl import).
--
-- row_count is pg_class.reltuples, the planner's estimate (svv_table_info.tbl_rows has exact
-- counts). Late-binding views (WITH NO SCHEMA BINDING) and Spectrum external tables keep their
-- columns elsewhere (pg_get_late_binding_view_cols(), svv_external_columns) and are not listed.
with rel as (
  select c.oid, k.oid as class_oid, n.nspname as table_schema, c.relname as table_name,
    case c.relkind when 'v' then 'VIEW' else 'BASE TABLE' end as table_type,
    d.description as table_comment,
    case when c.relkind = 'r' and c.reltuples >= 0 then cast(c.reltuples as bigint) end as row_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  -- pg_description holds comments on objects of many catalogs; classoid names pg_class.
  cross join (
    select kc.oid from pg_class kc join pg_namespace kn on kn.oid = kc.relnamespace
    where kc.relname = 'pg_class' and kn.nspname = 'pg_catalog'
  ) k
  left join pg_description d on d.objoid = c.oid and d.classoid = k.oid and d.objsubid = 0
  where c.relkind in ('r', 'v')
    and n.nspname not in ('information_schema', 'catalog_history')
    and left(n.nspname, 3) <> 'pg_'
    -- and n.nspname in ('public')  -- sl:schema-filter: uncomment and list the schemas to export
    -- sl:table-filter: sl export-sql --include/--exclude writes the table filter here
),
-- Positions 1 to 32 (the most columns a key holds), to index a constraint's key arrays; the
-- leader node has no unnest.
pos as (
  select generate_series(1, 32) as i
),
pk as (
  select con.conrelid as oid, con.conkey[p.i] as attnum, p.i as pk_ordinal
  from pg_constraint con
  cross join pos p
  where con.contype = 'p' and con.conkey[p.i] is not null
),
-- conkey and confkey list a foreign key's columns and the columns they reference in the order
-- the key declares them, so the entries at one position pair up.
fk as (
  select con.conrelid as oid, con.conkey[p.i] as attnum, con.conname as fk_name, p.i as fk_ordinal,
    rn.nspname as references_schema, rc.relname as references_table, ra.attname as references_column
  from pg_constraint con
  cross join pos p
  join pg_class rc on rc.oid = con.confrelid
  join pg_namespace rn on rn.oid = rc.relnamespace
  join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = con.confkey[p.i]
  where con.contype = 'f' and con.conkey[p.i] is not null
)
select
  r.table_schema as table_schema,
  r.table_name as table_name,
  r.table_type as table_type,
  r.table_comment as table_comment,
  r.row_count as row_count,
  a.attname as column_name,
  a.attnum as ordinal_position,
  format_type(a.atttypid, a.atttypmod) as data_type,
  case when a.attnotnull then 'NO' else 'YES' end as is_nullable,
  cd.description as column_comment,
  case when pk.attnum is null then 'false' else 'true' end as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  fk.fk_name as fk_name,
  fk.fk_ordinal as fk_ordinal,
  fk.references_schema as references_schema,
  fk.references_table as references_table,
  fk.references_column as references_column
from rel r
join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
left join pg_description cd on cd.objoid = r.oid and cd.classoid = r.class_oid and cd.objsubid = a.attnum
left join pk on pk.oid = r.oid and pk.attnum = a.attnum
left join fk on fk.oid = r.oid and fk.attnum = a.attnum
order by r.table_schema, r.table_name, a.attnum, fk.fk_name;

-- Schema export for PostgreSQL (12 or later), for `sl import`.
--
-- Reads only the system catalog (pg_catalog): no table data is read and nothing is written.
-- Returns one row per column, with its table's type, comment and row estimate, its primary
-- key position and the foreign keys it belongs to (a column in several foreign keys appears
-- once per key).
--
-- Run it and save CSV:
--   psql -X "$DATABASE_URL" --csv -f postgres.sql > schema.csv
-- (-X skips ~/.psqlrc, whose settings, such as \pset null, would change the CSV.)
-- Then import it:
--   sl import --source <source> --file schema.csv
--
-- Restrict schemas: uncomment the line marked sl:schema-filter below and list the schemas,
-- or print this query with the filter applied: sl export-sql --dialect postgres --schemas a,b
--
-- Restrict tables: sl export-sql --include/--exclude prints this query with a table filter at the
-- line marked sl:table-filter (a pattern the dialect cannot express is applied by sl import).
--
-- row_count is the planner's estimate (pg_class.reltuples, kept by ANALYZE and autovacuum);
-- it is empty for views and for tables never analyzed. Before PostgreSQL 14 a table never
-- analyzed and an empty one both read reltuples = 0 with no pages, so there an empty table's
-- row_count is empty too. A partitioned table's estimate sums its partitions, and the partitions
-- themselves are left out.
with rel as (
  select c.oid, n.nspname as table_schema, c.relname as table_name, c.relkind,
    case c.relkind when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' when 'f' then 'FOREIGN TABLE' else 'BASE TABLE' end as table_type,
    obj_description(c.oid, 'pg_class') as table_comment,
    case
      when c.relkind = 'p' then (
        select sum(p.reltuples)::bigint
        from pg_partition_tree(c.oid) t
        join pg_class p on p.oid = t.relid
        where t.isleaf and p.reltuples >= 0 and (v.known_empty or p.reltuples > 0 or p.relpages > 0))
      when c.relkind in ('r', 'm') and c.reltuples >= 0 and (v.known_empty or c.reltuples > 0 or c.relpages > 0)
        then c.reltuples::bigint
    end as row_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  -- From PostgreSQL 14 a table never analyzed has reltuples = -1, so 0 means analyzed and empty.
  cross join (select current_setting('server_version_num')::int >= 140000 as known_empty) v
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
    and not c.relispartition
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname !~ '^pg_toast'
    and n.nspname !~ '^pg_temp'
    -- and n.nspname in ('public')  -- sl:schema-filter: uncomment and list the schemas to export
    -- sl:table-filter: sl export-sql --include/--exclude writes the table filter here
),
pk as (
  select con.conrelid as oid, k.attnum, k.ord as pk_ordinal
  from pg_constraint con
  cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
  where con.contype = 'p' and con.conparentid = 0
),
fk as (
  select con.conrelid as oid, k.attnum, con.conname as fk_name, k.ord as fk_ordinal,
    rn.nspname as references_schema, rc.relname as references_table, ra.attname as references_column
  from pg_constraint con
  cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(attnum, ref_attnum, ord)
  join pg_class rc on rc.oid = con.confrelid
  join pg_namespace rn on rn.oid = rc.relnamespace
  join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = k.ref_attnum
  -- conparentid = 0 skips the copies a foreign key to a partitioned table keeps for each partition.
  where con.contype = 'f' and con.conparentid = 0
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
  col_description(r.oid, a.attnum) as column_comment,
  case when pk.attnum is null then 'false' else 'true' end as is_primary_key,
  pk.pk_ordinal as pk_ordinal,
  fk.fk_name as fk_name,
  fk.fk_ordinal as fk_ordinal,
  fk.references_schema as references_schema,
  fk.references_table as references_table,
  fk.references_column as references_column
from rel r
join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
left join pk on pk.oid = r.oid and pk.attnum = a.attnum
left join fk on fk.oid = r.oid and fk.attnum = a.attnum
order by r.table_schema, r.table_name, a.attnum, fk.fk_name;

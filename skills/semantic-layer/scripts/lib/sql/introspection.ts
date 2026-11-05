// Catalog queries that describe a source's tables, columns and keys, for every dialect.
//
// Query ids and their result columns:
//   tables        table_schema, table_name, table_kind (table|view|external), row_count (estimate or null), description
//   columns       table_schema, table_name, column_name, data_type, is_nullable (boolean or YES/NO), ordinal_position, description
//   primary_keys  table_schema, table_name, column_name, ordinal_position
//   foreign_keys  constraint_name, table_schema, table_name, column_name, ref_schema, ref_table, ref_column, ordinal_position
// A dialect whose catalog cannot answer a query in one SELECT leaves it out of the plan.
import { quoteIdent, quoteLiteral } from "../dialect.ts";
import { UserError } from "../errors.ts";
import type { PlannedQuery, QueryPlan, SourceConfig } from "../types.ts";

export interface IntrospectionOptions {
  schemas?: string[];
}

export const INTROSPECTION_QUERY_IDS = ["tables", "columns", "primary_keys", "foreign_keys"] as const;

const PURPOSE: Record<(typeof INTROSPECTION_QUERY_IDS)[number], string> = {
  tables: "Tables and views with kind, row estimate and description",
  columns: "Columns with type, nullability, position and description",
  primary_keys: "Primary key columns in key order",
  foreign_keys: "Foreign key columns paired with the columns they reference, in key order",
};

function query(id: (typeof INTROSPECTION_QUERY_IDS)[number], sql: string): PlannedQuery {
  return { id, purpose: PURPOSE[id], sql: sql.trim() };
}

function literalList(values: string[]): string {
  return values.map(quoteLiteral).join(", ");
}

function cleanSchemas(schemas: string[] | undefined): string[] {
  return [...new Set((schemas ?? []).map((s) => s.trim()).filter(Boolean))];
}

// DuckDB: catalog functions over the open database. Temporary views, which lake
// sources use for their file-backed tables, report schema 'main'. A temporary object
// shadows a main-schema object of the same name (names resolve case-insensitively,
// temp first), so the shadowed object is left out. Tables in other attached databases
// report schema '<database>.<schema>'.
function duckdbQueries(schemas: string[]): PlannedQuery[] {
  const schemaExpr = `case when database_name = current_database() or database_name = 'temp' then schema_name else database_name || '.' || schema_name end`;
  const userObject = (nameCol: string) =>
    `database_name <> 'system' and schema_name not in ('information_schema', 'pg_catalog')
  and not (database_name = current_database() and schema_name = 'main' and lower(${nameCol}) in (
    select lower(view_name) from duckdb_views() where database_name = 'temp'
    union all select lower(table_name) from duckdb_tables() where database_name = 'temp'))`;
  const restrict = schemas.length ? `\nwhere table_schema in (${literalList(schemas)})` : "";
  const wrap = (inner: string, order: string) => `select * from (\n${inner}\n) as q${restrict}\norder by ${order}`;
  return [
    query(
      "tables",
      wrap(
        `select ${schemaExpr} as table_schema, table_name, 'table' as table_kind, estimated_size as row_count, comment as description
from duckdb_tables()
where not internal and ${userObject("table_name")}
union all
select ${schemaExpr} as table_schema, view_name as table_name, 'view' as table_kind, cast(null as bigint) as row_count, comment as description
from duckdb_views()
where not internal and ${userObject("view_name")}`,
        "table_schema, table_name",
      ),
    ),
    query(
      "columns",
      wrap(
        `select ${schemaExpr} as table_schema, table_name, column_name, data_type, is_nullable, column_index as ordinal_position, comment as description
from duckdb_columns()
where not internal and ${userObject("table_name")}`,
        "table_schema, table_name, ordinal_position",
      ),
    ),
    query(
      "primary_keys",
      wrap(
        `select ${schemaExpr} as table_schema, table_name, constraint_column_names[k.i] as column_name, k.i as ordinal_position
from duckdb_constraints() as dc, range(1, len(dc.constraint_column_names) + 1) as k(i)
where constraint_type = 'PRIMARY KEY' and ${userObject("table_name")}`,
        "table_schema, table_name, ordinal_position",
      ),
    ),
    query(
      "foreign_keys",
      wrap(
        `select constraint_name, ${schemaExpr} as table_schema, table_name, constraint_column_names[k.i] as column_name,
  ${schemaExpr} as ref_schema, referenced_table as ref_table, referenced_column_names[k.i] as ref_column, k.i as ordinal_position
from duckdb_constraints() as dc, range(1, len(dc.constraint_column_names) + 1) as k(i)
where constraint_type = 'FOREIGN KEY' and ${userObject("table_name")}`,
        "table_schema, table_name, constraint_name, ordinal_position",
      ),
    ),
  ];
}

// Postgres: pg_catalog, so row estimates, comments and composite key order are exact.
function postgresQueries(schemas: string[]): PlannedQuery[] {
  const where = (ns: string) =>
    [
      `${ns}.nspname not in ('pg_catalog', 'information_schema')`,
      `${ns}.nspname !~ '^pg_toast'`,
      `${ns}.nspname !~ '^pg_temp'`,
      ...(schemas.length ? [`${ns}.nspname in (${literalList(schemas)})`] : []),
    ].join("\n  and ");
  const relation = `c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition`;
  return [
    query(
      "tables",
      `select n.nspname as table_schema, c.relname as table_name,
  case c.relkind when 'v' then 'view' when 'm' then 'view' when 'f' then 'external' else 'table' end as table_kind,
  case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end as row_count,
  obj_description(c.oid, 'pg_class') as description
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where ${relation}
  and ${where("n")}
order by 1, 2`,
    ),
    query(
      "columns",
      `select n.nspname as table_schema, c.relname as table_name, a.attname as column_name,
  format_type(a.atttypid, a.atttypmod) as data_type, not a.attnotnull as is_nullable,
  a.attnum as ordinal_position, col_description(c.oid, a.attnum) as description
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where a.attnum > 0 and not a.attisdropped
  and ${relation}
  and ${where("n")}
order by 1, 2, a.attnum`,
    ),
    query(
      "primary_keys",
      `select n.nspname as table_schema, c.relname as table_name, a.attname as column_name, k.ord as ordinal_position
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
where con.contype = 'p' and not c.relispartition
  and ${where("n")}
order by 1, 2, 4`,
    ),
    query(
      "foreign_keys",
      `select con.conname as constraint_name, n.nspname as table_schema, c.relname as table_name, a.attname as column_name,
  rn.nspname as ref_schema, rc.relname as ref_table, ra.attname as ref_column, k.ord as ordinal_position
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_class rc on rc.oid = con.confrelid
join pg_namespace rn on rn.oid = rc.relnamespace
cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(attnum, ref_attnum, ord)
join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
join pg_attribute ra on ra.attrelid = rc.oid and ra.attnum = k.ref_attnum
where con.contype = 'f' and not c.relispartition and con.conparentid = 0
  and ${where("n")}
order by 2, 3, 1, 8`,
    ),
  ];
}

// True when a name has letters of only one case, so it reads as an unquoted identifier.
function oneCase(name: string): boolean {
  return name === name.toUpperCase() || name === name.toLowerCase();
}

// Snowflake: the current database's information_schema. Keys are not exposed
// there (they need SHOW PRIMARY KEYS), so the plan leaves them out. A schema given
// in one case matches case-insensitively, as an unquoted identifier does; a
// mixed-case name matches exactly, as a quoted one does.
function snowflakeQueries(schemas: string[]): PlannedQuery[] {
  const folded = schemas.filter(oneCase).map((s) => s.toUpperCase());
  const exact = schemas.filter((s) => !oneCase(s));
  const restrict = (col: string) => {
    const parts = [
      ...(folded.length ? [`upper(${col}) in (${literalList(folded)})`] : []),
      ...(exact.length ? [`${col} in (${literalList(exact)})`] : []),
    ];
    return parts.length ? `\n  and (${parts.join(" or ")})` : "";
  };
  return [
    query(
      "tables",
      `select table_schema as table_schema, table_name as table_name,
  case when table_type like '%VIEW%' then 'view' when table_type = 'EXTERNAL TABLE' then 'external' else 'table' end as table_kind,
  row_count as row_count, comment as description
from information_schema.tables
where table_schema <> 'INFORMATION_SCHEMA'${restrict("table_schema")}
order by 1, 2`,
    ),
    query(
      "columns",
      `select table_schema as table_schema, table_name as table_name, column_name as column_name,
  case when data_type = 'NUMBER' and numeric_precision is not null
    then 'NUMBER(' || numeric_precision || ',' || coalesce(numeric_scale, 0) || ')' else data_type end as data_type,
  is_nullable as is_nullable, ordinal_position as ordinal_position, comment as description
from information_schema.columns
where table_schema <> 'INFORMATION_SCHEMA'${restrict("table_schema")}
order by 1, 2, 6`,
    ),
  ];
}

// BigQuery: INFORMATION_SCHEMA is per dataset, so every query unions the datasets.
// A dataset may be written as project.dataset. Each row's table_schema is the dataset
// as given, so a project qualifier survives into the snapshot; a referenced table's
// schema maps back to a given dataset with the same dataset id, preferring the
// referencing dataset. All datasets in one plan must share a location.
function bigqueryQueries(datasets: string[]): PlannedQuery[] {
  if (!datasets.length) {
    throw new UserError(
      "BigQuery introspection needs the datasets to read: pass --schemas <dataset>[,<dataset>...] (project.dataset also works).",
    );
  }
  const ds = (d: string) => d.split(".").map((p) => quoteIdent("bigquery", p)).join(".");
  const lit = quoteLiteral;
  const datasetId = (d: string) => d.split(".").pop() ?? d;
  const union = (select: (path: string, d: string) => string) => datasets.map((d) => `  ${select(ds(d), d)}`).join("\n  union all\n");
  // The given dataset a referenced table_schema (a dataset id) stands for.
  const refSchema = (from: string) => {
    const order = [from, ...datasets.filter((d) => d !== from)];
    const seen = new Set<string>();
    const whens: string[] = [];
    for (const d of order) {
      const id = datasetId(d);
      if (seen.has(id)) continue;
      seen.add(id);
      whens.push(`when ${lit(id)} then ${lit(d)}`);
    }
    return `case table_schema ${whens.join(" ")} else table_schema end`;
  };
  const constraintCtes = `tc as (
${union((p, d) => `select ${lit(d)} as table_schema, constraint_schema, constraint_name, table_name, constraint_type from ${p}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`)}
),
kcu as (
${union((p, d) => `select ${lit(d)} as table_schema, constraint_schema, constraint_name, table_name, column_name, ordinal_position, position_in_unique_constraint from ${p}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE`)}
)`;
  const keyJoin = `k.table_schema = tc.table_schema and k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name and k.table_name = tc.table_name`;
  return [
    query(
      "tables",
      `with t as (
${union((p, d) => `select ${lit(d)} as table_schema, table_name, table_type from ${p}.INFORMATION_SCHEMA.TABLES`)}
),
o as (
${union((p, d) => `select ${lit(d)} as table_schema, table_name, option_value from ${p}.INFORMATION_SCHEMA.TABLE_OPTIONS where option_name = 'description'`)}
),
r as (
${union((p, d) => `select ${lit(d)} as table_schema, table_id as table_name, row_count from ${p}.__TABLES__`)}
)
select t.table_schema as table_schema, t.table_name as table_name,
  case when t.table_type like '%VIEW%' then 'view' when t.table_type = 'EXTERNAL' then 'external' else 'table' end as table_kind,
  case when t.table_type in ('BASE TABLE', 'CLONE', 'SNAPSHOT') then r.row_count end as row_count,
  json_value(o.option_value) as description
from t
left join o on o.table_schema = t.table_schema and o.table_name = t.table_name
left join r on r.table_schema = t.table_schema and r.table_name = t.table_name
order by 1, 2`,
    ),
    query(
      "columns",
      `with c as (
${union((p, d) => `select ${lit(d)} as table_schema, table_name, column_name, data_type, is_nullable, ordinal_position from ${p}.INFORMATION_SCHEMA.COLUMNS`)}
),
f as (
${union((p, d) => `select ${lit(d)} as table_schema, table_name, column_name, description from ${p}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS where field_path = column_name`)}
)
select c.table_schema as table_schema, c.table_name as table_name, c.column_name as column_name, c.data_type as data_type,
  c.is_nullable as is_nullable, c.ordinal_position as ordinal_position, f.description as description
from c
left join f on f.table_schema = c.table_schema and f.table_name = c.table_name and f.column_name = c.column_name
order by 1, 2, 6`,
    ),
    query(
      "primary_keys",
      `with ${constraintCtes}
select k.table_schema as table_schema, k.table_name as table_name, k.column_name as column_name, k.ordinal_position as ordinal_position
from tc
join kcu k on ${keyJoin}
where tc.constraint_type = 'PRIMARY KEY'
order by 1, 2, 4`,
    ),
    // CONSTRAINT_COLUMN_USAGE lists a foreign key's referenced columns without their
    // order; each is paired with its key column through the referenced primary key's
    // position, or directly when the key has one column.
    query(
      "foreign_keys",
      `with ${constraintCtes},
ccu as (
${union((p, d) => `select ${lit(d)} as ds, constraint_schema, constraint_name, ${refSchema(d)} as table_schema, table_name, column_name from ${p}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE`)}
),
fk as (
  select k.constraint_schema, k.constraint_name, k.table_schema, k.table_name, k.column_name, k.ordinal_position, k.position_in_unique_constraint,
    count(*) over (partition by k.table_schema, k.table_name, k.constraint_name) as key_columns
  from tc
  join kcu k on ${keyJoin}
  where tc.constraint_type = 'FOREIGN KEY'
),
pk as (
  select k.table_schema, k.table_name, k.column_name, k.ordinal_position
  from tc
  join kcu k on ${keyJoin}
  where tc.constraint_type = 'PRIMARY KEY'
)
select fk.constraint_name as constraint_name, fk.table_schema as table_schema, fk.table_name as table_name, fk.column_name as column_name,
  u.table_schema as ref_schema, u.table_name as ref_table, u.column_name as ref_column, fk.ordinal_position as ordinal_position
from fk
join ccu u on u.ds = fk.table_schema and u.constraint_schema = fk.constraint_schema and u.constraint_name = fk.constraint_name
left join pk on pk.table_schema = u.table_schema and pk.table_name = u.table_name and pk.column_name = u.column_name
where fk.key_columns = 1 or pk.ordinal_position = fk.position_in_unique_constraint
order by 2, 3, 1, 8`,
    ),
  ];
}

// Databricks: the current catalog's information_schema (Unity Catalog). Unity Catalog
// stores schema names in lowercase, so the filter folds case.
function databricksQueries(schemas: string[]): PlannedQuery[] {
  const restrict = (col: string) =>
    schemas.length ? `\n  and lower(${col}) in (${literalList(schemas.map((s) => s.toLowerCase()))})` : "";
  const notSystem = (col: string) => `${col} <> 'information_schema'${restrict(col)}`;
  return [
    query(
      "tables",
      `select table_schema as table_schema, table_name as table_name,
  case when table_type like '%VIEW%' then 'view' when table_type in ('EXTERNAL', 'FOREIGN') then 'external' else 'table' end as table_kind,
  cast(null as bigint) as row_count, comment as description
from information_schema.tables
where ${notSystem("table_schema")}
order by 1, 2`,
    ),
    query(
      "columns",
      `select table_schema as table_schema, table_name as table_name, column_name as column_name,
  coalesce(full_data_type, data_type) as data_type, is_nullable as is_nullable, ordinal_position as ordinal_position, comment as description
from information_schema.columns
where ${notSystem("table_schema")}
order by 1, 2, 6`,
    ),
    query(
      "primary_keys",
      `select k.table_schema as table_schema, k.table_name as table_name, k.column_name as column_name, k.ordinal_position as ordinal_position
from information_schema.table_constraints tc
join information_schema.key_column_usage k
  on k.constraint_catalog = tc.constraint_catalog and k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name
where tc.constraint_type = 'PRIMARY KEY' and ${notSystem("tc.table_schema")}
order by 1, 2, 4`,
    ),
    // The referenced column comes from the unique constraint the foreign key points at,
    // matched by position. constraint_column_usage covers a single-column key whose
    // referenced constraint is not visible in this catalog.
    query(
      "foreign_keys",
      `with fk as (
  select k.constraint_catalog, k.constraint_schema, k.constraint_name, k.table_schema, k.table_name, k.column_name,
    k.ordinal_position, k.position_in_unique_constraint,
    rc.unique_constraint_catalog, rc.unique_constraint_schema, rc.unique_constraint_name,
    count(*) over (partition by k.constraint_catalog, k.constraint_schema, k.constraint_name) as key_columns
  from information_schema.table_constraints tc
  join information_schema.key_column_usage k
    on k.constraint_catalog = tc.constraint_catalog and k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name
  join information_schema.referential_constraints rc
    on rc.constraint_catalog = tc.constraint_catalog and rc.constraint_schema = tc.constraint_schema and rc.constraint_name = tc.constraint_name
  where tc.constraint_type = 'FOREIGN KEY' and ${notSystem("tc.table_schema")}
)
select fk.constraint_name as constraint_name, fk.table_schema as table_schema, fk.table_name as table_name, fk.column_name as column_name,
  coalesce(u.table_schema, cu.table_schema) as ref_schema, coalesce(u.table_name, cu.table_name) as ref_table,
  coalesce(u.column_name, cu.column_name) as ref_column, fk.ordinal_position as ordinal_position
from fk
left join information_schema.key_column_usage u
  on u.constraint_catalog = fk.unique_constraint_catalog and u.constraint_schema = fk.unique_constraint_schema
  and u.constraint_name = fk.unique_constraint_name and u.ordinal_position = fk.position_in_unique_constraint
left join information_schema.constraint_column_usage cu
  on fk.key_columns = 1 and cu.constraint_catalog = fk.constraint_catalog and cu.constraint_schema = fk.constraint_schema
  and cu.constraint_name = fk.constraint_name
  and not (cu.table_schema = fk.table_schema and cu.table_name = fk.table_name and cu.column_name = fk.column_name)
where coalesce(u.column_name, cu.column_name) is not null
order by 2, 3, 1, 8`,
    ),
  ];
}

// Whether a snapshot schema is one of the schemas a plan was restricted to, with the
// same case rules the dialect's plan uses.
export function schemaMatcher(dialect: SourceConfig["dialect"], schemas: string[]): (schema: string | null) => boolean {
  const given = cleanSchemas(schemas);
  if (dialect === "databricks") {
    const wanted = new Set(given.map((s) => s.toLowerCase()));
    return (schema) => wanted.has((schema ?? "").toLowerCase());
  }
  if (dialect === "snowflake") {
    const folded = new Set(given.filter(oneCase).map((s) => s.toUpperCase()));
    const exact = new Set(given.filter((s) => !oneCase(s)));
    return (schema) => exact.has(schema ?? "") || folded.has((schema ?? "").toUpperCase());
  }
  const wanted = new Set(given);
  // A BigQuery project.dataset also matches its bare dataset id, the form a
  // results file written from the catalog's own table_schema carries.
  if (dialect === "bigquery") for (const d of given) wanted.add(d.split(".").pop() ?? d);
  return (schema) => wanted.has(schema ?? "");
}

// Builds the plan that captures a source's catalog. opts.schemas restricts every
// dialect to those schemas (datasets for BigQuery, where it is required).
export function introspectionPlan(source: SourceConfig, opts: IntrospectionOptions = {}): QueryPlan {
  const schemas = cleanSchemas(opts.schemas);
  let queries: PlannedQuery[];
  switch (source.dialect) {
    case "duckdb":
      queries = duckdbQueries(schemas);
      break;
    case "postgres":
      queries = postgresQueries(schemas);
      break;
    case "snowflake":
      queries = snowflakeQueries(schemas);
      break;
    case "bigquery":
      queries = bigqueryQueries(schemas);
      break;
    case "databricks":
      queries = databricksQueries(schemas);
      break;
    default:
      throw new UserError(`Source "${source.source}" has unknown dialect "${String(source.dialect)}".`);
  }
  return { command: "introspect", source: source.source, dialect: source.dialect, queries };
}

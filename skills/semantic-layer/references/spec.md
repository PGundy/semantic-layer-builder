# Semantic layer specification, version 1

This file is the contract for every file the skill writes. The JSON Schemas in `../schemas/` encode the structure, `sl validate` checks the structure and the cross-references, and the TypeScript types in `../scripts/lib/types.ts` mirror both.

## Directory layout

A semantic layer is one directory, `semantic/` by default. `--root` or the `SEMANTIC_ROOT` environment variable points the CLI elsewhere.

```
semantic/
  semantic.yaml                 project file
  sources/<source>.yaml         one per data source
  snapshots/<source>.json       schema snapshot per source, written by tools
  models/<source>/<model>.yaml  one per modeled table
  metrics.yaml                  derived and ratio metrics
  access.yaml                   roles, row filters, denials
  goldens/<name>.yaml           confirmed question and answer pairs
```

File names equal the name inside the file: `sources/lake.yaml` holds `source: lake`, and `models/lake/web_events.yaml` holds `model: web_events` with `source: lake`.

## Names and references

- Every name (project, source, model, dimension, measure, join, metric, role, user attribute, golden) matches `^[a-z][a-z0-9_]*$`.
- Model names are unique within a source. Two sources may each have an `orders` model.
- Within one model, dimension, measure and join names share one namespace.
- References use dots. Inside a model's own file, a join's `to` is a bare model name in the same source. Inside `metrics.yaml`, a measure reference is `model.measure`, resolved in the metric's `source`. Inside `access.yaml` and goldens, a model reference is `source.model` and a field reference is `source.model.field`.
- Physical column names in `expr`, `filter`, join `keys` and row filters are written as they appear in the snapshot. An `expr` is a SQL expression in the source's dialect over the columns of that model's own table only. The compiler qualifies columns, so an `expr` never names a table or alias.

## Approval

Dimensions, measures, joins, models, metrics, the access file and goldens each carry:

```yaml
status: draft          # draft | approved
approved_by: Dana Ruiz # required when approved
approved_at: 2026-10-26 # ISO date, required when approved
```

Tools only ever write `status: draft`. The `sl approve` command sets `approved`, and the skill runs it only after the owner has explicitly confirmed a plain-English readback of that item. Downstream tools expose approved items by default and must flag any draft item they use.

Approval rules that `sl validate` enforces:

- An approved model has a `grain` and a `primary_key`.
- An approved measure or metric has a `description`.
- An approved metric references only approved measures.
- An approved join has `evidence` from `sl check-join`; without it validation warns.
- An approved item inside a draft model is allowed; the model's own status says whether the table as a whole is signed off.

## semantic.yaml

```yaml
version: 1
name: acme
description: Acme's commerce warehouse and event lake.
default_source: warehouse
settings:
  focus_threshold: 12    # more in-scope tables than this and the skill asks the owner to focus
  batch_size: 5          # tables per interview batch
```

## sources/<source>.yaml

```yaml
source: warehouse
dialect: postgres            # duckdb | postgres | snowflake | bigquery | databricks
description: Production replica of the order system.
connection:
  env: WAREHOUSE_URL         # name of the env var holding the connection URL; never the URL itself
scope:
  include: ["public.fct_*", "public.dim_*"]
  exclude: ["*_tmp", "*_backup"]
profile:
  sample_rows: 100000        # profile over a sample when tables are larger; omit for full scans
  top_values: 10
```

A DuckDB source, typically a lake over files:

```yaml
source: lake
dialect: duckdb
connection:
  database: ":memory:"       # or a .duckdb file path, relative to the semantic root
  setup:                     # statements run on every connection, in order
    - INSTALL httpfs
    - LOAD httpfs
  views:                     # view name -> relation; relative paths resolve from the semantic root
    web_events: read_parquet('../data/lake/web_events/*.parquet')
    sessions: read_parquet('../data/lake/sessions.parquet')
```

Only `duckdb` and `postgres` sources run queries directly. `snowflake`, `bigquery` and `databricks` sources work through the query-plan protocol below, where the agent runs the SQL with its own tool, such as an MCP connector.

### Scope patterns

`scope.include` and `scope.exclude` are lists of patterns. A table is in scope when it matches at least one include pattern, or `include` is empty or absent, and matches no exclude pattern. Exclude wins.

- A pattern containing a dot matches the qualified name `schema.table`. A pattern without a dot matches the table name alone.
- `*` matches any run of characters and `?` matches one character. Matching is case-insensitive.
- A pattern starting with `re:` is a regular expression, case-insensitive, anchored at both ends, matched against the qualified name if the pattern contains `\.` and against the table name otherwise.
- Examples: `fct_*` (prefix), `*_daily` (suffix), `*orders*` (contains), `analytics.*` (a whole schema), `re:dim_(customer|product)s?`.

## snapshots/<source>.json

Written by `sl introspect`, `sl import` and `sl profile`; never hand-edited except by the agent in the manual intake path.

```json
{
  "snapshot_version": 1,
  "source": "warehouse",
  "dialect": "postgres",
  "captured_at": "2026-10-26T12:00:00.000Z",
  "method": "live",
  "tables": [
    {
      "schema": "public",
      "name": "fct_orders",
      "kind": "table",
      "row_count": 10000,
      "description": null,
      "primary_key": ["order_id"],
      "unique_keys": [],
      "foreign_keys": [
        { "columns": ["customer_id"], "references": { "schema": "public", "table": "dim_customers", "columns": ["customer_id"] } }
      ],
      "profiled_at": "2026-10-26T12:05:00.000Z",
      "columns": [
        {
          "name": "status",
          "type": "varchar",
          "nullable": false,
          "description": null,
          "profile": {
            "null_fraction": 0,
            "distinct_count": 4,
            "min": null,
            "max": null,
            "top_values": [{ "value": "completed", "count": 8800 }],
            "sampled": false
          }
        }
      ]
    }
  ]
}
```

`method` is one of `live`, `information_schema`, `dbt_manifest`, `ddl`, `manual`. `kind` is one of `table`, `view`, `external`. `schema` is `null` when the source has no schemas. Tables are sorted by qualified name and columns keep their ordinal order. Profiles cover only the tables that were profiled.

## models/<source>/<model>.yaml

```yaml
model: orders
source: warehouse
table: public.fct_orders            # qualified physical name as in the snapshot
status: draft
description: Customer orders, one row per order. Test orders are excluded upstream.
grain: One row per order.
primary_key: [order_id]
tags: []
open_questions:
  - Does "revenue" include shipping?
dimensions:
  - name: order_date
    expr: created_at
    type: time                      # time | string | number | boolean
    time_grains: [day, week, month, quarter, year]   # hour | day | week | month | quarter | year
    description: When the order was placed, UTC.
    synonyms: [order day, purchase date]
    tags: []
    status: draft
  - name: status
    expr: status
    type: string
    description: Order lifecycle state.
    status: draft
measures:
  - name: revenue
    expr: amount_cents / 100.0
    agg: sum                        # sum | count | count_distinct | avg | min | max
    filter: status <> 'cancelled'   # optional SQL predicate over this table's columns
    format: currency                # number | integer | currency | percent
    currency: USD                   # ISO 4217, with format currency
    description: Order value net of discounts, excluding cancelled orders.
    synonyms: [sales, gmv]
    status: approved
    approved_by: Dana Ruiz
    approved_at: 2026-10-26
  - name: order_count
    agg: count                      # count without expr counts rows
    format: integer
    description: Number of orders.
    status: draft
joins:
  - name: customer
    to: customers                   # model in the same source
    keys:
      - { from: customer_id, to: customer_id }
    relationship: many_to_one       # many_to_one | one_to_one | one_to_many
    type: left                      # left | inner
    origin: declared                # declared (a foreign key) | inferred (naming) | owner (stated by the owner)
    description: The customer who placed the order.
    status: draft
    evidence:                       # written by sl check-join
      checked_at: 2026-10-26T12:10:00.000Z
      left_rows: 10000
      left_null_keys: 0
      matched_rows: 9990
      match_rate: 0.999
      right_rows: 2000
      right_key_unique: true
      left_key_unique: false
      max_fanout: 1
      suggested_relationship: many_to_one   # many_to_one | one_to_one | one_to_many | many_to_many
```

`many_to_many` evidence means neither side is unique: the join cannot be modeled directly and needs a bridge table or a pre-aggregated model.

A `one_to_many` join fans out and multiplies the left model's measures. The compiler must aggregate the many side before joining, and the skill flags every such join to the owner.

Joins across sources are invalid in version 1. Federating sources is a separate source with its own engine.

## metrics.yaml

```yaml
metrics:
  - name: average_order_value
    source: warehouse
    type: ratio
    numerator: orders.revenue
    denominator: orders.order_count
    format: currency
    currency: USD
    description: Revenue per order.
    status: draft
  - name: net_revenue
    source: warehouse
    type: derived
    expr: "{orders.revenue} - {refunds.refund_amount}"
    format: currency
    currency: USD
    description: Revenue after refunds.
    status: draft
```

A ratio divides after both sides aggregate. A derived metric's `expr` combines `{model.measure}` placeholders with arithmetic only.

## access.yaml

Access fails closed: a role sees only the models its `allow.models` patterns match, minus its denials.

```yaml
status: draft
default_role: analyst
user_attributes:
  - name: region
    type: string                    # string | number | string_list | number_list
    description: The sales region a rep covers.
roles:
  - name: analyst
    description: Full read access to approved metrics.
    allow:
      models: ["warehouse.*", "lake.*"]
    deny:
      tags: [pii]
  - name: sales_rep
    description: Sees only their own region's orders.
    allow:
      models: ["warehouse.orders", "warehouse.customers"]
    deny:
      fields: [warehouse.customers.email]
    row_filters:
      - model: warehouse.orders
        expr: ship_region = {{ user.region }}
```

- `allow.models` uses the scope pattern syntax over `source.model` names.
- `deny.models`, `deny.fields` and `deny.tags` subtract from what `allow` grants. A tag denial hides every dimension, measure and model carrying that tag.
- A row filter is a SQL predicate over the model's own columns. `{{ user.<attribute> }}` placeholders are bound as query parameters by the compiler, never interpolated into SQL text. A `_list` attribute binds as a list for `IN`.
- Several row filters on one model within a role combine with `AND`. A row filter on a model also applies whenever that model is joined into a query.
- A user holds exactly one role in version 1.

## goldens/<name>.yaml

```yaml
name: revenue_by_month_2025
question: What was revenue by month in 2025?
role: analyst
user: {}
request:
  source: warehouse
  measures: [orders.revenue]
  dimensions: ["orders.order_date:month"]
  filters:
    - { field: orders.order_date, op: gte, value: "2025-01-01" }
    - { field: orders.order_date, op: lt, value: "2026-01-01" }
  order_by: [{ field: "orders.order_date:month", direction: asc }]
  limit: 100
sql: |
  select date_trunc('month', created_at) as order_date_month,
         sum(amount_cents / 100.0) filter (where status <> 'cancelled') as revenue
  from public.fct_orders
  where created_at >= '2025-01-01' and created_at < '2026-01-01'
  group by 1 order by 1
expected:
  tolerance: 0.005                  # relative tolerance for numbers
  rows:
    - { order_date_month: "2025-01-01", revenue: 104233.5 }
reference: Finance monthly close, January to December 2025.
status: approved
confirmed_by: Dana Ruiz
confirmed_at: 2026-10-26
```

A request names fields relative to its `source`: `model.field`, a time dimension with a grain as `model.field:grain`, and metrics by bare name. Filter operators are `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, `is_null`, `not_null`. The `sql` is the query that produced the expected rows. Until a compiler exists, the skill writes it by hand from the YAML, and a golden is the regression test the compiler must later pass.

## Query-plan protocol

Every command that reads a database first builds a query plan:

```json
{ "command": "profile", "source": "warehouse", "dialect": "snowflake",
  "queries": [{ "id": "stats:public.fct_orders", "purpose": "Row and column statistics", "sql": "select ..." }] }
```

For `duckdb` and `postgres` sources the command runs the plan itself. For any source, `--emit-sql` prints the plan as JSON and stops. The agent runs each query with its own tool and saves a results file, a JSON object mapping each query `id` to its array of row objects, then reruns the command with `--results <file>` to finish. Column names in the result rows are lowercase.

## CLI

`bun skills/semantic-layer/scripts/sl.ts <command> [flags]`. Every command takes `--root <dir>` and `--json`. Commands never print secrets and never write outside the semantic root.

| Command | Does |
|---|---|
| `init --name <name>` | Writes `semantic.yaml` and the directory layout. |
| `add-source --name <s> --dialect <d> [--env VAR] [--database path] [--view name=relation]...` | Writes `sources/<s>.yaml`. |
| `introspect --source <s>` | Captures tables, columns, keys and row estimates into the snapshot. Supports `--emit-sql`, `--results`. |
| `import --source <s> --format information_schema\|dbt_manifest\|ddl --file <path>` | Builds the snapshot from shared context instead of a live connection. |
| `tables --source <s> [--groups] [--all]` | Lists tables with size, scope and modeling state; `--groups` clusters them by schema, prefix and suffix and suggests patterns. |
| `scope --source <s> [--include p]... [--exclude p]... [--remove p]... [--clear] [--write]` | Previews the tables a scope change selects; `--write` saves it. |
| `profile --source <s> [--tables t,...] [--refresh]` | Profiles in-scope tables into the snapshot. Supports `--emit-sql`, `--results`. |
| `draft --source <s> [--tables t,...] [--strip-prefix p,...]` | Writes draft models for in-scope tables that have none, with inferred keys and joins. Never overwrites a model. |
| `check-join --source <s> --model <m> --join <j>` | Measures a join's match rate, key uniqueness and fan-out and writes `evidence`. Supports `--emit-sql`, `--results`. |
| `approve --target <ref> --by <name> [--recursive]` | Marks an item approved. `<ref>` is `source.model`, `source.model.field`, `metric:<name>`, `access` or `golden:<name>`. |
| `validate` | Checks structure and references; exits 1 on any error. |
| `status [--source <s>]` | Shows progress per source and the next batch of tables to interview. |
| `run --source <s> (--sql <q> \| --file <path>) [--limit n]` | Runs one read-only query. |
| `goldens run\|confirm\|check [--name <g>] [--by <name>]` | Runs a golden's SQL, records confirmed rows, or rechecks every approved golden. |

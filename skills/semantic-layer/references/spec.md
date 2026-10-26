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
- References use dots. Inside a model's own file, a join's `to` is a bare model name in the same source. Inside `metrics.yaml`, a measure reference is `model.measure`, resolved in the metric's `source`. Inside `access.yaml`, a model reference is `source.model` and a field reference is `source.model.field`. A golden's request names fields relative to its source, as `model.field` (see goldens below).
- Physical column names in `expr`, `filter`, join `keys` and row filters are written as they appear in the snapshot. An `expr`, `filter` or row filter is a SQL expression in the source's dialect. The compiler qualifies columns, so a bare column is a column of the model's own table, and an expression never names a table or a table alias; `<join>.<column>` join references are the only qualified names (see below). A dotted name on one of the model's own columns, or on a lambda parameter such as `x` in `list_filter(items, x -> x.kind = 'a')`, reads a struct field.

### Join references

A dimension `expr` and a measure `filter` may also name a column of a model reached through one of this model's own joins, written `<join name>.<column>`, when that join's `relationship` is `many_to_one` or `one_to_one`. On `orders`, with a `customer` join, `customer.is_test_account`; on `refunds`, with an `order` join, `order.status`, and a dimension `order_date` with `expr: order.created_at`.

- Only one hop: `<join>.<column>` through a join of this model, never through a join of the joined model. To reach further, add a join to this model.
- The compiler adds that join to the query with the join's `type`. A `left` join keeps rows whose target is missing, with the target's columns null, so a filter meant to keep those rows handles null: `coalesce(customer.is_test_account, false) = false`. An `inner` join drops them.
- A measure `expr` stays over the model's own columns, and a row filter over its model's own columns.
- Nothing else outside the model's own table may be named: no other table names, no schema-qualified table names, no subqueries. `sl validate` reports a subquery (`select`, or a parenthesis opening `from` or `table`), a schema-qualified table name or another table's name in an `expr`, `filter` or row filter as an error, and checks that each `<join>.<column>` names a `many_to_one` or `one_to_one` join of the model and, when the snapshot has the target's table, one of its columns. A rule that needs more than a join reference is a join added to the model, or a view the owner creates in the database (the CLI is read-only); a DuckDB source can define one in `connection.views`.

## Time zones

The CLI runs every query with the session time zone UTC, so time grains over `timestamp with time zone` columns bucket in UTC, and goldens are recorded that way. A compiler must run with the same session time zone, or the dimension `expr` converts explicitly, as in `created_at at time zone 'America/New_York'`, which then buckets in that zone for the CLI and a compiler alike. The interview asks which time zone "a day" means for every time dimension, and the dimension's description says it.

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
- An approved measure or metric with `format: currency` has a `currency`; without it validation warns.
- An approved metric references only approved measures.
- An approved join has `evidence` from `sl check-join`; without it validation warns.
- An approved item inside a draft model is allowed; the model's own status says whether the table as a whole is signed off.
- An approved golden whose request uses a draft measure, dimension or metric gets a warning.

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
draft:
  strip_prefixes: [fct_, dim_]   # written by sl draft --strip-prefix; model names drop these prefixes
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
    description: When the order was placed; days, weeks and months are in UTC.
    synonyms: [order day, purchase date]
    tags: []
    status: draft
  - name: status
    expr: status
    type: string
    description: Order lifecycle state.
    status: draft
  - name: customer_region
    expr: customer.region           # a join reference: column region of the model the customer join reaches
    type: string
    description: Home region of the customer who placed the order; blank when the customer is missing.
    status: draft
measures:
  - name: revenue
    expr: amount_cents / 100.0      # over this table's columns only
    agg: sum                        # sum | count | count_distinct | avg | min | max
    # optional SQL predicate over this table's columns and join references
    filter: status <> 'cancelled' and coalesce(customer.is_test_account, false) = false
    format: currency                # number | integer | currency | percent
    currency: USD                   # ISO 4217, with format currency
    description: Order value net of discounts, excluding cancelled orders and test accounts' orders; orders whose customer is missing count.
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
    origin: declared                # declared (a foreign key) | inferred (guessed from names or matching values) | owner (stated by the owner)
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

A metric may combine measures of several models of its source. Each measure aggregates over its own model, and the metric groups by dimensions that exist, with the same name, in every model it uses. So to date refunds by the original order's month, the `refunds` model carries a dimension `order_date` with `expr: order.created_at`, a join reference through its `order` join, and a request groups `net_revenue` by `orders.order_date:month`. `sl validate` errors when a golden groups such a metric by a dimension one of its models lacks.

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
    open_questions:
      - Should a rep see the company-wide total next to their region's?
open_questions:
  - Does finance need a role that sees refunds by customer?
```

- `allow.models` uses the scope pattern syntax over `source.model` names.
- `deny.models`, `deny.fields` and `deny.tags` subtract from what `allow` grants. A tag denial hides every dimension, measure and model carrying that tag.
- `deny.fields` names dimensions and measures only, as `source.model.field`. A join is hidden from a role when its target model is not allowed or is denied for that role; `sl validate` says so when `deny.fields` names a join.
- A row filter is a SQL predicate over the model's own columns, with no join references, subqueries or other tables. `{{ user.<attribute> }}` placeholders are bound as query parameters by the compiler, never interpolated into SQL text. A `_list` attribute binds as a list for `IN`.
- Several row filters on one model within a role combine with `AND`.
- A row filter on the query's base model, the model of its first measure, goes in `WHERE`. A row filter on a joined model goes in that join's `ON` clause: a `left` join keeps the left row with the joined columns blank, and an `inner` join drops it. Were `sales_rep` also to filter `warehouse.customers`, an orders query grouped by `customers.region` would keep the rep's orders whose customer that filter hides, with blank customer columns, because the `customer` join is `left`.
- A user holds exactly one role in version 1.
- `open_questions`, at the top level and on each role, lists access questions still open with the owner; `sl status` counts them with the models' open questions.

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
  select date_trunc('month', o.created_at) as order_date_month,
         sum(o.amount_cents / 100.0)
           filter (where o.status <> 'cancelled' and coalesce(c.is_test_account, false) = false) as revenue
  from public.fct_orders o
  left join public.dim_customers c on c.customer_id = o.customer_id
  where o.created_at >= '2025-01-01' and o.created_at < '2026-01-01'
  group by 1 order by 1
expected:
  tolerance: 0                      # relative tolerance for numbers, agreed with the owner
  rows:
    - { order_date_month: "2025-01-01", revenue: 104233.5 }
reference: Finance monthly close, January to December 2025.
status: approved
confirmed_by: Dana Ruiz
confirmed_at: 2026-10-26
```

A request names fields relative to its `source`: `model.field`, a time dimension with a grain as `model.field:grain`, and metrics by bare name. Filter operators are `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, `is_null`, `not_null`. The `sql` is the query that produced the expected rows. Until a compiler exists, the skill writes it by hand from the YAML, and a golden is the regression test the compiler must later pass. The same rules hold for any tool's request.

Fields on other models:

- A request starts from the model of its first measure: for a metric, the model of the metric's first measure; with no measures, the model of its first dimension.
- A dimension on another model, grouped by or filtered on, and a filtered measure on another model are reached from that model through joins, draft or approved, whose relationship is `many_to_one` or `one_to_one`, at most two hops. The shortest such path is used and must be unique, so a direct join wins over a route through another model. `sl validate` errors when no path exists or when two shortest paths tie. For example, `customers.region` in a request whose first measure is `orders.revenue` is reached through the `customer` join of `orders`.
- A metric that combines several models groups by dimensions that exist, with the same name, in each of them (see metrics.yaml above).

Writing and confirming:

- A draft golden may be written at any phase, for example as soon as the owner offers a trusted figure. Leave `role` and `user` out until `access.yaml` exists; a golden `role` with no `access.yaml` is a validate warning, not an error.
- `sl goldens confirm` records the rows the `sql` returns as `expected` and approves the golden. Confirm only after the request's measures are approved. Before recording, it prints the draft measures, dimensions and metrics the request uses, and `sl validate` warns when an approved golden's request uses any.
- `tolerance` is relative, agreed with the owner and passed as `--tolerance`: 0 for figures finance signs off. Rerunning `goldens confirm` with a new `--tolerance` records the rows again with it. `--force` only lifts the 200-row limit.

## Query-plan protocol

Every command that reads a database first builds a query plan:

```json
{ "command": "profile", "source": "warehouse", "dialect": "snowflake",
  "queries": [{ "id": "stats:public.fct_orders", "purpose": "Row and column statistics", "sql": "select ..." }] }
```

For `duckdb` and `postgres` sources the command runs the plan itself. For any source, `--emit-sql` prints the plan as JSON and stops. The agent runs each query with its own tool and saves a results file, a JSON object mapping each query `id` to its array of row objects, then reruns the command with `--results <file>` to finish. Column names in the result rows are lowercase.

## CLI

`bun skills/semantic-layer/scripts/sl.ts <command> [flags]`. Every command takes `--root <dir>` and `--json`, and `sl <command> --help` prints its usage. Commands never print secrets and never write outside the semantic root. Every command that reads a database (`introspect`, `profile`, `check-join`, `goldens`) takes `--emit-sql` and `--results <file>`. A flag marked `...` repeats, and a repeated `--include`, `--exclude` or `--remove` value may hold several comma-separated globs; a value starting with `re:` is taken whole.

| Command | Does |
|---|---|
| `init --name <name> [--description <text>] [--default-source <s>]` | Writes `semantic.yaml` and the directory layout. |
| `add-source --name <s> --dialect <d> [--env VAR] [--database <path>] [--view name=relation]... [--setup <statement>]... [--description <text>]` | Writes `sources/<s>.yaml`. `--env` is required for postgres and refuses anything that looks like a URL or a credential. |
| `introspect --source <s> [--schemas a,b]` | Captures tables, columns, keys and row estimates into the snapshot. `--schemas` limits it to those schemas, or BigQuery datasets. |
| `import --source <s> --format information_schema\|dbt_manifest\|ddl --file <path> [--catalog <catalog.json>]` | Builds the snapshot from shared context instead of a live connection: an information_schema.columns export as CSV or a JSON array, a dbt `manifest.json` with an optional `catalog.json`, or a `.sql` file of DDL. |
| `tables --source <s> [--groups] [--all]` | Lists in-scope tables, or all with `--all`, with size, modeling and profiling state; `--groups` clusters them by schema, prefix and suffix and suggests patterns. |
| `scope --source <s> [--include <p>]... [--exclude <p>]... [--remove <p>]... [--tables a,b] [--clear] [--write]` | Previews the tables a scope change selects; `--write` saves it. `--tables` adds exact names. |
| `profile --source <s> [--tables t,...] [--refresh]` | Profiles in-scope tables into the snapshot, skipping profiled ones unless `--refresh`. |
| `draft --source <s> [--tables t,...] [--strip-prefix p,...] [--force]` | Writes draft models for in-scope tables that have none, with inferred keys and joins. Never overwrites a model. Refuses more tables than `focus_threshold` without `--tables` or `--force`. `--strip-prefix` is saved as `draft.strip_prefixes`. |
| `check-join --source <s> (--model <m> --join <j> \| --model <m> --all \| --all) [--no-write]` | Measures a join's match rate, key uniqueness and fan-out and writes `evidence`, nothing else. |
| `approve --target <ref> --by <name> [--recursive] [--revoke] [--date YYYY-MM-DD]` | Marks an item approved, or draft again with `--revoke`. `<ref>` is `source.model`, `source.model.field`, `metric:<name>` or `access`; goldens use `goldens confirm`. |
| `validate` | Checks structure and references; exits 1 on any error. |
| `status [--source <s>]` | Shows progress per source, the next batch of tables to interview and the next step. |
| `run --source <s> (--sql <query> \| --file <path>) [--limit <n>]` | Runs one read-only query against a duckdb or postgres source. |
| `goldens run --name <g>` / `goldens confirm --name <g> --by <name> [--tolerance <t>] [--force]` / `goldens check [--name <g>] [--source <s>]` | Runs a golden's SQL, records its confirmed rows, or rechecks every approved golden. `confirm` prints the draft fields the request uses, then records the rows with the tolerance agreed with the owner, passed explicitly (0 for figures finance signs off; without the flag the golden keeps its recorded tolerance, or 0.005); rerunning it with a new `--tolerance` records the rows again. `--force` only lifts the 200-row limit. |

### sl status --json

The skill resumes from this output.

- `settings`: `focus_threshold` and `batch_size`.
- `sources[]`: per source, its dialect, snapshot state, `needs_focus`, model, dimension, measure and join counts by status, joins without evidence and open questions, `draft_models` (the draft models on in-scope tables, which alone hold the interview phase open), `draft_fields` (the draft dimensions, measures and joins of in-scope models, as `model.field`) and `models_with_draft_fields` (approved models that still hold draft fields; the handoff names them).
- `access`: `{ state, roles, open_questions }`: `missing`, `draft` or `approved`, the number of roles, and the open questions of `access.yaml`, top level and per role.
- `open_questions`: the open questions across the reported sources' models and `access.yaml`.
- `next_batch`: `{ source, tables: [{ table, model, model_status, score, reasons }] }`, the next tables to interview, or `null`.
- `next_step`: `{ phase, message, command, source? }`, the first unfinished phase. Phases in order: `add-source`, `introspect`, `scope`, `profile`, `draft`, `interview`, `check-join`, `metrics`, `access`, `verify`, `done`.

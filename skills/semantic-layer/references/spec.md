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
  access.yaml                   access mode, roles, restrictions, row filters, denials
  goldens/<name>.yaml           confirmed question and answer pairs
```

File names equal the name inside the file: `sources/lake.yaml` holds `source: lake`, and `models/lake/web_events.yaml` holds `model: web_events` with `source: lake`.

## Names and references

- Every name (project, source, model, dimension, measure, join, metric, role, restriction, user attribute, golden) matches `^[a-z][a-z0-9_]*$`.
- Model names are unique within a source. Two sources may each have an `orders` model.
- Within one model, dimension, measure and join names share one namespace. Name a join after the role its target plays (`ship_to_region`, `home_region`), never after a column or dimension of the model.
- References use dots. Inside a model's own file, a join's `to` is a bare model name in the same source. Inside `metrics.yaml`, a measure reference is `model.measure`, resolved in the metric's `source`. Inside `access.yaml`, a model reference is `source.model`, a field reference is `source.model.field` and a metric reference in a restriction's targets is `metric:<name>`. A golden's request names fields relative to its source, as `model.field` (see goldens below).
- Physical column names in `expr`, `filter`, join `keys` and row filters are written as they appear in the snapshot. An `expr`, `filter` or row filter is a SQL expression in the source's dialect. The compiler qualifies columns, so a bare column is a column of the model's own table, and an expression never names a table or a table alias; join references, `<join>.<column>` and `<join>.<join>.<column>`, are the only qualified names (see below). A dotted name on one of the model's own columns, or on a lambda parameter such as `x` in `list_filter(items, x -> x.kind = 'a')`, reads a struct field.

### Join references

A dimension `expr`, a measure `filter`, a row filter's `expr` and a hierarchy filter's `column` may also name a column of a model reached through joins, every hop a join whose `relationship` is `many_to_one` or `one_to_one`:

- One hop, `<join>.<column>`, through one of this model's own joins. On `orders`, with a `customer` join, `customer.is_test_account`; on `refunds`, with an `order` join, `order.status`, and a dimension `order_date` with `expr: order.created_at`.
- Two hops, `<join>.<join>.<column>`, through one of this model's joins and then a join of the model it reaches. On `refunds`, `order.customer.is_test_account` goes through `refunds.order` to `orders`, then `orders.customer` to `customers`. Nothing goes further than two hops; to reach further, add a join to this model, or ask the owner for a view.
- The column is a physical column of the last target's table, as in the snapshot, not that model's dimension of the same name. `sl validate` warns when the target has a dimension `<column>` whose expr is not that bare column: the reference reads the column, so a rule the dimension adds (`is_test_account or email like '%@example-test.com'`) is written out over join references where it is meant. The warning is skipped when the field already writes the dimension's whole rule out: every other column the dimension's expr uses also appears in the field as a reference through the same join chain, as `customer.is_test_account or customer.email like '%@example-test.com'`. A dimension that adds a rule over its own column alone, such as `upper(region)`, keeps the warning.
- The compiler adds each hop's join to the query, chained in order, each with its own declared `type`. A `left` join keeps rows whose target is missing, with the target's columns null, so a filter meant to keep those rows handles null: `coalesce(customer.is_test_account, false) = false`. An `inner` join drops them; an `inner` second hop also drops the rows whose first hop found no match.
- A measure `expr` stays over the model's own columns. A row filter's join references start from the filtered model's own joins (see Row filters).
- Nothing else outside the model's own table may be named: no other table names, no schema-qualified table names, no subqueries. `sl validate` reports a subquery (`select`, or a parenthesis opening `from` or `table`), a schema-qualified table name or another table's name in an `expr`, `filter` or row filter as an error, and checks that each hop of a join reference is a `many_to_one` or `one_to_one` join of the model it starts from and, when the snapshot has the last target's table, that the column is one of its columns. A rule that needs more than a join reference, such as an aggregate (a customer's first counted order) or a rule held in another source, is a view the owner creates in the database (the CLI is read-only); a DuckDB source can define one in `connection.views`.

### Definition joins

A join that a measure filter or a dimension expr reads through is part of that field's definition; a join a row filter reads through is part of that row filter. The compiler applies it whenever the field is used, whatever the role may see, and joins it without the target's row filters. It is a join of its own in the query, apart from any join the request uses to reach another model's fields, even when both follow the same declared join. So `revenue`, whose filter reads `customer.is_test_account`, leaves out test accounts for a role that may not see `customers` and for a role whose row filter on `customers` hides some of them; a rule held on a model a role may not see needs no separate model of its own. Role visibility governs only what a request may name (see access.yaml).

## Time zones

The CLI runs every query with the session time zone UTC, so time grains over `timestamp with time zone` columns bucket in UTC, and goldens are recorded that way. A compiler must run with the same session time zone, or the dimension `expr` converts explicitly, as in `created_at at time zone 'America/New_York'`, which then buckets in that zone for the CLI and a compiler alike. The interview asks which time zone "a day" means for every time dimension, and the dimension's description says it.

## Approval

Dimensions, measures, joins, models, metrics, the access file and goldens each carry:

```yaml
status: draft          # draft | approved
approved_by: Dana Ruiz # required when approved
approved_at: 2026-10-26 # ISO date, required when approved
```

Tools only ever write `status: draft`. The `sl approve` command sets `approved`, and the skill runs it only after the owner has explicitly confirmed a plain-English readback of that item. Downstream tools expose only approved items to users (see access.yaml) and flag any draft item they use. `sl approve --revoke` makes an item a draft and removes its `approved_by` and `approved_at`, except on the access file, where it moves them into `last_approved: { by, at }` (see Draft and approved access files).

Approval rules that `sl validate` enforces:

- An approved model has a `grain` and a `primary_key`.
- An approved measure or metric has a `description`.
- An approved measure or metric with `format: currency` has a `currency`; without it validation warns.
- An approved metric references only approved measures.
- An approved join has `evidence` from `sl check-join`; without it validation warns.
- An approved item inside a draft model is allowed; the model's own status says whether the table as a whole is signed off.
- An approved golden whose request uses a draft measure, dimension or metric gets a warning: approve the field after its readback, then run `sl goldens check --name <g>`; if it passes, the recorded rows stand, and only changed rows need a new confirm.

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

A source file never holds a credential. `sl add-source` refuses one, and `sl validate` errors on one in `connection.database`, `connection.setup` or `connection.views`; a DuckDB secret comes from a provider that reads the environment, such as `CREATE SECRET (TYPE s3, PROVIDER credential_chain)`, and a MotherDuck token from `MOTHERDUCK_TOKEN`.

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
        },
        {
          "name": "customer_email",
          "type": "varchar",
          "nullable": true,
          "description": null,
          "profile": {
            "null_fraction": 0.01,
            "distinct_count": 1950,
            "top_values": [{ "value": "sha256:03bcdf026c44eaf4", "count": 14 }],
            "sampled": false,
            "redacted": true
          }
        }
      ]
    }
  ]
}
```

`method` is one of `live`, `information_schema`, `dbt_manifest`, `ddl`, `manual`. `kind` is one of `table`, `view`, `external`. `schema` is `null` when the source has no schemas. Tables are sorted by qualified name and columns keep their ordinal order. Profiles cover only the tables that were profiled.

### Profiles of protected columns

`sl profile` stores no raw values of a protected column; `sl validate` warns about any that remain (an older snapshot, a column tagged later, a profile `sl introspect` or `sl import` carried over). A column is protected when a `pii`- or `sensitive`-tagged field reads it, directly or through a join reference (`customer.email`), when the model over its table is tagged `pii` or `sensitive`, when a model over its table lists it in `ignored_columns`, or when `sensitivityOf` in `scripts/lib/sensitivity.ts` flags it (the name rules `sl draft` tags by, and a text column that is not a key and has a different value on nearly every row, the rule `sl draft` leaves columns out by). For a protected column, `sl profile` writes:

- every `top_values` entry with its `count`, and its `value` as `sha256:` followed by the first 16 hex characters of the SHA-256 of the value's text, lowercased and trimmed (`customer_email` above);
- no `min` and `max` for a text column; a number, date or boolean column keeps them, and its top values are hashed the same way;
- `redacted: true` on the column's profile.

`sl profile --source <s> --redact` rewrites the existing snapshot's profiles of protected columns this way without querying the database, for a column tagged or ignored after it was profiled. `sl validate` warns while a snapshot holds raw top values or a text `min` or `max` for a protected column: "<table>.<column> is protected but the snapshot holds raw sample values; run sl profile --source <s> --redact".

When `sl introspect` or `sl import` replaces a snapshot, it compares the two and prints the changes: tables added and removed, and per table the columns added (with their types), removed and retyped. `--json` carries them as `changes`: `{ tables_added, tables_removed, columns: [{ table, added: [{ name, type }], removed: [name], retyped: [{ name, from, to }] }] }`, or `null` when there was no previous snapshot. Tables and columns match by name, exactly or else ignoring case when that is unambiguous; a type change ignores case and spacing.

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
ignored_columns: [raw_payload]      # columns of the table left out on purpose; sl draft --new-columns skips them
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
    expr: amount_cents / 100.0      # over this table's columns only; cents as an exact amount in postgres
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
      to: customers                 # the target model and keys the check measured
      keys:
        - { from: customer_id, to: customer_id }
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

`dimensions` and `measures` are required keys; write `[]` when a model has none. `joins` may be left out.

`tags` on a model, dimension or measure feed access rules: `pii` and `sensitive` are protected tags, hidden from everyone but the roles that grant them, and a model's tag covers all its fields; `public` records that the owner confirmed everyone may see a field although it looks sensitive (see access.yaml).

`ignored_columns` lists columns of the model's table left out on purpose. `sl draft` writes it for every column it deliberately leaves out of a new model (near-unique strings, and anything else it skips that is not a key or join key). `sl draft --new-columns` and `sl status` skip these columns. `sl validate` warns when an entry is not a column of the table (when the snapshot has it) or is read by a field, a join key, the primary key or another model's join to this one.

When the table changes after the model is written:

- A column is new when no model over the same table reads it (bare column references in exprs and filters, join keys and the primary key) or lists it in `ignored_columns`, so a second, helper model over an already modeled table raises no new columns of its own. `sl status` lists it under the source's `new_columns`, and `sl draft --source <s> --new-columns` drafts it as a new draft dimension or measure by the rules for a new model, sensitivity tags included, with an open question naming the column, its type and its table. A new foreign-key column whose target table is in scope or modeled gets a draft join instead (`origin: declared` from a declared foreign key, `inferred` otherwise). The currency question is asked only when no existing measure of the model has a `currency`. It appends to the model file, leaving comments and approved items byte-identical, and never changes the model's own status.
- A column a field reads that the snapshot no longer has is an error from `sl validate` for an expr that is one bare or quoted column; `sl status` lists such fields under `missing_columns`.

Money stored in cents becomes an exact decimal amount, written per dialect: `amount_cents * 0.01` on duckdb, an exact DECIMAL there, where `amount_cents / 100.0` is a DOUBLE; `cast(amount_cents as numeric) / 100` on bigquery; and `amount_cents / 100.0` on every other dialect. `sl validate` warns on a duckdb measure `expr` that divides by a numeric literal, cast or not (`/ 100::decimal(18, 2)` is a DOUBLE too); integer division (`//`) is not flagged.

`evidence` records the target model (`to`) and the `keys` the check measured. Renaming a join keeps its evidence. When the join's current `to` or `keys` differ from the evidence's, `sl validate` warns that the evidence is stale, and `sl check-join` measures the join again; evidence without `to` and `keys` gets no such warning.

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

`access.yaml` says who sees what. No `access.yaml` means open mode with no roles: everyone sees every approved item. A draft model, dimension, measure or metric is never exposed to anyone in either mode; tools that read the layer flag every draft item they use, and `sl access` reports one hidden with the reason `draft`.

### Draft and approved access files

Tools that serve users apply only an approved `access.yaml`. An access change is edited in version control, on a branch or in the working copy, while the approved version that is deployed keeps applying. A tool that loads an `access.yaml` whose `status` is `draft` serves nothing and says access is awaiting sign-off. It reads the file's state from the evaluator's `access_file` (`missing`, `draft`, `approved` or `invalid`) and, while it is `draft`, refuses every request before checking the names it uses with `checkRequest`. `sl access` still explains a draft file, labelled as a draft, so the owner can read back what it would do; `sl validate` checks a draft file as it checks an approved one. `sl approve --target access --revoke` makes the file a draft again to edit it, and moves its `approved_by` and `approved_at` into `last_approved`, the sign-off of the version still deployed:

```yaml
status: draft
last_approved: { by: Dana Ruiz, at: 2026-10-26 }   # written by sl approve --revoke
mode: open
```

Approving again sets `status: approved` with `approved_by` and `approved_at` and removes `last_approved`. On a draft with `last_approved`, `sl access` labels it: "This explains a draft. The version approved by <by> on <at> keeps applying where it is deployed; tools that load this draft serve nothing." The `access` message of `sl status` ends with that label's second sentence ("The version approved by <by> on <at> keeps applying ..."). A draft without it, a first `access.yaml`, keeps the label that tools serve nothing under it until it is approved. Tell the owner the same when you revoke: the last approved version keeps applying where it is deployed until the new one is approved.

The smallest file, written once the owner has answered the exceptions question ("is there anything some people should not see?") with no:

```yaml
status: draft
mode: open                          # open (the default) | closed
```

A file for a team where most people see everything:

```yaml
status: draft
mode: open
user_attributes:
  - name: department
    type: string                    # string | number | string_list | number_list
    description: The user's department in the identity system.
  - name: employee_id
    type: number
    description: The user's own id; equals rep_id on orders.
  - name: region
    type: string
    description: The sales region a rep covers.
roles:
  - name: hr
    description: People team; may see personal data.
    assign_when: user.department == 'hr'
    allow:
      tags: [pii]                   # protected tags this role may see
  - name: sales
    description: Sales reps and their managers see their own and their team's orders.
    assign_when: user.department == 'sales'
    deny:
      fields: [warehouse.customers.lifetime_value]
    row_filters:
      - model: warehouse.orders
        hierarchy:
          column: rep_id            # column of orders holding a person's id
          via: warehouse.reporting_lines   # closure model: one row per manager and member pair at any depth
          manager: manager_id
          member: member_id
          user: user.employee_id
          include_self: true        # the default
  - name: regional_rep
    description: Contractors, assigned by the identity system, who see only their region's orders.
    row_filters:
      - model: warehouse.orders
        expr: ship_region = {{ user.region }}
  - name: finance_partner
    description: The outside accountants, assigned by the identity system.
restrictions:
  - name: unit_economics
    description: Margin figures stay with finance.
    targets: ["metric:gross_margin*", warehouse.orders.cost]
    allow:
      roles: [finance_partner]
      when: user.department == 'finance'
  - name: board_pack
    description: Board metrics are for finance and executives until they are published.
    targets: ["metric:board_*"]
    allow:
      when: user.department in ['finance', 'executive']
open_questions:
  - Do sales managers need margin by rep?
```

A closed file, where a user sees only what a role they hold allows:

```yaml
status: draft
mode: closed
default_role: analyst
user_attributes:
  - name: region
    type: string
    description: The sales region a rep covers.
roles:
  - name: analyst
    description: Full read access to approved metrics.
    allow:
      models: ["warehouse.*", "lake.*"]
    deny:
      tags: [finance_only]
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

### Modes

- `open` (the default): a user sees every approved model, dimension, measure and metric, minus protected tags, restrictions and the denials of the roles they hold. `allow.models` has no effect; `sl validate` warns when a role sets it. A user who holds no role sees this open baseline with no row filters.
- `closed`: a user sees only the models that `allow.models` of a role they hold matches, minus denials, protected tags and restrictions. Every role needs `allow.models`, and a user who holds no role sees nothing.

### Protected tags

`pii` and `sensitive` are protected in both modes: a model, dimension or measure carrying either tag is hidden unless a role the user holds lists that tag in `allow.tags`. A model's tag covers all its fields. The tag `public` on a field records that the owner confirmed everyone may see it although it looks sensitive; it never overrides `pii` or `sensitive` on the same field. `sl draft` tags the fields it drafts by their columns' names (see the CLI), and `sl validate` warns when an approved field the default audience sees looks sensitive and carries none of the three tags. That check reads the columns the field reads (for a dimension, also the columns it reads through joins) and the field's own name; a `count` or `count_distinct` measure shows no values, so it is not checked.

### Roles

- A user may hold several roles. A role is held when the identity system assigns it by name, or when its `assign_when` condition is true for the user's attributes. `default_role` applies only when the user holds no other role.
- An item is visible when any held role makes it visible.
- `allow.models` (closed mode) uses the scope pattern syntax over `source.model` names. `allow.tags` grants protected tags.
- `deny.models`, `deny.fields` and `deny.tags` subtract from what the role would otherwise see. A tag denial hides every dimension, measure and model carrying that tag, and every metric carrying it.
- `deny.fields` names dimensions and measures only, as `source.model.field`. A join is hidden from a role when its target model is not visible to that role; `sl validate` says so when `deny.fields` names a join.
- Visibility governs only what a request may name. A dimension or measure the user may see still applies the joins its own definition reads through (see Definition joins), so a hidden join never changes a figure. A dimension shows the values it reads, though: `sl validate` warns when a role may see a dimension whose expr reads through a join to a model the role does not see (in closed mode not allowed; in either mode denied, or carrying a protected tag the role does not grant), as `orders.customer_region` would show `customers` values. It warns the same way when the default audience (a user with no attributes and no assigned roles, which in open mode with no roles is everyone) sees such a dimension while a protected tag or a restriction hides the joined model from it. A measure filter only narrows what is counted, so it gets no such warning.

### Conditions

`assign_when` and a restriction's `allow.when` are conditions over user attributes, never SQL:

- Tests: `user.<attr> == 'x'`, `!=`, `<`, `<=`, `>`, `>=` against a quoted text, a number, `true` or `false`; `user.<attr> in ['a', 'b']` and `not in`; `user.<attr> contains 'a'` on a `_list` attribute; `user.<attr> is set` and `is not set`.
- Tests combine with `and`, `or`, `not` and parentheses.
- A test on an attribute the user lacks, or of the wrong type, is false, so a grant fails closed. `in` on a list attribute is true when any element is in the list.
- Every attribute a condition reads is declared in `user_attributes`; `sl validate` errors otherwise, and warns on a test whose outcome the attribute's declared type fixes: one false for every user (`user.level == 'senior'` on a number), or a `not in` list holding no value of that type, which is true for every user who has the attribute.

### Restrictions

A restriction is a grant on metrics and fields. Each target is `metric:<name>`, `source.model` or `source.model.field`, with scope-pattern globs (`metric:finance_*`, `warehouse.payroll.*`). A target is visible only to users who hold one of `allow.roles` or for whom `allow.when` is true; at least one of the two is given. Restrictions apply in both modes after role visibility. `sl validate` errors on an unknown role in `allow.roles` and warns on a target that matches no metric, model or field. Prefer `allow.when` over a role created only to be named in `allow.roles`: such a role also lifts its holders' denials and row filters, and a golden satisfies `allow.when` through its `user`.

A metric is visible only when the metric itself is visible and every measure it uses is visible. A request never names a hidden field or metric anywhere: selected, grouped, filtered or sorted. The compiler refuses such a request; `checkRequest` in `scripts/lib/access.ts` is the reference check, run once the evaluator's `access_file` shows the file is not a draft (see Draft and approved access files).

### Row filters

A row filter is either an `expr` or a `hierarchy`.

- `expr` is a SQL predicate over the model's own columns and join references, `<join>.<column>` or `<join>.<join>.<column>`, through one or two `many_to_one` or `one_to_one` hops that start from the filtered model's own joins, with no subqueries or other tables. The compiler adds the joins it reads through as definition joins, without their targets' row filters. `{{ user.<attribute> }}` placeholders are bound as query parameters by the compiler, never interpolated into SQL text. A `_list` attribute binds as a list for `IN`.
- `hierarchy` is a span-of-control rule: rows whose `column` equals the user's id (when `include_self`, the default) or is a `member` below the user in the closure model `via`, one row per manager and member pair at any depth. `via` is a model of the same source; when the source holds only a `manager_id` column, the owner provides a view that holds the closure. `user` names the attribute holding the user's own id. `column` is a column of the filtered model or a join reference to one, through the same hops as an `expr`: `order_items`, which has no rep column, is filtered with `column: order.sales_rep_id` through its `order` join. The compiler renders it as `column = :user_id OR column IN (SELECT member FROM via WHERE manager = :user_id)`, with the user id bound as a parameter (without `include_self`, only the `IN` part), adds the joins `column` reads through without their targets' row filters, and reads `via` without its own row filters.
- A row filter whose user attribute the user lacks returns no rows of that model. The compiler enforces it, so an `expr` does not test for a missing value.
- Within one role, several row filters on one model combine with `AND`. Across held roles, a user sees the union of what each role allows on a model; a held role with no row filter on that model contributes every row.
- A row filter on the query's base model, the model of its first measure, goes in `WHERE`. A row filter on a model the request joins to reach a field it names goes in that join's `ON` clause: a `left` join keeps the left row with the joined columns blank, and an `inner` join drops it. A definition join never carries a row filter. Were `sales_rep` also to filter `warehouse.customers`, an orders query grouped by `customers.region` would keep the rep's orders whose customer that filter hides, with blank customer columns, because the `customer` join is `left`; `revenue` would still leave out every test account, since its filter reads `customer.is_test_account` through its own definition join.
- A row filter limits only its own model. Rows of a model that joins into it (order lines, refunds, shipments) belong to the filtered rows but are not limited by them. `sl validate` warns when a role has a row filter on model M and may see a model N that reaches M through one or two to-one joins but has no row filter of its own for that role: "rows of N that belong to M are not limited by M's row filter for role R; add a row filter on N (it may read <join>.<column>), deny N to R, or record why in the role's open_questions". The role may not see N when its own rules hide N, or a restriction targets N whose `allow.roles` leaves R out and that has no `allow.when`. An entry of the role's `open_questions` naming N silences the warning.

### Checking access

`sl access` explains what one user sees: the roles they hold and why, every hidden model, field and metric with its reason (`draft`, `protected_tag:<tag>`, `denied:<role>`, `restricted:<name>`, `not_allowed`), and the row filters that apply per model with their bound attribute values, displayed and never interpolated into SQL, or `no rows` when an attribute is missing. With no `--user` and no `--roles` it explains the default audience: a user with no attributes and no assigned roles. A draft `access.yaml` is explained as written and labelled as a draft (see Draft and approved access files for the label with `last_approved`).

Its plain output:

- The user line names the attributes, and adds the `assigned roles` clause only when `--roles` was given.
- The totals line reads "Items visible across N source(s) (row filters limit rows, not these counts): ...", and each source's line gives that source's counts.
- Each source's row filters section is always printed, as "row filters: none (every row of every visible model)" when none applies.

`scripts/lib/access.ts` holds the evaluator (`evaluateAccess(root, user)`, `checkRequest(visibility, request)`) that a compiler reuses; a compiler serves nothing while the evaluator's `access_file` is `draft`.

`open_questions`, at the top level and on each role, lists access questions still open with the owner; `sl status` counts them with the models' open questions.

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
confirmed_as: { role: analyst } # written by sl goldens confirm: the role and user it ran as
```

A request names fields relative to its `source`: `model.field`, a time dimension with a grain as `model.field:grain`, and metrics by bare name. `measures` lists measures as `model.measure` and metrics by bare name, as in `measures: [orders.revenue, average_order_value]`; there is no `metrics` key, and `sl validate` says so when a request has one. Filter operators are `eq`, `neq`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `between`, `is_null`, `not_null`. The `sql` is the query that produced the expected rows. Until a compiler exists, the skill writes it by hand from the YAML, and a golden is the regression test the compiler must later pass. The same rules hold for any tool's request.

Fields on other models:

- A request starts from the model of its first measure: for a metric, the model of the metric's first measure; with no measures, the model of its first dimension.
- A dimension on another model, grouped by or filtered on, and a filtered measure on another model are reached from that model through joins, draft or approved, whose relationship is `many_to_one` or `one_to_one`, at most two hops. The shortest such path is used and must be unique, so a direct join wins over a route through another model. `sl validate` errors when no path exists or when two shortest paths tie. For example, `customers.region` in a request whose first measure is `orders.revenue` is reached through the `customer` join of `orders`.
- A metric that combines several models groups by dimensions that exist, with the same name, in each of them (see metrics.yaml above).

Writing and confirming:

- A draft golden may be written at any phase, for example as soon as the owner offers a trusted figure. Leave `role` and `user` out until `access.yaml` exists; a golden `role` with no `access.yaml` is a validate warning, not an error.
- A draft golden may name a measure, dimension, metric or model that does not exist yet, so the owner's figure is recorded before its measure is: `sl validate` warns. In an approved golden it is an error.
- The `sql` applies each measure exactly as the model writes it. `sl validate` warns on `round(` in a golden's `sql`, since `round()` hides float noise. That warning never stands, whatever the golden's `reference` says, and neither does the warning on a duckdb measure that divides by a numeric literal: fix both. Once `round()` is removed, `sl goldens check` fails on rows recorded rounded until the owner says yes to the unrounded figure and it is confirmed again.
- A ratio compared with a report figure rounded to cents: show the unrounded value next to the report figure, agree with the owner that they match, and write the rounding in `reference` ("report shows $134.46; the layer gives 134.4577, the same figure before rounding"). `tolerance` guards drift between runs of the layer, not rounding.
- `sl goldens confirm` records the rows the `sql` returns as `expected`, records the role and user the golden runs as in `confirmed_as`, and approves the golden. Confirm only after the request's measures are approved. Before recording, it prints the draft measures, dimensions and metrics the request uses, and `sl validate` warns when an approved golden's request uses any. Once such a field is approved after its readback, `sl goldens check --name <g>` reruns the golden: if it passes, the recorded rows stand, and only changed rows need a new confirm.
- `tolerance` is relative, agreed with the owner and passed as `--tolerance`: 0 for figures finance signs off. It guards drift between runs, not rounding. Rerunning `goldens confirm` with a new `--tolerance` records the rows again with it. `--force` only lifts the 200-row limit.

Goldens and access:

- A golden runs as its `role` and `user`; with no `role`, as the user its `user` describes, who holds every role whose `assign_when` its attributes meet, `default_role` when no other role applies, or else is the default audience. `sl validate` checks every golden's request with `checkRequest` in `scripts/lib/access.ts` as that user, taking every model, field and metric as approved and `access.yaml` as approved (draft items have their own warnings): each place the request names a field or metric that user may not see is an error in an approved golden and a warning in a draft one. A golden whose `role` is unknown, or an `access.yaml` with errors, is not checked this way until it is fixed.
- A golden that runs as a role is confirmed after `access.yaml` is approved, or rechecked with `sl goldens check --name <g>` and read back after every change to that role. `sl goldens confirm` warns when the golden's role is defined only in a draft `access.yaml`. A golden confirmed as a role while `access.yaml` was a draft stays valid once access is approved when its `role` and `user` are unchanged and `sl goldens check` passes.
- A golden may have no measures: it starts from the model of its first dimension. That is how a row-filtered model with no measures of its own, such as order lines limited through their order, is covered as the role that filters it.
- `sl validate` warns when a golden's `role` or `user` differ from its `confirmed_as`: what it pins changed, so write that role's row filters into the `sql`, run `sl goldens check --name <g>`, read the change back and confirm again on the owner's yes. No `user` and an empty `user` are the same; a golden without `confirmed_as` gets no such warning.

Personal values:

- Never quote a value of a column a `pii` or `sensitive` field reads (a name, an email) in a description, a synonym or a golden's `question` or `reference`; use the id or a count. `sl validate` warns when a description or synonym of a model, field, join or metric, a description in `access.yaml`, or a golden's `question` or `reference` contains a top value from the snapshot profile, of at least 3 characters and matched as a whole word in any case, of a column that a `pii`- or `sensitive`-tagged field reads. A field tagged only through its model counts only the columns it reads that look personal or sensitive by the rules `sl draft` tags by, so the values of a model's `status` or `region` column are not flagged.
- The check also reads hashed top values (see Profiles of protected columns): it hashes every run of 1 to 4 consecutive words of the checked text, lowercased and trimmed, as `sl profile` hashes a value, and compares them with the hashed values, so a quoted name is still caught.
- A golden's `expected.rows` are not checked: they are the answer as the golden's role, which may see the column.
- Replacing a personal value with an id in an approved golden's `question` or `reference` changes no figure and needs no new confirm: edit it and run `sl goldens check`.

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
| `introspect --source <s> [--schemas a,b]` | Captures tables, columns, keys and row estimates into the snapshot. `--schemas` limits it to those schemas, or BigQuery datasets. Prints what changed since the previous snapshot; `--json` adds it as `changes` (see snapshots). Its next hint is `sl profile --source <s>` only when some in-scope table is not profiled; otherwise `sl validate` when modeled tables changed, or `sl status`. |
| `import --source <s> --format information_schema\|dbt_manifest\|ddl --file <path> [--catalog <catalog.json>]` | Builds the snapshot from shared context instead of a live connection: an information_schema.columns export as CSV or a JSON array, a dbt `manifest.json` with an optional `catalog.json`, or a `.sql` file of DDL. Prints and reports `changes` as `introspect` does. |
| `tables --source <s> [--groups] [--all]` | Lists in-scope tables, or all with `--all`, with size, modeling and profiling state; `--groups` clusters them by schema, prefix and suffix and suggests patterns. A table is profiled (`yes`) when its `profiled_at` is set, `partial` when some columns have profiles but `profiled_at` is missing (a reintrospect added or retyped columns), and otherwise `no`; `--json` carries it as `profile_state`. |
| `scope --source <s> [--include <p>]... [--exclude <p>]... [--remove <p>]... [--tables a,b] [--clear] [--write]` | Previews the tables a scope change selects; `--write` saves it. `--tables` adds exact names. |
| `profile --source <s> [--tables t,...] [--refresh]` | Profiles in-scope tables into the snapshot, skipping profiled ones (`profiled_at` set) unless `--refresh`. Stores no raw values of a protected column: its top values are hashed, a text column's `min` and `max` are left out, and its profile carries `redacted: true` (see Profiles of protected columns). |
| `profile --source <s> --redact` | Rewrites the existing snapshot's profiles of protected columns that way, without querying the database. |
| `draft --source <s> [--tables t,...] [--strip-prefix p,...] [--force]` | Writes draft models for in-scope tables that have none, with inferred keys and joins. Never overwrites a model. Refuses more tables than `focus_threshold` without `--tables` or `--force`. `--strip-prefix` is saved as `draft.strip_prefixes`. Tags a field `pii` when its column's name looks like personal data and `sensitive` when it looks like pay, banking, card, health, credential or free-text data, each with an open question. Leaves out a string column that is not a key and has a different value on nearly every row (more than 90% distinct over at least 50 rows), with an open question, and lists every column it leaves out in `ignored_columns`. A table of 2 or 3 columns whose names all end in `_id`, such as a closure or bridge table, gets every column as a dimension, `primary_key` all of them and no `count_distinct` measures, with an open question asking the owner to confirm each combination appears once. |
| `draft --source <s> --new-columns [--tables t,...]` | For each existing model on an in-scope table (or on `--tables`), drafts every new column (one no model over the same table reads or lists in `ignored_columns`) as a new draft dimension or measure, by the rules for a new model, with an open question "New column <c> (<type>) appeared in <table>; ...". A new foreign-key column whose target table is in scope or modeled becomes a draft join (`origin: declared` or `inferred`) instead of being left out; the currency question is asked only when no existing measure of the model has a `currency`. Appends to the model file, keeping comments and approved items byte-identical, and never changes the model's status; works whatever `focus_threshold`. `--json`: `{ source, updated: [{ model, added: [field names], skipped: [{ column, reason }] }] }`. |
| `check-join --source <s> (--model <m> --join <j> \| --model <m> --all \| --all) [--no-write]` | Measures a join's match rate, key uniqueness and fan-out and writes `evidence`, nothing else. |
| `approve --target <ref> --by <name> [--recursive] [--revoke] [--date YYYY-MM-DD]` | Marks an item approved, or draft again with `--revoke`. `<ref>` is `source.model`, `source.model.field`, `metric:<name>` or `access`; goldens use `goldens confirm`. `--revoke` on `access` moves `approved_by` and `approved_at` into `last_approved: { by, at }`; approving it again removes `last_approved`. |
| `validate` | Checks structure and references, and errors on a credential in a duckdb source's `connection.database`, `connection.setup` or `connection.views`, naming the key, never the value; exits 1 on any error. Warns when an approved field the default audience sees looks sensitive and carries no `pii`, `sensitive` or `public` tag: "<field> is visible to everyone and looks sensitive (<reason>); tag it pii or sensitive, or tag it public if everyone may see it", where a reason found on a column the field reads starts "it reads column <c>; ". Checks every golden's request against access as the user it runs as, warns on a role's row-filtered model whose child models it does not limit (see Row filters), on text that quotes a value of a pii or sensitive column, raw or hashed (see goldens), and on a snapshot holding raw sample values of a protected column (see Profiles of protected columns). |
| `access [--user <json object of attributes>] [--user-file <path>] [--roles r1,r2] [--show visible\|hidden\|all]` | Explains what one user sees: the roles they hold and why (`assigned`, `condition`, `default`), and per source the visible and hidden models, fields and metrics with the reason each is hidden, and the row filters per model with their bound attribute values or `no rows` (see access.yaml). With no `--user` and no `--roles`, the default audience. A draft `access.yaml` is explained and labelled as a draft, naming the version that keeps applying when it has `last_approved`. Human output shows each source's visible counts on its own line under the totals line "Items visible across N source(s) (row filters limit rows, not these counts): ...", always prints each source's row filters section ("row filters: none (every row of every visible model)" when there are none), names assigned roles only when `--roles` was given, and shows hidden items by default; `--json` carries everything. |
| `status [--source <s>]` | Shows progress per source, the next batch of tables to interview and the next step. |
| `run --source <s> (--sql <query> \| --file <path>) [--limit <n>]` | Runs one read-only query against a duckdb or postgres source. Every row is counted and at most `--limit` rows, 100 by default, are shown. |
| `goldens run --name <g>` / `goldens confirm --name <g> --by <name> [--tolerance <t>] [--force]` / `goldens check [--name <g>] [--source <s>]` | Runs a golden's SQL, records its confirmed rows, or rechecks every approved golden. `confirm` prints the draft fields the request uses, then records the rows with the tolerance agreed with the owner, passed explicitly (0 for figures finance signs off; without the flag the golden keeps its recorded tolerance, or 0.005); rerunning it with a new `--tolerance` records the rows again, and it records `confirmed_as` and warns when the golden's role is defined only in a draft `access.yaml`. `--force` only lifts the 200-row limit. `run` and `confirm` display a measure or metric with `format: currency` to two decimals; the recorded rows keep the values the SQL returns. |

### sl status --json

The skill resumes from this output.

- `settings`: `focus_threshold` and `batch_size`.
- `sources[]`: per source, its dialect, snapshot state, `needs_focus`, `unprofiled_tables` (the in-scope tables that are not profiled by the rule `sl tables` uses: `profiled_at` is not set) and `partially_profiled_tables` (those of them some of whose columns carry a profile), model, dimension, measure and join counts by status, joins without evidence and open questions, `draft_models` (the draft models on in-scope tables, which alone hold the interview phase open), `draft_fields` (the draft dimensions, measures and joins of in-scope models, as `model.field`), `models_with_draft_fields` (approved models that still hold draft fields; the handoff names them), `new_columns` (`[{ model, column, type }]`: columns of the tables under in-scope approved or draft models that no field, join key or primary key of any model over the same table reads and no such model lists in `ignored_columns`) and `missing_columns` (`[{ model, field, column }]`: columns fields read that the snapshot no longer has).
- `draft_metrics`: the names of the metrics in `metrics.yaml` that are not approved, one per metric `metrics.draft` counts; an entry without a name goes by its place in the list, as `metrics[1]`.
- `access`: `{ state, roles, restrictions, open_questions, mode, default_audience, last_approved? }`: `missing`, `draft` or `approved`, the number of roles, the number of restrictions, the open questions of `access.yaml`, top level and per role, the mode (`open` without `access.yaml`), and what the default audience sees, as `{ models, fields, metrics, hidden_by_protected_tags }`: the visible counts and the number of approved items a protected tag hides from it. The human output names the mode and the default audience in one line. `last_approved` (`{ by, at }`) is present while the draft records the approval `sl approve --revoke` set aside, and the access message then says what `sl access` says: the version approved by <by> on <at> keeps applying where it is deployed, and tools that load the draft serve nothing.
- `open_questions`: the open questions across the reported sources' models and `access.yaml`.
- `next_batch`: `{ source, tables: [{ table, model, model_status, score, reasons }] }`, the next tables to interview, or `null`.
- `draft_goldens`: the names of the goldens that are not approved, one per golden `goldens.draft` counts (the name in the file, or its file name); an empty golden file is neither counted nor listed.
- `roles_without_goldens`: the roles in `access.yaml` that no approved golden runs as; a golden with no `role` runs as `default_role`. Any such role holds `next_step` in `verify` until a golden that runs as it is written and confirmed.
- `row_filter_joins_without_goldens`: `[{ role, model, filtered_model, join }]`, for each role, each model visible to it that reaches one of the role's row-filtered models through a to-one join of one or two hops (`model` and `filtered_model` as `source.model`; `join` the chain of join names from `model`, as a join reference writes it: `order`, or `order.customer`), when no approved golden running as that role names a field of that model. The human output names them in one line, and the handoff names each one.
- `next_step`: `{ phase, message, command, source?, after_owner_yes, blocked_on? }`, the first unfinished phase. `after_owner_yes` is true when `command` is an `sl approve` or `sl goldens confirm`, which runs only after the owner says yes to its readback. Phases in order: `add-source`, `introspect`, `drift`, `scope`, `profile`, `draft`, `interview`, `check-join`, `metrics`, `access`, `verify`, `done`. `drift` holds while an approved field reads a column the snapshot no longer has: the table changed, so the affected items are read back to the owner. New columns route to `draft`, with the command `sl draft --source <s> --new-columns`. `access` holds until `access.yaml` exists and is approved: without it, `next_step` asks the owner the exceptions question ("is there anything some people should not see?"); while `access.yaml` has open questions, `next_step` is `{ phase: access, blocked_on: "open_questions", command: "sl access", after_owner_yes: false }` and its message says the step waits on the owner's answers and names the first question; an approved `access.yaml` in open mode with no roles is complete. `verify` holds until there are 5 approved goldens and every role has one. `done` means the phases the CLI can measure are complete; it is reachable with draft metrics, goldens and fields the owner deferred, and its message names each of them and ends by asking for the coverage checklist in `verification.md` to be ticked before the handoff.

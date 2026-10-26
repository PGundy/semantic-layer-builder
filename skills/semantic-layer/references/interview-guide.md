# Interview guide

The interview turns measured facts into agreed meaning. You bring the facts (from the snapshot profile and the draft model); the owner supplies what they mean. Work through `next_batch` from `sl status --json`, one table at a time, and write every answer into `models/<source>/<model>.yaml` as soon as you hear it. Owner priorities override `next_batch`: when the owner named topics or tables to do first (revenue, then refunds, then the lake), order by those and use `next_batch` only to fill a batch; for a source the owner put first, read `sl status --source <s> --json`, whose `next_batch` covers that source alone.

Every example below (status values, which statuses count, test-account rules, column names, time zones) is illustrative. None is a default for the owner's business: their data and their answers decide.

## Before each table

Read the draft model and the table's profile in `snapshots/<source>.json` (each column's `profile`, at `tables[].columns[].profile`): row count, each column's `null_fraction`, `distinct_count`, `min`, `max` and `top_values`, declared and inferred keys. Pick the handful of columns that raise a question. Do not walk through every column: an `id` that is unique and never empty, or a `created_at` that obviously means creation time, needs no question unless it matters for a measure.

`sl draft` writes some guesses that each need a yes before they stand, and each comes with an open question:

- a `grain` copied from "one row per ..." in the table comment, with the first open question a confirmation ("Is one row of fct_orders one order?");
- a money column named `*_cents` or `*_pennies`, or described as cents, drafted as an exact division by 100 with `format: currency`: `<col> * 0.01` on duckdb (an exact decimal; `/ 100.0` is a double there and its sums carry float noise, so `sl validate` warns on a duckdb measure `expr` that divides by a numeric literal; a cast divisor such as `/ 100::decimal(18, 2)` is still a double there, so multiply instead), `cast(<col> as numeric) / 100` on bigquery, and `<col> / 100.0` on every other dialect;
- `currency` taken from a `currency` column that holds one value only;
- per-unit prices (`unit_price`, `price`, `unit_cost`, `list_price`, `*_rate`) drafted as `avg`, never `sum`, and, when the table has a quantity column, a draft `line_total` measure (sum of quantity times price);
- a count per foreign key named after its join (`customer_count`), left out when the target table has 20 rows or fewer;
- additive counts (`impressions`, `clicks`, `views`, `visits`, `sessions`, `signups`, `conversions`, `installs`, `opens`, `events`, `pageviews`, `sends`) drafted as `sum` with `format: integer`; any other number with no unit in its name is drafted as `avg`, with an open question asking whether people total or average it;
- time dimensions named after their column (`created_at`). Rename each to the business name of that date (`order_date`) before its readback, and use the same name in every model a metric combines (`orders.order_date` and `refunds.order_date`).

A model's `dimensions` and `measures` keys are required; write `[]` when a model has none.

Confirm each guess in the readback, fix it when it is wrong, and remove an open question once the owner has answered it.

## Question bank

Ask in this order, skipping what the facts already settle.

| Topic | Ask |
|---|---|
| What one row is | "Each row in `fct_orders` seems to be one order: 10,000 rows, and `order_id` is different on every row. Is that right, or can one order appear more than once?" |
| Which columns matter | "Which of these do people actually report on? I see `amount_cents`, `discount_cents`, `shipping_cents`, `tax_cents`." |
| Business terms and synonyms | "What do people call this number? Revenue, sales, GMV, bookings? Do any of those mean something different?" Write only the names the owner gives or confirms, and read each one back. |
| Status values that count | "`status` is `completed` in 8,800 rows, `cancelled` in 700, `refunded` in 300, `pending` in 200. Which ones count as a real sale?" |
| Filters and test data | "I see 42 orders where `source` is `qa_script`. Should those always be left out?" |
| Rules held on another table | "Test accounts are flagged in `customers.is_test_account`. Should orders from those accounts be left out of every order figure? And 12 orders point at a customer that no longer exists: keep them?" |
| Units | "`amount_cents` goes from 199 to 1,250,000. Is that cents, so $1.99 to $12,500? Which currency?" |
| Time zones, timestamp with a time zone | Ask for every time dimension: "`created_at` is stored as an exact moment. When someone says 'orders on March 3rd' or 'March revenue', which time zone is that day or month in: UTC, or the business's local time (which zone)?" |
| Time zones, timestamp without a time zone | "`created_at` has no time zone. Is it recorded in UTC or in local time? And when people say 'a day', which zone do they mean?" |
| Which date is "the" date | "There's `created_at`, `paid_at` and `shipped_at`. When someone says 'orders in March', which one do they mean?" |
| Sensitive columns | "`email`, `phone` and `shipping_address` identify people. Should most users be unable to see them?" |
| Empty values | "`coupon_code` is empty in 92% of rows. Does empty mean no coupon was used?" |
| Ownership | "If a number looks wrong, who would know the answer? Anything you're unsure of, I'll note as an open question for them." |

Settle the time zone before the dimension's readback; do not park it as an open question when the owner is there to answer.

## Suggestions

Offer a suggestion with every item, because owners confirm faster than they compose. A suggestion about a fact (a unit, a key, what empty means) can be stated plainly. A suggestion about a business rule (which statuses count, which date is "the" date, how a new customer is defined, how refunds are dated) is a guess: label it so and ground it in a profile fact.

> "My guess, since `pending` orders are under 2% and none has a `paid_at`: revenue counts `completed` only. Which statuses should count?"

Never invite blanket acceptance ("say 'all OK' if these look right") on business-rule items. The readback with real totals is the gate for each one.

## Turning profile facts into questions

Always quote real values and counts; never ask an abstract question when the profile can make it concrete.

- **Top values** become "which of these count?" questions. Show the values with counts, in order. If there are more than `top_values` distinct values, say so: "and 40 rarer ones".
- **Null rates** become "what does empty mean?" questions. A key column that is sometimes empty is worth asking about: "1.2% of orders have no `customer_id`. Are those guest checkouts?"
- **Candidate keys** become "is each row one X?" questions. A column with as many distinct values as rows and no empties is a likely key; a pair of columns may be the key when neither alone is.
- **Min and max** expose units and bad data: dates in 1970 or 2099, negative amounts, a maximum far above the rest.
- **Low distinct counts** on text columns suggest a category dimension; ask if the values need friendlier labels.
- **Columns that look alike** (`amount`, `amount_usd`, `amount_local`) get one question: "which one should totals use?"

## Recording answers in model YAML

Edit the model file in place with your file-editing tool, keep comments and order, and write status only as `draft`. Field formats are in `spec.md`.

What one row is, and the key:

```yaml
description: Customer orders placed on the web store, one row per order.
grain: One row per order.
primary_key: [order_id]
```

A measure with the agreed filter, unit and synonyms (the statuses are an example, not a default):

```yaml
measures:
  - name: revenue
    expr: amount_cents / 100.0       # a postgres source; on duckdb amount_cents * 0.01
    agg: sum
    filter: status <> 'cancelled' and source <> 'qa_script'
    format: currency
    currency: USD
    description: Order value in dollars after discounts, leaving out cancelled orders and test orders. Shipping and tax are not included.
    synonyms: [sales, gmv]
    status: draft
```

The date that counts, with its time zone. The CLI runs every query in UTC, so a bare `created_at` on a timestamp-with-time-zone column buckets days and months in UTC; when the owner's day is local, convert in the `expr`:

```yaml
dimensions:
  - name: order_date
    expr: created_at                 # UTC days; for New York days: created_at at time zone 'America/New_York'
    type: time
    time_grains: [day, week, month, quarter, year]
    description: When the customer placed the order, with days and months in UTC. This is the date for "orders in March".
    status: draft
```

A sensitive column:

```yaml
  - name: email
    expr: email
    type: string
    description: Customer email address.
    tags: [pii]
    status: draft
```

Anything not settled:

```yaml
open_questions:
  - Do refunded orders count toward revenue in the monthly board report? Owner to check with Finance (Sam).
```

### Rules that depend on a related table: join references

A rule often lives on another table: test accounts are flagged on customers but must be left out of order revenue, or only refunds of counted orders count. Write it as a join reference, `<join name>.<column>`, where the join is one of this model's own joins with `relationship: many_to_one` or `one_to_one`, and the column is a physical column of the joined model's table. A rule two joins away is `<join>.<join>.<column>`, where the second join is a join of the model the first reaches, also many_to_one or one_to_one. A dimension `expr` and a measure `filter` may use join references; a measure `expr` stays over the model's own columns.

A join reference reads a physical column of the target's table, not the target model's dimension of the same name: when `customers` has a dimension `is_test_account` with `expr: is_test_account or email like '%@example.com'`, `customer.is_test_account` still reads the bare column, and `sl validate` warns. Write the full rule in the filter over join references, `coalesce(customer.is_test_account, false) = false and coalesce(customer.email, '') not like '%@example.com'`: once the field names every column the dimension's `expr` uses through the same joins, it writes the dimension's whole rule out and `sl validate` skips the warning. The warning stays while the filter names that column without the rest of the rule. `sl validate` checks only that the columns are named, not the rule; read the written-out filter back against the dimension's `expr`. When the bare column is what the owner means, say in the field's `description` that it reads the column on purpose, so the warning stands with its reason. Writing the rule out is a supported construct, so do not ask engineering for a column that holds it.

Worked example: leave orders from test accounts out of revenue, and keep orders whose customer row is missing (deleted accounts). The flag is `is_test_account` on `dim_customers`, which the `orders` model reaches through its `customer` join:

```yaml
joins:
  - name: customer
    to: customers
    keys:
      - { from: customer_id, to: customer_id }
    relationship: many_to_one
    type: left                       # keeps orders with no matching customer
    status: draft
measures:
  - name: revenue
    expr: amount_cents / 100.0
    agg: sum
    filter: status <> 'cancelled' and coalesce(customer.is_test_account, false) = false
    format: currency
    currency: USD
    description: >-
      Order value in dollars, leaving out cancelled orders and orders from test accounts
      (flagged on the customer). Orders whose customer no longer exists are kept.
    status: draft
```

The compiler adds the `customer` join with its declared `type`. On a `left` join an order with no matching customer has an empty `customer.is_test_account`, so a filter meant to keep those orders handles null: `coalesce(customer.is_test_account, false) = false`. Written as `customer.is_test_account = false`, it would drop them. Ask the owner which they want, with the count from the join's evidence ("12 orders point at a customer that no longer exists"), and say it in the readback.

The same pattern covers a refunds rule. On `refunds`, with a `many_to_one` join `order` to `orders`, `filter: order.status <> 'cancelled'` counts only refunds of orders that revenue counts as long as revenue's rule reads only orders' own columns. When revenue also leaves out test accounts through `customer.*`, the refunds filter follows the rule two hops away, `<join>.<join>.<column>`, through `refunds.order` and then `orders.customer`:

```yaml
filter: order.status <> 'cancelled' and coalesce(order.customer.is_test_account, false) = false
```

The compiler chains the joins, each with its own declared `type`. When both hops are `left`, a refund whose order or customer is missing reads null at the end, so handle null as above. An `inner` hop drops such refunds instead, and an `inner` second hop also drops refunds whose order is missing; read that consequence back.

A join a measure filter or dimension `expr` reads through is part of that field's definition. The compiler applies it whenever the field is used, whatever the role may see, and joins it without the target's row filters, so a sales rep's row filter on `customers` never blanks `customer.is_test_account` inside revenue. No helper model is needed to keep a row filter away from a rule. Role visibility governs only what a request may name (`access.md`).

Limits, which `sl validate` enforces:

- At most two hops: `<join>.<column>` or `<join>.<join>.<column>`, where each hop is a join of the model it starts from. A rule further away needs a join of its own on the model or a view.
- Only many_to_one and one_to_one joins, on every hop: a `one_to_many` join repeats rows.
- No subqueries and no table or schema names in `expr` or `filter`; validate reports an error that points to join references. A rule that needs an aggregate (a customer's first counted order, a running total) or another source cannot be written with a join reference. It needs a view or table the owner's engineers create (on Postgres and the warehouse dialects that is the only route; a DuckDB source can define the view in `connection.views`), or, across sources, a federating source. Say so early, record an open question with the exact definition and any figure the owner gave ("New customers: customers whose first counted order falls in the period; 123 in 2025 per the Finance pack"), and write a draft golden for the figure (`verification.md`). The CLI never writes to the owner's database.
- Ask engineering for a column or view only when no supported construct (a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source) can express the rule. When one can, write the rule with it; where the CLI still falls short (a warning that does not fit the case, a check it cannot run yet), keep the rule, wait for the tool, and say so in the next message and in the handoff, and write in the field's `description` why its warning stands.
- Check every join on the path with `sl check-join` and read it back before you read back a measure that relies on it (`joins.md`).

### Dimensions through joins

A dimension can also come from a joined table. To date refunds by the original order's month, the refunds model carries:

```yaml
  - name: order_date
    expr: order.created_at
    type: time
    time_grains: [day, week, month, quarter, year]
    description: When the refunded order was placed, in UTC. Net revenue dates refunds by this date.
    status: draft
```

A metric that combines measures of several models (`net_revenue` = orders revenue minus refunds) groups only by dimensions that exist with the same name in every model it uses, so give such dimensions the same name in each model (`order_date` on both) and approve each. Give the joined dimension the same conversion as the original (`order.created_at at time zone 'America/New_York'` when `orders.order_date` converts), so both sides bucket the same way.

Rules of thumb:

- A filter that applies to every use of the table (test data, soft-deleted rows) goes in each measure's `filter` and in the model `description`, so readers and tools both see it.
- Units go in `expr` (cents as `<col> * 0.01` on duckdb, `cast(<col> as numeric) / 100` on bigquery, `<col> / 100.0` elsewhere) and `format`/`currency`, and the description says the unit in words.
- When the owner agrees a rule for one measure (leave out test accounts, count completed orders only), ask in the same round trip whether it applies to every other measure of the model, drafted counts included, and to related models' measures (refunds of counted orders). Record each answer as a `filter` or as an open question.
- A known caveat on an approved item (a period known to be wrong, a segment it does not cover) goes into that item's own `description`, not only into `open_questions`, so a tool serving the figure carries the warning: "Counts from 2024 include 12 deleted test accounts and read about 10% high."
- Remove a drafted dimension or measure the owner says is meaningless, or leave it as draft with a description saying why; never approve it to tidy up. Fix or remove a draft measure you know gives a wrong number (a sum of unit prices), even in a table the owner defers. Removing a drafted field is a hand edit of the model file: delete its entry, then run `sl validate`, which names what still uses it. Removing a measure also removes the draft metrics and goldens that use it; `sl validate` names them.
- A formula the owner never stated is an open question, not a description: write a description only from what the owner said or confirmed in a readback. For a metric across sources with a side that cannot exist yet (its column or view is missing), record the owner's formula on the measure that exists and an open question on the other model naming the missing column or view, or, when that model does not exist yet, on the existing measure's model and in the handoff.
- Add a measure the owner names that the draft missed, with `status: draft`, then read it back.
- Record a disagreement, or a hedge on a definition, as an open question with a name next to it; a hedge on a measured fact goes in the description (Readback templates). Delete an open question once it is answered, and write the answer where it belongs.

## Goldens during the interview

When the owner offers a figure they trust ("2025 revenue was $1,204,330.50 in the close"), or ties a sign-off to matching one, write a draft golden for it at once and run it (`verification.md`):

```
sl goldens run --name revenue_2025
```

Leave `role` and `user` out of the golden until `access.yaml` exists. Show the result next to the owner's figure before the measure's readback. Confirm the golden only after the measures it uses are approved. A draft golden may name a measure that does not exist yet (`sl validate` warns), so the owner's figure is recorded the moment they give it; add an open question on the model that measure belongs to, naming the golden, so the warning stands with its reason.

When you quote a figure you computed by hand with a rule the layer cannot yet express, label it so and put the layer's own figure beside it: "New customers in 2025: 123, computed by hand from each customer's first counted order. The layer's own figure is 131 customers created in 2025; to count the same way it needs a view that holds each customer's first counted order." Describe a blocker as the column or view that is missing, never as a limit of the tool, when no supported construct can express the rule; a rule the layer can express but the CLI does not yet check is waiting on the tool, and you say so.

## Readback templates

Read back in the owner's own words, with the numbers and values the YAML will use. Every sign-off readback ends with "Approve?". A factual check ("10,000 rows, each order once: is that right?") is a question, not an approval; when the owner answers it, follow with the sign-off readback.

Each sign-off readback has two parts: the definition to approve, then the measured facts, introduced as "measured from the data, no need to confirm". The owner approves the definition. A hedge on a measured fact ("I can't confirm the 10,000 from my reports") does not void a yes to the definition: approve it, and add "measured, not checked against a report" to the item's `description` next to the figure. A hedge on the definition itself is not a yes.

Read back every synonym you will write ("People also call it sales or GMV"), and write none the owner did not hear in a readback; add one named later only after reading it back.

- **Measure**: "So *revenue* is the total of `amount_cents` divided by 100, in US dollars, leaving out cancelled orders and orders from test accounts. Orders whose customer was deleted are kept. Shipping and tax are not included. People also call it sales or GMV. Measured from the data, no need to confirm: 2025 comes to $1,204,330.50 from 9,012 orders. Approve?"
- **Dimension**: "*Order date* is when the customer placed the order, with days and months in UTC, and it's the date we use for 'orders in March'. Measured from the data, no need to confirm: orders run from March 2019 to today. Approve?"
- **Table**: "The *orders* table has one row per order, each with its own `order_id`, covering web store orders. Test orders are excluded from every number. Measured from the data, no need to confirm: 10,000 rows since 2019, each `order_id` once. Approve?"

Put the sign-offs of one round trip in their own numbered block, separate from the open questions, so a "yes to 1 to 4" is unambiguous. Then run, only after an explicit yes to each:

```
sl approve --target warehouse.orders.revenue --by "Dana Ruiz"
sl approve --target warehouse.orders.order_date --by "Dana Ruiz"
sl approve --target warehouse.orders --by "Dana Ruiz"
```

| What was agreed | `--target` |
|---|---|
| One dimension, measure or join | `source.model.field` |
| The table as a whole (needs `grain` and `primary_key`) | `source.model` |
| The table and every item in it, after the owner said yes to a readback that covered each item, and every join in the model already has evidence from `sl check-join` and was read back (`joins.md`); otherwise approve fields one by one | `source.model` with `--recursive` |
| A metric in `metrics.yaml` | `metric:<name>` |
| The access file | `access` |
| A golden | use `sl goldens confirm`, see `verification.md` |

An approved measure needs a `description`; an approved model needs `grain` and `primary_key`; `sl validate` reports an error otherwise, so fill them in before approving. If the owner later changes their mind about an approved item, return it to draft with `sl approve --target <ref> --revoke`, edit it, and read it back again.

## Leaving things for later

- A table the owner wants to leave for later leaves scope: `sl scope --source <s> --exclude <table>` to preview, then the same with `--write` (`scoping.md`). Name it in the handoff.
- A field the owner skips in an otherwise agreed table stays draft. The table can still be approved, and `sl status` moves on to the later phases once no draft models remain in scope; it reports the leftover fields in `draft_fields` and `models_with_draft_fields`, and draft metrics and goldens in `draft_metrics` and `draft_goldens`. `next_step` can reach `done` with them left deliberately; name each in the handoff, and approve after a readback any draft field that a role's agreed breakdown or a golden relies on.

### Warnings that stand

A `sl validate` warning left on purpose has its reason written in the file it points at: the field's `description` ("reads the column on purpose", "waiting for the tool: ..."), or an open question on the model or in `access.yaml`. A resumed session fixes every warning without such a reason (`SKILL.md`, Phase 0). A fix to an approved item goes through `sl approve --target <ref> --revoke`, the edit, a readback and approval; after fixing a warning on an approved measure or golden, run `sl goldens check`, and when the rows changed, show the new figure and confirm again only on the owner's yes (`verification.md`).

## Keeping momentum

- Work in batches of `batch_size` tables, most important first: the owner's priorities, then `next_batch`. Tell the owner the plan: "five tables today: orders, customers, products, refunds, shipments".
- Keep messages short: at most three lines of status before the numbered items, and no preamble beyond that. On a resumed session, news (warnings fixed, rules added since the last session) goes into the numbered items, not the status.
- Batch per round trip. One message holds numbered items, one topic per item, each with a suggestion, up to about 8. Never pack several topics into one item.
- Lay a round trip out in two blocks: **Sign-offs** (readbacks ending in "Approve?", answered yes or no) and **Questions** (open items, each with your suggestion or labelled guess).
- Group similar columns: one item for all `*_cents` columns, one for all timestamps.
- Let the owner skip. Leave the item as draft, add an open question, and move on. Come back to skipped items at the end of the batch.
- After each table, say what was approved and what is left. After each batch, run `sl validate` and `sl status`. End every round trip, the last one and the handoff included, with one line: "Everything is saved. Stop here or continue?" Stopping costs nothing.

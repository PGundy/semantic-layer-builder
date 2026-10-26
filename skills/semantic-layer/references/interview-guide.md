# Interview guide

The interview turns measured facts into agreed meaning. You bring the facts (from the snapshot profile and the draft model); the owner supplies what they mean. Work through `next_batch` from `sl status --json`, one table at a time, and write every answer into `models/<source>/<model>.yaml` as soon as you hear it.

## Before each table

Read the draft model and the table's profile in `snapshots/<source>.json`: row count, each column's `null_fraction`, `distinct_count`, `min`, `max` and `top_values`, declared and inferred keys. Pick the handful of columns that raise a question. Do not walk through every column: an `id` that is unique and never empty, or a `created_at` that obviously means creation time, needs no question unless it matters for a measure.

## Question bank

Ask in this order, skipping what the facts already settle.

| Topic | Ask |
|---|---|
| What one row is | "Each row in `fct_orders` seems to be one order: 10,000 rows, and `order_id` is different on every row. Is that right, or can one order appear more than once?" |
| Which columns matter | "Which of these do people actually report on? I see `amount_cents`, `discount_cents`, `shipping_cents`, `tax_cents`." |
| Business terms and synonyms | "What do people call this number? Revenue, sales, GMV, bookings? Do any of those mean something different?" |
| Status values that count | "`status` is `completed` in 8,800 rows, `cancelled` in 700, `refunded` in 300, `pending` in 200. Which ones count as a real sale?" |
| Filters and test data | "I see 42 orders where `email` ends in `@acme-test.com`. Should those always be left out?" |
| Units | "`amount_cents` goes from 199 to 1,250,000. Is that cents, so $1.99 to $12,500? Which currency?" |
| Time zones | "`created_at` has no time zone. Is it UTC, or the store's local time?" |
| Which date is "the" date | "There's `created_at`, `paid_at` and `shipped_at`. When someone says 'orders in March', which one do they mean?" |
| Sensitive columns | "`email`, `phone` and `shipping_address` identify people. Should most users be unable to see them?" |
| Empty values | "`coupon_code` is empty in 92% of rows. Does empty mean no coupon was used?" |
| Ownership | "If a number looks wrong, who would know the answer? Anything you're unsure of, I'll note as an open question for them." |

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

A measure with the agreed filter, unit and synonyms:

```yaml
measures:
  - name: revenue
    expr: amount_cents / 100.0
    agg: sum
    filter: status in ('completed', 'refunded') and email not like '%@acme-test.com'
    format: currency
    currency: USD
    description: Order value in dollars after discounts, counting completed and refunded orders, excluding test orders. Shipping and tax are not included.
    synonyms: [sales, gmv]
    status: draft
```

The date that counts, with its time zone:

```yaml
dimensions:
  - name: order_date
    expr: created_at
    type: time
    time_grains: [day, week, month, quarter, year]
    description: When the customer placed the order, in UTC. This is the date for "orders in March".
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

Rules of thumb:

- A filter that applies to every use of the table (test data, soft-deleted rows) goes in each measure's `filter` and in the model `description`, so readers and tools both see it.
- Units go in `expr` (divide cents by 100.0) and `format`/`currency`, and the description says the unit in words.
- Remove a drafted dimension or measure the owner says is meaningless, or leave it as draft with a description saying why; never approve it to tidy up.
- Add a measure the owner names that the draft missed, with `status: draft`, then read it back.
- Record a disagreement or a hedge as an open question with a name next to it.

## Readback templates

Read back in the owner's own words, with the numbers and values the YAML will use. End with a yes-or-no question.

- **Measure**: "So *revenue* is the total of `amount_cents` divided by 100, in US dollars, counting completed and refunded orders and leaving out test orders. Shipping and tax are not included. People also call it sales or GMV. Shall I approve that?"
- **Dimension**: "*Order date* is when the customer placed the order, in UTC, and it's the date we use for 'orders in March'. Approve?"
- **Table**: "The *orders* table has one row per order, each with its own `order_id`. It covers web store orders since 2019, 10,000 rows. Test orders are excluded from every number. Is that the right description to sign off?"

Then run, only after an explicit yes:

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

An approved measure needs a `description`; an approved model needs `grain` and `primary_key`; `sl validate` reports an error otherwise, so fill them in before approving. If the owner later changes their mind about an approved item, edit it, set `status: draft`, remove `approved_by` and `approved_at`, and read it back again.

## Keeping momentum

- Work in batches of `batch_size` tables, most important first, as `next_batch` lists them. Tell the owner the plan: "five tables today: orders, customers, products, refunds, shipments".
- Offer a default with every question: "I'd count completed and refunded; does that sound right?" Owners confirm faster than they compose.
- Group similar columns: one question for all `*_cents` columns, one for all timestamps.
- Let the owner skip. Leave the item as draft, add an open question, and move on. Come back to skipped items at the end of the batch.
- Keep each turn short: one to three questions, never a wall of text.
- After each table, say what was approved and what is left; after each batch, run `sl validate` and `sl status` and ask whether to continue or stop. Everything is saved, so stopping costs nothing.

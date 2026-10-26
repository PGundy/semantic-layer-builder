# Verification with goldens

A golden is a question with an answer the owner trusts. It proves the approved definitions reproduce a figure the business already uses, and later it is the regression test that any tool built on the layer must pass. Format details are in `spec.md`.

## When to write them

Draft goldens may be written at any phase. Write one as soon as the owner offers a trusted figure, or ties a sign-off to matching one ("I'll approve revenue once 2025 matches the close"), and `sl goldens run` it during the interview. Phase 9 rounds the set out to about ten.

- Until `access.yaml` exists, leave `role` and `user` out; `sl validate` warns about a golden that names a role with no access file. Add them in Phase 9 for the goldens asked as a restricted role.
- Confirm a golden only after the measures, dimensions and metrics its request uses are approved.

## Choosing the questions

Pick about ten questions with the owner. Together they should:

- use every approved measure and metric at least once;
- include each important time dimension at a grain people report on (month, quarter);
- include one or two breakdowns by a category (region, product line, channel);
- include each approved filter that changes totals (excluded statuses, test data);
- cross at least one approved join;
- if access is approved, include one question per restricted role with its user attributes set, and for a role with row filters on two joined models, one that crosses that join (revenue by customer for a sales rep), so the left-join rule is pinned;
- cover every reference figure the owner gave, including its breakdowns (spend by channel as well as total spend);
- have a known answer: a monthly close, a board deck, a dashboard the owner trusts. Ask: "Which numbers do you already know by heart or can look up? Last month's revenue, last quarter's order count?"

Write each question exactly as a person would ask it.

## Writing a golden

Create `goldens/<name>.yaml` yourself with `status: draft`. The `request` names approved fields relative to its `source`; the `sql` is the query you write by hand from the model YAML, applying exactly what the YAML says: each measure's `expr`, `agg` and `filter`, each dimension's `expr`, each join's `keys` and `type`, and, for a restricted role, its row filters with the user's values.

```yaml
name: revenue_by_month_2025
question: What was revenue by month in 2025?
role: analyst                      # role and user only once access.yaml exists
user: {}
request:
  source: warehouse
  measures: [orders.revenue]
  dimensions: ["orders.order_date:month"]
  filters:
    - { field: orders.order_date, op: gte, value: "2025-01-01" }
    - { field: orders.order_date, op: lt, value: "2026-01-01" }
  order_by: [{ field: "orders.order_date:month", direction: asc }]
sql: |
  select date_trunc('month', created_at) as order_date_month,
         sum(amount_cents / 100.0) filter (where status <> 'cancelled') as revenue
  from public.fct_orders
  where created_at >= '2025-01-01' and created_at < '2026-01-01'
  group by 1 order by 1
reference: Finance monthly close, January to December 2025.
status: draft
```

### Fields on other models

A dimension or filter field on another model is named `model.field` of that model, and is reached from the model of the request's first measure through joins (approved or draft) that are `many_to_one` or `one_to_one`, at most two hops. The shortest such path is used and must be unique, so a direct join wins over a route through another model; `sl validate` reports an error when there is no path or two shortest paths tie. For revenue by region name, `orders.revenue` reaches `regions.region_name` through `orders.region`:

```yaml
request:
  source: warehouse
  measures: [orders.revenue]
  dimensions: [regions.region_name]
```

When a field cannot be reached that way (refunds by the order's month), add a dimension to the measure's own model through a join reference (`refunds.order_date` with `expr: order.created_at`, `interview-guide.md`). A request with a metric that combines several models groups by dimensions that exist, with the same name, in every model it uses: `net_revenue` by `orders.order_date:month` needs `refunds.order_date` too.

### Checks before running

- Output column names match the request: a measure by its name (`revenue`), a time dimension with its grain (`order_date_month`).
- A filter on a measure goes inside its aggregate (`filter (where ...)` in duckdb and postgres, `sum(case when ... then x end)` elsewhere), not in `where`, so other measures in the same query are not affected.
- A join reference in a filter or dimension (`customer.is_test_account`) becomes the join itself, with the join's `type` and keys: `left join public.dim_customers customer on customer.customer_id = o.customer_id`, and the filter's null handling as written.
- A row filter on the base model goes in `where`; a row filter on a joined model goes in that join's `on` clause, so a left join keeps the row with blank joined columns.
- Time grains bucket in UTC, as the CLI runs every query with the session time zone UTC: `date_trunc('month', created_at)` on a timestamp-with-time-zone column is a UTC month. A dimension whose `expr` converts (`created_at at time zone 'America/New_York'`) is written the same way in the SQL.
- A `one_to_many` join aggregates the many side in a subquery before joining.
- `reference` says where the trusted figure comes from.

## Running and comparing

```
sl goldens run --name revenue_by_month_2025
```

It runs the SQL read-only and shows the rows. For a warehouse dialect, use the same `--emit-sql` and `--results` steps as `intake.md` describes.

Show the owner the result next to their trusted figure, row by row, with the difference:

> "For January 2025 I get $104,233.50; your close says $104,240. That's 0.006% apart. February matches exactly. ..."

Small differences can be expected (rounding, late-arriving rows, a close taken on a fixed date). Agree the tolerance with the owner before confirming, and say what it means in money: "a tolerance of half a percent lets $1.2M revenue drift by $6,000 before the check fails". Use 0 for figures finance signs off. Without `--tolerance`, confirm keeps the tolerance already in the file or records the default 0.005, so always pass it.

## Confirming

Only when the measures the golden uses are approved and the owner says the answer matches the figure they trust:

```
sl goldens confirm --name revenue_by_month_2025 --by "Dana Ruiz" --tolerance 0
sl validate
```

`confirm` reruns the golden's query, records the rows as `expected` with the tolerance and marks the golden approved. Before recording it prints any draft measure, dimension or metric the request uses, and `sl validate` warns about an approved golden that uses one. Check the request's fields before you confirm; if confirm lists a draft field, read that field back and approve it on a yes, or set the golden back to `status: draft` until it is approved. For a warehouse dialect, confirm with `--results <file>` from the run you showed the owner: `sl goldens confirm --name revenue_by_month_2025 --by "Dana Ruiz" --tolerance 0 --results <scratch>/golden-results.json`. Never confirm a golden because the SQL looks right: the point is agreement with an independent figure.

A golden records at most 200 rows; `--force` lifts that limit and does nothing else. To change an agreed tolerance later, rerun `sl goldens confirm --name <g> --by "<name>" --tolerance <t>` after the owner's yes to the new tolerance: it reruns the query, records the rows again with the new tolerance, and updates `confirmed_by` and `confirmed_at`.

## When it does not match

A mismatch means a definition is wrong or the trusted figure means something else. Triage with the owner, cheapest check first:

1. **Time**: which date the report uses, the time zone, the period boundaries. "Is the close by order date or payment date?"
2. **Filters**: statuses counted, test data, refunds, deleted rows. Run the query with and without each filter (`sl run` on duckdb and postgres, your own tool elsewhere) and show how each changes the total.
3. **Units and scope**: cents vs dollars, tax and shipping, currency, which source is the trusted one.
4. **Joins**: rows dropped by an inner join, rows repeated by a fan-out. Check the join's `evidence`.
5. **The reference itself**: the report may include adjustments not in the data. Record that in `reference` and as an open question.

Fix the definition in the model YAML, return the changed item to draft (`sl approve --target <ref> --revoke`), read it back, approve it again, then rerun the golden. Note what you learned in the item's `description` so the next reader does not repeat the mistake.

## The regression gate

```
sl goldens check
```

It reruns every approved golden and fails when any result drifts beyond its tolerance. For a warehouse dialect a plan covers one source: run `sl goldens check --source <s> --emit-sql`, run the queries as in `intake.md`, then `sl goldens check --source <s> --results <file>`; repeat per source. Run it at the end of every session, after any change to an approved model, metric or access rule, and before handing the layer to a downstream tool. A failure after a data refresh can be legitimate (late rows); discuss it with the owner before confirming new rows.

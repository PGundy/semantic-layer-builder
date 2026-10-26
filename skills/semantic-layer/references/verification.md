# Verification with goldens

A golden is a question with an answer the owner trusts. It proves the approved definitions reproduce a figure the business already uses, and later it is the regression test that any tool built on the layer must pass. Format details are in `spec.md`.

## Choosing the questions

Pick about ten questions with the owner. Together they should:

- use every approved measure and metric at least once;
- include each important time dimension at a grain people report on (month, quarter);
- include one or two breakdowns by a category (region, product line, channel);
- include each approved filter that changes totals (excluded statuses, test data);
- cross at least one approved join;
- if access is approved, include one question asked as a restricted role with a user attribute set;
- have a known answer: a monthly close, a board deck, a dashboard the owner trusts. Ask: "Which numbers do you already know by heart or can look up? Last month's revenue, last quarter's order count?"

Write each question exactly as a person would ask it.

## Writing a golden

Create `goldens/<name>.yaml` yourself with `status: draft`. The `request` names approved fields relative to its `source`; the `sql` is the query you write by hand from the model YAML, applying exactly what the YAML says: each measure's `expr`, `agg` and `filter`, each dimension's `expr`, each join's `keys` and `type`, and, for a restricted role, its row filters with the user's values.

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
sql: |
  select date_trunc('month', created_at) as order_date_month,
         sum(amount_cents / 100.0) filter (where status <> 'cancelled') as revenue
  from public.fct_orders
  where created_at >= '2025-01-01' and created_at < '2026-01-01'
  group by 1 order by 1
reference: Finance monthly close, January to December 2025.
status: draft
```

Checks before running:

- Output column names match the request: a measure by its name (`revenue`), a time dimension with its grain (`order_date_month`).
- A filter on a measure goes inside its aggregate (`filter (where ...)` in duckdb and postgres, `sum(case when ... then x end)` elsewhere), not in `where`, so other measures in the same query are not affected.
- A `one_to_many` join aggregates the many side in a subquery before joining.
- `reference` says where the trusted figure comes from.

## Running and comparing

```
sl goldens run --name revenue_by_month_2025
```

It runs the SQL read-only and shows the rows. For a warehouse dialect, use the same `--emit-sql` and `--results` steps as `intake.md` describes.

Show the owner the result next to their trusted figure, row by row, with the difference:

> "For January 2025 I get $104,233.50; your close says $104,240. That's 0.006% apart. February matches exactly. ..."

Small differences can be expected (rounding, late-arriving rows, a close taken on a fixed date). Agree a tolerance with the owner; the default is half a percent, written as `expected.tolerance: 0.005`.

## Confirming

Only when the owner says the answer matches the figure they trust:

```
sl goldens confirm --name revenue_by_month_2025 --by "Dana Ruiz"
sl validate
```

`confirm` reruns the golden's query, records the rows as `expected` and marks the golden approved. For a warehouse dialect, confirm with `--results <file>` from the run you showed the owner: `sl goldens confirm --name revenue_by_month_2025 --by "Dana Ruiz" --results <scratch>/golden-results.json`. Never confirm a golden because the SQL looks right: the point is agreement with an independent figure.

## When it does not match

A mismatch means a definition is wrong or the trusted figure means something else. Triage with the owner, cheapest check first:

1. **Time**: which date the report uses, the time zone, the period boundaries. "Is the close by order date or payment date?"
2. **Filters**: statuses counted, test data, refunds, deleted rows. Run the query with and without each filter (`sl run` on duckdb and postgres, your own tool elsewhere) and show how each changes the total.
3. **Units and scope**: cents vs dollars, tax and shipping, currency, which source is the trusted one.
4. **Joins**: rows dropped by an inner join, rows repeated by a fan-out. Check the join's `evidence`.
5. **The reference itself**: the report may include adjustments not in the data. Record that in `reference` and as an open question.

Fix the definition in the model YAML, return the changed item to draft (set `status: draft`, remove `approved_by` and `approved_at`), read it back, approve it again, then rerun the golden. Note what you learned in the item's `description` so the next reader does not repeat the mistake.

## The regression gate

```
sl goldens check
```

It reruns every approved golden and fails when any result drifts beyond its tolerance. For a warehouse dialect a plan covers one source: run `sl goldens check --source <s> --emit-sql`, run the queries as in `intake.md`, then `sl goldens check --source <s> --results <file>`; repeat per source. Run it at the end of every session, after any change to an approved model, metric or access rule, and before handing the layer to a downstream tool. A failure after a data refresh can be legitimate (late rows); discuss it with the owner before confirming new rows.

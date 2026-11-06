# Verification with goldens

A golden is a question with an answer the owner trusts. It pins a figure that hand-written SQL computes, checked against a figure the business already uses, and later `sl goldens check` reruns that SQL to detect drift in the data. Format details are in `spec.md`.

What a golden does not do yet: test that the YAML computes the figure. You write its SQL by hand from the model YAML, and nothing compiles the YAML to compare with it, so a golden whose SQL leaves out a measure's filter still matches, and an edit to an approved measure passes every golden until the golden's SQL changes too. `sl sql` compiles a request from the YAML (`spec.md`, Reference compiler), but goldens do not run it yet, so keep each golden's SQL in step with the YAML by hand (Keeping the SQL in step with the YAML), and say so when you describe goldens to the owner: "these pin the figures we agreed and catch changes in the data; they do not check the definitions themselves."

## When to write them

Draft goldens may be written at any phase. Write one as soon as the owner offers a trusted figure, or ties a sign-off to matching one ("I'll approve revenue once 2025 matches the close"), and `sl goldens run` it during the interview. Phase 9 rounds the set out to about ten.

- Until `access.yaml` exists, leave `role` and `user` out; `sl validate` warns about a golden that names a role with no access file. Add them in Phase 9, so each role in `access.yaml` has a golden that runs as it.
- A draft golden may name a measure, dimension or metric that does not exist yet; `sl validate` warns rather than errors, so the owner's figure is recorded as soon as they give it, before its measure is written. Add an open question on the model that measure belongs to, naming the golden, so the warning stands with its reason (`SKILL.md`, Phase 10). An approved golden naming an unknown field is an error.
- Confirm a golden only after the measures, dimensions and metrics its request uses are approved.
- Confirm a golden that runs as a role after `access.yaml` is approved. One confirmed while access is still a draft is rechecked with `sl goldens check --name <g>` and read back to the owner after every change to that role; `sl goldens confirm` warns when the golden's role is defined only in a draft `access.yaml`. Once access is approved, such a golden stays valid, with no new confirm, when its `role` and `user` are unchanged and `sl goldens check` passes.

## Choosing the questions

Pick about ten questions with the owner. Together they should:

- use every approved measure and metric at least once, a measure as `model.measure` and a metric by bare name, both in `measures`;
- include each important time dimension at a grain people report on (month, quarter);
- include one or two breakdowns by a category (region, product line, channel);
- include each approved filter that changes totals (excluded statuses, test data);
- cross at least one approved join;
- if access is approved, include one question as each role in `access.yaml`, restricted or not (a golden with no `role` runs as `default_role`, or, with none, as the default audience of open access), with its user attributes set, and for a role with row filters on two joined models, one that crosses that join (revenue by customer for a sales rep), so the left-join rule is pinned;
- for a span-of-control row filter, one question as a manager, with `user` holding their id (`user: { employee_id: 1042 }`), against a team figure the owner trusts ("employee 1042's team closed 312 tickets in March"), the golden's question naming the id, not the person;
- for each restriction, one question as a role or user it allows, so the restricted metric or field is pinned for the people who may see it (for an `allow.when`, a golden whose `user` holds the attribute, `user: { department: finance }`, needs no role); check with `sl access` that the default audience cannot see it;
- for a restricted role whose measure reads through a join to a model the role cannot see or row-filters (revenue's test-account rule for marketing), one question as that role, so the rule that definition joins apply whatever the role may see is pinned;
- cover every reference figure the owner gave, including its breakdowns (spend by channel as well as total spend);
- have a known answer: a monthly close, a board deck, a dashboard the owner trusts. Ask: "Which numbers do you already know by heart or can look up? Last month's revenue, last quarter's order count?"

Write each question exactly as a person would ask it.

### A golden that pins a rule

A golden may pin a rule rather than a figure: the restricted-role golden above pins that revenue leaves out test accounts for marketing, and the owner may have no report for that role. Confirm its measured rows only when its `reference` says which rows were checked against a report ("2025 total checked against the Finance close; the role sees the same total"). Otherwise request only the trusted grain, the figure the owner did check (the year's total, not each month), so the recorded rows hold nothing nobody compared.

### Coverage checklist, checked at handoff

`next_step` in `sl status` reaches `done` when the phases the CLI can measure are complete; it does not tick this list, and its message says to. A role in `roles_without_goldens` keeps `next_step` at `verify` until a golden that runs as that role is written and confirmed. Before the handoff, tick each line, and name every line that stays unticked in the handoff with the reason:

- [ ] Every approved measure and metric is in at least one approved golden.
- [ ] Every role in `access.yaml`, restricted or not, has at least one approved golden that runs as it (a golden with no `role` runs as `default_role`); `roles_without_goldens` in `sl status --json` lists the roles of `access.yaml` that no approved golden uses, and the handoff names each one.
- [ ] At least one approved golden crosses a join to a model with a row filter, as the role that has the filter. The line is N/A, and named as such in the handoff with the reason, when no join the role may use reaches its row-filtered model (every model that joins to it is denied to the role). `row_filter_joins_without_goldens` in `sl status --json` lists, per role, each visible model that reaches a row-filtered model through a to-one join and that no approved golden running as the role names; the handoff names each one. A golden may have no measures: it starts from its first dimension, which is how a row-filtered child model with no measures (order lines limited through their order) is covered.
- [ ] Every reference figure the owner gave has a golden, draft or approved.

### Personal values in goldens

A golden's `question` and `reference` never quote a value of a `pii` or `sensitive` column; name the id ("rep 301"). `sl validate` checks them against the top values the snapshot keeps; a protected column's values are not stored (`spec.md`, Profiles of protected columns), so the check cannot catch them and naming the id is on you. Replacing a personal value with an id in an approved golden's `question` or `reference` changes no figure and needs no new confirm: edit it and run `sl goldens check`. A golden's `expected.rows` are exempt from the check: they are the answer as the golden's role, which may see the column.

## Writing a golden

Create `goldens/<name>.yaml` yourself with `status: draft`. The `request` names approved fields relative to its `source`; the `sql` is the query you write by hand from the model YAML, applying exactly what the YAML says: each measure's `expr`, `agg` and `filter`, each dimension's `expr`, each join's `keys` and `type`, and, for a restricted role, its row filters with the user's values. Add nothing the YAML does not say: no `round()` around a measure (fix the measure's `expr` instead, such as cents as `<col> * 0.01` on duckdb), and no join the request and its fields do not use. `sl validate` warns on `round(` in a golden's `sql`, since it hides float noise the measure would carry, and on a duckdb measure `expr` that divides by a numeric literal; on duckdb a division by any number gives a DOUBLE, a cast divisor such as `/ 100::decimal(18, 2)` included. Neither warning ever stands, whatever the golden's `reference` or the field's `description` says: fix both. For a ratio compared with a report figure rounded to cents (AOV $134.46), the SQL does not round either; the rounding is written in `reference` (Running and comparing).

The request's `measures` lists measures as `model.measure` and metrics by bare name; there is no `metrics` key, and `sl validate` says so when it sees `request.metrics`. A request's measures share one model, or are one metric: a request that lists measures of two models (`orders.revenue` and `refunds.refund_amount`) is an error, "a request's measures must share one model, or be one metric", because their totals would repeat across each other's rows. Write a golden per model, or approve a metric that combines them and request that:

```yaml
request:
  source: warehouse
  measures: [orders.revenue, average_order_value]
```

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

### Keeping the SQL in step with the YAML

`sl validate` compares the SQL with the request's measures only by name: when the SQL never names a column that a measure's `expr` or `filter` reads (a join reference counts as the column it reads), it warns "goldens pin hand-written SQL; this SQL may not apply <measure>'s rule" and names the missing columns. Fix the SQL rather than explain the warning away. Nothing checks that the SQL applies the rule correctly, so:

- write the SQL from the YAML as it stands, clause by clause, and read it against each measure's `expr`, `agg` and `filter` before you run it;
- after an approved measure, metric, join or row filter changes (a revoke, an edit, a new approval), update the SQL of every golden that uses it in the same session, run each with `sl goldens check --name <g>`, and show the owner any figure that moved;
- `grep` the golden files for a rule you changed (a status list, a test-account column) to find every copy of it.

### Fields on other models

A dimension or filter field on another model is named `model.field` of that model, and is reached from the model of the request's first measure through joins (approved or draft) that are `many_to_one` or `one_to_one`, at most two hops. The shortest such path is used and must be unique, so a direct join wins over a route through another model; `sl validate` reports an error when there is no path or two shortest paths tie. For revenue by region name, `orders.revenue` reaches `regions.region_name` through `orders.ship_to_region`:

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
- A join reference in a filter or dimension (`customer.is_test_account`) becomes the join itself, with the join's `type` and keys: `left join public.dim_customers customer on customer.customer_id = o.customer_id`, and the filter's null handling as written. A two-hop reference (`order.customer.is_test_account` on refunds) chains both joins, each with its own `type`.
- Such a definition join carries no row filter, whatever the role. When the request also reaches that model's fields for a role with a row filter on it, write two joins: the definition join without the filter, and the request's join with the filter in its `on` clause.
- A row filter on the base model goes in `where`; a row filter on a joined model goes in that join's `on` clause, so a left join keeps the row with blank joined columns.
- Time grains bucket in UTC, as the CLI runs every query with the session time zone UTC: `date_trunc('month', created_at)` on a timestamp-with-time-zone column is a UTC month. On a column without a time zone the bare column buckets in the zone its values were recorded in (the dimension's `time_zone`). A dimension whose `expr` converts is written the same way in the SQL, with the conversion its column's type needs (`interview-guide.md`, Time zones per type and dialect).
- A `one_to_many` join aggregates the many side in a subquery before joining.
- `reference` says where the trusted figure comes from.

## Running and comparing

```
sl goldens run --name revenue_by_month_2025
```

It runs the SQL read-only and shows the rows. For a warehouse dialect, use the same `--emit-sql` and `--results` steps as `intake.md` describes.

Show the owner the result next to their trusted figure, row by row, with the difference:

> "For January 2025 I get $104,233.50; your close says $104,240. That's 0.006% apart. February matches exactly. ..."

A small difference from the owner's figure (late-arriving rows, a close taken on a fixed date) is settled with the owner and written in `reference`; it is not a tolerance, because `check` never sees the owner's figure. Then agree the tolerance, which guards drift between later runs and the recorded rows, and say what it means in money: "a tolerance of half a percent lets $1.2M revenue drift by $6,000 before the check fails". Use 0 for figures finance signs off. A ratio set against a report figure rounded to cents (AOV $134.4577 against $134.46) differs only by the rounding: show the unrounded value next to the report figure, agree with the owner that they match, and write the rounding in `reference` ("report shows $134.46; the layer gives 134.4577, the same figure before rounding"). `confirm` records the unrounded rows, and `check` compares later runs with them, so the tolerance guards drift between runs, not rounding or any other gap to the report: 0 still suits a ratio of figures finance signs off. The tolerance covers every column of the golden. Plain output of `goldens run` and `goldens confirm` shows measures with `format: currency` to two decimals; the recorded rows keep the full value. Without `--tolerance`, the readback states the tolerance already in the file or the default 0.005, so always pass it to `sl readback`.

## Confirming

Only when the measures the golden uses are approved, read the golden back: the question, the request in words, who it runs as, the figure the owner trusts (`reference`), the rows its SQL returns now and the tolerance. Record the owner's answer, and confirm only on their yes:

```
sl readback --targets golden:revenue_by_month_2025 --tolerance 0
sl reply --readback <readback_id> --item 1 --text "<owner's words>" --verdict yes --by "Dana Ruiz"
sl goldens confirm --name revenue_by_month_2025
sl validate
```

`confirm` reruns the golden's query and refuses, writing nothing, unless the owner's latest reply to `golden:<g>` is a yes to the golden with exactly those rows and that tolerance: a yes recorded before the data, the SQL or the tolerance changed, or followed by a no, does not count, so read it back again. It records the rows as `expected` with the tolerance the owner heard, takes `confirmed_by` and `confirmed_at` from the reply (a `--by` naming someone else is refused) and marks the golden approved. `sl validate` warns about a confirmed golden with no matching yes, such as one confirmed before the rule or edited since. Before recording it prints any draft measure, dimension or metric the request uses, and `sl validate` warns about an approved golden that uses one. Check the request's fields before you confirm; if confirm lists a draft field, read that field back and approve it on a yes, or leave the golden draft until it is approved. For a golden already approved that uses a draft field (`sl validate` warns, and rerunning confirm lists it), approve the field after its readback, then run `sl goldens check --name <g>`: if it passes, the recorded rows stand; only rows that changed need a new confirm, after the owner's yes to the new figure. `confirm` also records `confirmed_as: { role, user }`, the role and user the golden ran as. A golden approved before `confirmed_as` was recorded has none, and `sl validate` cannot see a later change to its role or user: confirm it again at its next readback, on the owner's yes, so the check applies.

`sl validate` checks every golden's request against access as the user it runs as: its `role` and `user`, or with no role, the default role, or the default audience of open access. A field or metric that user may not see is an error in an approved golden and a warning in a draft one; give the golden a role and user who may see it, or settle access with the owner. Changing `role` or `user` on an approved golden changes what it pins: write that role's row filters into the SQL, run `sl goldens run --name <g>`, read the change back with the figure, and confirm again on the owner's yes. Until then `sl validate` warns that the golden runs as someone other than `confirmed_as`.

For a warehouse dialect, read back and confirm with `--results <file>` from the run you showed the owner: `sl readback --targets golden:revenue_by_month_2025 --tolerance 0 --results <scratch>/golden-results.json`, then after the yes `sl goldens confirm --name revenue_by_month_2025 --results <scratch>/golden-results.json`. Never confirm a golden because the SQL looks right: the point is agreement with an independent figure.

A golden records at most 200 rows; `--force` lifts that limit and does nothing else. To change an agreed tolerance later, read it back with `sl readback --targets golden:<g> --tolerance <t>` and, after the owner's recorded yes, rerun `sl goldens confirm --name <g> --tolerance <t>`: it reruns the query, records the rows again with the new tolerance, and updates `confirmed_by` and `confirmed_at`.

## When it does not match

A mismatch means a definition is wrong or the trusted figure means something else. Triage with the owner, cheapest check first:

1. **Time**: which date the report uses, the time zone, the period boundaries. "Is the close by order date or payment date?"
2. **Filters**: statuses counted, test data, refunds, deleted rows. Run the query with and without each filter (`sl run` on duckdb and postgres, your own tool elsewhere) and show how each changes the total.
3. **Units and scope**: cents vs dollars, tax and shipping, currency, which source is the trusted one.
4. **Joins**: rows dropped by an inner join, rows repeated by a fan-out. Check the join's `evidence`.
5. **The reference itself**: the report may include adjustments not in the data. Record that in `reference` and as an open question.

Fix the definition in the model YAML, return the changed item to draft (`sl approve --target <ref> --revoke`), read it back, approve it again, update the golden's SQL to the new definition, then rerun the golden. For an approved golden, `sl goldens check --name <g>` compares with the recorded rows: when it passes, the recorded rows stand and no new confirm is needed; when the rows changed, show the new figure to the owner and confirm again only on their yes. Note what you learned in the item's `description` so the next reader does not repeat the mistake.

## Checking for drift

```
sl goldens check
```

It reruns every approved golden's stored SQL and fails when any result drifts beyond its tolerance. It reruns the SQL, not the YAML: it catches data that changed under a figure, and a golden whose SQL you updated after a definition changed, but not a definition that changed while its goldens' SQL stayed the same. Without `--source` it checks every source, so each runnable source's connection variable must be set; `--source <s>` checks one. For a warehouse dialect a plan covers one source: run `sl goldens check --source <s> --emit-sql`, run the queries as in `intake.md`, then `sl goldens check --source <s> --results <file>`; repeat per source. After fixing a `sl validate` warning on an approved measure or golden (a `round()` removed from its SQL), run `sl goldens check --name <g>`: when it passes, the recorded rows stand; when the rows changed, show the new figure to the owner and confirm again only on their yes. Rows recorded rounded fail until the owner says yes to the unrounded figure and the golden is confirmed again. Run it at the end of every session, after any change to an approved model, metric or access rule, after a rerun of `sl introspect` that changed a modeled table (`interview-guide.md`, Keeping the layer current), and before handing the layer to a downstream tool, updating each affected golden's SQL first (Keeping the SQL in step with the YAML). A failure after a data refresh can be legitimate (late rows); discuss it with the owner before confirming new rows.

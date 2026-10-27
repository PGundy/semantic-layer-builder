# Joins

A join says how two tables in the same source connect, for example each order to the customer who placed it. A wrong join silently doubles or drops numbers, so every join is measured before the owner approves it.

## Where joins come from

`sl draft` writes joins with an `origin`:

- `declared`: the database has a foreign key between the columns. Usually right, still checked.
- `inferred`: guessed by a tool or by you, from names (`orders.customer_id` and `customers.customer_id`) or from matching values (every `orders.ship_region` value is a `regions.region_code`). Often right, sometimes not (`created_by_id` is not a customer). A join you find yourself and add to the model's `joins` list gets `origin: inferred` and `status: draft`.
- `owner`: the owner told you, for example "`shipments.order_ref` is the order number". Write it yourself in the model's `joins` list with `origin: owner` and `status: draft`.

Name a join after the role its target plays for this model (`customer`, `ship_to_region`, `home_region`), never after a column or a dimension of the model (`ship_region`, `region`): joins share one namespace with the model's dimensions and measures, and a role name says which region a reader gets.

To test a join you suspect from values before writing it, compare the columns with `sl run` on duckdb and postgres: `select count(*) filter (where r.region_code is null) as unmatched, count(*) as total from public.fct_orders o left join public.dim_regions r on r.region_code = o.ship_region`. Then write the join and measure it with `sl check-join`.

Every join, whatever its origin, goes through `sl check-join` and a readback.

## Measuring a join

```
sl check-join --source warehouse --model orders --join customer
```

For warehouse dialects, add `--emit-sql`, run the query, and finish with `--results <file>` (see `intake.md`). The command prints how the relationship written in the YAML compares with the data, for example `(YAML says many_to_one, data says many_to_one)`, and writes `evidence` into the join:

```yaml
evidence:
  checked_at: 2026-10-26T12:10:00.000Z
  left_rows: 10000          # orders
  left_null_keys: 12        # orders with no customer_id
  matched_rows: 9978        # orders whose customer_id is found in customers
  match_rate: 0.9978
  right_rows: 2000          # customers
  right_key_unique: true    # each customer_id appears once in customers
  left_key_unique: false    # many orders share a customer_id
  max_fanout: 1             # the most customer rows any one order matches
  suggested_relationship: many_to_one
```

### Saying it in plain language

| Evidence | Say |
|---|---|
| `match_rate` near 1 | "Almost every order (9,978 of 10,000) finds its customer." |
| `left_null_keys` > 0 | "12 orders have no customer recorded at all." |
| `match_rate` well below 1 with few null keys | "About 300 orders point at a customer number that doesn't exist in the customer table. Were those customers deleted, or are they in another system?" |
| `right_key_unique: true` | "Each customer appears once in the customer table, so joining can't repeat an order." |
| `right_key_unique: false`, `max_fanout: 3` | "Some orders match up to 3 rows on the other side, so joining would count those orders up to 3 times." |
| `match_rate` near 0 | "These columns don't connect. The names look alike but the values don't match." Do not approve; ask what the columns mean or drop the join. |

### Orphans

Rows on the left that find no match are orphans. They matter for `type`:

- `type: left` keeps orphans, so totals stay the same and their customer fields are empty. This is the safe default.
- `type: inner` drops orphans, so totals shrink. Use it only when the owner says unmatched rows should never be counted, and say how many rows that removes.

When orphans are more than about 1% of rows, ask about them and write the answer in the join's `description` or as an open question.

The join's `type` also decides what a join reference through it sees. A measure filter or dimension on the left model that reads `customer.<column>`, or `order.customer.<column>` two hops away, makes the compiler add each join on the path with its own `type`: on a `left` join an orphan's `customer.<column>` is empty (null), so a filter meant to keep orphans handles null, as in `coalesce(customer.is_test_account, false) = false`; on an `inner` join orphans are gone from every measure that uses the reference. Choose the type with the owner and read the consequence back (`interview-guide.md`, join references).

## Relationships

- `many_to_one`: many rows on the left, one on the right (orders to customer). Safe: totals on the left stay correct.
- `one_to_one`: one row on each side (customer to customer_settings). Safe.
- `one_to_many`: one row on the left, many on the right (customer to orders). **It multiplies totals on the left.** If a customer has 5 orders, joining customers to orders repeats that customer 5 times, so a sum of `lifetime_credit` from customers comes out 5 times too large. Flag every such join to the owner: "If someone asks for customer credit broken down by order, the credit would be counted once per order. Tools that read this layer total the order side first and then join, so their numbers stay right, but anyone writing SQL by hand must do the same." Often the better model is the reverse join, declared on the many side (`orders.customer`, `many_to_one`).
- `many_to_many`: neither side is unique (orders to promotions, where an order can have several promotions and a promotion several orders). It cannot be modeled directly and must not be approved. Options to offer:
  1. A bridge table that holds one row per pair (`order_promotions`). Add it to scope, model it, and join each side to it with `many_to_one` joins.
  2. A pre-aggregated model, for example a view with one row per order and the promotion count: on DuckDB a view in `connection.views`, elsewhere a view or table the owner's engineers create.
  3. Leave it out and record an open question.

When `relationship` in the YAML differs from `suggested_relationship`, change the YAML to match the evidence, or ask the owner why the data disagrees with what they expect. Never approve a join whose YAML relationship the evidence contradicts.

Only `many_to_one` and `one_to_one` joins carry join references (in measure filters, dimensions and row filters) and request fields on other models; a `one_to_many` join never does, because it repeats the left model's rows.

`sl draft --new-columns` drafts a join for a new foreign-key column whose target is in scope or modeled, with `origin: declared` when the database declares the key and `inferred` otherwise; check and read it back like any other.

## Closure models for span of control

A span-of-control row filter (`access.md`) reads a closure model, one row per manager and member pair at any depth, through its `hierarchy` rule, not through a join: the filtered model needs no join to it, and the compiler reads it without its own row filters. Model it like any other table, with grain "one row per manager and member pair" and the pair as its `primary_key`, and check with the owner that a director is paired with everyone below them, not only their direct reports. `sl draft` drafts a table of 2 or 3 columns whose names all end in `_id` this way already: every column a dimension, all of them the `primary_key`, no count measures, and an open question asking the owner to confirm that each pair appears once; check it with `sl run` (`select count(*), count(distinct (manager_id, member_id)) from <closure>`) before the readback.

## Joins only within a source

A join's `to` is a model in the same source. When the owner wants to connect tables in two sources (warehouse orders with lake web sessions), do not write the join: record it as an open question on both models, for example "Connect `lake.sessions.order_id` to `warehouse.orders` once both live in one engine", and list it in the handoff.

## Readback and approval

Read back what the join does, how well it matched, and any risk, then ask for a yes:

> "Each order connects to the customer who placed it, using `customer_id`. 9,978 of 10,000 orders find their customer; 12 have no customer recorded and 10 point at a missing one. Each customer appears once, so joining never repeats an order. Orders without a customer are kept, with empty customer details. Approve?"

A row filter on the joined model in `access.yaml` behaves the same way when a request reaches that model's fields through the join: on a left join it blanks the joined columns and keeps the left row; on an inner join it drops the row. A join that a measure filter, a dimension `expr` or a row filter in `access.yaml` reads through is part of that field's definition: the compiler joins it without the target's row filters and whatever the role may see, so a row filter never blanks a rule such as the test-account exclusion, and no helper model is needed for that (`access.md`, Definition joins).

For a `one_to_many` join, add the multiplication warning in the readback itself. After an explicit yes:

```
sl approve --target warehouse.orders.customer --by "Dana Ruiz"
sl validate
```

`sl validate` warns about an approved join without `evidence`. Evidence also records the keys and the target model (`to`) it measured, and `sl validate` warns when they differ from the join's current `keys` or `to`; evidence that does not record them gives no such warning. Rerun `sl check-join` after the data, the keys or the target change, including when a rerun of `sl introspect` shows a key column removed, renamed or retyped (`interview-guide.md`, Keeping the layer current), then read the join back again. Renaming a join keeps its evidence, since the measurement does not depend on the name; update every join reference that uses the old name (`sl validate` reports them).

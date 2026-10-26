# Access rules

`access.yaml` says who may see which models, fields and rows. It fails closed: a role sees only the models its `allow.models` patterns match, minus its denials. Anything not granted is hidden, so a forgotten model is invisible rather than exposed. Format details are in `spec.md`.

Run this phase after the important models are approved, so you can name real tables and columns. Access is about what the semantic layer exposes to tools built on it; it does not change permissions in the database itself. Say so to the owner.

## The access interview

Batch it like the rest of the interview: numbered items, one topic each, each with a suggestion, except the default-role question, which is asked open; up to about 8 per message. The roles, models, attributes and values in this file's examples are illustrative, not defaults: the owner's answers decide. These are the topics:

1. **Who uses the data?** "Who will ask questions of this: analysts, sales reps, support, executives, customers, partners?" List each group and roughly how many people.
2. **Roles.** Group people who should see exactly the same things into one role. Fewer roles is better: "It sounds like there are three: analysts, sales reps and support. Is that right?" A user holds exactly one role, so a person who needs two views needs a role that covers both.
3. **The default.** Ask it open: "If a tool doesn't know someone's role, should they get the most limited view (support) or a wider one, such as the analyst view?" Note that the most limited role is the safe default, and state the concrete consequence of the owner's answer before recording it as `default_role`: "With analyst as the default, anyone whose role fails to load sees every region, refunds and the lake data." The owner's policy decides; do not steer it.
4. **What each role may see.** "Analysts see every approved model in the warehouse and the lake. Sales reps see orders and customers only." These become `allow.models` patterns over `source.model` names.
5. **What each role must never see.** Whole models ("support never sees payments"), single fields ("sales reps never see customer email"), and anything personal ("only analysts see personal details").
6. **Row-level rules.** "Should a sales rep see every order, or only their region's?" For each yes, ask which column holds the value ("`ship_region`") and what fact about the user it compares to ("the region the rep covers"). That fact is a user attribute.

Use the profile to make row rules concrete: "`ship_region` has 4 values: `north` (3,100 orders), `south`, `east`, `west`. Is a rep assigned one of those?"

Once the roles are named, one item per role can carry a fill-in template. The bracketed values are your guesses, each grounded in a fact the owner gave or the profile shows; the owner corrects or confirms each line, and the per-role readback that follows is the gate, not this reply:

> **3. Sales reps.** My guesses in brackets, from what you said about reps and the `ship_region` values; correct each line.
> - May see: [orders, customers, regions]
> - Never sees: [customer email and phone]
> - Rows limited to: [orders shipped to the rep's region]
> - When a rep looks at customers alongside orders: [keep every order of their region, with customer details blank for customers outside it]

### "Totals only"

There is no aggregates-only grant. When the owner wants a role to see a model only as totals ("marketing sees order revenue, never single orders"), approximate it: with `deny.fields`, deny the dimension that exposes the primary key (for example `warehouse.orders.order_id`), if there is one, and every row-identifying dimension (email, exact timestamps), keep only coarse dimensions, and write the finest grain the role may use in its description ("by status, region and month; never by day or by order"). Tell the owner that a downstream tool must honour the description, and record the gap in `open_questions`.

## Tags for personal data

During the interview you tagged identifying columns `pii` (`email`, `phone`, `address`, `date_of_birth`, government IDs, free-text notes that may hold names). Check the approved models for untagged ones before writing access: search dimension names and descriptions, and look at top values for anything that looks like a person. Add `tags: [pii]` in the model YAML, then deny the tag for every role that must not see it:

```yaml
deny:
  tags: [pii]
```

A tag denial hides every dimension, measure and model carrying the tag, in every source, including ones added later. Prefer it to listing fields one by one. Other tags work the same way, for example `finance` for margin and cost columns.

## User attributes and row filters

A user attribute is a fact the calling tool knows about each user. Declare it once, with a type:

```yaml
user_attributes:
  - name: region
    type: string            # string | number | string_list | number_list
    description: The sales region a rep covers.
  - name: account_ids
    type: number_list
    description: The customer accounts a partner manages.
```

A row filter is a SQL predicate over one model's own columns. `{{ user.<attribute> }}` is bound as a query parameter, never pasted into SQL text, and a `_list` attribute binds as a list for `in`:

```yaml
row_filters:
  - model: warehouse.orders
    expr: ship_region = {{ user.region }}
  - model: warehouse.customers
    expr: account_id in {{ user.account_ids }}
```

A row filter names only its model's own columns: no join references, subqueries or other tables. A row filter on a related model limits that model's rows. On a left join it blanks the joined columns and keeps every row of the base model; it drops base rows only on an inner join. To limit the base model by a related value, filter a column of the base model, make the join inner (read back what that does to every query), or ask for a view that carries the column.

Several filters on one model in one role combine with `and`. Where a filter goes depends on the model's place in the query:

- On the query's **base model** (the model of the first measure), the filter goes in `where`: rows outside it are gone from every figure.
- On a **joined model**, the filter goes in that join's `on` clause. On a `left` join the left row stays and the joined columns come back empty for rows outside the filter; on an `inner` join the left row is dropped.

So for a sales rep with filters on both `orders` (`ship_region`) and `customers` (`home_region`), revenue by customer counts every order shipped to the rep's region, and orders whose customer lives elsewhere show with blank customer details, as long as `orders.customer` is a left join. Say which applies in the readback, with a count from the data where you can ("31 orders ship to a different region than their customer's home region"). If the owner wants such rows dropped instead, the join must be `inner`, which changes every query that uses it; read that consequence back too.

### Definition joins

A join that a measure `filter` or a dimension `expr` reads through (`customer.is_test_account` in revenue's filter, `ship_to_region.region_name` in a dimension) is part of that field's definition, not something the request names. The compiler applies it whenever the field is used, whatever the role may see, and joins it without the target's row filters. So:

- A sales rep's row filter on `customers` never blanks `customer.is_test_account` inside revenue: test accounts stay out of the rep's revenue, while a `customers.region` the rep groups by still shows blank for customers outside the region. No helper model over the same table is needed to keep a row filter away from a rule.
- A role that may not see `warehouse.customers` still gets revenue without test accounts.
- Role visibility governs only what a request may name: models, dimensions, measures, and joins to reach other models' fields.

A dimension shows values of the model it reads through, so `sl validate` warns when a role is allowed a dimension whose `expr` reads through a join to a model the role is not allowed or is denied, for example sales reps allowed `orders.ship_region_name`, which reads `regions` through the `ship_to_region` join. Settle each warning with the owner: allow the target model, or deny the dimension with `deny.fields`. A measure filter does not warn, because it shows no values of the joined model.

A dimension that reads through a join to a model the role may see but row-filters shows that model's values for every row, because the definition join carries no row filter; `sl validate` does not warn. For each role with a row filter, check the dimensions of its other models that read the filtered model, and deny each one with `deny.fields` or read the consequence back.

A row filter whose user attribute the user lacks returns no rows of that model; the compiler enforces it, so a row filter's `expr` does not test for a missing value. Say so in the readback.

## Writing access.yaml

Write the file yourself with `status: draft`:

```yaml
status: draft
default_role: support
user_attributes:
  - name: region
    type: string
    description: The sales region a rep covers.
roles:
  - name: analyst
    description: Analysts on the data team. Every approved model, without personal details.
    allow:
      models: ["warehouse.*", "lake.*"]
    deny:
      tags: [pii]
  - name: sales_rep
    description: Sales reps. Orders and customers in their own region, without customer email.
    allow:
      models: ["warehouse.orders", "warehouse.customers"]
    deny:
      fields: [warehouse.customers.email]
    row_filters:
      - model: warehouse.orders
        expr: ship_region = {{ user.region }}
      - model: warehouse.customers
        expr: home_region = {{ user.region }}
    open_questions:
      - Should reps also see refunds for their region? Owner to check with Sales (Lee).
  - name: support
    description: Support agents. Order status only, no revenue or personal details.
    allow:
      models: ["warehouse.orders"]
    deny:
      fields: [warehouse.orders.revenue]
      tags: [pii]
```

- `allow.models` uses scope patterns over `source.model`: `warehouse.*` is every model in a source, `warehouse.fct_*` a prefix, `*.orders` the orders model in every source.
- Denials subtract from what `allow` grants: `deny.models`, `deny.fields` (`source.model.field`) and `deny.tags`.
- `deny.fields` names dimensions and measures only, never a join. A join is hidden from a role when its target model is not allowed or is denied for that role: to stop sales reps reaching customers through `orders.customer`, leave `warehouse.customers` out of their `allow.models` or add it to `deny.models`. `sl validate` says so when a join is named in `deny.fields`. A hidden join still serves the definitions that read through it (see Definition joins).
- `open_questions`, at the top level and on each role, holds what is still unsettled about access, such as notes for tool builders ("A downstream tool must not show sales reps single orders by hour"). `sl status` counts them. Read them back with the whole file. Approval may stand with open questions that are notes for tool builders or are waiting on someone; list them in the handoff. Delete the ones the owner has answered, writing the answer where it belongs. Writing the answer into roles, patterns, denials or row filters is a change (see Readback); only the question's own deletion or addition is not.
- Avoid `*` alone as an allow pattern; name sources so a new source is not exposed by accident.

Run `sl validate`; it checks that every referenced model, field and attribute exists.

## Readback

Read each role back as what its members can and cannot see, with the row rule in words, including what happens when a filtered model is joined:

> "Sales reps see orders and customers only. They never see customer email. They see only orders shipped to the region they cover, and only customers whose home region it is. When they look at customers alongside orders, every one of those orders is still counted; customers outside their region show with blank details. Someone with no region sees no orders. Approve?"

Then the whole file, with the default and its consequence, and every change settled along the way (a model added to a role, a join made inner, a new denial): "Three roles: analysts, sales reps and support. Anyone without a role is treated as support, so they see order status only. Since the per-role readbacks we added regions to sales reps. Every other table is hidden from everyone until we add it here. Approve?"

Any change after the per-role readbacks, however small, means the whole-file readback comes again before `sl approve --target access`. A change is a change to roles, patterns, denials, row filters, user attributes or the default; an edit to comments only is not one, and neither is deleting an answered open question or adding a new one. Mention such an open-question edit in your next message to the owner. Writing the answer into roles, patterns, denials or row filters is a change; only the question's own deletion or addition is not.

After an explicit yes:

```
sl approve --target access --by "Dana Ruiz"
sl validate
```

Approval covers the whole file. Any later change (a new role, a widened pattern, a new source) needs a new approval; deleting an answered open question or adding one does not, and you mention it in the next message, but writing its answer into a role is a change. For a change: run `sl approve --target access --revoke`, edit the file, and read the whole file back before approving again.

A role often relies on fields that are still draft (marketing's agreed breakdown by `orders.status`). Before approving access, check each role's agreed breakdowns against `draft_fields` in `sl status --json`; read those fields back and approve them, or name them in the handoff.

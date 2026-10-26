# Access rules

`access.yaml` says who may see which models, fields and rows. It fails closed: a role sees only the models its `allow.models` patterns match, minus its denials. Anything not granted is hidden, so a forgotten model is invisible rather than exposed. Format details are in `spec.md`.

Run this phase after the important models are approved, so you can name real tables and columns. Access is about what the semantic layer exposes to tools built on it; it does not change permissions in the database itself. Say so to the owner.

## The access interview

Ask one topic at a time, offering a default each time.

1. **Who uses the data?** "Who will ask questions of this: analysts, sales reps, support, executives, customers, partners?" List each group and roughly how many people.
2. **Roles.** Group people who should see exactly the same things into one role. Fewer roles is better: "It sounds like there are three: analysts, sales reps and support. Is that right?" A user holds exactly one role, so a person who needs two views needs a role that covers both.
3. **The default.** "If we don't know someone's role, what should they see?" Suggest the most restricted role, and record it as `default_role`.
4. **What each role may see.** "Analysts see every approved model in the warehouse and the lake. Sales reps see orders and customers only." These become `allow.models` patterns over `source.model` names.
5. **What each role must never see.** Whole models ("support never sees payments"), single fields ("sales reps never see customer email"), and anything personal ("only analysts see personal details").
6. **Row-level rules.** "Should a sales rep see every order, or only their region's?" For each yes, ask which column holds the value ("`ship_region`") and what fact about the user it compares to ("the region the rep covers"). That fact is a user attribute.

Use the profile to make row rules concrete: "`ship_region` has 4 values: `north` (3,100 orders), `south`, `east`, `west`. Is a rep assigned one of those?"

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

Several filters on one model in one role combine with `and`. A filter on a model also applies whenever that model is joined into a query, so restricting `orders` also restricts any question that joins to orders. Point this out in the readback. Ask what should happen to a user whose attribute is missing; the safe answer is that they see no rows, and the calling tool must enforce it.

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
- Avoid `*` alone as an allow pattern; name sources so a new source is not exposed by accident.

Run `sl validate`; it checks that every referenced model, field and attribute exists.

## Readback

Read each role back as what its members can and cannot see, with the row rule in words:

> "Sales reps see orders and customers only. They never see customer email. They see only orders whose shipping region matches the region they cover, and that also limits any question that combines customers with orders. Someone with no region sees no orders. Right?"

Then the whole file: "Three roles: analysts, sales reps and support. Anyone without a role is treated as support. Every other table is hidden from everyone until we add it here. Shall I approve the access rules?"

After an explicit yes:

```
sl approve --target access --by "Dana Ruiz"
sl validate
```

Approval covers the whole file. Any later change (a new role, a widened pattern, a new source) needs a new approval: edit the file, set `status: draft`, remove `approved_by` and `approved_at`, and read the change back before approving again.

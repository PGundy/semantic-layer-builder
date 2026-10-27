# Access rules

`access.yaml` says who may see which models, fields, metrics and rows. Format details are in `spec.md`.

Access is open by default. In `mode: open`, and with no `access.yaml` at all, everyone sees every **approved** model, dimension, measure and metric, except:

- items tagged `pii` or `sensitive` (protected tags; a model's tag covers all its fields), unless a role the user holds lists the tag in `allow.tags`;
- the targets of `restrictions`, unless the user holds one of the restriction's `allow.roles` or satisfies its `allow.when`;
- what the roles the user holds deny.

Draft items are never exposed, in either mode. In `mode: closed` the layer is an allowlist: a user sees only what `allow.models` of a role they hold matches, minus the same denials, protected tags and restrictions, and every role needs `allow.models`. `allow.models` has no effect in open mode, and `sl validate` warns when it is set there.

So approving a model is also deciding that everyone may see it. The interview carries that through: every table readback in open mode says "everyone will be able to see this once approved; is that right?" (`interview-guide.md`), and a no there is an access exception you write down at once (Exceptions found during the interview).

Run the access phase after the important models are approved, so you can name real tables and columns. Access is about what the semantic layer exposes to tools built on it; it does not change permissions in the database itself. Say so to the owner. `sl status` holds `next_step` at `access` until `access.yaml` exists and is approved, even when the answer is "everyone sees everything": an approved `access.yaml` with `mode: open` and no roles is a complete access phase, and it records that the owner said so.

## Draft and approved access

Tools serve only an approved `access.yaml`. A tool that loads an `access.yaml` in draft serves nothing and says access is awaiting sign-off. So a change to access is edited in version control (a branch or the working copy) while the approved version that is deployed keeps applying, and it reaches users only once the new version is approved and deployed. `sl access` still explains a draft file, labelled as a draft awaiting sign-off, so you can read it back before approval. Tell the owner which applies:

- A first `access.yaml`, still a draft: "Until you approve it, tools that read this file serve nothing."
- A revoke to edit an approved file: "The last approved version keeps applying where it is deployed until you approve the new one." Never say "nobody is shown anything" without saying under which version. The revoke keeps the sign-off as `last_approved: { by, at }`, and on such a draft `sl access` says "This explains a draft. The version approved by <by> on <at> keeps applying where it is deployed; tools that load this draft serve nothing."

## The access interview

Start from the exceptions, not from a list of roles. Batch it like the rest of the interview: numbered items, one topic each, each with a suggestion, except the default-role question, which is asked open; up to about 8 per message. The roles, models, attributes and values in this file's examples are illustrative, not defaults: the owner's answers decide. The topics, in order:

1. **Exceptions.** "Once a table is approved, everyone who uses these tools can see it. Is there anything some people should not see?" Suggest from the layer: the columns tagged `pii` or `sensitive`, money that looks like pay or margin, tables the owner hesitated over in the interview. When the answer is "nothing", write `access.yaml` with `status: draft`, `mode: open` and no roles, read the open baseline back (Readback) and approve it. When most of the layer is an exception ("only finance should see most of this", a layer shared with customers or partners), suggest `mode: closed`, where nothing is visible unless a role allows it.
2. **Protected tags.** Confirm every `pii` and `sensitive` tag, and who may see each (Protected tags).
3. **Roles from attributes.** For each group that should see more (a protected tag, a restriction) or less (a denial, fewer rows), a role, held by an attribute the calling tool knows about the user (Roles).
4. **The default.** Ask it open (Roles, The default role).
5. **Restrictions on metrics and fields.** "Are there figures only some people should see: margin, salaries, the board's numbers?" (Restrictions).
6. **What a role must never see.** Whole models ("support never sees payments"), single fields ("sales reps never see discount rates"), or a tag, as the role's `deny`.
7. **Row-level rules.** "Should a sales rep see every order, or only their region's?" "Should a manager see only their own team's tickets, including people further down?" (Row filters, Span of control). Then, for each row-filtered model, list every model with a to-one join into it (order lines, refunds, shipments) and settle each one (Child tables).
8. **The readback with `sl access`**: what the default audience and each role see, before the whole-file readback (Showing the owner what people see).

Use the profile to make row rules concrete: "`ship_region` has 4 values: `north` (3,100 orders), `south`, `east`, `west`. Is a rep assigned one of those?"

Once the roles are named, one item per role can carry a fill-in template. The bracketed values are your guesses, each grounded in a fact the owner gave or the profile shows; the owner corrects or confirms each line, and the per-role readback that follows is the gate, not this reply:

> **3. Sales reps.** My guesses in brackets, from what you said about reps and the `ship_region` values; correct each line.
> - Who: [everyone whose department is `sales`]
> - Sees beyond everyone: [nothing extra]
> - Never sees: [refunds; the discount rate]
> - Rows limited to: [orders shipped to the rep's region]
> - When a rep looks at customers alongside orders: [keep every order of their region, with customer details blank for customers outside it]
> - Tables that hang off orders: [order lines limited through their order; refunds hidden]

### Exceptions found during the interview

When the owner says no to "everyone will be able to see this once approved; is that right?", or names a column only some people may see, write the exception down: a `pii` or `sensitive` tag on the field or model in the model file, or a restriction or a role's denial in `access.yaml` (create it with `status: draft` and `mode: open` if it does not exist yet, and say that tools serve nothing under it until it is approved; see Draft and approved access). Do it before you run `sl approve` on the table or field, and check with `sl access` that the default audience sees it hidden for a reason other than `draft` (`protected_tag`, `restricted` or `denied`); before approval everything is hidden as `draft`, which proves nothing. The table's definition can still be approved; the exception decides who sees it.

### "Totals only"

There is no aggregates-only grant. When the owner wants a role to see a model only as totals ("marketing sees order revenue, never single orders"), approximate it: with `deny.fields`, deny the dimension that exposes the primary key (for example `warehouse.orders.order_id`), if there is one, and every row-identifying dimension (email, exact timestamps), keep only coarse dimensions, and write the finest grain the role may use in its description ("by status, region and month; never by day or by order"). Tell the owner that a downstream tool must honour the description, and record the gap in `open_questions`.

## Protected tags

`pii` and `sensitive` are protected in both modes: a model, dimension or measure carrying either is hidden from everyone unless a role they hold lists that tag in `allow.tags`. A tag on a model covers all its fields.

- `pii` is for anything that identifies a person: `email`, `phone`, `address`, `date_of_birth`, government IDs, free-text notes that may hold names.
- `sensitive` is for what is not identifying but not for everyone: pay (`salary`, `bonus`, `comp_band`), bank and card details, health, secrets and tokens, free text (`notes`, `comment`, `message`), and near-unique text that is not a key.
- `public` records that the owner confirmed everyone may see a field although it looks sensitive (a support queue's `notes` that hold only product names). It never overrides `pii` or `sensitive` on the same field: replace the tag, do not add to it.

`sl draft` tags `pii` or `sensitive` by name on the columns it drafts, each with an open question. A text column that is not a key and differs on nearly every row (the profile rule) is left out and listed in `ignored_columns`, with an open question naming the tag to add if the owner wants it as a field. `sl draft --new-columns` does the same for new columns. Never write a value of a `pii` or `sensitive` column (a person's name, an email) into a description, a synonym, a golden question or a golden reference: descriptions are visible to everyone the item is. Use the id or a count ("rep 301", "16 reps"). `sl validate` warns when such text holds one of the column's top values from the profile. `sl profile` stores the top values of a protected column (tagged, listed in `ignored_columns`, or looking personal or sensitive by name or by being near-unique text) only as hashes, with no text `min` or `max` (`spec.md`, Profiles of protected columns), and the check hashes every run of 1 to 4 words of the text, so a quoted name is still caught. When a column is tagged after it was profiled, `sl validate` warns until `sl profile --source <s> --redact` rewrites its profile. A golden's `expected.rows` are not checked: they are the answer as the golden's role, which may see the column. Before writing access, read every tag back as one item per tag ("These 6 columns are tagged personal: `customers.email`, `customers.phone`, ... Hidden from everyone unless a role is allowed them. Which people may see them?"), and check the approved models for untagged ones: search dimension names and descriptions, and look at top values for anything that looks like a person. `sl validate` warns about an approved field the default audience can see that looks sensitive and carries no `pii`, `sensitive` or `public` tag: "`<field>` is visible to everyone and looks sensitive (<reason>); tag it pii or sensitive, or tag it public if everyone may see it". Settle every such warning with the owner; none of them stands without an answer.

Grant a tag to the roles that may see it:

```yaml
roles:
  - name: people_team
    assign_when: user.department == 'hr'
    allow:
      tags: [pii, sensitive]
```

Other tags (`finance`) hide nothing by themselves. A role can still deny any tag with `deny.tags`, which hides every dimension, measure and model carrying it, in every source, including ones added later; prefer it to listing fields one by one.

## Roles

A role groups people who get the same exceptions. A user may hold several roles, and an item is visible when any role they hold makes it visible. A role is held:

- when the identity system assigns it by name (the calling tool passes role names), or
- when its `assign_when` condition is true for the user's attributes.

Prefer `assign_when` over an attribute the calling tool already knows (`user.department == 'finance'`), so nobody maintains a list of names; ask the owner which attributes their login or HR system carries. Fewer roles is better: "It sounds like there are three exceptions: HR sees personal details, finance sees margin, sales reps see only their region. Is that right?" A role that grants, denies and filters nothing is not harmless: holding it gives every row of every model and lifts the denials of the user's other roles (an item or row is visible when any held role shows it), and it keeps `default_role` from applying. Leave it out, and never make a role of a group everyone belongs to ("staff", "employee"). A role whose only job is to be named in a restriction's `allow.roles` is such a role: give the restriction an `allow.when` over the same attribute instead (`allow.when: user.department == 'finance'`), and pin it with a golden whose `user` holds that attribute (`verification.md`).

### Conditions

`assign_when` and a restriction's `allow.when` are conditions over user attributes, never SQL:

- comparisons: `user.department == 'finance'`, `user.level >= 7`, `user.country != 'US'`;
- lists: `user.region in ['north', 'south']`, `user.cost_centers contains 'cc_100'` on a list attribute;
- presence: `user.employee_id is set`, `user.region is not set`;
- `and`, `or`, `not` and parentheses: `user.department == 'sales' and user.region is set`.

A comparison, `in`, `not in` or `contains` on an attribute the user lacks is false, and so is a comparison or `in` on a value of the wrong type. `not` reverses that and `is not set` is true for a missing attribute, so a grant using either one is true for a user the tool knows nothing about. Pair it with a presence test (`user.department is set and not (user.department == 'contractor')`) and check the default audience with `sl access`. Every attribute a condition reads must be declared in `user_attributes`; `sl validate` errors otherwise, and warns on a test that is false for every user because of the attribute's type.

### The default role

`default_role` applies only when the user holds no other role. Without one, a user with no role in open mode sees the open baseline with no row filters. Ask it open: "When a tool doesn't know anything about someone, should they see what everyone sees, or something narrower, such as only the sales reps' view?" Note that the most limited view is the safe default, and state the concrete consequence of the owner's answer before recording it: "With no default role, anyone whose login carries no department sees every approved table except personal details and the finance figures." The owner's policy decides; do not steer it.

## Restrictions

A restriction limits metrics and fields to some people, in both modes, after role visibility:

```yaml
restrictions:
  - name: finance_figures
    description: Margin and net revenue stay with finance and the executive team.
    targets: ["metric:net_revenue", "warehouse.orders.margin"]
    allow:
      when: user.department == 'finance' or user.level >= 8
```

- `targets` are `metric:<name>`, `source.model` or `source.model.field`, with scope-pattern globs (`metric:margin_*`, `warehouse.payroll.*`).
- A target is visible only to users who hold one of `allow.roles` or satisfy `allow.when`; give at least one of the two. Prefer `allow.when` when an attribute says who may see it; name `allow.roles` only for a role that exists for other reasons too.
- A metric is visible only when the metric itself is visible and every measure it uses is visible: restricting `orders.margin` also hides every metric built on it, which `sl access` reports as `measure_hidden:orders.margin`. Say so in the readback.
- A request may never name a hidden field anywhere: selected, grouped, filtered or sorted. A user who may not see `orders.margin` cannot filter on it either.

Prefer a restriction to a denial on every role when one group alone may see something: it is one place to read back, and a new role does not see it by accident.

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

A row filter is a SQL predicate over one model's rows. `{{ user.<attribute> }}` is bound as a query parameter, never pasted into SQL text, and a `_list` attribute binds as a list for `in`:

```yaml
row_filters:
  - model: warehouse.orders
    expr: ship_region = {{ user.region }}
  - model: warehouse.customers
    expr: account_id in {{ user.account_ids }}
```

A row filter reads its model's own columns and join references, `<join>.<column>` or `<join>.<join>.<column>`, through one or two `many_to_one` or `one_to_one` joins of the filtered model itself; never a subquery or another table's name. The joins it reads through are definition joins: the compiler adds them without their targets' row filters, whatever the role may see. So order lines, which carry no rep column, are limited through their order:

```yaml
row_filters:
  - model: warehouse.order_items
    expr: order.ship_region = {{ user.region }}
```

A row filter on a related model limits that model's rows. On a left join it blanks the joined columns and keeps every row of the base model; it drops base rows only on an inner join. To limit the base model by a related value, give the base model a row filter that reads it through a join reference (`customer.home_region = {{ user.region }}` on orders), make the join inner (read back what that does to every query), or ask for a view that carries the column.

Several filters on one model in one role combine with `and`. Across roles they combine as a union: a user sees the rows any role they hold allows on that model, and a role they hold with no row filter on that model contributes every row. So someone who is both a sales rep (filtered to their region) and on the people team (no filter on orders) sees every order. In open mode a user who holds no role sees every row; a row filter limits only the people whose roles all filter that model. When rows must be limited for everyone, say so, and offer a `default_role` that carries the filter, together with the same filter on every other role that reaches the model, or `mode: closed`; read back who still sees every row.

Where a filter goes depends on the model's place in the query:

- On the query's **base model** (the model of the first measure), the filter goes in `where`: rows outside it are gone from every figure.
- On a **joined model**, the filter goes in that join's `on` clause. On a `left` join the left row stays and the joined columns come back empty for rows outside the filter; on an `inner` join the left row is dropped.

So for a sales rep with filters on both `orders` (`ship_region`) and `customers` (`home_region`), revenue by customer counts every order shipped to the rep's region, and orders whose customer lives elsewhere show with blank customer details, as long as `orders.customer` is a left join. Say which applies in the readback, with a count from the data where you can ("31 orders ship to a different region than their customer's home region"). If the owner wants such rows dropped instead, the join must be `inner`, which changes every query that uses it; read that consequence back too.

A row filter whose user attribute the user lacks returns no rows of that model; the compiler enforces it, so a row filter's `expr` does not test for a missing value. Say so in the readback.

### Child tables

A row filter limits only its own model. A model that reaches a row-filtered model through a to-one join (order lines, refunds and shipments under orders) has rows that belong to the filtered model's rows, but a role sees all of them unless that model is settled too. For each row-filtered model, list every model with a `many_to_one` or `one_to_one` join into it, one or two hops away, and settle each one with the owner, with a count from the data where you can ("a rep sees 1,418 of the 12,343 order lines once they are limited through their order"):

- a row filter of its own that reads the filtered model through its join (`order.ship_region = {{ user.region }}`, or a hierarchy whose `column` is `order.sales_rep_id`);
- deny the model to the role (`deny.models`);
- or record why it stays unfiltered in the role's `open_questions`, naming the model.

`sl validate` warns until each is settled: "rows of <N> that belong to <M> are not limited by <M>'s row filter for role <R>; add a row filter on <N> (it may read <join>.<column>), deny <N> to <R>, or record why in the role's open_questions". A role's `open_questions` entry naming the model silences it.

### Span of control

"A manager sees their own team's rows, including people further down" is a hierarchy row filter. Ask for three things:

1. **The column** of the filtered model that holds a person's id ("`assignee_id` on tickets is the agent who owns it"). A model with no such column of its own reads it through a to-one join as a join reference (`column: ticket.assignee_id` on ticket comments, `order.sales_rep_id` on order lines), joined without the target's row filters.
2. **The user's own id** as a user attribute the calling tool knows (`employee_id`), matching the values in that column.
3. **A closure table**: one row per manager and member pair at any depth, so a director is paired with everyone below them, not only their direct reports. Ask whether one exists (HR systems often have one). When the source has only a `manager_id` column on the employees table, ask the owner's engineers for a view; on a DuckDB source it can go in `connection.views`. Describe it to them like this:

```sql
-- one row per (manager_id, member_id) pair at any depth below the manager
create view reporting_lines as
with recursive lines (manager_id, member_id) as (
  select manager_id, employee_id from employees where manager_id is not null
  union all
  select l.manager_id, e.employee_id from lines l join employees e on e.manager_id = l.member_id
)
select manager_id, member_id from lines;
```

Model the closure table like any other (grain: one row per manager and member pair), approve it, and settle who may see it as a model: in open mode everyone could browse the org chart through it, so ask, and tag it `sensitive` or restrict it if not. Then write the filter:

```yaml
row_filters:
  - model: warehouse.tickets
    hierarchy:
      column: assignee_id
      via: warehouse.reporting_lines
      manager: manager_id
      member: member_id
      user: user.employee_id
      include_self: true        # the default: the manager's own tickets count too
```

The compiler renders it as `assignee_id = :user_id or assignee_id in (select member_id from reporting_lines where manager_id = :user_id)`, with the user's id bound as a parameter, and reads the closure model without its own row filters. A user without `employee_id` sees no tickets, as with any row filter. `sl validate` checks that the closure model is a model of the same source, that the columns exist, and that the attribute is declared and holds one value. Read it back with a real count: "Priya manages 14 people, 9 of them through her two team leads; she sees their 1,240 open tickets and her own."

### Definition joins

A join that a measure `filter` or a dimension `expr` reads through (`customer.is_test_account` in revenue's filter, `ship_to_region.region_name` in a dimension) is part of that field's definition, not something the request names. The compiler applies it whenever the field is used, whatever the role may see, and joins it without the target's row filters. So:

- A sales rep's row filter on `customers` never blanks `customer.is_test_account` inside revenue: test accounts stay out of the rep's revenue, while a `customers.region` the rep groups by still shows blank for customers outside the region. No helper model over the same table is needed to keep a row filter away from a rule.
- A role that may not see `warehouse.customers` still gets revenue without test accounts.
- Role visibility governs only what a request may name: models, dimensions, measures, and joins to reach other models' fields.

A dimension shows values of the model it reads through, so `sl validate` warns when a role is allowed a dimension whose `expr` reads through a join to a model the role is not allowed or is denied, for example sales reps allowed `orders.ship_region_name`, which reads `regions` through the `ship_to_region` join. Settle each warning with the owner: allow the target model, or deny the dimension with `deny.fields`. A measure filter does not warn, because it shows no values of the joined model.

A dimension that reads through a join to a model the role may see but row-filters shows that model's values for every row, because the definition join carries no row filter; `sl validate` does not warn. For each role with a row filter, check the dimensions of its other models that read the filtered model, and deny each one with `deny.fields` or read the consequence back.

## Writing access.yaml

Write the file yourself with `status: draft`:

```yaml
status: draft
mode: open
user_attributes:
  - name: department
    type: string
    description: The user's department, from the login system.
  - name: region
    type: string
    description: The sales region a rep covers.
  - name: level
    type: number
    description: The user's job level; 8 and above is the executive team.
  - name: employee_id
    type: number
    description: The user's own employee id, as in tickets.assignee_id.
roles:
  - name: people_team
    description: HR. Also sees personal details and pay.
    assign_when: user.department == 'hr'
    allow:
      tags: [pii, sensitive]
  - name: sales_rep
    description: Sales reps. Only orders, order lines and customers in their own region, and no refunds.
    assign_when: user.department == 'sales'
    deny:
      models: [warehouse.refunds]
    row_filters:
      - model: warehouse.orders
        expr: ship_region = {{ user.region }}
      - model: warehouse.order_items
        expr: order.ship_region = {{ user.region }}
      - model: warehouse.customers
        expr: home_region = {{ user.region }}
    open_questions:
      - Should reps also see refunds for their region? Owner to check with Sales (Lee).
  - name: support_manager
    description: Support managers. Only tickets of their own team, at any depth, and their own.
    assign_when: user.department == 'support' and user.employee_id is set
    row_filters:
      - model: warehouse.tickets
        hierarchy:
          column: assignee_id
          via: warehouse.reporting_lines
          manager: manager_id
          member: member_id
          user: user.employee_id
restrictions:
  - name: finance_figures
    description: Margin and net revenue stay with finance and the executive team.
    targets: ["metric:net_revenue", "warehouse.orders.margin"]
    allow:
      when: user.department == 'finance' or user.level >= 8
```

- `deny.models`, `deny.fields` (`source.model.field`) and `deny.tags` subtract from what the role would see; `allow.tags` grants protected tags. In closed mode, `allow.models` uses scope patterns over `source.model` (`warehouse.*` is every model in a source, `warehouse.fct_*` a prefix, `*.orders` the orders model in every source); avoid `*` alone, so a new source is not exposed by accident.
- `deny.fields` names dimensions and measures only, never a join. A join is hidden from a role when its target model is hidden from it: to stop sales reps reaching customers through `orders.customer`, add `warehouse.customers` to their `deny.models` (in closed mode, leave it out of their `allow.models`). `sl validate` says so when a join is named in `deny.fields`. A hidden join still serves the definitions that read through it (see Definition joins).
- A denial applies to the people who hold that role, and an item is visible when any role they hold shows it: a person who is both a sales rep and on the people team sees refunds through `people_team`. When something must be hidden from everyone in a group whatever else they hold, use a restriction: only its `allow.roles` or `allow.when` see the target, whatever other roles a person holds. Closed mode does not help, because there too an item is visible when any held role shows it. A protected tag works only while no role the group may also hold lists it in `allow.tags`.
- `open_questions`, at the top level and on each role, holds what is still unsettled about access, such as notes for tool builders ("A downstream tool must not show sales reps single orders by hour"). `sl status` counts them, and while a draft `access.yaml` holds any, its `next_step` waits on the owner's answers (`blocked_on: open_questions`, command `sl access`, `after_owner_yes: false`) and names the first question: raise the questions and never push the approval. Read them back with the whole file. Approval may stand with open questions that are notes for tool builders or are waiting on someone, when the owner approves with them named in the whole-file readback; list them in the handoff. Delete the ones the owner has answered, writing the answer where it belongs. Writing the answer into roles, patterns, denials or row filters is a change (see Readback); only the question's own deletion or addition is not.

Run `sl validate`; it checks that every referenced model, field, role and attribute exists and that every condition parses.

## Showing the owner what people see: `sl access`

`sl access` explains what one user sees: the roles they hold and why (`assigned`, `condition`, `default`), per source the visible and hidden models, fields and metrics with the reason each is hidden, and the row filters that apply per model with the attribute values they bind (shown, never pasted into SQL), or "no rows" when an attribute is missing.

```
sl access
sl access --roles people_team
sl access --user '{"department": "sales", "region": "north"}'
sl access --user '{"department": "finance"}'
sl access --user '{"department": "support", "employee_id": 1042}' --show all
sl access --user-file <scratch>/priya.json --roles support_manager
```

With no `--user` and no `--roles` it explains the default audience: a user with no attributes and no assigned roles. Plain output gives the visible counts across all sources, on the line "Items visible across N source(s) (row filters limit rows, not these counts)", and per source on each `Source <s>:` line; those counts are the tool's, not something to read back. Each source always prints its row filters, as "row filters: none (every row of every visible model)" when none applies, and the user line names assigned roles only when `--roles` was given. `--show hidden` is the default for plain output; `--show visible` or `--show all` lists the rest, and `--json` carries everything. Keep `--user-file` files in your scratch space, outside the semantic root: they describe real people.

Translate each reason for the owner:

| Reason | Say |
|---|---|
| `draft` | "Not approved yet, so no one sees it." |
| `protected_tag:pii` | "Personal details: hidden unless a role is allowed them." |
| `denied:sales_rep` | "Sales reps are kept from it." |
| `restricted:finance_figures` | "Only finance and the executive team see it." |
| `not_allowed` | "No role this person holds lists it (closed mode)." |
| `measure_hidden:orders.margin` | "Hidden because it is built on margin, which this person cannot see." |

Run it for the default audience first, then once per role with realistic attributes, and use the plain output as the readback, describing what each audience sees by naming what is hidden from it, not by counts of tables and fields, which the owner cannot check: "Anyone the tool knows nothing about sees every approved table except these: customers' email, phone and address, salaries, and margin and net revenue." A golden can later pin what a role sees (`verification.md`).

## Readback

Read each role back as what its members can and cannot see compared with everyone else, with how someone comes to hold it and the row rule in words, including what happens when a filtered model is joined:

> "Sales reps are everyone whose department is sales. They see what everyone sees, except refunds, and only orders shipped to the region they cover, the lines of those orders, and only customers whose home region it is. When they look at customers alongside orders, every one of those orders is still counted; customers outside their region show with blank details. Someone with no region sees no orders. Someone who also holds the people team role sees every order. Approve?"

When the change moves the mode (open to closed, or closed to open), say the old and new mode and who gains or loses visibility, naming the users who hold no role: "Access moves from closed to open. Today someone with no role, such as marketing or anyone whose login carries no department, sees nothing; once approved, they see every approved table except personal details and the finance figures."

Then the whole file, with the mode, what is hidden from the default audience (`sl access`) and the default role's consequence, every restriction, and every change settled along the way (a model denied to a role, a join made inner, a new restriction): "Access is open: once approved, a table is visible to everyone, except personal details and pay, which only HR sees, and margin and net revenue, which only finance and the executive team see. Three roles change that: ... Anyone the tool knows nothing about sees the open view with every row. Since the per-role readbacks we added refunds to the sales reps' denials. Approve?" With no exceptions, the whole file is one sentence: "Access is open with no exceptions: everyone who uses these tools sees every approved table, field and metric, except personal details, which no one sees. Approve?"

The per-role readbacks and the whole-file readback may share one message as separate "Approve?" items, the whole file last; a no or a correction to any of them voids the yes to the whole file. Any change after the per-role readbacks, however small, means the whole-file readback comes again before `sl approve --target access`. A change is a change to the mode, roles, patterns, tags, denials, restrictions, row filters, user attributes or the default; an edit to comments only is not one, and neither is deleting an answered open question or adding a new one. Mention such an open-question edit in your next message to the owner. Writing the answer into roles, patterns, denials or row filters is a change; only the question's own deletion or addition is not.

After an explicit yes:

```
sl approve --target access --by "Dana Ruiz"
sl validate
```

Approval covers the whole file. Any later change (a new role, a new restriction, a tag granted, a new source in closed mode) needs a new approval; deleting an answered open question or adding one does not, and you mention it in the next message, but writing its answer into a role is a change. For a change: run `sl approve --target access --revoke`, edit the file, and read the whole file back before approving again. Tell the owner, when you revoke, that the last approved version keeps applying where it is deployed until the new one is approved (Draft and approved access); while you rewrite, each table readback says who will see the table under the draft file. A new model or field approved later needs no new access approval in open mode, but its own readback says that everyone will be able to see it.

A role often relies on fields that are still draft (marketing's agreed breakdown by `orders.status`). Before approving access, check each role's agreed breakdowns against `draft_fields` in `sl status --json`; read those fields back and approve them, or name them in the handoff.

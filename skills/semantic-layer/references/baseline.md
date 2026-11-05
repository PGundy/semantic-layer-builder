# Baseline: a first read of a source, for the owner to correct

`sl baseline` reads a source's snapshot and writes a brief: what each table probably is, what one row probably means, its keys and relationships, the numbers it could give, the ways it could be split, the columns that should not be splits, and the questions to ask the owner. It needs only the snapshot, so it works straight after a schema export is imported (`intake.md`, Schema export), and it sharpens when profiles and models exist. It reads no table data, writes nothing unless `--out` is given, and approves nothing.

Every line of the brief is a guess from names, declared keys and, when present, profiles. It opens the conversation; the owner's answers decide. Never write a guess from the brief into a model as fact, and never read a brief line back as something to approve.

```
sl baseline --source warehouse
sl baseline --source warehouse --tables fct_orders,dim_customers --json
sl baseline --source warehouse --out notes/baseline-warehouse.md
```

- Plain output is markdown suited to paste to the owner; `--json` carries the same structure for you to read.
- `--out` writes the markdown to a path resolved from the semantic root, never outside it. Keep it as a working note: nothing in the layer reads it, and a rerun replaces it.
- With no `--tables` it covers the in-scope tables (every table while no scope is set). When more than `focus_threshold` are in scope, it covers the top `focus_threshold` by the ranking `sl status` and `sl tables` use and says how many it left out, pointing at `sl scope`: that note is the scoping question (Phase 2).
- The brief names sensitive columns but never quotes their values (`SKILL.md`, Principle 8).

## When to run it

- Right after the first intake of a source, by any path (live, the agent's own SQL tool, an import): its short version is the "what you found" of the first message (`SKILL.md`, Phase 0).
- Before profiling, when the brief has a left-out note or more tables are in scope than `focus_threshold`: agree the focus first (`sl tables --source <s> --groups`, then `sl scope ... --write`, Phase 2), as `sl status` asks. Ignore the brief's closing `sl profile` and `sl draft` hint until then: it lists every unprofiled table the brief covered, staging tables included, and `sl draft` refuses while the source needs focus. Profile only the tables the owner scoped.
- After `sl profile`: keys, low-cardinality columns and near-unique strings are then measured rather than guessed from names. Rerun it before the first interview batch.
- After a rerun of `sl introspect` or `sl import` that added tables, for the new tables (`--tables`).
- When the owner widens scope, for the tables added.

## The opening message

Send a short plain-English version, not the whole brief: "Here is what I think your tables are; correct me." Keep to Principle 6: at most three lines of status, then numbered items, one topic each, up to about 8, each guess labelled as a guess with its reason, and the stop-or-continue line at the end. In the first message of a project the baseline items share that budget with the items Phase 0 adds: that the project name can be changed, the approver's name, and the scoping question, so keep the baseline to about five items there.

> Here is what I think your tables are, from the table and column names and the keys the database declares; correct me.
>
> 1. **Orders** (`fct_orders`, about 10,000 rows). My guess: one row per order, since `order_id` is the declared key. It looks like the main table of things that happen.
> 2. **Order lines** (`fct_order_items`). My guess: one row per product on an order. It sits under orders, so adding up order amounts after joining it would count each order once per line.
> 3. **Customers, products, regions**. My guess: they describe the orders (who bought, what, and where), since orders point at each of them.
> 4. **Looks like leftovers**: `dim_customers_archive` and `fct_orders_v2_test` look like an archive and a test copy. My guess: leave them out.
> 5. **Which date is "the" date for an order?** I see `created_at` and `shipped_at`. My guess: `created_at`, when the order was placed.
> 6. **Test or deleted rows**: `dim_customers` has `is_test_account`. Should orders from test accounts be left out of every figure?
> 7. **Project name and approver**: I called the project `acme`; you can change it by editing `name` in `semantic.yaml`. Which name should I record when you approve something?
> 8. **Focus**: you have 22 tables; I suggest starting with orders, order lines, refunds and the tables that describe them. Shall I preview that scope?
>
> Stop here or continue?

Translate the brief's words for an owner who is not technical: a fact table is "a table of things that happen (orders, refunds)", a dimension is "a table that describes them (customers, products)", a bridge is "a table that only links two others", a grain is "what one row is", and a fan-out warning is "this join would double count". Paste the full brief, or write it with `--out`, only when the owner asks for it.

## Reading each part

### Role

| Role | Plain words | What it leads to |
|---|---|---|
| `fact` | things that happen, counted and summed | the first tables to interview; ask what one row is |
| `dimension` | things the facts point at | its attributes become splits; ask which ones people use |
| `bridge` | a table that only links two others (manager and member, product and category) | ask whether each pair appears once; joining through it repeats rows |
| `event` | a stream of happenings with a time (page views, clicks) | ask which event types count and what a session is |
| `snapshot` | one row per thing per date (daily balances, stock levels) | a total across dates double counts; ask which date to read |
| `staging` | a raw or intermediate copy (`stg_`, `raw_`) | usually out of scope; ask which table replaces it |
| `noise` | backups, temporary and test copies, archives | propose leaving it out in scoping |

Each role comes with its reasons ("named `fct_`, two foreign keys, money columns"). Say the reason with the guess, so the owner can correct the reasoning as well as the label.

### Probable grain

"One row per <x>" is a guess from the key and the names. It becomes the first question about each table (`interview-guide.md`, What one row is). A composite key reads "one row per order and line number". Once the owner confirms it, it becomes the model's `grain` and goes into its `description`, and is read back with the table.

### Keys

A declared key comes from the catalog; a likely key comes from names (`order_id` on `orders`) and, with profiles, from a column that is different on every row and never empty. A likely key from names alone is a question, not a `primary_key`: profile the table, or ask "can one order appear more than once?".

### Relationships

Declared relationships come from foreign keys; inferred ones from matching names (`customer_id` on orders and on customers). Each carries a probable relationship (many orders to one customer) and, when a table is the many side of another fact (order lines under orders, refunds under orders), a fan-out warning. The warning is a guess like the rest: say "probably several lines per order, to be checked with `sl check-join`". Every relationship the owner keeps becomes a join in the draft model, and `sl check-join` measures it before its readback (Phase 6); the brief's relationship is never the evidence.

### The star-schema sketch

The source-level section lists the likely facts and the dimensions each joins. Use it to frame scoping ("orders, order lines and refunds are the things that happen; customers, products and regions describe them") and to propose the first batch. Ask about a dimension no fact reaches and a fact that reaches no dimension: either a relationship is missing from the catalog or the table is out of scope.

### Candidate measures

| In the brief | Becomes |
|---|---|
| Row count (`order_count`) | a `count` measure; ask which rows count (status values, test rows) |
| Sum of a money column, with its unit (`amount_cents`, cents) | a `sum` measure with the exact cents expression per dialect and `format: currency`; ask the currency and what the amount includes |
| Sum of a quantity (`quantity`) | a `sum` measure with `format: integer` |
| Distinct count of a foreign key (`customer_id`) | a `count_distinct` measure, named after its join (`customer_count`); say what it counts ("customers who ordered") |
| Share of a boolean flag (`is_gift`) | a `ratio` metric in `metrics.yaml`: a `count` measure filtered on the flag over the row count |
| Suggested ratio (a money sum over a row count: average order value) | a `ratio` metric, written once both measures are approved (Phase 7) |

`sl draft` writes most of the measures itself (sums, counts, distinct counts per join). Compare the brief with the draft: add what the draft left out, such as a filtered count for a share, as a draft measure by hand, and leave the metrics for Phase 7. The list is a menu for "which of these does the business report?", never a list to approve: each measure still needs its rule (which rows, which date, which unit) before its readback.

### Candidate splits

| In the brief | Becomes |
|---|---|
| A time column with grains (`created_at`: day, week, month, quarter, year) | a `time` dimension renamed to the date's business name (`order_date`); ask which date is "the" date and which time zone a day is in |
| A low-cardinality categorical column (`status`, `channel`, `region`) | a `string` dimension; ask whether the values need friendlier labels, and whether a value is a split or a rule (`status` is often both: a filter on revenue and a split for order counts) |
| An attribute of a to-one joined dimension, with its path (`customer.acquisition_channel`) | a dimension of the joined model, which a request reaches through the join; on the fact itself only as a join-reference dimension (`expr: customer.acquisition_channel`) when a metric across models needs the same name in each |

With profiles, categorical columns come with their distinct counts and top values, so the question can quote them ("`channel` is `web` in 70% of orders, then `app`, `phone`"). Without profiles they are guessed from names (status, type, category, channel, region, country, segment, tier, plan, source, device), and the brief says so; `sl profile` measures them. Any values a question names before then are examples, not values found in the data: say "for example", and that the profile will list the real ones. Ask which splits people actually use for each candidate measure ("do people break revenue down by channel, region or customer segment?"), and read back only those as dimensions to approve; leave the rest as draft or remove them.

### Columns that should not be splits

Ids, free text, near-unique strings and sensitive columns. Keep ids as keys and join keys. A near-unique string is left out by `sl draft` and listed in `ignored_columns`. A sensitive column goes to the sensitive-column question (`interview-guide.md`) and its tag; the brief never shows its values. When the owner wants one as a split anyway (a coarse free-text field that holds a handful of values), check its profile first.

### Questions for the owner

The brief orders them by importance: what a row is, which status values count, which date is "the" date, units and currency, test or deleted rows (`is_test`, `deleted_at`, `is_deleted`, a status such as `test`), soft-delete or history columns (`valid_from` and `valid_to`: current rows only, or as of a date?), and sensitive columns. Take them from the top, a batch per round trip, each with a suggestion grounded in a fact. An answer about test or deleted rows usually becomes a `filter` on every measure of the model, and its related models' measures (`interview-guide.md`, Rules that depend on a related table); a history table becomes a filter such as `valid_to is null`, or a time dimension over the validity dates, as the owner says.

### Without profiles

The brief says which facts `sl profile` would measure (key uniqueness, the values of category columns, empty rates, near-unique strings), and lists the columns it cannot place by name as unclear until profiled. Tell the owner which guesses would firm up. On the shared-context path, where nothing can be profiled yet, ask for example values where a question needs them, and note in each model's open questions what stays unmeasured.

## From the baseline to the layer

1. **The opening message**: roles, grains, the sketch and the top questions, as above.
2. **Scoping** (Phase 2): `noise` and `staging` tables are the exclusions to propose; the left-out note is the focus question. Preview with `sl scope`, then write on the owner's yes.
3. **Table structure** (Phase 5, step 1): the grain, key and relationship guesses become the first question for each table; the fan-out warnings become the join readbacks.
4. **Metric definitions**: candidate measures become the menu of measures to define; suggested ratios and shares become metrics in Phase 7.
5. **Splits**: candidate splits become dimensions, named in the business's words; the columns that should not be splits stay out.

Answers given before a table has a model go into its model as soon as `sl draft` writes it, in the same turn: scope the tables the owner answered about, profile them where the source allows it, draft them, then write each answer (`description`, `grain`, `primary_key`, `filter`, `open_questions`). A scoping answer goes straight into `sl scope ... --write` after its preview.

## What must be confirmed

Nothing in the brief stands until the owner confirms it:

- each table's role, grain and key: the table readback, then `sl approve` on a yes;
- each relationship: `sl check-join`, then the join's readback;
- each measure's rule, unit and currency: its readback ending in "Approve?";
- each split: which date and time zone, which values, which labels;
- each sensitive column: its tag and who may see it (`access.md`);
- each exclusion: the scoping preview and the owner's yes.

When the brief and the draft disagree (the brief guesses a dimension where the draft wrote measures, or a different key), ask the owner rather than picking one silently.

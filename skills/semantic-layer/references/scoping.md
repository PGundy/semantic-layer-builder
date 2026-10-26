# Scoping: focusing on the tables that matter

## Why focus

A real database holds staging copies, backups, dated snapshots, migration bookkeeping and tables nobody remembers. Interviewing an owner about all of them wastes their time, and a semantic layer with 200 half-defined tables is worse than one with 15 well-defined ones. Scope decides which tables the CLI profiles, drafts and lists in `next_batch`; everything else is ignored until someone widens the scope.

Rule: when a source has more in-scope tables than `settings.focus_threshold` in `semantic.yaml` (default 12), always ask the owner whether to focus before profiling. Below the threshold, still check that obvious noise is excluded.

## Pattern syntax

Scope lives in `sources/<source>.yaml` as `scope.include` and `scope.exclude`. A table is in scope when it matches at least one include pattern (or there are no include patterns) and no exclude pattern. Exclude always wins. Matching ignores case.

- A pattern **without a dot** matches the table name alone.
- A pattern **with a dot** matches `schema.table`.
- `*` matches any run of characters, `?` matches exactly one.
- `re:` starts a regular expression, anchored at both ends. It matches `schema.table` when it contains `\.`, the table name otherwise.

| Owner says | Pattern | Matches | Does not match |
|---|---|---|---|
| "the fact tables" (prefix) | `fct_*` | `fct_orders`, `fct_refunds` | `orders_fct` |
| "the daily rollups" (suffix) | `*_daily` | `sales_daily`, `sessions_daily` | `daily_sales` |
| "anything about orders" (contains) | `*orders*` | `fct_orders`, `orders_archive`, `stg_orders_v2` | `order_items` |
| "everything in analytics" (schema) | `analytics.*` | `analytics.orders`, `analytics.customers` | `staging.orders` |
| "orders in any schema" | `*.orders` | `public.orders`, `sales.orders` | `public.orders_v2` |
| "just these three" (exact names) | `orders`, `customers`, `products` | exactly those names | `orders_backup` |
| "one table in one schema" | `public.orders` | `public.orders` | `archive.orders` |
| "the quarterly sales tables" (regex) | `re:sales_20[0-9]{2}q[1-4]` | `sales_2024q1`, `sales_2025q3` | `sales_2024` |
| "no backups or temp tables" (exclude) | `*_backup`, `*_tmp`, `tmp_*` | excluded wherever they appear | |
| "skip dated copies" (exclude, regex) | `re:.*_20[0-9]{2}(_?[0-9]{2}){0,2}` | `orders_2023`, `orders_20240115` | `orders` |

A regular expression can list alternatives: `re:dim_(customer|product)s?` matches `dim_customer`, `dim_customers`, `dim_product` and `dim_products`.

In a shell, quote every pattern (`--include 'fct_*'`) so the shell does not expand the `*`.

When `sl tables` prints three-part names (a DuckDB file with attached databases, or an import spanning several databases or catalogs), the schema part includes that prefix, so write schema patterns with it, such as `prod.analytics.*` or `*.analytics.*`; `analytics.*` alone matches nothing there. Copy qualified names exactly as `sl tables` prints them.

## Presenting `sl tables --groups`

```
sl tables --source warehouse --groups
```

The output clusters tables by schema, shared prefix and shared suffix, with counts and sizes, and suggests patterns. Do not paste it raw to a non-technical owner. Summarise in a few lines with real names and plain words, then propose a default:

> Your warehouse has 64 tables. Most fall into a few groups:
> - 9 tables starting `fct_` (orders, refunds, shipments...) and 7 starting `dim_` (customers, products...): these look like the main reporting tables.
> - 22 tables starting `stg_`: these usually hold raw copies before cleanup.
> - 11 tables ending `_backup` or with a date at the end, like `orders_2023`: these look like old copies.
> - 15 others, including `schema_migrations`, which is bookkeeping for the app.
>
> I suggest we start with the 16 `fct_` and `dim_` tables and leave out the rest for now. We can add any table later. Does that work, or are there tables you know you need?

Lead with the biggest and most referenced groups, name two or three example tables per group, and flag likely noise with the reason (`name contains "tmp"`, `name ends in a date`). Never use the words "regex", "glob" or "pattern" with the owner unless they use them first.

## Question script

Ask one or two at a time, and offer a default each time.

1. "Which business questions do you most want answered first?" (revenue, signups, churn, inventory). Map the answers to table groups.
2. "These groups look like the main tables: ... Should we start with them?"
3. "These look like copies, staging or old data: ... Can we leave them out?"
4. "Are there tables you know are important that I haven't mentioned?" (search with `*<word>*` patterns)
5. "Are any of these off limits for this project?" (exclude them now; access rules come later)

If the scope is still above `focus_threshold` after these, say so and suggest splitting it ("let's do orders and customers first, then marketing next session"). The threshold is a prompt to ask, not a hard limit: if the owner wants 30 tables, write 30. Batching in the interview keeps it manageable.

When the owner confirms they want more tables than `focus_threshold`, set `settings.focus_threshold` in `semantic.yaml` to the agreed count, editing the file in place and keeping its comments (add a `settings:` block with `focus_threshold: <n>` if the file has none), then run `sl validate`. Otherwise `sl status` keeps asking for focus and `sl draft` refuses. You can also draft one batch at a time instead, with `sl draft --source warehouse --tables a,b,c`.

## Preview, confirm, write

Preview never changes anything:

```
sl scope --source warehouse --include 'fct_*' --include 'dim_*' --exclude '*_backup' --exclude 'tmp_*'
```

Read the result back: how many tables, the names, and anything surprising ("this also picks up `fct_orders_old`; leave it out?"). Adjust with more `--exclude` patterns, or drop a pattern you added with `--remove <pattern>`; start over with `--clear`. When the owner confirms, rerun the exact same command with `--write`:

```
sl scope --source warehouse --include 'fct_*' --include 'dim_*' --exclude '*_backup' --exclude 'tmp_*' --write
sl validate
```

`--write` saves the patterns, not a table list, so new tables that match later are picked up automatically. Mention this to the owner: "any new `fct_` table will be included too".

## Expanding scope later

- Add tables: `sl scope --source warehouse --include 'mkt_*'` to preview, then `--write`. Existing patterns stay.
- Drop a pattern: `sl scope --source warehouse --remove 'stg_*'`, preview, then `--write`. Models already drafted for those tables stay on disk; they simply leave scope.
- After widening, run `sl profile` and `sl draft` again for the new tables (`--tables` names them). `sl draft` never touches an existing model; `sl profile --refresh` reprofiles tables that already have a profile.
- `sl tables --source warehouse --all` lists every table with its scope and modeling state, useful when the owner asks "what did we leave out?".

## Per-source scoping in a lake

Each source has its own scope. Scope and interview one source at a time, and ask the focus question separately for each: "Now the event lake: it has 40 datasets. Which ones matter for the questions you listed?" A lake of files often has one view per dataset plus many partitions or versions; scope by dataset name (`web_*`, `*_events`) rather than by file. Do not carry a pattern from one source to another without checking: `fct_*` in the warehouse says nothing about the lake.

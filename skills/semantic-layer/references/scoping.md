# Scoping: focusing on the tables that matter

## Why focus

A real database holds staging copies, backups, dated snapshots, migration bookkeeping and tables nobody remembers. Interviewing an owner about all of them wastes their time, and a semantic layer with 200 half-defined tables is worse than one with 15 well-defined ones. Scope decides which tables the CLI profiles, drafts and lists in `next_batch`; everything else is ignored until someone widens the scope.

Rule: when a source has more in-scope tables than `settings.focus_threshold` in `semantic.yaml` (12 as `sl init` writes it), always ask the owner whether to focus before profiling. Below the threshold, still check that obvious noise is excluded.

Run `sl init`, `sl add-source` and `sl introspect` before the first scoping question (SKILL.md Phase 0), so the next turn can resume from the files.

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

The views of an in-memory DuckDB source are in schema `main` (`sl tables` prints `main.web_events`): a pattern without a dot (`web_*`) matches the view name, `main.*` matches every view, and the source name (`lake.*`) matches nothing.

## Presenting `sl tables --groups`

```
sl tables --source warehouse --groups
```

It first lists the in-scope tables, then the groups. The groups cluster tables by schema, shared prefix and shared suffix, with counts and sizes, and suggests patterns. A group's rows read `?` when none of its tables has a row count yet (views before `sl profile`) and `30,551+` when only some do; `--json` carries `total_rows` (`null` when all are unknown) and `rows_unknown`. Never tell the owner a group is empty because its total is unknown.

It ends with one combined command:

```
Suggested scope (the include-suggested groups, less the noise tables they would select):
  sl scope --source warehouse --include 'dim_*' --include 'fct_*' --exclude acme.dim_customers_archive --exclude acme.fct_orders_v2_test
Preview it, agree it with the owner, then add --write to save it.
```

`--json` carries the same as `suggested_scope: { include, exclude }`. It already removes the noise tables that the include patterns would also catch (`fct_*` catches `fct_orders_v2_test`), by exact qualified name, so start the preview from it rather than combining the group rows yourself. It is a starting point for the owner's choice, not their answer.

Do not paste the output raw to a non-technical owner. Summarise in a few lines with real names and plain words, then propose a default:

> Your warehouse has 64 tables. Most fall into a few groups:
> - 9 tables starting `fct_` (orders, refunds, shipments...) and 7 starting `dim_` (customers, products...): these look like the main reporting tables.
> - 22 tables starting `stg_`: these usually hold raw copies before cleanup.
> - 11 tables ending `_backup` or with a date at the end, like `orders_2023`: these look like old copies.
> - 15 others, including `schema_migrations`, which is bookkeeping for the app.
>
> I suggest we start with the 16 `fct_` and `dim_` tables and leave out the rest for now. We can add any table later. Does that work, or are there tables you know you need?

Every first scoping message says that tables can be added later, whatever else it holds.

Lead with the biggest and most referenced groups, name two or three example tables per group, and flag likely noise with the reason (`name contains "tmp"`, `name ends in a date`). Never use the words "regex", "glob" or "pattern" with the owner unless they use them first.

## Question script

Batch the scoping questions into one message: numbered items, one topic each, each with a suggestion, up to about 8. These are the usual items; drop the ones the facts already settle.

1. "Which business questions do you most want answered first?" (revenue, signups, churn, inventory). Map the answers to table groups.
2. "These groups look like the main tables: ... I suggest we start with them."
3. "These look like copies, staging or old data: ... I suggest we leave them out."
4. "Are there tables you know are important that I haven't mentioned?" (search with `*<word>*` patterns)
5. "Are any of these off limits for this project?" (exclude them now; access rules come later)

Keep the confirmation of the final table list as its own yes/no, after the preview.

### Patterns or exact names

Match the owner's own rule. When they state a rule that is a pattern ("all the fact and dimension tables", "everything in analytics"), write the pattern (`fct_*`, `analytics.*`), and say that new tables matching it later are included too. When they name a few tables ("orders, customers and refunds"), use exact names, with `--tables orders,customers,refunds` or an `--include` per name, and say that exact names do not pick up new tables: a new `fct_` table will need another `sl scope ... --write`. On a small source, exact names are often clearest.

If the scope is still above `focus_threshold` after these, say so and suggest splitting it ("let's do orders and customers first, then marketing next session"). The threshold is a prompt to ask, not a hard limit: if the owner wants 30 tables, write 30. Batching in the interview keeps it manageable.

When the owner confirms they want more tables than `focus_threshold`, set `settings.focus_threshold` in `semantic.yaml` to the agreed count, editing the file in place and keeping its comments (add a `settings:` block with `focus_threshold: <n>` if the file has none), then run `sl validate`. Otherwise `sl status` keeps asking for focus and `sl draft` refuses. You can also draft one batch at a time instead, with `sl draft --source warehouse --tables a,b,c`.

## Preview, confirm, write

Preview never changes anything:

```
sl scope --source warehouse --include 'fct_*' --include 'dim_*' --exclude '*_backup' --exclude 'tmp_*'
```

Read the result back: how many tables, the names, and anything surprising ("this also picks up `fct_orders_old`; leave it out?"). Adjust with more `--exclude` patterns, or drop a pattern you added with `--remove <pattern>`; start over with `--clear`. After any change, preview again and read back the final count and names; skip the new preview only when the owner stated the exact final list themselves ("just those 15, without dim_currency"). When the owner confirms that list, rerun the exact same command with `--write`. Ask for that confirmation as its own sign-off, not in the same item as an open question ("anything I missed?"):

```
sl scope --source warehouse --include 'fct_*' --include 'dim_*' --exclude '*_backup' --exclude 'tmp_*' --write
sl validate
```

`--write` saves the patterns, not a table list, so new tables that match a pattern later are picked up automatically; exact names match only those tables. Tell the owner which applies: "any new `fct_` table will be included too", or "a new table will need adding".

## Expanding scope later

- Add tables: `sl scope --source warehouse --include 'mkt_*'` to preview, then `--write`. Existing patterns stay.
- Add one table the owner names ("add the sales team closure too"): preview it with `sl scope --source warehouse --include acme.sales_team_closure`, check that the preview lists it as added, `--write`, and confirm it in one line that notes a name-based scope does not pick up new tables: "Added `sales_team_closure` to scope by its exact name; a new table that no pattern matches will need adding the same way." The owner's request is the yes; no separate preview sign-off is needed.
- Drop a pattern: `sl scope --source warehouse --remove 'stg_*'`, preview, then `--write`. Models already drafted for those tables stay on disk; they simply leave scope.
- After widening, run `sl profile` and `sl draft` again for the new tables (`--tables` names them). `sl draft` never touches an existing model; `sl profile --refresh` reprofiles tables that already have a profile.
- A rerun of `sl introspect` lists the tables added since the last snapshot. A new table that matches an include pattern is in scope at once, and `sl status` routes it to profile and draft; one that exact names do not cover stays out until you ask the owner and add it.
- `sl tables --source warehouse --all` lists every table with its scope and modeling state, useful when the owner asks "what did we leave out?".

## Deferring a table

When the owner wants to leave an in-scope table for later ("skip order items for now"), take it out of scope instead of leaving it as a draft:

```
sl scope --source warehouse --exclude fct_order_items
sl scope --source warehouse --exclude fct_order_items --write
```

Name the table as `sl tables` prints it, not the model name (`fct_order_items`, not `order_items` after `--strip-prefix`), and check that the preview shows it under Removed before you `--write`.

Its draft model stays on disk, out of scope, so `sl status` stops offering it in `next_batch` and the later phases can finish. Name every deferred table in the handoff, and bring it back later with `sl scope --source warehouse --remove fct_order_items --write`.

## Per-source scoping in a lake

Each source has its own scope. Scope and interview one source at a time, and ask the focus question separately for each: "Now the event lake: it has 40 datasets. Which ones matter for the questions you listed?" A lake of files often has one view per dataset plus many partitions or versions; scope by dataset name (`web_*`, `*_events`) rather than by file. Do not carry a pattern from one source to another without checking: `fct_*` in the warehouse says nothing about the lake.

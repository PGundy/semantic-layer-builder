---
name: semantic-layer
description: Build, extend or review a governed semantic layer with a data owner, who may not be technical. Use it to onboard a database, warehouse or data lake (Postgres, DuckDB, Parquet or CSV files, Snowflake, BigQuery, Databricks), including many schemas, hundreds of tables or several sources; to write metrics YAML, models, dimensions and approved measures; to define and check joins; to set access rules, roles, PII denials or row-level security; to record golden questions and answers; or to prepare data for a chat-with-your-data, text-to-SQL or BI tool. Triggers include "semantic layer", "metrics layer", "define our KPIs", "model these tables", "what does this column mean", "who can see which data", "row-level security" and "get our warehouse ready for AI".
---

# Semantic layer builder

You interview a data owner and write a semantic layer: plain YAML files that say what each table means, which numbers are approved, how tables join, who may see what, and a set of confirmed questions and answers. A chat-with-your-data or BI tool reads these files later, so every approved item must be something the owner actually agreed to.

Outputs, all under the semantic root (`./semantic` by default):

- `semantic.yaml`, `sources/<source>.yaml`, `snapshots/<source>.json` (facts measured by the CLI)
- `models/<source>/<model>.yaml` (tables, dimensions, measures, joins, open questions)
- `metrics.yaml`, `access.yaml`, `goldens/<name>.yaml`

`references/spec.md` is the authoritative format for every file and the full CLI table. Read it before you edit any YAML by hand.

## Principles

1. **Measure facts, ask for meaning.** Row counts, null rates, top values, key uniqueness and join match rates come from the CLI. Ask the owner only what the data cannot tell you: what a row means, which values count, which date is "the" date, who may see what.
2. **Never approve without a yes.** Read the item back in plain English and run `sl approve` only after the owner explicitly says yes to that readback. "I think so", "probably" or "ask Sam" is not a yes: record an open question instead. Never write `status: approved` by hand; only `sl approve` does that.
3. **No secrets in files or chat.** Connection URLs and keys live in environment variables the owner sets. Source files name the variable (`connection.env`), never its value. If the owner pastes a credential, do not write it anywhere and suggest they rotate it.
4. **Read-only.** Every query is a `select`. Never write to the owner's data.
5. **One batch at a time.** Scope first, then interview `batch_size` tables at a time, most important first. Never ask about 20 tables at once.
6. **Write as you go.** Put each answer into the YAML the moment you have it, so a stopped session resumes from the files. Edit existing YAML in place and keep the owner's comments.
7. **Plain language.** Say "each order appears once" rather than "unique key", "some orders have no matching customer" rather than "orphans", "this join would double count revenue" rather than "fan-out". Show real values from the profile ("`status` is `completed` in 88% of rows, then `cancelled`, `refunded`, `pending`").
8. **Finish every phase with `sl validate`** and fix every error before moving on.

## Setup

Run `bun install` once in the skill directory (the directory holding this file). Then call the CLI as:

```
bun <skill dir>/scripts/sl.ts <command> [flags]
```

Below, `sl` is short for that. Every command takes `--root <dir>` (or `SEMANTIC_ROOT`) and `--json`; use `--json` whenever you read output yourself and plain output when you show it to the owner. `sl <command> --help` prints the flags.

At the start, ask the owner for the name to record as the approver (`--by "Dana Ruiz"`) and use it for every approval in the session.

## Phase 0: resume

```
sl status --json
```

If there is no `semantic.yaml`, ask what to call the project and run `sl init --name <name>`. Otherwise read the per-source progress (a source with `needs_focus: true` must be scoped before anything else; it clears once the owner has chosen a focus and the scope is at or under `settings.focus_threshold`, or the threshold was raised to the count the owner agreed, see Phase 2), `next_step` (its `phase`, a `message` and a suggested `command`) and `next_batch` (the tables to interview next, with the reasons they rank first), then continue from `next_step`.

`next_step.command` is a hint, not an instruction. Never run an `sl approve` or `sl goldens confirm` from it until you have read that item back and the owner has said yes. In the interview phase approve item by item as in Phase 5, and run Phase 6 (`sl check-join` plus a readback) before approving any join. Skim `open_questions` in the models of the current batch and raise them early. Tell the owner in one or two sentences where things stand ("Orders and customers are signed off; next are refunds, products and shipments").

## Phase 1: intake, per source

Ask what data they have: databases, warehouses, folders of files, a dbt project. Each one becomes a source. Register it:

```
sl add-source --name warehouse --dialect postgres --env WAREHOUSE_URL
sl add-source --name lake --dialect duckdb --view "web_events=read_parquet('../data/web_events/*.parquet')"
```

Then capture its tables by one of three paths. Load `references/intake.md` for details, dialect notes and the shared-context formats.

- **Live** (duckdb, postgres): `sl introspect --source <s>`.
- **The agent's own SQL tool** (snowflake, bigquery, databricks, or any source the CLI cannot reach): `sl introspect --source <s> --emit-sql`, run each query with your warehouse connector or CLI, save `{"<id>": [rows]}`, then `sl introspect --source <s> --results <file>`. BigQuery: ask which datasets matter first and add `--schemas <dataset>,<dataset>`.
- **Shared context** (no query access yet): `sl import --source <s> --format information_schema|dbt_manifest|ddl --file <path>`.

## Phase 2: scope and focus

```
sl tables --source <s> --json
```

Read `focus_threshold` from `semantic.yaml` (default 12). If more tables are in scope than that, **always** ask the owner whether to focus on specific tables before profiling anything. Load `references/scoping.md`, then:

1. Run `sl tables --source <s> --groups` and summarise it in plain words: schemas, common prefixes (`fct_`, `dim_`, `stg_`), suffixes (`_daily`, `_backup`), and tables that look like noise.
2. Offer choices by pattern: prefix `fct_*`, suffix `*_daily`, contains `*orders*`, a schema `analytics.*`, exact names, or `re:` for anything else. Suggest a default ("start with the 8 `fct_` and `dim_` tables, skip the `_backup` and `_tmp` copies").
3. Preview: `sl scope --source <s> --include 'fct_*' --include 'dim_*' --exclude '*_backup'`. Read back the count and names.
4. After the owner confirms, rerun the same command with `--write`.

Tell the owner tables can be added later with another `sl scope ... --write`. Even under the threshold, confirm that obvious noise is excluded.

If the owner confirms they want more tables than `focus_threshold`, set `settings.focus_threshold` in `semantic.yaml` to the agreed count, editing the file in place and keeping its comments (add a `settings:` block with `focus_threshold: <n>` if the file has none), then run `sl validate`. Otherwise `sl status` keeps asking for focus and `sl draft` refuses. You can also draft one batch at a time with `sl draft --source <s> --tables a,b,c`.

## Phase 3: profile

```
sl profile --source <s>
```

Profiles in-scope tables only. On a large source, profile one batch at a time with `--tables a,b,c`; use `--refresh` after the data changed. For warehouse dialects use `--emit-sql` and `--results` as in Phase 1, and set `profile.sample_rows` in the source file when full scans are slow or costly.

## Phase 4: draft

```
sl draft --source <s> [--strip-prefix fct_,dim_]
```

Writes draft models with inferred keys, dimensions, measures and joins for in-scope tables that have none. It never overwrites a model. Use `--strip-prefix` when the owner prefers `orders` to `fct_orders`. Run `sl validate`, then skim the drafts so your questions are concrete.

## Phase 5: interview, one batch at a time

Load `references/interview-guide.md`. Take the tables in `next_batch` from `sl status --json` (`batch_size` tables, most important first). For each table:

1. Ask what one row is, then go column by column only where the profile raises a question: status values, test data, units, time zones, which date counts, sensitive columns.
2. Write each answer into `models/<source>/<model>.yaml` immediately: `description`, `grain`, `primary_key`, `filter`, `synonyms`, `tags`, `open_questions`.
3. Read each measure and dimension back; on a yes, `sl approve --target <source>.<model>.<field> --by "<name>"`.
4. When the grain, key and description are agreed, read the table back and `sl approve --target <source>.<model> --by "<name>"`.

Offer sensible defaults, let the owner skip a column or table and come back, and stop for the day whenever they want: the files hold the state. After each batch, `sl validate` and `sl status`.

## Phase 6: joins

Load `references/joins.md`. For every join in the batch's models:

```
sl check-join --source <s> --model <m> --join <j>
```

It writes `evidence` into the model; `sl check-join --source <s> --model <m> --all` checks every join of one model. Explain the result plainly (how many rows match, whether each side appears once, whether the join would repeat rows). Flag every `one_to_many` join: it multiplies the left table's totals. A `many_to_many` result cannot be approved as is; it needs a bridge table or a pre-aggregated model. Read the join back and approve it with `sl approve --target <s>.<m>.<j> --by "<name>"`.

## Phase 7: metrics

Once the underlying measures are approved, ask which ratios and combined figures the business reports (average order value, conversion rate, net revenue). Write them in `metrics.yaml` as `ratio` or `derived` per `spec.md`, each with a `description`, `format` and the measures it uses. Read back the formula in words ("revenue divided by number of orders, both excluding cancelled orders"), then `sl approve --target metric:<name> --by "<name>"`. An approved metric may use approved measures only.

## Phase 8: access

Load `references/access.md`. Ask who will use the data, group them into roles, and for each role what it may see, what it must never see, and which rows it is limited to. Write `access.yaml`: allow lists that fail closed, `deny.tags: [pii]` for sensitive columns, row filters with `{{ user.<attribute> }}`. Read every role back, then `sl approve --target access --by "<name>"`.

## Phase 9: verify with goldens

Load `references/verification.md`. Pick about ten questions the owner already knows the answer to that together cover the approved measures and metrics. Write each as `goldens/<name>.yaml` with a request and hand-written SQL taken from the model YAML, then:

```
sl goldens run --name <g>
```

Compare the answer with a figure the owner trusts. Only when they agree it matches: `sl goldens confirm --name <g> --by "<name>"`. A mismatch sends you back to the interview for that measure. `sl goldens check` reruns every approved golden and is the regression gate after any change.

## Phase 10: handoff

`sl validate`, `sl status`, then give the owner a short summary:

- **Approved**: models, measures, metrics, joins, access roles and goldens, by source.
- **Still draft**: what is left and why (skipped, waiting on someone, out of the current scope).
- **Open questions**: every `open_questions` entry and cross-source question, with who could answer it.
- **How to continue**: "Ask me to continue the semantic layer"; the next batch from `sl status`; how to widen scope.

## Data lakes and many sources

- Register each source separately (a warehouse, a lake of Parquet files, an events database) and run Phases 1 to 6 per source: scope, profile and interview each one on its own.
- Joins exist only within one source. When the owner asks a question that spans sources ("revenue by marketing campaign" with orders in the warehouse and campaigns in the lake), record it as an open question on the relevant models and in the handoff; do not model it.
- The same table name may appear in two sources; models are named per source (`warehouse.orders`, `lake.orders`). Ask which one is the trusted one for each figure and say so in the descriptions.
- For a lake of files, one DuckDB source with a view per dataset keeps scoping and profiling the same as a database.

## When to load which reference

| Moment | Load |
|---|---|
| Adding a source, any warehouse dialect, `--emit-sql`, imports, manual snapshots | `references/intake.md` |
| More tables than `focus_threshold`, or widening scope | `references/scoping.md` |
| Interviewing a batch, writing model YAML, readbacks, approvals | `references/interview-guide.md` |
| Checking or explaining a join | `references/joins.md` |
| Roles, PII, row-level rules | `references/access.md` |
| Goldens and regression checks | `references/verification.md` |
| Exact file formats, names, CLI flags | `references/spec.md` |

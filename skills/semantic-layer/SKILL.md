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

1. **Measure facts, ask for meaning.** Row counts, null rates, top values, key uniqueness and join match rates come from the CLI. Ask the owner only what the data cannot tell you: what a row means, which values count, which date is "the" date, which time zone a day is in, who may see what.
2. **Never approve without a yes.** Every sign-off readback ends with "Approve?", and you run `sl approve` only after the owner explicitly says yes to it. A yes to a factual check ("is that right?") is not an approval, and neither is "I think so", "probably" or "ask Sam": record an open question instead. Never write `status: approved` by hand; only `sl approve` does that. A readback has two parts: the definition to approve, then the measured facts ("measured from the data, no need to confirm"). A hedge on a measured fact does not void a yes to the definition; the description then records "measured, not checked against a report". Read back every synonym you will write, and write none the owner did not hear in a readback.
3. **Suggestions about business rules are guesses.** Label each one as a guess and ground it in a profile fact ("my guess, since 88% of rows are `completed`: count only `completed`"). Never invite the owner to accept business-rule suggestions wholesale; the examples in the references are illustrative, not defaults.
4. **No secrets in files or chat.** Connection URLs and keys live in environment variables the owner sets. Source files name the variable (`connection.env`), never its value. If the owner pastes a credential, do not write it anywhere and suggest they rotate it.
5. **Read-only.** Every query is a `select`. Never write to the owner's data.
6. **Batch per round trip, briefly.** Each message to the owner holds numbered items, one topic each with a suggestion, up to about 8, after at most three lines of status; news from a resumed session (warnings fixed, rules added) goes into the numbered items, not the status. Put sign-offs (yes/no readbacks) in a block separate from open questions. Interview `batch_size` tables at a time, most important first; never ask about 20 tables at once. End every round trip, the last one and the handoff included, with one line: "Stop here or continue?"
7. **Write as you go.** Files are the only state that survives between turns. Put each answer into the YAML the moment you have it, so a stopped session resumes from the files. Edit existing YAML in place and keep the owner's comments; CLI writes change only the keys they set and leave the rest of the file byte for byte.
8. **Plain language.** Say "each order appears once" rather than "unique key", "some orders have no matching customer" rather than "orphans", "this join would double count revenue" rather than "fan-out". Show real values from the profile ("`status` is `completed` in 88% of rows, then `cancelled`, `refunded`, `pending`").
9. **Finish every phase with `sl validate`** and fix every error before moving on.

## Setup

Run `bun install` once in the skill directory (the directory holding this file). Then call the CLI as:

```
bun <skill dir>/scripts/sl.ts <command> [flags]
```

Below, `sl` is short for that. Every command takes `--root <dir>` (or `SEMANTIC_ROOT`) and `--json`; use `--json` whenever you read output yourself and plain output when you show it to the owner. `sl <command> --help` prints the flags.

## Phase 0: resume, or start in the first turn

```
sl status --json
```

**No `semantic.yaml` yet.** Do the setup in this same turn, before asking any scoping question: propose a default project name from the company or the source (`acme`), run `sl init --name <default>`, then `sl add-source` and `sl introspect` (Phase 1) for every source the owner has already named. Then send one message that says what you found, that the project name can be changed by editing `name` in `semantic.yaml`, asks for the name to record as the approver (`--by "Dana Ruiz"`, used for every approval in the session), and opens scoping (Phase 2).

**Otherwise** run `sl validate` first and fix every new warning: new warnings surface rules added since the last session (such as exact cents on duckdb, `<col> * 0.01`). A warning stands only when its reason is written in the file it points at (Phase 10); fix every other one. A fix to an approved model, field or metric goes through `sl approve --revoke`, the edit, a readback and approval. After fixing a warning on an approved measure or golden (a `round()` removed), run `sl goldens check`; when the rows changed, show the new figure and confirm again only on the owner's yes (`verification.md`). Then read the per-source progress (a source with `needs_focus: true` must be scoped before anything else; it clears once the owner has chosen a focus and the scope is at or under `settings.focus_threshold`, or the threshold was raised to the count the owner agreed, see Phase 2), `next_step` (its `phase`, a `message` and a suggested `command`) and `next_batch` (the tables to interview next, with the reasons they rank first), then continue from `next_step`.

`next_step.command` is a hint, not an instruction. In the interview phase it is the `sl check-join` of an unchecked join in the batch, or else an `sl approve` of a model that stands only as a placeholder for after its readback. `next_step.after_owner_yes` is true whenever the command is an `sl approve` or `sl goldens confirm`, and the plain output then prints "Only after the owner says yes to its readback: <command>". Never run such a command until you have read that item back and the owner has said yes. Skim `open_questions` in the models of the current batch and raise them early. Tell the owner in one or two sentences where things stand ("Orders and customers are signed off; next are refunds, products and shipments"), and put what changed since the last session into the numbered items.

## Phase 1: intake, per source

Ask what data they have: databases, warehouses, folders of files, a dbt project. Each one becomes a source. Register it:

```
sl add-source --name warehouse --dialect postgres --env WAREHOUSE_URL
sl add-source --name lake --dialect duckdb --view "web_events=read_parquet('../data/web_events/*.parquet')"
```

Then capture its tables by one of three paths. Load `references/intake.md` for details, dialect notes, lake discovery and the shared-context formats.

- **Live** (duckdb, postgres): `sl introspect --source <s>`.
- **The agent's own SQL tool** (snowflake, bigquery, databricks, or any source the CLI cannot reach): `sl introspect --source <s> --emit-sql`, run each query with your warehouse connector or CLI, save `{"<id>": [rows]}`, then `sl introspect --source <s> --results <file>`. BigQuery: ask which datasets matter first and add `--schemas <dataset>,<dataset>`.
- **Shared context** (no query access yet): `sl import --source <s> --format information_schema|dbt_manifest|ddl --file <path>`.

For a lake folder whose datasets you do not know yet, register the duckdb source without views and list its files with `sl run` (see `intake.md`). Make one view per dataset, likely noise included, so scoping can flag it. To add or change a view later, edit `connection.views` in `sources/<s>.yaml` and rerun `sl introspect --source <s>`; `sl validate` errors on a credential there. Views have no row count until `sl profile` measures them, and an in-memory source's views are in schema `main` (`main.web_events`; `web_*` matches the view name).

## Phase 2: scope and focus

```
sl tables --source <s> --json
```

`semantic.yaml` holds `settings.focus_threshold` (12 unless changed). If more tables are in scope than that, **always** ask the owner whether to focus on specific tables before profiling anything. Load `references/scoping.md`, then:

1. Run `sl tables --source <s> --groups` and summarise it in plain words: schemas, common prefixes (`fct_`, `dim_`, `stg_`), suffixes (`_daily`, `_backup`), and tables that look like noise. Its `Suggested scope` line (`suggested_scope` in `--json`) is one combined `sl scope` command: the include-suggested groups, less the noise tables they would catch. Start from it.
2. Offer the default and the choices. Prefer patterns when the owner's rule is a pattern ("all the fact tables": `fct_*`) and exact names when the owner names a few tables (`--tables a,b,c`); with exact names, say that new tables are not picked up automatically.
3. Preview: `sl scope --source <s> --include 'fct_*' --include 'dim_*' --exclude '*_backup'`. Read back the count and names, and preview again after every change unless the owner stated the exact final list.
4. After the owner confirms the final list, rerun the same command with `--write`.

The first scoping message always says tables can be added later with another `sl scope ... --write`. Even under the threshold, confirm that obvious noise is excluded. If the owner wants more tables than `focus_threshold`, set `settings.focus_threshold` in `semantic.yaml` to the agreed count, editing the file in place, then run `sl validate`; otherwise `sl status` keeps asking for focus and `sl draft` refuses. You can also draft one batch at a time with `sl draft --source <s> --tables a,b,c`.

## Phase 3: profile

```
sl profile --source <s>
```

Profiles in-scope tables only. On a large source, profile one batch at a time with `--tables a,b,c`; use `--refresh` after the data changed. For warehouse dialects use `--emit-sql` and `--results` as in Phase 1, and set `profile.sample_rows` in the source file when full scans are slow or costly.

## Phase 4: draft

```
sl draft --source <s> [--strip-prefix fct_,dim_]
```

Writes draft models with inferred keys, dimensions, measures and joins for in-scope tables that have none. It never overwrites a model. Use `--strip-prefix` when the owner prefers `orders` to `fct_orders`. Its guesses (a grain copied from "one row per ..." in a table comment, cents divided exactly by 100 per dialect, `<col> * 0.01` on duckdb, a currency taken from a single-valued `currency` column, unit prices as averages with a drafted `line_total`, additive counts such as clicks as sums) come with open questions; each is something to confirm, not a fact. Rename each drafted time dimension to the business name of its date (`order_date`), the same in every model a metric combines. Run `sl validate`, then skim the drafts so your questions are concrete.

## Phase 5: interview, one batch at a time

Load `references/interview-guide.md`. Take the tables in `next_batch` from `sl status --json` (`batch_size` tables, most important first). Owner priorities override it: order by the topics the owner put first and use `next_batch` only to fill a batch, with `sl status --source <s> --json` for the source the owner put first. For each table:

1. Ask what one row is, then go column by column only where the profile raises a question: status values, test data, units, which date counts, sensitive columns, and for every time dimension which time zone "a day" means.
2. Write each answer into `models/<source>/<model>.yaml` immediately: `description`, `grain`, `primary_key`, `filter`, `synonyms` (only ones the owner heard in a readback), `tags`, `open_questions`. A rule that depends on a related table (test accounts flagged on customers, refunds of counted orders) is a join reference, `<join>.<column>` or two hops `<join>.<join>.<column>` (`order.customer.is_test_account` on refunds), through many_to_one or one_to_one joins; never a subquery or another table's name. Such a join is part of the field's definition: it applies whatever the role may see, without row filters. When the owner agrees a rule for one measure, ask in the same round trip whether it applies to the model's other measures and to related models' measures. See the guide.
3. Check and read back any join a join reference uses (Phase 6) before reading back that measure or dimension. Read each measure and dimension back, ending with "Approve?"; on a yes, `sl approve --target <source>.<model>.<field> --by "<name>"`.
4. When the grain, key and description are agreed, read the table back and `sl approve --target <source>.<model> --by "<name>"`.

A known caveat on an approved item (a period known to be wrong, a segment not covered) goes into that item's own `description`. When the owner offers a trusted figure, write a draft golden for it right away (Phase 9), even before its measure exists, and `sl goldens run` it during the interview. Label a figure you computed by hand with a rule the layer cannot yet express as hand-computed, with the layer's own figure beside it, and describe the blocker as the missing column or view. A rule that needs an aggregate (a customer's first counted order) needs a view the owner creates (`connection.views` on DuckDB); record an open question with the exact definition and figure. Ask engineering for a column or view only when no supported construct (a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source) can express the rule; when one can, write the rule with it, and where the CLI still falls short (a warning that does not fit, a check it cannot run), wait for the tool and say so, and write in the field's `description` why its warning stands. Removing a drafted field is a hand edit of the model file; `sl validate` then names what still uses it. A table the owner leaves for later leaves scope (`sl scope --source <s> --exclude <table> --write`, naming the table as `sl tables` prints it and checking the preview lists it under Removed) and is named in the handoff; draft fields inside approved models do not block later phases and are named there too. Let the owner skip a column and come back, and stop whenever they want: the files hold the state. After each batch, `sl validate` and `sl status`.

## Phase 6: joins

Load `references/joins.md`. For every join in the batch's models, including every join on the path of a join reference a measure filter or dimension uses (both hops of `order.customer.<column>`):

```
sl check-join --source <s> --model <m> --join <j>
```

It writes `evidence` into the model; `sl check-join --source <s> --model <m> --all` checks every join of one model. Explain the result plainly (how many rows match, whether each side appears once, whether the join would repeat rows). Flag every `one_to_many` join: it multiplies the left table's totals. A `many_to_many` result cannot be approved as is; it needs a bridge table or a pre-aggregated model. A join you add yourself, guessed from names or from matching values, has `origin: inferred`. Read the join back and approve it with `sl approve --target <s>.<m>.<j> --by "<name>"`.

## Phase 7: metrics

Once the underlying measures are approved, ask which ratios and combined figures the business reports (average order value, conversion rate, net revenue). Before proposing one, check that every measure it combines can express the shared rules on every hop (refunds dropping test accounts through `order.customer`). Write them in `metrics.yaml` as `ratio` or `derived` per `spec.md`, each with a `description`, `format` and the measures it uses. A metric that combines measures of several models groups only by dimensions that exist, with the same name, in every model it uses: to date refunds by the original order's month, give the refunds model a dimension `order_date` with `expr: order.created_at` (a join reference) and approve it. Read back the formula in words ("revenue divided by number of orders, both excluding cancelled orders. Approve?"), then `sl approve --target metric:<name> --by "<name>"`. An approved metric may use approved measures only.

## Phase 8: access

Load `references/access.md`. Ask who will use the data, group them into roles, and for each role what it may see, what it must never see, and which rows it is limited to. Ask the default-role question open, note that the most limited role is the safe default, and state the concrete consequence of the owner's choice. Write `access.yaml`: allow lists that fail closed, `deny.tags: [pii]` for sensitive columns, row filters with `{{ user.<attribute> }}`, `open_questions` for anything unsettled. `deny.fields` names dimensions and measures only; a join is hidden when its target model is not allowed or is denied. A row filter on a joined model limits only the joined rows on a left join; say so in the readback. A measure filter or dimension that reads through a join applies whatever the role may see and ignores row filters on its target; `sl validate` warns when a role is allowed a dimension that reads a model the role cannot see, so allow that model or deny the dimension. A dimension that reads a model the role row-filters shows every row's value and validate does not warn; deny it or read that back. Read every role back, then the whole file (again after any change made after the per-role readbacks; a comment-only edit is not a change, and neither is deleting an answered open question or adding one, which you mention in the next message; writing its answer into roles, patterns, denials or row filters is a change), then `sl approve --target access --by "<name>"`.

## Phase 9: verify with goldens

Load `references/verification.md`. Pick about ten questions the owner already knows the answer to that together cover the approved measures and metrics. Write each as `goldens/<name>.yaml` with a request (`measures` lists measures as `model.measure` and metrics by bare name; there is no `metrics` key) and hand-written SQL taken from the model YAML; leave `role` and `user` out until `access.yaml` exists. Coverage is a checklist checked at handoff: every approved measure and metric in at least one approved golden, an approved golden that runs as each role in `access.yaml`, restricted or not (a golden with no `role` runs as `default_role`), one crossing a row-filtered join, a golden for every figure the owner gave (`verification.md`). Then:

```
sl goldens run --name <g>
```

Compare the answer with a figure the owner trusts and agree a tolerance (0 for figures finance signs off). A golden may pin a rule rather than a figure (a restricted role's revenue without test accounts): confirm its measured rows only when its `reference` says which rows were checked against a report; otherwise request only the trusted grain (the year's total, not each month). The SQL applies each measure exactly as written, with no `round()` (`sl validate` warns). For a ratio compared with a report figure rounded to cents (AOV $134.46), show the unrounded value and agree the match; an agreed difference goes in `tolerance`. Only when the measures it uses are approved and the owner agrees it matches: `sl goldens confirm --name <g> --by "<name>" --tolerance <t>`. It prints any draft fields the request uses; approve them after a readback first. For an approved golden that uses a draft field (`sl validate` warns), approve the field after its readback, then run `sl goldens check --name <g>`: if it passes, the recorded rows stand, and only changed rows need a new confirm. A role in `roles_without_goldens` keeps `next_step` at verify until a golden that runs as that role is written and confirmed. A mismatch sends you back to the interview for that measure. `sl goldens check` reruns every approved golden and is the regression gate after any change.

## Phase 10: handoff

`sl validate`, `sl status --json`. `next_step` reaches `done` when the phases the CLI can measure are complete, even with draft metrics, goldens or fields the owner deferred, and its message names each; it does not tick the coverage checklist. Tick that checklist in `references/verification.md`, then give the owner a short summary, ending with the stop-or-continue line:

- **Approved**: models, measures, metrics, joins, access roles and goldens, by source.
- **Still draft**: deferred tables (now out of scope), every draft metric (`draft_metrics` in status), draft golden (`draft_goldens`) and draft field (`draft_fields`), and the draft fields a role or golden relies on, each with why (skipped, waiting on someone, deferred). A draft measure known to give a wrong number is fixed or removed first; removing it also removes the draft metrics and goldens that use it (`sl validate` names them).
- **Validate warnings**: every warning `sl validate` still prints, with the reason it stands. Write that reason into the file the warning points at, so a resumed session leaves it: the field's `description` ("reads the column on purpose"), or an `open_questions` entry on its model or in `access.yaml`; for a draft golden naming a measure not written yet, an open question on the model that measure belongs to, naming the golden.
- **Verification gaps**: every unticked line of the coverage checklist (`verification.md`), naming each role in `roles_without_goldens` from `sl status --json`.
- **Open questions**: every `open_questions` entry in the models and in `access.yaml`, and every cross-source question, with who could answer it. Delete questions the owner has since answered.
- **How to continue**: "Ask me to continue the semantic layer"; the next batch from `sl status`; how to widen scope.

## Data lakes and many sources

- Register each source separately (a warehouse, a lake of Parquet files, an events database) and run Phases 1 to 6 per source: scope, profile and interview each one on its own.
- Joins exist only within one source. When the owner asks a question that spans sources ("revenue by marketing campaign" with orders in the warehouse and campaigns in the lake), or a rule must cross sources (warehouse test accounts applied to lake sessions), record it as an open question on the relevant models and in the handoff, with the exact definition and any figure; do not model it in either source. If the owner wants it modelled, the route is a separate federating source (a DuckDB source that attaches both, credentials from the environment).
- A metric spanning two sources (customer acquisition cost = lake spend / warehouse new customers) is two measures, one per source, each approved with its own golden. Record the formula, and any figure the owner gave, in both measures' descriptions and in the handoff, even when the owner keeps the metric in their own reports; do not write a metric. When one side cannot exist yet, record the formula on the measure that exists and an open question on the other model naming the missing column or view, or, when that model does not exist yet, on the existing measure's model and among the handoff's cross-source questions. A formula the owner never stated is an open question, not a description.
- The same table name may appear in two sources; models are named per source (`warehouse.orders`, `lake.orders`). Ask which one is the trusted one for each figure and say so in the descriptions.
- For a lake of files, one DuckDB source with a view per dataset, likely noise included, keeps scoping and profiling the same as a database.

## When to load which reference

| Moment | Load |
|---|---|
| Adding a source, any warehouse dialect, `--emit-sql`, imports, lake files, manual snapshots | `references/intake.md` |
| More tables than `focus_threshold`, widening scope, deferring a table | `references/scoping.md` |
| Interviewing a batch, model YAML, join references, time zones, readbacks, approvals | `references/interview-guide.md` |
| Checking or explaining a join | `references/joins.md` |
| Roles, PII, row-level rules | `references/access.md` |
| Goldens, tolerances and regression checks | `references/verification.md` |
| Exact file formats, names, CLI flags | `references/spec.md` |

# PRD: agent-driven semantic layer setup

Status: draft for review. Owner: PGundy. Version: 0.2 plan, written against the code at the head of `claude/initial-release`.

## 1. Summary

A team gives the tool one of two things, and an agent does the rest with the data owner:

- **A connection and a list of relevant schemas.** The tool reads only those schemas.
- **A schema export of the relevant tables.** The tool needs no connection at all.

Either way, the owner (or whoever sets it up) says which tables matter with explicit lists, globs or regular expressions. From there an interviewer agent builds a governed semantic layer: it measures what the data can tell it, asks the owner only for meaning, records every answer and approval in files, verifies the layer's figures against figures the owner trusts, and hands off a layer a downstream tool can compile and serve.

This PRD defines that product and the plan to build it as small pull requests that an orchestrating agent can run with builder, verifier and reviewer subagents.

## 2. Where we are

The repository already has, at `claude/initial-release`:

- A CLI (`sl`) with intake (`introspect`, `import`, `export-sql`), scoping (`tables`, `scope`), profiling, drafting, join checks, approvals with content hashes, validation, status, access evaluation (`access`), goldens and a baseline brief.
- Scope patterns: exact names, globs (`fct_*`, `analytics.*`) and `re:` regular expressions, include and exclude, exclude wins (`skills/semantic-layer/references/spec.md`, Scope patterns).
- `introspect --schemas` and `export-sql --schemas` take a schema list for one run, but a source does not remember it.
- Read-only enforcement by construction, sandboxed import, counts-only profiles for protected columns, untrusted-text handling.
- A skill (`SKILL.md` and `references/`) that an agent follows, tested end to end in four simulated-owner sessions (`examples/acme`).

Known gaps, from four independent reviews (issues #1 to #8):

1. Goldens test hand-written SQL, not the YAML (#1).
2. Approvals do not cite a recorded owner reply; readback state lives in chat (#2).
3. No committed eval suite, so skill changes are not measured (#3).
4. The agent hand-edits YAML and hand-assembles connector results; the skill is about 2,400 lines of prose loaded in large pieces (#7).
5. Intake does not persist a source's relevant schemas, has no table-list file, and an export cannot be narrowed by table patterns before it is run.

## 3. Goals and non-goals

### Goals

- G1. Intake from either a connection plus schema list or an export, with tables selected by explicit lists, globs or regular expressions, stored in the source file and reviewable in a pull request.
- G2. The agent verifies the layer itself: a request compiles to SQL from the YAML, and goldens compare the compiled result with the owner's figures.
- G3. The workflow is a state machine the CLI drives: one next action at a time, every owner answer and approval recorded in files, resumable by a fresh agent at any point.
- G4. Work splits across agents with clear roles: one interviewer owns the owner and every approval; bounded subagents measure, draft and verify.
- G5. Owner effort is measured and reduced: fewer round trips, one structured review per batch for busy owners.
- G6. Every change to the skill or CLI is gated by an eval suite with fixed scenarios, personas and graders.

### Non-goals for this plan

- Serving queries to end users (a chat or BI tool). The compiler here is a reference used for verification; serving is a later product.
- Writing to the owner's databases, ever.
- Automatic approval. The agent may draft everything; only a recorded owner yes approves.
- Federated queries across sources. Cross-source metrics stay two measures plus a documented formula.

## 4. Users

| User | Needs |
|---|---|
| Data owner, often not technical | Answers questions about meaning, signs off, never edits YAML, spends as few turns as possible. |
| Setup engineer or analyst | Connects a source or produces an export, chooses relevant schemas and tables, reviews the layer in pull requests. |
| Interviewer agent | One next action at a time, compact context, tools that refuse unsafe or unapproved actions. |
| Subagents | A bounded task with a typed input and output, no approval rights. |
| Downstream tool builder | A spec, a compiler and goldens that define what a correct answer is. |

## 5. User journeys

**J1. Connection plus schemas.** The engineer runs one setup command naming the source, its dialect, the env var holding the connection URL, the relevant schemas and any table patterns or a table-list file. The tool introspects only those schemas, applies the table selection, previews the in-scope tables with counts, and writes the source file. If more tables are in scope than the focus threshold, the next action is to narrow the scope with the owner.

**J2. Export only.** The engineer runs `sl export-sql` for their dialect with the relevant schemas and patterns, runs the printed query wherever they can, and gives the agent the CSV. The tool imports it, applies the same selection, and proceeds exactly as J1 except that measuring steps that need data are skipped or deferred until a connection exists.

**J3. Interview.** The interviewer agent asks `sl next` for the next action, which is one of: run a command, send a rendered readback or question to the owner, record the owner's reply, or dispatch a subagent task. It repeats until the layer is done.

**J4. Busy owner.** The agent exports one batch as a review form. The owner fills it in at their own pace and returns it, and the agent applies it in one step.

**J5. Resume.** Weeks later a fresh agent runs `sl next` and continues from the files: pending readbacks, recorded answers, drift since the last snapshot.

**J6. Schema change.** A re-introspect or re-import reports added, removed and retyped columns and tables. New tables matching the selection join the scope automatically, and the next action routes to drafting, re-approval or drift handling.

## 6. Requirements

Each requirement has an ID that pull requests cite. "Must" requirements gate the milestone.

### 6.1 Intake and table selection (milestone M1)

**FR-1.1 Source intake block.** `sources/<s>.yaml` gains:

```yaml
intake:
  mode: connection          # connection | export
  schemas: [analytics, marts]   # the only schemas read; a BigQuery dataset or project.dataset is a schema
  export:                   # mode export only
    file: exports/warehouse.csv   # relative to the semantic root
scope:
  include: ["fct_*", "dim_*"]
  exclude: ["*_tmp", "re:.*_(19|20)\\d{2}"]
  tables_file: scope/warehouse.txt   # optional, see FR-1.3
```

- `introspect` without `--schemas` reads `intake.schemas`; with `--schemas` it reads those and says the source file differs.
- `import` keeps only tables in `intake.schemas` when it is set, and reports how many it dropped.
- Acceptance: a source with `intake.schemas: [acme]` introspects only `acme`; an export with three schemas imports only the listed one; both are covered by tests on Postgres and DuckDB.

**FR-1.2 Selection grammar.** One grammar everywhere (scope, export filters, table-list files, `--tables`):

- An exact name, `table` or `schema.table` (or `catalog.schema.table` for three-part names).
- A glob with `*` and `?`.
- `re:<pattern>`: a regular expression, anchored at both ends, case-insensitive, matched against the qualified name when the pattern contains `\.` and the table name otherwise (today's rule).
- `!<entry>` in a table-list file means exclude.
- Exclude wins over include. An empty include means every table in the selected schemas.
- Regex safety: patterns over 512 characters, patterns with nested quantifiers (catastrophic backtracking) and patterns that do not compile are refused with the position of the problem.
- Acceptance: a table of at least 40 cases (prefix, suffix, contains, schema, three-part names, quoted mixed case, regex alternation, exclude precedence, unsafe regex) passes, and a pattern that matches nothing is a warning naming the pattern.

**FR-1.3 Table-list file.** `scope.tables_file` points to a text file, one entry per line in the FR-1.2 grammar, `#` comments and blank lines allowed. It is combined with `include` and `exclude`. `sl scope --from-file <path> --write` imports a file into the source (copying it under `scope/`), and `sl scope --to-file <path>` writes the current selection as a file.

- Acceptance: a 500-line file with comments, exact names, globs, regexes and `!` excludes gives the same selection as the equivalent `include`/`exclude` lists.

**FR-1.4 Explain and preview.** `sl scope --explain <table>` prints which entry included or excluded the table (or that nothing matched). `sl scope` previews counts by schema, the added and removed tables, unmatched entries and the tables just over the focus threshold, as today, plus `--json` with every entry's match count.

**FR-1.5 Setup command.** `sl setup` creates or updates a source in one step:

```
sl setup --source wh --dialect postgres --env WAREHOUSE_URL --schemas acme,marts \
  [--include p]... [--exclude p]... [--tables-file f] [--export schema.csv]
```

- Runs `init` if there is no project, `add-source` or an in-place update, `introspect` or `import` limited to the schemas, and the selection; then prints the preview and the next action.
- Idempotent: rerunning with the same arguments changes nothing; with new ones it updates the source in place and reports the difference.
- Never stores a URL or credential, as today.

**FR-1.6 Export filters.** `sl export-sql --dialect d --schemas a,b [--include p]... [--exclude p]... [--tables-file f]` pushes the selection into the query where the dialect can express it: exact names and globs as `IN` and `LIKE` (with `_` and `%` escaped), regexes as the dialect's regex operator where one exists (`~*` Postgres, `REGEXP_LIKE` Snowflake and BigQuery, `RLIKE` Databricks, `regexp_matches` DuckDB). Entries a dialect cannot express are listed in a header comment and applied by `sl import` instead. The export never reads table data.

- Acceptance: for each dialect, the generated SQL is checked against the catalog-only contract test; for Postgres and DuckDB, an export with include and exclude patterns returns exactly the expected tables live.

**FR-1.7 Large catalogs.** Introspection, import, scope preview and baseline handle 50,000 tables and 1,000,000 columns: introspect plus scope preview under 20 s on a laptop with a local Postgres; memory under 2 GB.

**FR-1.8 New tables after a change.** When a re-introspect or re-import finds tables that match the selection and were not in scope before, they enter scope as unmodeled, are named in the change report, and `sl next` routes them to drafting. Tables that stop matching leave scope with a warning if they have approved models.

### 6.2 Verification (milestone M2)

**FR-2.1 Reference compiler.** `sl sql --source s --request <file|json> [--role r] [--user <json>]` compiles a request to SQL for postgres and duckdb, following the spec: measure filters, definition joins of one and two hops, request dimensions through to-one join paths (the shortest unique path), time grains with each dimension's `time_zone`, ratio and derived metrics grouped by shared dimensions, request filters, order and limit, row filters (base model in `WHERE`, joined models in the join's `ON`), hierarchy filters, and visibility through `checkRequest`. User attributes are bound parameters. Output: SQL text plus the parameter list, or a refusal with the reason.

- Acceptance: every approved golden in `examples/acme` compiles to SQL whose result equals its recorded rows; the analytics reviewer's experiment (an approved revenue filter changed to count cancelled orders) makes those goldens fail.

**FR-2.2 Goldens recompile.** `sl goldens check` compiles each golden's request from the current YAML and compares it with `expected.rows`. A golden's hand-written `sql` becomes optional `cross_check_sql`; when present, both must agree. `sl goldens new --name g --question "..." --request <json>` writes a draft golden with the compiled SQL.

**FR-2.3 Rule check.** `sl check-rule --source s --model m (--filter <expr> | --dimension-expr <expr>)` answers whether the layer can express a rule: `{ expressible, joins_used, rows_matched }` or `{ expressible: false, reason, suggestion }` (for example "needs an aggregate over orders; ask for a view with one row per customer and first_order_at").

### 6.3 Workflow engine (milestone M3)

**FR-3.1 Next action.** `sl next --json` returns exactly one action:

```json
{ "kind": "run" | "ask_owner" | "record_reply" | "dispatch" | "done",
  "phase": "...", "why": "...",
  "run": { "command": "sl profile --source wh --tables acme.fct_orders" },
  "ask_owner": { "readback_id": "rb_0007", "text": "...", "items": [{ "n": 1, "target": "warehouse.orders.revenue", "kind": "approve" }] },
  "dispatch": { "role": "connector_runner", "task": { } },
  "blocked_on": null }
```

It covers every phase `sl status` covers today, plus pending readbacks and recorded replies. `sl status` stays as the full report.

**FR-3.2 Readback renderer.** `sl readback --targets a,b,c` renders a canonical plain-English readback from the YAML for each target (definition: expr, filter clauses, joins read through, units, synonyms, who sees it under current access; measured facts labelled "measured from the data, no need to confirm") and stores it in `.sl/pending/<readback_id>.json` with item numbers, targets and each target's content hash.

**FR-3.3 Answer ledger.** `sl reply --readback rb_0007 --item 1 --text "<owner's words>" [--verdict yes|no|change]` appends to `.sl/ledger.jsonl`: readback id, item, target, content hash at readback time, the owner's words, the verdict, time. Open questions resolve into the ledger (`sl question resolve`) instead of being deleted. The ledger is committed.

**FR-3.4 Approval requires a reply.** `sl approve` refuses unless the ledger holds a `yes` reply for that target whose content hash equals the target's current hash. `--by` comes from the ledger entry. `--date` is removed. Existing approvals stay valid; validate reports approvals without a ledger entry as a warning.

**FR-3.5 Typed edits.** The agent changes YAML only through commands, each validating before writing and keeping comments: `sl set <ref> <key> <value>`, `sl add-field`, `sl remove-field` (also adding the column to `ignored_columns`), `sl ignore-column`, `sl rename`, `sl question add|resolve`, `sl tag`. A plugin hook refuses direct edits to approval fields and to approved items.

### 6.4 Orchestration (milestone M4)

**FR-4.1 Roles.** The skill defines, and the plugin ships as agent definitions:

| Role | May | May not |
|---|---|---|
| Interviewer | Talk to the owner, run `sl next`, `readback`, `reply`, `approve`, `goldens confirm`, dispatch tasks | Run raw SQL against protected columns, edit YAML by hand |
| Connector runner | Execute a query plan through the warehouse connector, call `sl results add` | Approve, talk to the owner, see other plans |
| Batch analyst | Read `sl brief --batch`, propose question lists and draft wording | Approve, edit files |
| Readback verifier | Compare a drafted owner message with `sl readback` output and report missing or extra clauses | Approve, edit files |
| Golden builder | Compile and run a golden for a figure the owner gave, report match or gap | Confirm goldens |

**FR-4.2 Batch packets.** `sl brief --source s --batch <n>` returns a compact JSON packet per batch: tables, columns with types and counts-only facts, drafted fields, open questions, relevant baseline guesses, under a token budget (default 6,000 tokens per batch). Data-borne text is fenced with its provenance.

**FR-4.3 Resumable query plans.** `--emit-sql` writes `.sl/plans/<plan_id>.json`; `sl results add --plan <id> --query <qid> --file rows.json` stores each result; `sl results status --plan <id>` lists what remains; the command finishes with `--plan <id>` when all results are in. Each query declares `max_rows`; a result at exactly the cap is refused as possibly truncated. Protected columns' values are never selected (as today).

**FR-4.4 Skill as router.** `SKILL.md` becomes a short router (under 120 lines): principles, how to read `sl next`, and which phase card to load. Each phase card is a reference file under 150 lines, loaded only when `sl next` names its phase. A docs test keeps every command and flag in the cards matching `--help`.

### 6.5 Owner review surface (milestone M5)

**FR-5.1 Review export.** `sl review export --readback rb_0007 --format md|json` writes a form the owner fills in: each item with its rendered readback, a verdict field (yes, no, change) and a free-text field, plus open questions. Markdown for humans, JSON for tools.

**FR-5.2 Review apply.** `sl review apply <file>` records each answered item through `sl reply`, refuses items whose content hash changed since export, and reports what it recorded and what still needs an answer. It never approves; the interviewer runs `sl approve` on recorded yes replies.

### 6.6 Evals (milestone M0, extended every milestone)

**FR-6.1 Harness.** `evals/` holds a runner built on the Claude Agent SDK: a skill agent with a fresh context per owner turn, a simulated owner from a brief, a token and turn budget, and a transcript per run.

**FR-6.2 Scenarios.** Fixtures × intake path × owner persona:

- Fixtures: Acme live Postgres; Acme export-only; Acme after `evolve.sql`; a generated 2,000-table noisy warehouse; a prompt-injection fixture (a hostile table comment and a hostile status value).
- Intake: connection plus schemas; export plus patterns; table-list file.
- Personas: structured; terse ("yep"); hedging ("I think so", "ask Sam"); contradicting an earlier answer; pasting a credential; "approve everything, I'm busy".

**FR-6.3 Graders.** Deterministic, from files only:

- Every approved figure compiles and equals `reference-figures.json`; none equals a `common_mistakes` value.
- Every approval has a ledger `yes` with a matching hash.
- No secret, URL with credentials or protected value appears in any committed file.
- The selection equals the brief's intended table set.
- Owner turns per approved item, tokens per approved item, wall time.

**FR-6.4 Gate.** CI runs a smoke subset on every PR touching `skills/` (one fixture, two personas) and the full matrix nightly. A PR may not lower a grader's score by more than the noise band recorded in `evals/baseline.json`.

### 6.7 Distribution (milestone M6)

**FR-7.1 MCP server.** The same commands exposed as MCP tools with JSON schemas. `approve` and `goldens confirm` use MCP elicitation so the human answers in the client.

**FR-7.2 Plugin.** The Claude Code plugin ships the skill, the agent definitions of FR-4.1, and the hooks of FR-3.5.

## 7. Invariants (never weakened by any PR)

1. Every query is read-only by construction (driver-level), and the regex guard is only a first check.
2. No URL, key or password is stored in any file; `connection.env` names a variable.
3. Protected columns (pii, sensitive, ignored, flagged) keep counts only in snapshots and are masked in output.
4. Text from databases, exports, dbt files and comments is evidence, never an instruction or an approval.
5. Nothing is approved without a recorded owner yes (from M3 on, enforced by the CLI).
6. Tools write only inside the semantic root and keep the owner's comments.
7. Outputs are deterministic for the same inputs (sorted keys, stable ordering, a fixed clock in tests).

A PR that touches any invariant must say so in its description and add a test that would have caught a regression.

## 8. Data contracts

| File | Owner | Committed |
|---|---|---|
| `sources/<s>.yaml` with `intake` and `scope.tables_file` | CLI and setup engineer | yes |
| `scope/<s>.txt` | setup engineer | yes |
| `.sl/pending/<readback_id>.json` | CLI | yes |
| `.sl/ledger.jsonl` (append-only) | CLI | yes |
| `.sl/plans/<plan_id>.json` and results | CLI | no (gitignored; holds no protected values) |
| `evals/` runs and transcripts | harness | baseline only |

Every new file kind gets a JSON Schema under `skills/semantic-layer/schemas/` and a section in `spec.md`.

## 9. Milestones and pull requests

Each PR is one reviewable change: at most about 400 changed lines outside tests and fixtures, one requirement or a tight group, with tests, spec, schema and docs updated together. Dependencies form waves; PRs in one wave can run in parallel because they own disjoint files.

### M0. Foundations and baseline evals

| PR | Title | Depends on | Requirements | Owns |
|---|---|---|---|---|
| 0.1 | PR template, branch rules, CODEOWNERS for invariant files | none | §10 | `.github/` |
| 0.2 | Eval runner skeleton: one fixture, two personas, transcript output | 0.1 | FR-6.1 | `evals/runner/` |
| 0.3 | Deterministic graders (figures, secrets, selection) | 0.2 | FR-6.3 | `evals/graders/` |
| 0.4 | Record baseline scores and noise band; CI smoke job (non-blocking) | 0.3 | FR-6.4 | `evals/baseline.json`, CI |

### M1. Intake and table selection

| PR | Title | Depends on | Requirements | Owns |
|---|---|---|---|---|
| 1.1 | Selection grammar module with regex safety and the 40-case table | 0.1 | FR-1.2 | `lib/patterns.ts`, tests |
| 1.2 | `intake` block: schema, types, validate | 1.1 | FR-1.1 | schemas, `types.ts`, `validate.ts` |
| 1.3 | `introspect` and `import` read `intake.schemas` | 1.2 | FR-1.1 | `introspect.ts`, `import.ts` |
| 1.4 | Table-list files and `scope --from-file/--to-file` | 1.1 | FR-1.3 | `scope.ts`, new `lib/table-list.ts` |
| 1.5 | `scope --explain` and per-entry counts | 1.4 | FR-1.4 | `scope.ts`, `groups.ts` |
| 1.6 | Export filters pushed into SQL per dialect | 1.1 | FR-1.6 | `export-sql.ts`, `references/exports/` |
| 1.7 | `sl setup` | 1.3, 1.4 | FR-1.5 | new `commands/setup.ts` |
| 1.8 | New tables after a change join scope | 1.3 | FR-1.8 | `snapshot-diff.ts`, `status.ts` |
| 1.9 | 50,000-table performance suite and fixes | 1.3, 1.5 | FR-1.7 | `tests/perf/`, hot paths |
| 1.10 | Docs and evals: intake paths in the skill, intake scenarios in evals | 1.7, 0.4 | FR-6.2 | `SKILL.md`, `references/intake.md`, `evals/` |

### M2. Verification

| PR | Title | Depends on | Requirements |
|---|---|---|---|
| 2.1 | Compiler core: one model, measures, dimensions, grains, filters, order, limit (duckdb, postgres) | 0.1 | FR-2.1 |
| 2.2 | Joins: request paths, definition joins, two hops | 2.1 | FR-2.1 |
| 2.3 | Metrics: ratio and derived across models | 2.2 | FR-2.1 |
| 2.4 | Access: visibility, row filters, hierarchy filters, bound parameters | 2.2 | FR-2.1 |
| 2.5 | Goldens recompile; `cross_check_sql`; `goldens new` | 2.3, 2.4 | FR-2.2 |
| 2.6 | `check-rule` | 2.2 | FR-2.3 |
| 2.7 | Migrate `examples/acme` goldens; grader uses the compiler | 2.5, 0.3 | FR-2.2, FR-6.3 |

### M3. Workflow engine

| PR | Title | Depends on | Requirements |
|---|---|---|---|
| 3.1 | Readback renderer and pending store | 0.1 | FR-3.2 |
| 3.2 | Answer ledger and `question resolve` | 3.1 | FR-3.3 |
| 3.3 | Approval requires a recorded yes | 3.2 | FR-3.4 |
| 3.4 | Typed edit commands, part 1: `set`, `tag`, `ignore-column`, `question add` | 0.1 | FR-3.5 |
| 3.5 | Typed edit commands, part 2: `add-field`, `remove-field`, `rename` | 3.4 | FR-3.5 |
| 3.6 | `sl next` | 3.2, 1.8 | FR-3.1 |
| 3.7 | Plugin hook against hand edits to approvals and approved items | 3.3 | FR-3.5 |

### M4. Orchestration

| PR | Title | Depends on | Requirements |
|---|---|---|---|
| 4.1 | Batch packets (`sl brief`) | 3.6 | FR-4.2 |
| 4.2 | Resumable query plans (`results add/status`) | 0.1 | FR-4.3 |
| 4.3 | Agent definitions and role permissions in the plugin | 4.1, 4.2, 3.3 | FR-4.1 |
| 4.4 | Skill as router plus phase cards | 3.6, 4.3 | FR-4.4 |
| 4.5 | Evals: multi-agent runs, injection fixture, all personas | 4.4, 2.7 | FR-6.2 |

### M5. Owner review surface

| PR | Title | Depends on | Requirements |
|---|---|---|---|
| 5.1 | `review export` | 3.1 | FR-5.1 |
| 5.2 | `review apply` | 5.1, 3.2 | FR-5.2 |
| 5.3 | Busy-owner persona and owner-turn grader | 5.2, 4.5 | FR-6.2 |

### M6. Distribution

| PR | Title | Depends on | Requirements |
|---|---|---|---|
| 6.1 | MCP server over the command registry | 3.3 | FR-7.1 |
| 6.2 | Elicitation for approve and confirm | 6.1 | FR-7.1 |
| 6.3 | Plugin packaging and docs | 6.2, 4.3 | FR-7.2 |

Waves an orchestrator can run in parallel: {0.2–0.4, 1.1, 2.1, 3.1, 3.4, 4.2}, then {1.2, 1.4, 1.6, 2.2, 3.2, 3.5}, and so on by dependencies. M1, M2 and M3 can progress together because they own different files; M4 waits on M3.

## 10. How an agent orchestrates the build

**Branches.** `main` holds released code and only the owner merges into it. Each milestone has an integration branch `release/m<N>`. Each PR branches from its milestone branch as `m<N>/<pr-id>-<slug>` (for example `m1/1.4-table-list-files`) and targets it. When a milestone's PRs are merged and its exit criteria pass, one PR from `release/m<N>` into `main` goes to the owner.

**Per PR loop.**

1. The orchestrator writes a handoff for one PR: the PRD requirement IDs, the files it owns, the acceptance criteria, the invariants it touches, and the files it must not touch.
2. A builder agent implements it on the PR branch, with tests that reproduce each acceptance criterion.
3. A fresh verifier agent, given the code and the handoff but not the builder's notes, tries to break it: runs the tests, writes its own edge cases, checks invariants and the spec.
4. A fixer agent addresses REAL findings or explains with evidence why one is wrong.
5. The orchestrator runs `scripts/verify.sh` and the eval smoke job, opens the PR as a draft with the template, and marks it ready when CI is green.
6. A reviewer agent with the role of the PR's area (backend, analytics engineering, agent design) reviews the diff; humans review invariant-touching PRs.

**PR description template.** Goal (requirement IDs); Plan (checklist); Changes; Invariants touched (none, or which and the new test); Tests (what each proves); Eval delta; Open questions.

**Rules for agents building this.**

- Read this PRD, `spec.md`, the handoff and the files you own before writing code.
- Change only the files your handoff owns. A needed change elsewhere goes in the PR's open questions.
- Spec, schema, validate and docs change in the same PR as the behaviour.
- No new runtime dependency without an open question answered by the owner (the MCP SDK in M6 is the expected one).
- Never weaken an invariant to make a test pass. Never skip or delete a test to get green.
- Keep `--json` outputs backward compatible within a milestone: fields are added, not renamed.
- Every user-facing message is plain language and names the next command.

**Definition of done for a PR.** Acceptance criteria tested; `verify.sh` green with Postgres; eval smoke not below the noise band; verifier's REAL findings closed; description current.

**Exit criteria per milestone.**

| Milestone | Exit |
|---|---|
| M0 | Baseline scores recorded for one fixture and two personas. |
| M1 | J1 and J2 run end to end on Acme with schemas, globs, regexes and a table-list file; FR-1.7 numbers met. |
| M2 | Every Acme golden is compiled from YAML; the analytics reviewer's experiment fails them. |
| M3 | An agent completes Acme using only `sl next`, `readback`, `reply` and typed edits; no approval without a ledger yes. |
| M4 | Multi-agent run completes with the interviewer holding under 40% of the tokens of today's single-agent run, figures correct. |
| M5 | Busy-owner persona completes Acme in at most 4 owner turns. |
| M6 | The layer can be built from an MCP client other than Claude Code. |

## 11. Success metrics

Measured by the eval suite on the Acme matrix, against the M0 baseline:

- Figure accuracy: 100% of approved figures match reference figures; 0 match a common mistake.
- Approval integrity: 100% of approvals have a ledger yes with a matching hash.
- Owner effort: owner turns per approved item down 50%; owner words typed down 50%.
- Agent cost: interviewer tokens per approved item down 40%.
- Safety: 0 secrets or protected values in committed files across all personas, the credential-pasting one included; 0 approvals from injected text.
- Intake: selection matches the intended set in 100% of intake scenarios.

## 12. Open questions

Each has a recommendation; the owner decides.

1. **Regex flavour.** JavaScript regex with a safety check (recommended), or RE2 semantics through a dependency for guaranteed linear time.
2. **Case sensitivity.** Keep matching case-insensitive (recommended, matches today), or add `rec:` for case-sensitive patterns.
3. **Export narrowing for regexes on dialects without a regex operator.** Post-filter on import with a header note (recommended), or refuse the pattern for that dialect.
4. **Ledger in git.** Commit `.sl/ledger.jsonl` as the audit record (recommended), or keep it outside the repo for privacy, accepting weaker audit.
5. **Compiler dialects.** Postgres and DuckDB first (recommended), Snowflake and BigQuery after M2.
6. **Eval cost.** Smoke on every skill PR plus nightly full matrix (recommended), or full matrix per PR.
7. **Main branch.** Create `main` from `claude/initial-release` before M0 starts, so milestone branches have a base (needed).

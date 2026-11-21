# PRD: first-layer hardening

Status: built; every PR of section 3 is merged on `release/v1`. Owner: PGundy. Built on `release/v1`, after every milestone of `docs/PRD.md`. This plan adds to that one and changes none of its requirements, invariants or decisions; the build loop, the PR rules and the definition of done are its section 10.

## 1. Purpose

The tool has one job: take a team from an empty folder and a Postgres connection to a viable first semantic layer, in one sitting with the data owner. A gap review of `release/v1` (a code review, a live agent walkthrough on Postgres as a SELECT-only role, and connection tests with an env file) found that the path works end to end and that these things stand between it and "works the first time for someone who is not us":

- three ways to end with a layer that is wrong or not really approved (a golden that passes on swapped years, a forged owner yes, parallel edits that lose each other);
- places where the agent has no command for what the owner asked, or where `semlayer next` names a step that cannot run;
- a connection story that depends on the directory the command runs from;
- one failing table or one timeout that throws away a whole profiling run;
- malformed files that crash with a stack trace;
- far more reading than the agent needs, and readbacks an owner has to decode.

Everything here serves the first build. Work that only matters once a layer is being maintained over time (drift, re-approval flows, further dialects) is out of scope.

## 2. Exit

A fresh agent, given an empty directory, the installed plugin and a `.env` file holding a SELECT-only Postgres URL for the Acme warehouse, reaches an approved layer with at least three confirmed goldens, and:

1. it follows `semlayer next` from start to finish and no step it is given fails to run;
2. it hand-edits no layer file, access rules included;
3. it never loads `spec.md`, and no phase needs a reference over 12 KB on the normal path;
4. one owner turn's answers take at most three commands to record;
5. the connection secret appears in no file under the semantic root, no command output and no transcript;
6. `semlayer validate` is clean and every approval traces to a recorded owner yes.

The walkthrough is run once before the plan starts (the gap review) and once after the last PR, and both transcripts' counts go in the last PR's description.

## 3. Requirements and pull requests

Branches are `v1/h<n>-<slug>`, targeting `release/v1`. Each PR cites its `HR` id in Goal. A PR may exceed the 400-line guide only where it says why.

| PR | Title | Depends on | Owns |
|---|---|---|---|
| H1 | Tests clean up after themselves; CI runs on the release line | none | `tests/helpers.ts`, test cleanup, `scripts/verify.sh`, `.github/workflows/ci.yml` |
| H2 | Goldens compare keys and whole numbers exactly | none | `lib/goldens.ts` |
| H3 | One writer at a time, and whole-file writes | none | new `lib/lock.ts`, `lib/cli.ts`, `lib/yaml.ts`, `lib/ledger.ts` |
| H4 | Connections from an env file | none | new `lib/env-file.ts`, `lib/adapters/postgres.ts`, `lib/credentials.ts`, `commands/setup.ts`, `commands/init.ts`, `mcp/server.ts` |
| H5 | Profiling and join checks keep what succeeded | none | `lib/plan.ts`, `commands/profile.ts`, `commands/check-join.ts`, `commands/draft.ts` |
| H6 | A changed ledger that `semlayer` did not write is put back | none | `hooks/`, `.claude-plugin/plugin.json` |
| H7 | Malformed files are reported, not crashed on | none | new `lib/schema.ts`, `lib/project.ts`, `lib/validate.ts` |
| H8 | Protected values stay masked under any alias | none | `lib/output.ts`, `commands/sql.ts`, `commands/run.ts` |
| H9 | Typed commands for every access rule | H3 | `commands/access.ts`, `lib/access.ts`, `references/phases/access.md` |
| H10 | Readbacks in the owner's words, with the figure | H8 | `lib/readback.ts` |
| H11 | Many edits in one command, validated once | H7, H9 | new `commands/apply.ts`, `lib/edit.ts`, `lib/naming.ts`, `tests/perf/` |
| H12 | `semlayer next` never names a step that cannot run | H4, H5, H9 | `lib/next.ts`, `lib/status.ts`, `commands/readback.ts`, `commands/scope.ts` |
| H13 | One list of approvals | H9, H11, H12 | `lib/approval-hash.ts` and its seven callers |
| H14 | Cards that are enough on their own | H4, H9, H11, H12 | `SKILL.md`, `references/phases/`, `commands/baseline.ts`, `README.md`, `evals/` |
| H15 | Exit walkthrough and its fixes | all | what the walkthrough finds |

Waves: H1 alone first (every later run inherits the cleanup); then H2 to H8; then H9 and H10; then H11 and H12; then H13 and H14; then H15.

### HR-1. Tests clean up; CI on the release line (H1)

- Every temporary directory a test or a helper creates is removed when its file finishes, pass or fail. The Postgres cluster `scripts/verify.sh` starts is stopped and its directory removed on exit, also when a step fails.
- `scripts/verify.sh` counts the `semlayer-test-*` and `semlayer-pg-*` entries under the temp directory before and after and fails when the count grew.
- CI runs on pushes to `release/**` as well as `main`.

### HR-2. Golden comparison (H2)

- A golden's grouping columns (the dimensions and time grains of its request) compare exactly: `2024` never matches `2025`, whatever the tolerance.
- Two whole numbers compare exactly. The tolerance applies only when at least one side is not a whole number.
- A golden with no request (a cross-check only) follows the whole-number rule.
- Tests: swapped years fail; a count off by one fails at any tolerance; a decimal total inside the tolerance still passes; every Acme golden still passes on DuckDB and Postgres.

### HR-3. Locking and atomic writes (H3)

- Every command that changes a file under the semantic root holds one lock, `.semlayer/lock`, while it reads, changes and writes. A command that queries a database holds it only while it writes its results, so a long profile does not block the interview.
- A second writer waits (30 seconds by default, `SEMLAYER_LOCK_WAIT_MS`), then fails with a message naming the command that holds the lock. A lock whose process is gone is taken over.
- YAML, JSON and ledger writes go to a temporary file in the same directory and are renamed into place. Ledger ids are allocated under the lock.
- `.semlayer/lock` is ignored by git (`semlayer init` writes the rule; an existing root gets it on the first locked command).
- Read-only commands (`status`, `next`, `validate`, `readback` without a write) take no lock.
- Tests: 20 parallel `semlayer set` calls on different fields all land; 20 parallel `semlayer reply` calls give 20 distinct ids and a ledger that validates; a writer killed mid-write leaves the previous file intact.

### HR-4. Env file connections (H4)

Lookup, first hit wins, and the tool says which one it used (never the value):

1. the variable in the process environment;
2. the file named by `--env-file <path>` (a global option) or `SEMLAYER_ENV_FILE`; a named file that does not exist is an error;
3. `.env` in the directory that holds the semantic root;
4. `.env` in the working directory.

- The tool reads these files itself: `KEY=value` lines, optional `export`, optional single or double quotes, `#` comments. A `$` in a value is kept as written; nothing is expanded. The same value arrives whether the file sits in the working directory or is named explicitly.
- A source may name the parts instead of a URL: `connection.env_prefix: PG` reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE`; `LAKE_` reads `LAKE_HOST` and so on. The password is used as written, with no URL encoding. `semlayer setup --env-prefix` writes it. A source has `env` or `env_prefix`, not both.
- The MCP server resolves the variable on each call, so a `.env` written after the server starts is seen.
- `semlayer init` and `semlayer setup` add `.env` and `.env.*` (keeping `.env.example`) to the `.gitignore` of the directory that holds the semantic root. `semlayer validate` reports an env file inside the semantic root, or one that git tracks, as an error.
- Messages: an unset variable names the variable, the files looked at and the line to add, with placeholders. An unreachable host names host and port. A server that requires SSL says to add `sslmode=require`. No message contains a credential.
- Tests: each lookup step and its precedence; `pa$$HOME` arrives unchanged; `--root` from another directory; the prefix form against live Postgres with a password containing `@`, `#` and `/`; each message.

### HR-5. Partial profiling and join checks (H5)

- `semlayer profile` and `semlayer check-join` work table by table (join by join). A table that fails (no SELECT, a timeout, a type the profiler cannot read) is skipped with its reason, the rest are saved, and the command lists what was skipped and exits non-zero only when nothing succeeded.
- A rerun profiles only what is missing or failed (`--all` redoes everything).
- A timeout message names `SEMLAYER_STATEMENT_TIMEOUT_MS` and `profile.sample_rows`.
- The skipped list is in `--json` (`skipped: [{table, reason}]`) so `semlayer next` can route on it (HR-12).
- `semlayer draft` after `semlayer profile` needs no extra flag to keep protected samples out; the default is the safe one.

### HR-6. Ledger integrity (H6)

- Before a Bash call that is not a plain `semlayer` command or a git command that moves commits (pull, merge, rebase, checkout, switch, restore, reset, revert, cherry-pick, stash), the hook records the ledger and the pending readbacks. After the call it compares. A difference is put back, and the agent is told that answers are recorded with `semlayer reply` only.
- A call whose after-check never ran is checked on the next hook call.
- When a plain `semlayer` command ran at the same time, the difference is left and reported, since it cannot be attributed.
- The hook refuses to read the env file a semantic root would load (the Read tool, and `cat`, `head`, `tail`, `less`, `grep`, `sed`, `awk`, `source` in Bash).
- The existing checks on Edit, Write and Bash stay as they are (decision HD1).
- Tests: a `python3 -c` write that forges a yes is reverted and `semlayer approve` then refuses; `semlayer reply` followed by a read-only command keeps the reply; a `git pull` that brings ledger lines keeps them; the env file read is refused.

### HR-7. Loaders check shape (H7)

- Every YAML and JSON file the tool loads is checked against its schema before use. A file with the wrong shape (an empty model file, a snapshot with no `tables`, `metrics: 5`, a list where `semantic.yaml` wants a map) gives a plain message naming the file, the place and what was expected, with exit code 1 and no stack trace.
- `--json` commands report the same as JSON, including `semlayer status --json` and `semlayer next --json` in a directory with no semantic root.
- The schema check lives in one module the loaders and `semlayer validate` share.

### HR-8. Masking under aliases (H8)

- No command prints a protected column's values because the SQL renamed or wrapped it: `select email as e`, `select lower(email)`, a subquery or CTE that renames it, `select t.*`.
- Counts and other aggregates over a protected column are still shown.
- When the tool cannot tell whether an output column carries a protected value, it masks it.

### HR-9. Access commands (H9)

- Every change the access phase can ask for has a typed command: add, change and remove a role and its `assign_when`; a user attribute; a restriction and its targets; a row filter (condition and hierarchy forms); the mode; a role's `allow`.
- They validate, keep comments, and return an approved file to draft like every typed edit.
- Visibility is decided once, in the access phase. A table readback states who sees the table and does not ask; an owner who answers "change" about visibility there is routed to the access phase and the table's sign-off proceeds.
- The access phase card names these commands and no hand edit.

### HR-10. Readbacks (H10)

- A readback uses the owner's words: conditions the tool can render are rendered in plain language, and the SQL appears once, last, labelled as the technical definition.
- A measure or metric readback on a connected source shows its figure on today's data and the row count behind it, computed from the compiled SQL. The figure is evidence: it is outside the approval hash, never shows a protected value, and a failure to compute it says why and does not block the readback.
- A who-sees block that is the same for every item in a batch is printed once.
- The access readback names every role, and for each what it adds or takes away.
- The description is shown with the item (decision HD2).

### HR-11. Batch edits and edit cost (H11)

- `semlayer apply --file <path>` (or stdin) takes a list of typed edit commands, each as its argument list, and runs them under one lock with one validation. Either all land or none do; a failure names the entry.
- A single typed edit validates once.
- Table lookup is indexed. On the 870-model, 5,000-table perf fixture: `semlayer validate` under 5 seconds, a typed edit under 8.

### HR-12. `semlayer next` (H12)

- `Step` carries a structured action (command, arguments, kind); `next` reads that and parses no command text. Status, next and approve read the ledger the same way.
- An unset connection variable gives `ask_owner` with `blocked_on` naming the variable and the env file (HR-4), never `semlayer profile`.
- Skipped tables (HR-5) give the retry or the question to ask, never the same failing command.
- No goldens yet gives `semlayer goldens new`. The metrics phase gives the action for its kind, not `semlayer validate` as a run step.
- Open questions in any file, `access.yaml` included, set `blocked_on`.
- A pending "change" reply is surfaced in `why` with the owner's words.
- Golden counts agree between `semlayer next` and `semlayer status`.
- `semlayer readback --discard <id>` removes a pending readback; `semlayer next` names it where it used to say to delete the file.
- `semlayer scope --exclude` takes `--reason`, recorded with the entry.

### HR-13. One list of approvals (H13)

One function lists every approval entry in a layer (models, fields, joins, metrics, access, goldens). Approve, the typed edits, status, validate, access, readback and the approvals grader use it. No behaviour change.

### HR-14. Cards (H14)

- Each phase card is enough for its phase's normal path. No card tells the agent to load `spec.md`, and none sends it to a reference over 12 KB unless it names the unusual case that needs it.
- Syntax the agent needs in the moment (golden request filters, access conditions) is in the card or printed by the command's `--help`.
- The intake card asks for the dialect and for where the connection lives (variable or env file), and tells the agent never to read or print the file.
- `semlayer baseline --json` is scoped to what the current phase needs by default; `--full` gives everything.
- `README.md` describes goldens and the compiler as they are.
- The scripted eval token counts are re-recorded.

### HR-15. Exit walkthrough (H15)

Run the section 2 walkthrough with a fresh agent. Each failure of an exit condition is fixed in this PR or, when it is larger than a small fix, in its own PR before this one merges.

## 4. Decisions

| ID | Decision |
|---|---|
| HD1 | The hook's existing Bash checks stay. The before-and-after comparison is added beside them: it closes the forged-yes route, and the existing checks still give the early, plain refusals that name the right `semlayer` command. |
| HD2 | Descriptions stay outside the approval hash. Adding them would void every recorded approval, and a description does not change a figure. The readback shows the description so the owner's yes is given with it in view. |
| HD3 | A process variable wins over any env file, as with every dotenv tool. |
| HD4 | Postgres parts are named by a prefix on the source, so two sources can each have their own. `PG` gives the standard libpq names. |
| HD5 | No new runtime dependency. The env file reader and the lock are written here. |

## 5. Not in this plan

- Drift, re-approval and upgrade flows beyond keeping them working.
- Dialects other than Postgres and DuckDB for the compiler.
- Rewriting `lib/status.ts`'s step selection beyond giving each step a structured action.
- The chat product (`semantic-layer-chat`), which builds on the layer this plan makes dependable.

## 6. After this plan

These landed on `release/v1` after this plan was built and are not part of it; `README.md` and `docs/plugin.md` describe the product as it is now.

- Usage evidence from saved queries and query logs (`semlayer usage`).
- The rename of the tool from `sl` to `semlayer` (and of `.sl/` and `SL_*` to `.semlayer/` and `SEMLAYER_*`).
- The automatic install of the packages by Claude Code, the `semlayer` command on the agent's `PATH` (`bin/semlayer`) and `semlayer doctor`.
- `semlayer demo`, a sample project with synthetic data and no warehouse.
- The `/semlayer` entry point and a README written for the terminal.
- A documentation pass that brought every document in line with the terminal-first product.

The plan that followed, a first PostgreSQL layer and then fast iteration, ran in eight workstreams. Each is one line here: what exists now, and what is left.

- A. Eval gate: the scripted smoke is a blocking CI job on DuckDB and PostgreSQL, the 200-table single-schema scenario included, with token counts computed and a warning when a scenario's tokens rise more than 10%; the live gate (`bun run eval:smoke -- --driver sdk --gate`) and the weekly `eval-live` workflow exist but stay off until the owner adds the `ANTHROPIC_API_KEY` secret with a spend limit and commits a baseline recorded on two days (`evals/README.md`, The live gate), so a scheduled live run that reports against a committed baseline waits on those steps; the dbt-manifest and changed-schema scenarios are left, and a live run as a merge gate is not planned.
- B. Stable codes and structured errors: every `semlayer validate` issue carries a registered code (`semlayer validate --codes`), and every failing command prints one `{error, code, next?}` object under `--json`; a `semlayer explain <code>` command, a `fix` object an agent can apply and severities beyond error and warning are left, and codes on every other refusal (they share `user_error`) are not planned.
- C. Metric semantics: segments, a week start per source, a default time dimension, balances that keep each period's last or first value and, on PostgreSQL, running and trailing totals, comparison with the prior period and a year earlier by grain, and the last n days against the n days before and a year earlier, all as request options proven on Chinook; fiscal years, segments on metric requests, `label`, year-to-date and other running-total variants, a year earlier at week grain, windows in weeks or months and these views on DuckDB are left, and cumulative or period-over-period metric types in `metrics.yaml` are not planned.
- D. Bridges and multi-fact queries: measures of several tables in one request combine on the dimensions they share, `semlayer conform` declares two differently named dimensions the same, a bridge join shares a figure by the owner's rule and `semlayer check-join` measures it, and the draft proposes the bridge for a link table with the rule left for the owner; a weight beyond one column and chains of two bridges are left.
- E. dbt: `semlayer import --semantic` reads a manifest's semantic models and metrics and says what it skipped and why, and with `--emit` writes them as typed draft edits for `semlayer apply`, keeping a snapshot read from the database; export to MetricFlow or Cube is not planned, nor cumulative, conversion, offset-window and semi-additive dbt metrics.
- F. PostgreSQL proof and dialect scope: versions 13 to 17, PgBouncer in transaction mode and TLS are tested in CI, `semlayer doctor` reports the server version, encryption and a labelled pooler guess, the product offers PostgreSQL only, and the provider kit (`docs/compat/postgres.md`, `scripts/compat-provider.sh`) exists; the fixtures from two managed providers wait on the owner's runs (`docs/compat/postgres.md`, Add your provider), 5,000-table timing and Redshift are left, and MySQL and SQL Server sources and live runs of the other warehouses are not planned.
- G. Schema scope: a source has one primary schema (`semlayer setup --primary`), `semlayer next` asks the schema question, and a join leaves the primary schema only through a pair the owner declared with its keys (`semlayer add-cross-schema`) and approved on a recorded yes; chains of three or more schemas, column allowlists per pair, access rules that name schemas and schema-per-tenant layouts are left.
- H. Iterating a layer from 1 to 1.x: `semlayer change close --version 1.0` records a finished layer, and a round (`semlayer change start`, `status`, `close`) ends in a new version and a `changelog.yaml` entry that names what changed and which goldens' figures moved, while `semlayer introspect` keeps the drift record; changes between two versions for consumers, semver rules, and deprecation and rename aliases are left, and a migration framework, branches inside the tool and version-aware compilation are not planned.
- Follow-ups from the milestone walkthroughs: `semlayer add-metric --none` records an owner's answer of no metrics, `semlayer goldens unconfirm` and `semlayer goldens remove` lower a golden's trust or delete a draft and a round names each, `semlayer goldens new` and `semlayer validate` refuse a request that cannot compile, and refusals and warnings name their fix (a model-level filter, an unbridged fact join, a key that is not unique, an `--emit` path).

Open questions for the owner, put on pull requests and not yet decided:

- H: a draft never approved is left out of a release and named, as built, or the close is refused instead.
- H: a changelog entry copies the golden rows, protected values included.
- H: `semlayer import` (a snapshot from a file) writes no drift record.
- H: after a close that left goldens unconfirmed, `semlayer next` returns to the verify step, and there is no way to record that the owner deferred them.
- E: a plain `semlayer import` on a source whose snapshot came from the database replaces that snapshot.
- D: on conformed dimensions, a single declared time zone is not compared with an unset one, and grouping by both sides of a conformed pair has no next command.
- G: an approval stamp hashed correctly but written by a whole-file shell write with no recorded yes is flagged afterwards and still counts as approved, for every kind of item.
- Every item: a description is outside the approval hash, so an approved item's description can be edited without a new yes.

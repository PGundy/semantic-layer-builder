# PRD: first-layer hardening

Status: approved for build. Owner: PGundy. Built on `release/v1`, after every milestone of `docs/PRD.md`. This plan adds to that one and changes none of its requirements, invariants or decisions; the build loop, the PR rules and the definition of done are its section 10.

## 1. Purpose

The tool has one job: take a team from an empty folder and a Postgres connection to a viable first semantic layer, in one sitting with the data owner. A gap review of `release/v1` (a code review, a live agent walkthrough on Postgres as a SELECT-only role, and connection tests with an env file) found that the path works end to end and that these things stand between it and "works the first time for someone who is not us":

- three ways to end with a layer that is wrong or not really approved (a golden that passes on swapped years, a forged owner yes, parallel edits that lose each other);
- places where the agent has no command for what the owner asked, or where `sl next` names a step that cannot run;
- a connection story that depends on the directory the command runs from;
- one failing table or one timeout that throws away a whole profiling run;
- malformed files that crash with a stack trace;
- far more reading than the agent needs, and readbacks an owner has to decode.

Everything here serves the first build. Work that only matters once a layer is being maintained over time (drift, re-approval flows, further dialects) is out of scope.

## 2. Exit

A fresh agent, given an empty directory, the installed plugin and a `.env` file holding a SELECT-only Postgres URL for the Acme warehouse, reaches an approved layer with at least three confirmed goldens, and:

1. it follows `sl next` from start to finish and no step it is given fails to run;
2. it hand-edits no layer file, access rules included;
3. it never loads `spec.md`, and no phase needs a reference over 12 KB on the normal path;
4. one owner turn's answers take at most three commands to record;
5. the connection secret appears in no file under the semantic root, no command output and no transcript;
6. `sl validate` is clean and every approval traces to a recorded owner yes.

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
| H6 | A changed ledger that `sl` did not write is put back | none | `hooks/`, `.claude-plugin/plugin.json` |
| H7 | Malformed files are reported, not crashed on | none | new `lib/schema.ts`, `lib/project.ts`, `lib/validate.ts` |
| H8 | Protected values stay masked under any alias | none | `lib/output.ts`, `commands/sql.ts`, `commands/run.ts` |
| H9 | Typed commands for every access rule | H3 | `commands/access.ts`, `lib/access.ts`, `references/phases/access.md` |
| H10 | Readbacks in the owner's words, with the figure | H8 | `lib/readback.ts` |
| H11 | Many edits in one command, validated once | H7, H9 | new `commands/apply.ts`, `lib/edit.ts`, `lib/naming.ts`, `tests/perf/` |
| H12 | `sl next` never names a step that cannot run | H4, H5, H9 | `lib/next.ts`, `lib/status.ts`, `commands/readback.ts`, `commands/scope.ts` |
| H13 | One list of approvals | H9, H11, H12 | `lib/approval-hash.ts` and its seven callers |
| H14 | Cards that are enough on their own | H4, H9, H11, H12 | `SKILL.md`, `references/phases/`, `commands/baseline.ts`, `README.md`, `evals/` |
| H15 | Exit walkthrough and its fixes | all | what the walkthrough finds |

Waves: H1 alone first (every later run inherits the cleanup); then H2 to H8; then H9 and H10; then H11 and H12; then H13 and H14; then H15.

### HR-1. Tests clean up; CI on the release line (H1)

- Every temporary directory a test or a helper creates is removed when its file finishes, pass or fail. The Postgres cluster `scripts/verify.sh` starts is stopped and its directory removed on exit, also when a step fails.
- `scripts/verify.sh` counts the `sl-test-*` and `sl-pg-*` entries under the temp directory before and after and fails when the count grew.
- CI runs on pushes to `release/**` as well as `main`.

### HR-2. Golden comparison (H2)

- A golden's grouping columns (the dimensions and time grains of its request) compare exactly: `2024` never matches `2025`, whatever the tolerance.
- Two whole numbers compare exactly. The tolerance applies only when at least one side is not a whole number.
- A golden with no request (a cross-check only) follows the whole-number rule.
- Tests: swapped years fail; a count off by one fails at any tolerance; a decimal total inside the tolerance still passes; every Acme golden still passes on DuckDB and Postgres.

### HR-3. Locking and atomic writes (H3)

- Every command that changes a file under the semantic root holds one lock, `.sl/lock`, while it reads, changes and writes. A command that queries a database holds it only while it writes its results, so a long profile does not block the interview.
- A second writer waits (30 seconds by default, `SL_LOCK_WAIT_MS`), then fails with a message naming the command that holds the lock. A lock whose process is gone is taken over.
- YAML, JSON and ledger writes go to a temporary file in the same directory and are renamed into place. Ledger ids are allocated under the lock.
- `.sl/lock` is ignored by git (`sl init` writes the rule; an existing root gets it on the first locked command).
- Read-only commands (`status`, `next`, `validate`, `readback` without a write) take no lock.
- Tests: 20 parallel `sl set` calls on different fields all land; 20 parallel `sl reply` calls give 20 distinct ids and a ledger that validates; a writer killed mid-write leaves the previous file intact.

### HR-4. Env file connections (H4)

Lookup, first hit wins, and the tool says which one it used (never the value):

1. the variable in the process environment;
2. the file named by `--env-file <path>` (a global option) or `SL_ENV_FILE`; a named file that does not exist is an error;
3. `.env` in the directory that holds the semantic root;
4. `.env` in the working directory.

- The tool reads these files itself: `KEY=value` lines, optional `export`, optional single or double quotes, `#` comments. A `$` in a value is kept as written; nothing is expanded. The same value arrives whether the file sits in the working directory or is named explicitly.
- A source may name the parts instead of a URL: `connection.env_prefix: PG` reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE`; `LAKE_` reads `LAKE_HOST` and so on. The password is used as written, with no URL encoding. `sl setup --env-prefix` writes it. A source has `env` or `env_prefix`, not both.
- The MCP server resolves the variable on each call, so a `.env` written after the server starts is seen.
- `sl init` and `sl setup` add `.env` and `.env.*` (keeping `.env.example`) to the `.gitignore` of the directory that holds the semantic root. `sl validate` reports an env file inside the semantic root, or one that git tracks, as an error.
- Messages: an unset variable names the variable, the files looked at and the line to add, with placeholders. An unreachable host names host and port. A server that requires SSL says to add `sslmode=require`. No message contains a credential.
- Tests: each lookup step and its precedence; `pa$$HOME` arrives unchanged; `--root` from another directory; the prefix form against live Postgres with a password containing `@`, `#` and `/`; each message.

### HR-5. Partial profiling and join checks (H5)

- `sl profile` and `sl check-join` work table by table (join by join). A table that fails (no SELECT, a timeout, a type the profiler cannot read) is skipped with its reason, the rest are saved, and the command lists what was skipped and exits non-zero only when nothing succeeded.
- A rerun profiles only what is missing or failed (`--all` redoes everything).
- A timeout message names `SL_STATEMENT_TIMEOUT_MS` and `profile.sample_rows`.
- The skipped list is in `--json` (`skipped: [{table, reason}]`) so `sl next` can route on it (HR-12).
- `sl draft` after `sl profile` needs no extra flag to keep protected samples out; the default is the safe one.

### HR-6. Ledger integrity (H6)

- Before a Bash call that is not a plain `sl` command or a git command that moves commits (pull, merge, rebase, checkout, switch, restore, reset, revert, cherry-pick, stash), the hook records the ledger and the pending readbacks. After the call it compares. A difference is put back, and the agent is told that answers are recorded with `sl reply` only.
- A call whose after-check never ran is checked on the next hook call.
- When a plain `sl` command ran at the same time, the difference is left and reported, since it cannot be attributed.
- The hook refuses to read the env file a semantic root would load (the Read tool, and `cat`, `head`, `tail`, `less`, `grep`, `sed`, `awk`, `source` in Bash).
- The existing checks on Edit, Write and Bash stay as they are (decision HD1).
- Tests: a `python3 -c` write that forges a yes is reverted and `sl approve` then refuses; `sl reply` followed by a read-only command keeps the reply; a `git pull` that brings ledger lines keeps them; the env file read is refused.

### HR-7. Loaders check shape (H7)

- Every YAML and JSON file the tool loads is checked against its schema before use. A file with the wrong shape (an empty model file, a snapshot with no `tables`, `metrics: 5`, a list where `semantic.yaml` wants a map) gives a plain message naming the file, the place and what was expected, with exit code 1 and no stack trace.
- `--json` commands report the same as JSON, including `sl status --json` and `sl next --json` in a directory with no semantic root.
- The schema check lives in one module the loaders and `sl validate` share.

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

- `sl apply --file <path>` (or stdin) takes a list of typed edit commands, each as its argument list, and runs them under one lock with one validation. Either all land or none do; a failure names the entry.
- A single typed edit validates once.
- Table lookup is indexed. On the 870-model, 5,000-table perf fixture: `sl validate` under 5 seconds, a typed edit under 8.

### HR-12. `sl next` (H12)

- `Step` carries a structured action (command, arguments, kind); `next` reads that and parses no command text. Status, next and approve read the ledger the same way.
- An unset connection variable gives `ask_owner` with `blocked_on` naming the variable and the env file (HR-4), never `sl profile`.
- Skipped tables (HR-5) give the retry or the question to ask, never the same failing command.
- No goldens yet gives `sl goldens new`. The metrics phase gives the action for its kind, not `sl validate` as a run step.
- Open questions in any file, `access.yaml` included, set `blocked_on`.
- A pending "change" reply is surfaced in `why` with the owner's words.
- Golden counts agree between `sl next` and `sl status`.
- `sl readback --discard <id>` removes a pending readback; `sl next` names it where it used to say to delete the file.
- `sl scope --exclude` takes `--reason`, recorded with the entry.

### HR-13. One list of approvals (H13)

One function lists every approval entry in a layer (models, fields, joins, metrics, access, goldens). Approve, the typed edits, status, validate, access, readback and the approvals grader use it. No behaviour change.

### HR-14. Cards (H14)

- Each phase card is enough for its phase's normal path. No card tells the agent to load `spec.md`, and none sends it to a reference over 12 KB unless it names the unusual case that needs it.
- Syntax the agent needs in the moment (golden request filters, access conditions) is in the card or printed by the command's `--help`.
- The intake card asks for the dialect and for where the connection lives (variable or env file), and tells the agent never to read or print the file.
- `sl baseline --json` is scoped to what the current phase needs by default; `--full` gives everything.
- `README.md` describes goldens and the compiler as they are.
- The scripted eval token counts are re-recorded.

### HR-15. Exit walkthrough (H15)

Run the section 2 walkthrough with a fresh agent. Each failure of an exit condition is fixed in this PR or, when it is larger than a small fix, in its own PR before this one merges.

## 4. Decisions

| ID | Decision |
|---|---|
| HD1 | The hook's existing Bash checks stay. The before-and-after comparison is added beside them: it closes the forged-yes route, and the existing checks still give the early, plain refusals that name the right `sl` command. |
| HD2 | Descriptions stay outside the approval hash. Adding them would void every recorded approval, and a description does not change a figure. The readback shows the description so the owner's yes is given with it in view. |
| HD3 | A process variable wins over any env file, as with every dotenv tool. |
| HD4 | Postgres parts are named by a prefix on the source, so two sources can each have their own. `PG` gives the standard libpq names. |
| HD5 | No new runtime dependency. The env file reader and the lock are written here. |

## 5. Not in this plan

- Drift, re-approval and upgrade flows beyond keeping them working.
- Dialects other than Postgres and DuckDB for the compiler.
- Rewriting `lib/status.ts`'s step selection beyond giving each step a structured action.
- The chat product (`semantic-layer-chat`), which builds on the layer this plan makes dependable.

# semantic-layer-builder

An agent skill that interviews a data owner and builds a governed semantic layer for their data: what each table means, which numbers are approved, how tables join, who may see what, and a set of confirmed questions and answers. The owner does not need to be technical. The agent measures everything it can with a small CLI and asks the owner only for meaning.

The output is plain YAML under version control, meant to be read by a chat-with-your-data tool, a text-to-SQL agent or a BI layer. It works across several sources at once, such as a Postgres warehouse beside a lake of Parquet files.

## What it does

1. **Intake.** It reads each source's schema live (DuckDB, Postgres), through the agent's own warehouse tool (Snowflake, BigQuery, Databricks), or from shared context: an `information_schema` export, a dbt manifest, or DDL.
2. **Focus.** When a source has more tables than the focus threshold, 12 by default, the skill always asks the owner which ones matter. It groups tables by schema, prefix and suffix, suggests patterns such as `fct_*`, `*_archive` or `analytics.*`, previews what a pattern selects, and saves the agreed scope. Nobody has to describe 20 tables at once.
3. **Profile.** It measures row counts, null rates, distinct counts, ranges, top values and candidate keys for the tables in scope.
4. **Draft.** It writes a skeleton model per table: time, category and boolean dimensions, sum and count measures, primary keys, declared and inferred joins, PII tags, and the open questions the data raises, such as whether an amount is in cents.
5. **Interview.** It works through the tables a few at a time, most important first. It reads each item back in plain English and approves it only after the owner says yes. An approval records a hash of what was approved, so `sl validate` reports an approved item that changed afterwards.
6. **Joins.** It measures every join's match rate, key uniqueness and fan-out before the owner signs it off, so orphaned rows and double counting surface as facts.
7. **Metrics and access.** It records ratio and derived metrics, and who may see what. Access is open by default: everyone sees what the owner approved, except personal and sensitive data, which stays hidden unless a role is granted it. Roles can come from user attributes such as department. Restrictions limit single metrics or fields to roles or conditions. Row filters can follow a reporting hierarchy, so a manager sees their team's rows. `sl access` shows the owner what any user would see before they sign. A strict mode turns access into an allowlist for regulated data.
8. **Goldens.** It writes each golden question as a request in the layer's own terms (measures, dimensions, filters), and the reference compiler turns the YAML into SQL for it, as the role and user the golden runs as (`sl sql` prints that SQL). It compares the answer with a figure the owner already trusts and records the agreed rows on the owner's yes. `sl goldens check` compiles every approved golden from the current YAML and runs it again, so a change to the data, or an approved edit that moves a figure, fails the goldens that use it. A golden may also carry hand-written `cross_check_sql`, which must give the same rows. The compiler writes Postgres and DuckDB SQL.
9. **Keep current.** When tables change, `sl introspect` reports added, removed and retyped columns. `sl draft --new-columns` drafts only what is new, and status raises approved items whose columns disappeared.

`sl status` records where the work stands, so a stopped session resumes from the files.

## Install

As a Claude Code plugin, from your shell (or in a session, `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`):

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

The plugin needs [Bun](https://bun.sh) 1.4 or later on `PATH` and one dependency install in the plugin root, the directory Claude Code runs the plugin from. When the dependencies are missing, a new session starts with a message that names the command with that directory filled in (usually the `installPath` that `claude plugin list --json` prints):

```sh
cd "<plugin root>" && bun install --frozen-lockfile --production
```

Run it again after each plugin update. The plugin ships the `semantic-layer` skill, five agents (`sl-interviewer`, `sl-connector-runner`, `sl-batch-analyst`, `sl-readback-verifier`, `sl-golden-builder`), the MCP server below (as the interviewer), `PreToolUse` hooks that refuse hand edits to approved items and hold each agent to its role, hooks after each shell command that put back a change to the answer ledger `sl` did not make, and a `SessionStart` hook that checks the install. Check it with `claude plugin details semantic-layer-builder`, which lists one skill, five agents, four hook events and one MCP server.

Then ask the agent something like "help me build a semantic layer for our warehouse". For a multi-agent build, run the interviewer as the main session: `claude --agent semantic-layer-builder:sl-interviewer`. [`docs/plugin.md`](docs/plugin.md) has the details, how to check the install, and how the plugin runs the MCP server.

Without the plugin, copy `skills/semantic-layer/` into a project's `.claude/skills/`; the CLI needs Bun and one install in the skill directory:

```sh
cd skills/semantic-layer && bun install
```

### As an MCP server

Any MCP client can call the same commands as tools (`sl_status`, `sl_readback`, `sl_approve` and the rest). The server needs no extra install; point it at a semantic directory:

```sh
bun skills/semantic-layer/scripts/mcp/server.ts --root /path/to/semantic        # or: bun run mcp -- --root /path/to/semantic
claude mcp add semantic-layer -- bun "$PWD/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic"   # Claude Code, from a clone
```

A client configured by JSON takes `{"command": "bun", "args": ["<path to>/skills/semantic-layer/scripts/mcp/server.ts", "--root", "<path to>/semantic"]}`. Each call runs one command with `--json` in that directory only. [`spec.md`](skills/semantic-layer/references/spec.md) (MCP server) has the protocol details. No tool takes `--show-protected`, and `--role <role>` limits the tools to one agent role's commands (default `interviewer`, every command). The Claude Code plugin starts the server for you ([`docs/plugin.md`](docs/plugin.md)).

## Run the CLI

The agent calls the CLI for you, but you can run it yourself. From the repository root:

```sh
bun skills/semantic-layer/scripts/sl.ts --help          # every command; or: bun run sl -- --help
bun skills/semantic-layer/scripts/sl.ts status --help   # one command's flags
```

A quickstart, with `sl` as shorthand for `bun <path to>/skills/semantic-layer/scripts/sl.ts`:

```sh
alias sl="bun $PWD/skills/semantic-layer/scripts/sl.ts"
# Put the connection in .env beside ./semantic yourself (sl keeps it out of git and never prints it):
#   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
# A variable already set in your shell wins; another file is read with --env-file <path>.
sl setup --source warehouse --dialect postgres --env WAREHOUSE_URL --schemas acme --name acme
                                        # writes ./semantic, registers the source and reads its tables

# or, with no connection: print the catalog export, run it yourself, import the file
sl export-sql --dialect postgres > export.sql
psql -X "<your connection>" --csv -f export.sql > schema.csv   # psql does not read .env
sl import --source warehouse --file schema.csv

sl baseline --source warehouse          # a first-pass brief of the tables, read-only
sl status                               # where things stand and the next step
```

Every command takes `--root <dir>` (or the `SEMANTIC_ROOT` environment variable) and `--json`. `--root` points at the semantic directory itself, the one that holds `semantic.yaml`, not its parent; without it the CLI uses `./semantic` under the current directory. Relative paths in source files, such as a DuckDB view's `read_parquet('../data/*.parquet')`, resolve from that directory. Snowflake, BigQuery and Databricks sources take `--emit-sql` and `--results <file>`: the CLI prints the queries, and you or the agent run them with your own tool. [`skills/semantic-layer/references/spec.md`](skills/semantic-layer/references/spec.md) has the full CLI table.

## Trust model

- **Read-only by construction.** The CLI only reads. On Postgres the connection starts with `default_transaction_read_only` on, a statement timeout and the time zone UTC, set as startup options so a reconnect keeps them, and every query runs alone in a read-only transaction that is rolled back. When the role is a superuser or can write, the CLI prints a warning: connect with a SELECT-only role (`sl setup --print-role-sql` prints the `GRANT` statements). On DuckDB a database file opens read-only, each query must be exactly one `SELECT`-type statement, and once a source's views and setup have run, external file access is limited to the files the views read, extensions do not install or load on their own, and the configuration is locked. A check of the SQL text runs first, to give a friendly message early; the guarantee that nothing is written does not depend on it. Reading files on the Postgres server is a different matter: a read-only transaction does not stop it, so the role is the barrier. A superuser or a member of `pg_read_server_files` can read server files through read-only functions, the CLI only warns about such a role, and the text check's list of refused functions is then the only fallback.
- **A semantic directory is executable configuration.** A DuckDB source's `connection.setup` and `connection.views` run on every connection, and every golden's `cross_check_sql` runs on `sl goldens check`. Setup is limited to an allowlist (loading named extensions, known settings, secrets from a provider or the environment) and each view must be one table expression; the adapter refuses anything else and `sl validate` reports it. Review changes to `sources/` and `goldens/` in pull requests as you would code, and run the CLI only on a semantic directory you trust.
- **Text from the data is evidence, not instructions.** Table and column comments, dbt descriptions, export files and column values reach the agent. The skill shows them to the owner; it never follows them as instructions and never treats them as approvals.
- **Protecting personal data is a heuristic.** A column is protected when the owner tags it `pii` or `sensitive`, when it is in a model's `ignored_columns`, or when its name or its near-unique text looks personal or sensitive. `sl run` and `sl goldens run` print a protected column as `[protected]`, also when the query renames or wraps it (`select email as e`, `lower(email)`, a subquery): a statement that reads a protected column shows only its counts and the columns that read nothing protected. The check reads the SQL's words, not the database's views and functions, and `--show-protected` is for the owner alone. Snapshots keep only counts for a protected column: its null fraction and distinct count, and a range only for numbers and dates; its top values are not stored. Name rules miss columns, so review `snapshots/` before committing them and tag what the rules missed.
- **Credentials stay in the environment.** Source files name an environment variable (or a prefix of several), never its value. The value comes from the shell or from an env file outside the semantic directory, `.env` beside it by default, which `sl setup` keeps out of git; the plugin's hook refuses to read that file, and `sl validate` reports anything that looks like a credential in a source file.
- **Goldens pin the YAML's figures.** A golden's request compiles from the current YAML and runs read-only, and its rows were checked against a figure the owner trusts. It catches drift in the data and an approved edit that moves the figure (see What it does); it proves the figure, not that every definition the request does not read is right.

[`SECURITY.md`](SECURITY.md) says how to report a vulnerability.

## The files it writes

```
semantic/
  semantic.yaml                 project name, default source, focus threshold, batch size
  sources/<source>.yaml         dialect, connection env var name, scope patterns
  snapshots/<source>.json       tables, columns, keys and profiles measured by the CLI
  models/<source>/<model>.yaml  dimensions, measures, joins, grain, open questions
  metrics.yaml                  ratio and derived metrics
  access.yaml                   roles, allowed models, denials, row filters
  goldens/<name>.yaml           confirmed questions, their requests and expected rows
```

A measure, as the owner approved it:

```yaml
- name: revenue
  expr: amount_cents / 100.0
  agg: sum
  filter: status in ('completed', 'shipped')
  format: currency
  currency: USD
  description: Order value in dollars for completed and shipped orders.
  synonyms: [sales]
  status: approved
  approved_by: Dana Ruiz
  approved_at: 2026-10-26
```

[`skills/semantic-layer/references/spec.md`](skills/semantic-layer/references/spec.md) is the full specification, with every file format and the CLI table. JSON Schemas for editor support live in [`skills/semantic-layer/schemas/`](skills/semantic-layer/schemas/).

## Sources and dialects

| Dialect | Introspect | Profile, check joins, run goldens | Notes |
|---|---|---|---|
| DuckDB | live | live | Files DuckDB reads, such as Parquet or CSV, as views in the source file, or a `.duckdb` database opened read-only |
| Postgres | live | live | Read-only transactions; connect with a SELECT-only role; the URL stays in an env var |
| Snowflake, BigQuery, Databricks | query plan | query plan | `--emit-sql` prints the SQL; the agent runs it with its own connector and passes `--results` |

Joins live within one source. A question that spans sources becomes an open question, because joining across engines needs a federating engine of its own.

## Example

[`examples/acme/`](examples/acme/) holds a semantic layer built by running the skill end to end against the synthetic Acme dataset in [`fixtures/acme/`](fixtures/acme/), a 20-table Postgres warehouse and a Parquet lake. An agent played the skill and another agent played the data owner from a private brief, over four sessions that include a schema change and a move to open access.

## Develop

```sh
bun install
bash scripts/verify.sh               # typecheck, tests (starts a private local Postgres if binaries exist), example validation
bun test tests/scope.test.ts         # one suite
eval "$(bash scripts/pg-local.sh)"   # a local Postgres for the live tests, no Docker; stop it with --stop
```

All test and fixture data is synthetic. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the live Postgres tests and the checks a change must pass. The skill's procedure starts at [`skills/semantic-layer/SKILL.md`](skills/semantic-layer/SKILL.md), a short router that maps each phase `sl next` names to one phase card under [`references/phases/`](skills/semantic-layer/references/phases/); the topic references beside them hold the detail.

## License

MIT

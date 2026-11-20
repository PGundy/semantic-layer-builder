# semantic-layer-builder

A Claude Code plugin that builds a governed semantic layer with the person who owns the data, in one sitting at the terminal. The agent measures your tables with a small read-only CLI, `semlayer`, asks only for what the data cannot say, reads each definition back and records it once you say yes.

You end up with plain YAML under version control: what each table means, the approved numbers, how tables join, who may see what, and questions with confirmed answers, ready for a chat-with-your-data tool, a text-to-SQL agent or a BI layer.

## Quick start

You need [Claude Code](https://code.claude.com/docs/en/setup) (checked here with 2.1.325; `claude --version`) and [Bun](https://bun.sh) 1.4 or later on `PATH` (`bun --version`). Install the plugin from your shell:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

Or in a session: `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`. Claude Code installs the plugin's packages and puts the `semlayer` command on the agent's `PATH`.

### Try it on sample data

In an empty folder, start `claude` and type `/semlayer demo`; it makes `semlayer-demo/`. (The plugin's skill is `/semantic-layer-builder:semlayer`, and Claude Code's [skills documentation](https://code.claude.com/docs/en/skills) says the bare `/semlayer` invokes it too unless another command already uses that name; if it does, type the long form.) Then:

```sh
cd semlayer-demo
claude    # then type: /semlayer
```

`semlayer demo` makes a practice project from the synthetic store data this repository ships: its tables as CSV and Parquet files, a semantic layer already set up over them, and `OWNER.md`, a cheat sheet for you to play the data owner. It needs no connection, no secret and no network, and every value in it is made up. Answer the agent's questions as the owner, from `OWNER.md`. To try it from a clone instead of an installed plugin, load the clone as the plugin for one session with `--plugin-dir`:

```sh
git clone https://github.com/PGundy/semantic-layer-builder
(cd semantic-layer-builder && bun install)
bun semantic-layer-builder/skills/semantic-layer/scripts/semlayer.ts demo   # makes ./semlayer-demo
cd semlayer-demo
claude --plugin-dir ../semantic-layer-builder
```

Then type `/semlayer`, or say "help me build a semantic layer for the data in this folder".

### On your own warehouse

1. Get a read-only role. `semlayer setup --print-role-sql --dialect postgres --schemas analytics` prints the `GRANT` statements (for a role named `semlayer_reader`) for your database administrator. Ask Claude to run it, or run it yourself once `semlayer` is on your own `PATH` (Running semlayer yourself, below, says how).
2. Put the connection in `.env` in your project folder, one line you write yourself. When the variable is not set yet, `semlayer setup` writes a `.env.example` beside it with that line, placeholders only, for you to copy to `.env` and fill in. `semlayer` reads `.env`, keeps it out of git, and never prints it, and the plugin refuses to let the agent read it:

   ```sh
   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
   ```

3. Start `claude` in that folder and type `/semlayer`, or say what you want ("help me build a semantic layer for our warehouse").

Optional: Claude Code asks before each `semlayer` command it has not been allowed, and a first build runs many. To stop that, add the rule `Bash(semlayer *)` under `permissions.allow` in `.claude/settings.local.json` (this project, not committed), `.claude/settings.json` (this project, shared) or `~/.claude/settings.json` (every project):

```json
{ "permissions": { "allow": ["Bash(semlayer *)"] } }
```

The tool never adds it for you. Claude Code's [permissions documentation](https://code.claude.com/docs/en/permissions) says each part of a command joined by `&&`, `;` or `|` must be allowed on its own; it does not say how a command that passes its input on standard input through a heredoc is matched, and that is not tested here, so such a command may still ask.

When something is off, type `/semlayer doctor`, or ask Claude to run `semlayer doctor`: one line per check (Bun, the packages, each connection by name, the role, git, the command on `PATH`), the fix for each that is not ok, and the next step.

## What a session looks like

An abridged, illustrative first session on a Postgres warehouse (the figures are made up); the commands are the ones the agent runs:

```text
> /semlayer
  Which database is it, and where does its read-only connection live?
> Postgres. WAREHOUSE_URL is in .env.
  semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL --name acme
  semlayer baseline --source warehouse --json
  Here is what I think your tables are; correct me. 20 tables; 6 look like staging copies.
  1. fct_orders: one row per order, my guess, since order_id appears once in each of 48,210 rows.
  ...
  Stop here or continue?
> Leave out the staging tables. Revenue is completed and shipped orders only.
  ...
  Revenue: order value in dollars for completed and shipped orders. Approve?
> yes
  semlayer reply --readback rb_0004 --answers - --approve
```

The agent measures row counts, keys and join match rates itself and asks you only for meaning. Each definition is read back in plain words and approved only on your yes; a guess is labelled as a guess. Say "stop" at any point: everything is already in files, and `/semlayer` in a later session picks up where you left off (the plugin's session start hook shows a line that says a layer is here, as Claude Code's [hooks documentation](https://code.claude.com/docs/en/hooks) describes for `systemMessage`). Review the files and commit them like code.

## Running semlayer yourself

`semlayer doctor` prints the line that puts the plugin's command on your own shell's `PATH`, `export PATH="$PATH":'<plugin root>/bin'`; add it to your shell profile. An installed plugin's folder is named for its version, so after a plugin update run `semlayer doctor` again and replace the line. The commands a person uses most:

```sh
semlayer status                # where the work stands, and what the default audience sees
semlayer next                  # the one next step
semlayer doctor                # check the setup
semlayer validate              # errors and warnings in the layer
semlayer access --roles analyst   # what one role sees, and what is hidden from it
semlayer goldens check         # rerun every confirmed question against the data
semlayer sql --source warehouse --request semantic/goldens/<name>.yaml   # the SQL a golden compiles to
```

Every command takes `--root <dir>` (or the `SEMANTIC_ROOT` environment variable), `--env-file <path>` and `--json`, and `semlayer <command> --help` prints its flags. Under `--json` a failing command prints one object, `{error, code, next?}`, and each issue of `semlayer validate --json` carries a stable `code`; `semlayer validate --codes` lists every code with its meaning. `--root` points at the semantic directory itself, the one that holds `semantic.yaml`, not its parent; without it the CLI uses `./semantic` under the current directory. From a clone of this repository the CLI is `bun skills/semantic-layer/scripts/semlayer.ts`:

```sh
bun skills/semantic-layer/scripts/semlayer.ts --help          # every command; or: bun run semlayer -- --help
```

An intake by hand, without the agent:

```sh
# Put the connection in .env beside ./semantic yourself (semlayer keeps it out of git and never prints it):
#   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
# A variable already set in your shell wins; another file is read with --env-file <path>.
semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL --schemas acme --name acme

# or, with no connection: print the catalog export, run it yourself, set the source up from the file
semlayer export-sql --dialect postgres > export.sql
psql -X "<your connection>" --csv -f export.sql > schema.csv   # psql does not read .env
semlayer setup --source warehouse --dialect postgres --export schema.csv --reason "<why a connection is not possible>" --name acme

semlayer baseline --source warehouse          # a first-pass brief of the tables, read-only
semlayer usage add --source warehouse ./queries   # optional: saved queries or a query log as evidence; runs none of it
semlayer status
```

[`spec.md`](skills/semantic-layer/references/spec.md) has the full CLI table.

## What it builds

1. **Intake.** Each source's schema, read live (DuckDB, Postgres), or from an `information_schema` export, a dbt manifest or DDL. Saved queries and query logs can be added as evidence.
2. **Focus.** Past 12 tables, you choose which matter, with patterns such as `fct_*` or `*_archive`; nobody describes 20 tables at once.
3. **Profile and draft.** Row counts, null rates, top values and candidate keys, then a draft model per table with its dimensions, measures, joins, PII tags and open questions.
4. **Interview.** A few tables at a time, most important first; each item read back and approved only on your yes. An approval records a hash, so `semlayer validate` reports an approved item that changed afterwards.
5. **Joins.** Match rate, key uniqueness and double counting measured before you sign a join off. A many-valued attribute, such as the tags of an order, joins through a bridge table with the rule you choose for sharing a figure among its values, so a total is never multiplied by accident.
6. **Metrics and access.** Ratio and derived metrics; segments, a condition such as "completed orders" that a table names once and its measures reuse; the date each figure is measured over by default and the day a week starts; balances that keep each period's last value instead of adding the days up; and who may see what: open by default with personal and sensitive data hidden, roles from user attributes, restrictions, and row filters that can follow a reporting hierarchy. `semlayer access` shows what any user would see.
7. **Goldens.** Questions you already know the answer to, written in the layer's own terms; the reference compiler turns the YAML into SQL for it, as the role and user the golden runs as. `semlayer goldens check` compiles every approved golden from the current YAML and runs it again, so a change to the data, or an approved edit that moves a figure, fails the goldens that use it. A request may combine measures of several tables, such as orders and refunds by month, and on Postgres it can add a running total, a comparison with the prior period and a year earlier, or the last n days against the n days before and a year earlier (see Figures over time).
8. **Changes.** A finished layer is released as 1.0 and then changed in rounds, each closed as a new version with a changelog entry that names what changed and which goldens' figures moved (see Changing a finished layer).

The files:

```
semantic/
  semantic.yaml                 project name, default source, focus threshold, batch size
  sources/<source>.yaml         dialect, connection env var name, scope patterns
  snapshots/<source>.json       tables, columns, keys and profiles measured by the CLI
  models/<source>/<model>.yaml  dimensions, measures, joins, grain, open questions
  metrics.yaml                  ratio and derived metrics
  access.yaml                   roles, allowed models, denials, row filters
  goldens/<name>.yaml           confirmed questions, their requests and expected rows
  changelog.yaml                releases: each version's approved items and golden rows
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

[`spec.md`](skills/semantic-layer/references/spec.md) is the full specification; JSON Schemas for editor support live in [`schemas/`](skills/semantic-layer/schemas/).

## Where it runs

Claude Code in the terminal is the supported surface. Claude Code's IDE extensions and the desktop app's Code tab load the same plugin ([plugins documentation](https://code.claude.com/docs/en/plugins)); claude.ai and Cowork do not install it, because it ships a command (`bin/semlayer`). The plugin ships the `semlayer` skill, five agents (`semlayer-interviewer`, `semlayer-connector-runner`, `semlayer-batch-analyst`, `semlayer-readback-verifier`, `semlayer-golden-builder`), the MCP server below, and hooks that refuse hand edits to approved items, put back changes to the answer ledger `semlayer` did not make, and at session start name the fix for a missing install or, in a project that holds a layer, say that it is here. Check it with `claude plugin details semantic-layer-builder`. When Claude Code's own install of the packages did not run, a new session names the command, with the plugin root filled in:

```sh
cd "<plugin root>" && bun install --frozen-lockfile --production
```

For a multi-agent build, run the interviewer as the main session: `claude --agent semantic-layer-builder:semlayer-interviewer`. [`docs/plugin.md`](docs/plugin.md) has what the plugin ships, how to check the install, the hooks, the MCP server and the agents.

The fallback without the plugin: copy `skills/semantic-layer/` into a project's `.claude/skills/` and install the packages in that copy. You invoke it as `/semlayer`, and the agent then runs the CLI by its full form, `bun <skill dir>/scripts/semlayer.ts <command>`, with no `semlayer` command, agents, hooks or MCP server:

```sh
cd .claude/skills/semantic-layer && bun add --exact yaml@2.9.1 ajv@8.20.0 @duckdb/node-api@2.0.0-r.1
```

### As an MCP server

Any MCP client can call the same commands as tools (`semlayer_status`, `semlayer_readback`, `semlayer_approve` and the rest). Point it at a semantic directory:

```sh
bun skills/semantic-layer/scripts/mcp/server.ts --root /path/to/semantic        # or: bun run mcp -- --root /path/to/semantic
claude mcp add semantic-layer -- bun "$PWD/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic"   # Claude Code, from a clone
```

A client configured by JSON takes `{"command": "bun", "args": ["<path to>/skills/semantic-layer/scripts/mcp/server.ts", "--root", "<path to>/semantic"]}`. Each call runs one command with `--json` in that directory only. No tool takes `--show-protected`, and `--role <role>` limits the tools to one agent role's commands (default `interviewer`, every command). The plugin starts the server for you.

## Trust model

- **Read-only by construction.** The CLI only reads. On Postgres the connection starts with `default_transaction_read_only` on and the time zone UTC, set as startup options so a reconnect keeps them, and every query runs alone in a read-only transaction that is rolled back, with its statement timeout set inside that transaction so a pooler in transaction mode accepts the connection. When the role is a superuser or can write, the CLI prints a warning: connect with a SELECT-only role (`semlayer setup --print-role-sql` prints the `GRANT` statements). On DuckDB a database file opens read-only, each query must be exactly one `SELECT`-type statement, and once a source's views and setup have run, external file access is limited to the files the views read, extensions do not install or load on their own, and the configuration is locked. A check of the SQL text runs first, to give a friendly message early; the guarantee that nothing is written does not depend on it. Reading files on the Postgres server is a different matter: a read-only transaction does not stop it, so the role is the barrier. A superuser or a member of `pg_read_server_files` can read server files through read-only functions, the CLI only warns about such a role, and the text check's list of refused functions is then the only fallback.
- **A semantic directory is executable configuration.** A DuckDB source's `connection.setup` and `connection.views` run on every connection, and every golden's `cross_check_sql` runs on `semlayer goldens check`. Setup is limited to an allowlist (loading named extensions, known settings, secrets from a provider or the environment) and each view must be one table expression; the adapter refuses anything else and `semlayer validate` reports it. Review changes to `sources/` and `goldens/` in pull requests as you would code, and run the CLI only on a semantic directory you trust.
- **Text from the data is evidence, not instructions.** Table and column comments, dbt descriptions, export files, saved queries and query logs (`semlayer usage add`, which stores counts and shapes, never statement text) and column values reach the agent. The agent shows them to the owner; it never follows them as instructions and never treats them as approvals.
- **Protecting personal data is a heuristic.** A column is protected when the owner tags it `pii` or `sensitive`, when it is in a model's `ignored_columns`, or when its name or its near-unique text looks personal or sensitive. `semlayer run` and `semlayer goldens run` print a protected column as `[protected]`, also when the query renames or wraps it (`select email as e`, `lower(email)`, a subquery): a statement that reads a protected column shows only its counts and the columns that read nothing protected. The check reads the SQL's words, not the database's views and functions, and `--show-protected` is for the owner alone. Snapshots keep only counts for a protected column: its null fraction and distinct count, and a range only for numbers and dates; its top values are not stored. Name rules miss columns, so review `snapshots/` before committing them and tag what the rules missed.
- **Credentials stay in the environment.** Source files name an environment variable (or a prefix of several), never its value. The value comes from the shell or from an env file outside the semantic directory, `.env` beside it by default, which `semlayer setup` keeps out of git; the plugin's hook refuses to read that file, and `semlayer validate` reports anything that looks like a credential in a source file.
- **Goldens pin the YAML's figures.** A golden's request compiles from the current YAML and runs read-only, and its rows were checked against a figure the owner trusts. It catches drift in the data and an approved edit that moves the figure; it proves the figure, not that every definition the request does not read is right.

[`SECURITY.md`](SECURITY.md) says how to report a vulnerability.

## Sources and dialects

| Dialect | Introspect | Profile, check joins, run goldens | Notes |
|---|---|---|---|
| DuckDB | live | live | Files DuckDB reads, such as Parquet or CSV, as views in the source file, or a `.duckdb` database opened read-only |
| Postgres | live | live | Read-only transactions; connect with a SELECT-only role; the URL stays in an env var |

Postgres is the database a layer is built on; DuckDB is for the demo, sample data and files. The code for Snowflake, BigQuery, Databricks, Redshift, MySQL and SQL Server is kept but not supported for new work, and [`other-dialects.md`](skills/semantic-layer/references/other-dialects.md) describes it.

Postgres 13 to 17 is supported, and CI runs the live tests on each of those majors. A connection through PgBouncer in transaction mode works, and so does TLS with a CA file: `sslmode=verify-full` with `sslrootcert=<path>` in the URL, or `<PREFIX>SSLROOTCERT` for a connection given in parts. A role with SELECT on only some tables works: `semlayer introspect` reads the tables the role can read and prints the ones it skipped.

Joins live within one source. A question that spans sources becomes an open question, because joining across engines needs a federating engine of its own.

A first layer stays within one schema of its source. `semlayer setup --primary <schema>` names it, and `semlayer next` asks the owner when the database has more than one. A join leaves the primary schema only on a schema pair the owner approved: `semlayer add-cross-schema` records the pair with the keys that connect the two schemas, and `semlayer approve --target schema-pair:<source>:<from>:<to>` approves it on the owner's recorded yes.

## Figures over time

On Postgres, a request asks for any approved measure or ratio metric over time, and adds no definition to approve: the golden that records it holds the owner's yes to its figures. The owner's question "revenue in the last 30 days against the prior 30 days and a year ago", on a layer over the Chinook sample database in [`fixtures/chinook/`](fixtures/chinook/), is this request:

```json
{
  "source": "chinook",
  "measures": ["invoice.revenue"],
  "window": { "dimension": "invoice.invoice_date", "days": 30, "as_of": "2025-12-22" },
  "compare": { "with": ["prior", "year_ago"] }
}
```

```sh
semlayer sql --source chinook --request request.json   # the SQL, the three date ranges in words, never run
semlayer goldens new --name revenue_30_days --question "Revenue in the last 30 days against the prior 30 days and a year ago" --request request.json
```

It returns one row with the columns `revenue`, `revenue_prior`, `revenue_prior_change`, `revenue_prior_pct`, `revenue_year_ago`, `revenue_year_ago_change` and `revenue_year_ago_pct`: here 38.62 for 2025-11-23 to 2025-12-22, against 49.62 for the 30 days before and 37.62 for the same dates a year earlier. A `_pct` column is a fraction (-0.2217 for a fall of 22.17%), blank when the earlier figure is 0. With no `as_of`, `semlayer sql` runs the window as of today's date in UTC and says so; `semlayer goldens new` writes that date into the golden, so a golden always states its date and `semlayer goldens check` never reads the clock.

By month instead of by days, `"running": {"over": "invoice.invoice_date:month"}` adds `revenue_running` (with `"periods": 3`, `revenue_trailing_3`), and `"compare": {"over": "invoice.invoice_date:month", "with": ["prior", "year_ago"]}` adds the month before and the same month a year earlier, each with its `_change` and `_pct`. `over` names one of the request's dimensions in full.

## Changing a finished layer

When the owner agrees the first build is finished, the agent records it as release 1.0, and each later change is a round of its own:

```sh
semlayer change close --version 1.0      # the first release: every approved item's hash and every golden's rows
semlayer change start --note "Add the refund rate" --by "Dana Ruiz"
semlayer change status                   # items added, changed and removed since the release, and the goldens that read them
semlayer change close --version 1.1      # refused, naming each, while a changed item waits for the owner's yes or a golden's figures moved unconfirmed
```

Only the items the round touches are read back. `layer_version` in `semantic.yaml` and `changelog.yaml` beside it record each release; a draft the owner deferred is left out of a release and named. After a schema change, `semlayer introspect` keeps `.semlayer/drift.json`, the record of the tables and columns that changed, and `semlayer validate` warns `release.column_retyped` on each approved field that reads a retyped column until it is read back and approved again.

## Example

[`examples/acme/`](examples/acme/) holds a semantic layer built end to end against the synthetic Acme dataset in [`fixtures/acme/`](fixtures/acme/), a 20-table Postgres warehouse and a Parquet lake. One agent was the interviewer, following the skill behind `/semlayer`, and another played the data owner from a private brief, over four sessions that include a schema change and a move to open access.

## Develop

```sh
bun install
bash scripts/verify.sh               # typecheck, tests (starts a private local Postgres if binaries exist), example validation
bun test tests/scope.test.ts         # one suite
eval "$(bash scripts/pg-local.sh)"   # a local Postgres for the live tests, no Docker; stop it with --stop
```

All test and fixture data is synthetic. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the live Postgres tests and the checks a change must pass. The skill's procedure starts at [`SKILL.md`](skills/semantic-layer/SKILL.md), a short router that maps each phase `semlayer next` names to one phase card under [`references/phases/`](skills/semantic-layer/references/phases/).

## License

MIT

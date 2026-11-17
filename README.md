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

Every command takes `--root <dir>` (or the `SEMANTIC_ROOT` environment variable), `--env-file <path>` and `--json`, and `semlayer <command> --help` prints its flags. `--root` points at the semantic directory itself, the one that holds `semantic.yaml`, not its parent; without it the CLI uses `./semantic` under the current directory. From a clone of this repository the CLI is `bun skills/semantic-layer/scripts/semlayer.ts`:

```sh
bun skills/semantic-layer/scripts/semlayer.ts --help          # every command; or: bun run semlayer -- --help
```

An intake by hand, without the agent:

```sh
# Put the connection in .env beside ./semantic yourself (semlayer keeps it out of git and never prints it):
#   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
# A variable already set in your shell wins; another file is read with --env-file <path>.
semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL --schemas acme --name acme

# or, with no connection: print the catalog export, run it yourself, import the file
semlayer export-sql --dialect postgres > export.sql
psql -X "<your connection>" --csv -f export.sql > schema.csv   # psql does not read .env
semlayer import --source warehouse --file schema.csv

semlayer baseline --source warehouse          # a first-pass brief of the tables, read-only
semlayer usage add --source warehouse ./queries   # optional: saved queries or a query log as evidence; runs none of it
semlayer status
```

Snowflake, BigQuery and Databricks sources take `--emit-sql` and `--results <file>`: the CLI prints the queries, and you or the agent run them with your own tool. [`spec.md`](skills/semantic-layer/references/spec.md) has the full CLI table.

## What it builds

1. **Intake.** Each source's schema, read live (DuckDB, Postgres), through the agent's own warehouse tool, or from an `information_schema` export, a dbt manifest or DDL. Saved queries and query logs can be added as evidence.
2. **Focus.** Past 12 tables, you choose which matter, with patterns such as `fct_*` or `*_archive`; nobody describes 20 tables at once.
3. **Profile and draft.** Row counts, null rates, top values and candidate keys, then a draft model per table with its dimensions, measures, joins, PII tags and open questions.
4. **Interview.** A few tables at a time, most important first; each item read back and approved only on your yes. An approval records a hash, so `semlayer validate` reports an approved item that changed afterwards.
5. **Joins.** Match rate, key uniqueness and double counting measured before you sign a join off.
6. **Metrics and access.** Ratio and derived metrics, and who may see what: open by default with personal and sensitive data hidden, roles from user attributes, restrictions, and row filters that can follow a reporting hierarchy. `semlayer access` shows what any user would see.
7. **Goldens.** Questions you already know the answer to, written in the layer's own terms; the reference compiler turns the YAML into SQL for it, as the role and user the golden runs as. `semlayer goldens check` compiles every approved golden from the current YAML and runs it again, so a change to the data, or an approved edit that moves a figure, fails the goldens that use it.

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

- **Read-only by construction.** The CLI only reads. On Postgres the connection starts with `default_transaction_read_only` on, a statement timeout and the time zone UTC, set as startup options so a reconnect keeps them, and every query runs alone in a read-only transaction that is rolled back. When the role is a superuser or can write, the CLI prints a warning: connect with a SELECT-only role (`semlayer setup --print-role-sql` prints the `GRANT` statements). On DuckDB a database file opens read-only, each query must be exactly one `SELECT`-type statement, and once a source's views and setup have run, external file access is limited to the files the views read, extensions do not install or load on their own, and the configuration is locked. A check of the SQL text runs first, to give a friendly message early; the guarantee that nothing is written does not depend on it. Reading files on the Postgres server is a different matter: a read-only transaction does not stop it, so the role is the barrier. A superuser or a member of `pg_read_server_files` can read server files through read-only functions, the CLI only warns about such a role, and the text check's list of refused functions is then the only fallback.
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
| Snowflake, BigQuery, Databricks | query plan | query plan | `--emit-sql` prints the SQL; the agent runs it with its own connector and passes `--results` |

Joins live within one source. A question that spans sources becomes an open question, because joining across engines needs a federating engine of its own.

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

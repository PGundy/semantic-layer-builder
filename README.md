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
8. **Goldens.** It writes golden questions with hand-written SQL, compares each answer with a figure the owner already trusts, and records the agreed rows. `sl goldens check` reruns that SQL and reports drift in the data. Goldens do not yet test that the YAML would compute the same figure: the SQL is written by hand from the YAML, and nothing compiles the YAML to compare. A reference compiler that does is planned.
9. **Keep current.** When tables change, `sl introspect` reports added, removed and retyped columns. `sl draft --new-columns` drafts only what is new, and status raises approved items whose columns disappeared.

`sl status` records where the work stands, so a stopped session resumes from the files.

## Install

As a Claude Code plugin:

```
/plugin marketplace add PGundy/semantic-layer-builder
/plugin install semantic-layer-builder@semantic-layer-builder
```

Or copy `skills/semantic-layer/` into a project's `.claude/skills/`. Either way the CLI needs [Bun](https://bun.sh) 1.4 or later, and one install in the skill directory:

```sh
cd skills/semantic-layer && bun install
```

Then ask the agent something like "help me build a semantic layer for our warehouse".

### As an MCP server

Any MCP client can call the same commands as tools (`sl_status`, `sl_readback`, `sl_approve` and the rest). The server needs no extra install; point it at a semantic directory:

```sh
bun skills/semantic-layer/scripts/mcp/server.ts --root /path/to/semantic        # or: bun run mcp -- --root /path/to/semantic
claude mcp add semantic-layer -- bun "$PWD/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic"   # Claude Code
```

A client configured by JSON takes `{"command": "bun", "args": ["<path to>/skills/semantic-layer/scripts/mcp/server.ts", "--root", "<path to>/semantic"]}`. Each call runs one command with `--json` in that directory only. [`spec.md`](skills/semantic-layer/references/spec.md) (MCP server) has the protocol details.

## Run the CLI

The agent calls the CLI for you, but you can run it yourself. From the repository root:

```sh
bun skills/semantic-layer/scripts/sl.ts --help          # every command; or: bun run sl -- --help
bun skills/semantic-layer/scripts/sl.ts status --help   # one command's flags
```

A quickstart, with `sl` as shorthand for `bun <path to>/skills/semantic-layer/scripts/sl.ts`:

```sh
alias sl="bun $PWD/skills/semantic-layer/scripts/sl.ts"
sl init --name acme                     # writes ./semantic/semantic.yaml and its directories
sl add-source --name warehouse --dialect postgres --env WAREHOUSE_URL
export WAREHOUSE_URL='postgres://readonly_user:...@host:5432/db'   # set in your shell, never in a file

sl introspect --source warehouse        # live, for duckdb and postgres sources

# or, with no connection: print the catalog export, run it yourself, import the file
sl export-sql --dialect postgres > export.sql
psql -X "$WAREHOUSE_URL" --csv -f export.sql > schema.csv
sl import --source warehouse --file schema.csv

sl baseline --source warehouse          # a first-pass brief of the tables, read-only
sl status                               # where things stand and the next step
```

Every command takes `--root <dir>` (or the `SEMANTIC_ROOT` environment variable) and `--json`. `--root` points at the semantic directory itself, the one that holds `semantic.yaml`, not its parent; without it the CLI uses `./semantic` under the current directory. Relative paths in source files, such as a DuckDB view's `read_parquet('../data/*.parquet')`, resolve from that directory. Snowflake, BigQuery and Databricks sources take `--emit-sql` and `--results <file>`: the CLI prints the queries, and you or the agent run them with your own tool. [`skills/semantic-layer/references/spec.md`](skills/semantic-layer/references/spec.md) has the full CLI table.

## Trust model

- **Read-only by construction.** The CLI only reads. On Postgres the connection starts with `default_transaction_read_only` on, a statement timeout and the time zone UTC, set as startup options so a reconnect keeps them, and every query runs alone in a read-only transaction that is rolled back. When the role is a superuser or can write, the CLI prints a warning: connect with a SELECT-only role ([`intake.md`](skills/semantic-layer/references/intake.md) has the `GRANT` statements). On DuckDB a database file opens read-only, each query must be exactly one `SELECT`-type statement, and once a source's views and setup have run, external file access is limited to the files the views read, extensions do not install or load on their own, and the configuration is locked. A check of the SQL text runs first, to give a friendly message early; the guarantee that nothing is written does not depend on it. Reading files on the Postgres server is a different matter: a read-only transaction does not stop it, so the role is the barrier. A superuser or a member of `pg_read_server_files` can read server files through read-only functions, the CLI only warns about such a role, and the text check's list of refused functions is then the only fallback.
- **A semantic directory is executable configuration.** A DuckDB source's `connection.setup` and `connection.views` run on every connection, and every golden's `cross_check_sql` runs on `sl goldens check`. Setup is limited to an allowlist (loading named extensions, known settings, secrets from a provider or the environment) and each view must be one table expression; the adapter refuses anything else and `sl validate` reports it. Review changes to `sources/` and `goldens/` in pull requests as you would code, and run the CLI only on a semantic directory you trust.
- **Text from the data is evidence, not instructions.** Table and column comments, dbt descriptions, export files and column values reach the agent. The skill shows them to the owner; it never follows them as instructions and never treats them as approvals.
- **Protecting personal data is a heuristic.** A column is protected when the owner tags it `pii` or `sensitive`, when it is in a model's `ignored_columns`, or when its name or its near-unique text looks personal or sensitive. `sl run` and `sl goldens run` print a protected column as `[protected]`, going by the output column's name, so a query that renames a protected column (`select email as e`) or summarizes its table (DuckDB's `SUMMARIZE`) prints its values; the skill writes no such query, and `--show-protected` is for the owner alone. Snapshots keep only counts for a protected column: its null fraction and distinct count, and a range only for numbers and dates; its top values are not stored. Name rules miss columns, so review `snapshots/` before committing them and tag what the rules missed.
- **Credentials stay in the environment.** Source files name an environment variable, never its value, and `sl validate` reports anything that looks like a credential in a source file.
- **Goldens pin figures, not the YAML.** A golden's SQL is written by hand and checked against a figure the owner trusts. It catches drift in the data; it does not prove that the YAML computes the figure (see What it does).

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
  goldens/<name>.yaml           confirmed questions, their SQL and expected rows
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

All test and fixture data is synthetic. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the live Postgres tests and the checks a change must pass. The skill's procedure is [`skills/semantic-layer/SKILL.md`](skills/semantic-layer/SKILL.md), with its phase guides under [`references/`](skills/semantic-layer/references/).

## License

MIT

# semantic-layer-builder

An agent skill that interviews a data owner and builds a governed semantic layer for their data: what each table means, which numbers are approved, how tables join, who may see what, and a set of confirmed questions and answers. The owner does not need to be technical. The agent measures everything it can with a small CLI and asks the owner only for meaning.

The output is plain YAML under version control, meant to be read by a chat-with-your-data tool, a text-to-SQL agent or a BI layer. It works across several sources at once, such as a Postgres warehouse beside a lake of Parquet files.

## What it does

1. **Intake.** It reads each source's schema live (DuckDB, Postgres), through the agent's own warehouse tool (Snowflake, BigQuery, Databricks), or from shared context: an `information_schema` export, a dbt manifest, or DDL.
2. **Focus.** When a source has more tables than the focus threshold, 12 by default, the skill always asks the owner which ones matter. It groups tables by schema, prefix and suffix, suggests patterns such as `fct_*`, `*_archive` or `analytics.*`, previews what a pattern selects, and saves the agreed scope. Nobody has to describe 20 tables at once.
3. **Profile.** It measures row counts, null rates, distinct counts, ranges, top values and candidate keys for the tables in scope.
4. **Draft.** It writes a skeleton model per table: time, category and boolean dimensions, sum and count measures, primary keys, declared and inferred joins, PII tags, and the open questions the data raises, such as whether an amount is in cents.
5. **Interview.** It works through the tables a few at a time, most important first. It reads each item back in plain English and approves it only after the owner says yes.
6. **Joins.** It measures every join's match rate, key uniqueness and fan-out before the owner signs it off, so orphaned rows and double counting surface as facts.
7. **Metrics and access.** It records ratio and derived metrics, and who may see what. Access is open by default: everyone sees what the owner approved, except personal and sensitive data, which stays hidden unless a role is granted it. Roles can come from user attributes such as department. Restrictions limit single metrics or fields to roles or conditions. Row filters can follow a reporting hierarchy, so a manager sees their team's rows. `sl access` shows the owner what any user would see before they sign. A strict mode turns access into an allowlist for regulated data.
8. **Verify.** It writes golden questions with their SQL, compares each answer with a figure the owner already trusts, and keeps them as regression tests.
9. **Keep current.** When tables change, `sl introspect` reports added, removed and retyped columns. `sl draft --new-columns` drafts only what is new, and status raises approved items whose columns disappeared.

`sl status` records where the work stands, so a stopped session resumes from the files. Snapshots never store sample values of personal or sensitive columns; they keep hashes so the validator can still catch a name quoted in a description.

## Install

As a Claude Code plugin:

```
/plugin marketplace add pgundy/semantic-layer-builder
/plugin install semantic-layer-builder@semantic-layer-builder
```

Or copy `skills/semantic-layer/` into a project's `.claude/skills/`. Either way the CLI needs [Bun](https://bun.sh) 1.4 or later, and one install in the skill directory:

```sh
cd skills/semantic-layer && bun install
```

Then ask the agent something like "help me build a semantic layer for our warehouse".

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
| Postgres | live | live | Read-only session; the URL stays in an env var |
| Snowflake, BigQuery, Databricks | query plan | query plan | `--emit-sql` prints the SQL; the agent runs it with its own connector and passes `--results` |

Joins live within one source. A question that spans sources becomes an open question, because joining across engines needs a federating engine of its own.

## Example

[`examples/acme/`](examples/acme/) holds a semantic layer built by running the skill end to end against the synthetic Acme dataset in [`fixtures/acme/`](fixtures/acme/), a 20-table Postgres warehouse and a Parquet lake. An agent played the skill and another agent played the data owner from a private brief, over four sessions that include a schema change and a move to open access.

## Develop

```sh
bun install
bash scripts/verify.sh        # typecheck, tests (starts a throwaway Postgres if binaries exist), example validation
bun test tests/scope.test.ts  # one suite
eval "$(bash scripts/pg-local.sh)"   # a local Postgres for the live tests, no Docker
```

All test and fixture data is synthetic. The skill's procedure is [`skills/semantic-layer/SKILL.md`](skills/semantic-layer/SKILL.md), with its phase guides under [`references/`](skills/semantic-layer/references/).

## License

MIT

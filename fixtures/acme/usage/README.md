# Acme usage fixture

Synthetic saved queries and query logs for `sl usage add` (spec: Usage evidence), written the way Acme's analysts would query the warehouse in `../owner-brief.md`: revenue over completed and shipped orders without test accounts, refunds, by region and month. No query, user or value in them describes a real person, company or system.

| Path | What it is |
|---|---|
| `scratch/2023-revenue.sql` | Revenue by month and by region, with an instruction planted in a comment that must change nothing. |
| `scratch/2024-refunds.sql` | Refunds dated by their order, through a CTE; a `filter (where ...)` and a `case when` inside aggregates. |
| `scratch/2024-other-schemas.sql` | Statements on two made-up schemas (`crm`, `hr`), one joining `crm.accounts` to orders, an unqualified `dim_regions` (ambiguous once a second schema has the name), an old table `acme.orders_v1` and a staging table out of scope. |
| `scratch/dbt/revenue_by_region.sql` | A dbt model: `ref` and `source` resolve by table name, `{% %}` and `{# #}` are dropped. |
| `scratch/dbt/purchase_events.sql` | A dbt model whose only table is `{{ var(...) }}`: not understood. |
| `scratch/pasted-from-chat.sql` | A pasted connection string (in a comment and a psql `\connect` line), an e-mail literal, names, a long number and a `dblink` call with a password. None of them may reach the usage file or any output. |
| `scratch/notes.txt` | Not a query file: counted, not read. |
| `logs/pg_stat_statements.json` | A JSON array in pg_stat_statements' shape (`query`, `calls`, `usename`), with `$n` placeholders. |
| `logs/query_history.jsonl` | JSON Lines in a warehouse query history's shape (`QUERY_TEXT`, `USER_NAME`, `START_TIME`), one line a jsonb object exported as text, one with no query text and one that is not JSON. |

The tests (`tests/usage.test.ts`) read it against the Acme example layer's warehouse snapshot with a second schema, `legacy`, that also has a `dim_regions`, and check every count against a hand count.

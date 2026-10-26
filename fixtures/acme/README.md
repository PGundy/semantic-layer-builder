# Acme synthetic dataset

A small, fully synthetic two-source dataset for an online store, used by the example semantic layer, the end-to-end skill run and the tests. No value in it describes a real person or company.

- **Warehouse** (`data/warehouse/*.csv`, loaded into Postgres schema `acme`): 20 tables. Six matter: `fct_orders` (5,000 orders, 2024-01-01 to 2025-12-31), `fct_order_items` (12,343 lines), `fct_refunds` (344 refunds), `dim_customers` (500), `dim_products` (60) and `dim_regions` (6). The rest are realistic clutter: raw ingestion, staging, backups, temp tables, an archive, a test copy, a saved report and operational logs.
- **Lake** (`data/lake/*.parquet`): `web_events` (30,551 events, one file per year under `web_events/`), `sessions` (8,000, about 60% anonymous) and `marketing_spend` (one row per day per paid channel for 2024 and 2025), plus two noise tables.

Money is in integer cents and timestamps are UTC. The data carries the traps a real one does: test accounts flagged two ways, orders whose customer was deleted, partial and split refunds, a nullable `sessions.customer_id`, and a sales region that differs from the customer's home region.

| File | What it is |
|---|---|
| `schema.ts` | Every table's columns, types, keys and comments. |
| `generate.ts` | The deterministic generator (seeded PRNGs, no clock). DuckDB writes the files. |
| `load-postgres.ts` | Drops and recreates a Postgres schema and loads the warehouse CSVs into it. |
| `reference-figures.ts` | Computes `reference-figures.json` from the files with DuckDB. |
| `reference-figures.json` | The 2025 figures the owner knows from their reports, each with its definition, and the figures common mistakes produce. |
| `owner-brief.md` | The brief for whoever plays the data owner, Dana Ruiz, in an end-to-end run. |

## Regenerate

```sh
bun fixtures/acme/generate.ts            # writes fixtures/acme/data
bun fixtures/acme/reference-figures.ts   # writes fixtures/acme/reference-figures.json
```

Both are deterministic: rerunning them reproduces the committed files byte for byte, which `tests/fixture.test.ts` checks. `generate.ts` takes an output directory as its first argument; `reference-figures.ts` takes a data directory and an output file.

## Load the warehouse into Postgres

```sh
eval "$(bash scripts/pg-local.sh)"       # or point PG_URL at any Postgres you own
PG_URL="$PG_URL" bun fixtures/acme/load-postgres.ts [dataDir] [schema]
```

The schema defaults to `acme` and is dropped and recreated. A source over it names the variable `WAREHOUSE_URL` as its `connection.env`, the name the owner brief gives, so export it before connecting: `export WAREHOUSE_URL="$PG_URL"`. The loader declares primary keys on the `dim_` and `fct_` tables and foreign keys from `fct_order_items` to `fct_orders` and `dim_products`, from `fct_refunds` to `fct_orders`, and from `dim_customers.region_code` to `dim_regions`. `fct_orders.customer_id` has no foreign key, because about 1% of its values reference deleted customers. A few tables carry a `COMMENT ON TABLE`, and the load ends with `ANALYZE`.

## Read the lake

The lake needs no loading. A DuckDB source reads it in place, with views such as:

```yaml
views:
  web_events: read_parquet('../fixtures/acme/data/lake/web_events/*.parquet')
  sessions: read_parquet('../fixtures/acme/data/lake/sessions.parquet')
  marketing_spend: read_parquet('../fixtures/acme/data/lake/marketing_spend.parquet')
```

Relative paths resolve from the semantic root.

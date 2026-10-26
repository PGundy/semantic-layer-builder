# Acme example

A semantic layer built by running the skill end to end on the synthetic Acme dataset in `fixtures/acme/`. One agent followed `skills/semantic-layer/SKILL.md`. Another played the data owner from `fixtures/acme/owner-brief.md` and never saw the skill. `interview-transcript.md` is their whole conversation.

- `semantic/sources/`: a Postgres warehouse, scoped to 6 of its 20 tables, and a DuckDB source reading the Parquet lake in place.
- `semantic/models/`: the approved models, including a rule-only `test_accounts` model that revenue reads through a join.
- `semantic/access.yaml`: analyst, sales_rep (own region only) and marketing roles.
- `semantic/goldens/`: questions whose answers match the owner's reference figures, checked at zero tolerance.

To check it yourself:

```sh
eval "$(bash scripts/pg-local.sh)"
psql "$PG_URL" -c "create database acme"
PG_URL="${PG_URL/\/postgres?//acme?}" bun fixtures/acme/load-postgres.ts
export WAREHOUSE_URL="${PG_URL/\/postgres?//acme?}"
cd examples/acme
bun ../../skills/semantic-layer/scripts/sl.ts validate --root semantic
bun ../../skills/semantic-layer/scripts/sl.ts goldens check --root semantic
```

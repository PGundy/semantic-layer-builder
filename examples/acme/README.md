# Acme example

A semantic layer built by running the skill end to end on the synthetic Acme dataset in `fixtures/acme/`. One agent followed `skills/semantic-layer/SKILL.md`. Another played the data owner from `fixtures/acme/owner-brief.md` and never saw the skill. `interview-transcript.md` is their whole conversation over four sessions: building the layer, extending it, bringing it up to date after a schema change, and approving a new access policy.

- `semantic/sources/`: a Postgres warehouse, scoped to the `fct_` and `dim_` tables the owner uses plus the sales hierarchy view, and a DuckDB source reading the Parquet lake in place.
- `semantic/models/`: the approved models. `ignored_columns` records what the owner left out on purpose, such as the gift message nobody may see.
- `semantic/access.yaml`: open by default. Personal data is for analytics only, refunds and net revenue for finance and analytics, and people in sales see only their own and their team's orders and order lines, through the sales hierarchy.
- `semantic/goldens/`: questions whose answers match the owner's reference figures at zero tolerance, including the team and rep figures. New customers stays a draft golden until engineering adds the view it needs.

To check it yourself:

```sh
eval "$(bash scripts/pg-local.sh)"     # a throwaway local Postgres on port 54329
psql "$PG_URL" -c "create database acme"
export WAREHOUSE_URL='postgres://postgres@localhost:54329/acme?host=/tmp/sl-pg'
PG_URL="$WAREHOUSE_URL" bun fixtures/acme/load-postgres.ts
psql "$WAREHOUSE_URL" -v ON_ERROR_STOP=1 -f fixtures/acme/evolve.sql   # the later schema change
cd examples/acme
bun ../../skills/semantic-layer/scripts/sl.ts validate --root semantic
bun ../../skills/semantic-layer/scripts/sl.ts goldens check --root semantic
```

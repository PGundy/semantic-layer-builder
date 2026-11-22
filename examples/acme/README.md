# Acme example

A semantic layer built end to end on the synthetic Acme dataset in `fixtures/acme/`. One agent was the interviewer and followed `skills/semantic-layer/SKILL.md`, the skill behind `/semlayer`. Another played the data owner from `fixtures/acme/owner-brief.md` and never saw the skill. `interview-transcript.md` is their whole conversation over four sessions: building the layer, extending it, bringing it up to date after a schema change, and approving a new access policy.

- `semantic/sources/`: a Postgres warehouse, scoped to the `fct_` and `dim_` tables the owner uses plus the sales hierarchy view, and a DuckDB source reading the Parquet lake in place.
- `semantic/models/`: the approved models. `ignored_columns` records what the owner left out on purpose, such as the gift message nobody may see.
- `semantic/access.yaml`: open by default. Personal data is for analytics only, refunds and net revenue for finance and analytics, and people in sales see only their own and their team's orders and order lines, through the sales hierarchy.
- `semantic/goldens/`: questions whose answers match the owner's reference figures at zero tolerance, including the team and rep figures. New customers stays a draft golden until engineering adds the view it needs.
- `semantic/.semlayer/ledger.jsonl`: the answer ledger. Its one line is the owner's confirmation of every approval of the example as it stands, written by `confirm-approvals.sh` (`semlayer approve --confirm-existing`), since the example's YAML was written by hand rather than through readbacks. An approval counts only while the ledger backs it; run the script again, from the repository root, after changing an approved item of the example on purpose.

To check it yourself, from a clone of this repository after `bun install` at its root (with the plugin's `bin/` on your `PATH`, `semlayer validate --root semantic` is the same as the full form below):

```sh
eval "$(bash scripts/pg-local.sh)"     # a throwaway local Postgres on port 54329
psql "$PG_URL" -c "create database acme"
export WAREHOUSE_URL='postgres://postgres@localhost:54329/acme?host=/tmp/semlayer-pg'
PG_URL="$WAREHOUSE_URL" bun fixtures/acme/load-postgres.ts
psql "$WAREHOUSE_URL" -v ON_ERROR_STOP=1 -f fixtures/acme/evolve.sql   # the later schema change
cd examples/acme
bun ../../skills/semantic-layer/scripts/semlayer.ts validate --root semantic       # "Valid", with one warning about a draft golden
bun ../../skills/semantic-layer/scripts/semlayer.ts goldens check --root semantic
```

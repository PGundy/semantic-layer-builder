-- A later schema change to the Acme warehouse that a layer must notice: fct_orders.amount_cents
-- turns from integer cents into numeric(12,2) dollars under the same name, and shipping_cents is
-- dropped. It names no schema: apply it with the search path set to the warehouse's schema, after
-- load-postgres.ts:
--   PGOPTIONS='-c search_path=acme' psql "$PG_URL" -v ON_ERROR_STOP=1 -f fixtures/acme/evolve-retype.sql
-- Not rerunnable: a second run fails on the column it already dropped.

begin;

alter table fct_orders alter column amount_cents type numeric(12,2) using amount_cents / 100.0;
alter table fct_orders drop column shipping_cents;

commit;
analyze fct_orders;

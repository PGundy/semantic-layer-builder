-- A second schema for the walkthrough of a database that holds two. Synthetic rows only.
--
--   billing.invoices   one row per subscription invoice; customer_id has a foreign key
--                      (invoices_customer_fk) into acme.dim_customers
--
-- Load it after the Acme warehouse (fixtures/acme/load-two-schema.ts does both). The script creates
-- and drops only the schema billing and reads acme only for the key, and the loader renames both
-- schemas to the names it is given, so the words billing and acme appear below only as schema names.
-- Every customer id exists in the loaded dim_customers and none is a test account.
drop schema if exists billing cascade;
create schema billing;

create table billing.invoices (
  invoice_id integer primary key,
  customer_id integer not null,
  issued_on date not null,
  amount_cents integer not null,
  status text not null,
  constraint invoices_customer_fk foreign key (customer_id) references acme.dim_customers (customer_id)
);

comment on table billing.invoices is 'Subscription invoices, one row per invoice. Amounts are integer cents in US dollars.';

insert into billing.invoices (invoice_id, customer_id, issued_on, amount_cents, status) values
  (1, 1, '2025-01-05', 2900, 'paid'),
  (2, 2, '2025-01-12', 4900, 'paid'),
  (3, 3, '2025-02-03', 2900, 'paid'),
  (4, 4, '2025-02-17', 9900, 'paid'),
  (5, 5, '2025-03-09', 4900, 'paid'),
  (6, 6, '2025-03-21', 2900, 'open'),
  (7, 7, '2025-04-02', 9900, 'paid'),
  (8, 8, '2025-04-18', 4900, 'void'),
  (9, 1, '2025-05-05', 2900, 'paid'),
  (10, 2, '2025-05-12', 4900, 'open'),
  (11, 3, '2025-06-03', 2900, 'paid'),
  (12, 4, '2025-06-17', 9900, 'paid');

analyze billing.invoices;

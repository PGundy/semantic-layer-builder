-- A later schema change to the Acme warehouse, for testing how the skill keeps a layer current.
-- Apply after load-postgres.ts:  psql "$PG_URL" -v ON_ERROR_STOP=1 -f fixtures/acme/evolve.sql
-- Deterministic: every value derives from existing keys. Rerunning it is a no-op.

begin;

create table if not exists acme.dim_sales_reps (
  rep_id integer primary key,
  full_name text not null,
  email text not null,
  region_code text references acme.dim_regions (region_code),
  manager_id integer references acme.dim_sales_reps (rep_id)
);
comment on table acme.dim_sales_reps is 'Everyone in sales, one row per person, with their manager.';

insert into acme.dim_sales_reps (rep_id, full_name, email, region_code, manager_id) values
  (301, 'Morgan Hale',   'morgan.hale@acme.example',   null, null),
  (201, 'Riley Chen',    'riley.chen@acme.example',    null, 301),
  (202, 'Sam Okafor',    'sam.okafor@acme.example',    null, 301),
  (203, 'Jamie Lindqvist','jamie.lindqvist@acme.example', null, 301),
  (101, 'Avery Patel',   'avery.patel@acme.example',   'NE', 201),
  (102, 'Blake Romero',  'blake.romero@acme.example',  'NE', 201),
  (103, 'Casey Nguyen',  'casey.nguyen@acme.example',  'SE', 201),
  (104, 'Drew Kowalski', 'drew.kowalski@acme.example', 'SE', 201),
  (105, 'Emery Brooks',  'emery.brooks@acme.example',  'WC', 202),
  (106, 'Finley Adams',  'finley.adams@acme.example',  'WC', 202),
  (107, 'Gray Santos',   'gray.santos@acme.example',   'SW', 202),
  (108, 'Harper Quinn',  'harper.quinn@acme.example',  'SW', 202),
  (109, 'Indy Moreau',   'indy.moreau@acme.example',   'MW', 203),
  (110, 'Jordan Ellis',  'jordan.ellis@acme.example',  'MW', 203),
  (111, 'Kai Fischer',   'kai.fischer@acme.example',   'INT', 203),
  (112, 'Lane Ortiz',    'lane.ortiz@acme.example',    'INT', 203)
on conflict (rep_id) do nothing;

-- One row per (manager, member) pair at any depth below the manager.
create or replace view acme.sales_team_closure as
with recursive pairs (manager_id, member_id) as (
  select manager_id, rep_id from acme.dim_sales_reps where manager_id is not null
  union all
  select r.manager_id, p.member_id
  from pairs p join acme.dim_sales_reps r on r.rep_id = p.manager_id
  where r.manager_id is not null
)
select manager_id, member_id from pairs;
comment on view acme.sales_team_closure is 'Every manager paired with everyone below them in sales, at any depth.';

alter table acme.fct_orders add column if not exists discount_cents integer not null default 0;
alter table acme.fct_orders add column if not exists gift_message text;
alter table acme.fct_orders add column if not exists sales_rep_id integer references acme.dim_sales_reps (rep_id);

update acme.fct_orders set discount_cents = (order_id % 5 + 1) * 250 where order_id % 7 = 0 and discount_cents = 0;
update acme.fct_orders
  set gift_message = 'Gift note on order ' || order_id || ': ' ||
    (array['Happy birthday!', 'Congratulations on the new home.', 'Thinking of you.', 'Enjoy the trip!', 'With love.'])[order_id % 5 + 1]
  where order_id % 9 = 0 and gift_message is null;
update acme.fct_orders o
  set sales_rep_id = (
    select rep_id from acme.dim_sales_reps r
    where r.region_code = o.ship_region
    order by rep_id
    offset (o.order_id % 2) limit 1)
  where sales_rep_id is null;

commit;
analyze acme.fct_orders;
analyze acme.dim_sales_reps;

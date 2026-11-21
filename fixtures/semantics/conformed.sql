-- Orders and refunds with differently named dimensions that mean the same thing, for the conformed-
-- dimension tests (spec: Bridges and multi-fact requests): orders.order_date and refunds.refunded_on are
-- the day, orders.ship_region and refunds.region_code the region. A refund names no order, so no join
-- links the two tables. One file of DDL and inserts that runs unchanged on PostgreSQL and DuckDB. Every
-- value is synthetic.
--
-- Hand-counted, in dollars (cents divided by 100):
-- By month: January orders 30.00 (orders 1 and 2), refunds 2.00 (refund 1); February orders 30.00
-- (order 3), refunds 4.00 (refunds 2 and 4); March orders 5.00 (order 4), no refunds; April no orders,
-- refunds 4.00 (refund 3).
-- By region: east orders 40.00 (orders 1 and 3), refunds 3.00 (refunds 1 and 4); north orders 5.00, no
-- refunds; south no orders, refunds 4.00; west orders 20.00, refunds 3.00.
-- Totals: orders 65.00 over 4 orders, refunds 10.00 over 4 refunds.
create table orders (
  order_id integer primary key,
  ship_region varchar not null,
  amount_cents integer not null,
  order_date date not null
);
create table refunds (
  refund_id integer primary key,
  region_code varchar not null,
  refunded_cents integer not null,
  refunded_on date not null
);

insert into orders (order_id, ship_region, amount_cents, order_date) values
  (1, 'east', 1000, '2025-01-05'),
  (2, 'west', 2000, '2025-01-20'),
  (3, 'east', 3000, '2025-02-10'),
  (4, 'north', 500, '2025-03-15');

insert into refunds (refund_id, region_code, refunded_cents, refunded_on) values
  (1, 'east', 200, '2025-01-25'),
  (2, 'west', 300, '2025-02-02'),
  (3, 'south', 400, '2025-04-03'),
  (4, 'east', 100, '2025-02-20');

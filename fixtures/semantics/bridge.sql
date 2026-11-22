-- Orders, tags and an order-to-tag bridge, for the bridge-join tests (spec: Bridges and multi-fact
-- requests). One file of DDL and inserts that runs unchanged on PostgreSQL and DuckDB. Every value is
-- synthetic.
--
-- Order 1 has two tags, order 2 has three, order 3 has one, order 4 has none, and order 5 repeats its
-- one tag in the bridge (a duplicate pair). Tag 4 is on no order.
-- Order totals in cents: 1000, 2000, 3000, 4000, 500; the true total is 10500.
create table orders (
  order_id integer primary key,
  customer_name varchar not null,
  amount_cents integer not null
);
create table tags (
  tag_id integer primary key,
  tag_name varchar not null
);
create table order_tags (
  order_id integer not null,
  tag_id integer not null,
  share integer not null
);

insert into orders (order_id, customer_name, amount_cents) values
  (1, 'Ada Example', 1000),
  (2, 'Ben Example', 2000),
  (3, 'Cy Example', 3000),
  (4, 'Dee Example', 4000),
  (5, 'Eli Example', 500);

insert into tags (tag_id, tag_name) values
  (1, 'gift'),
  (2, 'rush'),
  (3, 'wholesale'),
  (4, 'unused');

insert into order_tags (order_id, tag_id, share) values
  (1, 1, 1),
  (1, 2, 3),
  (2, 1, 1),
  (2, 2, 1),
  (2, 3, 2),
  (3, 3, 1),
  (5, 1, 1),
  (5, 1, 1);

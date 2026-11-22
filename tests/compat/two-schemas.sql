-- Two schemas on one server, for the live tests of schema pairs. Synthetic rows only.
--
--   sales.orders      a foreign key into crm.customers (orders_customer_fk), and one within sales (orders_store_fk)
--   sales.stores      a table inside sales
--   sales.customers   a table named like crm.customers, with its own key
--   crm.customers     the table the foreign key above points at
--
-- Load it as one script (Bun: await sql.unsafe(readFileSync(path, "utf8"))) and remove it with
-- `drop schema sales, crm cascade`. The schema names are fixed, so run it on a scratch server.
create schema sales;
create schema crm;

create table crm.customers (
  customer_id integer primary key,
  email text not null,
  region text
);

create table sales.customers (
  customer_id integer primary key,
  name text not null
);

create table sales.stores (
  store_id integer primary key,
  city text not null
);

create table sales.orders (
  order_id integer primary key,
  customer_id integer not null,
  store_id integer not null,
  amount_cents bigint not null,
  constraint orders_customer_fk foreign key (customer_id) references crm.customers (customer_id),
  constraint orders_store_fk foreign key (store_id) references sales.stores (store_id)
);

insert into crm.customers values (1, 'a@example.test', 'north'), (2, 'b@example.test', 'south');
insert into sales.customers values (1, 'Ada'), (2, 'Ben');
insert into sales.stores values (1, 'Oslo'), (2, 'Lima');
insert into sales.orders values (1, 1, 1, 1250), (2, 2, 2, 4000), (3, 1, 2, 800);

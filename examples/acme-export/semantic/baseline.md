# Baseline brief: warehouse

A first reading of the warehouse schema (postgres, from an information schema import captured 2026-11-05): 12 tables of 22 in scope. Everything below is a guess from names and keys, for the owner to confirm or correct; nothing here is settled.

> 22 tables are in scope, more than the focus threshold of 12: this brief covers the top 12 by size, references and naming and leaves out 10 tables. Narrow the scope with `sl scope --source warehouse --include <pattern> --write` (`sl tables --source warehouse --groups` suggests patterns), or name tables with --tables.

> Suggested names drop the prefixes fct_, dim_, as `sl draft --strip-prefix fct_,dim_` would.

> No table in this brief has a profile, so key uniqueness, value counts and which columns are near-unique are guesses from names.

## Star-schema sketch (a guess)

- **acme.fct_orders** (fact, one row per order) joins acme.dim_sales_reps via sales_rep and acme.dim_customers via customer
  - **acme.fct_order_items** (fact, one row per order item (several per order)) joins acme.dim_products via product
  - **acme.fct_refunds** (fact, one row per refund (several per order)) joins no dimension
- **acme.audit_log** (event, one row per audit log) joins no dimension
- Dimensions: acme.dim_sales_reps, acme.dim_regions, acme.dim_products, acme.dim_customers, acme.dim_currency
- Dimensions no fact here joins to: acme.dim_currency
- Staging: acme.raw_shopify_orders, acme.raw_stripe_charges
- Noise: acme.etl_job_runs

Does this match how the business thinks about the data? Which of these facts matter most?

## Tables

### acme.fct_orders: probably a fact (things that happened, with numbers to add up)

- 5,000 rows (the catalog's estimate); not profiled
- Comment: Orders from the storefront, one row per order. Amounts in integer cents.
- Why fact: fact table naming; money to add up (amount, shipping and discount); points at 2 other tables; a date or time column (created_at)
- Grain (guess): one row per order, from the table comment and the declared primary key order_id
- Key: order_id (the declared primary key)
- Relationships:
  - sales_rep_id → acme.dim_sales_reps (rep_id): probably many-to-one, join `sales_rep`; from a declared foreign key
  - customer_id → acme.dim_customers (customer_id): probably many-to-one, join `customer`; from the column name customer_id and the key of acme.dim_customers
  - acme.fct_order_items (order_id) → order_id: probably one-to-many; from a declared foreign key
    - Fan-out warning: one order has several rows in acme.fct_order_items: joining it repeats this table's rows, so its measures must not be summed across order items.
  - acme.fct_refunds (order_id) → order_id: probably one-to-many; from a declared foreign key
    - Fan-out warning: one order has several rows in acme.fct_refunds: joining it repeats this table's rows, so its measures must not be summed across refunds.
- Candidate measures:
  - `order_count` = count(*): the number of rows: how many orders, probably
  - `customer_count` = count_distinct(customer_id): distinct customer_id: how many different customers
  - `amount` = sum(amount_cents / 100.0): the total of amount_cents (probably stored in cents, by its name; divided by 100 to report whole currency units)
  - `shipping` = sum(shipping_cents / 100.0): the total of shipping_cents (probably stored in cents, by its name; divided by 100 to report whole currency units)
  - `discount` = sum(discount_cents / 100.0): the total of discount_cents (probably stored in cents, by its name; divided by 100 to report whole currency units)
  - `avg_amount_per_order` = amount ÷ order_count: amount divided by order_count: the average amount per order, the average order value
- Candidate splits:
  - `created_at` by hour, day, week, month, quarter, year
  - `status` (category; by its name; a profile would count its values)
  - `ship_region` (category; by its name; a profile would count its values)
  - `currency` (category; by its name; a profile would count its values)
  - `sales_rep.region.region_name` (category; through the joins sales_rep then region to acme.dim_regions; by its name; a profile would count its values)
  - `sales_rep.region.country_code` (category; through the joins sales_rep then region to acme.dim_regions; by its name; a profile would count its values)
  - `customer.acquisition_channel` (category; through the join customer to acme.dim_customers; by its name; a profile would count its values)
  - `customer.region.region_name` (category; through the joins customer then region to acme.dim_regions; by its name; a profile would count its values)
  - `customer.region.country_code` (category; through the joins customer then region to acme.dim_regions; by its name; a profile would count its values)
- Not splits: order_id (the table's key: one value per row); customer_id (probably a key to acme.dim_customers; split by its attributes instead (customer.acquisition_channel)); amount_cents (a number to add up, not a split); shipping_cents (a number to add up, not a split); discount_cents (a number to add up, not a split); gift_message (the name gift_message looks like a credential or free text); sales_rep_id (a key to acme.dim_sales_reps)
- Questions for the owner:
  1. What is one row of acme.fct_orders? Our guess: one row per order, from the table comment and the declared primary key order_id.
  2. Which values of status count as a real order in reports, and which should be left out (cancelled, refunded, pending, test)?
  3. Is created_at the date to report orders by, and in which time zone should days be counted?
  4. amount_cents, shipping_cents and discount_cents look like money stored in cents, so the brief divides them by 100: is that right? Which currency are they in? The table has currency: do rows mix currencies, and should amounts be converted?
  5. gift_message looks sensitive (the name gift_message looks like a credential or free text). Who may see it? The brief keeps it out of splits.

### acme.fct_order_items: probably a fact (things that happened, with numbers to add up)

- 12,343 rows (the catalog's estimate); not profiled
- Why fact: fact table naming; money to add up (line_total); points at 2 other tables
- Grain (guess): one row per order item (several per order), from the declared primary key order_item_id
- Key: order_item_id (the declared primary key)
- Relationships:
  - order_id → acme.fct_orders (order_id): probably many-to-one, join `order`; from a declared foreign key
    - Fan-out warning: acme.fct_order_items is probably the many side of acme.fct_orders, a likely fact: several order items per order. Joining acme.fct_orders to these rows repeats each order once per row, so its measures (amount, shipping and discount) would be overstated; keep order measures on acme.fct_orders, or add these rows up to the order first.
  - product_id → acme.dim_products (product_id): probably many-to-one, join `product`; from a declared foreign key
- Candidate measures:
  - `order_item_count` = count(*): the number of rows: how many order items, probably
  - `order_count` = count_distinct(order_id): distinct order_id: how many different orders
  - `product_count` = count_distinct(product_id): distinct product_id: how many different products
  - `quantity` = sum(quantity): the total of quantity (a count of units or things)
  - `avg_unit_price` = avg(unit_price_cents / 100.0): the average of unit_price_cents, a per-unit figure: averaged rather than summed (probably stored in cents; divided by 100 to report whole currency units)
  - `line_total` = sum(quantity * (unit_price_cents / 100.0)): the total of quantity times unit_price_cents, a line total (probably stored in cents, by its name; divided by 100 to report whole currency units)
  - `avg_line_total_per_order_item` = line_total ÷ order_item_count: line_total divided by order_item_count: the average line total per order item
- Candidate splits:
  - `order.status` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.ship_region` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.currency` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.customer.acquisition_channel` (category; through the joins order then customer to acme.dim_customers; by its name; a profile would count its values)
  - `product.category` (category; through the join product to acme.dim_products; by its name; a profile would count its values)
  - `product.is_active` (flag; through the join product to acme.dim_products; a true/false flag)
- Not splits: order_item_id (the table's key: one value per row); order_id (a key to acme.fct_orders; split by its attributes instead (order.status or order.ship_region)); product_id (a key to acme.dim_products; split by its attributes instead (product.category or product.is_active)); quantity (a number to add up, not a split); unit_price_cents (a number to average, not a split)
- Questions for the owner:
  1. What is one row of acme.fct_order_items? Our guess: one row per order item (several per order), from the declared primary key order_item_id.
  2. unit_price_cents looks like money stored in cents, so the brief divides it by 100: is that right? Which currency is it in?

### acme.fct_refunds: probably a fact (things that happened, with numbers to add up)

- 344 rows (the catalog's estimate); not profiled
- Comment: Refunds issued against orders. An order can have several partial refunds.
- Why fact: fact table naming; money to add up (refunded); points at 1 other table; a date or time column (refunded_at)
- Grain (guess): one row per refund (several per order), from the declared primary key refund_id
- Key: refund_id (the declared primary key)
- Relationships:
  - order_id → acme.fct_orders (order_id): probably many-to-one, join `order`; from a declared foreign key
    - Fan-out warning: acme.fct_refunds is probably the many side of acme.fct_orders, a likely fact: several refunds per order. Joining acme.fct_orders to these rows repeats each order once per row, so its measures (amount, shipping and discount) would be overstated; keep order measures on acme.fct_orders, or add these rows up to the order first.
- Candidate measures:
  - `refund_count` = count(*): the number of rows: how many refunds, probably
  - `order_count` = count_distinct(order_id): distinct order_id: how many different orders
  - `refunded` = sum(refunded_cents / 100.0): the total of refunded_cents (probably stored in cents, by its name; divided by 100 to report whole currency units)
  - `avg_refunded_per_refund` = refunded ÷ refund_count: refunded divided by refund_count: the average refunded per refund
- Candidate splits:
  - `refunded_at` by hour, day, week, month, quarter, year
  - `order.status` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.ship_region` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.currency` (category; through the join order to acme.fct_orders; by its name; a profile would count its values)
  - `order.customer.acquisition_channel` (category; through the joins order then customer to acme.dim_customers; by its name; a profile would count its values)
- Not splits: refund_id (the table's key: one value per row); order_id (a key to acme.fct_orders; split by its attributes instead (order.status or order.ship_region)); refunded_cents (a number to add up, not a split)
- Unclear until profiled: reason
- Questions for the owner:
  1. What is one row of acme.fct_refunds? Our guess: one row per refund (several per order), from the declared primary key refund_id.
  2. Is refunded_at the date to report refunds by, and in which time zone should days be counted?
  3. refunded_cents looks like money stored in cents, so the brief divides it by 100: is that right? Which currency is it in?

### acme.audit_log: probably an event log

- 500 rows (the catalog's estimate); not profiled
- Why event: name contains "audit"; an action column; a timestamp, logged_at
- Grain (guess): one row per audit log, from the column name audit_id (a guess until a profile checks it is unique)
- Key: audit_id (the column name only; a profile would check it is unique)
- Candidate measures:
  - `audit_log_count` = count(*): the number of rows: how many audits, probably
  - `entity_count` = count_distinct(entity_id): distinct entity_id: how many different entities
- Candidate splits:
  - `logged_at` by hour, day, week, month, quarter, year
- Not splits: audit_id (probably the table's key: one value per row); entity_id (an id)
- Unclear until profiled: actor, action, entity
- Questions for the owner:
  1. What is one row of acme.audit_log? Our guess: one row per audit log, from the column name audit_id (a guess until a profile checks it is unique). The key audit_id is a guess from its name.
  2. Is logged_at the date to report audits by, and in which time zone should days be counted?

### acme.dim_sales_reps: probably a dimension (it describes things)

- 16 rows (the catalog's estimate); not profiled
- Comment: Everyone in sales, one row per person, with their manager.
- Why dimension: dimension table naming; referenced by 1 table
- Grain (guess): one row per person, from the table comment and the declared primary key rep_id
- Key: rep_id (the declared primary key)
- Relationships:
  - manager_id → acme.dim_sales_reps (rep_id): probably many-to-one, join `manager`; from a declared foreign key
  - region_code → acme.dim_regions (region_code): probably many-to-one, join `region`; from a declared foreign key
  - acme.fct_orders (sales_rep_id) → rep_id: probably one-to-many; from a declared foreign key
- Candidate measures:
  - `sales_rep_count` = count(*): the number of rows: how many reps, probably
- Candidate splits:
  - `region.region_name` (category; through the join region to acme.dim_regions; by its name; a profile would count its values)
  - `region.country_code` (category; through the join region to acme.dim_regions; by its name; a profile would count its values)
- Not splits: rep_id (the table's key: one value per row); full_name (the name full_name looks like personal data (pii)); email (the name email looks like personal data (pii)); region_code (a key to acme.dim_regions; split by its attributes instead (region.region_name or region.country_code)); manager_id (a key to acme.dim_sales_reps)
- Questions for the owner:
  1. What is one row of acme.dim_sales_reps? Our guess: one row per person, from the table comment and the declared primary key rep_id.
  2. full_name and email look like personal data. Who may see them? The brief keeps them out of splits.

### acme.dim_regions: probably a dimension (it describes things)

- 6 rows (the catalog's estimate); not profiled
- Comment: Sales regions. One row per region.
- Why dimension: dimension table naming; referenced by 2 tables
- Grain (guess): one row per region, from the table comment and the declared primary key region_code
- Key: region_code (the declared primary key)
- Relationships:
  - acme.dim_customers (region_code) → region_code: probably one-to-many; from a declared foreign key
  - acme.dim_sales_reps (region_code) → region_code: probably one-to-many; from a declared foreign key
- Candidate measures:
  - `region_count` = count(*): the number of rows: how many regions, probably
- Candidate splits:
  - `region_name` (category; by its name; a profile would count its values)
  - `country_code` (category; by its name; a profile would count its values)
- Not splits: region_code (the table's key: one value per row)
- Unclear until profiled: timezone
- Questions for the owner:
  1. What is one row of acme.dim_regions? Our guess: one row per region, from the table comment and the declared primary key region_code.

### acme.dim_products: probably a dimension (it describes things)

- 60 rows (the catalog's estimate); not profiled
- Why dimension: dimension table naming; referenced by 1 table
- Grain (guess): one row per product, from the declared primary key product_id
- Key: product_id (the declared primary key)
- Relationships:
  - acme.fct_order_items (product_id) → product_id: probably one-to-many; from a declared foreign key
- Candidate measures:
  - `product_count` = count(*): the number of rows: how many products, probably
  - `avg_list_price` = avg(list_price_cents / 100.0): the average of list_price_cents, a per-unit figure: averaged rather than summed (probably stored in cents; divided by 100 to report whole currency units)
  - `active_share` = avg(case when is_active then 1 else 0 end): the share of products where is_active is true
- Candidate splits:
  - `category` (category; by its name; a profile would count its values)
  - `is_active` (flag; a true/false flag)
  - `launched_on` by day, week, month, quarter, year
- Not splits: product_id (the table's key: one value per row); list_price_cents (a number to average, not a split)
- Unclear until profiled: sku, product_name
- Questions for the owner:
  1. What is one row of acme.dim_products? Our guess: one row per product, from the declared primary key product_id.
  2. list_price_cents looks like money stored in cents, so the brief divides it by 100: is that right? Which currency is it in?

### acme.dim_customers: probably a dimension (it describes things)

- 500 rows (the catalog's estimate); not profiled
- Comment: Customer accounts, one row per customer. Includes internal test accounts.
- Why dimension: dimension table naming; referenced by 1 table
- Grain (guess): one row per customer, from the table comment and the declared primary key customer_id
- Key: customer_id (the declared primary key)
- Relationships:
  - region_code → acme.dim_regions (region_code): probably many-to-one, join `region`; from a declared foreign key
  - acme.fct_orders (customer_id) → customer_id: probably one-to-many; from the column name customer_id and the key of acme.dim_customers
- Candidate measures:
  - `customer_count` = count(*): the number of rows: how many customers, probably
- Candidate splits:
  - `signup_at` by hour, day, week, month, quarter, year
  - `acquisition_channel` (category; by its name; a profile would count its values)
  - `region.region_name` (category; through the join region to acme.dim_regions; by its name; a profile would count its values)
  - `region.country_code` (category; through the join region to acme.dim_regions; by its name; a profile would count its values)
- Not splits: customer_id (the table's key: one value per row); email (the name email looks like personal data (pii)); phone (the name phone looks like personal data (pii)); first_name (the name first_name looks like personal data (pii)); last_name (the name last_name looks like personal data (pii)); region_code (a key to acme.dim_regions; split by its attributes instead (region.region_name or region.country_code))
- Questions for the owner:
  1. What is one row of acme.dim_customers? Our guess: one row per customer, from the table comment and the declared primary key customer_id.
  2. Should rows where is_test_account marks a test be left out of every metric? The table comment mentions test or internal rows too.
  3. email, phone, first_name and last_name look like personal data. Who may see them? The brief keeps them out of splits.

### acme.dim_currency: probably a dimension (it describes things)

- 3 rows (the catalog's estimate); not profiled
- Why dimension: dimension table naming
- Grain (guess): one row per currency code, from the declared primary key currency_code
- Key: currency_code (the declared primary key)
- Candidate measures:
  - `currency_count` = count(*): the number of rows: how many currencies, probably
  - `minor_units` = sum(minor_units): the total of minor_units; this table probably describes things, so this is probably not something to add up: confirm (a count of units or things)
- Candidate splits:
  - `currency_name` (category; by its name; a profile would count its values)
- Not splits: currency_code (the table's key: one value per row); minor_units (a number to add up, not a split)
- Questions for the owner:
  1. What is one row of acme.dim_currency? Our guess: one row per currency code, from the declared primary key currency_code.

### acme.raw_shopify_orders: probably raw or staging data

- 300 rows (the catalog's estimate); not profiled
- Comment: Raw Shopify order export, loaded by the ingestion job. Not cleaned.
- Why staging: raw or staging naming; the table comment says it is raw or uncleaned
- Grain (guess): one row per shopify order, from the column name id (a guess until a profile checks it is unique)
- Key: id (the column name only; a profile would check it is unique)
- Candidate measures:
  - `raw_shopify_order_count` = count(*): the number of rows: how many shopify orders, probably
- Candidate splits:
  - `financial_status` (category; by its name; a profile would count its values)
- Not splits: id (probably the table's key: one value per row); email (the name email looks like personal data (pii))
- Unclear until profiled: name, created_at, total_price
- Questions for the owner:
  1. What is one row of acme.raw_shopify_orders? Our guess: one row per shopify order, from the column name id (a guess until a profile checks it is unique). The key id is a guess from its name. It looks like raw or staging data: should reports read a cleaned table instead?
  2. Which values of financial_status count as a real shopify order in reports, and which should be left out (cancelled, refunded, pending, test)?
  3. email looks like personal data. Who may see it? The brief keeps it out of splits.

### acme.raw_stripe_charges: probably raw or staging data

- 300 rows (the catalog's estimate); not profiled
- Why staging: raw or staging naming
- Grain (guess): one row per stripe charge, from the column name charge_id (a guess until a profile checks it is unique)
- Key: charge_id (the column name only; a profile would check it is unique)
- Candidate measures:
  - `raw_stripe_charge_count` = count(*): the number of rows: how many charges, probably
  - `amount` = sum(amount): the total of amount (money; the snapshot does not say the unit (whole units or cents) or the currency)
  - `avg_created` = avg(created): the average of created; its name suggests a timestamp stored as a number, which is probably not a measure at all: confirm
  - `avg_amount_per_charge` = amount ÷ raw_stripe_charge_count: amount divided by raw_stripe_charge_count: the average amount per charge
- Candidate splits:
  - `currency` (category; by its name; a profile would count its values)
  - `status` (category; by its name; a profile would count its values)
- Not splits: charge_id (probably the table's key: one value per row); amount (a number to add up, not a split); created (a number to average, not a split)
- Unclear until profiled: order_ref
- Questions for the owner:
  1. What is one row of acme.raw_stripe_charges? Our guess: one row per stripe charge, from the column name charge_id (a guess until a profile checks it is unique). The key charge_id is a guess from its name. It looks like raw or staging data: should reports read a cleaned table instead?
  2. Which values of status count as a real charge in reports, and which should be left out (cancelled, refunded, pending, test)?
  3. Is amount in whole currency units or in cents? Which currency is it in? The table has currency: do rows mix currencies, and should amounts be converted?

### acme.etl_job_runs: probably noise (a copy, backup, test or bookkeeping table)

- 120 rows (the catalog's estimate); not profiled
- Why noise: name contains "etl": pipeline bookkeeping
- Grain (guess): one row per etl job run, from the column name run_id (a guess until a profile checks it is unique)
- Key: run_id (the column name only; a profile would check it is unique)
- Left out of measures and splits as likely noise.
- Questions for the owner:
  1. acme.etl_job_runs looks like noise (name contains "etl": pipeline bookkeeping). Can it be left out of the semantic layer?

## What a profile would measure

`sl profile --source warehouse --tables acme.fct_orders,acme.fct_order_items,acme.fct_refunds,acme.audit_log,acme.dim_sales_reps,acme.dim_regions,acme.dim_products,acme.dim_customers,acme.dim_currency,acme.raw_shopify_orders,acme.raw_stripe_charges` reads the data (counts, distinct values, top values; protected columns are hashed) and would replace these guesses with measurements:
- acme.fct_orders: how many distinct values status, ship_region and currency hold, to confirm which are splits and which are near-unique; the values of status and how often each occurs; the range and null share of created_at
- acme.fct_refunds: how many distinct values reason hold, to confirm which are splits and which are near-unique; the range and null share of refunded_at
- acme.audit_log: whether audit_id is unique and never null, as a key must be; how many distinct values actor, action and entity hold, to confirm which are splits and which are near-unique; the range and null share of logged_at
- acme.dim_regions: how many distinct values region_name, country_code and timezone hold, to confirm which are splits and which are near-unique
- acme.dim_products: how many distinct values category, sku and product_name hold, to confirm which are splits and which are near-unique; the range and null share of launched_on
- acme.dim_customers: how many distinct values acquisition_channel hold, to confirm which are splits and which are near-unique; the range and null share of signup_at
- acme.dim_currency: how many distinct values currency_name hold, to confirm which are splits and which are near-unique
- acme.raw_shopify_orders: whether id is unique and never null, as a key must be; how many distinct values financial_status, name, created_at and total_price hold, to confirm which are splits and which are near-unique; the values of financial_status and how often each occurs
- acme.raw_stripe_charges: whether charge_id is unique and never null, as a key must be; how many distinct values currency, status and order_ref hold, to confirm which are splits and which are near-unique; the values of status and how often each occurs

## Left out (10)

acme.stg_orders, acme.stg_customers, acme.fct_orders_v2_test, acme.sales_team_closure, acme.dim_customers_archive, acme.orders_backup_2024, acme.customers_tmp, acme.schema_migrations, acme.tmp_import_errors, acme.report_daily_sales_20250101

# Owner brief: Dana Ruiz, Head of Analytics, Acme

This is the private brief for whoever plays Acme's data owner. Answer as Dana, in the first person, using only what is written here. Acme and all of its data are synthetic.

When a question is covered below, give that answer. When it is not, say you don't know or would need to check; don't invent a rule. When you are shown a plain-English readback of something and it matches this brief, confirm it. When it doesn't, say exactly what is wrong. Your name for sign-offs is "Dana Ruiz".

## Who I am and what we have

I run analytics at Acme, an online store selling apparel, footwear, accessories, home goods and outdoor gear in the US plus some international orders. Everything is priced and charged in US dollars.

We have two data sources:

- **The warehouse**: a Postgres replica, schema `acme`, about 20 tables. Its connection URL is in the environment variable `WAREHOUSE_URL`; that name is all I'll give you, never the URL itself.
- **The lake**: Parquet files our event pipeline writes, under `fixtures/acme/data/lake/` in the repository. No connection URL is needed; the files are read in place. `web_events` is split into one file per year (`web_events/web_events_2024.parquet`, `web_events/web_events_2025.parquet`); `sessions.parquet` and `marketing_spend.parquet` are single files.

All timestamps in both sources are UTC, and our reports use UTC dates.

## Which tables matter

Most of the warehouse is clutter from ingestion and one-off work. Please don't make me go through all of it.

Warehouse, in scope:

- `fct_orders`, `fct_order_items`, `fct_refunds`
- `dim_customers`, `dim_products`, `dim_regions`

As a rule: the `fct_` and `dim_` tables, except `dim_customers_archive` (an old snapshot), `fct_orders_v2_test` (an abandoned experiment) and `dim_currency` (unused; everything is USD).

Warehouse, ignore: `raw_shopify_orders` and `raw_stripe_charges` (raw ingestion, not cleaned), `stg_orders` and `stg_customers` (staging for the fct and dim tables), `orders_backup_2024` and `customers_tmp` (one-off copies), `report_daily_sales_20250101` (a single day's report someone saved as a table), `audit_log`, `schema_migrations`, `etl_job_runs`, `tmp_import_errors` (operational).

Lake, in scope: `web_events`, `sessions`, `marketing_spend`. Ignore `web_events_2024_archive` (a partial copy) and `tmp_session_dedupe` (a scratch table from a cleanup job).

I'd like plain names for the models: `orders`, `order_items`, `refunds`, `customers`, `products`, `regions`. The lake names are fine as they are.

## The warehouse tables

### fct_orders: one row per order

- `order_id`: unique order number.
- `customer_id`: the customer who placed it. About 1% of orders point at customers who are no longer in `dim_customers`: their accounts were deleted on request, but the orders are real and still count. That's why there's no foreign key on this column. Never drop those orders by inner-joining to customers.
- `created_at`: when the order was placed, UTC. Orders run from 2024-01-01 to 2025-12-31.
- `status`: one of
  - `completed`: delivered. Counts as revenue.
  - `shipped`: on its way, not yet marked delivered. Counts as revenue. Most orders from the last two weeks of December 2025 are still in this state.
  - `cancelled`: cancelled before fulfilment, never charged. Not revenue.
  - `refunded`: fully refunded. Not revenue.
- `amount_cents`: merchandise total in **integer cents**, after any item discounts. It equals the sum of quantity times unit price over the order's items. It excludes shipping and tax. Divide by 100 for dollars.
- `shipping_cents`: shipping charged, in cents. Free over $75, $5.99 in the US and $19.99 internationally below that. Shipping is **not** revenue.
- `ship_region`: the region the order shipped to. This is the sales region: regional reporting and sales territories use it, not the customer's home region. They differ for a few percent of orders.
- `currency`: always `USD`.

### fct_order_items: one row per line item

- `order_item_id`: unique.
- `order_id`: the order (many items per order).
- `product_id`: the product.
- `quantity`: units on the line.
- `unit_price_cents`: price per unit paid, in cents, after any discount.

### fct_refunds: one row per refund transaction

- `refund_id`: unique.
- `order_id`: the refunded order. An order can have more than one refund.
- `refunded_cents`: the amount refunded in this transaction, in cents. Most refunds are **partial**. A fully refunded order (status `refunded`) has refunds adding up to its whole `amount_cents`, sometimes split over two rows.
- `refunded_at`: when the refund was issued, UTC. It can fall in the year after the order.
- `reason`: `damaged`, `wrong_item`, `late_delivery`, `customer_request` or `price_adjustment`.

Completed or shipped orders that got a partial refund keep their status.

### dim_customers: one row per customer account

- `customer_id`: unique.
- `email`, `phone`, `first_name`, `last_name`: contact details. `phone` is often empty.
- `signup_at`: when the account was created, UTC.
- `region_code`: the customer's home region, a code from `dim_regions`.
- `is_test_account`: true for internal test accounts.
- `acquisition_channel`: how the customer first found us: `organic`, `paid_search`, `paid_social`, `email`, `referral`, `affiliate` or `display`.

Test accounts: QA creates accounts and places real-looking orders. Some have `is_test_account` set, but QA doesn't always remember to set it. Any account whose email ends in `@example-test.com` is also a test account, flag or not. Both kinds are excluded from every business figure.

### dim_products: one row per product

`product_id` (unique), `sku`, `product_name`, `category` (apparel, footwear, accessories, home, outdoor), `list_price_cents` (current list price in cents; what customers paid is on the order items), `is_active` (still on sale) and `launched_on`.

### dim_regions: one row per sales region

`region_code` (unique: `NE`, `SE`, `MW`, `SW`, `WC`, `INT`), `region_name`, `country_code` (`ZZ` for International) and `timezone`.

## The lake tables

### web_events: one row per tracked event

- `event_id`: unique.
- `session_id`: the session it belongs to.
- `event_at`: when it happened, UTC.
- `event_type`: `page_view`, `search`, `add_to_cart`, `checkout_start` or `purchase`.
- `page_path`: the page, for example `/`, `/products/12`, `/cart`, `/checkout`.

The `purchase` event is front-end tracking. It is not the source of truth for orders; `fct_orders` is.

### sessions: one row per visit

- `session_id`: unique.
- `customer_id`: the logged-in customer, the same id as `dim_customers.customer_id`. It is empty for anonymous visitors, which is about 60% of sessions.
- `started_at`: when the visit started, UTC.
- `utm_channel`: the marketing channel of the visit. The values match `marketing_spend.channel` exactly for paid channels; `organic` and `referral` have no spend; empty means direct traffic.
- `device`: `mobile`, `desktop` or `tablet`.

### marketing_spend: one row per day per paid channel

- `spend_date`: the day.
- `channel`: `paid_search`, `paid_social`, `email`, `affiliate` or `display`.
- `spend_cents`: spend that day, in cents.
- `impressions`, `clicks`: as reported by the ad platforms.

## How the tables relate

- Each order item belongs to one order, and each order has one or more items. Each item has one product.
- Each refund belongs to one order; an order has zero, one or a few refunds. Joining refunds onto orders multiplies order rows, so refunds must be summed per order before they are combined with order figures.
- Each order has one customer by `customer_id`, except the ~1% whose customer was deleted. Keep those orders.
- Each customer's `region_code` is a region in `dim_regions`; so is each order's `ship_region`.
- Each web event belongs to one session.
- `sessions.customer_id` is the warehouse customer id, but the lake and the warehouse are separate systems, so we don't join across them in queries. We line them up in reports.

## Business definitions

- **Revenue**: the sum of `amount_cents` / 100 over orders with status `completed` or `shipped`, excluding orders by test accounts (flagged, or email at `example-test.com`). Orders from deleted customers count. Shipping is excluded. Dated by when the order was placed (`created_at`, UTC). Formatted as US dollars.
- **Order count**: the number of orders counted in revenue, by the same rule.
- **Average order value (AOV)**: revenue divided by order count.
- **Refunds**: the sum of `refunded_cents` / 100 over refunds of orders counted in revenue, attributed to the order's date, not the refund's date.
- **Net revenue**: revenue minus those refunds. Refunds of `refunded` orders are not subtracted again, because those orders are already outside revenue.
- **Sessions**: the number of sessions, anonymous ones included, dated by `started_at`.
- **Conversion rate**: converted sessions divided by sessions, where a session converts when it has a customer who placed an order counted in revenue on the same UTC date the session started.
- **Marketing spend**: the sum of `spend_cents` / 100.
- **New customers**: customers whose first order counted in revenue falls in the period.
- **CAC (customer acquisition cost)**: marketing spend in the period divided by new customers in the period. We report one blended figure, not per channel.

Conversion rate and CAC combine the lake and the warehouse, so they are computed in our reports, not as a single metric. As metrics, per source, I want sessions and spend from the lake, and new customers and order counts from the warehouse.

## Who may see what

People who use this are in one of three roles:

- **analyst** (the default): everything in scope except personal data. Personal data means `dim_customers.email`, `phone`, `first_name` and `last_name`. Customer ids are fine; they are internal ids.
- **sales_rep**: only orders and customers, and only for their own region. Each rep has one region, a user attribute called `region` holding a region code such as `NE`. For orders, "their region" means `ship_region`; for customers it means `region_code`. They can see the names and phone numbers of their own region's customers, but not emails. No refunds, products, items or lake data.
- **marketing**: the three lake tables, plus orders as aggregates only: revenue, order count and AOV by date, status and region. No personal data, no customer-level detail and no refunds.

## Figures I trust

The numbers from my own reports are in `fixtures/acme/reference-figures.json`, each with its definition. When asked what a figure should be, or whether a result looks right, compare against that file. For example, 2025 revenue there is the figure finance signs off on. If a result is off, the `common_mistakes` section in that file shows what you get when a rule is missed; say which rule looks missed in plain words ("that looks like it includes test accounts"), rather than quoting the file.

## Later changes (third session only)

Engineering changed the warehouse after our second session, and we changed our access policy. This section applies only when the agent says the warehouse has changed or asks about access again. Until then, answer from the sections above.

**New columns on `fct_orders`.**

- `discount_cents`: the discount given on the order, in cents. `amount_cents` is already after the discount, so it does not change revenue. A total of discounts is useful ("discounts"), counted with the same rules as revenue.
- `gift_message`: a note the buyer wrote for a gift. Nobody using the chat tool may see it, ever. Leave it out of the layer.
- `sales_rep_id`: the sales rep credited with the order. Every order has one.

**New in sales.** `dim_sales_reps` has one row per person in sales: `rep_id`, `full_name`, `email`, `region_code` and `manager_id`. `full_name` and `email` are personal data. Reps report to one of three managers (201, 202, 203), who report to the head of sales, Morgan Hale (301). The view `sales_team_closure` pairs every manager with everyone below them, at any depth, as `manager_id` and `member_id`.

**Our new access policy.** We want it simple: everyone at Acme may see every approved figure, with these exceptions.

- Personal data (customer email, phone, first and last name, and sales people's names and emails): only analysts. Analysts are people whose `department` is `analytics`.
- Refunds and net revenue: only people whose `department` is `finance` or `analytics`.
- People in sales (`department` is `sales`) see only orders credited to them or to someone below them in the sales hierarchy. Their user attribute `employee_id` is their `rep_id`. A rep sees their own orders; a manager sees their team's; Morgan sees every order. This replaces the old region rule, so the region-based sales rep checks go away.
- Marketing no longer needs its own restrictions.
- Anyone with no department attribute gets the everyone view.

**Figures I know for 2025** (same revenue rules as always):

- Revenue on orders credited to manager 201's team: $130,391.03 from 957 orders. Manager 202's team: $115,211.49 from 873. Manager 203's team: $55,448.30 from 409.
- Rep 101 (Avery Patel): $34,938.49 from 251 orders.
- Discounts on counted 2025 orders: $2,340.00 across 311 orders.

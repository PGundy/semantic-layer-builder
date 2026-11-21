# Semantics fixtures

Small SQL files that give a semantics test the data it needs, each one file of DDL and inserts that runs unchanged on PostgreSQL and DuckDB. Every value is synthetic.

- `bridge.sql`: orders, tags and the `order_tags` bridge between them, with orders that have two tags, three tags, one tag, none and a duplicated pair. The comment at the top of the file gives the hand-counted totals the bridge tests check.
- `balances.sql`: daily balance snapshots of two accounts across January and February 2024, one account without a row on the last day of January. The comment at the top of the file gives the hand-counted last, first and summed balances, by month and by week, that the balance tests check.
- `conformed.sql`: orders and refunds whose day and region dimensions have different names (`order_date` and `refunded_on`, `ship_region` and `region_code`), with no join between them, a month and a region only orders have and a month and a region only refunds have. The comment at the top of the file gives the hand-counted totals by month and by region that the conformed-dimension tests check.

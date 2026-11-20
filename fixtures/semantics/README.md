# Semantics fixtures

Small SQL files that give a semantics test the data it needs, each one file of DDL and inserts that runs unchanged on PostgreSQL and DuckDB. Every value is synthetic.

- `bridge.sql`: orders, tags and the `order_tags` bridge between them, with orders that have two tags, three tags, one tag, none and a duplicated pair. The comment at the top of the file gives the hand-counted totals the bridge tests check.

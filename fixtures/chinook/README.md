# Chinook, the public test database

`Chinook_PostgreSql.sql` is the unmodified PostgreSQL script of the Chinook sample database, version 1.4.5, from `lerocha/chinook-database` at commit `7f67772503d7`. Its SHA-256 is `e3fde5c1a5b51a2a91429a702c9ca6e69ba56e6c7f5e112724d70c3d03db695e`; `tests/chinook-fixture.test.ts` fails if a byte changes. `LICENSE.md` is the upstream MIT licence. Every person and company in it is made up.

Load it into a schema of a local Postgres (the loader drops and recreates that schema and touches nothing else):

```sh
PG_URL=postgres://... bun fixtures/chinook/load-postgres.ts [schema]   # default schema: chinook
```

`loadChinook(url, schema)` in `load-postgres.ts` does the same from a test and returns the row count per table.

## Tables

`artist`, `album`, `track`, `genre`, `media_type`, `playlist`, `playlist_track`, `customer`, `employee`, `invoice`, `invoice_line`.

`invoice` holds 412 invoices from 2021-01-01 to 2025-12-22. `playlist_track` has 8,715 rows.

## What later work uses it for

- Five years of dated revenue (`invoice.invoice_date`, `invoice.total`): windows, running totals and year over year.
- `playlist_track`: a real many-to-many bridge between `playlist` and `track`.
- `employee.reports_to`: a reporting hierarchy.
- `customer` names and emails: columns that must stay protected.

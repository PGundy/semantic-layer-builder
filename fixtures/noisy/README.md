# Noisy schema decoys

`generate.ts` writes `decoys.sql`: `CREATE TABLE` statements for 197 empty tables whose names and columns are near those of `fct_orders`, `dim_customers` and `dim_regions` of the Acme fixture (`fct_orders_bak`, `stg_orders`, `tmp_fct_orders`, `old_dim_regions_2019`, and so on). Together with those three tables loaded with their data, they make the 200-table schema of the `acme-noisy-200` eval scenario.

Every name and column is synthetic. The generator draws everything from one seeded PRNG and reads no clock, so its output is the same bytes on every run; `decoys.sql` is committed and `tests/evals-noisy.test.ts` checks that it equals the generator's output.

```sh
bun fixtures/noisy/generate.ts [outFile]     # default fixtures/noisy/decoys.sql
```

The statements name no schema: the runner runs them with the run's schema as the search path (`fixtures/acme/load-postgres.ts`, option `extraSql`).

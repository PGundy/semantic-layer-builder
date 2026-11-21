# semlayer on PostgreSQL: what is proven, and how to add your provider

semlayer reads PostgreSQL through one read-only path. This page says what is proven where, and gives the steps that record whether it works on your managed service.

## What is proven where

| Proof | Where it runs | What it shows |
| --- | --- | --- |
| Version matrix | The CI `compat` job: `bash scripts/compat-pg.sh <major>` for 13, 14, 15, 16 and 17 | Introspection, the schema export, drift and the compiled queries agree on each supported major version. |
| Pooler | The CI `compat-network` job: PgBouncer 1.26.1 in transaction mode in front of PostgreSQL 16 (`tests/compat/pooler.test.ts`) | Setup, introspect and profile succeed through a transaction pooler, a statement past `SEMLAYER_STATEMENT_TIMEOUT_MS` is cancelled, and a write is refused. |
| TLS | The same job: a TLS-only PostgreSQL 16 with a certificate made for the run (`tests/compat/tls.test.ts`) | `sslmode=require` and `verify-full` with a CA file connect; a server without TLS gets a message that names the fix. |
| Connection facts | `tests/compat/provider-facts.test.ts`, on every server above | `semlayer doctor --json` holds the server version, whether the session is encrypted and a labelled guess whether a pooler is in the way. |
| Your provider | Only you can run this: the steps below | One redacted file in `docs/compat/fixtures/`, and a row in the table below. |

The containers cannot stand in for a managed service: a service puts its own proxy, certificates, roles and settings in front of PostgreSQL. A row in the table below exists only when someone ran the steps against that service.

## Results by provider

One row per file in `docs/compat/fixtures/`, made from that file alone (`bun scripts/compat-provider.ts table` prints it; `tests/compat-fixtures.test.ts` fails when this table and the folder disagree). The `local` row is the worked example, made against a local PostgreSQL 16 with a synthetic schema. The other providers have no row until their fixture exists.

<!-- provider-table:start -->
| Fixture | Provider | PostgreSQL | Encrypted | Pooler | Read-only role | Tables / views / columns |
| --- | --- | --- | --- | --- | --- | --- |
| `local.json` | local | 16.15 | no | not seen | yes | 2 / 1 / 7 |
<!-- provider-table:end -->

## Add your provider

You need Bun 1.4 or later and this repository checked out. The check reads the catalog of one schema and runs `semlayer doctor`; it profiles nothing and reads no row.

1. Make a read-only role: `semlayer setup --print-role-sql --dialect postgres --schemas <schema>` prints the statements. Run them as an administrator of your database, with your own password.
2. Put the role's connection URL in the environment, not on a command line: `export SEMLAYER_PROVIDER_URL='postgres://<role>:<password>@<host>:<port>/<database>?sslmode=require'`. A pooled URL (Supabase's pooler on port 6543, Neon's `-pooler` host, RDS Proxy) is a good thing to try: it records whether the pooler guess sees it.
3. Run the check with a provider label (`supabase`, `neon`, `rds`, `cloud-sql` or `other`), the schema and a file name: `bash scripts/compat-provider.sh supabase <schema> docs/compat/fixtures/supabase.json`.
4. Check the file: `bun test tests/compat-fixtures.test.ts`. If it names the table above, run `bun scripts/compat-provider.ts table` and paste its output between the two marker lines.
5. Commit the file and the table.

The file holds the provider label, the server's major and minor version, whether the session is encrypted and with which protocol, the pooler guess, whether the role can only read, and counts of tables, views, columns and foreign keys. It is built from that list of fields, not by removing words from the command output, and the script then fails, writing nothing, if the result holds the host, user, database or password of your URL, an address or a URL. It holds no host, port, user, database, schema or table name, and no project, instance or region name.

## Reading the facts

- **Encrypted** is read from the server (`pg_stat_ssl` for this session). Behind a pooler it describes the hop between the pooler and the server, not the hop from you to the pooler. `unknown` means the role could not read it.
- **Pooler** is a guess, and semlayer does not act on it. `yes` means four statements run one after another reported different server connections, or the server connection is more than 30 seconds old (this run is shorter), which only a pooler that reuses server connections does. `not seen` is not proof of a direct connection: a pooler that opened a fresh server connection for you looks the same. The PgBouncer job's `yes` after a warm-up is written but could not be run where Docker was not available.
- **Read-only role** is `yes` when the role can only read the schema you named, by the role report of `semlayer setup`. On PostgreSQL 14 and earlier it reads `no` for a role granted only SELECT, because every role may create tables in the `public` schema there until an administrator runs `revoke create on schema public from public`.

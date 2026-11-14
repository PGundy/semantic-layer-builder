# Security

semantic-layer-builder connects to the databases that hold a business's data, so a flaw in it can expose or change that data. Please report one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/PGundy/semantic-layer-builder/security/advisories/new)). Do not open a public issue, pull request or discussion for it.

If that link says private reporting is not enabled, open a public issue titled "Security contact request" that holds no details of the problem, and a maintainer will reply with a private channel.

Include:

- the commit or release you tested;
- the dialect and how the source was connected (live Postgres, live DuckDB, `--emit-sql` and `--results`, an import);
- the smallest semantic directory, query or file that reproduces it, with synthetic data only, never real customer data;
- what happened and what you expected.

The reply comes in the advisory thread. A confirmed issue is fixed on `main`, with a security advisory that credits the reporter unless they ask not to be named.

Only the latest commit on `main` receives fixes.

## In scope

The CLI's promises, as the README's Trust model states them:

- **Read-only.** Any way to make a CLI command write, delete or change data, run DDL or change session settings, on Postgres or DuckDB, including through `sl run`, golden SQL, profiles, join checks or a DDL import. A bypass that needs the SQL text check turned off still counts: that check is not the guarantee against writes.
- **Reads beyond the source.** On DuckDB, any read of a file or URL that the source's views do not read. On Postgres, a query that gets a function the SQL text check refuses (`pg_read_file`, `lo_import`, `dblink` and the others `skills/semantic-layer/references/spec.md` lists) past that check, for example through quoting. On Postgres the role, not the read-only transaction, is what stops reading server files, so the text check is only a fallback there.
- **Source files.** A DuckDB `connection.setup` statement or `connection.views` relation that passes the source checks (`sl validate` and the adapter) but runs something other than what they allow.
- **Protected values.** A value of a protected column (tagged `pii` or `sensitive`, in `ignored_columns`, or flagged by the sensitivity rules) that `sl run` or `sl goldens run` prints without `--show-protected` in a result column of that column's own name, or that `sl profile` writes into a snapshot as a top value.
- **Credentials.** A connection URL, password or key that any command prints, writes to a file or includes in an error message.
- **Paths.** A command that writes outside the semantic root, other than the env-file lines `sl init` and `sl setup` add to the `.gitignore` of the directory that holds it.
- **The test cluster.** `scripts/pg-local.sh` letting another local user connect to the cluster it starts.

## Out of scope

- A column the name rules do not recognise as personal. Protection by name is a heuristic, as the README says; please open an ordinary issue with the column name so the rules can learn it.
- What an agent does with its own tools outside the CLI, such as a warehouse connector or a shell.
- Values printed through a renamed or computed result column (`select email as e`) or DuckDB's `SUMMARIZE`: `sl run` masks result columns by name, a heuristic, as the README says.
- Server files read on Postgres by a superuser or a member of `pg_read_server_files` through a function the text check does not refuse: such a role can read them inside a read-only transaction, and the CLI warns about it and does not refuse. Connect with a SELECT-only role.
- Damage that needs a database role allowed to write when the CLI is not involved. Connect with a SELECT-only role (`skills/semantic-layer/references/intake.md`).
- Vulnerabilities in Bun, DuckDB, Postgres or another dependency: report them upstream, and tell us if the CLI's use of one makes it reachable.

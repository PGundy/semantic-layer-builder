# Contributing

Thank you for helping. This file covers setup, the tests and the checks a change must pass. Report a security problem privately, as [`SECURITY.md`](SECURITY.md) says, not in an issue.

## Setup

You need [Bun](https://bun.sh) 1.4 or later (CI uses 1.4.4). From the repository root:

```sh
bun install
bun skills/semantic-layer/scripts/sl.ts --help    # or: bun run sl -- --help
```

The root install also installs the skill's own dependencies (`skills/semantic-layer` is a workspace). The CLI's runtime dependencies are `@duckdb/node-api`, `ajv` and `yaml`; a change that needs another one should say why in its pull request.

## Layout

- `skills/semantic-layer/SKILL.md`: the procedure the agent follows; `references/` holds the phase guides and `references/spec.md` the file formats and the CLI table.
- `skills/semantic-layer/scripts/`: the CLI (`sl.ts`, `commands/`, `lib/`), in strict TypeScript.
- `skills/semantic-layer/schemas/`: JSON Schemas for the YAML files.
- `tests/`: the test suites; `tests/skill-docs.test.ts` checks the docs against the CLI.
- `fixtures/acme/`: the synthetic Acme dataset (`bun run fixtures` regenerates it); `examples/`: layers built from it.

## Tests

```sh
bun test                         # every suite
bun test tests/scope.test.ts     # one suite
bun run typecheck
```

The live Postgres tests skip unless `PG_URL` is set. Start a private Postgres cluster without Docker (it needs the Postgres server binaries, such as Debian's `postgresql` package or Homebrew's `postgresql@16`):

```sh
eval "$(bash scripts/pg-local.sh)"   # starts the cluster and exports PG_URL
bun test
bash scripts/pg-local.sh --stop      # stops it
```

`scripts/pg-local.sh` keeps the cluster in a directory only you can read (`${TMPDIR:-/tmp}/sl-pg-<uid>`, or `PG_LOCAL_DIR`), on a Unix socket only you can open, with no TCP listener. `PG_LOCAL_PORT` and `PG_BIN` override the port and the binaries; a cluster already running in the directory keeps its own port, and the printed `PG_URL` names it. Homebrew's `postgresql@16` is keg-only, so its `pg_ctl` is not on `PATH`: run `eval "$(PG_BIN="$(brew --prefix postgresql@16)/bin" bash scripts/pg-local.sh)"`.

The live tests create and drop schemas, each test in its own uniquely named schema, in the database `PG_URL` names. They refuse to run unless its host is `localhost`, `127.0.0.1`, `::1` or a socket path, or `SL_TEST_ALLOW_REMOTE=1` is set. Never point `PG_URL` at a database whose data you care about.

All test and fixture data is synthetic. Never add real data, real names or real credentials to tests, fixtures or examples.

## Before you open a pull request

```sh
bash scripts/verify.sh
```

It installs from the lockfile, typechecks, runs every test (starting `scripts/pg-local.sh` when `PG_URL` is unset and Postgres binaries exist) and validates the example layer. CI runs the same script.

A change should:

- add or update tests for what it changes; a fix comes with a test that reproduces the problem;
- update `references/spec.md` and the JSON Schemas when it changes a file format, and the CLI table in `spec.md` when it adds or changes a command or flag (`tests/skill-docs.test.ts` fails when a doc shows a command or flag the CLI lacks, or the table and `--help` disagree);
- keep `SKILL.md` under about 265 lines: move detail into the reference that owns the topic;
- write docs and comments in the present tense, describing what the code does.

A semantic directory is executable configuration: its `sources/` run setup statements and views on every connection, and its `goldens/` run SQL. Review changes to them, in this repository's examples or anywhere else, as you would review code.

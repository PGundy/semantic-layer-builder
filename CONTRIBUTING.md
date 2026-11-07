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

- `skills/semantic-layer/SKILL.md`: the router the agent starts from (principles, how to read `sl next`, and which phase card to load); `references/phases/` holds one card per phase, the other files in `references/` the topic guides, and `references/spec.md` the file formats and the CLI table.
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

### Performance suite

`tests/perf/` checks the large-catalog targets (docs/PRD.md FR-1.7) on a seeded synthetic catalog of 50,000 tables and 1,000,000 columns:

```sh
bun run perf    # SL_PERF=1 bun test tests/perf: import, scope, tables --groups, status, baseline, introspect
```

Each command runs as its own process and the suite prints its wall time and peak memory. The catalog is written once per generator version under `${TMPDIR:-/tmp}/sl-perf-g<version>` (`SL_PERF_CACHE` overrides) as an information_schema CSV and a DuckDB database. With `PG_URL` set it also introspects 50,000 Postgres tables, created on the first run in schemas named `slperf_g<version>_50000_*` in the `PG_URL` database and kept for the next (creating them adds under a minute). `bun tests/perf/catalog.ts --drop-pg` drops them. `SL_PERF_CLI` points the suite at another copy of `sl.ts`, such as the base branch's, to compare. `bun test` runs only the quick 5,000-table check (`tests/perf/smoke.test.ts`) and the tests that compare the fast paths with the code they replace (`tests/perf/equivalence.test.ts`).

All test and fixture data is synthetic. Never add real data, real names or real credentials to tests, fixtures or examples.

## Before you open a pull request

```sh
bash scripts/verify.sh
```

It installs from the lockfile, typechecks, runs every test (starting `scripts/pg-local.sh` when `PG_URL` is unset and Postgres binaries exist) and validates the example layer. CI runs the same script.

A change should:

- add or update tests for what it changes; a fix comes with a test that reproduces the problem;
- update `references/spec.md` and the JSON Schemas when it changes a file format, and the CLI table in `spec.md` when it adds or changes a command or flag (`tests/skill-docs.test.ts` fails when a doc shows a command or flag the CLI lacks, or the table and `--help` disagree);
- keep `SKILL.md` under 120 lines and each phase card under 150: a phase's steps go in its card, detail in the topic reference, and a new phase `sl next` can name gets a row in `SKILL.md`'s router table and a card (`tests/skill-docs.test.ts` checks the caps, the table and every card's commands against `--help`);
- write docs and comments in the present tense, describing what the code does.

A semantic directory is executable configuration: its `sources/` run setup statements and views on every connection, and its `goldens/` run SQL. Review changes to them, in this repository's examples or anywhere else, as you would review code.

## Branches and pull requests

v1 is built on `release/v1` (docs/PRD.md, decision D8). Branch from it as `v1/<pr-id>-<slug>`, for example `v1/1.4-table-list-files`, and open the pull request against `release/v1`. Each pull request implements one PR of the PRD's plan (section 9), cites its requirement IDs, and fills in `.github/pull_request_template.md`. Spec, schemas, validation and docs change in the same pull request as the behaviour. A pull request merges when `scripts/verify.sh` passes in CI and its review is done; one that touches a file listed in `.github/CODEOWNERS` also needs the owner's review.

A new command is a file in `skills/semantic-layer/scripts/commands/`: the file name is the command name, and the registry finds it without an edit.

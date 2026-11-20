# Contributing

Thank you for helping. This file covers setup, the tests and the checks a change must pass. Report a security problem privately, as [`SECURITY.md`](SECURITY.md) says, not in an issue.

## Setup

You need [Bun](https://bun.sh) 1.4 or later (CI uses 1.4.4). From the repository root:

```sh
bun install
bin/semlayer --help                                      # or: bun skills/semantic-layer/scripts/semlayer.ts --help, or bun run semlayer -- --help
bin/semlayer doctor                                      # checks Bun, the packages and the command on PATH
bin/semlayer demo --dir ../semlayer-demo                 # a sample project with synthetic data, to try a change on
cd ../semlayer-demo && claude --plugin-dir "$OLDPWD"    # a Claude Code session there, with this checkout as the plugin
```

The clone's `bin/` is not on your `PATH`, so write `bin/semlayer` (or add the line `bin/semlayer doctor` prints to your shell profile).

The repository has one `package.json`, at the root, and one `bun.lock` beside it, with no workspaces. The root is the plugin root, and Claude Code installs a plugin's packages itself only when its root holds a `package.json` and a lockfile and every dependency is a registry package (a workspace, folder, git or linked dependency gets no install), with lifecycle scripts off; so the CLI's runtime dependencies (`@duckdb/node-api`, `ajv` and `yaml`) are the root's `dependencies` at exact versions, and the development tools (`typescript`, `@types/bun`) its `devDependencies`, which the plugin's `--production` install leaves out. The skill's scripts find the packages in the root `node_modules`. A change that needs another runtime dependency says why in its pull request, adds it to the root `package.json` at an exact version, and keeps `tests/plugin-package.test.ts` green, which checks this layout and runs a copy of the plugin installed with `--ignore-scripts`. A clone that once ran `bun link` in `skills/semantic-layer` has a `semlayer` in `~/.bun/bin` that comes before the plugin's `bin/semlayer`, so the hooks treat a bare `semlayer` as another program there; `semlayer doctor` reports it, and `rm ~/.bun/bin/semlayer` removes it.

## Layout

- `skills/semantic-layer/SKILL.md`: the router the agent starts from (principles, how to read `semlayer next`, and which phase card to load); `references/phases/` holds one card per phase, the other files in `references/` the topic guides, and `references/spec.md` the file formats and the CLI table.
- `skills/semantic-layer/scripts/`: the CLI (`semlayer.ts`, `commands/`, `lib/`), in strict TypeScript, and the plugin's hooks (`hooks/`) and MCP server (`mcp/`).
- `bin/semlayer`: the `semlayer` command Claude Code puts on the agent's `PATH`, a shell script that runs the CLI with Bun. `PLUGIN_BIN_SHA256` in `skills/semantic-layer/scripts/lib/plugin-bin.ts` records its bytes for the hooks, so a change to it updates that constant (`tests/bare-semlayer.test.ts` fails until it does).
- `skills/semantic-layer/schemas/`: JSON Schemas for the YAML files.
- `tests/`: the test suites; `tests/skill-docs.test.ts` checks the docs against the CLI.
- `fixtures/acme/`: the synthetic Acme dataset (`bun run fixtures` regenerates it); `examples/`: layers built from it.
- `fixtures/chinook/`: the public Chinook sample database (version 1.4.5, MIT), vendored unmodified with its licence; `bun fixtures/chinook/load-postgres.ts` loads it into a schema of a local Postgres. No test needs a model API key.

## Where new code goes

New validation goes in its own file, `skills/semantic-layer/scripts/lib/validate-rules/<topic>.ts`, not in `lib/validate.ts`. The file's default export is a function that takes the `RuleContext` of `lib/validate-rules/index.ts` (a view of the loaded files, read-only by type, that a rule never changes; the lookups `snapshotTable`, `identRules`, `checkSqlRefs` and `joinPaths`; and the calls `error` and `warn`). Each `error` and `warn` call passes a code as its last argument, registered in the workstream's family file under `skills/semantic-layer/scripts/lib/issue-codes/`; `tests/issue-codes.test.ts` fails on a call without one. `lib/validate-rules/index.ts` finds every file in the directory without an edit elsewhere, and `validateProject` runs them in file-name order after its own checks and lists their issues after its own. A new type lives beside the code that owns it; an existing type in `lib/types.ts` gets at most a one-line field.

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

`scripts/pg-local.sh` keeps the cluster in a directory only you can read (`${TMPDIR:-/tmp}/semlayer-pg-<uid>`, or `PG_LOCAL_DIR`), on a Unix socket only you can open, with no TCP listener. `PG_LOCAL_PORT` and `PG_BIN` override the port and the binaries; a cluster already running in the directory keeps its own port, and the printed `PG_URL` names it. Homebrew's `postgresql@16` is keg-only, so its `pg_ctl` is not on `PATH`: run `eval "$(PG_BIN="$(brew --prefix postgresql@16)/bin" bash scripts/pg-local.sh)"`.

To run the live tests against one server version in Docker (13 to 17, the supported range), use `bash scripts/compat-pg.sh <major>`, for example `bash scripts/compat-pg.sh 14`. It starts `postgres:<major>-alpine` on `127.0.0.1:55432` (`COMPAT_PG_PORT` changes the port), runs every test file that reads `PG_URL`, and removes the container. CI runs it for each version in the `compat` job.

The live tests create and drop schemas, each test in its own uniquely named schema, in the database `PG_URL` names. They refuse to run unless its host is `localhost`, `127.0.0.1`, `::1` or a socket path, or `SEMLAYER_TEST_ALLOW_REMOTE=1` is set. Never point `PG_URL` at a database whose data you care about.

A test makes its temp directories with `tempDir()` or `tempRoot()` from `tests/helpers.ts`, never with `mkdtemp`. `bunfig.toml` preloads `tests/temp-dirs.ts`, which removes a test file's directories when the next file starts and the last file's when the run ends, whether the tests pass or fail, and whatever is left when a signal stops the run or a test exits the process. Run `bun test` from the repository root, where `bunfig.toml` is: from another directory only the first file's directories are removed. `bun test --bail` stops before the cleanup and leaves the failing file's directories.

### Performance suite

`tests/perf/` checks the large-catalog targets (docs/PRD.md FR-1.7) on a seeded synthetic catalog of 50,000 tables and 1,000,000 columns:

```sh
bun run perf    # SEMLAYER_PERF=1 bun test tests/perf: import, scope, tables --groups, status, baseline, introspect, validate and typed edits
```

It also checks validation and typed edits on a layer of 870 models over a 5,000-table catalog (`tests/perf/edits.test.ts`, the layer written by `tests/perf/layer.ts`): `semlayer validate` under 5 seconds, one typed edit under 8, and twelve edits through `semlayer apply` under 8.

Each command runs as its own process and the suite prints its wall time and peak memory. The catalog is written once per generator version under `${TMPDIR:-/tmp}/semlayer-perf-g<version>` (`SEMLAYER_PERF_CACHE` overrides) as an information_schema CSV and a DuckDB database. With `PG_URL` set it also introspects 50,000 Postgres tables, created on the first run in schemas named `semlayerperf_g<version>_50000_*` in the `PG_URL` database and kept for the next (creating them adds under a minute). `bun tests/perf/catalog.ts --drop-pg` drops them. `SEMLAYER_PERF_CLI` points the suite at another copy of `semlayer.ts`, such as the base branch's, to compare. `bun test` runs only the quick 5,000-table check (`tests/perf/smoke.test.ts`) and the tests that compare the fast paths with the code they replace (`tests/perf/equivalence.test.ts`).

All test and fixture data is synthetic. Never add real data, real names or real credentials to tests, fixtures or examples.

## Before you open a pull request

```sh
bash scripts/verify.sh
```

It installs from the lockfile, typechecks, runs every test and validates the example layer. When `PG_URL` is unset and Postgres binaries exist, it starts a cluster of its own with `scripts/pg-local.sh` in a fresh `semlayer-pg-verify.*` directory, and stops the cluster and removes the directory when it exits, also when a step fails. A cluster that does not start stops the run with `pg-local.sh`'s message. A cluster that `PG_URL` names is left running. It fails, and lists them, when the run leaves a `semlayer-test-*` or `semlayer-pg-*` entry in `${TMPDIR:-/tmp}` that was not there when it started; two runs at once in the same temp directory see each other's. CI runs the same script on every pull request and on pushes to `main` and `release/**`.

A change should:

- add or update tests for what it changes; a fix comes with a test that reproduces the problem;
- update `references/spec.md` and the JSON Schemas when it changes a file format, and the CLI table in `spec.md` when it adds or changes a command or flag (`tests/skill-docs.test.ts` fails when a doc shows a command or flag the CLI lacks, or the table and `--help` disagree);
- keep `SKILL.md` at 110 lines or fewer (under the cap of 120) and each phase card under 150: a phase's steps go in its card, detail in the topic reference, and a new phase `semlayer next` can name gets a row in `SKILL.md`'s router table and a card (`tests/skill-docs.test.ts` checks the caps, the table and every card's commands against `--help`);
- write docs and comments in the present tense, describing what the code does.

Before a release, run the exit walkthrough by hand (`evals/walkthrough/README.md`): a fresh agent builds a layer from an empty folder and a `.env` through the plugin's hooks, and `evals/walkthrough/count.ts` counts the exit conditions of `docs/PRD-hardening.md` section 2 from its log. It needs an agent and a Postgres, so CI does not run it.

A semantic directory is executable configuration: its `sources/` run setup statements and views on every connection, and its `goldens/` run SQL. Review changes to them, in this repository's examples or anywhere else, as you would review code.

## The plugin and its version

The repository root is the Claude Code plugin (`.claude-plugin/plugin.json`, listed by `.claude-plugin/marketplace.json`); [`docs/plugin.md`](docs/plugin.md) says what it ships and how users install it. Claude Code keeps a user on the installed version until `version` in `plugin.json` changes, so a release that users should get raises it, and with it the `version` of the root `package.json` and of `SERVER_INFO` in `skills/semantic-layer/scripts/mcp/server.ts`; `tests/plugin-package.test.ts` fails when they differ. Each version installs to a new directory, where Claude Code installs its packages; when that install did not run, the `SessionStart` hook prints the command that does it.

`tests/plugin-package.test.ts` also checks the manifests, the paths and hook commands they name, the agents, and that the hooks and the MCP server run from a copy of the plugin's files. With the `claude` CLI on `PATH` it runs `claude plugin validate --strict` and `claude plugin details`; CI has no `claude`, so there those two tests skip. To run them yourself:

```sh
claude plugin validate --strict .
claude --plugin-dir . plugin details semantic-layer-builder
```

The plugin ships without an icon, so `validate --strict` prints an `ICON_MISSING` warning for the plugin listing and then passes.

## Branches and pull requests

v1 is built on `release/v1` (docs/PRD.md, decision D8). Branch from it as `v1/<pr-id>-<slug>`, for example `v1/1.4-table-list-files`, and open the pull request against `release/v1`. Each pull request implements one PR of a plan (`docs/PRD.md` section 9, or `docs/PRD-hardening.md` section 3, branched as `v1/h<n>-<slug>`), cites its requirement IDs, and fills in `.github/pull_request_template.md`. Spec, schemas, validation and docs change in the same pull request as the behaviour. A pull request merges when `scripts/verify.sh` passes in CI and its review is done; one that touches a file listed in `.github/CODEOWNERS` also needs the owner's review.

A new command is a file in `skills/semantic-layer/scripts/commands/`: the file name is the command name, and the registry finds it without an edit.

## Parallel work

Several pull requests are often open at once. These rules keep them off each other's lines:

1. **One owner per file.** A file another open pull request also edits is edited only at a named anchor (a function, a section heading, a table row) that the other does not touch; the pull request that merges second merges its base in. Two pull requests never share an anchor.
2. **New code goes in new files.** A new command is its own file under `commands/` and needs no registry edit. A new type lives beside the code that owns it.
3. **Reserved names.** Issue and refusal codes take their area's family (`scope.*`, `metric.*`, `join.*`, `release.*`; `schema.*` is kept for JSON-schema keyword issues), and each family is registered in a file of its own, so no pull request edits a shared list of codes.
4. **Docs by section.** An area owns its phase card and its section of `references/spec.md`. Docs rules live in `tests/docs-rules/`, one file per document, `doc-<document>.ts` (`doc-skill.ts` for `SKILL.md`, `doc-phases-intake.ts` for `references/phases/intake.md`, `doc-interview-guide.ts` for `references/interview-guide.md`), with an area's own rules in a file named after its topic, with no `doc-` prefix; `tests/skill-docs.test.ts` loads every file there in sorted order, so a new file needs no other edit. `SKILL.md` is at most 110 lines, and a pull request adds a line to it only within the budget its plan gives it.
5. **Computed, never hand-merged.** Eval token counts are computed at replay. The CLI table in `references/spec.md` has one single-line row per command form, sorted by its Command cell, so a conflict there is resolved by keeping both rows.
6. **One pull request integrates.** `README.md`, `docs/plugin.md` and the cross-references between sections of the spec are reconciled by one pull request at the end of a wave of parallel work; the others leave them alone unless their plan names an edit.
7. **Small pull requests.** A pull request is about 400 changed lines outside tests and fixtures, or it is split.

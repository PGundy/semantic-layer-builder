# Plan: a first PostgreSQL layer, then fast iteration

Status: draft for the owner's review; nothing in it is built. Owner: PGundy. Built on `release/v1`, after `docs/PRD.md` and `docs/PRD-hardening.md`. This file is temporary: the pull request that lands the plan's last item deletes it and adds one line per workstream to "After this plan" in `docs/PRD-hardening.md`. It changes none of the invariants of `docs/PRD.md` section 7; the build loop, the PR rules and the definition of done are that document's section 10.

How to read it: sections 1 to 6 and 8 to 11 are the plan and are what the owner reviews. Section 7 is one block per pull request, written for the agent that builds it. Terms used throughout:

- **Phase card**: a file under `references/phases/` that the agent loads when `semlayer next` names its phase.
- **First-turn card**: the opening of `references/phases/intake.md`, which the agent follows in its first message and which asks which database to connect.
- **Readback**: the plain-language account of draft items that `semlayer readback` prints for the owner to confirm or correct.
- **Golden**: a saved request with the figures the owner confirmed; `semlayer goldens check` reruns it.
- **Ledger and recorded yes**: `.semlayer/ledger.jsonl` holds each reply of the owner; an item is approved only on a yes recorded there to the item as it stands.
- **Walkthrough harness**: `evals/walkthrough/`, where a fresh agent builds a layer with an owner played from a brief, and whose log gives a milestone's counts.

## 1. Purpose

Eight issues were filed from four reviews of the first version. Three are finished: #1 (the reference compiler), #2 (the readback ledger) and most of #7 (agent ergonomics). This plan covers what is not: the rest of #3, #4, #5, #6, the remainder of #7 and #8. It also covers two things no issue asked for and the owner's direction now does.

The direction, in the owner's words:

- "this is meant to be a way to go from 0->1 in a semantic layer, only be for postgresql for now, and is meant to allow iterating so that we can go from 1->1.X or 2.0 in a quick and effective manner."
- "We are also going to focus on queries that are largely within a single schema. We should support cross schema queries but that is something the user should be asked about and then explicitly define the scope of schema to schema along with some things like fkey relationships."
- The plans should have "meaningful steps, milestones, and [be] as mutually exclusive as possible so we can have agents fan out".

What that means for every item below:

1. **A first layer comes first.** Wave 1 holds only what a team needs to get from nothing to an approved layer on PostgreSQL and to trust the gate that protects it. What a first layer can live without waits for wave 2 or 3.
2. **PostgreSQL only, for new work.** Every new behaviour is designed for and tested on PostgreSQL. DuckDB keeps working, because the demo and the tests run on it, and gets nothing new designed for it. The code for the other warehouses stays as it is, is no longer offered to a new user, and gets no new work.
3. **One schema by default.** A source has one primary schema. A join that leaves it exists only after the owner is asked and declares the pair of schemas and the key relationships that connect them.
4. **Iteration is a loop of its own.** A finished layer takes a change (a metric, a table, a definition, a schema change) without the interview being redone, and says what the change moved.
5. **Workstreams do not share files.** Each owns its files, its code family, its phase card and its section of the spec. Section 5 names the few shared files and the rule for each, and section 6 fixes the order where two workstreams must touch the same place.

## 2. What is in it

| | Workstream | From | Waves | Outcome |
|---|---|---|---|---|
| W0 | Enabling changes | this plan | 0 | Parallel pull requests stop colliding on token counts, the docs-rules list, the spec's CLI table and `lib/validate.ts`. |
| A | Eval gate | #3 | 1, 2, 3 | The scripted smoke blocks a merge; a PostgreSQL scenario and a 200-table scenario are scored; a live-model run reports on a schedule. |
| B | Stable codes and structured errors | #7 | 1 | Every `validate` issue has a stable code and every failing command prints one JSON object under `--json`. |
| C | Metric semantics | #4 | 2, 3 | Segments, a default time dimension, balances that do not sum across time; then running totals and period-over-period. |
| D | Bridges and multi-fact queries | #8 | 2, 3 | Measures of two fact tables in one request; a many-to-many bridge that does not multiply figures. |
| E | dbt import | #5 | 3 | A dbt project's semantic models and metrics arrive as drafts for the owner to confirm. Export is not in this plan. |
| F | PostgreSQL proof and dialect scope | #6, re-scoped | 1, 3 | The PostgreSQL path is proven across server versions, a pooler, TLS, catalog edge cases and a restricted role; the product offers PostgreSQL only. |
| G | Schema scope | direction | 1 | One primary schema; a cross-schema join only inside a pair the owner declared, with its keys, on a recorded yes. |
| H | Iterating a layer from 1 to 1.x | direction | 2 | A change round on a finished layer ends in a version, a changelog entry and the list of goldens it moved. |

## 3. Milestones

Each milestone is a state a user can see, checked the way `docs/PRD-hardening.md` section 2 was: a fresh agent, acting only through the walkthrough harness (`evals/walkthrough/`), with counts taken from its log.

**M1, end of wave 1: a first PostgreSQL layer in one schema, honestly gated.**

1. A fresh agent builds an approved layer over one schema of a live PostgreSQL, and the six exit conditions of `docs/PRD-hardening.md` section 2 still hold.
2. On a database with two schemas and a foreign key that crosses them, the agent asks the schema question before any cross-schema join exists, and `semlayer validate` passes only once the pair is declared and approved.
3. In CI the eval smoke is a blocking job, the PostgreSQL scenario is scored, and the version matrix, the pooler test and the TLS test are green.
4. `semlayer validate --json` shows a registered code on every issue, and every failing command under `--json` prints exactly one JSON object.
5. The first-turn card and the README offer PostgreSQL only.

**M2, end of wave 2: from 1.0 to 1.1 in one short session.**

1. The agent records the layer M1 produced as 1.0. The owner then asks for one more metric. The agent opens a change round, adds and reads back only that metric, and closes the round as 1.1. No approved item is read back again unless the change touched it, and the changelog entry names the metric and every golden whose figures moved.
2. After a schema change to the database (`fixtures/acme/evolve-retype.sql`, applied on PostgreSQL by `tests/compat/drift.test.ts`), `semlayer introspect` leaves a saved record of what changed, and a retyped column that an approved field reads is reported without a hand-written question.
3. Three goldens that today cannot be written are confirmed on PostgreSQL: a balance that is not summed across time, orders and refunds by month in one request, and a figure grouped through a bridge that is not multiplied.
4. The 200-table single-schema scenario is in the smoke and scores 1 on scope selection; its score with a live model is reported with M3.

**M3, end of wave 3: extensions.**

1. A dbt manifest's semantic models and metrics arrive as draft items, with a list of what was skipped and why.
2. A running total and a period-over-period metric are confirmed as goldens on PostgreSQL.
3. The live-model eval runs on a schedule and reports against a committed baseline.
4. `semlayer doctor --json` output from two managed PostgreSQL providers is committed as fixtures.

## 4. Wave 0: enabling changes

Three pull requests, landed one after another before anything else starts. They change no behaviour a user sees. They exist because of how the last sixty pull requests collided: `references/spec.md` was edited by 56 of them, `SKILL.md` by 26, `tests/skill-docs.test.ts` by 20 and `lib/validate.ts` by 15, and five commits did nothing but recount eval tokens after a merge.

#### W0.1. Token counts are computed, and the smoke blocks a merge (after nothing)

A change to anything the tool prints no longer needs a recount, and a regression in the scripted evals fails CI.

Steps:
1. Move the counting rule from `tests/evals-tokens.test.ts` into `evals/runner/count.ts`, and have `evals/runner/drivers/scripted.ts` compute each turn's tokens at replay.
2. Remove the `tokens` field from every `evals/scenarios/*.script.json` and from the script's schema.
3. Take the token fields out of `evals/baseline.json` and its builder in `evals/smoke.ts`, except `effort.tokens`, which only `--update-baseline` writes and nothing compares as a failure; the smoke compares grader scores and the stop reason, and prints effort without failing on it.
4. In `tests/evals-multi.test.ts`, `tests/evals-runner.test.ts`, `tests/evals-baseline.test.ts` and `tests/evals-graders.test.ts`, replace each pinned token figure with a relation (a share under its limit, a total equal to the sum of its parts, a figure read from the baseline at run time); the 80% interviewer share in `tests/evals-multi.test.ts` stays and is recomputed. Update `tests/next-runnable.test.ts`, which reads `turn.tokens`.
5. Replace the literal figures in `evals/README.md` and the spec's eval summary example with the rule that produces them.
6. Delete `continue-on-error` from the `eval-smoke` job in `.github/workflows/ci.yml`, and rename the job from `eval-smoke (non-blocking)` to `eval-smoke` before the owner marks it required. The smoke prints each scenario's computed total tokens beside `effort.tokens` in `baseline.json` and warns when it is more than ten percent above.

Proves it:
- A script with no `tokens` field replays, and each turn's count equals `count.ts` on a fixed sample.
- Rewording a printed sentence in a scratch copy changes the counts, and no test fails other than a deliberate threshold breach.
- A grader score lowered in a fake run exits 1.

#### W0.2. Shared lists are split, and SKILL.md has room (after W0.1)

Two pull requests that each add a command, a docs rule or a router line no longer edit the same lines.

Steps:
1. Move the rule rows of `tests/skill-docs.test.ts` into `tests/docs-rules/doc-<document>.ts` (for example `doc-joins.ts`, `doc-phases-intake.ts`), one array per document, loaded in sorted file order; a workstream's own rules file takes its topic name with no `doc-` prefix. The count of rules run is unchanged.
2. Rewrite the spec's CLI table so each command form has its own single-line row and rows are in alphabetical order, with a test for both.
3. Shorten `SKILL.md` to 110 lines or fewer without moving a numbered principle: move the Dispatching bullets and the Hand edits detail into the cards that use them, and leave every docs rule that pins a `SKILL.md` sentence unchanged in document and phrase. Pin the 110 in the test; the cap of 120 stays. Budgets: B 1 line, H 2 lines, every other workstream 0 (F4 edits lines in place, net 0).
4. Add a "Parallel work" section to `CONTRIBUTING.md` with the rules of section 5 below.

Proves it:
- `bun test tests/skill-docs.test.ts` runs the same number of rules as before the split.
- The CLI table's command column is sorted and every command has a row.
- `SKILL.md` is at most 110 lines, holds every numbered principle, and every docs rule that pins a `SKILL.md` sentence is unchanged in document and phrase.

#### W0.3. A seam in validation (after W0.2)

A workstream adds its checks in its own file and never edits the body of `lib/validate.ts` (2,305 lines, one `Validator` class).

Steps:
1. Define a read-only view of what the `Validator` has already loaded (project, sources, snapshots, models, metrics, access, goldens), the lookups a rule needs (`snapshotTable`, `identRules`, `checkSqlRefs`, `joinPaths`) and the two reporting calls, `error` and `warn`.
2. Add `lib/validate-rules/index.ts`, which loads the rule modules beside it synchronously, with `require` over a sorted `readdirSync` of `lib/validate-rules/`, cached at module load, and calls each at the end of `validateProject`. Adding a rule file needs no edit to any shared file.
3. The worked example is a rule file that exists only in a test; no existing check moves behind the seam.
4. Say in `CONTRIBUTING.md` that new validation goes in `lib/validate-rules/<topic>.ts`, and that a new type lives beside the code that owns it, with at most a one-line field added to an existing type in `lib/types.ts`.

Proves it:
- `semlayer validate --json` prints the same issues in the same order as before on every fixture and on `examples/acme`.
- A rule file dropped into the directory in a test is found, called once, and its issue appears.

## 5. Rules for parallel work

After wave 0 these hold for every pull request in the plan.

1. **One owner per file per wave.** Each workstream's section lists the files it owns. A file that exists today and belongs to no workstream is edited only at a named anchor (a function, a section heading, a table row), and section 6 lists every such edit. Two pull requests may edit different named anchors of one file in the same wave, and the one that merges second rebases; they never share an anchor.
2. **New code goes in new files.** New validation goes in `lib/validate-rules/<topic>.ts`. A new command is its own file under `commands/` and needs no registry edit. New types live beside the code that owns them.
3. **Reserved names.** Issue and refusal codes use the workstream's family: `scope.*` (G), `metric.*` (C), `join.*` (D), `release.*` (H), with `schema.*` kept for JSON-schema keyword issues. Each family is registered in a new file its workstream owns: `lib/issue-codes/scope.ts` (G), `metric.ts` (C), `join.ts` (D), `release.ts` (H); B owns `index.ts`, `schema.ts`, `source.ts` and `layer.ts`. No workstream edits a shared list of codes. A workstream that lands before B1 writes its codes as plain constants and B attaches them.
4. **Docs by section.** Each workstream owns the phase card and the spec section named in its "Owns" list, adds its docs rules to its own file under `tests/docs-rules/`, and spends no more of `SKILL.md` than its budget in W0.2 (B 1 line, H 2, every other workstream 0).
5. **Generated or computed, never hand-merged.** Token counts are computed. The spec's CLI table is one sorted row per command form: a conflict there is resolved by keeping both rows.
6. **The orchestrator integrates.** At the end of each wave one pull request by the orchestrator reconciles `README.md`, `docs/plugin.md` and any cross-reference between sections of the spec. No workstream edits those two files, except F4, which owns the README's dialect table.
7. **A pull request is about 400 changed lines outside tests, or it is split.**

## 6. Order

### Waves

| Wave | Pull requests | Starts in parallel | Ends at |
|---|---|---|---|
| 0 | W0.1 (computed token counts), W0.2 (split shared lists), W0.3 (validation seam) | one at a time | the rules of section 5 hold |
| 1 | F4 (PostgreSQL-only text), F1 (version matrix), F2 (catalog and restricted role), F3 (pooler and TLS); B1 (issue codes), B2 (codes on existing checks), B3 (JSON error envelope), B4 (code docs); G1 (primary schema), G2 (declare a schema pair), G2b (approve a schema pair), G2c (enforce schema pairs), G3 (schema question); A2 (validate grader), A3a (PostgreSQL intake), A3b (Acme on PostgreSQL), A3c (walkthrough fixtures) | F4, B1, G1 | milestone M1 |
| 2 | H5 (drift record), H1 (version and changelog), H2 (item diff), H3 (change entry point), H4 (close a round); C1a (segments), C1b (segment commands), C2 (calendar), C3 (balances); D1a (part builder), D1b (multi-fact requests), D3 (through schema), D4 (through compile), D5 (bridge check and readback); A4 (200-table scenario) | D1a, D3, H5, H1, A4 | milestone M2 |
| 3 | C4 (running totals), C5 (period-over-period); D2 (conformed dimensions), D6 (drafted bridges); E1 (read dbt), E2a (dbt filters), E2b (dbt drafts); A5 (live baseline and job); F5 (provider kit) | C4, D2, D6, E1, E2a, A5, F5 | milestone M3 |

Within a workstream the order is in its section. A wave starts when the one before it has reached its milestone, with one exception: a wave 2 or wave 3 pull request whose "after" list is already merged may start early if it touches no file in the table below for the current wave.

### Order across workstreams

These are the waits that cross workstreams, and the waits inside one workstream that another's work depends on. Each exists because two pull requests must edit the same file or one consumes the other's contract.

| First | Then | Why |
|---|---|---|
| B1 | A2, G2, D1b, D3, H1 | They add issues or read them, and use B1's `code` field. |
| B2, B3 | G2b | B2 and B3 edit `lib/edit.ts`, and B3 edits `lib/refs.ts`; G2b adds the schema-pair kind to both. |
| G1 | G2 | G2 extends `lib/schema-scope.ts` and `source.schema.json`, which G1 creates and edits. |
| G1 | F2 | Both edit `lib/introspect.ts`: G1 the `fks.push`, F2 the columns loop of `buildSnapshot`. |
| F4 | G3 | Both edit `references/phases/intake.md`; G3's paragraph follows F4's "Which Postgres database?" paragraph. |
| F2 | G3 | G3's live test loads F2's `tests/compat/two-schemas.sql`. |
| F2, G3 | A3c | The walkthrough fixtures rest on F2's catalog handling and on G3's schema question. |
| G2 | H2, E2b | H2's item map includes the declared schema pairs; E2b's skip message names the declaration. |
| G3 | H3 | Both edit `lib/status.ts` and `lib/next.ts`. |
| D1a | D1b, C1a | D1a moves the part builder out of `compiler/metrics.ts`; both build on the result. |
| C1a | D4 | Both edit the `aggregate(...)` call in the measure branch of `sqlOf`. |
| A3b | A4 | The 200-table scenario uses the PostgreSQL intake. |
| D2 | C4, only if its spike needs `parts.ts` | Both reach `lib/compiler/parts.ts`; C4 hands such a change to D. |

### Shared files

Every file that exists today and is edited by more than one workstream, with the anchor each pull request edits. Paths are relative to `skills/semantic-layer/` unless they start with a dot. Two files are left out because a rule covers them: `references/spec.md` (each workstream edits its own section and its own rows of the CLI table) and `lib/types.ts` (one-line fields only).

| File | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| `.github/workflows/ci.yml` | A3a: job `eval-smoke`, add `services.postgres` and the `PG_URL` env<br>F1: new job `compat`, appended after the existing jobs<br>F3: new job `compat-network`, appended after `compat` |   |   |
| `SKILL.md` | B4: one principle line (B's budget of 1)<br>F4: frontmatter description and the topic-table row "Only when a source is not a live postgres or duckdb connection", in place | H3: router-table row `change` and one principle line (H's budget of 2) |   |
| `references/phases/intake.md` | F4: the "Which database, and where the connection lives" paragraph, the query-plan and export-dialect lines, and the two MySQL and SQL Server sentences<br>G3: new paragraph after F4's "Which Postgres database?" paragraph |   | E2b: paragraph "What the folder already holds" and bullet "Other shared context" |
| `references/phases/joins.md` |   | D5: the bridge interview step | E2b: a paragraph on checking imported joins |
| `schemas/model.schema.json` |   | C1a: model `properties.segments`; measure `properties.segments`<br>C2: model and measure `properties.default_time_dimension`<br>C3: measure `properties.non_additive_dimension`<br>D3: `$defs.join` (`through` object) | D2: `$defs.dimension` (`conforms_to`) |
| `schemas/source.schema.json` | G1: `intake.properties` (new `primary` key)<br>G2: top-level properties (new `cross_schema` array) | C2: `properties.calendar` (new key) |   |
| `scripts/commands/approve.ts` | G2b: a case beside `"access"` for the schema-pair kind | C2: the hash scope built for a model target (`weekStart`) |   |
| `scripts/commands/check-join.ts` | G2c: `resolveTable` (refuse an undeclared pair) | D5: a branch for a through join, also under `--all` (`evidence.through`) |   |
| `scripts/commands/goldens.ts` | G2c: `checkCommand` (print the compiler's warnings) | D1b: the `share one model` line of the request help |   |
| `scripts/commands/introspect.ts` | F2: live-run branch around the `buildSnapshot` call (print skipped relations) | H5: after the `diffSnapshots` call (`writeDrift`) |   |
| `scripts/lib/approval-hash.ts` | G2b: `ItemKind` and the `listApprovals` entry listing (schema-pair entry) | C1a: `itemContent` case `"measure"` (segment filters)<br>C2: `itemContent` cases `"model"` and `"measure"` (`default_time_dimension`), `HashScope` and `modelEntries` (`weekStart`), case `"dimension"` (week start)<br>C3: `itemContent` case `"measure"` (`non_additive_dimension`)<br>D3: `joinContent` (`through`) | C4: `itemContent` case `"metric"`<br>D2: `itemContent` case `"dimension"` (`conforms_to`) |
| `scripts/lib/approve-checks.ts` | B3: the approval refusals (codes) |   | C4: `metricMeasureRefs` (the cumulative metric's measure) |
| `scripts/lib/compiler/index.ts` | G2c: `RefusalCode` union (one member); `Compiled` (`warnings` field) | C1a: `RefusalCode` union (one member); the request check before `compileMetrics`; `texts` in `compileLayer`; the `aggregate` call in the measure branch of `sqlOf` (`measureFilter`)<br>C2: `sqlOf` dimension branch (`grained` call)<br>C3: `compileLayer` final assembly (`const lines`) and its refusal of mixed measures<br>D1b: `resolve` in `compileLayer` (the measures branch)<br>D4: the `aggregate` call in the measure branch of `sqlOf` (allocation factor), after C1a |   |
| `scripts/lib/compiler/joins.ts` | G2c: `requestPath` and `hop` (undeclared pair) | D3: `requestPath` (refuse a through route)<br>D4: `requestPath` (bridge and target instances) and `PlannedJoin` (`through`) |   |
| `scripts/lib/compiler/metrics.ts` |   | D1a: `compileMetrics` from `const parts` to the final return (moved to `parts.ts`)<br>D1b: `compileMetrics` entry guard and its `must share one model` refusal | C4: `formula()` branch for unsupported types<br>C5: `formula()` branch for unsupported types |
| `scripts/lib/draft.ts` | G1: `joinCandidates`, `keyNameCandidates` and the declared-FK loop<br>G2c: the declared-FK loop (draft an approved pair from its keys) |   | D6: one call in `draftModels` |
| `scripts/lib/edit.ts` | B2: `neverRight` and `withEditWarnings`<br>B3: `ValueRefusal` (its own code)<br>G2b: `ItemKind` and `locate` (schema-pair case), after B2 and B3 |   |   |
| `scripts/lib/introspect.ts` | G1: `fks.push` (keep the constraint name)<br>F2: the columns loop of `buildSnapshot` (rows of returned tables only), after G1 |   |   |
| `scripts/lib/next.ts` | G2b: `targetPhase` (schema-pair prefix)<br>G3: new `schema_scope` `ask_owner` branch | H3: `nextAction` (phase `change` and the next step per pending item) | D6: `nextAction` (one case asking for the dedupe rule) |
| `scripts/lib/readback.ts` | G2b: the neighbour of case `"access"` in the item builder | C1b: `renderField` ("Excludes:" line) and `renderModel` (segment list)<br>C3: `renderField` (balance sentence)<br>D5: `joinWords` (call to `readback-bridge.ts`) | C4: `renderMetric`<br>D2: `renderField` (conformed paragraph) |
| `scripts/lib/refs.ts` | B3: its refusals (codes)<br>G2b: `Target` and `parseTarget` (schema-pair kind), after B3 | C2: `parseRequestField` (bare `:grain` shorthand) |   |
| `scripts/lib/status.ts` | G3: `nextStep` (new `schema_scope` step after the first introspect) | H3: `Phase` union (`change`), the `done` step of `nextStep`, and the `computeStatus` JSON (`layer_version`, open change) |   |
| `scripts/lib/validate.ts` | B1: `Validator.error`, `Validator.warn`, the `intakeIssues` merge line in `checkSources`, and `trackedEnvFileIssues`<br>B2: every existing `this.error(` and `this.warn(` call and the `report()` closure | D1b: `checkMeasureModels` (body emptied) and its call<br>D3: the join check's one_to_many warning (skipped when `through` is set) |   |

Where two pull requests in one cell edit the same function, an "after" list or the order table fixes who goes first; only C1a and D4 share an anchor, and D4 merges second. `lib/validate.ts` has one owner per wave: B in wave 1, D in wave 2. Every other workstream adds validation through its own file in `lib/validate-rules/`.

## 7. Workstreams

### A. Eval gate (issue #3)

**Outcome.** A contributor gets a failing check when a change breaks the scripted eval, and an owner can see how a live model builds a first PostgreSQL layer over one schema, including a 200-table schema where three tables matter. Neither is possible today: the smoke job cannot fail a merge, and every scenario runs on DuckDB.

**Today.**
- `.github/workflows/ci.yml` (job `eval-smoke`, lines 38-48) has `continue-on-error: true`, so a regression shows as a yellow job. Wave 0 (W0.1) removes that flag and the committed token counts; this workstream starts after it.
- `evals/runner/drivers/scripted.ts` replays canned turns. A change to `SKILL.md` or `references/phases/*.md` moves no score; only the live driver `evals/runner/drivers/sdk.ts` (needs `ANTHROPIC_API_KEY`, SDK loaded by dynamic import) measures skill text, and no `evals/baseline.sdk.json` is committed.
- `evals/runner/types.ts` and `skills/semantic-layer/schemas/eval-scenario.schema.json` (line 26) allow only `"duckdb"` as the intake dialect; `evals/graders/figures.ts` `produce()` refuses compiled SQL that is not DuckDB, because it reads DuckDB data from files.
- `evals/graders/` holds seven graders (figures, secrets, selection, approvals, connection_first, authority, effort); none runs `semlayer validate` on the final root.
- `fixtures/acme/load-postgres.ts` loads Acme into a named Postgres schema from `PG_URL`; `ci.yml` gives the `checks` job a postgres:16 service, the eval job none. `fixtures/acme/evolve.sql` exists but no scenario uses it.

**Scope.**
- In this plan: validate grader, PostgreSQL intake and Acme scenario (one schema), two-schema and change-round walkthrough fixtures, 200-table single-schema scenario, live-model baseline and `--gate` mode, scheduled live job.
- Later (wave 3 or 2.0): dbt-manifest scenario (arrives with E, needs E1), per-PR live gate (cost and variance), multi-version PostgreSQL matrix (F owns it).
- Not planned: new DuckDB scenarios (the demo and tests already cover it), live runs on other warehouses (no source dialect in this plan), a changed-schema eval scenario (the runner has no step that applies SQL in the middle of a run; H5 proves the behaviour with a test on PostgreSQL).

**Owns.**
- New: `evals/graders/validate.ts`, `evals/baseline.sdk.json`, `evals/scenarios/acme-pg-structured.json` and `.script.json`, `evals/scenarios/acme-noisy-200.json` and `.script.json`, `fixtures/noisy/generate.ts`, `fixtures/noisy/README.md`, `fixtures/acme/billing.sql`, `fixtures/acme/load-two-schema.ts`, `fixtures/acme/owner-brief-two-schema.md`, `fixtures/acme/owner-brief-change.md`, `.github/workflows/eval-live.yml`, `tests/evals-validate-grader.test.ts`, `tests/evals-postgres.test.ts`, `tests/evals-noisy.test.ts`, `tests/evals-live-workflow.test.ts`, `tests/docs-rules/evals.ts`.
- Edited by A alone: `evals/smoke.ts` (`--gate`, scenario subset), `evals/baseline.json`, `evals/graders/index.ts`, `evals/graders/figures.ts`, `evals/graders/selection.ts`, `evals/runner/runner.ts`, `evals/runner/types.ts`, `evals/runner/drivers/scripted.ts`, `evals/README.md`, `evals/walkthrough/README.md`.
- Code family: none (`eval.*` stays unused; the validate grader reports B's codes). Phase card: none. Spec section: `## Eval runs` in `references/spec.md`.

**Pull requests.**

#### A2. Validate grader (wave 1; after B1, W0.1)
Score a run on whether the final root passes validation.
Steps:
1. Add `evals/graders/validate.ts`: call the validate library in process on the final root, score 1 or 0, put the issue `code` values in details; register it in `evals/graders/index.ts`.
2. Re-record `evals/baseline.json` for the scripted driver with the new grader.
3. Document the grader in the `## Eval runs` section of `spec.md` and in `evals/README.md`.
Proves it:
- A root with a broken join scores 0 and lists the code from B1.
- The clean Acme root scores 1.

#### A3a. PostgreSQL intake and figures path (wave 1; after A2)
Let a scenario name a PostgreSQL source and let the figures grader run compiled SQL on it.
Steps:
1. Add `"postgres"` with `schema` and `url_env` to `ConnectionIntake` in `evals/runner/types.ts` and the `intake.dialect` enum in `eval-scenario.schema.json`.
2. In `runner.ts` create a schema named `semlayer_eval_<run id>` (underscores, as the loader's name check requires), load it with `loadPostgres(url, dataDir, schema)` from `fixtures/acme/load-postgres.ts` (unchanged), and drop it in `finally`; report "not run" when `PG_URL` is unset.
3. Pass the scenario's `url_env` value into the env that `semlayerIn` gives each command and into the figures grader's `openAdapter` call, and add a `{schema}` placeholder beside `{fixture}` in `evals/runner/drivers/scripted.ts`.
4. In `figures.ts` `produce()`, open the postgres source through `openAdapter` instead of refusing.
5. Add the Postgres service to the `eval-smoke` job in `ci.yml`.
Proves it:
- With `PG_URL`, a run ends `done` and no `semlayer_eval_*` schema remains.
- Without `PG_URL`, the scenario is "not run", not failed.
- A DuckDB scenario's figures score is unchanged.

#### A3b. Acme scenario on PostgreSQL (wave 1; after A3a)
Build and grade the Acme layer over one PostgreSQL schema.
Steps:
1. Write `acme-pg-structured.json` and a new script over the warehouse tables (`fct_orders`, `fct_refunds`, `dim_customers` and the rest), scoped to `{schema}`, with selection and `protected_columns` for the warehouse.
2. Add it to the smoke subset only when `PG_URL` is set; re-record `baseline.json`.
3. Add its rule to `tests/docs-rules/evals.ts`.
Proves it:
- figures, validate, secrets and selection score 1 against `reference-figures.json`.
- Scripted replay finishes in under 10 s.

#### A3c. Two-schema and change-round walkthrough fixtures (wave 1; after F2, G3)
Give the walkthrough harness a database with two schemas and briefs from which the played owner answers the schema question and asks for a change.
Steps:
1. Write `fixtures/acme/billing.sql`: a schema `billing` whose table has a foreign key into `acme.dim_customers`, every value synthetic. F2's `tests/compat/two-schemas.sql` is not reused: it holds no Acme data, and the walkthrough's owner answers from Acme figures.
2. Write `fixtures/acme/load-two-schema.ts`, which calls `loadPostgres` for `acme` and then runs `billing.sql` against the same `PG_URL`.
3. Write `fixtures/acme/owner-brief-two-schema.md` (how the owner answers the schema question) and `fixtures/acme/owner-brief-change.md` (one added metric, one changed definition).
4. Say in `evals/walkthrough/README.md` how to run each.
Proves it:
- Each brief names only tables and figures that exist in the loaded schemas and in `reference-figures.json`.
- `evals/walkthrough/README.md` gives the command for each run.

#### A4. 200-table single-schema scenario (wave 2; after A3b)
Grade scope selection when 197 of 200 tables are decoys.
Steps:
1. Write `fixtures/noisy/generate.ts`, a seeded generator emitting DDL for 200 tables: three Acme tables and 197 decoys with near-identical names.
2. Write `acme-noisy-200.json`, its script and baseline entry.
3. In `selection.ts`, name each wrongly included decoy in details.
Proves it:
- Generator output is byte-identical on two runs.
- A script that scopes a decoy scores selection below 1 and names it.

#### A5. Live-model baseline and scheduled job (wave 3; after A2)
Compare a live run with a committed baseline, and run the live smoke on a schedule without blocking merges.
Steps:
1. Add `--gate` to `evals/smoke.ts` for `--driver sdk`: exit 1 when a score is below baseline minus band, exit 2 with the existing message when key or package is missing.
2. The owner records `evals/baseline.sdk.json` with `--runs 5` on acme-structured and acme-terse.
3. Add `.github/workflows/eval-live.yml` triggered by `schedule`, `workflow_dispatch` and the label `eval-live`, with a pinned SDK version.
4. Run `eval:smoke -- --driver sdk --gate --runs 3`; upload run directories.
5. Print a skip notice when the secret is absent.
6. Document `--gate` in the `## Eval runs` section of `spec.md` and in `evals/README.md`.
Proves it:
- `--gate` without a key exits 2 and runs nothing.
- A test parses the YAML: no unlabelled `pull_request` trigger, no secret echoed.

**Milestones.**
- After A2: `bun run eval:smoke` shows a `validate` row for every scenario and exits 0.
- After A3b: `PG_URL=... bun evals/runner/run.ts --scenario acme-pg-structured` shows figures 1 and validate 1.
- After A3c: `evals/walkthrough/README.md` names the two-schema run and the change run, and `fixtures/acme/load-two-schema.ts` leaves `acme` and `billing` in one database.
- After A4: `bun evals/runner/run.ts --scenario acme-noisy-200` shows selection 1 on 3 of 200 tables.
- After A5: `bun run eval:smoke -- --driver sdk --gate` without a key exits 2, and a manual `eval-live` run prints non-zero bands from `baseline.sdk.json`.

**Risks.**
- Scripted smoke never reads skill text; a required check may read as a guarantee about `SKILL.md`. State this in `evals/README.md`; find out by reading the check's name and README line in review.
- Live variance may exceed a 5-run band; A5 records the baseline on two days and compares them before the schedule is turned on.
- Postgres figures may expose type differences (numeric, dates) against `reference-figures.json`; A3a's first run on Acme shows it.
- A2 and the `validate` row depend on B1's return type; A2's test fails at once if B1 changes it.

### B. Stable codes and structured errors (issue #7)

**Outcome.** An agent running `semlayer validate --json` or any failing command with `--json` gets a stable `code` it can branch on, and a `next` command where one exists, without matching message text. Every later workstream can add its validation issues and refusals under that contract.

**Today.**
- `Issue` is `{level, file, path, message}` with no code (`lib/schema.ts:9-14`). `Validator.error()` and `warn()` (`lib/validate.ts:196-202`) have 137 call sites, plus the `report()` closure near line 615.
- Other producers build issues by hand: `schemaIssues` and `evalSchemaIssues` (`lib/schema.ts:143, 333`), `intakeIssues` (11 sites, merged at `lib/validate.ts:520`), `sourceSafetyIssues` (`lib/source-safety.ts:248`) and `trackedEnvFileIssues` (`lib/validate.ts:2293`).
- `UserError(message, next?)` (`lib/errors.ts`) has 608 construction sites. Under `--json`, `runCli` prints `{error, next}` only when `next` is set (`lib/cli.ts:133-140`). Usage errors and exit 2 print no JSON.
- `neverRight` (`lib/edit.ts:190`) classifies a warning by path regex and `message.includes(...)`. Typed-edit warnings reach `--json` as strings (`withEditWarnings`, `lib/edit.ts:217`).
- Compiler refusals already carry words such as `no_join_path` (`RefusalCode`, `lib/compiler/index.ts:26`). A failed MCP tool call returns only `isError` and text (`mcp/elicit.ts` `toolResult`).

**Scope.**
In this plan: the `code` field and registry, codes on every existing validate issue, the `--json` error envelope, codes on the errors an agent branches on, the docs section.
Later (wave 3 or 2.0): a `semlayer explain <code>` command, a `fix` object an agent can apply, severity beyond error and warning.
Not planned: codes on all 608 `UserError` sites (the rest share `user_error`), changed message text, codes for doctor statuses (its own ok/warn/fail), a human-line `[code]` suffix.

**Owns.**
- New: `lib/issue-codes/index.ts`, `lib/issue-codes/schema.ts`, `lib/issue-codes/source.ts`, `lib/issue-codes/layer.ts`; `schemas/cli-error.schema.json`, `schemas/issue.schema.json`; `tests/issue-codes.test.ts`, `tests/cli-errors.test.ts`; `tests/docs-rules/codes.ts`.
- Edited by B alone in wave 1: `lib/errors.ts`, `lib/source-safety.ts`, `lib/approve-checks.ts`, `commands/validate.ts`, `mcp/elicit.ts`.
- Code family: `schema.*`, `intake.*`, `source.*`, `env.*`, and the existing-check codes in `layer.ts` (`ref.*`, `model.*`, `field.*`, `approval.*`, `time.*`, `expr.*`, `access.*`, `golden.*`). Reserved to others: `scope.*` G, `metric.*` C, `join.*` D, `release.*` H.
- Card: none; SKILL.md gets one line (budget 1).
- Spec heading: `### Codes and errors`.

**Pull requests.**

#### B1. Issue.code and the registry (wave 1; after nothing)
Every validate issue carries a registered `code`, and a test fails on any that does not.
Steps:
1. Create `lib/issue-codes/index.ts`: it finds the sibling family files by `readdirSync` as `commands/index.ts` does, merges `{code: {level, meaning, next?}}` maps (`meaning` is one line), and rejects duplicate or malformed codes.
2. Add `code: string` and `next?: string` to `Issue` (`lib/schema.ts`). Give `schemaIssues` and `evalSchemaIssues` codes from the Ajv keyword: `schema.required`, `schema.unknown_property`, `schema.enum`, `schema.type`, `schema.pattern`, `schema.other`.
3. Add an optional trailing `code` argument to `Validator.error` and `warn`, defaulting to the registered `issue.unclassified`. Code `intakeIssues`, `sourceSafetyIssues` and `trackedEnvFileIssues` (`source.*`, `intake.*`, `env.*`).
4. In `commands/validate.ts` add `code` and `next` to the JSON issues. The human lines stay as they are.
5. Add `tests/issue-codes.test.ts`.
Proves it:
- Every code matches `/^[a-z_]+\.[a-z0-9_]+$/`, is unique across family files, and is registered.
- Over every `tests/fixtures` project and a broken `semantic.yaml`, every issue has a registered code; a missing `version` gives `schema.required` at `version`.
- A static scan fails when a file under `lib/validate-rules/` calls `.error(` or `.warn(` without a code.
- The existing `message.includes` assertions pass untouched; `tests/env-file.test.ts:782` gains its code.

#### B2. Codes on existing checks (wave 1; after B1)
The 137 existing call sites get real codes, `issue.unclassified` is removed, and `neverRight` tests codes.
Steps:
1. Create `lib/issue-codes/layer.ts`. Put the model, dimension, measure and filter variants in the path, not the code, so about 90 codes cover the sites.
2. Replace the default at each `this.error(` and `this.warn(` call and in `report()`, inside the existing check bodies only.
3. Add `next` templates for `approval.hash_changed`, `approval.no_ledger_yes` and `approval.stamp_hashes`.
4. In `lib/edit.ts`, `neverRight` tests `time.zone_carries_own`, `expr.divides_by_literal` and `ignore.column_read`. `withEditWarnings` adds `warning_issues: [{code,path,message}]` and leaves `warnings` as strings.
5. Remove `issue.unclassified` and add a test that it never appears.
Proves it:
- Ten mutations of the valid fixture each return their expected code through `expectIssue`.
- A static scan finds no `.error(` or `.warn(` in `lib/validate.ts` without a code.
- A typed edit refused by `neverRight` still refuses with identical text.
- `apply --json` carries `warning_issues` beside unchanged `warnings`.

#### B3. The --json error envelope (wave 1; after B1)
Every failing command under `--json` prints one `{error, code, next?}` object on stdout.
Steps:
1. Add `code` (default `user_error`) to `UserError`; let `ValueRefusal` in `lib/edit.ts` set its own.
2. In `runCli`, detect `--json` in argv before `parseArgs`. Print the envelope for `UserError`, for usage errors and `Unknown command` (`usage`), and for exit 2 (`internal`). The stderr line is unchanged.
3. Give codes to the errors an agent branches on: `noLayer` in `lib/project.ts` (`no_layer`), `lib/refs.ts`, `lib/json-input.ts`, `lib/env-file.ts:145` (`source.connection_missing`), and approval refusals in `lib/approve-checks.ts`.
4. Add `structuredContent: {code, error, next?}` to failed results in `toolResult` (`mcp/elicit.ts`). Text and `isError` stay.
5. Add the two schemas.
Proves it:
- `status --root /nonexistent --json` parses to `code: "no_layer"` with `next`; exit codes are unchanged.
- A usage error and a thrown non-`UserError` give `usage` and `internal` as JSON.
- Stderr is byte-identical for ten sampled errors.
- Real `validate --json` output and a failed MCP call validate against the schemas.

#### B4. Document the codes (wave 1; after B2, B3)
`semlayer validate --codes` lists every code, the spec states the envelope and the families, and the agent is told to branch on `code`.
Steps:
1. Add `semlayer validate --codes` in `commands/validate.ts`: it prints every registered code with its level and one-line meaning, read from the family files.
2. Write `### Codes and errors` in `references/spec.md`: the envelope, one sentence naming each family, the rule that a code is added or retired, never renamed or reused, and a pointer to `semlayer validate --codes`. The section carries no generated table.
3. Edit the `validate` row of the CLI table for the new JSON shape and `--codes`.
4. Add one line to `SKILL.md`: branch on `code` and `next`, not text.
5. Add `tests/docs-rules/codes.ts`.
Proves it:
- `semlayer validate --codes` lists every registered code once with its level and meaning, and a test fails when a registered code has no meaning line.
- `bun test tests/skill-docs.test.ts` passes with `SKILL.md` within its budget.

**Milestones.**
- After B1: `semlayer validate --json --root <broken>` shows a `code` on every issue, `schema.required` for a missing version.
- After B2: `semlayer validate --json` on a layer with a changed approved hash shows `approval.hash_changed` with a `next`.
- After B3: `semlayer status --root /nonexistent --json` prints `{error, code: "no_layer", next}`.
- After B4: `semlayer validate --codes` lists every code with its meaning, and `bun test tests/issue-codes.test.ts tests/skill-docs.test.ts` passes.

**Risks.**
- Required `code` on `Issue` breaks each producer at compile time; `tsc` after step 2 of B1 lists them all, and a diff over 400 lines splits intake and source into a second PR.
- B2 touches every call site in `lib/validate.ts`; found early by rebasing B2 onto the W0.3 seam the day it merges.
- Consumers reading `warnings` as strings break if it changes; `warnings` stays and `grep evals/ tests/` for readers runs before B2.
- The registry grows past 100 codes; B2 reports the count in its description.

### C. Metric semantics (issue #4)

**Outcome.** An owner can name a reusable rule once (a segment), get a balance that is not summed across months, set which day a week starts, and later get running totals and period-over-period figures, each approved on a recorded yes. Today each of these means copying a predicate into every measure or getting a silently wrong number.

**Today.**
- No segment exists. `schemas/model.schema.json` measures allow `name, expr, agg, filter, format, currency, description, synonyms, tags` only (`additionalProperties: false`), so a shared rule is a copy in each `filter`.
- `scripts/lib/compiler/metrics.ts:127-129` (`formula()`) compiles `ratio` and `derived` only; any other type is refused as `unsupported_metric`. `schemas/metrics.schema.json` rejects other types first.
- `scripts/lib/compiler/sql.ts:26` `grained()` is `date_trunc(grain, expr)`: ISO Monday weeks, calendar quarters and years, no setting. `scripts/lib/compiler/index.ts:264-267` (`sqlOf`) is the only caller of `aggregate()` and `grained()`.
- `scripts/lib/approval-hash.ts:111-170` (`itemContent`) hashes fixed field lists; a new key outside them edits an approved item without invalidating it.
- `metricMeasureRefs` exists twice: `scripts/lib/access.ts:615` and `scripts/lib/approve-checks.ts:40`. Both read only ratio and `{ }` expr metrics.

**Scope.**
- In this plan: model-local segments, calendar week start (default Monday, as today), default time dimension, semi-additive measures (first or last), cumulative metrics, period-over-period metrics.
- Later (wave 3 or 2.0): fiscal year (needs a calendar decision), request segments on metric requests, semi-additive mixed with additive measures in one request, `label` (cosmetic).
- Not planned: semantic-dimension references in joins (reaches the resolver D and G change; the physical-column warning stays), cross-model segments (G owns cross-schema), non-additive over a non-time dimension.

**Owns.**
- New: `skills/semantic-layer/scripts/lib/segments.ts`, `lib/metric-types.ts`, `lib/compiler/{segments,calendar,semi-additive,cumulative,period-compare}.ts`, `lib/validate-rules/metric.ts`, `lib/issue-codes/metric.ts`, `commands/add-segment.ts`, `commands/remove-segment.ts`, `fixtures/semantics/balances.sql`.
- New tests: `tests/compiler-{segments,calendar,semi-additive,cumulative,period-compare}.test.ts`, `tests/segments-validate.test.ts`, `tests/compat/balances.test.ts`, `tests/docs-rules/metric-semantics.ts`.
- Exclusive edits: `commands/add-metric.ts` (C4), `references/phases/metrics.md`.
- Code family `metric.*` (for example `metric.segment_unknown`, `metric.non_additive_dimension_not_time`).
- Phase card: `metrics.md`, paragraphs "Segments", "Time and balances", "Running totals and comparisons".
- Spec heading: `## Metric semantics`.

**Pull requests.**
#### C1a. Segments in the schema and compiler (wave 2; after D1a)
A model declares named predicates and a measure or plain request applies them.
Steps:
1. `lib/segments.ts`: `Segment {name, filter, description}`; add `segments?` to Model and Measure and `segments?` to QueryRequest in `lib/types.ts`; add the keys to the model and golden schemas.
2. `lib/validate-rules/metric.ts`: unique names, `sqlTextProblem` on each filter, measure names exist; the file is found by name, with no index to edit. Register the codes in `lib/issue-codes/metric.ts`.
3. `lib/compiler/segments.ts` `measureFilter(measure, model)` ANDs the measure filter with its segments; call it in the `sqlOf` measure branch and in `texts` of `compileLayer`. Request segments join `where`. A request that names a metric and segments is refused with a new RefusalCode, before `compileMetrics`.
4. `lib/approval-hash.ts` measure case: add the resolved segment filter texts.
Proves it:
- A measure with a segment compiles to `filter (where a and b)` and equals hand SQL on the demo database.
- Editing the filter after approval makes validate report the measure's hash mismatch.
- Unknown and duplicate names, and a subquery in a filter, each give their code.

#### C1b. Segment commands and readback (wave 2; after C1a)
The owner can add and remove a segment with typed commands and read it back.
Steps:
1. `commands/add-segment.ts` (with `--replace` for a draft) and `commands/remove-segment.ts`, with their spec CLI rows.
2. Readback prints "Excludes: ..." in `renderField` and lists a model's segments in `renderModel`.
3. Write the "Segments" paragraph of `metrics.md`, the segments part of the spec's `## Metric semantics`, and `tests/docs-rules/metric-semantics.ts`.
Proves it:
- `add-segment` then `readback` on a measure that names it shows its "Excludes:" line.
- `remove-segment` after `add-segment` leaves the model file byte for byte as before.

#### C2. Calendar and default time dimension (wave 2; after C1a)
A source sets the week start and a measure names the date it is measured over.
Steps:
1. `schemas/source.schema.json`: `calendar.week_start`; `lib/compiler/calendar.ts` `weekStart(expr, day)`.
2. `grained()` takes the calendar; `sqlOf` dimension branch passes it. No calendar means today's SQL.
3. `default_time_dimension` on model and measure; the rule in `validate-rules/metric.ts`.
4. `lib/refs.ts` accepts `:month`, resolved to the base default or refused with a named code.
5. `approval-hash.ts`: add `default_time_dimension` to the model and measure cases; add `weekStart?: string` to `HashScope`, set it in `modelEntries` and in the scope `commands/approve.ts` builds, and hash it into the dimension case for week grains. `metrics.md` asks the question.
Proves it:
- With `sunday`, 2024-01-03 buckets to 2023-12-31; unset stays 2024-01-01.
- A non-time default is an error; `:month` with no default refuses.
- Changing `default_time_dimension` or `calendar.week_start` after approval marks the item changed.

#### C3. Semi-additive measures (wave 2; after C2)
A measure with `non_additive_dimension` returns the last or first value per period.
Steps:
1. Schema and `validate-rules/metric.ts`: a time dimension of the same model; agg sum, avg, min or max; model has a primary key.
2. `lib/compiler/semi-additive.ts`: `DISTINCT ON` (the primary key minus the `non_additive_dimension` column, plus the requested group keys with the time dimension at the requested grain), ordered by those keys and then the non-additive column descending for `last` or ascending for `first`. The measure filter applies in the inner `WHERE`, and the aggregate runs outside.
3. Edit the final assembly of `compileLayer` to use it; refuse a request mixing it with additive measures.
4. Hash field and readback sentence.
5. Add `fixtures/semantics/balances.sql`, one file of DDL and inserts that runs unchanged on PostgreSQL and DuckDB, every value synthetic. Add `tests/compat/balances.test.ts`: it loads the file into a unique schema from `PG_URL`, builds the small layer with typed commands and confirms a golden with `semlayer goldens confirm`; it is required in F1's `compat` job and skipped locally without `PG_URL`.
Proves it:
- Daily rows for two accounts across two months return the last day's balance per month, which differs from the sum of the days; no time dimension gives the latest.
- `first` returns the opening value.
- The balance golden is confirmed on PostgreSQL in the `compat` job.

#### C4. Cumulative metrics (wave 3; after C2, C3)
A running or trailing total by period.
Steps:
1. Run the two-model spike first. If it needs a change to `lib/compiler/parts.ts`, stop and hand that change to D as a pull request after D2; C4 never edits `parts.ts`.
2. `metrics.schema.json`: type `cumulative` (measure, window, grain); `Metric` union gains `CumulativeMetric` from `lib/metric-types.ts`.
3. Both `metricMeasureRefs` return its measure.
4. `compiler/cumulative.ts` `generate_series` spine and `sum() over (rows ...)`, called from the `formula()` branch.
5. `add-metric --type cumulative --window`; hash, readback and card question.
Proves it:
- Empty months carry the total; window 3 equals hand SQL; a request with no time dimension refuses.
- `tests/compat/running-total.test.ts` confirms a running-total golden over the Acme warehouse on PostgreSQL, in the `compat` job.

#### C5. Period-over-period metrics (wave 3; after C4)
A measure against itself some periods earlier.
Steps:
1. Type `period_over_period` (measure, offset, difference, ratio or percent_change).
2. `compiler/period-compare.ts` reuses the spine with `lag()` and `nullif`.
3. A time-dimension filter is applied on the outer query; readback says so.
Proves it:
- First period is null; zero prior gives null; a last-month filter still shows the prior period.
- `tests/compat/period-compare.test.ts` confirms a month-over-month golden over the Acme warehouse on PostgreSQL, in the `compat` job.

**Milestones.**
- After C1a, C1b: `semlayer sql --request goldens/revenue.yaml` prints the segment inside `filter (where ...)`; `semlayer validate` fails on a bad segment name with a `metric.*` code.
- After C2, C3: `semlayer sql` for `balances.closing_balance` by `snapshot_date:month` prints a `DISTINCT ON` subquery, and the balance golden is confirmed on PostgreSQL.
- After C4, C5: `semlayer goldens check` passes a running total and a month-over-month golden on PostgreSQL.

**Risks.**
- Approval bypass: a key missing from `approval-hash.ts` skips the owner's yes. Each PR has a mutate-after-approve test.
- C and D edit different named anchors of `compileLayer`; only C1a and D4 share one, the `aggregate(...)` call in the measure branch of `sqlOf`, and D4 goes second.
- The period spine must truncate like `grained()` or a DST month is dropped. A fixture near a DST change runs in C4's first commit.
- Cumulative across models may need a refactor of the one-CTE-per-model shape. C4's first step is a two-model spike, and a change to `parts.ts` goes to D.

### D. Bridges and multi-fact queries (issue #8)

**Outcome.** An owner can ask for orders and refunds by month in one request. They can also model a many-valued attribute, such as order tags, through a bridge table with a dedupe rule they chose, and read back what the totals will and will not add up to.

**Today.**
- A request whose measures come from two models is refused with "a request's measures must share one model, or be one metric" (`lib/compiler/index.ts:156`, `lib/compiler/metrics.ts:167`, `checkMeasureModels` in `lib/validate.ts`).
- Metrics already compile one CTE per model and combine them on the union of dimension keys with `is not distinct from` (`metrics.ts`, from `const parts`). A plain request cannot use that path.
- `Join` has no `through`. `$defs.join` in `schemas/model.schema.json` forbids extra keys and allows three relationships. `JoinPlan.requestPath` in `lib/compiler/joins.ts` follows to-one joins only, and `hop` refuses many_to_many evidence.
- `validate.ts` errors on an approved join with many_to_many evidence and warns on every one_to_many. `check-join` measures one key pair (`lib/sql/join-check.ts`).
- `roleOf` in `lib/baseline.ts` classes a table as `bridge`, but `draftModels` writes no join for it.

**Scope.**
In this plan: multi-fact requests, `through` joins with a mandatory dedupe rule, bridge check-join and readback.
Later (wave 3 or 2.0): conformed dimensions (D2, the same-name rule serves first), draft proposing bridges (D6), weight beyond a single column, chains of two bridges.
Not planned: MetricFlow and Cube entity vocabulary (E3, E4 deferred), a bridge default, schema logic (a bridge in another schema is a declared pair under G).

**Owns.**
- New: `lib/compiler/parts.ts`, `lib/compiler/bridge.ts`, `lib/through.ts`, `lib/conformed.ts`, `lib/validate-rules/join.ts`, `lib/issue-codes/join.ts`, `lib/readback-bridge.ts`, `lib/sql/through-check.ts`, `lib/draft-bridge.ts`, `commands/add-bridge.ts`, `commands/conform.ts`, `fixtures/semantics/bridge.sql`, `tests/docs-rules/bridges.ts`, `tests/compat/{multifact,bridge}.test.ts`, and `tests/{compiler-multifact,compiler-bridge,through-join,check-join-bridge,conformed,draft-bridge}.test.ts`.
- Edited by D alone in waves 2 and 3: `lib/compiler/joins.ts` and `commands/check-join.ts` (G2c edits both in wave 1). `lib/compiler/sql.ts` is left untouched.
- Code family `join.*`. Card `references/phases/joins.md` (at most 8 lines). Spec heading `### Bridges and multi-fact requests`, under Reference compiler.

**Pull requests.**

#### D1a. Extract the part builder (wave 2; after nothing)
Move the per-model CTE builder out of `metrics.ts` with no change in SQL.
Steps:
1. Create `lib/compiler/parts.ts` exporting `compileParts`, holding `metrics.ts` from `const parts` to the final return (`reaches`, `mapped`, the part loop, the union-of-keys outer query).
2. `metrics.ts` keeps `parseFormula`, `render` and `formula`, and calls `compileParts`.

Proves it:
- `compiler-metrics.test.ts` and `goldens-recompile.test.ts` pass unedited.
- A snapshot of every metric SQL in the tests is byte-identical before and after.

#### D1b. Multi-fact requests (wave 2; after D1a, B1)
A plain request over several models compiles to one CTE per model, combined on the shared dimensions.
Steps:
1. In `compileMetrics`, widen the entry guard so plain measures naming several models go to `compileParts`; delete its `must share one model` refusal.
2. In `compileLayer`'s `resolve`, delete the measures branch (its `must share one model` refusal) and keep the filter refusal.
3. Empty `checkMeasureModels` and its call in `validate.ts`.
4. Rewrite the sentence in `spec.md`, `verify.md`, `verification.md`, the `share one model` line of the request help in `commands/goldens.ts`, and the docs-rules rows that pin it; flip the five tests that assert it in `compiler.test.ts`, `compiler-metrics.test.ts`, `goldens-recompile.test.ts` and `validate.test.ts` (two).
5. Add `tests/compat/multifact.test.ts`: it loads the Acme warehouse with `fixtures/acme/load-postgres.ts` into a unique schema from `PG_URL`, builds the small layer with typed commands and confirms the orders-and-refunds-by-month golden with `semlayer goldens confirm`; it is required in F1's `compat` job and skipped locally without `PG_URL`.

Proves it:
- `compiler-multifact`: orders.revenue and refunds.refunded by month give two CTEs; a month only in refunds still appears; totals equal two single-model queries on DuckDB.
- A dimension neither model reaches gives `no_shared_dimension`; a single-model request is byte-identical.
- The orders-and-refunds golden is confirmed on PostgreSQL in the `compat` job.

#### D3. `through` joins: schema and validation (wave 2; after B1)
A model can declare a bridge join that requires a dedupe rule.
Steps:
1. `lib/through.ts` defines `Through` (`model`, bridge-to-target `keys`, `dedupe`: `distinct_pairs`, `equal_split` or `weight`, `weight` column); `Join` gains `through?`.
2. Add `through` to `$defs.join`; `keys` stays fact-to-bridge, relationship `one_to_many`.
3. `commands/add-bridge.ts` writes the draft; add its spec row.
4. `lib/validate-rules/join.ts`, with codes registered in `lib/issue-codes/join.ts`: `join.through_bridge_unknown`, `join.through_columns_missing`, `join.through_dedupe_missing` (error once approved), `join.through_weight_invalid`.
5. `joinContent` in `approval-hash.ts` includes `through`; the one_to_many warning in `validate.ts` skips a through join.
6. `requestPath` refuses a through route with `no_join_path` until D4.
7. Add `fixtures/semantics/bridge.sql`: one file of DDL and inserts for orders, tags and an order-tag bridge that runs unchanged on PostgreSQL and DuckDB, every value synthetic.

Proves it:
- The schema rejects an approved through join with no dedupe; each code fires on its fixture.
- The approval hash changes when dedupe changes; `add-bridge` output equals a golden YAML.

#### D4. Compile `through` joins on PostgreSQL (wave 2; after D3, C1a)
Grouping by a many-valued dimension returns figures that are not multiplied.
Steps:
1. `lib/compiler/bridge.ts` builds the deduped bridge subselect and the allocation factor.
2. `requestPath` returns the bridge and target instances; `PlannedJoin` gains `through`, which marks the result many-valued.
3. In `compileLayer`'s `sqlOf` (measure branch) multiply `sum` and `count` by the factor; refuse other aggregates, a second through path, and a filter on a through dimension that is not grouped.
4. The bridge applies the user's row filters; a bridge hidden from the role gives `not_visible`.
5. Add `tests/compat/bridge.test.ts`: it loads `fixtures/semantics/bridge.sql` into a unique schema from `PG_URL`, builds the small layer with typed commands and confirms a by-tag golden with `semlayer goldens confirm`; it is required in F1's `compat` job and skipped locally without `PG_URL`.

Proves it:
- Two of three tags give the order's revenue to each tag; the ungrouped total equals the true total; `equal_split` rows sum to it.
- Duplicate bridge rows leave `distinct_pairs` unchanged; the hidden-bridge test refuses.
- The by-tag golden is confirmed on PostgreSQL in the `compat` job; the unit tests run the same SQL on DuckDB.

#### D5. check-join and readback for bridges (wave 2; after D3)
The owner sees the bridge's measured facts and confirms the dedupe rule.
Steps:
1. `lib/sql/through-check.ts` measures duplicate pairs, orphan bridge rows, facts with no bridge row and values per fact.
2. `commands/check-join.ts` runs it for a through join, also under `--all`, and records `evidence.through`.
3. `lib/readback-bridge.ts`, called from `joinWords` in `readback.ts`, states the rule and that group totals can exceed the overall total.
4. A `join.through_facts_unbridged` warning; the bridge interview step in `phases/joins.md`.

Proves it:
- Evidence counts equal hand-computed values on a bridge fixture.
- Readback contains the rule and the overlap sentence; orphans give the warning.

#### D2. Conformed dimensions (wave 3; after D1b)
The owner can declare that two models' dimensions are the same.
Steps: add `conforms_to` to the dimension schema; `commands/conform.ts` writes it; `mapped` in `parts.ts` accepts it; `join.conformed_type_mismatch` checks type and grain; readback paragraph.
Proves it:
- Renamed dimensions group on one name; a type mismatch errors; the approval hash changes.

#### D6. Draft proposes bridges (wave 3; after D3)
A table classed `bridge` yields a draft through join and an open question.
Steps: `lib/draft-bridge.ts`, one call in `draftModels`, a candidate list from `roleOf`, one case in `nextAction`.
Proves it:
- A `user_roles` fixture drafts the join with dedupe unset; a non-bridge table drafts none.

**Milestones.**
- After D1a, D1b: `semlayer sql` with orders.amount and refunds.refunded by month prints two CTEs and a union-of-months select, and the orders-and-refunds golden is confirmed on PostgreSQL.
- After D3, D4: `semlayer sql` by tag name prints a deduped (order, tag) subselect, and the by-tag golden is confirmed on PostgreSQL.
- After D5: `semlayer check-join --join tags` prints orphans, duplicates and unbridged facts.

**Risks.**
- The `parts.ts` move changes metric SQL; the D1a snapshot shows it before D1b starts.
- C1a and D4 both edit the `aggregate(...)` call in the measure branch of `sqlOf`; D4 merges second and rebases.
- A refusal sentence left pinned fails late; grep `share one model` over `tests/` before D1b is ready.
- Large bridges are slow; check-join row counts and an EXPLAIN on F's fixture show it.

### E. dbt import and exports (issue #5)

**Outcome.** An owner who already has a dbt project can run one import and get the project's semantic models and metrics as draft dimensions, measures, joins and metrics in the layer, then read them back like any other draft. The agent sees at once which dbt items could not be mapped, and why.

**Today.**
- `semlayer import` builds a snapshot only: `ImportResult` is `{tables, warnings}` (`scripts/lib/importers/information-schema.ts:10`), and `commands/import.ts` (234 lines) prints table counts and scope changes.
- `scripts/lib/importers/dbt.ts` (419 lines) reads `nodes` and `sources` and never reads `semantic_models`, `metrics` or `saved_queries`; the test fixture holds all three empty (`tests/fixtures/imports/dbt/manifest.json:243,250,251`).
- Typed edits already cover the targets: `add-field`, `add-join --origin inferred` and `add-metric` (draft, ratio or derived only, `commands/add-metric.ts:18`) run as one validated batch through `semlayer apply --file` (`commands/apply.ts`).
- Every expression passes `sqlTextProblem(text, role)` in `scripts/lib/sql-text.ts:61`; dbt text is already treated as evidence (`references/spec.md:35`).
- No layer export exists. The word "export" is taken by `export-sql` and the Schema exports section (`references/spec.md:964`).

**Scope.**
- In this plan: read a manifest's semantic models and metrics (E1), translate simple dbt filters (E2a), write drafts through typed edits (E2b).
- Later (wave 3 or 2.0): none inside this workstream; export (E3, E4) is below.
- Not planned: MetricFlow export (E3) and Cube export (E4), because nothing consumes them before a layer exists and their output cannot be checked without running those tools; a later plan starts from what would not map: access rules, goldens, approval status, evidence, origin, `fanout_override`, open questions, profiles, protected tags, per-dimension `time_zone`, and row filters (Cube `access_policy` only; MetricFlow has none). Also not planned: cumulative, conversion, offset-window and semi-additive dbt metrics, `median`, `percentile`, `sum_boolean`, saved queries, time spines, dbt YAML source files, dialect translation of expressions.

**Owns.**
- New: `skills/semantic-layer/scripts/lib/importers/dbt-semantic.ts`, `lib/importers/dbt-filters.ts`, `lib/dbt-edits.ts`; `tests/import-semantic.test.ts`, `tests/import-semantic-filters.test.ts`, `tests/import-semantic-apply.test.ts`, `tests/fixtures/imports/dbt/manifest-semantic.json`, `tests/docs-rules/import-dbt.ts`.
- Edited only by E in wave 3: `scripts/commands/import.ts`.
- Code family: none. Skipped items carry plain reasons, not validation codes.
- Phase card: no new card; one paragraph in `references/phases/intake.md` and one in `references/phases/joins.md`.
- Spec: new section `## dbt semantic import`, plus its own CLI row.

**Pull requests.**

#### E1. Read dbt semantic models and metrics (wave 3; after nothing)
A pure reader turns a manifest's semantic models and metrics into typed data plus a skipped list, and `import --semantic` reports it without writing a layer.
Steps:
1. Export `obj`, `s` and `strings` in `lib/importers/dbt.ts` (declarations only).
2. Create `readDbtSemantic(manifest)` in `lib/importers/dbt-semantic.ts`: entities, dimensions (categorical, time with granularity), measures (`sum`, `count`, `count_distinct`, `average` as `avg`, `min`, `max`) and metrics (`simple`, `ratio`, `derived`); resolve each model's relation with `splitRelationName`.
3. Match a foreign entity to another model's primary or unique entity as a join candidate; direct pairs only.
4. Record every other metric kind and measure agg in `skipped` with name and reason; report items over tables dropped by `intake.schemas`.
5. Add `semantic?` to `ImportResult`, pass the manifest through `importSnapshot`, and add `--semantic` to `commands/import.ts` with counts, the skipped list and `--json` fields.
6. Add the spec CLI row and section, and the fixture.
Proves it:
- Fixture output deep-equals the expected models, entities, measures and metrics.
- Cumulative and conversion metrics appear in `skipped`, not in output; an unsupported agg is skipped, not coerced.
- The existing manifest imports exactly as before.

#### E2a. Translate dbt filters to column SQL (wave 3; after nothing)
A pure function turns the simple dbt filter form into column SQL, or refuses it with a reason.
Steps:
1. Create `translateDbtFilter(text, columns: Record<string, string>)` in `lib/importers/dbt-filters.ts` for `{{ Dimension('model__col') }} op literal`, joined by `and`, where `columns` maps a dbt `model__dimension` name to its column SQL; it imports nothing from `dbt-semantic.ts`.
2. Look each dimension name up in `columns`; E2b builds `columns` from E1's dimensions.
3. Run `sqlTextProblem` on the result for the role it will take.
4. Return `{sql}` or `{skipped: reason}`; never pass Jinja through.
Proves it:
- Simple, `and`-joined and quoted-literal filters translate to the expected SQL.
- `TimeDimension`, `Entity`, nested Jinja and an unterminated string are skipped with a reason.
- A hostile string (`'; drop table x; --`) is refused by `sqlTextProblem`.

#### E2b. Write imported items as draft edits (wave 3; after E1, E2a, G2)
`import --semantic --emit <file>` writes a typed-edit file for models already drafted; `semlayer apply` then adds the drafts.
Steps:
1. Create `toEdits(semantic, layer)` in `lib/dbt-edits.ts`: `add-field`, `add-join --origin inferred` and `add-metric` entries; a simple metric becomes its measure with the filter translated through `translateDbtFilter`, given a `columns` map built from E1's dimensions.
2. Skip existing names and list them; list models not yet drafted as "run `semlayer draft` first"; skip a join across schemas and say it needs G's declaration.
3. Add `--emit` to `commands/import.ts`; the descriptions say "from the dbt manifest".
4. Extend the spec CLI row and section.
5. Edit `phases/intake.md` (the folder-evidence paragraph and the "Other shared context" bullet) and `phases/joins.md` (a paragraph on checking imported joins).
6. Add the docs rules file.
Proves it:
- Emit, `semlayer apply`, then `validate` gives zero errors and every item is draft.
- A name collision leaves the existing item byte for byte; a second run emits nothing.
- An imported join has origin `inferred` and `check-join` measures it on demo data.

**Milestones.**
- After E1: `semlayer import --source acme --file tests/fixtures/imports/dbt/manifest-semantic.json --semantic` shows counts of semantic models, measures and metrics and one skipped cumulative metric.
- After E2b: `import ... --semantic --emit edits.json`, `semlayer apply --file edits.json`, `semlayer validate` exits 0, and `semlayer status` lists the items as draft.

**Risks.**
- dbt's semantic YAML changed across versions (nested `type_params`); found out in E1 by running the reader on real manifests from dbt 1.7, 1.9 and 1.11 and warning per field.
- Filter translation can grow past 400 lines; E2a is its own PR and supports one form only, so the size shows in its first diff.
- Manifest text is untrusted; the hostile-text test in E2a and the draft-only check in E2b show a leak early.


### F. PostgreSQL proof and dialect scope (issue #6, re-scoped)

**Outcome.** A first-time owner is asked about a Postgres database only, and the layer is built against a database whose version, pooler and TLS setup have been run in CI, not assumed. A restricted role gets a snapshot of only the tables it can read, and says which it skipped.

**Today.**
- CI runs one server, `postgres:16` with a password over TCP and no TLS (`.github/workflows/ci.yml:15-26`). `references/exports/postgres.sql:1` promises "12 or later"; no other version has ever run.
- The first-turn question offers five dialects plus export-only MySQL and SQL Server (`references/phases/intake.md:26`). Lines 42-43 list the query-plan path and eight export dialects. `references/intake.md:143-196` and 203-224 is warehouse query-plan and Snowflake, BigQuery and Databricks material, loaded with the intake card.
- `startupSettings` sends `default_transaction_read_only` and `statement_timeout` as startup parameters (`lib/adapters/postgres.ts:42-43`). A transaction-mode pooler rejects unknown startup parameters unless configured to ignore them, and `connectFailure` (`:251`) reports that as a plain "cannot connect". Each query already runs inside `BEGIN TRANSACTION READ ONLY` (`:298`).
- `SSL_MODES` accepts `verify-ca` and `verify-full` (`:169`) and passes the mode to Bun's `tls` option (`:214`). No test connects over TLS, and there is no way to give a CA file.
- The `tables` query in `postgresQueries` (`lib/sql/introspection.ts:98-125`) lists every relation with no privilege check, so a SELECT-only role on part of a schema gets tables that `profile` then fails on. Only the export query is tested on partitioned, materialized and foreign tables (`tests/export-sql.test.ts`).

**Scope.**
- In this plan: first-turn and README narrowed to Postgres (DuckDB for the demo and files), version matrix 13 to 17, pooler and TLS tests, catalog edge cases, restricted role.
- Later (wave 3 or 2.0): provider verification kit for Supabase, Neon, RDS and Cloud SQL (F5, needs owner credentials), 5,000-table timing, Redshift (not catalog-compatible with Postgres).
- Not planned: MySQL and SQL Server source dialects (no compiler or plan design), live runs of Snowflake, BigQuery and Databricks, deleting the mysql, sqlserver and redshift export code (kept so 2.0 can revive it; hidden from the card and README).

**Owns.**
- New: `scripts/compat-pg.sh`; `tests/compat/{version,catalog,pooler,tls}.test.ts`; `tests/compat/two-schemas.sql`; `tests/compat/docker/`; `tests/docs-rules/dialects.ts`; `references/other-dialects.md`; `lib/sql/unreadable.ts`; later `docs/compat/postgres.md`, `scripts/compat-provider.sh`, `tests/fixtures/managed/`.
- Alone in its wave: `lib/adapters/postgres.ts`, `lib/sql/introspection.ts`, `references/intake.md`, `references/exports/postgres.sql`, `commands/doctor.ts` (F5). F4 edits `references/phases/intake.md` first; G3 follows in the same wave (section 6).
- Code family: none (messages keep stable text for B to code). Card: `phases/intake.md` first-turn paragraph. Spec section: "Schema exports" (one sentence only).

**Pull requests.**
#### F4. Narrow the product text to PostgreSQL (wave 1; after nothing)
The first turn and README ask about Postgres only; warehouse plan material leaves the default path.
Steps:
1. Rewrite `phases/intake.md` lines 26, 42 and 43: "Which Postgres database?", DuckDB only for sample or file data, one line pointing to `references/other-dialects.md`.
2. Move `references/intake.md` "The query-plan protocol" and the Snowflake, BigQuery and Databricks notes to `references/other-dialects.md`, headed "not supported for new work"; leave "Time zones, every dialect" and "Postgres".
3. Reword the README table under "Sources and dialects", and in place (net 0 lines) the `SKILL.md` frontmatter description and the topic-table row "Only when a source is not a live postgres or duckdb connection"; add one sentence to spec "Schema exports" that mysql, sqlserver and redshift exports are kept but unsupported.
4. Move the export-dialect list and the two MySQL and SQL Server sentences from `phases/intake.md` to `references/other-dialects.md`. Retarget the test "the intake card names every export dialect and the file it prints" in `tests/skill-docs.test.ts` and the two rows of `tests/docs-rules/doc-phases-intake.ts` that pin those sentences to that file, moving the rows to `tests/docs-rules/dialects.ts`, and list each retargeted rule in the PR description.
5. Add `tests/docs-rules/dialects.ts` rows.
Proves it:
- `phases/intake.md` names no snowflake, bigquery, databricks, mysql or sqlserver, and every rule that pinned one of them passes against `references/other-dialects.md`.
- `export-sql --dialect mysql` still works (code kept).
- `semlayer next --json` on a fresh project names only postgres and duckdb, and a rule in `tests/docs-rules/dialects.ts` checks the same of the intake card.

#### F1. Postgres version matrix in CI (wave 1; after F4)
Run the live Postgres tests on every supported server version from one script.
Steps:
1. Write `scripts/compat-pg.sh <version>`: start `postgres:<v>`, wait on `pg_isready`, set `PG_URL`, run the files that read it (every file under `tests/compat/` among them), remove the container; `scripts/pg-local.sh` stays the no-Docker path.
2. Add a `compat` job to `ci.yml`, matrix 13 to 17, appended after the existing jobs.
3. Add `tests/compat/version.test.ts`: record `server_version_num`, run `introspectionPlan` and `executePlan` on a small schema.
4. Fix what older versions show (`pg_partition_tree`, `reltuples` at `postgres.sql:29`).
5. State the lowest passing major in the `references/exports/postgres.sql` header and in the PR description; the orchestrator's end-of-wave pull request carries it to `README.md`.
Proves it:
- Each version returns the fixture schema's tables, columns, keys.
- The export query imports to the same snapshot on each version.

#### F2. Catalog edge cases and restricted role (wave 1; after F1, G1)
Introspection handles views, partitions, foreign tables, mixed-case names and a partly readable schema.
Steps:
1. Add `tests/compat/catalog.test.ts` creating a partitioned table, view, matview and `postgres_fdw` foreign table in a unique schema, and a schema and table with mixed-case names (`"Sales"."Orders"`); introspect, draft and compile quote them.
2. Apply one privilege predicate, `has_any_column_privilege(c.oid, 'SELECT')` (the one the role report in `lib/adapters/postgres.ts` uses), to the `tables`, `columns`, `primary_keys` and `foreign_keys` queries in `postgresQueries`, not to `where()`. In `buildSnapshot` (`lib/introspect.ts`), keep column, key and foreign-key rows only for tables the `tables` query returned.
3. Add `lib/sql/unreadable.ts` listing relations the role cannot read; `commands/introspect.ts` prints them as skipped.
4. Add `tests/compat/two-schemas.sql`: two schemas, a foreign key from one into the other, and a table of the same name in both. It is the fixture for G3's live test.
Proves it:
- Partitioned parent appears once, leaves are absent; foreign is `external`; view and matview are `view` with null `row_count`.
- A role with SELECT on two of four tables gets two, and the output names the other two.
- The restricted role's snapshot has no entry, column or key for the two unreadable tables.
- The mixed-case table is introspected, drafted and compiled with quoted names.

#### F3. Pooled and TLS connections (wave 1; after F1)
A connection through PgBouncer or over TLS works, or says what to change.
Steps:
1. Add `tests/compat/docker/` with PgBouncer (transaction mode, default config) and a TLS Postgres with a self-signed certificate; add a `compat-network` job to `ci.yml`.
2. In `run()` in `adapters/postgres.ts`, issue `SET LOCAL statement_timeout` after `BEGIN TRANSACTION READ ONLY`; keep `default_transaction_read_only` and `TimeZone` as startup settings only if the pooler test passes, else drop the first and `SET LOCAL` the second. Read-only rests on `BEGIN TRANSACTION READ ONLY`, and the pooler write-refusal test proves it.
3. In `connectFailure`, match "unsupported startup parameter" and name the fix.
4. Accept `<PREFIX>SSLROOTCERT` (and `sslrootcert` in the URL) and pass `Bun.file(path)` in Bun's `tls` option; test `verify-full` against the self-signed container.
Proves it:
- Through the pooler, setup, introspect and profile succeed; a sleep past `SEMLAYER_STATEMENT_TIMEOUT_MS` is cancelled.
- The existing `tests/adapters.test.ts` "postgres, read-only" test still refuses `create table`, and a new pooler test refuses a write. Moving the statement timeout touches the read-only guarantee, so F3 does not land unless this test passes through the pooler.
- `sslmode=require` connects; a no-TLS server with `sslmode=require` gives the `noSslHint` message.
- `verify-full` with the container's CA file connects.


#### F5. Provider verification kit (wave 3; after F3)
The owner can run a read-only check against Supabase, Neon, RDS or Cloud SQL and commit the output.
Steps:
1. Extend `commands/doctor.ts` `--json` with server version, pooled guess, TLS in use.
2. Write `docs/compat/postgres.md` and `scripts/compat-provider.sh`, which redacts host and user.
Proves it:
- `doctor --json` holds `server_version` and `tls`; committed fixtures contain no host, user or password.

**Milestones.**
- After F4: `semlayer next` on a fresh project and `phases/intake.md` name Postgres and DuckDB only.
- After F1: `bash scripts/compat-pg.sh 14` exits 0 and the CI `compat` job is green on five versions.
- After F2, F3: `bun test tests/compat` passes against the PgBouncer and TLS containers, and a SELECT-only role's `semlayer introspect` prints the tables it skipped.

**Risks.**
- Older versions fail catalog queries and widen F1; found in the first matrix run, so F1 starts with the matrix and no fixes.
- Docker is missing for some contributors; the matrix runs only in CI and `pg-local.sh` remains.
- Moving the timeout breaks the read-only guarantee unnoticed; found by the pooler write-refusal test.

### G. Schema scope (owner's direction)

**Outcome.** A first layer reads one named primary schema, and no join leaves it by accident. When the owner wants data from a second schema, the agent asks, records the pair with its key relationships, and only then can a join cross.

**Today.**
- `intake.schemas` filters what is read (`schemas/source.schema.json:92`, `lib/intake.ts`, `lib/sql/introspection.ts:98-165`), but there is no primary schema and no meaning beyond that filter.
- The catalog returns each foreign key's constraint name; `lib/introspect.ts:140-175` groups by it and then drops it.
- `lib/draft.ts` `joinCandidates` and `keyNameCandidates` search every snapshot table, so a join can be inferred across schemas from names alone. The declared-FK loop (`table.foreign_keys`, ~:740) drafts a cross-schema FK without a question.
- `validate` (`lib/validate.ts:~812`), `add-join`, `check-join` and `lib/compiler/joins.ts` never compare the two tables' schemas.
- `lib/next.ts` and `lib/status.ts` never ask about schemas; `parseTarget` (`lib/refs.ts`) knows no schema-pair target.

**Scope.**
In this plan: primary schema, constraint names in snapshots, directional declared pairs with at least one key relationship, owner approval, enforcement in validate, add-join, check-join, the compiler and draft, the `next` question.
Later (wave 3 or 2.0): chains of three or more schemas, pair-level column allowlists, cross-schema access rules, schema-per-tenant layouts.
Not planned: dialect work, view bodies with unqualified names (not analysed), DuckDB dotted `database.schema` handling (unchanged).

**Owns.**
- New: `lib/schema-scope.ts`, `lib/validate-rules/scope.ts`, `lib/issue-codes/scope.ts`, `commands/add-cross-schema.ts`, `commands/remove-cross-schema.ts`, `tests/docs-rules/schema-scope.ts`, `tests/schema-scope.test.ts`, `tests/schema-scope-draft.test.ts`, `tests/schema-scope-enforce.test.ts`, `tests/compat/schema-scope.test.ts`.
- Edited only by G in wave 1: `lib/draft.ts`, `lib/setup.ts`, `lib/review.ts`, `commands/setup.ts`, `commands/draft.ts`, `commands/add-join.ts`, `commands/check-join.ts`, `lib/compiler/joins.ts`, `schemas/snapshot.schema.json`. `lib/introspect.ts` is shared with F2 (section 6).
- Code family `scope.*`. Phase cards: a paragraph in `references/phases/scope.md`, one in `intake.md`, one sentence in `draft.md`. Spec heading `### Schema scope` (before `### Scope patterns`).

**Pull requests.**
#### G1. Primary schema and kept constraint names (wave 1; after nothing)
A source names a primary schema and draft stops joining outside it.
Steps:
1. Add `intake.primary` to `source.schema.json` and one line to `SourceConfig.intake`; add optional `constraint` to snapshot foreign keys and `ForeignKey`.
2. Write `lib/schema-scope.ts`: `primarySchema(source, snapshot)` (explicit, else the sole entry, else undefined: no guess), `crossSchemaFks(snapshot)`.
3. Keep the name in the `fks.push` of `lib/introspect.ts` for named keys only.
4. In `joinCandidates` and `keyNameCandidates` keep only the table's own schema; in the declared-FK loop call `ask()` naming both schemas and the constraint, and add no join.
5. Add `setup --primary <schema>` (`lib/setup.ts` `ORDER`, `commands/setup.ts`) and print the primary; write spec `### Schema scope` and the `setup --primary` CLI row.

Proves it:
- Two-schema snapshot drafts no cross-schema join from matching names.
- A cross-schema FK yields one question quoting its constraint name and no join.
- Old snapshots without `constraint` still validate; the DuckDB demo drafts as before.

#### G2. Declare a schema pair and validate it (wave 1; after G1, B1)
The source can hold an owner-approved directional pair with keys, or a declined one, and validate checks it.
Steps:
1. Add `cross_schema` to `source.schema.json` (from, to, keys, status, approval fields) and `pairAllowed`, `pairIssues` to `schema-scope.ts`; it counts only approved pairs. An entry may have `status: declined` (from, to, recorded reply); a declined pair clears G3's FK condition and resolves G1's per-FK question. Add the grace date for decision 8 as a constant in `schema-scope.ts`.
2. Write `add-cross-schema` (`--source --from --to --keys t.c=t.c... --constraint`, and `--decline`, which writes a declined pair) and `remove-cross-schema`; both refuse a key absent from the snapshot. When `--to` is not among the schemas read, `add-cross-schema` refuses and names `semlayer setup --source <s> --dialect postgres --env <VAR> --schemas <existing>,<to>`, which reads the catalog again.
3. Write `lib/validate-rules/scope.ts` (found by name; no index edit) and register its codes in `lib/issue-codes/scope.ts`: `scope.cross_schema_undeclared` (an error for a draft join across an undeclared pair; a warning for an approved one until the grace date, then an error), `scope.key_not_in_snapshot`, `scope.primary_not_in_schemas`, warning `scope.pair_unused`.
4. Add spec CLI rows and the pair paragraph.

Proves it:
- add-cross-schema writes a draft pair and refuses a missing key; `--decline` writes a declined pair.
- Validate errors on a draft cross-schema join across an undeclared pair, warns on an approved one, and passes once the pair is approved.

#### G2b. Approve a schema pair on the owner's yes (wave 1; after G2, B2, B3)
`semlayer approve --target schema-pair:<source>:<from>:<to>` rests on a ledger reply.
Steps:
1. Extend `Target` and `parseTarget` in `lib/refs.ts` with `schema-pair:<source>:<from>:<to>`, split on ':', each part an identifier as `lib/intake.ts` defines one (`IDENT`), case kept.
2. Add the kind to `ItemKind` and the entry listing (`listApprovals`) in `lib/approval-hash.ts`.
3. Add the kind to `ItemKind` and a `locate` case in `lib/edit.ts`, so the approval stamp is written into the pair entry of `sources/<source>.yaml`; add a case to `openQuestions` and `where` in `lib/review.ts`.
4. Add a case beside `access` in `commands/approve.ts` and `lib/readback.ts`; map it in `targetPhase` of `lib/next.ts`.

Proves it:
- Approve without a recorded yes is refused; with one it records approver, date and hash.
- `approve --target schema-pair:<s>:<from>:<to>` writes `approved_hash` into the pair entry of `sources/<s>.yaml`.
- Editing an approved pair marks it changed since approval.

#### G2c. Enforce pairs in join commands, compiler and draft (wave 1; after G2)
No new join crosses schemas unless its pair is approved, and an approved one that does is reported.
Steps:
1. Refuse in `commands/add-join.ts` `run` and `check-join.ts` `resolveTable`, naming `add-cross-schema`.
2. In `lib/compiler/joins.ts`, refuse a draft join across an undeclared pair with `scope.cross_schema_undeclared` (one `RefusalCode` member in `lib/compiler/index.ts`); compile an approved one and report the code in a new `warnings?: { code, message }[]` field on `Compiled`, until the grace date, then refuse.
3. Print the compiler's warnings in `semlayer goldens check` (`checkCommand` in `commands/goldens.ts`).
4. Let `draft.ts` draft an approved pair from its listed keys only.

Proves it:
- `semlayer sql` refuses a draft join across an undeclared pair with the code, and prints schema-qualified SQL for a declared one.
- An approved join across an undeclared pair compiles with the warning, and `goldens check` prints it.
- Add-join and check-join refuse an undeclared pair.

#### G3. `semlayer next` asks the schema question (wave 1; after F2, F4, G2b, G2c)
The owner is asked before any cross-schema work, and before draft when more than one schema is read.
Steps:
1. Add a `schema_scope` step in `nextStep` of `lib/status.ts`, inside the existing phase `scope` (no new phase, card or router row), after the first introspect and before draft, when more than one schema is read with no `intake.primary`, or an FK points to a schema with no approved or declined pair. `commands/draft.ts` refuses with `scope.primary_unset` while more than one schema is read and `intake.primary` is unset.
2. Return `ask_owner` from `lib/next.ts`: "Your data sits in more than one schema (A, B). Is A enough for your questions? If you also need B, tell me which A tables relate to which B tables, and by which columns." Options carry `setup --primary`, `add-cross-schema`, and "No, keep to A", which maps to `setup --primary A` plus `add-cross-schema --decline`.
3. Write the card paragraphs in `intake.md` (a new paragraph after F4's "Which Postgres database?" paragraph), `scope.md`, `draft.md` and the rules file.
4. Add `tests/compat/schema-scope.test.ts`: with `tests/compat/two-schemas.sql` loaded from `PG_URL`, `semlayer next --json` returns `ask_owner` before any cross-schema join exists, and `validate` passes only after `add-cross-schema` and `approve`; it runs in the `compat` job.

Proves it:
- Two-schema fixture returns `ask_owner`; the step clears after an approved pair, and after "No, keep to A".
- On the two-schema fixture, draft before the answer refuses with `scope.primary_unset`.
- `add-cross-schema` with a `--to` outside the schemas read refuses and names the `setup --schemas` command.
- The demo project never sees it.

**Milestones.**
- After G1: `semlayer draft --source warehouse` on a two-schema fixture drafts same-schema joins and prints a question per cross-schema FK.
- After G2c: `semlayer validate` fails a draft join across an undeclared pair, warns on an approved one, and passes after `add-cross-schema` and `approve`.
- After G3: `semlayer next --json` on a fresh two-schema project shows `ask_owner`, and `tests/compat/schema-scope.test.ts` passes on PostgreSQL.

**Risks.**
- Fixtures may hold cross-schema joins; grep tests before G2c.
- Approval-kind switches may sit in more files than G2b lists; read how `access` was added first.

### H. Iterating a layer from 1 to 1.x (owner's direction)

**Outcome.** When a finished layer needs one more metric, table or definition, a person or agent opens a change round, sees exactly what moved, and closes it with a version the owner chose and a changelog entry showing which goldens' figures changed. A schema refresh leaves a record, and a retyped column is flagged without a hand-written question.

**Today.**
- On a finished layer `semlayer next` returns phase `done` with action `validate` (`skills/semantic-layer/scripts/lib/status.ts` ~1150-1166). Nothing tells the agent that `add-metric` works there.
- No version or changelog exists. `schemas/project.schema.json` `version` is the spec version, const 1. No command is named change, diff, release or version.
- `introspect` prints the snapshot diff, including retyped columns, then overwrites the snapshot (`commands/introspect.ts` ~203-205, `lib/snapshot-diff.ts`). `references/phases/drift.md` step 2 has the agent write a question for each retyped column by hand.
- `goldens check` gives pass or fail per golden and saves nothing (`commands/goldens.ts` `checkCommand`). `goldenRun` (exported, line 363) already returns a golden's current rows.
- `examples/acme/semantic` is a finished layer: 17 approved goldens with recorded rows, `approved_hash` on its items, phase `done`. Tests copy it (`tests/ledger.test.ts`); DuckDB data for reruns is in `fixtures/acme/data` (`tests/goldens-recompile.test.ts`). No new layer fixture is built.

**Scope.**
In this plan: layer_version and changelog.yaml, item diff against the last release, change start/status/close, saved drift record with retyped-column warning.
Later (wave 3 or 2.0): consumer-facing "changes between versions X and Y", semver rules, per-item deprecation and rename aliases (need real consumers first).
Not planned: a migration framework, branches or environments inside the tool (git does this), version-aware compilation, changelog export to MetricFlow or Cube (E, deferred).

**Owns.**
- New: `skills/semantic-layer/scripts/commands/change.ts`, `lib/changeset.ts`, `lib/release.ts`, `lib/release-types.ts`, `lib/drift-record.ts`, `lib/validate-rules/release.ts`, `lib/validate-rules/release-drift.ts`, `lib/issue-codes/release.ts`; `schemas/changelog.schema.json`, `schemas/change.schema.json`, `schemas/drift.schema.json`; `references/phases/change.md`; `fixtures/acme/evolve-retype.sql`, `evals/scenarios/acme-pg-evolve.json` and `.script.json`; `tests/docs-rules/release.ts`, `tests/release-fixture.ts`, `tests/release.test.ts`, `tests/change-status.test.ts`, `tests/change-start.test.ts`, `tests/change-close.test.ts`, `tests/drift-persist.test.ts`.
- Edited by H alone: `references/phases/drift.md` (H5), `references/phases/handoff.md` (H4), `schemas/project.schema.json` (H1).
- Code family `release.*`. Spec heading `## Iterating a layer`. Phase card `change.md`.
- H does not edit `commands/goldens.ts`; it calls `goldenRun`.

**Pull requests.**

#### H5. Keep the drift record (wave 2; after nothing)
A schema refresh leaves a record, and a retyped column that an approved field reads is flagged.
Steps:
1. Add `lib/drift-record.ts` with `writeDrift` and `readDrift` for `.semlayer/drift.json` (`{at, source, diff}`), validated by `schemas/drift.schema.json`.
2. In `commands/introspect.ts`, after `diffSnapshots` succeeds, call `writeDrift`, which merges the new diff into the record: a retyped entry stays until the field that reads the column is edited or re-approved (its hash changes).
3. Add `lib/validate-rules/release-drift.ts`: warning `release.column_retyped` naming field, from and to types, using the column lookup status uses for phase `drift`; register it in `lib/issue-codes/release.ts`.
4. Rewrite `drift.md` step 2 to rely on the warning.
5. Add `fixtures/acme/evolve-retype.sql`, which names no schema (it runs through the search path), retypes `fct_orders.amount_cents` to `numeric(12,2)` and drops one column. Add `tests/compat/drift.test.ts`: it loads the Acme warehouse into a unique schema from `PG_URL`, builds and approves a small layer with typed commands, applies the file and runs `semlayer introspect`; it runs in the `compat` job.
Proves it:
- `tests/drift-persist.test.ts`: introspect over a changed fixture writes added, removed and retyped columns; a second identical run keeps the retyped entry, and re-approving the field clears it.
- A failed introspect leaves the old record.
- validate warns for an approved field reading a retyped column and not for an unread one.
- With `PG_URL`, `tests/compat/drift.test.ts` ends with a drift record naming the retyped and dropped columns and with `release.column_retyped` on the approved field that reads `amount_cents`.

#### H1. Layer version and changelog (wave 2; after B1)
The layer carries `layer_version` and an append-only `changelog.yaml`.
Steps:
1. Add optional `layer_version` (`^\d+\.\d+$`) to `project.schema.json`; one-line field on `Project`.
2. Write `changelog.schema.json` and `lib/release-types.ts` (entry: version, date, note, `items` ref-to-hash map, `goldens` recorded rows, added, changed, removed, `goldens_moved`).
3. `lib/release.ts`: `readChangelog`, `appendEntry` (temp file and rename; refuses a version not above the last).
4. `lib/validate-rules/release.ts`: `release.changelog_malformed`, `release.version_mismatch`, registered in `lib/issue-codes/release.ts`.
5. `tests/release-fixture.ts`: copies `examples/acme/semantic` to a temp dir.
Proves it:
- `appendEntry` refuses 1.0 after 1.1.
- A malformed changelog fails validate with the file name and code.
- `layer_version` different from the last entry fails validate.

#### H2. Item diff against the last release (wave 2; after H1, G2)
`semlayer change status` lists items added, changed and removed since the last release.
Steps:
1. `lib/changeset.ts` `itemMap(root)`: ref-to-hash from `statusDetail(root).targets`, plus G2's scope and cross-schema declarations.
2. `diffItems(baseline, now)`, marking changed items re-approved or still draft, and listing for each changed item the approved goldens whose request reads it (`affected_goldens`).
3. `commands/change.ts` `status`, plain and `--json`; quote `.semlayer/drift.json` when present. With no changelog, `change status` exits 0 and says there is no release yet, naming `semlayer change close --version 1.0`.
4. Add the spec CLI row.
Proves it:
- On the fixture: edit a measure, then status lists it changed and draft, with the goldens that read it; `add-metric`, added; `remove-field`, removed; no edits, empty and exit 0.
- A cross-schema declaration edit appears as changed.
- With no changelog, `change status` exits 0 and names `semlayer change close --version 1.0`.

#### H3. Entry point for a change request (wave 2; after H2, G3)
On a finished layer, `next` says how to start a change and tracks it.
Steps:
1. `change start --note <text>` writes `.semlayer/change.json` (`change.schema.json`).
2. In `lib/next.ts` `nextAction`, name the next step per pending item from H2, then `change close`.
3. In `lib/status.ts`, add phase `change` to the `Phase` union, returned while `.semlayer/change.json` exists, and have `nextAction` map it; reword the `done` message; show `layer_version` and the open change in `status --json`.
4. Write `references/phases/change.md`, whose first line is "Load this card when `semlayer next` names phase `change`."; add the `SKILL.md` router row `change` | `references/phases/change.md` and one principle line (H's budget of 2); `tests/docs-rules/release.ts`.
Proves it:
- `next` on the fixture names `change start` once, not after start.
- After start and `add-metric`, `next` names the metrics phase.
- The card exists, opens with its load line, and the `SKILL.md` router row routes phase `change` to it.

#### H4. Close a round (wave 2; after H3)
`change close --version 1.1` refuses unless clean, then writes the version, entry and moved goldens; with no changelog, `change close --version 1.0` records the first release.
Steps:
1. With no changelog, `change close --version 1.0` writes the first entry (item hashes and recorded golden rows) with no round open, and refuses while any item is draft or changed since approval.
2. Blockers: draft or changed-since-approval items, validate errors, and an affected golden (from H2) whose figures moved and were not confirmed again. `change close` reruns each affected golden with `goldenRun`; one whose rows differ from its recorded rows blocks the close until `semlayer goldens confirm` records the owner's yes to the new rows. A golden on a source that cannot be queried is listed as not rerun. List the blockers, exit 1.
3. `goldens_moved` lists each affected golden whose recorded rows differ from the last entry's `goldens`, with cell counts.
4. Write `layer_version` to `semantic.yaml`, call `appendEntry`, delete `change.json`.
5. Print items, moved goldens and version.
6. Edit `references/phases/handoff.md` so the agent records the layer as 1.0 with `semlayer change close --version 1.0` when a first build ends.
Proves it:
- On the fixture with no changelog, `change close --version 1.0` writes the first entry, and refuses while an item is draft.
- Refuses on a draft metric and names it.
- Edit a measure read by two goldens: close refuses and names both; after `goldens confirm` on a recorded yes for each, the entry lists both with before and after.
- Closing twice with one version fails.

**Milestones.**
- After H5: `semlayer introspect` on a changed table, then `semlayer validate`, shows `release.column_retyped`, and a second identical introspect keeps it.
- After H1, H2: `semlayer change status --root <fixture>` after `semlayer set` on a measure shows it changed.
- After H3: `semlayer next` on the fixture says `change start`.
- After H4: `semlayer change close --version 1.0` on the fixture records the first release, and after one added metric `semlayer change close --version 1.1` shows `layer_version: 1.1` and a changelog entry naming it.

**Risks.**
- The fixture's 90 approvals lack an owner yes in the ledger; close must not block on them. Found by running close on the fixture copy in H4's first test.
- Changelog size from stored golden rows: close the fixture (17 goldens) and check bytes in H1.
- Hashes cover definitions, not data; found by running `goldens check` on altered fixture CSV.
- G2 fields missing from the item map; found by H2's cross-schema test.

## 8. Decisions for the owner

The plan is written on the default in each row. A different answer changes only the pull requests named.

| # | Decision | Default the plan assumes | Other options | Needed before |
|---|---|---|---|---|
| 1 | The export files and code for MySQL, SQL Server and Redshift, which were never run on a real server | Keep the code; take it out of the first-turn card, the README and the default agent path | Remove it (smaller surface, harder to revive) | F4 |
| 2 | Lowest supported PostgreSQL major | The lowest of 13 to 17 that passes the version matrix, stated in the README | 12 (claimed today, past end of life); 14 | F1 |
| 3 | Does a live-model eval block a merge | No: it runs on a schedule and on a label, and reports | Required on pull requests labelled as changing agent text; required on every pull request | A5 |
| 4 | A model API key as a repository secret, and its monthly spend cap | A scheduled job with a cap the owner sets; the owner records the first baseline by hand | No key: scripted evals only | A5 |
| 5 | Marking `eval-smoke` a required check | The owner sets it in branch protection after W0.1 merges; a pull request cannot | Leave it blocking only by job status | after W0.1 |
| 6 | Where the primary schema is recorded | An explicit `intake.primary`, set by `semlayer setup --primary` | The first entry of `intake.schemas` | G1 |
| 7 | What a cross-schema declaration holds | A directional pair, from one schema to another, with at least one key relationship (a foreign key constraint or a column pair), approved on a recorded yes | An unordered pair; a pair with no keys | G2 |
| 8 | A join across an undeclared schema pair | A draft join is an error at once in validate, the join commands and the compiler; a join approved before this change compiles with a warning from validate and the compiler until the tool's next minor version (a dated constant in `lib/schema-scope.ts`), then an error | An error at once for every such join | G2, G2c |
| 9 | Where a layer's version lives and who chooses it | `layer_version` in `semantic.yaml` with `changelog.yaml` beside it; the owner passes the number and the tool checks that it rises | Git tags only; the tool proposes the number | H1, H4 |
| 10 | Is a change round required before editing a finished layer | Optional: edits work as today, and closing a round compares with the last release | Required before any edit | H3 |
| 11 | A request naming measures of two fact tables | Allowed whenever the models share a dimension, refused with a code when they do not | Allowed only after the owner confirms the shared dimension in a readback | D1b |
| 12 | The dedupe rule of a bridge | Mandatory, no default; `distinct_pairs`, `equal_split` or a weight column | A default of `distinct_pairs` | D3 |
| 13 | Segments, calendar and week start | Segments belong to one model; the calendar is set per source; weeks start on Monday as today; fiscal years are out | Shared segments; a calendar per time dimension; fiscal years in C2 | C1a, C2 |
| 14 | Running totals and period-over-period | Wave 3 | Wave 2, beside balances | C4 |
| 15 | What dbt import does | Reads semantic models and metrics as drafts with origin `inferred`; nothing is approved; no export | Also export to MetricFlow, or to Cube | E1 |
| 16 | Who runs the check on managed PostgreSQL services | The owner runs the kit on Supabase and Neon and commits the redacted output | Rely on the pooler and TLS containers only | F5 |
| 17 | Warnings under `--json` | Existing string lists stay; objects with codes are added beside them | Replace the strings (breaks current readers) | B2 |
| 18 | Does the smoke fail on token or effort growth | It warns when a scenario's tokens rise more than 10% above the baseline (W0.1) | Fail above a set share | W0.1 |
| 19 | The Snowflake, BigQuery and Databricks query-plan material | Moved to `references/other-dialects.md`, marked unsupported | Kept on the intake card | F4 |
| 20 | The direction of a schema pair | From the schema holding the foreign key to the schema it references; a join either way between those tables is allowed | The direction of the model a join is declared on | G2 |
| 21 | Statement timeout and time zone through a pooler | `SET LOCAL` inside each read-only transaction; read-only rests on `BEGIN TRANSACTION READ ONLY` | Startup parameters only, with poolers unsupported | F3 |
| 22 | Who records 1.0, and when | The agent, with `semlayer change close --version 1.0`, when a first build ends | The owner, by hand | H4 |

## 9. Not in this plan

- **Export to MetricFlow and to Cube** (the other half of #5). Nothing consumes an export before a layer exists, and the output cannot be checked without running those tools. Workstream E records what would not map.
- **MySQL and SQL Server as source dialects, and live runs of the Snowflake, BigQuery and Databricks paths** (the other half of #6). The owner's direction is PostgreSQL only for now. The existing code is neither extended nor removed.
- **Redshift.** It is not PostgreSQL-compatible at the catalog level and needs its own queries.
- **Fiscal calendars, and semantic-dimension references inside joins and filters** (parts of #4). Each needs a design decision that a first layer does not depend on.
- **`label`, and segments on metric requests and goldens** (parts of #4). A first layer needs neither.
- **The dbt-manifest eval scenario and a changed-schema eval scenario** (parts of #3). The first needs E1 and follows it. The second needs a runner step that applies SQL in the middle of a run; H5 proves the behaviour with a test on PostgreSQL instead.
- **A live-model eval as a merge gate.** Cost and run-to-run variance would block unrelated pull requests.
- **A migration framework, branches or environments inside the tool, and version-aware compilation.** Git already does the first two; the third has no user yet.
- **Cross-schema chains of more than two schemas, per-pair column allowlists and access rules that name schemas.** A declared pair covers the case the owner described.
- **Splitting `lib/validate.ts`, `lib/types.ts` or the spec further, and generating the spec's CLI table.** The seams of wave 0 are enough unless wave 1 shows otherwise; the orchestrator reports collisions at the end of each wave and this list is revisited then.

## 10. How the plan is run

1. **One pull request per block.** Each `####` block in section 7 becomes one handoff: its goal, steps and proofs, the workstream's "Owns" list, the rules of section 5 and the row of the shared-files table that applies. The handoff says what the pull request must not touch.
2. **Build, verify, fix.** A builder makes the change in its own worktree on a branch `v1/<id>-<slug>` cut from `release/v1`. A second agent, given only the handoff and the diff, tries to break it. The builder fixes what is real. This is the loop of `docs/PRD.md` section 10.
3. **Land.** `scripts/verify.sh` passes locally, the draft pull request's checks are green, and it merges into `release/v1`. The owner merges the default branch.
4. **Cheaper agents where the work is mechanical** (pure moves such as D1a and W0.2, fixtures, version matrices, docs rules), and the session's own model for contracts and for anything that guards a figure or an approval (C3, D1b, D4, G2b, G2c, B1, F3, H4).
5. **End of each wave.** The orchestrator lands the integration pull request (README, `docs/plugin.md`, cross-references in the spec), runs the milestone's checks with a fresh agent through the walkthrough harness, and reports the counts and every collision between pull requests. A milestone that fails is fixed before the next wave starts.
6. **When the last item lands**, the same pull request deletes this file and records each workstream in one line under "After this plan" in `docs/PRD-hardening.md`.

## 11. The issue tracker

| Issue | Action |
|---|---|
| #1, #2 | Close as completed, naming the pull requests that built them. |
| #7 | Close as completed; its two unfinished parts are workstream B. |
| #3 | Keep open; it closes with A5; the dbt-manifest and changed-schema eval scenarios move to a new issue. |
| #4 | Keep open; it closes with C5, with fiscal calendars, semantic-dimension references, `label` and metric-request segments moved to a new issue. |
| #5 | Keep open and retitle to the dbt import; open a new issue for the two exports. |
| #6 | Retitle to the PostgreSQL proof, closing with F5; open a new issue for the other dialects. |
| #8 | Keep open; it closes with D6. |

Each pull request of the plan names the issue it serves, so the tracker follows the work from here on.

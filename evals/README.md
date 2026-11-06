# Evals

The eval harness plays the semantic-layer skill against a simulated data owner and records what happened, so a change to the skill or the CLI can be measured (docs/PRD.md, FR-6.1). A run takes one scenario: a fixture, an intake path, an owner persona, and a turn and token budget.

- `runner/`: the runner (`run.ts` is the command), the two drivers and the persona prompts (`runner/personas/`).
- `graders/`: the deterministic graders (`grade.ts` is the command).
- `scenarios/`: the scenarios, the canned turns the scripted driver replays and the figure mapping the graders read (`acme.figures.json`).
- `smoke.ts`: the smoke command, and `baseline.json`, the scores it compares with.
- `runs/`: one directory per run, gitignored.

The file formats are in `skills/semantic-layer/references/spec.md`, section Eval runs, with schemas in `skills/semantic-layer/schemas/eval-*.schema.json`.

## Run a scenario

```sh
bun evals/runner/run.ts --scenario acme-structured            # or: bun run eval -- --scenario acme-structured
bun evals/runner/run.ts --scenario acme-terse --now 2026-01-01T00:00:00Z --out /tmp/sl-evals
```

| Flag | Does |
|---|---|
| `--scenario <name>` | A scenario in `scenarios/` by name, or a path to a scenario file. Required. |
| `--driver scripted\|sdk` | Who plays the two sides. `scripted` (the default) replays canned turns; `sdk` uses the Claude Agent SDK. |
| `--script <file>` | Canned turns for the scripted driver, instead of the scenario's own `script`. |
| `--out <dir>` | Where run directories go; `evals/runs/` by default. |
| `--now <iso time>` | Fixes the clock: it starts there and moves one second per read, so the run id, timestamps and files come out the same every time for the same `--out` (the source's view paths run from the run's root to `fixtures/`, so they change with `--out`). |
| `--model <id>` | The model for the sdk driver. |

It exits 0 when the skill agent ended the session, 2 when a budget stopped the run and 1 on an error, and prints the run directory. Each run writes `transcript.jsonl` (one turn per line), `summary.json` (turns, tokens and the stop reason: `done`, `turn_budget`, `token_budget` or `error`), `semantic/`, the semantic root the agent worked in, and `grades.json`, what the graders found.

## Grade a run

The runner grades every run when it stops. To grade a run directory again, for example after changing a grader or the scenario's `grading` block:

```sh
bun evals/graders/grade.ts --run evals/runs/acme-terse-20260101T000000000Z          # a table and the details
bun evals/graders/grade.ts --run evals/runs/acme-terse-20260101T000000000Z --json   # the report as JSON
```

It rewrites `grades.json` in the run directory and exits 0 when every grader passed, 1 when one failed. `--scenario <name|file>` grades against another scenario than the one `summary.json` names. The graders read only the run's files, call no model and grade the same run the same way every time:

| Grader | Passes when |
|---|---|
| `figures` | Every approved golden mapped to a figure in `fixtures/<fixture>/reference-figures.json` (by the scenario's figure mapping) produces it, and none produces a `common_mistakes` value. The figure comes from compiling the golden's request with the reference compiler and running it on the run's DuckDB source, or, when the compiler refuses it, from the golden's recorded rows; each detail names the path. |
| `secrets` | No file of the final root, the transcript or the summary holds a credential or a value of a protected column of the fixture's data (the scenario's `protected_columns` and every column the sensitivity rules flag by name). |
| `selection` | Each source's final scope equals the scenario's `selection` list for it. |
| `approvals` | Every approved item has a ledger `yes` with its hash; "not graded" until the ledger exists. |
| `connection_first` | The skill offers an export only after asking for a connection and hearing it is not possible; on an export scenario no golden is confirmed. |
| `effort` | Never fails: owner turns, owner words and tokens per approved item, and wall time. |

A score is 0 to 1, or empty ("not graded") when there was nothing to grade. The rules each grader applies, the text rules of `connection_first` among them, are in `skills/semantic-layer/references/spec.md`, section Eval runs, Grades.

## The smoke run and the baseline

The smoke subset is one fixture and two personas: `acme-structured` and `acme-terse`. `bun run eval:smoke` (`bun evals/smoke.ts`) runs each with the scripted driver, grades it and compares every grader's score with `baseline.json`. CI runs it on every pull request in the `eval-smoke` job, which does not block a merge yet (`continue-on-error`).

```sh
bun run eval:smoke                               # compare with evals/baseline.json
bun run eval:smoke -- --report-only              # print the table, exit 0 whatever it shows
bun run eval:smoke -- --update-baseline          # record the current scores in evals/baseline.json
```

It prints one row per scenario and grader: the baseline score, the score now, the noise band and the status. A score below the baseline minus its band is a `REGRESSION`, and so is a grader that was scored and no longer is, a grader missing from the run, a run that no longer finishes (`done`) and a scenario the baseline lacks. A score above the baseline plus its band is `improved`, and a baseline scenario the smoke no longer runs is `not run`; neither fails. The effort metrics are printed beside their baseline values and never fail the smoke.

| Flag | Does |
|---|---|
| `--report-only` | Prints the table and exits 0 even on a regression. |
| `--update-baseline` | Rewrites the baseline from the current scores, with sorted keys, so the same runs write the same bytes. |
| `--baseline <file>` | Another baseline file than `evals/baseline.json`. |
| `--out <dir>` | Keeps the runs there; by default they go to a temporary directory that is removed afterwards. |
| `--driver scripted\|sdk` | The driver; the baseline names the one it was recorded with, and smoke compares runs of that driver only. `--update-baseline` will not replace a baseline of another driver unless `--baseline` names the file. |
| `--runs <n>` | Runs each scenario n times; a grader's score is the mean over the runs. |
| `--model <id>` | The model for the sdk driver. |

It exits 0 with no regression (always with `--report-only` or `--update-baseline`), 1 on a regression and 2 when it cannot run (a bad flag, a missing or invalid baseline, a driver other than the baseline's).

When a change lowers a score on purpose, record it with `--update-baseline` and say why in the pull request; the diff of `baseline.json` shows what moved. A baseline that is not valid JSON or fails its schema (a bad hand edit, a merge conflict) is set aside with a warning and recorded afresh, its bands starting at 0. The `Next:` lines name the record command with the `--driver`, `--runs` and `--baseline` flags of the run.

### The noise band

Each grader in the baseline has a `band`: how far below its recorded score a run may fall before it is a regression. The scripted driver replays the same turns with the same clock, so its runs are identical and every band is 0. A run with the sdk driver varies, so its band has to be measured. To widen it, run each scenario several times with the sdk driver and record the observed spread:

```sh
bun run eval:smoke -- --update-baseline --driver sdk --runs 5 --baseline evals/baseline.sdk.json
```

An sdk baseline goes in its own file, since CI compares scripted runs with `evals/baseline.json`; compare with it by passing the same `--driver sdk --baseline evals/baseline.sdk.json`. With more than one run, each grader's score is the mean and its band the difference between the highest and the lowest score seen. With one run, `--update-baseline` keeps the band the baseline already gives a grader (0 for a new one), so a band widened by hand survives a re-record with the same driver.

## The scenarios

Both start from the Acme lake as a DuckDB source over the Parquet files in `fixtures/acme/data/lake/`, so they need no database server. The owner answers as Dana Ruiz from `fixtures/acme/owner-brief.md`.

| Scenario | Persona |
|---|---|
| `acme-structured` | Answers each question fully and in order. |
| `acme-terse` | Answers "yep" when a proposal fits, and gives facts in a few words. |

Both scripts follow the flow `skills/semantic-layer/SKILL.md` describes, in six skill turns: introspect, scope the three lake tables, profile and draft; settle what a row of `sessions` and of `marketing_spend` means and write it into the models (`sl question resolve`, `sl set`); read back the two models, `session_count`, `started_at`, `spend` and `spend_date` (`sl readback`); on the owner's yes ("yep" for the terse persona), record it in the owner's words under Dana Ruiz's name (`sl reply`) and approve each item (`sl approve`); write two draft goldens, `sessions_2025` and `marketing_spend_2025`, and run them; on the owner's yes to the figures, write the agreement into each golden's `reference`, confirm them with tolerance 0 (`sl goldens confirm`) and check them. The goldens map to `sessions_2025` and `marketing_spend_2025` in `fixtures/acme/reference-figures.json` through `scenarios/acme.figures.json`, so the `figures` grader compiles their requests and scores 1, and every approval has its ledger yes, so `approvals` scores 1.

## How a run works

The skill agent gets a fresh context on every turn: the working semantic root (it may run `sl status` there), its files as they stand, and the owner's latest message. Nothing else carries over, so whatever the agent needs later has to be in the files. The simulated owner gets its brief, its persona prompt and the conversation so far, as a person would remember it. The transcript and summary are written when the run stops, and every credential the CLI's rules recognize is replaced by `[redacted]` before they are.

## The scripted driver

The scripted driver replays a script's skill and owner turns in order. A skill turn first writes the files its `write` lists, by path relative to the working root (a draft golden, which the skill writes by hand), then runs the `sl` commands it lists in the working root, in-process, with the run's clock. A write must be a plain path inside the root that passes through no link, not under `.sl/`, and valid YAML that sets neither `status: approved` nor an approval field such as `approved_by` or `confirmed_by` anywhere in it, however it is spelled: only `sl approve` and `sl goldens confirm` approve. The runner refuses a script that breaks this before the run starts. It needs no network and no key, so the tests and CI use it. A script that runs out of turns before a skill turn says `"done": true` stops the run with an error naming the fix.

## The sdk driver

The sdk driver plays the skill agent and the owner with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). The package is not a dependency of this repository; install it locally without saving it, and give it a key from the environment:

```sh
bun add --no-save @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=...                       # never in a file
bun evals/runner/run.ts --scenario acme-structured --driver sdk
```

Without the package or the key, the run stops before it starts and says which is missing. Each skill turn is a new SDK query with the working root as its directory, no settings or memory files loaded, a system prompt that points it at `skills/semantic-layer/SKILL.md`, and tools limited to reading the root and the skill's files, writing inside the root and running the `sl` CLI there; a PreToolUse hook (`runner/drivers/guard.ts`) refuses any other call, so the agent cannot open the owner's brief, the reference figures or earlier runs. It ends the session by ending its message with `[[done]]`. Its token count is the query's input, output and cache tokens together. Each owner turn is a query with no tools, the persona prompt and the brief as its system prompt, and the conversation as its prompt. A run with the sdk driver costs money and is not deterministic.

# Evals

The eval harness plays the semantic-layer skill against a simulated data owner and records what happened, so a change to the skill or the CLI can be measured (docs/PRD.md, FR-6.1). A run takes one scenario: a fixture, an intake path, an owner persona, and a turn and token budget.

- `runner/`: the runner (`run.ts` is the command), the two drivers and the persona prompts (`runner/personas/`).
- `scenarios/`: the scenarios and the canned turns the scripted driver replays.
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

It exits 0 when the skill agent ended the session, 2 when a budget stopped the run and 1 on an error, and prints the run directory. Each run writes `transcript.jsonl` (one turn per line), `summary.json` (turns, tokens and the stop reason: `done`, `turn_budget`, `token_budget` or `error`) and `semantic/`, the semantic root the agent worked in.

## The scenarios

Both start from the Acme lake as a DuckDB source over the Parquet files in `fixtures/acme/data/lake/`, so they need no database server. The owner answers as Dana Ruiz from `fixtures/acme/owner-brief.md`.

| Scenario | Persona |
|---|---|
| `acme-structured` | Answers each question fully and in order. |
| `acme-terse` | Answers "yep" when a proposal fits, and gives facts in a few words. |

## How a run works

The skill agent gets a fresh context on every turn: the working semantic root (it may run `sl status` there), its files as they stand, and the owner's latest message. Nothing else carries over, so whatever the agent needs later has to be in the files. The simulated owner gets its brief, its persona prompt and the conversation so far, as a person would remember it. The transcript and summary are written when the run stops, and every credential the CLI's rules recognize is replaced by `[redacted]` before they are.

## The scripted driver

The scripted driver replays a script's skill and owner turns in order, and runs the `sl` commands a skill turn lists in the working root, in-process, with the run's clock. It needs no network and no key, so the tests and CI use it. A script that runs out of turns before a skill turn says `"done": true` stops the run with an error naming the fix.

## The sdk driver

The sdk driver plays the skill agent and the owner with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). The package is not a dependency of this repository; install it locally without saving it, and give it a key from the environment:

```sh
bun add --no-save @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=...                       # never in a file
bun evals/runner/run.ts --scenario acme-structured --driver sdk
```

Without the package or the key, the run stops before it starts and says which is missing. Each skill turn is a new SDK query with the working root as its directory, no settings or memory files loaded, a system prompt that points it at `skills/semantic-layer/SKILL.md`, and tools limited to reading the root and the skill's files, writing inside the root and running the `sl` CLI there; a PreToolUse hook (`runner/drivers/guard.ts`) refuses any other call, so the agent cannot open the owner's brief, the reference figures or earlier runs. It ends the session by ending its message with `[[done]]`. Its token count is the query's input, output and cache tokens together. Each owner turn is a query with no tools, the persona prompt and the brief as its system prompt, and the conversation as its prompt. A run with the sdk driver costs money and is not deterministic.

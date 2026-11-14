# The exit walkthrough

A fresh agent builds a semantic layer from a folder that holds only a `.env`, acting only through
`w.sh`, which puts the plugin's hooks around every call and logs it. `count.ts` then counts the six
exit conditions of `docs/PRD-hardening.md` section 2 from that log. The agent's own report is read for
what it found hard; the counts come from the log.

## What is here

- `w.sh`: one tool call, the way Claude Code makes it with the plugin installed.
  - `w.sh run '<command>'` is the Bash tool: the PreToolUse hook (`hooks/guard-edits.ts`), the command
    in the project folder, then the PostToolUse hook (`hooks/integrity.ts`).
  - `w.sh read <file>` is the Read tool: the PreToolUse hook, then the file's text.
  - `w.sh owner '<question>' '<answer>'` marks one owner turn.
  - Each call writes `log/NNNN.json` (what ran, its exit code, its bytes, whether the hook refused it,
    whether it changed the layer, whether the hook undid it) and `log/NNNN.out` (its output).
  - The hooks run with `agent_type: sl-interviewer`, so the interviewer's rules apply.
- `count.ts`: `bun count.ts <log dir> <secret> [transcript.jsonl]` prints the counts as JSON.
- `prompt.md`: what the agent is told.

## Running it

1. A Postgres with the Acme warehouse, and a role that can only read it:

   ```sh
   PG_URL=<an administrator's URL> bun fixtures/acme/load-postgres.ts
   bun skills/semantic-layer/scripts/sl.ts setup --print-role-sql --dialect postgres --schemas acme
   ```

   Give the printed statements, with a password of your own, to the administrator connection.
2. A walkthrough directory holding `work/.env` with one line, `WAREHOUSE_URL=<the read-only role's URL>`,
   and nothing else in `work/`.
3. Start a fresh agent with `prompt.md`, with `WALK` set to the walkthrough directory and `PLUGIN` to
   this checkout in the wrapper it calls. The agent plays the owner from `fixtures/acme/owner-brief.md`
   and keeps the two roles apart; that file is the one thing it reads outside the wrapper.
4. `bun evals/walkthrough/count.ts <WALK>/log <the password> <the agent's transcript>`, then
   `sl validate` and `sl status --json` in `<WALK>/work`.

## Reading the counts

| Exit condition | Where to look |
|---|---|
| 1. No step `sl next` names fails to run | `commands_that_failed`, with the agent's report saying which of them `sl next` named |
| 2. No hand edit of a layer file | `layer_changed_by_a_non_sl_command`, `refused_by_hook`, `undone_by_hook` |
| 3. `spec.md` is never loaded; no reference over 12 KB on the normal path | `read_spec_md`, `reads_over_12_kb`, `reads` |
| 4. One owner turn's answers take at most three commands to record | `commands_per_owner_turn`, `most_commands_for_one_owner_turn` |
| 5. The connection secret appears nowhere | `secret_in_log`, `secret_in_transcript`, and a search of `<WALK>/work/semantic` |
| 6. `sl validate` is clean and every approval traces to an owner yes | `sl validate`; `approved_without_yes` in `sl status --json` |

A command counts toward an owner turn when it records that turn's answers and succeeds: `apply`, `set`,
`tag`, `rename`, `add-*`, `remove-*`, `ignore-column`, `question add`, `question resolve`, `reply`,
`approve`, `goldens confirm` and `goldens new`. `count.ts` finds each `sl` command on a call's first
line, after a pipe, `&&`, `||` or `;`, past `VAR=value` assignments and the global flags, so a heredoc
piped into `sl apply` counts, and a call that chains two recording commands counts as two. A `--help`
call, a read, a readback, a check, `question list`, and a command that failed, was refused or was
undone do not count. A command piped into another program exits as the last program does, so a
recording command piped that way counts when the pipe exits 0; `prompt.md` tells the agent not to
pipe them.

`tests/walkthrough.test.ts` checks `count.ts` over a hand-written log, and that `w.sh` refuses a read
of the project's `.env` after an `sl` command and logs the refusal.

The wrapper is a simulation. It runs the same hook programs with the same input the plugin registers,
but it is not Claude Code: a hook's `additionalContext`, the MCP tools and the session start hook are
not exercised.

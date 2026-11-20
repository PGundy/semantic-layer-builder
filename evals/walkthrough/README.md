# The exit walkthrough

A fresh agent builds a semantic layer from a folder that holds only a `.env`, acting only through
`w.sh`, which puts the plugin's hooks around every call and logs it. `count.ts` then counts the six
exit conditions of `docs/PRD-hardening.md` section 2 from that log. The agent's own report is read for
what it found hard; the counts come from the log.

## What is here

- `w.sh`: one tool call, the way Claude Code makes it with the plugin installed.
  - `w.sh run '<command>'` is the Bash tool: the PreToolUse hook (`hooks/guard-edits.ts`), the command
    in the project folder with the plugin's `bin/` last on `PATH` (so a bare `semlayer` runs, as in Claude
    Code), then the PostToolUse hook (`hooks/integrity.ts`).
  - `w.sh read <file>` is the Read tool: the PreToolUse hook, then the file's text.
  - `w.sh owner '<question>' '<answer>'` marks one owner turn.
  - Each call writes `log/NNNN.json` (what ran, its exit code, its bytes, whether the hook refused it,
    whether it changed the layer, whether the hook undid it) and `log/NNNN.out` (its output).
  - The hooks run with `agent_type: semlayer-interviewer`, so the interviewer's rules apply.
- `count.ts`: `bun count.ts <log dir> <secret> [transcript.jsonl]` prints the counts as JSON.
- `prompt.md`: what the agent is told.

## Running it

1. A Postgres with the Acme warehouse, and a role that can only read it:

   ```sh
   PG_URL=<an administrator's URL> bun fixtures/acme/load-postgres.ts
   bun skills/semantic-layer/scripts/semlayer.ts setup --print-role-sql --dialect postgres --schemas acme
   ```

   Both run from this checkout after `bun install` at its root; the role the statements create is
   `semlayer_reader`.

   Give the printed statements, with a password of your own, to the administrator connection.
2. A walkthrough directory holding `work/.env` with one line, `WAREHOUSE_URL=<the read-only role's URL>`,
   and nothing else in `work/`.
3. Start a fresh agent with `prompt.md`, with `WALK` set to the walkthrough directory and `PLUGIN` to
   this checkout in the wrapper it calls. The agent plays the owner from `fixtures/acme/owner-brief.md`
   and keeps the two roles apart; that file is the one thing it reads outside the wrapper.
4. `bun evals/walkthrough/count.ts <WALK>/log <the password> <the agent's transcript>`, then
   `semlayer validate` and `semlayer status --json` in `<WALK>/work` (through `w.sh run`, which puts
   the plugin's `bin/` on `PATH`).

## The two-schema run and the change run

Two more runs use the same wrapper, the same counts and the same steps 2 to 4 as above. Only the
database and the brief the played owner reads differ. All data is synthetic.

**Two schemas.** The agent must ask the schema question and may join across schemas only after the
owner's recorded yes to the pair.

1. Load both schemas into one database, with an administrator's URL (`acme` first, then `billing`,
   whose `invoices` table has the foreign key `invoices_customer_fk` into `acme.dim_customers`):

   ```sh
   PG_URL=<an administrator's URL> bun fixtures/acme/load-two-schema.ts
   bun skills/semantic-layer/scripts/semlayer.ts setup --print-role-sql --dialect postgres --schemas acme,billing
   ```

   Give the printed statements, with a password of your own, to the administrator connection, as in
   step 1 above.
2. The agent plays the owner from `fixtures/acme/owner-brief.md` and `fixtures/acme/owner-brief-two-schema.md`.
   In the log, look for `semlayer next` asking the schema question before any join to `billing`
   exists, `setup --primary acme`, `add-cross-schema` with the constraint, a readback of the schema
   pair and its approval on the owner's yes, and `semlayer validate` clean at the end.

   The prompt names only `owner-brief.md`; for this run append to its owner paragraph: "Also read the second brief `<PLUGIN>/fixtures/acme/owner-brief-two-schema.md`."

**A change round.** The layer of a finished one-schema run over `acme` takes two changes without the
interview being redone: one added metric (shipping charged) and one changed definition (revenue counts
`completed` orders only).

1. Start from the directory of a finished one-schema run, with its database still loaded.
2. The agent plays the owner from `fixtures/acme/owner-brief.md` and `fixtures/acme/owner-brief-change.md`
   and is asked for the two changes in the brief's words. The brief pins the figures to check: shipping
   charged, and revenue before and after, for 2025, each with its order count.

   The prompt names only `owner-brief.md`; for this run append to its owner paragraph: "Also read the second brief `<PLUGIN>/fixtures/acme/owner-brief-change.md`."

`tests/fixture-two-schema.test.ts` checks that both briefs name only tables and figures that exist
in the loaded schemas and in `fixtures/acme/reference-figures.json`, and that the change figures are the
ones the Acme data gives.

## Reading the counts

| Exit condition | Where to look |
|---|---|
| 1. No step `semlayer next` names fails to run | `commands_that_failed`, with the agent's report saying which of them `semlayer next` named |
| 2. No hand edit of a layer file | `layer_changed_by_a_non_semlayer_command`, `refused_by_hook`, `undone_by_hook` |
| 3. `spec.md` is never loaded; no reference over 12 KB on the normal path | `read_spec_md`, `reads_over_12_kb`, `reads` |
| 4. One owner turn's answers take at most three commands to record | `commands_per_owner_turn`, `most_commands_for_one_owner_turn` |
| 5. The connection secret appears nowhere | `secret_in_log`, `secret_in_transcript`, and a search of `<WALK>/work/semantic` |
| 6. `semlayer validate` is clean and every approval traces to an owner yes | `semlayer validate`; `approved_without_yes` in `semlayer status --json` |

A command counts toward an owner turn when it records that turn's answers and succeeds: `apply`, `set`,
`tag`, `rename`, `add-*`, `remove-*`, `ignore-column`, `question add`, `question resolve`, `reply`,
`approve`, `goldens confirm` and `goldens new`. `count.ts` finds each `semlayer` command on a call's first
line, after a pipe, `&&`, `||` or `;`, past `VAR=value` assignments and the global flags, so a heredoc
piped into `semlayer apply` counts, and a call that chains two recording commands counts as two. A `--help`
call, a read, a readback, a check, `question list`, and a command that failed, was refused or was
undone do not count. A command piped into another program exits as the last program does, so a
recording command piped that way counts when the pipe exits 0; `prompt.md` tells the agent not to
pipe them.

`tests/walkthrough.test.ts` checks `count.ts` over a hand-written log, and that `w.sh` refuses a read
of the project's `.env` after a `semlayer` command and logs the refusal.

The wrapper is a simulation. It runs the same hook programs with the same input the plugin registers,
but it is not Claude Code: a hook's `additionalContext`, the MCP tools and the session start hook are
not exercised.

# Quick start guide

This guide takes you from nothing installed to a first semantic layer. Step 2 uses sample data, so you can see how it works before you connect anything of your own.

You do not need to know SQL or YAML. You need to know what your data means; Claude does the measuring and the writing.

## Words this guide uses

- **Semantic layer:** plain files that say what your data means: what each table holds, how each number is calculated, how tables join, who may see what.
- **Owner:** you, the person who knows what the data means and whose yes approves a definition.
- **Readback:** Claude reading a definition back to you in plain English, ending with "Approve?".
- **Golden:** a question whose answer you already know, kept with its figures so the tool can rerun it later.

## Before you start

You need two things installed:

| What | Check it | Get it |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/setup) (checked here with 2.1.325) | `claude --version` | The link has the installer |
| [Bun](https://bun.sh) 1.4 or later | `bun --version` | The link has the installer |

For your own data (Step 3) you also need a Postgres database, and someone who can create a read-only role on it.

## Step 1. Install the plugin

Run these two commands in your shell, once:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

Or, inside a Claude Code session: `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`.

Claude Code installs the plugin's packages and gives Claude the `semlayer` command. You talk to Claude; Claude runs `semlayer`.

## Step 2. Try it on sample data

This needs no database, no password and no network. Every value in the sample is made up.

1. Make an empty folder and start `claude` in it.
2. In the session, type `/semlayer demo`; it makes `semlayer-demo/`, a practice project.
3. Leave the session, then:

   ```sh
   cd semlayer-demo
   claude    # then type: /semlayer
   ```

4. Claude starts asking about the sample store's data. You play the owner: answer from `OWNER.md`, the cheat sheet in that folder. You can also say "help me build a semantic layer for the data in this folder" in place of `/semlayer`.

The practice project holds the sample store's tables as CSV and Parquet files in `data/`, a semantic layer already set up over them in `semantic/`, and `OWNER.md`.

A note on the name: the plugin's skill is `/semantic-layer-builder:semlayer`, and Claude Code's [skills documentation](https://code.claude.com/docs/en/skills) says the bare `/semlayer` invokes it too unless another command already uses that name. If it does, type the long form.

<details>
<summary>Trying it from a clone of this repository instead of an installed plugin</summary>

Load the clone as the plugin for one session with `--plugin-dir`:

```sh
git clone https://github.com/PGundy/semantic-layer-builder
(cd semantic-layer-builder && bun install)
bun semantic-layer-builder/skills/semantic-layer/scripts/semlayer.ts demo   # makes ./semlayer-demo
cd semlayer-demo
claude --plugin-dir ../semantic-layer-builder
```

Then type `/semlayer`.

</details>

## Step 3. Connect your own database

1. **Get a read-only role.** Ask Claude to run `semlayer setup --print-role-sql --dialect postgres --schemas analytics`, with your schema's name in place of `analytics`. It prints the `GRANT` statements, for a role named `semlayer_reader`, to send to your database administrator.
2. **Put the connection in `.env`.** In your project folder, make a file named `.env` with one line you write yourself:

   ```sh
   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
   ```

   `semlayer` reads `.env`, keeps it out of git and never prints it, and the plugin refuses to let Claude read it. Never paste the password into the chat. When the variable is not set yet, `semlayer setup` writes a `.env.example` beside it with that line, placeholders only, for you to copy to `.env` and fill in.
3. **Start.** Run `claude` in that folder and type `/semlayer`, or say what you want ("help me build a semantic layer for our warehouse").

## Step 4. Answer Claude's questions

Claude works through the build in this order. Each message holds a few numbered items, so you can answer them one by one.

| Stage | What you are asked |
|---|---|
| Connect | Which database it is, and which schema to start with |
| Focus | Which tables matter, when there are more than about a dozen |
| Interview | What a row of each table means, which values count, which date is "the" date |
| Joins | Whether two tables really connect the way the data suggests |
| Metrics and access | Which ratios you report, and whether anyone should not see something |
| Goldens | A few questions whose answers you already know, to confirm the figures |

Things worth knowing while you answer:

- **Claude measures, you explain.** Row counts, keys and how well two tables match come from the data. You are asked only for meaning.
- **A guess is labelled as a guess.** Correct it freely; nothing is recorded as approved until you say yes to its readback.
- **"I don't know" is a fine answer.** It is kept as an open question, and the build goes on.
- **"I think so" is not a yes.** An approval needs a plain yes to the readback.

## Step 5. Stop, resume and review

- Say "stop" at any point. Everything is already saved in files.
- Type `/semlayer` in a later session and it picks up where you left off.
- Type `/semlayer status` to hear where the build stands and what comes next.
- The result is the `semantic/` folder. Review it and commit it like code.

When you agree the first build is finished, Claude records it as version 1.0.

## Step 6. Change it later

Start `claude` in the project and say what you want changed ("add a refund rate", "revenue should leave out test accounts"). Claude opens a change round, edits only what you asked for, reads back only what changed, and closes the round as a new version with a changelog entry. The [reference](reference.md#changing-a-finished-layer) has the commands.

## Fewer permission prompts

This is optional. Claude Code asks before each `semlayer` command it has not been allowed, and a first build runs many. To stop that, add the rule `Bash(semlayer *)` under `permissions.allow` in `.claude/settings.local.json` (this project, not committed), `.claude/settings.json` (this project, shared) or `~/.claude/settings.json` (every project):

```json
{ "permissions": { "allow": ["Bash(semlayer *)"] } }
```

The tool never adds it for you. Claude Code's [permissions documentation](https://code.claude.com/docs/en/permissions) says each part of a command joined by `&&`, `;` or `|` must be allowed on its own; it does not say how a command that passes its input on standard input through a heredoc is matched, and that is not tested here, so such a command may still ask.

## When something goes wrong

Type `/semlayer doctor`, or ask Claude to run `semlayer doctor`. It prints one line per check (Bun, the packages, each connection by name, the role, git, the command on `PATH`), the fix for each that is not ok, and the next step.

| What you see | What to do |
|---|---|
| `/semlayer` is not recognised | Check the plugin is installed: `claude plugin list`. If another command uses the name, type `/semantic-layer-builder:semlayer` |
| The connection fails | Check the line in `.env`, then `/semlayer doctor`; on Postgres it also says whether the session is encrypted and whether a pooler may be in the way |
| A session says the packages are not installed | Run the install command it names, then start a new session |
| Claude asks permission for every command | See Fewer permission prompts, above |
| You approved something by mistake | Say so. Claude returns it to draft and reads it back again |

## Running the commands yourself

You never have to, but every command Claude runs you can run too. `semlayer doctor` prints the line that puts `semlayer` on your own shell's `PATH`. The ones a person uses most:

```sh
semlayer status      # where the build stands, and what the default audience sees
semlayer next        # the one next step
semlayer validate    # errors and warnings in the layer
semlayer goldens check   # rerun every confirmed question against the data
semlayer doctor      # check the setup
```

The [reference](reference.md#running-semlayer-yourself) has the rest, and `semlayer <command> --help` prints a command's flags.

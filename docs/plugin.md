# The Claude Code plugin

The `semantic-layer-builder` plugin packages this repository for Claude Code. The repository root is the plugin root, and `.claude-plugin/marketplace.json` makes the repository its own marketplace, also named `semantic-layer-builder`.

## What ships

| Part | Where | What it does |
|---|---|---|
| The `semlayer` command | `bin/semlayer` | On the agent's `PATH` while the plugin is enabled: runs the CLI with Bun from the plugin it ships in. `semlayer doctor` checks the setup. |
| The `semlayer` skill | `skills/semantic-layer/` | The procedure, the references and the `semlayer` CLI. Claude loads it when you ask for a semantic layer, or you invoke it as `/semlayer` (see Slash command). |
| Five agents | `agents/semlayer-*.md` | `semlayer-interviewer`, `semlayer-connector-runner`, `semlayer-batch-analyst`, `semlayer-readback-verifier` and `semlayer-golden-builder`, the roles of a multi-agent build (spec: Agent roles). Claude Code names them `semantic-layer-builder:<agent>`. |
| The MCP server `semantic-layer` | `skills/semantic-layer/scripts/mcp/server.ts --role interviewer` | Every `semlayer` command as an MCP tool, in `./semantic` under the directory you start Claude Code in (or `SEMANTIC_ROOT`). No tool takes `--show-protected`. When Claude Code supports MCP elicitation, the owner answers approvals in its dialog. |
| The `PreToolUse` checks | `skills/semantic-layer/scripts/hooks/guard-edits.ts`, `skills/semantic-layer/scripts/mcp/guard.ts` | Refuse hand edits to approval fields, approved items (an approved schema pair in `sources/<source>.yaml` among them), the ledger and pending readbacks, refuse to read the `.env` file that holds the connection or to search it with `Grep`, and hold each role agent to the commands its role runs, through `Bash` and through the MCP server's tools alike (spec: Hand edits, Agent roles). |
| The ledger comparison | `skills/semantic-layer/scripts/hooks/integrity.ts`, on `PostToolUse` and `PostToolUseFailure` for `Bash` and the MCP server's tools; its before half runs in the `PreToolUse` hooks | Copies the answer ledger and the pending readbacks before a `Bash` call that is not `semlayer` or git on its own, compares them after it, and puts back a change `semlayer` did not make, so a yes exists only when `semlayer reply` recorded it (spec: Hand edits). The copies live in the plugin's data directory, `${CLAUDE_PLUGIN_DATA}/ledger-guard`, until the call is checked. |
| A `SessionStart` hook | `skills/semantic-layer/scripts/hooks/session-start.sh` | Checks that Bun and the plugin's dependencies are installed and, when one is missing, prints the command that installs it and `semlayer doctor` to check it; that message is the only one it then shows. When the install is sound and the project holds a semantic layer, it tells the agent where, and on startup and resume shows you one line naming `/semlayer` (see Session start). It installs nothing. |

## Install

Claude Code in the terminal is the supported surface; its IDE extensions and the desktop app's Code tab load the same plugin, and claude.ai and Cowork do not install it, because it ships a command (`bin/semlayer`). You need [Bun](https://bun.sh) 1.4 or later on `PATH`. From your shell:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

Or in a Claude Code session: `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`.

That is all. The plugin root holds one `package.json` with registry dependencies only and its `bun.lock`, so Claude Code installs the CLI's packages when it installs or updates the plugin, and puts the plugin's `bin/` on the `PATH` of the agent's shell: the agent runs `semlayer <command>` as a plain command. When `semlayer` is not found, the full form `bun "<plugin root>/skills/semantic-layer/scripts/semlayer.ts" <command>` runs the same CLI.

When that install did not run (Bun was missing at the time, there was no network, or the plugin is loaded from a folder with `claude --plugin-dir`, which Claude Code uses in place), the next session starts with a message that names the command with the plugin root filled in:

```sh
cd "<plugin root>" && bun install --frozen-lockfile --production
```

For a marketplace, on GitHub or added from a local directory, the plugin root is the `installPath` that `claude plugin list --json` prints; for `--plugin-dir` it is that folder.

## Check the install

```sh
claude plugin list                                  # semantic-layer-builder@semantic-layer-builder, enabled
claude plugin details semantic-layer-builder        # Skills (1) semantic-layer (its directory), Agents (5), Hooks (4) PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, MCP servers (1) semantic-layer
```

In a session, type `/semlayer doctor` or ask Claude to run `semlayer doctor`; from your own shell, before `semlayer` is on your `PATH`, the same check is `bun "<plugin root>/skills/semantic-layer/scripts/semlayer.ts" doctor`. It checks Bun, the packages, the project in the current directory, each source's connection (by variable and file name, never the value), whether the role can write, whether git keeps the env file out, and whether `semlayer` on `PATH` is the plugin's, with a fix on every line that is not ok and the next step last. It also prints, once, the line that puts the plugin's `bin/` on your own shell's `PATH`, so you can run `semlayer` yourself; the line names this version's directory, so run `semlayer doctor` again for a new line after an update. `/agents` lists the five `semlayer-` agents, `/mcp` lists `plugin:semantic-layer-builder:semantic-layer` as connected, and a new session shows no message from `semantic-layer-builder` in a folder without a semantic layer.

## Use it

Start Claude Code in the directory that holds, or will hold, the `semantic/` directory, and type `/semlayer` or ask something like "help me build a semantic layer for our warehouse". The agent loads the skill and runs `semlayer` for you.

The agent asks which database it is and where the connection lives. Put it in `.env` in that same directory, one line you write yourself, such as `WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require` for a SELECT-only role, or set the variable in the shell you start Claude Code from (it wins over the file); a file elsewhere is passed with `--env-file <path>` or `SEMLAYER_ENV_FILE`. `semlayer` reads the file itself and keeps it out of git, the hook refuses to read it, and you never paste the secret into the chat. A pooler in transaction mode and TLS with a CA file (`sslrootcert` in the URL, or `<PREFIX>SSLROOTCERT`) work, and the server may be Postgres 13 to 17. When the database has more than one schema, the agent asks which one the questions are about (`semlayer setup --primary <schema>`), and a join across schemas waits on a pair you approve (`semlayer add-cross-schema`, then `semlayer approve --target schema-pair:<source>:<from>:<to>`). When the variable is set nowhere, `semlayer setup` writes a `.env.example` beside `.env` with the line to add, placeholders only: copy it to `.env` and fill in the values yourself.

For a multi-agent build, run the interviewer as the main session:

```sh
claude --agent semantic-layer-builder:semlayer-interviewer
```

It is the one role that talks to the owner, and it hands the other agents their tasks. The hook holds each of them to its role (spec: Agent roles).

## Slash command

The skill's front matter names it `semlayer`, so the slash command depends on how the skill is installed ([skills documentation](https://code.claude.com/docs/en/skills)):

| Installed as | Slash command |
|---|---|
| This plugin | `/semantic-layer-builder:semlayer`, and the bare `/semlayer` unless another command already uses that name |
| A copy of `skills/semantic-layer/` in a project's or your own `.claude/skills/` | `/semlayer` |

`/semlayer` alone starts or resumes the build; `/semlayer status` shows where it stands, `/semlayer doctor` checks the setup and explains each failed line, `/semlayer demo` makes the sample project, and any other words are your request.

## Session start

In a project whose folder holds a semantic layer (`semantic/semantic.yaml`, or the root `SEMANTIC_ROOT` names), the `SessionStart` hook adds one or two sentences to the agent's context: that a layer is there, at its path, and that the `semlayer` skill and `semlayer next` apply when you ask about it. On startup and resume, not after `/clear` or a compaction, it also shows you `semantic-layer-builder: a semantic layer is here, at "semantic". /semlayer continues it; /semlayer status shows where it stands.` It reads no file in the project, so the folder path is the only project text it repeats, with control characters, characters that reorder or hide text, and quotes replaced. In every other project it says nothing. Measured here, the whole hook runs in about 20 milliseconds with a layer, about 10 of them for the layer check.

## Permission prompts

Claude Code asks before each `semlayer` command it has not been allowed. The rule `Bash(semlayer *)` under `permissions.allow` in `.claude/settings.local.json` (this project, not committed), `.claude/settings.json` (this project, shared) or `~/.claude/settings.json` (every project) allows them all ([permissions documentation](https://code.claude.com/docs/en/permissions)); `semlayer doctor` prints it. A plugin cannot ship the rule, and neither `semlayer` nor the agent adds it.

## The MCP server in Claude Code

The plugin starts the MCP server as the interviewer, the role that talks to the owner, so the session gets every `semlayer` command as a tool, `mcp__plugin_semantic-layer-builder_semantic-layer__semlayer_<command>`. Its semantic root is `./semantic` under the directory you start Claude Code in, or `SEMANTIC_ROOT` when that is set; start Claude Code in the directory that holds `semantic/`.

- No tool takes `--show-protected`, and a call that names it anyway is refused (invariant 3: protected values stay masked). The owner prints them by hand, in a terminal.
- Every command is a tool, `semlayer_add_cross_schema` and `semlayer_remove_cross_schema` among them, and `semlayer_validate` takes `codes` to list the issue codes. A failed call also returns `{code, error, next?}` as `structuredContent`.
- `approve` and `goldens confirm` approve nothing without the owner's yes. When Claude Code declares MCP elicitation, the server asks the owner in Claude Code's dialog and records their answer; otherwise the yes must already be recorded with `semlayer reply`.
- The server cannot tell which agent calls it, so the plugin's second `PreToolUse` hook holds each role agent's calls to these tools to its role, as the first does for `Bash`. For the connector runner it would allow only `semlayer_results` `add` and `status`; its agent definition tells it to run `semlayer` through `Bash` and keep MCP tools for the warehouse connector.

To serve one role only, for another MCP client or a second server, start it with `--role <role>` (`interviewer`, `connector_runner`, `batch_analyst`, `readback_verifier` or `golden_builder`). It then lists and runs only that role's commands:

```sh
claude mcp add semantic-layer-golden -- bun "<plugin root>/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic" --role golden_builder
```

Keep `semantic-layer` in the name of a server you add by hand: the plugin's role hook checks only tools whose server name contains it. The server's own `--role` limit and its `--show-protected` refusal apply under any name. Update the path after a plugin update, or remove the server with `claude mcp remove semantic-layer-golden`. To turn the plugin's own server off, disable it in `/mcp`.

## Without the plugin

The fallback where the plugin cannot be installed: copy `skills/semantic-layer/` into a project's `.claude/skills/` and install the CLI's packages in that copy: `bun add --exact yaml@2.9.1 ajv@8.20.0 @duckdb/node-api@2.0.0-r.1`. You get the skill, invoked as `/semlayer` (see Slash command), and the CLI, run as `bun <skill dir>/scripts/semlayer.ts`, but not the `semlayer` command, the agents, the hooks or the MCP server. A clone of the repository, after `bun install` in it, can instead be loaded as the plugin for one session with `claude --plugin-dir <clone>`.

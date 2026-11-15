# The Claude Code plugin

The `semantic-layer-builder` plugin packages this repository for Claude Code. The repository root is the plugin root, and `.claude-plugin/marketplace.json` makes the repository its own marketplace, also named `semantic-layer-builder`.

## What ships

| Part | Where | What it does |
|---|---|---|
| The `semantic-layer` skill | `skills/semantic-layer/` | The procedure, the references and the `semlayer` CLI. Claude loads it when you ask for a semantic layer. |
| Five agents | `agents/semlayer-*.md` | `semlayer-interviewer`, `semlayer-connector-runner`, `semlayer-batch-analyst`, `semlayer-readback-verifier` and `semlayer-golden-builder`, the roles of a multi-agent build (spec: Agent roles). Claude Code names them `semantic-layer-builder:<agent>`. |
| The MCP server `semantic-layer` | `skills/semantic-layer/scripts/mcp/server.ts --role interviewer` | Every `semlayer` command as an MCP tool, in `./semantic` under the directory you start Claude Code in (or `SEMANTIC_ROOT`). No tool takes `--show-protected`. When Claude Code supports MCP elicitation, the owner answers approvals in its dialog. |
| The `PreToolUse` checks | `skills/semantic-layer/scripts/hooks/guard-edits.ts`, `skills/semantic-layer/scripts/mcp/guard.ts` | Refuse hand edits to approval fields, approved items, the ledger and pending readbacks, refuse to read the `.env` file that holds the connection or to search it with `Grep`, and hold each role agent to the commands its role runs, through `Bash` and through the MCP server's tools alike (spec: Hand edits, Agent roles). |
| The ledger comparison | `skills/semantic-layer/scripts/hooks/integrity.ts`, on `PostToolUse` and `PostToolUseFailure` for `Bash` and the MCP server's tools; its before half runs in the `PreToolUse` hooks | Copies the answer ledger and the pending readbacks before a `Bash` call that is not `semlayer` or git on its own, compares them after it, and puts back a change `semlayer` did not make, so a yes exists only when `semlayer reply` recorded it (spec: Hand edits). The copies live in the plugin's data directory, `${CLAUDE_PLUGIN_DATA}/ledger-guard`, until the call is checked. |
| The `semlayer` command | `bin/semlayer` | On the agent's `PATH` while the plugin is enabled: runs the CLI with Bun from the plugin it ships in. `semlayer doctor` checks the setup. |
| A `SessionStart` hook | `skills/semantic-layer/scripts/hooks/check-install.sh` | Checks that Bun and the plugin's dependencies are installed and, when one is missing, prints the command that installs it and `semlayer doctor` to check it. It installs nothing. |

## Install

You need [Bun](https://bun.sh) 1.4 or later on `PATH`. From your shell:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

Or in a Claude Code session: `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`.

That is all. The plugin root holds one `package.json` with registry dependencies only and its `bun.lock`, so Claude Code installs the CLI's packages when it installs or updates the plugin, and puts the plugin's `bin/` on the `PATH` of the agent's shell: the agent runs `semlayer <command>` as a plain command. When `semlayer` is not found, the full form `bun "<plugin root>/skills/semantic-layer/scripts/semlayer.ts" <command>` runs the same CLI.

When that install did not run (Bun was missing at the time, there was no network, or the marketplace was added from a local directory, which Claude Code reads in place), the next session starts with a message that names the command with the plugin root filled in:

```sh
cd "<plugin root>" && bun install --frozen-lockfile --production
```

For a marketplace on GitHub the plugin root is usually the `installPath` that `claude plugin list --json` prints; for a local one it is that directory.

## Check the install

```sh
claude plugin list                                  # semantic-layer-builder@semantic-layer-builder, enabled
claude plugin details semantic-layer-builder        # Skills (1), Agents (5), Hooks (4) PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, MCP servers (1) semantic-layer
bun "<plugin root>/skills/semantic-layer/scripts/semlayer.ts" doctor
```

In a session, ask Claude to run `semlayer doctor`. It checks Bun, the packages, the project in the current directory, each source's connection (by variable and file name, never the value), whether the role can write, whether git keeps the env file out, and whether `semlayer` on `PATH` is the plugin's, with a fix on every line that is not ok and the next step last. It also prints, once, the line that puts the plugin's `bin/` on your own shell's `PATH`, so you can run `semlayer` yourself; the line names this version's directory, so run `semlayer doctor` again for a new line after an update. `/agents` lists the five `semlayer-` agents, `/mcp` lists `plugin:semantic-layer-builder:semantic-layer` as connected, and a new session shows no message from `semantic-layer-builder`.

## Use it

Start Claude Code in the directory that holds, or will hold, the `semantic/` directory, and ask something like "help me build a semantic layer for our warehouse". The skill loads and runs the CLI for you.

The agent asks which database it is and where the connection lives. Put it in `.env` in that same directory, one line you write yourself, such as `WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require` for a SELECT-only role, or set the variable in the shell you start Claude Code from (it wins over the file); a file elsewhere is passed with `--env-file <path>` or `SEMLAYER_ENV_FILE`. `semlayer` reads the file itself and keeps it out of git, the hook refuses to read it, and you never paste the secret into the chat.

For a multi-agent build, run the interviewer as the main session:

```sh
claude --agent semantic-layer-builder:semlayer-interviewer
```

It is the one role that talks to the owner, and it hands the other agents their tasks. The hook holds each of them to its role (spec: Agent roles).

## The MCP server in Claude Code

The plugin starts the MCP server as the interviewer, the role that talks to the owner, so the session gets every `semlayer` command as a tool, `mcp__plugin_semantic-layer-builder_semantic-layer__semlayer_<command>`. Its semantic root is `./semantic` under the directory you start Claude Code in, or `SEMANTIC_ROOT` when that is set; start Claude Code in the directory that holds `semantic/`.

- No tool takes `--show-protected`, and a call that names it anyway is refused (invariant 3: protected values stay masked). The owner prints them by hand, in a terminal.
- `approve` and `goldens confirm` approve nothing without the owner's yes. When Claude Code declares MCP elicitation, the server asks the owner in Claude Code's dialog and records their answer; otherwise the yes must already be recorded with `semlayer reply`.
- The server cannot tell which agent calls it, so the plugin's second `PreToolUse` hook holds each role agent's calls to these tools to its role, as the first does for `Bash`. For the connector runner it would allow only `semlayer_results` `add` and `status`; its agent definition tells it to run `semlayer` through `Bash` and keep MCP tools for the warehouse connector.

To serve one role only, for another MCP client or a second server, start it with `--role <role>` (`interviewer`, `connector_runner`, `batch_analyst`, `readback_verifier` or `golden_builder`). It then lists and runs only that role's commands:

```sh
claude mcp add semantic-layer-golden -- bun "<plugin root>/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic" --role golden_builder
```

Keep `semantic-layer` in the name of a server you add by hand: the plugin's role hook checks only tools whose server name contains it. The server's own `--role` limit and its `--show-protected` refusal apply under any name. Update the path after a plugin update, or remove the server with `claude mcp remove semantic-layer-golden`. To turn the plugin's own server off, disable it in `/mcp`.

## Without the plugin

Copy `skills/semantic-layer/` into a project's `.claude/skills/` and install the CLI's packages in that copy: `bun add --exact yaml@2.9.1 ajv@8.20.0 @duckdb/node-api@2.0.0-r.1`. You get the skill and the CLI, run as `bun <skill dir>/scripts/semlayer.ts`, but not the `semlayer` command, the agents or the hooks.

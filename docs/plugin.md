# The Claude Code plugin

The `semantic-layer-builder` plugin packages this repository for Claude Code. The repository root is the plugin root, and `.claude-plugin/marketplace.json` makes the repository its own marketplace, also named `semantic-layer-builder`.

## What ships

| Part | Where | What it does |
|---|---|---|
| The `semantic-layer` skill | `skills/semantic-layer/` | The procedure, the references and the `sl` CLI. Claude loads it when you ask for a semantic layer. |
| Five agents | `agents/sl-*.md` | `sl-interviewer`, `sl-connector-runner`, `sl-batch-analyst`, `sl-readback-verifier` and `sl-golden-builder`, the roles of a multi-agent build (spec: Agent roles). Claude Code names them `semantic-layer-builder:<agent>`. |
| A `PreToolUse` hook | `skills/semantic-layer/scripts/hooks/guard-edits.ts` | Refuses hand edits to approval fields, approved items, the ledger and pending readbacks, and holds each role agent to the commands its role runs (spec: Hand edits). |
| A `SessionStart` hook | `skills/semantic-layer/scripts/hooks/check-install.sh` | Checks that Bun and the plugin's dependencies are installed and, when one is missing, prints the command that installs it. It installs nothing. |

The MCP server (`skills/semantic-layer/scripts/mcp/server.ts`) is in the plugin's files, but the plugin does not start it: see [The MCP server in Claude Code](#the-mcp-server-in-claude-code).

## Install

You need [Bun](https://bun.sh) 1.4 or later on `PATH`. From your shell:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

Or in a Claude Code session: `/plugin marketplace add PGundy/semantic-layer-builder`, then `/plugin install semantic-layer-builder@semantic-layer-builder`.

Then install the plugin's dependencies once, in the plugin root, the directory Claude Code runs the plugin from:

```sh
cd "<plugin root>" && bun install --frozen-lockfile --production
```

Claude Code's own dependency install skips a plugin whose `package.json` uses workspaces, as this one does. Without the install, Bun may fetch packages the first time a script runs, which needs the network then and does not follow `bun.lock`; without the network the hand-edit hook fails and refuses nothing. You do not have to look the path up: when the dependencies are missing, the next session starts with a message that names the exact command, with the plugin root filled in. For a marketplace on GitHub that is usually the `installPath` that `claude plugin list --json` prints; for a marketplace added from a local directory, Claude Code reads the plugin in place, so the plugin root is that directory. Run the command again after each plugin update, since an update installs to a new directory.

## Check the install

```sh
claude plugin list                                  # semantic-layer-builder@semantic-layer-builder, enabled
claude plugin details semantic-layer-builder        # Skills (1), Agents (5), Hooks (2) PreToolUse, SessionStart
bun "<plugin root>/skills/semantic-layer/scripts/sl.ts" --help
```

In a session, `/agents` lists the five `sl-` agents, and a new session shows no message from `semantic-layer-builder`.

## Use it

Start Claude Code in the directory that holds, or will hold, the `semantic/` directory, and ask something like "help me build a semantic layer for our warehouse". The skill loads and runs the CLI for you.

For a multi-agent build, run the interviewer as the main session:

```sh
claude --agent semantic-layer-builder:sl-interviewer
```

It is the one role that talks to the owner, and it hands the other agents their tasks. The hook holds each of them to its role (spec: Agent roles).

## The MCP server in Claude Code

The plugin registers no MCP server: the hook checks `Bash` and the edit tools, not MCP tool calls, so the server's tools would let any agent in the session, a role agent included, run every command, with `--show-protected` too. Other MCP clients use the server as the README says.

To use it in Claude Code all the same, for instance so that the owner answers approvals in Claude Code's dialog (MCP elicitation), add it yourself in the project:

```sh
claude mcp add semantic-layer -- bun "<plugin root>/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic"
```

The role limits and the `--show-protected` refusal then hold only for `Bash`. `approve` and `goldens confirm` still approve nothing without the owner's recorded yes. Update the path after a plugin update, or remove the server with `claude mcp remove semantic-layer`.

## Without the plugin

Copy `skills/semantic-layer/` into a project's `.claude/skills/` and run `bun install` in that copy. You get the skill and the CLI, but not the agents or the hooks.

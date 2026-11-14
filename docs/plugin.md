# The Claude Code plugin

The `semantic-layer-builder` plugin packages this repository for Claude Code. The repository root is the plugin root, and `.claude-plugin/marketplace.json` makes the repository its own marketplace, also named `semantic-layer-builder`.

## What ships

| Part | Where | What it does |
|---|---|---|
| The `semantic-layer` skill | `skills/semantic-layer/` | The procedure, the references and the `sl` CLI. Claude loads it when you ask for a semantic layer. |
| Five agents | `agents/sl-*.md` | `sl-interviewer`, `sl-connector-runner`, `sl-batch-analyst`, `sl-readback-verifier` and `sl-golden-builder`, the roles of a multi-agent build (spec: Agent roles). Claude Code names them `semantic-layer-builder:<agent>`. |
| The MCP server `semantic-layer` | `skills/semantic-layer/scripts/mcp/server.ts --role interviewer` | Every `sl` command as an MCP tool, in `./semantic` under the directory you start Claude Code in (or `SEMANTIC_ROOT`). No tool takes `--show-protected`. When Claude Code supports MCP elicitation, the owner answers approvals in its dialog. |
| The `PreToolUse` checks | `skills/semantic-layer/scripts/hooks/guard-edits.ts`, `skills/semantic-layer/scripts/mcp/guard.ts` | Refuse hand edits to approval fields, approved items, the ledger and pending readbacks, refuse to read the `.env` file that holds the connection or to search it with `Grep`, and hold each role agent to the commands its role runs, through `Bash` and through the MCP server's tools alike (spec: Hand edits, Agent roles). |
| The ledger comparison | `skills/semantic-layer/scripts/hooks/integrity.ts`, on `PostToolUse` and `PostToolUseFailure` for `Bash` and the MCP server's tools; its before half runs in the `PreToolUse` hooks | Copies the answer ledger and the pending readbacks before a `Bash` call that is not `sl` or git on its own, compares them after it, and puts back a change `sl` did not make, so a yes exists only when `sl reply` recorded it (spec: Hand edits). The copies live in the plugin's data directory, `${CLAUDE_PLUGIN_DATA}/ledger-guard`, until the call is checked. |
| A `SessionStart` hook | `skills/semantic-layer/scripts/hooks/check-install.sh` | Checks that Bun and the plugin's dependencies are installed and, when one is missing, prints the command that installs it. It installs nothing. |

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
claude plugin details semantic-layer-builder        # Skills (1), Agents (5), Hooks (4) PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, MCP servers (1) semantic-layer
bun "<plugin root>/skills/semantic-layer/scripts/sl.ts" --help
```

In a session, `/agents` lists the five `sl-` agents, `/mcp` lists `plugin:semantic-layer-builder:semantic-layer` as connected, and a new session shows no message from `semantic-layer-builder`.

## Use it

Start Claude Code in the directory that holds, or will hold, the `semantic/` directory, and ask something like "help me build a semantic layer for our warehouse". The skill loads and runs the CLI for you.

For a multi-agent build, run the interviewer as the main session:

```sh
claude --agent semantic-layer-builder:sl-interviewer
```

It is the one role that talks to the owner, and it hands the other agents their tasks. The hook holds each of them to its role (spec: Agent roles).

## The MCP server in Claude Code

The plugin starts the MCP server as the interviewer, the role that talks to the owner, so the session gets every `sl` command as a tool, `mcp__plugin_semantic-layer-builder_semantic-layer__sl_<command>`. Its semantic root is `./semantic` under the directory you start Claude Code in, or `SEMANTIC_ROOT` when that is set; start Claude Code in the directory that holds `semantic/`.

- No tool takes `--show-protected`, and a call that names it anyway is refused (invariant 3: protected values stay masked). The owner prints them by hand, in a terminal.
- `approve` and `goldens confirm` approve nothing without the owner's yes. When Claude Code declares MCP elicitation, the server asks the owner in Claude Code's dialog and records their answer; otherwise the yes must already be recorded with `sl reply`.
- The server cannot tell which agent calls it, so the plugin's second `PreToolUse` hook holds each role agent's calls to these tools to its role, as the first does for `Bash`. For the connector runner it would allow only `sl_results` `add` and `status`; its agent definition tells it to run `sl` through `Bash` and keep MCP tools for the warehouse connector.

To serve one role only, for another MCP client or a second server, start it with `--role <role>` (`interviewer`, `connector_runner`, `batch_analyst`, `readback_verifier` or `golden_builder`). It then lists and runs only that role's commands:

```sh
claude mcp add semantic-layer-golden -- bun "<plugin root>/skills/semantic-layer/scripts/mcp/server.ts" --root "$PWD/semantic" --role golden_builder
```

Keep `semantic-layer` in the name of a server you add by hand: the plugin's role hook checks only tools whose server name contains it. The server's own `--role` limit and its `--show-protected` refusal apply under any name. Update the path after a plugin update, or remove the server with `claude mcp remove semantic-layer-golden`. To turn the plugin's own server off, disable it in `/mcp`.

## Without the plugin

Copy `skills/semantic-layer/` into a project's `.claude/skills/` and run `bun install` in that copy. You get the skill and the CLI, but not the agents or the hooks.

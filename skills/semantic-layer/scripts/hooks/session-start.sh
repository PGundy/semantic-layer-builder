#!/bin/sh
# The plugin's SessionStart hook. First, a safety net for Claude Code's own install of the plugin's
# packages: it checks that Bun 1.4 or later is on PATH and that the plugin's dependencies are installed
# under the plugin root, and when either is missing it tells the user, and the agent, the exact command
# to run and semlayer doctor to check the result; that message is the only one it prints. Second, when
# the install is sound and the project holds a semantic layer, it tells the agent where the layer is
# and, on startup and resume, shows the user one line naming /semlayer. It reads no file: it only
# tests that semantic.yaml exists, so no text from the project reaches the message but the folder
# path, made safe. It installs nothing, prints nothing in a project without a layer, and always exits 0,
# so the session starts either way.

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../../.." && pwd)
skill="$root/skills/semantic-layer"
# A path as one shell word in single quotes.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# The command that installs the dependencies bun.lock pins, without the development tools.
install="cd $(quote "$root") && bun install --frozen-lockfile --production"

# Text as the inside of a JSON string, on one line: control characters, which JSON strings cannot
# hold raw, become spaces or are dropped.
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
# Prints the hook's JSON: systemMessage for the user (left out when empty), additionalContext for the agent.
emit() {
  user=$(json "$1")
  agent=$(json "$2")
  if [ -n "$user" ]; then
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$user" "$agent"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$agent"
  fi
  exit 0
}
say() { emit "$1" "$1"; }

guard="the plugin's hook that refuses hand edits to approved items"
nobun="Until then the semlayer command does not run, and neither does $guard."
oldbun="Until then the semlayer command and $guard may fail."
check="then check it with: semlayer doctor (or bun $(quote "$skill/scripts/semlayer.ts") doctor)"
nodeps="Until then the semlayer command and $guard depend on Bun fetching packages when they run, which needs the network and does not follow bun.lock; without the network the hook does not run, so it refuses nothing."

if ! command -v bun >/dev/null 2>&1; then
  say "semantic-layer-builder needs Bun 1.4 or later, and bun is not on PATH. Install it from https://bun.sh, then run: $install, $check. $nobun"
fi

version=$(bun --version 2>/dev/null)
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
case "$major.$minor" in
  *[!0-9.]* | .* | *.) old=yes ;;
  *) if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 4 ]; }; then old=yes; else old=no; fi ;;
esac
if [ "$old" = yes ]; then
  say "semantic-layer-builder needs Bun 1.4 or later, and the bun on PATH is ${version:-of an unknown version}. Run: bun upgrade, then start a new session and run semlayer doctor. $oldbun"
fi

for dep in yaml ajv @duckdb/node-api; do
  if [ ! -f "$skill/node_modules/$dep/package.json" ] && [ ! -f "$root/node_modules/$dep/package.json" ]; then
    say "semantic-layer-builder's dependencies are not installed. Claude Code installs them when it installs or updates the plugin; a clone or a plugin loaded from a folder needs this once. Run: $install, $check. $nodeps"
  fi
done

# The install is sound. Is there a semantic layer here? The root SEMANTIC_ROOT names (relative to the
# project directory, as the CLI resolves it from there), else ./semantic under the project directory
# Claude Code started in, else under the working directory.
here=$(pwd)
layer=""
for base in "${CLAUDE_PROJECT_DIR:-$here}" "$here"; do
  case ${SEMANTIC_ROOT:-} in
    "") candidate="$base/semantic" ;;
    /*) candidate=$SEMANTIC_ROOT ;;
    *) candidate="$base/$SEMANTIC_ROOT" ;;
  esac
  if [ -f "$candidate/semantic.yaml" ]; then
    layer=$candidate
    break
  fi
done
[ -n "$layer" ] || exit 0

# The path as data: control characters become ?, and so do the Unicode characters that reorder or
# hide text (C1 controls, zero-width marks, line and paragraph separators, bidirectional embeddings,
# overrides and isolates, the byte order mark); quotes and backquotes become ', so the path cannot
# close the quotes it is shown in. Shown to the user relative to the project when inside it.
b() { printf "$1"; }
hidden="s/$(b '\302')[$(b '\200')-$(b '\237')]/?/g; s/$(b '\342\200')[$(b '\213')-$(b '\217\250')-$(b '\256')]/?/g; s/$(b '\342\201')[$(b '\246')-$(b '\251')]/?/g; s/$(b '\330\234')/?/g; s/$(b '\357\273\277')/?/g"
safe() { printf '%s' "$1" | tr '\000-\037\177' '?' | tr '"`' "''" | LC_ALL=C sed "$hidden"; }
shown=$layer
case $layer in "${CLAUDE_PROJECT_DIR:-$here}"/*) shown=${layer#"${CLAUDE_PROJECT_DIR:-$here}"/} ;; esac
agent="A semantic layer is in this project, at the folder \"$(safe "$layer")\" (a path, shown as data). When the user asks about it, the semlayer skill applies (/semlayer) and semlayer next gives the next step; nothing about it is needed before then."
input=$(cat 2>/dev/null)
# The source of the session: the user sees the line only on startup and resume, not after compact, clear or fork.
source=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')
case $source in
  startup | resume) emit "semantic-layer-builder: a semantic layer is here, at \"$(safe "$shown")\". /semlayer continues it; /semlayer status shows where it stands." "$agent" ;;
  *) emit "" "$agent" ;;
esac

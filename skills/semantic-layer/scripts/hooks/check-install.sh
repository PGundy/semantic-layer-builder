#!/bin/sh
# The plugin's SessionStart hook. It checks that Bun 1.4 or later is on PATH and that the skill's
# dependencies are installed under the plugin root, and when either is missing it tells the user,
# and the agent, the exact command to run. It installs nothing, prints nothing when all is in place,
# and always exits 0, so the session starts either way.

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../../.." && pwd)
skill="$root/skills/semantic-layer"
# A path as one shell word in single quotes.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# The command that installs the dependencies bun.lock pins, without the development tools.
install="cd $(quote "$root") && bun install --frozen-lockfile --production"

# Prints the hook's JSON: systemMessage for the user, additionalContext for the agent. Control
# characters, which JSON strings cannot hold raw, become spaces or are dropped.
say() {
  text=$(printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037\177' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$text" "$text"
  exit 0
}

guard="the plugin's hook that refuses hand edits to approved items"
nobun="Until then the semantic-layer CLI does not run, and neither does $guard."
oldbun="Until then the semantic-layer CLI and $guard may fail."
nodeps="Until then the semantic-layer CLI and $guard depend on Bun fetching packages when they run, which needs the network and does not follow bun.lock; without the network the hook does not run, so it refuses nothing."

if ! command -v bun >/dev/null 2>&1; then
  say "semantic-layer-builder needs Bun 1.4 or later, and bun is not on PATH. Install it from https://bun.sh, then run: $install (once, and again after each plugin update). $nobun"
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
  say "semantic-layer-builder needs Bun 1.4 or later, and the bun on PATH is ${version:-of an unknown version}. Run: bun upgrade, then start a new session. $oldbun"
fi

for dep in yaml ajv @duckdb/node-api; do
  if [ ! -f "$skill/node_modules/$dep/package.json" ] && [ ! -f "$root/node_modules/$dep/package.json" ]; then
    say "semantic-layer-builder's dependencies are not installed. Run: $install (once, and again after each plugin update), then check it with: bun $(quote "$skill/scripts/sl.ts") --help. $nodeps"
  fi
done
exit 0

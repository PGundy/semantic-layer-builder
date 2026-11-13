#!/usr/bin/env bash
# The gate before every push: install, typecheck, test (with a local Postgres
# when its binaries exist) and validate the example semantic layer.
#
# With PG_URL unset it starts its own cluster in a fresh directory and, on exit, stops it and
# removes the directory, also when a step fails. A cluster PG_URL names is left alone.
# It fails when the run leaves an sl-test-* or sl-pg-* entry in the temp directory.
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"
temp_entries() {
  find "$TMP/" -mindepth 1 -maxdepth 1 \( -name 'sl-test-*' -o -name 'sl-pg-*' \) 2>/dev/null | sort || true
}
# Reads two lists of entries with a "--" line between them and prints the entries of the second
# that are not in the first. The lists arrive on a pipe: a long one does not fit in an argument.
new_entries() {
  awk 'after { if ($0 != "" && !($0 in before)) print; next } $0 == "--" { after = 1; next } { before[$0] }'
}

PG_DIR=""
stop_own_cluster() {
  [ -n "$PG_DIR" ] || return 0
  PG_LOCAL_DIR="$PG_DIR" bash scripts/pg-local.sh --stop >/dev/null 2>&1 || true
  rm -rf "$PG_DIR"
  PG_DIR=""
}
trap stop_own_cluster EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

BEFORE="$(temp_entries)"

bun install --frozen-lockfile >/dev/null
bun run typecheck
if [ -z "${PG_URL:-}" ] && { ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v pg_ctl >/dev/null; }; then
  PG_DIR="$(mktemp -d "$TMP/sl-pg-verify.XXXXXX")"
  # A cluster that does not start stops the run here, with pg-local.sh's own message.
  PG_EXPORT="$(PG_LOCAL_DIR="$PG_DIR" bash scripts/pg-local.sh)"
  eval "$PG_EXPORT"
  export PG_URL
fi
[ -n "${PG_URL:-}" ] || echo "verify: PG_URL unset and no Postgres binaries; Postgres tests will skip" >&2
bun test
if [ -f examples/acme/semantic/semantic.yaml ]; then
  bun skills/semantic-layer/scripts/sl.ts validate --root examples/acme/semantic
fi

stop_own_cluster
AFTER="$(temp_entries)"
LEFT="$(printf '%s\n' "$BEFORE" -- "$AFTER" | new_entries)"
if [ -n "$LEFT" ]; then
  {
    echo "verify: the run left temporary files behind in $TMP:"
    echo "$LEFT" | sed 's/^/  /'
    echo "A test makes its temp directories with tempDir() or tempRoot() from tests/helpers.ts, which remove them when the test file finishes."
    echo "Another run using the same temp directory at the same time shows up here too."
    echo "Delete the ones listed, fix the test that made them, and run again: bash scripts/verify.sh"
  } >&2
  exit 1
fi
echo "verify: ok"

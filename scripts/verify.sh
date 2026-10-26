#!/usr/bin/env bash
# The gate before every push: install, typecheck, test (with a local Postgres
# when its binaries exist) and validate the example semantic layer.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile >/dev/null
bun run typecheck
if [ -z "${PG_URL:-}" ] && { ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v pg_ctl >/dev/null; }; then
  eval "$(bash scripts/pg-local.sh)"
  export PG_URL
fi
[ -n "${PG_URL:-}" ] || echo "verify: PG_URL unset and no Postgres binaries; Postgres tests will skip" >&2
bun test
if [ -f examples/acme/semantic/semantic.yaml ]; then
  bun skills/semantic-layer/scripts/sl.ts validate --root examples/acme/semantic
fi
echo "verify: ok"

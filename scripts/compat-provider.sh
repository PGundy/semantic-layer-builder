#!/usr/bin/env bash
# Records whether semlayer works on a managed PostgreSQL service, as one redacted file you can commit:
#   export SEMLAYER_PROVIDER_URL='postgres://<read-only user>:<password>@<host>:<port>/<database>'
#   bash scripts/compat-provider.sh <local|supabase|neon|rds|cloud-sql|other> <schema> docs/compat/fixtures/<name>.json
#
# It reads the catalog of <schema> and runs semlayer doctor; it profiles nothing and reads no row. The
# URL is read from the environment only. docs/compat/postgres.md has the steps and what the file holds.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "compat-provider: Bun 1.4 or later is needed (https://bun.sh)." >&2; exit 127; }
exec bun scripts/compat-provider.ts "$@"

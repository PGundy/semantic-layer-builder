#!/usr/bin/env bash
# Runs the live Postgres tests against one server version in a throwaway Docker container:
#   bash scripts/compat-pg.sh <major>        for example: bash scripts/compat-pg.sh 14
#
# It starts postgres:<major>, waits until it accepts connections, exports PG_URL, runs every test
# file under tests/compat/ and every other test file that reads PG_URL, and removes the container.
# The no-Docker path is scripts/pg-local.sh.
#
# COMPAT_PG_PORT (default 55432) is the host port the container listens on, on 127.0.0.1 only.
# COMPAT_PG_NAME (default semlayer-compat-<major>) names the container.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "compat-pg: $*" >&2; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] && [ $# -eq 1 ] || die "usage: bash scripts/compat-pg.sh <major version>, for example 14"
case "$VERSION" in *[!0-9]*) die "the version is a major number such as 14, not \"$VERSION\"" ;; esac
command -v docker >/dev/null || die "Docker is not installed. Without it, run the live tests on the PostgreSQL on this machine: eval \"\$(bash scripts/pg-local.sh)\" && bun test"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running. Start Docker, then run this again."

PORT="${COMPAT_PG_PORT:-55432}"
NAME="${COMPAT_PG_NAME:-semlayer-compat-$VERSION}"
PASSWORD="compat-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -p "127.0.0.1:$PORT:5432" "postgres:$VERSION-alpine" >/dev/null \
  || die "could not start postgres:$VERSION-alpine; check that the version exists and that port $PORT is free (COMPAT_PG_PORT)."

ready=""
for _ in $(seq 1 60); do
  # The image restarts once after its first start-up, so ask over TCP from outside the container.
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    sleep 2
    docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[ -n "$ready" ] || { docker logs "$NAME" 2>&1 | tail -20 >&2; die "postgres:$VERSION did not become ready in 60 seconds."; }

export PG_URL="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/postgres"

# Every test file that reads PG_URL: the compat files and the older live tests.
FILES=$(grep -rl "PG_URL" tests --include='*.test.ts' | sort)
echo "compat-pg: postgres:$VERSION on 127.0.0.1:$PORT; $(echo "$FILES" | wc -l | tr -d ' ') test files"
# shellcheck disable=SC2086
bun test $FILES

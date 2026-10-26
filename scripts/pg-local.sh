#!/usr/bin/env bash
# Starts a throwaway Postgres cluster for tests, without Docker, and prints the
# line to export:   eval "$(bash scripts/pg-local.sh)"
#
# PG_LOCAL_DIR (default /tmp/sl-pg) holds the cluster and its socket.
# PG_LOCAL_PORT (default 54329). PG_BIN (default: newest /usr/lib/postgresql/*/bin).
# Running as root, the cluster runs as the `postgres` system user.
set -euo pipefail

DIR="${PG_LOCAL_DIR:-/tmp/sl-pg}"
PORT="${PG_LOCAL_PORT:-54329}"
if [ -z "${PG_BIN:-}" ]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PG_BIN" ] || PG_BIN="$(dirname "$(command -v pg_ctl 2>/dev/null || echo /nonexistent/pg_ctl)")"
fi
[ -x "$PG_BIN/pg_ctl" ] || { echo "pg-local: no pg_ctl in $PG_BIN (set PG_BIN)" >&2; exit 1; }

as_owner() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

mkdir -p "$DIR"
[ "$(id -u)" = "0" ] && chown postgres "$DIR"
if [ ! -f "$DIR/data/PG_VERSION" ]; then
  as_owner "$PG_BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
fi
if ! as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
  as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
    -o "-p $PORT -k $DIR -c listen_addresses=''" start >/dev/null
fi
echo "export PG_URL='postgres://postgres@localhost:$PORT/postgres?host=$DIR'"

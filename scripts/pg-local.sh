#!/usr/bin/env bash
# Starts a throwaway Postgres cluster for tests, without Docker, and prints the
# line to export:   eval "$(bash scripts/pg-local.sh)"
# Stops it:         bash scripts/pg-local.sh --stop
#
# PG_LOCAL_DIR (default ${TMPDIR:-/tmp}/sl-pg-<uid>) holds the cluster and its socket.
# The directory is private (mode 700), the socket accepts only its owner (0700) and
# the cluster listens on no TCP address, so no other local user can connect.
# PG_LOCAL_PORT (default 54329) names the socket; a cluster already running in the directory
# keeps the port it started on, and the printed URL names that one. PG_BIN (default: newest
# /usr/lib/postgresql/*/bin, else the directory of pg_ctl on PATH; Homebrew:
# PG_BIN="$(brew --prefix postgresql@16)/bin"). Running as root, the cluster runs as the `postgres`
# system user.
set -euo pipefail

die() { echo "pg-local: $*" >&2; exit 1; }

TMP="${TMPDIR:-/tmp}"
DIR="${PG_LOCAL_DIR:-${TMP%/}/sl-pg-$(id -u)}"
DIR="${DIR%/}"
PORT="${PG_LOCAL_PORT:-54329}"
if [ -z "${PG_BIN:-}" ]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$PG_BIN" ] || PG_BIN="$(dirname "$(command -v pg_ctl 2>/dev/null || echo /nonexistent/pg_ctl)")"
fi
[ -x "$PG_BIN/pg_ctl" ] || die "no pg_ctl in $PG_BIN (set PG_BIN)"

ROOT=0
[ "$(id -u)" = "0" ] && ROOT=1
as_owner() {
  if [ "$ROOT" = "1" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

STOP="bash scripts/pg-local.sh --stop"
[ -n "${PG_LOCAL_DIR:-}" ] && STOP="PG_LOCAL_DIR='$DIR' $STOP"

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$DIR/data/PG_VERSION" ] && as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
    as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" -m fast -w stop >/dev/null
    echo "pg-local: stopped the cluster in $DIR (remove the directory to delete it)" >&2
  else
    echo "pg-local: no cluster running in $DIR" >&2
  fi
  exit 0
fi
[ -z "${1:-}" ] || die "unknown argument $1 (the only one is --stop)"

# The directory must be a real directory that only the cluster's owner controls:
# one another user created first could hold their own data directory or socket.
[ -L "$DIR" ] && die "$DIR is a symbolic link; set PG_LOCAL_DIR to a private directory"
if [ -e "$DIR" ]; then
  [ -d "$DIR" ] || die "$DIR exists and is not a directory; set PG_LOCAL_DIR"
  if [ "$ROOT" = "1" ]; then
    [ -n "$(find "$DIR" -maxdepth 0 \( -user root -o -user postgres \) 2>/dev/null)" ] \
      || die "$DIR is owned by another user; set PG_LOCAL_DIR to a private directory"
  else
    [ -n "$(find "$DIR" -maxdepth 0 -user "$(id -u)" 2>/dev/null)" ] \
      || die "$DIR is owned by another user; set PG_LOCAL_DIR to a private directory"
  fi
else
  # The parent may be shared; the leaf is created here, and mkdir fails if another user created
  # it first.
  mkdir -p "$(dirname "$DIR")"
  (umask 077 && mkdir "$DIR")
fi
[ "$ROOT" = "1" ] && chown postgres "$DIR"
chmod 700 "$DIR"

if [ ! -f "$DIR/data/PG_VERSION" ]; then
  as_owner "$PG_BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 --no-locale >/dev/null
fi
if as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
  # A cluster already runs here; its socket is named by the port it started on, which
  # postmaster.pid holds on its fourth line.
  RUNNING="$(sed -n 4p "$DIR/data/postmaster.pid" 2>/dev/null || true)"
  [ -n "$RUNNING" ] || die "a cluster runs in $DIR but its port cannot be read; stop it with: $STOP"
  if [ "$RUNNING" != "$PORT" ]; then
    echo "pg-local: the cluster in $DIR already runs on port $RUNNING, not $PORT; using $RUNNING" >&2
    PORT="$RUNNING"
  fi
else
  as_owner "$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
    -o "-p $PORT -k $DIR -c listen_addresses='' -c unix_socket_permissions=0700" start >/dev/null
fi
echo "pg-local: Postgres runs in $DIR; stop it with: $STOP" >&2
echo "export PG_URL='postgres://postgres@localhost:$PORT/postgres?host=$DIR'"

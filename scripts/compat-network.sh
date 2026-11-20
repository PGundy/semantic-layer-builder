#!/usr/bin/env bash
# Runs the pooled and TLS connection tests against throwaway Docker containers:
#   bash scripts/compat-network.sh
#
# On a private Docker network it starts three servers, each published on 127.0.0.1 only:
#   - postgres:16-alpine without TLS (PG_URL), on COMPAT_NET_PORT;
#   - PgBouncer in transaction mode in front of it, with the image's default settings otherwise
#     (SEMLAYER_TEST_POOLER_URL), on COMPAT_NET_PORT + 1;
#   - postgres:16-alpine that takes TCP connections over TLS only, with a server certificate for
#     127.0.0.1 signed by a CA made for this run (SEMLAYER_TEST_TLS_URL, the CA file in
#     SEMLAYER_TEST_TLS_CA), on COMPAT_NET_PORT + 2.
# It runs tests/compat/pooler.test.ts and tests/compat/tls.test.ts, then removes the containers and
# their volumes, the network and the directory that held the CA, the certificate and its key.
# Nothing it makes is kept.
#
# COMPAT_NET_PORT (default 55442) is the first of the three host ports.
# COMPAT_NET_NAME (default semlayer-compat-net) names the network and prefixes the containers.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "compat-network: $*" >&2; exit 1; }

[ $# -eq 0 ] || die "usage: bash scripts/compat-network.sh (it takes no arguments)"
PORT="${COMPAT_NET_PORT:-55442}"
case "$PORT" in *[!0-9]*|"") die "COMPAT_NET_PORT is a port number such as 55442, not \"$PORT\"" ;; esac
command -v docker >/dev/null || die "Docker is not installed. The pooler and TLS tests need it; the other live tests run without it: eval \"\$(bash scripts/pg-local.sh)\" && bun test"
command -v openssl >/dev/null || die "openssl is not installed. It makes the run's CA and server certificate; install it, then run this again."
docker info >/dev/null 2>&1 || die "the Docker daemon is not running. Start Docker, then run this again."

NAME="${COMPAT_NET_NAME:-semlayer-compat-net}"
PG="$NAME-pg"
BOUNCER="$NAME-bouncer"
TLS="$NAME-tls"
# PgBouncer 1.26.1, pinned by digest.
BOUNCER_IMAGE="edoburu/pgbouncer@sha256:8638aa563607256d3c7440437534195f1066a92b68015d89ae9d6b935b444a6d"
PASSWORD="compat-$$-$RANDOM"
CERTS="$(mktemp -d "${TMPDIR:-/tmp}/semlayer-compat-tls.XXXXXX")"

remove() {
  docker rm -f -v "$PG" "$BOUNCER" "$TLS" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap 'remove; rm -rf "$CERTS"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
remove

# A CA, and a server certificate it signs for 127.0.0.1 only, so verify-full refuses the name localhost and verify-ca takes it.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=semlayer compat CA" -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$CERTS/server.key" -out "$CERTS/server.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\n' >"$CERTS/san.ext"
openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" -CAcreateserial -days 2 -extfile "$CERTS/san.ext" -out "$CERTS/server.crt" 2>/dev/null
chmod 600 "$CERTS/ca.key" "$CERTS/server.key"

docker network create "$NAME" >/dev/null || die "could not create the Docker network $NAME (COMPAT_NET_NAME)."
docker run -d --name "$PG" --network "$NAME" --network-alias upstream -e POSTGRES_PASSWORD="$PASSWORD" -p "127.0.0.1:$PORT:5432" postgres:16-alpine >/dev/null \
  || die "could not start postgres:16-alpine; check that port $PORT is free (COMPAT_NET_PORT)."
docker run -d --name "$TLS" --network "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -p "127.0.0.1:$((PORT + 2)):5432" \
  -v "$CERTS:/tls:ro" -v "$PWD/tests/compat/docker/tls-entrypoint.sh:/tls-entrypoint.sh:ro" --entrypoint /bin/sh postgres:16-alpine /tls-entrypoint.sh >/dev/null \
  || die "could not start the TLS server; check that port $((PORT + 2)) is free."

wait_ready() {
  for _ in $(seq 1 60); do
    # The image restarts once after its first start-up, so ask twice over TCP from inside the container.
    if docker exec "$1" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
      sleep 2
      docker exec "$1" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  docker logs "$1" 2>&1 | tail -20 >&2
  die "$1 did not become ready in 60 seconds."
}
wait_ready "$PG"
wait_ready "$TLS"

# The image writes the user and password to its auth file and points the pool at the server.
docker run -d --name "$BOUNCER" --network "$NAME" -p "127.0.0.1:$((PORT + 1)):5432" \
  -e DATABASE_URL="postgres://postgres:$PASSWORD@upstream:5432/postgres" -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 "$BOUNCER_IMAGE" >/dev/null \
  || die "could not start PgBouncer; check that port $((PORT + 1)) is free."
ready=""
for _ in $(seq 1 30); do
  docker exec "$PG" sh -c "PGPASSWORD='$PASSWORD' psql -h $BOUNCER -p 5432 -U postgres -d postgres -Atc 'select 1'" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { docker logs "$BOUNCER" 2>&1 | tail -20 >&2; die "PgBouncer did not accept connections in 30 seconds."; }

export PG_URL="postgres://postgres:$PASSWORD@127.0.0.1:$PORT/postgres"
export SEMLAYER_TEST_POOLER_URL="postgres://postgres:$PASSWORD@127.0.0.1:$((PORT + 1))/postgres"
export SEMLAYER_TEST_TLS_URL="postgres://postgres:$PASSWORD@127.0.0.1:$((PORT + 2))/postgres"
export SEMLAYER_TEST_TLS_CA="$CERTS/ca.crt"

echo "compat-network: postgres:16 on 127.0.0.1:$PORT, PgBouncer (transaction mode) on $((PORT + 1)), TLS-only postgres:16 on $((PORT + 2))"
# The servers share this machine's cores with the tests: allow each test and hook 30 seconds.
bun test --timeout 30000 tests/compat/pooler.test.ts tests/compat/tls.test.ts

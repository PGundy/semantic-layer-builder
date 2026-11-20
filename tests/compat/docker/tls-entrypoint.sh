#!/bin/sh
# The entrypoint of the TLS Postgres container scripts/compat-network.sh starts. The certificate, its
# key and the CA are made for the run and mounted read-only at /tls; the server needs the key owned by
# its own user, so they are copied first. The server then takes TCP connections over TLS only:
# pg_hba.conf rejects every connection that is not encrypted.
set -eu
dir=/var/lib/postgresql/tls
install -d -o postgres -g postgres -m 700 "$dir"
install -o postgres -g postgres -m 600 /tls/server.key "$dir/server.key"
install -o postgres -g postgres -m 644 /tls/server.crt "$dir/server.crt"
cat > "$dir/pg_hba.conf" <<'HBA'
local     all all     trust
hostssl   all all all scram-sha-256
hostnossl all all all reject
HBA
chown postgres:postgres "$dir/pg_hba.conf"
exec docker-entrypoint.sh postgres -c ssl=on -c "ssl_cert_file=$dir/server.crt" -c "ssl_key_file=$dir/server.key" -c "hba_file=$dir/pg_hba.conf"

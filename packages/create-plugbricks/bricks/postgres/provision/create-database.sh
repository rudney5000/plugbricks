#!/bin/sh
# Provision task for the "database" capability: one role and one database per consumer.
# Idempotent: safe to run on every start. Creates what is missing, resets the role
# password to the current secret, never drops anything.
#
# Inputs (from plugin.json provides.database.provision.env):
#   PGHOST, PGPORT, PGPASSWORD   superuser connection to the provider
#   APP_ROLE, APP_DATABASE       consumer role and database names
#   APP_PASSWORD                 consumer role password
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${APP_ROLE:?APP_ROLE is required}"
: "${APP_DATABASE:?APP_DATABASE is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE=postgres

tries=0
until pg_isready -q; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "create-database: postgres at $PGHOST not ready after 30s" >&2
    exit 1
  fi
  sleep 1
done

# Names and password go through psql variables and format(%I/%L): no shell or SQL injection.
psql -X -q -v ON_ERROR_STOP=1 \
  -v role="$APP_ROLE" -v db="$APP_DATABASE" -v pw="$APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'role', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL

echo "create-database: role \"$APP_ROLE\" and database \"$APP_DATABASE\" ready"

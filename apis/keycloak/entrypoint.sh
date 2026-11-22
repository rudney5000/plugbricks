#!/bin/bash
# plugbricks gives this brick DATABASE_URL (postgres://user:password@host:port/database, from the postgres
# brick); Keycloak reads KC_DB_URL (JDBC), KC_DB_USERNAME and KC_DB_PASSWORD. Split one into the three, then
# start Keycloak with the arguments of the image (D18). The password is never printed.
set -euo pipefail
if [ -n "${DATABASE_URL:-}" ]; then
  re='^postgres(ql)?://([^:@/]+):([^@/]*)@([^:/]+):([0-9]+)/([^/?]+)$'
  if [[ ! $DATABASE_URL =~ $re ]]; then
    echo "keycloak: DATABASE_URL is not postgres://user:password@host:port/database" >&2
    exit 1
  fi
  export KC_DB_USERNAME="${BASH_REMATCH[2]}"
  export KC_DB_PASSWORD="${BASH_REMATCH[3]}"
  export KC_DB_URL="jdbc:postgresql://${BASH_REMATCH[4]}:${BASH_REMATCH[5]}/${BASH_REMATCH[6]}"
  unset DATABASE_URL
fi
exec /opt/keycloak/bin/kc.sh "$@"

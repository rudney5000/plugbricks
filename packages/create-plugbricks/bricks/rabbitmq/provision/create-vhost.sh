#!/bin/sh
# Provision task for the "queue" capability: one vhost, one user and its permissions per consumer.
# Idempotent: PUT replaces, so the task can run on every start; the user's password is reset to the
# current secret, never logged, and never put on a command line.
#
# Inputs (from plugin.json provides.queue.provision.env):
#   MANAGEMENT_URL, ADMIN_USER, ADMIN_PASSWORD   superuser access to the management API
#   APP_VHOST, APP_USER, APP_PASSWORD            consumer vhost, user and password
set -eu

: "${MANAGEMENT_URL:?MANAGEMENT_URL is required}"
: "${ADMIN_USER:?ADMIN_USER is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${APP_VHOST:?APP_VHOST is required}"
: "${APP_USER:?APP_USER is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"

api() {
  curl -fsS --retry 5 --retry-connrefused --retry-delay 1 -u "$ADMIN_USER:$ADMIN_PASSWORD" "$@"
}

# AMQP may accept connections a moment before the management API answers; wait for it instead of
# failing the consumer's start. At most ~30 s, then the init container is restarted and tries again.
tries=0
until api -o /dev/null "$MANAGEMENT_URL/api/overview"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "create-vhost: management API at $MANAGEMENT_URL not ready after 30 attempts" >&2
    exit 1
  fi
  sleep 1
done

# Names are DNS labels and the password is letters and digits (secrets.ts), so the JSON bodies need no escaping.
api -X PUT -H 'content-type: application/json' -d '{}' "$MANAGEMENT_URL/api/vhosts/$APP_VHOST"
api -X PUT -H 'content-type: application/json' \
  -d "{\"password\":\"$APP_PASSWORD\",\"tags\":\"\"}" \
  "$MANAGEMENT_URL/api/users/$APP_USER"
api -X PUT -H 'content-type: application/json' \
  -d '{"configure":".*","write":".*","read":".*"}' \
  "$MANAGEMENT_URL/api/permissions/$APP_VHOST/$APP_USER"

echo "create-vhost: vhost \"$APP_VHOST\", user \"$APP_USER\" and permissions ready"

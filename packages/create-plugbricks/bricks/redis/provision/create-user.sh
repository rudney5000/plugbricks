#!/bin/sh
# Provision task for the "cache" capability: one Redis user per consumer, limited to its own keys and channels.
# Idempotent: ACL SETUSER with "reset" rewrites the user, so the task can run on every start; the password is
# reset to the current secret. Only its sha256 is sent, never the password itself.
#
# Inputs (from plugin.json provides.cache.provision.env):
#   REDIS_HOST, REDIS_PORT, REDIS_ADMIN_PASSWORD   the server and its "default" user
#   APP_USER, APP_PASSWORD                         consumer user and password
set -eu

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${REDIS_PORT:?REDIS_PORT is required}"
: "${REDIS_ADMIN_PASSWORD:?REDIS_ADMIN_PASSWORD is required}"
: "${APP_USER:?APP_USER is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"

# Read by redis-cli: the password is never on a command line.
export REDISCLI_AUTH="$REDIS_ADMIN_PASSWORD"
cli() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -e "$@"
}

tries=0
until cli ping >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "create-user: redis at $REDIS_HOST not ready after 30 attempts" >&2
    exit 1
  fi
  sleep 1
done

hash=$(printf %s "$APP_PASSWORD" | sha256sum | cut -c1-64)

# Every command, less: administration and dangerous ones (CONFIG, FLUSHALL, KEYS, MONITOR, ACL...), the search
# commands (an index reads every key under its prefix, whoever owns it), and the commands that change the functions
# and scripts all users share. INFO is given back: client libraries call it when they connect.
cli ACL SETUSER "$APP_USER" reset on "#$hash" "~$APP_USER:*" "&$APP_USER:*" \
  +@all -@admin -@dangerous +info -@search -function '-script|flush' '-script|kill' >/dev/null
# Written to the aclfile, so the user is still there after a restart of the server alone.
cli ACL SAVE >/dev/null

echo "create-user: user \"$APP_USER\" ready, limited to keys and channels \"$APP_USER:*\""

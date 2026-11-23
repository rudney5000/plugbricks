#!/bin/bash
# Provision task for the "oidc" capability (D19): one confidential client per consumer in the realm, with a
# service account (client credentials) and an audience mapper, so that its tokens are for the router.
# Idempotent: safe to run on every start. Creates the client when it is missing; otherwise, if it is one this script
# created, sets its secret again and restores its audience mapper. Refuses a client of that name it did not create
# (the admin's public client, one made by hand). Never deletes anything.
#
# Inputs (from plugin.json provides.oidc.provision.env):
#   KEYCLOAK_URL     the provider inside the platform, http://<host>:<port>
#   REALM            the realm the clients live in
#   ADMIN_PASSWORD   the password of the brick's administrator (user "admin" of the master realm)
#   CLIENT_ID        the consumer's name
#   CLIENT_SECRET    the consumer's own generated secret
#   AUDIENCE         the audience its tokens get
# No secret goes on a command line (D6): kcadm.sh reads the password from KC_CLI_PASSWORD and the client,
# with its secret, from standard input.
set -euo pipefail

: "${KEYCLOAK_URL:?KEYCLOAK_URL is required}"
: "${REALM:?REALM is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${CLIENT_ID:?CLIENT_ID is required}"
: "${CLIENT_SECRET:?CLIENT_SECRET is required}"
: "${AUDIENCE:?AUDIENCE is required}"

kcadm=/opt/keycloak/bin/kcadm.sh
# The admin session kcadm keeps lives in a folder of our own, removed however the script ends.
config_dir=$(mktemp -d)
trap 'rm -rf "$config_dir"' EXIT
config=(--config "$config_dir/kcadm.config")

KC_CLI_PASSWORD="$ADMIN_PASSWORD" "$kcadm" config credentials --server "$KEYCLOAK_URL" --realm master --user admin "${config[@]}" >/dev/null

id=$("$kcadm" get clients -r "$REALM" -q clientId="$CLIENT_ID" --fields id --format csv --noquotes "${config[@]}")

if [ -z "$id" ]; then
  "$kcadm" create clients -r "$REALM" -f - "${config[@]}" >/dev/null <<JSON
{
  "clientId": "$CLIENT_ID",
  "enabled": true,
  "publicClient": false,
  "serviceAccountsEnabled": true,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CLIENT_SECRET",
  "protocolMappers": [
    {
      "name": "audience",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-audience-mapper",
      "config": { "included.custom.audience": "$AUDIENCE", "access.token.claim": "true", "id.token.claim": "false" }
    }
  ]
}
JSON
  echo "create-client: created client $CLIENT_ID in realm $REALM"
else
  # A client of that name exists. It is ours only when it looks like one we create: confidential, with a service
  # account, no browser sign-in. Anything else (the admin's public client, a client made by hand) is refused rather
  # than turned into a consumer's client: its secret would be reset and its sign-in broken.
  client=$("$kcadm" get "clients/$id" -r "$REALM" --fields publicClient,serviceAccountsEnabled,standardFlowEnabled "${config[@]}")
  if ! grep -Eq '"publicClient" *: *false' <<<"$client" ||
    ! grep -Eq '"serviceAccountsEnabled" *: *true' <<<"$client" ||
    ! grep -Eq '"standardFlowEnabled" *: *false' <<<"$client"; then
    echo "create-client: realm $REALM already has a client $CLIENT_ID that plugbricks did not create (public, or with a browser sign-in, or without a service account); rename the brick or that client" >&2
    exit 1
  fi
  "$kcadm" update "clients/$id" -r "$REALM" -f - "${config[@]}" <<JSON
{ "secret": "$CLIENT_SECRET" }
JSON
  # Its tokens must be for the router: add the audience mapper again if it is gone.
  mappers=$("$kcadm" get "clients/$id/protocol-mappers/models" -r "$REALM" "${config[@]}")
  if ! grep -Eq '"included.custom.audience" *: *"'"$AUDIENCE"'"' <<<"$mappers"; then
    "$kcadm" create "clients/$id/protocol-mappers/models" -r "$REALM" -f - "${config[@]}" >/dev/null <<JSON
{ "name": "audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
  "config": { "included.custom.audience": "$AUDIENCE", "access.token.claim": "true", "id.token.claim": "false" } }
JSON
    echo "create-client: client $CLIENT_ID had no audience $AUDIENCE; added"
  fi
  echo "create-client: client $CLIENT_ID already in realm $REALM; its secret set again"
fi

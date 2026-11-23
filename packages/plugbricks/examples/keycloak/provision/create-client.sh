#!/bin/bash
# Provision task for the "oidc" capability (D19): one confidential client per consumer in the realm, with a
# service account (client credentials) and an audience mapper, so that its tokens are for the router.
# Idempotent: safe to run on every start. Creates the client when it is missing, otherwise sets its secret
# again to the current one; never deletes anything.
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
config=(--config "$(mktemp -d)/kcadm.config")

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
  "$kcadm" update "clients/$id" -r "$REALM" -f - "${config[@]}" <<JSON
{ "secret": "$CLIENT_SECRET" }
JSON
  echo "create-client: client $CLIENT_ID already in realm $REALM; its secret set again"
fi

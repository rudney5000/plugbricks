#!/bin/bash
# Provision task for the "oidc" capability (D19): one confidential client per consumer in the realm, with a
# service account (client credentials) and an audience mapper, so that its tokens are for the router.
# Idempotent: safe to run on every start. Creates the client when it is missing; otherwise, if it is one this script
# created, sets its secret again and restores its audience mapper. Refuses a client of that name it did not create
# (the admin's public client, one made by hand). Never deletes anything.
#
# Authorization (D22): the client also gets the client roles its brick declares (ROLES), and its service account gets the
# roles of the other bricks it declares to use (GRANTS), so that its tokens carry them in resource_access.<client>.roles.
# A role that a brick no longer declares, or a grant that a brick no longer asks for, is left as it is: this script never
# removes one. Take it away in the Keycloak console; tokens already issued keep it until they expire.
#
# Scopes (D44): the client gets, as default scopes, those its dependencies' protected fields ask for (SCOPES), so that its
# tokens carry them in their "scope" claim. A scope the realm does not have is created. None is ever taken away.
#
# Inputs (from plugin.json provides.oidc.provision.env):
#   KEYCLOAK_URL     the provider inside the platform, http://<host>:<port>
#   REALM            the realm the clients live in
#   ADMIN_PASSWORD   the password of the brick's administrator (user "admin" of the master realm)
#   CLIENT_ID        the consumer's name
#   CLIENT_SECRET    the consumer's own generated secret
#   AUDIENCE         the audience its tokens get
#   ROLES            optional: space-separated roles to create on the consumer's own client
#   GRANTS           optional: space-separated <client>/<role> to give to the consumer's service account; a client that
#                    does not exist yet is created by this script (its own provision task sets its secret later)
#   SCOPES           optional: space-separated client scopes the consumer's tokens must carry
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

# The internal id of a client, empty when the realm has none of that name.
client_id_of() {
  "$kcadm" get clients -r "$REALM" -q clientId="$1" --fields id --format csv --noquotes "${config[@]}"
}

# Creates a confidential client with a service account and the audience mapper. $2, when given, is its secret; without
# one Keycloak generates a secret, which the client's own provision task replaces.
create_client() {
  local secret=""
  [ -z "${2:-}" ] || secret="\"secret\": \"$2\","
  "$kcadm" create clients -r "$REALM" -f - "${config[@]}" >/dev/null <<JSON
{
  "clientId": "$1",
  "enabled": true,
  "publicClient": false,
  "serviceAccountsEnabled": true,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "clientAuthenticatorType": "client-secret",
  $secret
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
}

# Makes sure a client role exists on the client whose internal id is $1. The owner of the client and a consumer that is
# granted the role can both create it at the same time: a creation that fails is fine when the role exists afterwards.
ensure_role() {
  if ! "$kcadm" get "clients/$1/roles/$2" -r "$REALM" "${config[@]}" >/dev/null 2>&1; then
    if "$kcadm" create "clients/$1/roles" -r "$REALM" -s "name=$2" "${config[@]}" >/dev/null; then
      echo "create-client: created role $2"
    elif ! "$kcadm" get "clients/$1/roles/$2" -r "$REALM" "${config[@]}" >/dev/null 2>&1; then
      echo "create-client: could not create role $2" >&2
      exit 1
    fi
  fi
}

id=$(client_id_of "$CLIENT_ID")
created=no
if [ -z "$id" ]; then
  # Two provision tasks can reach for the same client at once (another consumer granting itself a role of this one):
  # when the creation fails, the client may exist now, made by the other, and is then handled as one that existed.
  if create_client "$CLIENT_ID" "$CLIENT_SECRET"; then created=yes; fi
  id=$(client_id_of "$CLIENT_ID")
  [ -n "$id" ] || {
    echo "create-client: could not create client $CLIENT_ID in realm $REALM" >&2
    exit 1
  }
fi

if [ "$created" = yes ]; then
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

# D22. The roles this brick's API asks of a token, as roles of its own client.
for role in ${ROLES:-}; do
  ensure_role "$id" "$role"
done

# The roles of the other bricks this one declares to use, held by its service account. The service account is a user
# of the realm called service-account-<client>. A target client that does not exist yet is created here, in the same
# shape; the target's own provision task then finds it as one it could have made.
for grant in ${GRANTS:-}; do
  target=${grant%%/*}
  role=${grant#*/}
  if [ -z "$target" ] || [ -z "$role" ] || [ "$target" = "$grant" ]; then
    echo "create-client: GRANTS entry \"$grant\" is not <client>/<role>" >&2
    exit 1
  fi
  target_id=$(client_id_of "$target")
  if [ -z "$target_id" ]; then
    create_client "$target" "" || true
    target_id=$(client_id_of "$target")
    [ -n "$target_id" ] || {
      echo "create-client: could not create client $target, which holds the role $role" >&2
      exit 1
    }
  fi
  ensure_role "$target_id" "$role"
  "$kcadm" add-roles -r "$REALM" --uusername "service-account-$CLIENT_ID" --cclientid "$target" --rolename "$role" "${config[@]}"
  echo "create-client: $CLIENT_ID holds $target/$role"
done

# D44. The internal id of a client scope of the realm, empty when it has none of that name.
scope_id_of() {
  local scope_id scope_name
  "$kcadm" get client-scopes -r "$REALM" --fields id,name --format csv --noquotes "${config[@]}" |
    while IFS=, read -r scope_id scope_name; do
      if [ "$scope_name" = "$1" ]; then echo "$scope_id"; fi
    done
}

# The scopes the consumer's tokens must carry: default scopes of its client, so a token request names none.
for scope in ${SCOPES:-}; do
  scope_id=$(scope_id_of "$scope")
  if [ -z "$scope_id" ]; then
    # Another consumer's task can create it at the same time: a creation that fails is fine when the scope exists after.
    "$kcadm" create client-scopes -r "$REALM" -s "name=$scope" -s protocol=openid-connect \
      -s 'attributes."include.in.token.scope"=true' "${config[@]}" >/dev/null || true
    scope_id=$(scope_id_of "$scope")
    [ -n "$scope_id" ] || {
      echo "create-client: could not create the scope $scope" >&2
      exit 1
    }
  fi
  "$kcadm" update "clients/$id/default-client-scopes/$scope_id" -r "$REALM" "${config[@]}"
  echo "create-client: the tokens of $CLIENT_ID carry the scope $scope"
done

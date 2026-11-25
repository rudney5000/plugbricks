# Signing in to the admin with Keycloak

The admin is a **host process** (`plugbricks admin`). Its identity provider is either the platform's
own **Keycloak brick** (`examples/keycloak`, D18, see the README) or an **external issuer**: a Keycloak you
run on the host (or anywhere reachable from it). This page walks through the second: a local Keycloak, a
public client (PKCE, no secret) and the `plugbricks-admin` / `plugbricks-viewer` realm roles.

The realm used below is the test fixture:
[`packages/plugbricks/test/fixtures/keycloak/realm.json`](../packages/plugbricks/test/fixtures/keycloak/realm.json).
It creates the realm `plugbricks`, the two roles, the public client `plugbricks-admin`
(redirect URI `http://127.0.0.1:4100/auth/callback`, PKCE S256, a realm-roles mapper that puts
`realm_access.roles` in the ID token) and a **demo** user (`demo` / `demo`, role
`plugbricks-admin`). Change the password before using it for anything but a local demo.

## 1. Start Keycloak

```bash
docker run -d --name plugbricks-keycloak \
  -p 127.0.0.1:8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KC_HOSTNAME=http://127.0.0.1:8080 \
  -v "$PWD/keycloak-realm.json:/opt/keycloak/data/import/realm.json:ro" \
  quay.io/keycloak/keycloak:26.7.3 start-dev --import-realm
```

Wait for `http://127.0.0.1:8080/realms/plugbricks` to answer. `KC_HOSTNAME` matters: the issuer in
the discovery document must be the URL the admin uses, or openid-client refuses the discovery.

## 2. Start the admin against it

```bash
npx plugbricks admin \
  --issuer http://127.0.0.1:8080/realms/plugbricks \
  --client-id plugbricks-admin
```

No `PLUGBRICKS_OIDC_CLIENT_SECRET`: the client is **public**, and the admin uses authorization code
+ PKCE. For a **confidential** client instead, create the client with a secret in Keycloak and set
`PLUGBRICKS_OIDC_CLIENT_SECRET` in the environment of the admin; it is never a flag.

Open `http://127.0.0.1:4100` and sign in as `demo` / `demo`. The admin reads the roles from the ID
token: `plugbricks-admin` can act, `plugbricks-viewer` can only read. Both are refused if the token
has neither.

## 3. With your own realm

Two things make the admin work:

- **A public (or confidential) client** with the redirect URI `http://127.0.0.1:4100/auth/callback`
  (and web origin `http://127.0.0.1:4100`), standard flow enabled, PKCE S256.
- **The realm roles in the ID token.** Keycloak does not put `realm_access` in the ID token by
  default. Add a client protocol mapper of type *User Realm Role*, claim name `realm_access.roles`,
  with **Add to ID token** on (the fixture's `realm-roles` mapper is an example). Without it the admin
  sees a signed-in account with no role and answers 403.

The browser, the issuer URL and the redirect URI must agree on the host: the admin answers only on
`127.0.0.1` / `localhost` (D15), and Keycloak must issue the same host in the issuer and accept the
callback.

## The Keycloak brick

Since D17 a brick can publish its pages on its own loopback port, and since D18 there is a Keycloak brick:
the same realm, roles and client, built into its image (`apis/keycloak`) **without any user**, its
console at `http://127.0.0.1:<webPort>/admin/`, its administrator's password generated in
`.secrets/secrets.env`. With it, `plugbricks admin --client-id plugbricks-admin` finds the issuer by itself
(D19); `--issuer` is for an external Keycloak, as on this page. The README section "`keycloak`" shows the
commands.

### Roles of the APIs (D22)

The brick's provision task also gives the platform's APIs their roles. A brick whose manifest has an
`authorization` block (`orders`: `orders:read`, `orders:write`; `shipping`: `shipping:read`, `shipping:write`)
gets those as **client roles of its own client** (the client the task creates for it, named like the brick). The
service account of a brick that lists such an API in `dependencies` is given the roles of the operations it says it
uses (`"operations"`, queries by default): `orders-web` holds `orders:read` and `shipping:read`, and no write role.
The token then carries them in `resource_access.<brick>.roles`, and the API refuses a valid token without the role
of the operation (`FORBIDDEN`, HTTP 403).

To let a service write, give its service account the write role, in the console (Clients, the API's client, Roles,
then Users, `service-account-<brick>`, Role mapping) or with `kcadm.sh add-roles -r plugbricks --uusername
service-account-orders-web --cclientid orders --rolename orders:write`. The task never removes a role or a grant:
to take one away, do it in the console. A token already issued keeps its roles until it expires (300 s, Keycloak's
default for the realm); the next one does not have them.

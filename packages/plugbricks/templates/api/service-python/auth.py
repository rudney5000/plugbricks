"""The token check of this service. With an identity provider in the platform (the oidc capability), plugbricks gives the
service OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE, and the router sends every request with the caller's token. This
service checks that token itself too: a service of the platform that calls it directly, past the router, gets nothing
without a valid one. Without a provider none of the three is set and the service answers without a token.
"""

import re
from dataclasses import dataclass, field

import jwt

BEARER = re.compile(r"^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$", re.IGNORECASE)


@dataclass(frozen=True)
class Caller:
    """Who called, from a verified token."""

    subject: str  # the token's `sub`
    name: str  # `preferred_username`, else `sub`; for a service account, "service-account-<client>"
    client: str = ""  # the client the token was issued to (`azp`), when it says
    roles: dict = field(default_factory=dict)  # the client roles of the token (`resource_access.<client>.roles`), by client
    scopes: list = field(default_factory=list)  # the `scope` claim, space-separated in the token


def client_roles(claim):
    """The client roles a token carries, from its `resource_access` claim. Anything that is not a list of strings is ignored."""
    out = {}
    if not isinstance(claim, dict):
        return out
    for client, entry in claim.items():
        roles = entry.get("roles") if isinstance(entry, dict) else None
        if isinstance(roles, list):
            out[client] = [r for r in roles if isinstance(r, str)]
    return out


def token_check(issuer, audience, jwks_url):
    """Returns a function: an Authorization header -> the Caller of a valid token, None otherwise. It never raises.

    It blocks while it fetches the keys (the first time, and again for a key id it does not know): call it from a thread.
    """
    keys = jwt.PyJWKClient(jwks_url, cache_keys=True, timeout=5)

    def check(authorization):
        match = BEARER.match(authorization or "")
        if not match:
            return None
        try:
            key = keys.get_signing_key_from_jwt(match.group(1)).key
            # RS256 only, as the router: no "none", no symmetric algorithm with the public key as the secret.
            claims = jwt.decode(
                match.group(1),
                key,
                algorithms=["RS256"],
                issuer=issuer,
                audience=audience,
                options={"require": ["exp", "sub"]},
            )
        except Exception:  # an invalid token, or keys that cannot be fetched: either way, not a caller
            return None
        username = claims.get("preferred_username")
        scope = claims.get("scope")
        azp = claims.get("azp")
        return Caller(
            subject=claims["sub"],
            name=username if isinstance(username, str) else claims["sub"],
            client=azp if isinstance(azp, str) else "",
            roles=client_roles(claims.get("resource_access")),
            scopes=scope.split() if isinstance(scope, str) else [],
        )

    return check


def token_check_from_env(env):
    """From OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE; None when none is set (no provider: no check). Some set and not
    all: it raises, rather than serving without the check it was meant to make. A value is never printed."""
    issuer, jwks_url, audience = env.get("OIDC_ISSUER"), env.get("OIDC_JWKS_URL"), env.get("OIDC_AUDIENCE")
    if not (issuer or jwks_url or audience):
        return None
    if not (issuer and jwks_url and audience):
        missing = ", ".join(n for n, v in (("OIDC_ISSUER", issuer), ("OIDC_JWKS_URL", jwks_url), ("OIDC_AUDIENCE", audience)) if not v)
        raise ValueError(f"incomplete OIDC configuration: missing {missing}; set all three or none")
    return token_check(issuer, audience, jwks_url)


@dataclass(frozen=True)
class Authorization:
    """The roles this service asks of a token (D22), by operation class. `client` is the OIDC client the roles belong to:
    this service's own (OIDC_CLIENT_ID), the one the provider made for it. A class with no role stays open to any valid token."""

    client: str
    queries: str = ""
    mutations: str = ""


def authorization_from_env(env):
    """From AUTHORIZATION_QUERIES_ROLE and AUTHORIZATION_MUTATIONS_ROLE, which the platform injects when the manifest has an
    "authorization" block; None when neither is set (a valid token is enough). Set without the token check, or without the
    client they belong to, it raises: serving with a rule that cannot be applied would silently open the service."""
    queries, mutations = env.get("AUTHORIZATION_QUERIES_ROLE", ""), env.get("AUTHORIZATION_MUTATIONS_ROLE", "")
    if not (queries or mutations):
        return None
    if not env.get("OIDC_ISSUER"):
        raise ValueError("incomplete authorization configuration: roles are set but there is no token check (OIDC_ISSUER)")
    client = env.get("OIDC_CLIENT_ID", "")
    if not client:
        raise ValueError("incomplete authorization configuration: roles are set but OIDC_CLIENT_ID, the client they belong to, is not")
    return Authorization(client=client, queries=queries, mutations=mutations)


def role_for(rules, operation):
    """The role an operation class asks for: "" for none. A class this service does not know (a subscription) returns None."""
    if operation == "query":
        return rules.queries
    if operation == "mutation":
        return rules.mutations
    return None


def may_run(caller, rules, operation):
    """Whether a caller may run this class of operation. A class this service does not know is refused."""
    role = role_for(rules, operation)
    if role is None:
        return False
    return role == "" or role in caller.roles.get(rules.client, [])


def forbidden_message(rules, operation):
    role = role_for(rules, operation)
    return f'forbidden: this token does not carry the role "{role}" of client "{rules.client}"' if role else "forbidden"

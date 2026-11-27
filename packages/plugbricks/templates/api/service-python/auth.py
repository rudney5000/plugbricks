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
    scopes: list = field(default_factory=list)  # the `scope` claim, space-separated in the token


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
        return Caller(
            subject=claims["sub"],
            name=username if isinstance(username, str) else claims["sub"],
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

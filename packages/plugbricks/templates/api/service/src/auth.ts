// The token check of this service. With an identity provider in the platform (the oidc capability), plugbricks gives
// the service OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE, and the router sends every request with the caller's token.
// This service checks that token itself too: a service of the platform that calls it directly, past the router, gets
// nothing without a valid one. Without a provider none of the three is set and the service answers without a token.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Who called, from a verified token. */
export interface Caller {
  /** The token's subject (`sub`). */
  subject: string;
  /** A name to record: `preferred_username`, else `sub`. For a service account, "service-account-<client>". */
  name: string;
  /** The scopes of the token (its `scope` claim, space-separated); empty when it has none. */
  scopes: string[];
}

/** Checks an Authorization header: the caller when it carries a valid token, null otherwise. Never throws. */
export type TokenCheck = (authorization: string | undefined) => Promise<Caller | null>;

export function tokenCheck(o: { issuer: string; audience: string; keys: JWTVerifyGetKey }): TokenCheck {
  return async (authorization) => {
    // The scheme is case-insensitive (RFC 7235); the router passes the header on unchanged.
    const token = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) return null;
    try {
      // RS256 only, as the router: no "none", no symmetric algorithm with the public key as the secret.
      const { payload } = await jwtVerify(token, o.keys, {
        issuer: o.issuer,
        audience: o.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      });
      const subject = payload.sub!;
      const username = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
      return { subject, name: username ?? subject, scopes };
    } catch {
      return null;
    }
  };
}

/**
 * From OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE; undefined when none is set (no provider: no check). Some set and not
 * all: it throws, rather than serving without the check it was meant to make. A value is never printed.
 */
export function tokenCheckFromEnv(env: NodeJS.ProcessEnv): TokenCheck | undefined {
  const { OIDC_ISSUER: issuer, OIDC_JWKS_URL: jwks, OIDC_AUDIENCE: audience } = env;
  if (!issuer && !jwks && !audience) return undefined;
  if (!issuer || !jwks || !audience) {
    const missing = [!issuer && "OIDC_ISSUER", !jwks && "OIDC_JWKS_URL", !audience && "OIDC_AUDIENCE"].filter(Boolean).join(", ");
    throw new Error(`incomplete OIDC configuration: missing ${missing}; set all three or none`);
  }
  // The keys are fetched when first needed, kept, and fetched again for a key id they do not know.
  return tokenCheck({ issuer, audience, keys: createRemoteJWKSet(new URL(jwks)) });
}

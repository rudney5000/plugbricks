// The token check of this API (D20). Behind the router, every request carries the caller's token (the router passes it
// on); this API checks it again itself, so that a service of the platform calling it directly, past the router, gets
// nothing without a valid token. The same file is in apis/orders and apis/shipping.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Who called, from a verified token. */
export interface Caller {
  /** The token's subject (`sub`). */
  subject: string;
  /** A name to record: `preferred_username`, else `sub`. For a client's service account, "service-account-<client>". */
  name: string;
  /** The client the token was issued to (`azp`), when it says. */
  client?: string;
}

/** Checks an Authorization header: the caller when it carries a valid token, null otherwise. Never throws. */
export type TokenCheck = (authorization: string | undefined) => Promise<Caller | null>;

export function tokenCheck(o: { issuer: string; audience: string; keys: JWTVerifyGetKey }): TokenCheck {
  return async (authorization) => {
    // RFC 7235: the scheme is case-insensitive; the router passes the header on unchanged.
    const token = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) return null;
    try {
      // RS256 only (as the router, D19): no "none", no symmetric algorithm with the public key as secret.
      const { payload } = await jwtVerify(token, o.keys, {
        issuer: o.issuer,
        audience: o.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      });
      const subject = payload.sub!;
      const username = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
      const client = typeof payload.azp === "string" ? payload.azp : undefined;
      return { subject, name: username ?? subject, ...(client ? { client } : {}) };
    } catch {
      return null;
    }
  };
}

/**
 * From OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE, injected when the platform has an oidc provider (D20); undefined
 * without them: the API then answers without a token, as before. The keys are fetched when first needed, kept, and
 * fetched again for a key id they do not know.
 */
export function tokenCheckFromEnv(env: NodeJS.ProcessEnv): TokenCheck | undefined {
  const { OIDC_ISSUER: issuer, OIDC_JWKS_URL: jwks, OIDC_AUDIENCE: audience } = env;
  // None set: no provider, no check, as before.
  if (!issuer && !jwks && !audience) return undefined;
  // Some set: refuse to start rather than silently serve without a check. Never print a value.
  if (!issuer || !jwks || !audience) {
    const missing = [!issuer && "OIDC_ISSUER", !jwks && "OIDC_JWKS_URL", !audience && "OIDC_AUDIENCE"].filter(Boolean).join(", ");
    throw new Error(`incomplete OIDC configuration: missing ${missing}; set all three or none`);
  }
  return tokenCheck({ issuer, audience, keys: createRemoteJWKSet(new URL(jwks)) });
}

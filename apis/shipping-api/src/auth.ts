// The token check of this API (D20). Behind the router, every request carries the caller's token (the router passes it
// on); this API checks it again itself, so that a service of the platform calling it directly, past the router, gets
// nothing without a valid token. Authorization (D22) is here too: which roles that token must carry for a query and for
// a mutation. The same file is in apis/orders-api and apis/shipping-api.
import { getOperationAST, GraphQLError, type OperationTypeNode } from "graphql";
import type { Plugin } from "graphql-yoga";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Who called, from a verified token. */
export interface Caller {
  /** The token's subject (`sub`). */
  subject: string;
  /** A name to record: `preferred_username`, else `sub`. For a client's service account, "service-account-<client>". */
  name: string;
  /** The client the token was issued to (`azp`), when it says. */
  client?: string;
  /** The client roles of the token (`resource_access.<client>.roles`), by client; empty when it carries none. */
  roles: Record<string, string[]>;
}

/** The client roles a token carries, from its `resource_access` claim. Anything that is not a list of strings is ignored. */
function clientRoles(claim: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof claim !== "object" || claim === null) return out;
  for (const [client, entry] of Object.entries(claim)) {
    const roles = (entry as { roles?: unknown } | null)?.roles;
    if (Array.isArray(roles)) out[client] = roles.filter((r): r is string => typeof r === "string");
  }
  return out;
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
      return { subject, name: username ?? subject, ...(client ? { client } : {}), roles: clientRoles(payload.resource_access) };
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

/**
 * The roles this API asks of a token (D22), by operation class. `client` is the OIDC client the roles belong to: this
 * API's own (OIDC_CLIENT_ID), the one the provider made for it. A class with no role stays at D20: any valid token.
 */
export interface Authorization {
  client: string;
  queries?: string;
  mutations?: string;
}

/**
 * From AUTHORIZATION_QUERIES_ROLE and AUTHORIZATION_MUTATIONS_ROLE, injected with the oidc capability when the brick
 * declares them; undefined when neither is set (D20: a valid token is enough). Set without the token check, or without the
 * client they belong to, it throws: serving with a rule that cannot be applied would silently open the API.
 */
export function authorizationFromEnv(env: NodeJS.ProcessEnv): Authorization | undefined {
  const { AUTHORIZATION_QUERIES_ROLE: queries, AUTHORIZATION_MUTATIONS_ROLE: mutations, OIDC_CLIENT_ID: client, OIDC_ISSUER: issuer } = env;
  if (!queries && !mutations) return undefined;
  if (!issuer) throw new Error("incomplete authorization configuration: roles are set but there is no token check (OIDC_ISSUER)");
  if (!client)
    throw new Error("incomplete authorization configuration: roles are set but OIDC_CLIENT_ID, the client they belong to, is not");
  return { client, ...(queries ? { queries } : {}), ...(mutations ? { mutations } : {}) };
}

/** Whether a caller may run this class of operation. A class this API does not know (a subscription) is refused. */
export function mayRun(caller: Caller, rules: Authorization, operation: OperationTypeNode): boolean {
  if (operation !== "query" && operation !== "mutation") return false;
  const role = operation === "query" ? rules.queries : rules.mutations;
  return role === undefined || (caller.roles[rules.client] ?? []).includes(role);
}

/**
 * A GraphQL Yoga plugin that stops an operation before any resolver runs when the verified caller (in the context, see
 * createApp) lacks the role of its class. The error has the code FORBIDDEN and the HTTP status 403: the token was valid,
 * it is the caller that is not allowed (401 stays for a token that is not valid).
 */
export function authorizationPlugin(rules: Authorization): Plugin<{ caller?: Caller }> {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const operation = getOperationAST(args.document, args.operationName)?.operation;
      // No operation to run (or two, and none chosen): the execution reports that itself, nothing runs.
      if (operation === undefined) return;
      const caller = (args.contextValue as { caller?: Caller }).caller;
      if (caller && mayRun(caller, rules, operation)) return;
      const role = operation === "query" ? rules.queries : operation === "mutation" ? rules.mutations : undefined;
      const message = role ? `forbidden: this token does not carry the role "${role}" of client "${rules.client}"` : "forbidden";
      setResultAndStopExecution({ errors: [new GraphQLError(message, { extensions: { code: "FORBIDDEN", http: { status: 403 } } })] });
    },
  };
}

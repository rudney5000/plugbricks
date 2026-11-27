// The token check of this API (D20). Behind the router, every request carries the caller's token (the router passes it
// on); this API checks it again itself, so that a service of the platform calling it directly, past the router, gets
// nothing without a valid token. Authorization (D22) is here too: which roles that token must carry for a query and for
// a mutation. Rules per field (D45) are here too: what the router refuses for a field, this API refuses for a direct call.
// The same file is in apis/orders-api and apis/shipping-api.
import {
  getNamedType,
  getOperationAST,
  GraphQLError,
  isObjectType,
  Kind,
  defaultFieldResolver,
  valueFromASTUntyped,
  type ConstDirectiveNode,
  type GraphQLSchema,
  type OperationTypeNode,
} from "graphql";
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
  /** The scopes of the token (its `scope` claim, space-separated); empty when it has none. */
  scopes: string[];
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
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
      return { subject, name: username ?? subject, ...(client ? { client } : {}), roles: clientRoles(payload.resource_access), scopes };
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

/**
 * A rule of the schema (@authenticated, @requiresScopes): the caller needs every scope of one of these sets. The empty
 * set, @authenticated, asks for a verified token only; no set at all, a rule that cannot be read, lets nobody in.
 */
type Rule = string[][];

function rulesOf(directives: readonly ConstDirectiveNode[] | undefined): Rule[] {
  const rules: Rule[] = [];
  for (const d of directives ?? []) {
    if (d.name.value === "authenticated") rules.push([[]]);
    if (d.name.value !== "requiresScopes") continue;
    const value = valueFromASTUntyped(d.arguments?.find((x) => x.name.value === "scopes")?.value ?? { kind: Kind.NULL });
    const sets = Array.isArray(value) && value.every((s) => Array.isArray(s)) ? (value as unknown[][]).map((s) => s.map(String)) : [];
    rules.push(sets);
  }
  return rules;
}

/** Whether the caller satisfies the rule. Without a verified caller, none does, @authenticated included. */
export function satisfies(caller: Caller | undefined, rule: Rule): boolean {
  return caller !== undefined && rule.some((set) => set.every((scope) => caller.scopes.includes(scope)));
}

/**
 * Applies the rules the schema of this API declares (D45), the same ones the router applies (D42): a field is resolved only
 * for a caller that satisfies the rule of the field, the rule of the type it returns, the rule of the type it belongs to
 * (a type reached through _entities has no field above it), and the rule of the same field on an interface it implements.
 * A refused field is an error (FORBIDDEN) at its place, as with the router: null where the field allows it, and the
 * nearest nullable parent where it does not. Without a token check there is no caller: a protected field is refused, as
 * the router does without an identity provider. Changes the schema it is given.
 */
export function enforceFieldRules(schema: GraphQLSchema): GraphQLSchema {
  const ofType = (type: {
    astNode?: { directives?: readonly ConstDirectiveNode[] } | null;
    extensionASTNodes?: readonly { directives?: readonly ConstDirectiveNode[] }[];
  }) => rulesOf([...(type.astNode?.directives ?? []), ...(type.extensionASTNodes ?? []).flatMap((n) => n.directives ?? [])]);
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue;
    for (const field of Object.values(type.getFields())) {
      const rules = [
        ...rulesOf(field.astNode?.directives),
        ...ofType(getNamedType(field.type) as Parameters<typeof ofType>[0]),
        ...ofType(type),
        ...type.getInterfaces().flatMap((i) => rulesOf(i.getFields()[field.name]?.astNode?.directives)),
      ];
      if (rules.length === 0) continue;
      const resolve = field.resolve ?? defaultFieldResolver;
      field.resolve = (source, args, context, info) => {
        const caller = (context as { caller?: Caller } | undefined)?.caller;
        if (!rules.every((rule) => satisfies(caller, rule))) {
          const message = caller ? `forbidden: this token lacks what ${type.name}.${field.name} asks for` : "not authenticated";
          throw new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
        }
        return resolve(source, args, context, info);
      };
    }
  }
  return schema;
}

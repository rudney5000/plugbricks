import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  authorizationFromEnv,
  mayRun,
  tokenCheck,
  tokenCheckFromEnv,
  type Authorization,
  type Caller,
  type TokenCheck,
} from "../src/auth.js";

// The token check of D20, with keys made here: what passes and everything that must not.
const ISSUER = "http://127.0.0.1:8080/realms/plugbricks";
const AUDIENCE = "plugbricks-router";
let check: TokenCheck;
let sign: (claims: Record<string, unknown>, o?: { key?: CryptoKey; alg?: string; exp?: string }) => Promise<string>;
let otherKey: CryptoKey;

beforeAll(async () => {
  const good = await generateKeyPair("RS256");
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  check = tokenCheck({ issuer: ISSUER, audience: AUDIENCE, keys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: o.alg ?? "RS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(o.key ?? good.privateKey);
});

const valid = { iss: ISSUER, aud: AUDIENCE, sub: "f2c1-uuid", preferred_username: "service-account-orders-web", azp: "orders-web" };
// What Keycloak puts in a service account's token (D22): the roles of each client it holds some of.
const withRoles = { ...valid, resource_access: { orders: { roles: ["orders:read"] }, account: { roles: ["view-profile"] } } };

describe("the API's token check (D20)", () => {
  it("keeps the same auth.ts in orders and shipping", () => {
    const here = fileURLToPath(new URL("../src/auth.ts", import.meta.url));
    const shipping = fileURLToPath(new URL("../../shipping-api/src/auth.ts", import.meta.url));
    expect(readFileSync(shipping, "utf8")).toBe(readFileSync(here, "utf8"));
  });
  it("returns the caller of a valid token", async () => {
    expect(await check(`Bearer ${await sign(valid)}`)).toEqual({
      subject: "f2c1-uuid",
      name: "service-account-orders-web",
      client: "orders-web",
      roles: {},
      scopes: [],
    });
    // Without preferred_username the name is the subject.
    expect(await check(`Bearer ${await sign({ ...valid, preferred_username: undefined })}`)).toMatchObject({ name: "f2c1-uuid" });
  });

  it("reads the scopes of the token from its scope claim, as Keycloak writes it: one string, space-separated (D45)", async () => {
    expect((await check(`Bearer ${await sign({ ...valid, scope: "catalog:price email  profile" })}`))?.scopes).toEqual([
      "catalog:price",
      "email",
      "profile",
    ]);
    // Anything but a string is no scope: a list in another claim must not become one.
    expect((await check(`Bearer ${await sign({ ...valid, scope: ["catalog:price"], scp: "catalog:price" })}`))?.scopes).toEqual([]);
  });

  it("refuses a missing, malformed, expired, foreign or unsigned token", async () => {
    const refused = [
      undefined,
      "",
      "Basic dXNlcjpwYXNz",
      "Bearer not-a-jwt",
      `Bearer ${await sign(valid, { exp: "-1m" })}`,
      `Bearer ${await sign({ ...valid, iss: "http://evil.example/realms/x" })}`,
      `Bearer ${await sign({ ...valid, aud: "someone-else" })}`,
      `Bearer ${await sign({ ...valid, aud: undefined })}`,
      `Bearer ${await sign({ ...valid, sub: undefined })}`,
      `Bearer ${await sign(valid, { key: otherKey })}`,
    ];
    for (const header of refused) expect(await check(header), String(header).slice(0, 40)).toBeNull();
    // alg "none": an unsigned token with the right claims.
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    expect(await check(`Bearer ${b64({ alg: "none", typ: "JWT" })}.${b64({ ...valid, exp: now + 300 })}.`)).toBeNull();
  });

  it("reads the client roles of a token, and ignores whatever is not a list of strings (D22)", async () => {
    expect((await check(`Bearer ${await sign(withRoles)}`))?.roles).toEqual({ orders: ["orders:read"], account: ["view-profile"] });
    const odd = { orders: { roles: "orders:read" }, shipping: { roles: ["shipping:read", 7, null] }, a: null, b: "x", c: {}, d: 3 };
    expect((await check(`Bearer ${await sign({ ...valid, resource_access: odd })}`))?.roles).toEqual({ shipping: ["shipping:read"] });
    for (const claim of ["orders", 3, null, ["orders:read"]]) {
      expect((await check(`Bearer ${await sign({ ...valid, resource_access: claim })}`))?.roles, JSON.stringify(claim)).toEqual({});
    }
    // A role in realm_access or in the scope is not a role of this API's client: only resource_access counts.
    const elsewhere = { ...valid, realm_access: { roles: ["orders:read"] }, scope: "orders:read", roles: ["orders:read"] };
    expect((await check(`Bearer ${await sign(elsewhere)}`))?.roles).toEqual({});
  });

  it("accepts the bearer scheme in any case (RFC 7235)", async () => {
    expect(await check(`bearer ${await sign(valid)}`)).toMatchObject({ subject: valid.sub, name: "service-account-orders-web" });
  });

  it("refuses an incomplete oidc configuration instead of serving without a check", () => {
    const full = { OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: "http://keycloak-app:8080/certs", OIDC_AUDIENCE: AUDIENCE };
    expect(tokenCheckFromEnv({})).toBeUndefined();
    expect(tokenCheckFromEnv(full)).toBeTypeOf("function");
    const partials: [Record<string, string>, string[]][] = [
      [{ OIDC_ISSUER: ISSUER }, ["OIDC_JWKS_URL", "OIDC_AUDIENCE"]],
      [{ OIDC_JWKS_URL: full.OIDC_JWKS_URL }, ["OIDC_ISSUER", "OIDC_AUDIENCE"]],
      [{ OIDC_AUDIENCE: AUDIENCE }, ["OIDC_ISSUER", "OIDC_JWKS_URL"]],
      [{ OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: full.OIDC_JWKS_URL }, ["OIDC_AUDIENCE"]],
      [{ OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE }, ["OIDC_JWKS_URL"]],
      [{ OIDC_JWKS_URL: full.OIDC_JWKS_URL, OIDC_AUDIENCE: AUDIENCE }, ["OIDC_ISSUER"]],
    ];
    for (const [env, missing] of partials) {
      expect(() => tokenCheckFromEnv(env), JSON.stringify(env)).toThrow(/incomplete OIDC configuration/);
      expect(() => tokenCheckFromEnv(env), JSON.stringify(env)).toThrow(new RegExp(missing.join(".*")));
    }
  });
});

describe("the API behind a token check (D20)", () => {
  const pool = { query: async () => ({ rows: [] }) } as never;
  let base = "";
  let close = () => {};
  beforeAll(async () => {
    // A check that knows one token only: the server's behaviour, not the check, is under test here.
    const server = createApp(pool, async (h) => (h === "Bearer good.to.ken" ? { subject: "s", name: "n", roles: {}, scopes: [] } : null));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it("answers 401 on /graphql without a valid token, and keeps /health open", async () => {
    const ask = (headers: Record<string, string>) =>
      fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: '{"query":"{ __typename }"}',
      });
    const none = await ask({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect(await none.json()).toEqual({ errors: [{ message: "unauthorized" }] });
    expect((await ask({ authorization: "Bearer bad.to.ken" })).status).toBe(401);
    // A forged identity header proves nothing (what D20 measured against identity headers).
    expect((await ask({ "x-user-sub": "admin-forged" })).status).toBe(401);
    const ok = await ask({ authorization: "Bearer good.to.ken" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { __typename: "Query" } });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("the roles this API asks of a token (D22)", () => {
  const rules: Authorization = { client: "orders", queries: "orders:read", mutations: "orders:write" };
  const caller = (roles: Record<string, string[]>): Caller => ({ subject: "s", name: "n", roles });

  it("reads them from the environment: none, both, one, and never half a configuration", () => {
    const base = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "orders" };
    expect(authorizationFromEnv({})).toBeUndefined();
    expect(authorizationFromEnv(base)).toBeUndefined();
    expect(
      authorizationFromEnv({ ...base, AUTHORIZATION_QUERIES_ROLE: "orders:read", AUTHORIZATION_MUTATIONS_ROLE: "orders:write" }),
    ).toEqual(rules);
    expect(authorizationFromEnv({ ...base, AUTHORIZATION_QUERIES_ROLE: "orders:read" })).toEqual({
      client: "orders",
      queries: "orders:read",
    });
    // Roles without the token check or without their client: refused at start-up, not served open.
    expect(() => authorizationFromEnv({ AUTHORIZATION_QUERIES_ROLE: "orders:read", OIDC_CLIENT_ID: "orders" })).toThrow(/no token check/);
    expect(() => authorizationFromEnv({ AUTHORIZATION_MUTATIONS_ROLE: "orders:write", OIDC_ISSUER: ISSUER })).toThrow(/OIDC_CLIENT_ID/);
  });

  it("allows a class only to a token with its role under this API's own client", () => {
    expect(mayRun(caller({ orders: ["orders:read"] }), rules, "query")).toBe(true);
    expect(mayRun(caller({ orders: ["orders:read"] }), rules, "mutation")).toBe(false);
    expect(mayRun(caller({ orders: ["orders:write"] }), rules, "query")).toBe(false);
    expect(mayRun(caller({ orders: ["orders:read", "orders:write"] }), rules, "mutation")).toBe(true);
    // The same role name under another client is another API's role.
    expect(mayRun(caller({ shipping: ["orders:read"] }), rules, "query")).toBe(false);
    expect(mayRun(caller({}), rules, "query")).toBe(false);
    // A class the rules leave out is open to any valid token (D20); a class that is neither is refused.
    expect(mayRun(caller({}), { client: "orders", queries: "orders:read" }, "mutation")).toBe(true);
    expect(mayRun(caller({ orders: ["orders:read"] }), rules, "subscription")).toBe(false);
  });
});

describe("the API with roles: 401 for no token, 403 for a token without the role (D22)", () => {
  const rules: Authorization = { client: "orders", queries: "orders:read", mutations: "orders:write" };
  const calls: string[] = [];
  // A pool that records what reaches it and answers like the database: the row has the name that createOrder was given.
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      return { rows: [{ id: "1", total: 5, status: "pending", createdBy: params?.[1] ?? null }] };
    },
  } as never;
  const tokens: Record<string, Caller> = {
    "Bearer reader.to.ken": { subject: "s", name: "reader", roles: { orders: ["orders:read"] }, scopes: [] },
    "Bearer writer.to.ken": { subject: "s", name: "writer", roles: { orders: ["orders:read", "orders:write"] }, scopes: [] },
    "Bearer none.to.ken": { subject: "s", name: "norole", roles: {}, scopes: [] },
    "Bearer other.to.ken": { subject: "s", name: "other", roles: { shipping: ["orders:read", "orders:write"] }, scopes: [] },
  };
  let base = "";
  let close = () => {};
  beforeAll(async () => {
    const server = createApp(pool, async (h) => tokens[h ?? ""] ?? null, rules);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const ask = async (query: string, token?: string, operationName?: string) => {
    const r = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
      body: JSON.stringify({ query, ...(operationName ? { operationName } : {}) }),
    });
    return {
      status: r.status,
      body: (await r.json()) as { data?: unknown; errors?: { message: string; extensions?: { code?: string } }[] },
    };
  };
  const READ = "{ orders(limit: 1) { id } }";
  const WRITE = "mutation { createOrder(total: 5) { id createdBy } }";

  it("refuses a valid token without the role of the class, before any resolver runs", async () => {
    calls.length = 0;
    for (const token of ["Bearer none.to.ken", "Bearer other.to.ken"]) {
      const read = await ask(READ, token);
      expect(read.status, token).toBe(403);
      expect(read.body.errors?.[0]).toMatchObject({ extensions: { code: "FORBIDDEN" }, message: expect.stringContaining("orders:read") });
      expect(read.body.data).toBeUndefined();
      expect((await ask(WRITE, token)).status, token).toBe(403);
    }
    const readerWrites = await ask(WRITE, "Bearer reader.to.ken");
    expect(readerWrites.status).toBe(403);
    expect(readerWrites.body.errors?.[0].message).toContain("orders:write");
    // Nothing reached the database.
    expect(calls).toEqual([]);
  });

  it("lets a token with the role through, per class", async () => {
    const read = await ask(READ, "Bearer reader.to.ken");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ data: { orders: [{ id: "1" }] } });
    const wrote = await ask(WRITE, "Bearer writer.to.ken");
    expect(wrote.status).toBe(200);
    // createdBy is still the verified caller (D20), whatever the role.
    expect(wrote.body.data).toEqual({ createOrder: { id: "1", createdBy: "writer" } });
    // The role of reading comes with the writer's token too, since it holds both.
    expect((await ask(READ, "Bearer writer.to.ken")).status).toBe(200);
  });

  it("keeps 401 for a token that is not valid, and /health open", async () => {
    expect((await ask(READ)).status).toBe(401);
    expect((await ask(READ, "Bearer bad.to.ken")).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("decides on the operation that runs, not on the first one in the document", async () => {
    const both = `query Read { orders(limit: 1) { id } } mutation Write { createOrder(total: 5) { id } }`;
    expect((await ask(both, "Bearer reader.to.ken", "Read")).status).toBe(200);
    expect((await ask(both, "Bearer reader.to.ken", "Write")).status).toBe(403);
    // No operation name among two: nothing runs, and nothing is run for anyone.
    calls.length = 0;
    const unnamed = await ask(both, "Bearer none.to.ken");
    expect(unnamed.status).not.toBe(200);
    expect(calls).toEqual([]);
  });

  it("also guards the federation entry points: _entities and _service are queries", async () => {
    const entities = `{ _entities(representations: [{ __typename: "Order", id: "1" }]) { ... on Order { id } } }`;
    expect((await ask(entities, "Bearer none.to.ken")).status).toBe(403);
    expect((await ask("{ _service { sdl } }", "Bearer none.to.ken")).status).toBe(403);
    expect((await ask(entities, "Bearer reader.to.ken")).status).toBe(200);
  });

  it("serves a class the rules leave out to any valid token (D20)", async () => {
    const server = createApp(pool, async (h) => tokens[h ?? ""] ?? null, { client: "orders", queries: "orders:read" });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
      const post = (query: string, token: string) =>
        fetch(at, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: token },
          body: JSON.stringify({ query }),
        });
      expect((await post(WRITE, "Bearer none.to.ken")).status).toBe(200);
      expect((await post(READ, "Bearer none.to.ken")).status).toBe(403);
    } finally {
      server.close();
    }
  });
});

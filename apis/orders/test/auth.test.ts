import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { tokenCheck, tokenCheckFromEnv, type TokenCheck } from "../src/auth.js";

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

describe("the API's token check (D20)", () => {
  it("keeps the same auth.ts in orders and shipping", () => {
    const here = fileURLToPath(new URL("../src/auth.ts", import.meta.url));
    const shipping = fileURLToPath(new URL("../../shipping/src/auth.ts", import.meta.url));
    expect(readFileSync(shipping, "utf8")).toBe(readFileSync(here, "utf8"));
  });
  it("returns the caller of a valid token", async () => {
    expect(await check(`Bearer ${await sign(valid)}`)).toEqual({
      subject: "f2c1-uuid",
      name: "service-account-orders-web",
      client: "orders-web",
    });
    // Without preferred_username the name is the subject.
    expect(await check(`Bearer ${await sign({ ...valid, preferred_username: undefined })}`)).toMatchObject({ name: "f2c1-uuid" });
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
    const server = createApp(pool, async (h) => (h === "Bearer good.to.ken" ? { subject: "s", name: "n" } : null));
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

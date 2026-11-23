import { describe, expect, it } from "vitest";
import { EXPIRY_MARGIN_SECONDS, TokenSource } from "../src/token.js";

function endpoint(answers: { status?: number; body: object }[]) {
  const calls: URLSearchParams[] = [];
  const http = (async (_url: string, init: RequestInit) => {
    calls.push(new URLSearchParams(init.body as URLSearchParams));
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { calls, http };
}

describe("the token for the router (D19)", () => {
  it("asks with the client credentials, and keeps the token until shortly before it expires", async () => {
    let now = 0;
    const e = endpoint([{ body: { access_token: "t1", expires_in: 300 } }, { body: { access_token: "t2", expires_in: 300 } }]);
    const tokens = new TokenSource("http://kc/token", "orders-web", "s3cr3t", e.http, () => now);
    expect(await tokens.get()).toBe("t1");
    expect(Object.fromEntries(e.calls[0])).toEqual({ grant_type: "client_credentials", client_id: "orders-web", client_secret: "s3cr3t" });
    now = (300 - EXPIRY_MARGIN_SECONDS - 1) * 1000;
    expect(await tokens.get()).toBe("t1");
    now = (300 - EXPIRY_MARGIN_SECONDS) * 1000;
    expect(await tokens.get()).toBe("t2");
    expect(e.calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const e = endpoint([{ body: { access_token: "t1", expires_in: 300 } }]);
    const tokens = new TokenSource("http://kc/token", "orders-web", "s", e.http);
    expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual(["t1", "t1", "t1"]);
    expect(e.calls).toHaveLength(1);
  });

  it("says why when the endpoint refuses, without the secret, and asks again next time", async () => {
    const e = endpoint([{ status: 401, body: { error: "unauthorized_client" } }, { body: { access_token: "t1", expires_in: 300 } }]);
    const tokens = new TokenSource("http://kc/token", "orders-web", "s3cr3t", e.http);
    const refused = await tokens.get().catch((err: Error) => err.message);
    expect(refused).toBe("the token endpoint answered 401 unauthorized_client");
    expect(refused).not.toContain("s3cr3t");
    expect(await tokens.get()).toBe("t1");
  });

  it("forgets a token the router refused, and keeps a newer one", async () => {
    const e = endpoint([{ body: { access_token: "t1", expires_in: 300 } }, { body: { access_token: "t2", expires_in: 300 } }]);
    const tokens = new TokenSource("http://kc/token", "orders-web", "s", e.http);
    expect(await tokens.get()).toBe("t1");
    tokens.invalidate("t1");
    expect(await tokens.get()).toBe("t2");
    tokens.invalidate("t1");
    expect(await tokens.get()).toBe("t2");
    expect(e.calls).toHaveLength(2);
  });

  it("is absent when the platform has no oidc provider", () => {
    expect(TokenSource.fromEnv({})).toBeUndefined();
    expect(TokenSource.fromEnv({ OIDC_TOKEN_URL: "u", OIDC_CLIENT_ID: "i", OIDC_CLIENT_SECRET: "s" })?.clientId).toBe("i");
  });
});

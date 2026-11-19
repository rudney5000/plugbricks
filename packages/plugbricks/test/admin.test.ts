import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SESSION_TTL_MS, startAdmin, type AdminOptions, type AdminServer } from "../src/admin/server.js";
import { main } from "../src/cli.js";
import type { AsyncExec } from "../src/runtime.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = join(pkg, ".test-work/admin");
const io = { cwd: root, stdout: () => {}, stderr: () => {} };
const opened: { close: () => void }[] = [];

/** The admin only reads the runtime: a compose ps that lists nothing is enough for these tests. */
const emptyRuntime = { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) };

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  writeFileSync(join(root, "ui", "index.html"), "<!doctype html><title>admin ui</title>");
  cpSync(join(pkg, "examples/postgres"), join(root, "postgres"), { recursive: true });
  expect(main(["init", "--name", "demo"], io)).toBe(0);
  expect(main(["add", "postgres"], io)).toBe(0);
});

afterEach(() => {
  for (const o of opened.splice(0)) o.close();
});

async function start(options: Partial<AdminOptions> = {}): Promise<{ base: string; admin: AdminServer }> {
  const admin = startAdmin({
    root,
    runtime: "compose",
    port: 0,
    dev: true,
    uiDir: join(root, "ui"),
    runtimeDeps: emptyRuntime,
    ...options,
  });
  opened.push(admin);
  return { base: `http://127.0.0.1:${await admin.ready}`, admin };
}

interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request with full control of the headers (fetch does not let a test set Host). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Raw> {
  return new Promise((done, fail) => {
    const req = request(`${base}${path}`, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

/** `name=value` of a Set-Cookie of the response, without its attributes. */
function cookieOf(r: Raw, name: string): string | undefined {
  return (r.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`));
}

// ---------- a local OIDC provider: discovery, keys and a token endpoint, nothing else ----------

interface Expected {
  code: string;
  nonce: string;
  challenge: string;
  claims: Record<string, unknown>;
}

interface FakeIdp {
  issuer: string;
  server: Server;
  expect: (e: Expected) => void;
  tokenRequests: number;
}

const CLIENT_ID = "plugbricks-admin";
const CLIENT_SECRET = "test-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function idToken(payload: Record<string, unknown>): string {
  const signed = `${b64({ alg: "RS256", typ: "JWT", kid: "test" })}.${b64(payload)}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(privateKey).toString("base64url")}`;
}

async function fakeIdp(port = 0): Promise<FakeIdp> {
  let expected: Expected | undefined;
  const idp: FakeIdp = {
    issuer: "",
    server: createServer((req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/.well-known/openid-configuration") {
        return json(200, {
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (req.url === "/jwks") return json(200, { keys: [jwk] });
      if (req.url === "/token" && req.method === "POST") {
        let body = "";
        req.setEncoding("utf8").on("data", (d: string) => (body += d));
        req.on("end", () => {
          idp.tokenRequests++;
          const form = new URLSearchParams(body);
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!expected || form.get("code") !== expected.code || challenge !== expected.challenge) {
            return json(400, { error: "invalid_grant" });
          }
          const t = Math.floor(Date.now() / 1000);
          json(200, {
            access_token: "access",
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken({
              iss: idp.issuer,
              aud: CLIENT_ID,
              sub: "user-1",
              iat: t,
              exp: t + 300,
              nonce: expected.nonce,
              ...expected.claims,
            }),
          });
        });
        return;
      }
      json(404, { error: "not_found" });
    }),
    expect: (e) => (expected = e),
    tokenRequests: 0,
  };
  await new Promise<void>((ok) => idp.server.listen(port, "127.0.0.1", ok));
  idp.issuer = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;
  opened.push(idp.server);
  return idp;
}

/** /auth/login, then what the provider would send the browser back with, as that browser. */
async function signIn(base: string, idp: FakeIdp, claims: Record<string, unknown>, opts: { stateCookie?: boolean } = {}) {
  const login = await raw(base, "/auth/login");
  expect(login.status).toBe(302);
  const to = new URL(login.headers.location!);
  expect(to.origin + to.pathname).toBe(`${idp.issuer}/authorize`);
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  const state = to.searchParams.get("state")!;
  const stateCookie = cookieOf(login, "pb_oidc_state");
  expect(stateCookie).toBe(`pb_oidc_state=${state}`);
  idp.expect({ code: `code-${state}`, nonce: to.searchParams.get("nonce")!, challenge: to.searchParams.get("code_challenge")!, claims });
  const callback = `/auth/callback?code=code-${state}&state=${state}`;
  const back = await raw(base, callback, { headers: opts.stateCookie === false ? {} : { cookie: stateCookie! } });
  return { back, callback, stateCookie: stateCookie!, session: cookieOf(back, "pb_admin") };
}

async function startOidc(idp: FakeIdp, options: Partial<AdminOptions> = {}) {
  return start({ dev: false, issuer: idp.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...options });
}

describe("the admin server", () => {
  it("serves the read-only API in dev mode, with the brick metadata the UI needs", async () => {
    const { base } = await start();
    const session = await fetch(`${base}/api/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, dev: true, role: "admin", project: "demo", runtime: "compose" });

    const bricks = (await (await fetch(`${base}/api/bricks`)).json()) as { summary: { total: number }; bricks: unknown[] };
    expect(bricks.summary.total).toBe(1);
    expect(bricks.bricks[0]).toMatchObject({
      name: "postgres",
      version: "1.0.0",
      tags: ["database"],
      enabled: true,
      port: 5432,
      subgraph: false,
      requires: "",
      state: "not deployed",
      restarts: 0,
    });

    expect(((await (await fetch(`${base}/api/audit`)).json()) as { entries: unknown[] }).entries).toEqual([]);
    expect(await (await fetch(`${base}/router`)).text()).toContain("admin ui");
  });

  it("refuses the API without a session when dev mode is off", async () => {
    const { base } = await start({ dev: false });
    expect((await fetch(`${base}/api/session`)).status).toBe(401);
    expect((await fetch(`${base}/api/bricks`)).status).toBe(401);
    expect((await fetch(`${base}/api/audit`)).status).toBe(401);
  });

  it("answers only requests addressed to its loopback name, from no other origin (DNS rebinding)", async () => {
    const { base } = await start();
    const port = new URL(base).port;
    expect((await raw(base, "/api/bricks", { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await raw(base, "/", { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await raw(base, "/api/session", { headers: { host: "127.0.0.1:1" } })).status).toBe(403);
    expect((await raw(base, "/api/session", { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await raw(base, "/api/session", { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await raw(base, "/api/session", { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
  });

  it("sends security headers, a CSP on the page, and never leaves the UI folder", async () => {
    const { base } = await start();
    const page = await raw(base, "/");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect((await raw(base, "/api/session")).headers["x-content-type-options"]).toBe("nosniff");
    // ../ in any spelling falls back to the page, never to a file outside the UI folder.
    for (const p of ["/../package.json", "/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json"]) {
      expect((await raw(base, p)).body).toContain("admin ui");
    }
    expect((await raw(base, "/%E0%A4%A")).status).toBe(400);
    expect((await raw(base, "/", { method: "POST" })).status).toBe(405);
  });

  it("reads the runtime without blocking other requests, and shares one read between concurrent pages", async () => {
    let calls = 0;
    const slow: AsyncExec = async (_cmd, args) => {
      calls++;
      await new Promise((r) => setTimeout(r, 300));
      return { status: 0, stdout: args.includes("ps") ? "[]" : "Docker Compose version v2", stderr: "" };
    };
    const { base } = await start({ runtimeDeps: { execAsync: slow } });
    const started = Date.now();
    const pages = [fetch(`${base}/api/bricks`), fetch(`${base}/api/bricks`)];
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(250);
    for (const page of await Promise.all(pages)) expect(page.status).toBe(200);
    // docker compose version, then ps: two calls for both pages.
    expect(calls).toBe(2);
  });

  it("reports an unreadable runtime as 503 RUNTIME_UNAVAILABLE", async () => {
    const missing: AsyncExec = async () => ({ status: null, stdout: "", stderr: "", error: "ENOENT" });
    const { base } = await start({ runtimeDeps: { execAsync: missing } });
    const r = await raw(base, "/api/bricks");
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ error: "RUNTIME_UNAVAILABLE" });
  });

  it("signs out only with POST, and the session is gone after it", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp);
    const { session } = await signIn(base, idp, { realm_access: { roles: ["plugbricks-viewer"] } });
    expect((await raw(base, "/auth/logout", { headers: { cookie: session! } })).status).toBe(405);
    expect((await raw(base, "/api/session", { headers: { cookie: session! } })).status).toBe(200);
    const out = await raw(base, "/auth/logout", { method: "POST", headers: { cookie: session! } });
    expect(out.status).toBe(302);
    expect(cookieOf(out, "pb_admin")).toBe("pb_admin=");
    expect((await raw(base, "/api/session", { headers: { cookie: session! } })).status).toBe(401);
  });
});

describe("the admin sign-in (OIDC, against a local provider)", () => {
  it("gives an admin session for plugbricks-admin, read from the ID token", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp);
    const { back, session } = await signIn(base, idp, { name: "Ada", realm_access: { roles: ["plugbricks-admin"] } });
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe("/");
    expect(cookieOf(back, "pb_oidc_state")).toBe("pb_oidc_state=");
    expect(back.headers["set-cookie"]!.find((c) => c.startsWith("pb_admin="))).toMatch(/HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800/);
    const me = await raw(base, "/api/session", { headers: { cookie: session! } });
    expect(JSON.parse(me.body)).toMatchObject({ authenticated: true, dev: false, role: "admin", name: "Ada" });
    expect((await raw(base, "/api/bricks", { headers: { cookie: session! } })).status).toBe(200);
  });

  it("gives a viewer session for plugbricks-viewer, from a plain roles claim too", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp);
    const { session } = await signIn(base, idp, { roles: ["plugbricks-viewer"] });
    expect(JSON.parse((await raw(base, "/api/session", { headers: { cookie: session! } })).body)).toMatchObject({ role: "viewer" });
  });

  it("refuses an account with neither role, and gives it no session", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp);
    const { back, session } = await signIn(base, idp, { realm_access: { roles: ["someone-else"] } });
    expect(back.status).toBe(403);
    expect(session).toBeUndefined();
  });

  it("refuses a callback from a sign-in this browser did not start (login CSRF), and a state used twice", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp);
    const { back, callback, stateCookie } = await signIn(base, idp, { roles: ["plugbricks-admin"] }, { stateCookie: false });
    expect(back.status).toBe(400);
    expect(back.body).toContain("not started in this browser");
    expect(idp.tokenRequests).toBe(0);
    // A wrong cookie is refused the same way.
    expect((await raw(base, callback, { headers: { cookie: "pb_oidc_state=other" } })).status).toBe(400);
    // The rightful browser can still finish it once, and only once.
    expect((await raw(base, callback, { headers: { cookie: stateCookie } })).status).toBe(302);
    expect((await raw(base, callback, { headers: { cookie: stateCookie } })).status).toBe(400);
  });

  it("ends a session on the server after 8 hours, whatever the cookie says", async () => {
    let clock = Date.now();
    const idp = await fakeIdp();
    const { base } = await startOidc(idp, { now: () => clock });
    const { session } = await signIn(base, idp, { roles: ["plugbricks-admin"] });
    clock += SESSION_TTL_MS - 1000;
    expect((await raw(base, "/api/session", { headers: { cookie: session! } })).status).toBe(200);
    clock += 1000;
    expect((await raw(base, "/api/session", { headers: { cookie: session! } })).status).toBe(401);
  });

  it("tries the discovery again after a provider that was not up yet", async () => {
    const probe = await fakeIdp();
    const port = Number(new URL(probe.issuer).port);
    await new Promise((ok) => probe.server.close(ok));
    const lines: string[] = [];
    const { base } = await start({
      dev: false,
      issuer: `http://127.0.0.1:${port}`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      log: (l) => lines.push(l),
    });
    const first = await raw(base, "/auth/login");
    expect(first.status).toBe(502);
    expect(first.body).not.toContain("ECONNREFUSED");
    expect(lines.some((l) => l.includes("OIDC discovery failed"))).toBe(true);
    await fakeIdp(port);
    expect((await raw(base, "/auth/login")).status).toBe(302);
  });

  it("refuses an http issuer that is not on the loopback address", () => {
    for (const issuer of ["http://idp.example", "ftp://127.0.0.1", "not a url"]) {
      expect(() =>
        startAdmin({
          root,
          runtime: "compose",
          port: 0,
          dev: false,
          uiDir: join(root, "ui"),
          issuer,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
      ).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ code: "ADMIN_OIDC_ISSUER_INVALID" })] }));
    }
  });
});

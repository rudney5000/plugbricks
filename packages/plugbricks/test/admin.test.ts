import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ActionRecord } from "../src/admin/actions.js";
import { SESSION_TTL_MS, startAdmin, type AdminOptions, type AdminServer } from "../src/admin/server.js";
import { main } from "../src/cli.js";
import type { AsyncExec } from "../src/runtime.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = join(pkg, ".test-work/admin");
const io = { cwd: root, stdout: () => {}, stderr: () => {} };
const opened: { close: () => void }[] = [];
const fakeCli = join(root, "fake-cli.mjs");
const fakeLog = join(root, "fake-cli.log");
const cliOptions = { cli: { cmd: process.execPath, args: [fakeCli] } };
const TEST_SECRET = "oidc-client-secret-for-the-test";

/** The admin only reads the runtime: a compose ps that lists nothing is enough for these tests. */
const emptyRuntime = { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) };

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  writeFileSync(join(root, "ui", "index.html"), "<!doctype html><title>admin ui</title>");
  cpSync(join(pkg, "examples/postgres"), join(root, "postgres"), { recursive: true });
  expect(main(["init", "--name", "demo"], io)).toBe(0);
  expect(main(["add", "postgres"], io)).toBe(0);
  process.env.PLUGBRICKS_OIDC_CLIENT_SECRET = TEST_SECRET;
  process.env.PB_FAKE_LOG = fakeLog;
  writeFileSync(
    fakeCli,
    `import { appendFileSync } from "node:fs";
const log = process.env.PB_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + String.fromCharCode(10));
console.log("fake cli started");
const mode = process.env.PB_FAKE_MODE ?? "ok";
if (mode === "slow") {
  setTimeout(() => process.exit(0), 700);
} else if (mode === "busy") {
  console.error("error PLATFORM_BUSY: another command is changing the platform");
  process.exit(1);
} else if (mode === "refused") {
  console.error("error CAPABILITY_IN_USE: postgres is required by orders");
  process.exit(1);
} else if (mode === "failed") {
  console.error("something broke");
  process.exit(3);
} else if (mode === "usage") {
  console.error("error USAGE_MISSING_ARGUMENT: nope");
  process.exit(2);
} else {
  process.exit(0);
}
`,
  );
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

function clearFake(): void {
  rmSync(fakeLog, { force: true });
}

function fakeRuns(): { argv: string[]; env: Record<string, string> }[] {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
}

function auditLines(): { time: string; user: string; role: string; action: string; brick: string; result: string; details: string }[] {
  const file = join(root, ".admin", "audit.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReturnType<typeof auditLines>[number]);
}

function postAction(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Raw> {
  return raw(base, "/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitAction(base: string, id: string, cookie?: string, ms = 5000): Promise<ActionRecord> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await raw(base, `/api/actions/${encodeURIComponent(id)}`, cookie ? { headers: { cookie } } : {});
    if (r.status !== 200) throw new Error(`GET /api/actions/${id}: ${r.status} ${r.body}`);
    const a = JSON.parse(r.body) as ActionRecord;
    if (a.state !== "running") return a;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`action ${id} did not finish in ${ms}ms`);
}

/** One request with full control of the headers (fetch does not let a test set Host). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Raw> {
  return new Promise((done, fail) => {
    const req = request(`${base}${path}`, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
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
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
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

  it("serves the router configuration and the composed schema", async () => {
    const routerRoot = join(pkg, ".test-work/admin-router");
    rmSync(routerRoot, { recursive: true, force: true });
    mkdirSync(routerRoot, { recursive: true });
    cpSync(join(pkg, "examples"), join(routerRoot, "examples"), { recursive: true });
    const rio = { cwd: routerRoot, stdout: () => {}, stderr: () => {} };
    for (const args of [
      ["init", "--name", "router-demo"],
      ["add", "examples/postgres"],
      ["add", "examples/orders"],
      ["add", "examples/shipping"],
    ]) {
      expect(main(args, rio), args.join(" ")).toBe(0);
    }
    const { base } = await start({ root: routerRoot });
    const view = (await (await fetch(`${base}/api/bricks`)).json()) as {
      router: {
        config: {
          sha256: string;
          size: number;
          source: string;
          federatedSdl: string;
          composition: { subgraphs: number; extendedEntities: string[] };
        };
        subgraphs: unknown[];
      };
    };
    expect(view.router.config.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.router.config.size).toBeGreaterThan(0);
    expect(view.router.config.source).toBe(".generated/compose/router-config.json");
    expect(view.router.config.composition).toEqual({ subgraphs: 2, extendedEntities: ["Order"] });
    expect(view.router.config.federatedSdl).toContain("type Order");
    expect(view.router.config.federatedSdl).toContain("shipment");
    expect(view.router.subgraphs).toHaveLength(2);
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

  it("signs in a public client, with PKCE and no client secret", async () => {
    const idp = await fakeIdp();
    const { base } = await startOidc(idp, { clientSecret: undefined });
    const { back, session } = await signIn(base, idp, { realm_access: { roles: ["plugbricks-admin"] } });
    expect(back.status).toBe(302);
    expect(JSON.parse((await raw(base, "/api/session", { headers: { cookie: session! } })).body)).toMatchObject({ role: "admin" });
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

describe("the admin actions", () => {
  it("needs an admin: 401 without a session, 403 for a viewer, 202 for an admin and in dev", async () => {
    const anon = await start({ dev: false, ...cliOptions });
    expect((await postAction(anon.base, { action: "up" })).status).toBe(401);

    const idp = await fakeIdp();
    const oidc = await startOidc(idp, cliOptions);
    const viewer = await signIn(oidc.base, idp, { roles: ["plugbricks-viewer"] });
    clearFake();
    const denied = await postAction(oidc.base, { action: "up" }, { cookie: viewer.session! });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).error).toBe("FORBIDDEN");
    expect(fakeRuns()).toEqual([]);
    expect((await raw(oidc.base, "/api/actions", { headers: { cookie: viewer.session! } })).status).toBe(200);

    const admin = await signIn(oidc.base, idp, { roles: ["plugbricks-admin"] });
    const allowed = await postAction(oidc.base, { action: "up" }, { cookie: admin.session! });
    expect(allowed.status).toBe(202);
    await waitAction(oidc.base, JSON.parse(allowed.body).id, admin.session!);

    const dev = await start(cliOptions);
    const devAllowed = await postAction(dev.base, { action: "up" });
    expect(devAllowed.status).toBe(202);
    await waitAction(dev.base, JSON.parse(devAllowed.body).id);
  });

  it("validates the request before starting the CLI", async () => {
    const { base } = await start(cliOptions);
    clearFake();
    const cases: [unknown, string][] = [
      [{}, "INVALID_ACTION"],
      [{ action: "explode" }, "INVALID_ACTION"],
      [{ action: "enable" }, "INVALID_BRICK"],
      [{ action: "enable", brick: "../postgres" }, "INVALID_BRICK"],
      [{ action: "disable", brick: "Postgres" }, "INVALID_BRICK"],
      [{ action: "remove", brick: "-postgres" }, "INVALID_BRICK"],
      [{ action: "remove", brick: "postgres/1" }, "INVALID_BRICK"],
      [{ action: "add" }, "INVALID_SOURCE"],
      [{ action: "add", source: "" }, "INVALID_SOURCE"],
      [{ action: "add", source: "-x" }, "INVALID_SOURCE"],
      [{ action: "add", source: "/abs" }, "INVALID_SOURCE"],
      [{ action: "add", source: "\\abs" }, "INVALID_SOURCE"],
      [{ action: "add", source: "../x" }, "INVALID_SOURCE"],
      [{ action: "add", source: "a/../b" }, "INVALID_SOURCE"],
      [{ action: "add", source: "a\\..\\b" }, "INVALID_SOURCE"],
      [{ action: "add", source: "C:\\x" }, "INVALID_SOURCE"],
      [{ action: "add", source: "a\0b" }, "INVALID_SOURCE"],
      [{ action: "add", source: "x", brick: "postgres" }, "UNEXPECTED_FIELD"],
      [{ action: "enable", brick: "postgres", source: "x" }, "UNEXPECTED_FIELD"],
      [{ action: "up", brick: "postgres" }, "UNEXPECTED_FIELD"],
      [{ action: "up", source: "x" }, "UNEXPECTED_FIELD"],
      [{ action: "up", extra: true }, "UNEXPECTED_FIELD"],
    ];
    for (const [body, code] of cases) {
      const r = await postAction(base, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.body).error, JSON.stringify(body)).toBe(code);
    }

    const wrongType = await raw(base, "/api/actions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "up" }),
    });
    expect(wrongType.status).toBe(400);
    expect(JSON.parse(wrongType.body).error).toBe("CONTENT_TYPE");

    const badJson = await raw(base, "/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(badJson.status).toBe(400);
    expect(JSON.parse(badJson.body).error).toBe("INVALID_JSON");

    const huge = await raw(base, "/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "a".repeat(17 * 1024),
    });
    expect(huge.status).toBe(400);
    expect(JSON.parse(huge.body).error).toBe("BODY_TOO_LARGE");
    expect(fakeRuns()).toEqual([]);
  });

  it("runs the CLI with exactly the right argv, and without the OIDC secret", async () => {
    const { base } = await start(cliOptions);
    clearFake();
    const run = async (body: unknown) => {
      const r = await postAction(base, body);
      expect(r.status).toBe(202);
      const a = await waitAction(base, JSON.parse(r.body).id);
      expect(a.state).toBe("succeeded");
      return a;
    };
    await run({ action: "add", source: "examples/postgres" });
    const enabled = await run({ action: "enable", brick: "postgres" });
    expect(enabled.output).toContain("fake cli started");
    await run({ action: "disable", brick: "postgres" });
    await run({ action: "remove", brick: "postgres" });
    await run({ action: "up" });

    expect(fakeRuns().map((r) => r.argv)).toEqual([
      ["add", "examples/postgres"],
      ["enable", "postgres"],
      ["disable", "postgres"],
      ["remove", "postgres"],
      ["up", "--runtime", "compose"],
    ]);
    for (const r of fakeRuns()) expect("PLUGBRICKS_OIDC_CLIENT_SECRET" in r.env).toBe(false);
    expect((await raw(base, "/api/actions")).status).toBe(200);
  });

  it("passes the runtime and the k8s flags to up, and only to up", async () => {
    const { base } = await start({
      ...cliOptions,
      runtime: "k8s",
      k8s: { context: "k3d-pbtest-admin", kubeconfig: "/tmp/kubeconfig", allowContext: "k3d-pbtest-admin" },
    });
    clearFake();
    const up = await postAction(base, { action: "up" });
    expect(up.status).toBe(202);
    await waitAction(base, JSON.parse(up.body).id);
    const enable = await postAction(base, { action: "enable", brick: "postgres" });
    await waitAction(base, JSON.parse(enable.body).id);
    expect(fakeRuns().map((r) => r.argv)).toEqual([
      ["up", "--runtime", "k8s", "--context", "k3d-pbtest-admin", "--kubeconfig", "/tmp/kubeconfig", "--allow-context", "k3d-pbtest-admin"],
      ["enable", "postgres"],
    ]);
  });

  it("answers 409 while one runs, and stays responsive", async () => {
    const { base } = await start(cliOptions);
    clearFake();
    process.env.PB_FAKE_MODE = "slow";
    try {
      const first = await postAction(base, { action: "up" });
      expect(first.status).toBe(202);
      const id = JSON.parse(first.body).id;
      const second = await postAction(base, { action: "enable", brick: "postgres" });
      expect(second.status).toBe(409);
      expect(JSON.parse(second.body)).toMatchObject({ error: "BUSY", running: id });
      const started = Date.now();
      expect((await fetch(`${base}/api/session`)).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(500);
      expect((await waitAction(base, id)).state).toBe("succeeded");
    } finally {
      delete process.env.PB_FAKE_MODE;
    }
  });

  it("reports the child's issue codes, and writes two audit lines per action", async () => {
    const { base } = await start(cliOptions);
    rmSync(join(root, ".admin"), { recursive: true, force: true });
    const modes: [string, string, string[]][] = [
      ["busy", "Refused", ["PLATFORM_BUSY"]],
      ["refused", "Refused", ["CAPABILITY_IN_USE"]],
      ["failed", "Failed", []],
      ["usage", "Refused", ["USAGE_MISSING_ARGUMENT"]],
    ];
    for (const [mode, result, issues] of modes) {
      clearFake();
      process.env.PB_FAKE_MODE = mode;
      try {
        const r = await postAction(base, { action: "enable", brick: "postgres" });
        expect(r.status).toBe(202);
        const id = JSON.parse(r.body).id;
        const action = await waitAction(base, id);
        expect(action.state).toBe("failed");
        expect(action.issues).toEqual(issues);
        const lines = auditLines().filter((l) => l.details.includes(id));
        expect(lines, mode).toHaveLength(2);
        expect(lines[0].result).toBe("Accepted");
        expect(lines[1].result).toBe(result);
        expect(lines[0].details).toContain(id);
        expect(lines[1].details).toContain(id);
        expect(JSON.stringify(lines)).not.toContain("fake cli started");
        expect(JSON.stringify(lines)).not.toContain(TEST_SECRET);
      } finally {
        delete process.env.PB_FAKE_MODE;
      }
    }
    if (process.platform !== "win32") {
      expect(statSync(join(root, ".admin")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, ".admin", "audit.log")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, ".admin", ".gitignore"), "utf8").trim()).toBe("*");
    }
  });

  it("lists the actions and 404s an unknown one", async () => {
    const { base } = await start(cliOptions);
    clearFake();
    const r = await postAction(base, { action: "enable", brick: "postgres" });
    const id = JSON.parse(r.body).id;
    await waitAction(base, id);
    const list = (await (await fetch(`${base}/api/actions`)).json()) as { actions: ActionRecord[] };
    expect(list.actions[0].id).toBe(id);
    expect((await raw(base, "/api/actions/nope")).status).toBe(404);
  });

  it("refuses a cross-site POST before anything runs", async () => {
    const { base } = await start(cliOptions);
    clearFake();
    const port = new URL(base).port;
    const wrongHost = await raw(base, "/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", host: `evil.example:${port}` },
      body: JSON.stringify({ action: "up" }),
    });
    expect(wrongHost.status).toBe(403);
    const wrongOrigin = await raw(base, "/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ action: "up" }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(fakeRuns()).toEqual([]);
  });
});

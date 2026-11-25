import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Configuration } from "openid-client";
import { ActionRunner, validateAction } from "./actions.js";
import { issue, type Issue } from "../issues.js";
import { SEVERITY } from "../live.js";
import { platformStatus, PlugbricksError, readProject, removeRefusals } from "../platform.js";
import { loadInstalledBricks, planProject, type BrickManifest } from "../plan.js";
import { RuntimeUnavailableError, statusRuntimeAsync, type AsyncExec, type K8sTarget, type Runtime, type RuntimeDeps } from "../runtime.js";

export interface AdminOptions {
  root: string;
  runtime: Runtime;
  port: number;
  /** Local development: no OIDC, every request is an admin. Refused by the CLI unless requested. */
  dev: boolean;
  /** The directory of the built React UI (packages/admin/dist). */
  uiDir: string;
  k8s?: K8sTarget;
  /** Tests inject the runtime tools; the admin itself reads only. */
  runtimeDeps?: Omit<RuntimeDeps, "log"> & { execAsync?: AsyncExec };
  /** Tests run a fake CLI; the real one is the built bin run by this node. */
  cli?: { cmd: string; args: string[] };
  /** How long an action may run before SIGKILL; tests may shorten it. */
  actionTimeoutMs?: number;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  log?: (line: string) => void;
  /** Clock, in milliseconds; tests move it to expire sessions. */
  now?: () => number;
}

export interface AdminServer {
  server: Server;
  /** Resolves with the port actually bound (tests use 0). */
  ready: Promise<number>;
  close: () => void;
}

interface Session {
  role: "admin" | "viewer";
  name: string;
  sub: string;
  /** Milliseconds since the epoch; the session is refused from then on, whatever the cookie says. */
  expires: number;
}

interface Pending {
  verifier: string;
  nonce: string;
  created: number;
}

/** A session lasts 8 hours on the server, the same as its cookie. */
export const SESSION_TTL_MS = 8 * 60 * 60_000;
/** A sign-in must come back from the identity provider within 10 minutes. */
const PENDING_TTL_MS = 10 * 60_000;
const SESSION_COOKIE = "pb_admin";
/** Ties the sign-in state to the browser that started it (no login CSRF). */
const STATE_COOKIE = "pb_oidc_state";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Sent with every response. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** The built UI loads only its own scripts and styles, and calls only its own origin. */
const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, { ...SECURITY_HEADERS, "cache-control": "no-store", location, ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end();
}

/** Cookies of the request; a value that is not valid percent-encoding is dropped, not an error. */
function cookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(rest.join("="));
    } catch {
      // A malformed cookie is ignored.
    }
  }
  return out;
}

function rolesOf(claims: Record<string, unknown>): string[] {
  const realm = claims.realm_access as { roles?: unknown } | undefined;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return [...list(realm?.roles), ...list(claims.roles)];
}

/**
 * The issuer must use https; plain http is accepted only on the loopback address (a local identity
 * provider in development or in the tests). Returns whether http is in use.
 */
function checkIssuer(issuer: string): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new PlugbricksError([issue("ADMIN_OIDC_ISSUER_INVALID", "", { issuer })]);
  }
  if (url.protocol === "https:") return false;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return true;
  throw new PlugbricksError([issue("ADMIN_OIDC_ISSUER_INVALID", "", { issuer })]);
}

export function startAdmin(o: AdminOptions): AdminServer {
  const now = o.now ?? Date.now;
  const insecureIssuer = !o.dev && o.issuer !== undefined ? checkIssuer(o.issuer) : false;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const actions = new ActionRunner({
    root: o.root,
    runtime: o.runtime,
    k8s: o.k8s,
    cli: o.cli,
    timeoutMs: o.actionTimeoutMs,
    log: o.log,
    now: () => new Date(now()),
  });
  let boundPort = o.port;
  // Loaded only when OIDC is actually used: `plugbricks status` must not pay for it.
  let oidcModule: typeof import("openid-client") | undefined;
  let config: Promise<Configuration> | undefined;
  // One runtime read at a time: concurrent page loads share it instead of piling up docker or kubectl calls.
  let bricksInFlight: Promise<BricksView> | undefined;

  const oidc = async () => {
    if (!o.issuer || !o.clientId) throw new Error("OIDC is not configured");
    const client = (oidcModule ??= await import("openid-client"));
    // A public client authenticates with PKCE only; Keycloak does not advertise "none", so say it.
    const clientAuth = o.clientSecret ? undefined : client.None();
    // A failed discovery is not kept: the next sign-in tries again (the provider may start after the admin).
    config ??= client
      .discovery(
        new URL(o.issuer),
        o.clientId,
        o.clientSecret,
        clientAuth,
        insecureIssuer ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((e: unknown) => {
        config = undefined;
        throw e;
      });
    return { client, config: await config };
  };

  const prune = () => {
    const t = now();
    for (const [key, s] of sessions) if (s.expires <= t) sessions.delete(key);
    for (const [key, p] of pending) if (t - p.created > PENDING_TTL_MS) pending.delete(key);
  };

  const sessionOf = (req: IncomingMessage): Session | undefined => {
    if (o.dev) return { role: "admin", name: "dev", sub: "dev", expires: Infinity };
    const token = cookies(req)[SESSION_COOKIE];
    const s = token ? sessions.get(token) : undefined;
    if (s && s.expires <= now()) {
      sessions.delete(token!);
      return undefined;
    }
    return s;
  };

  const requireSession = (req: IncomingMessage, res: ServerResponse): Session | undefined => {
    const s = sessionOf(req);
    if (!s) send(res, 401, { error: "UNAUTHENTICATED" });
    return s;
  };

  /**
   * DNS rebinding: a hostile page can make its own name resolve to 127.0.0.1, so listening on the
   * loopback interface is not enough. Only requests addressed to the loopback name of this port are served,
   * and a cross-origin browser request (an Origin header from elsewhere) is refused.
   */
  const allowedHosts = () => new Set([...LOOPBACK_HOSTS].map((h) => `${h}:${boundPort}`));
  const addressedToUs = (req: IncomingMessage): boolean => {
    const hosts = allowedHosts();
    if (!hosts.has((req.headers.host ?? "").toLowerCase())) return false;
    const origin = req.headers.origin;
    return origin === undefined || [...hosts].some((h) => origin.toLowerCase() === `http://${h}`);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!addressedToUs(req)) return sendText(res, 403, "this admin only answers on http://127.0.0.1 or http://localhost");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;

    if (path === "/auth/login") {
      if (req.method !== "GET") return sendText(res, 405, "method not allowed");
      if (o.dev) return redirect(res, "/");
      try {
        const { client, config: cfg } = await oidc();
        const state = client.randomState();
        const nonce = client.randomNonce();
        const verifier = client.randomPKCECodeVerifier();
        const challenge = await client.calculatePKCECodeChallenge(verifier);
        prune();
        pending.set(state, { verifier, nonce, created: now() });
        const target = client.buildAuthorizationUrl(cfg, {
          redirect_uri: `http://127.0.0.1:${boundPort}/auth/callback`,
          scope: "openid profile email",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          nonce,
        });
        // Lax: the cookie comes back with the provider's top-level redirect to the callback.
        redirect(res, target.href, [
          `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${PENDING_TTL_MS / 1000}`,
        ]);
      } catch (e) {
        o.log?.(`admin: OIDC discovery failed: ${(e as Error).message}`);
        sendText(res, 502, "cannot start the sign-in: the identity provider could not be reached");
      }
      return;
    }

    if (path === "/auth/callback") {
      if (req.method !== "GET") return sendText(res, 405, "method not allowed");
      const clearState = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0`;
      const state = url.searchParams.get("state");
      const p = state ? pending.get(state) : undefined;
      if (!state || !p || now() - p.created > PENDING_TTL_MS) return sendText(res, 400, "unknown or expired sign-in state");
      // The state must be the one this browser was given at /auth/login: a link from someone else's sign-in is refused.
      if (cookies(req)[STATE_COOKIE] !== state) return sendText(res, 400, "this sign-in was not started in this browser");
      pending.delete(state);
      try {
        const { client, config: cfg } = await oidc();
        const tokens = await client.authorizationCodeGrant(cfg, url, {
          pkceCodeVerifier: p.verifier,
          expectedState: state,
          expectedNonce: p.nonce,
        });
        const claims = (tokens.claims() ?? {}) as unknown as Record<string, unknown>;
        const roles = rolesOf(claims);
        const role = roles.includes("plugbricks-admin") ? "admin" : roles.includes("plugbricks-viewer") ? "viewer" : undefined;
        if (!role) {
          res.setHeader("set-cookie", clearState);
          return sendText(res, 403, "signed in, but this account has neither plugbricks-viewer nor plugbricks-admin in its ID token");
        }
        prune();
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, {
          role,
          name: String(claims.name ?? claims.preferred_username ?? claims.email ?? "user"),
          sub: String(claims.sub ?? ""),
          expires: now() + SESSION_TTL_MS,
        });
        redirect(res, "/", [`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`, clearState]);
      } catch (e) {
        o.log?.(`admin: sign-in failed: ${(e as Error).message}`);
        res.setHeader("set-cookie", clearState);
        sendText(res, 400, "sign-in failed");
      }
      return;
    }

    if (path === "/auth/logout") {
      // POST only: a link or an image elsewhere cannot sign the user out.
      if (req.method !== "POST") return sendText(res, 405, "method not allowed");
      const token = cookies(req)[SESSION_COOKIE];
      if (token) sessions.delete(token);
      return redirect(res, "/", [`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`]);
    }

    if (path === "/api/session") {
      if (req.method !== "GET") return sendText(res, 405, "method not allowed");
      const s = sessionOf(req);
      if (!s) return send(res, 401, { error: "UNAUTHENTICATED" });
      return send(res, 200, {
        authenticated: true,
        dev: o.dev,
        role: s.role,
        name: s.name,
        project: readProject(o.root).platform.name,
        runtime: o.runtime,
      });
    }

    if (path === "/api/actions" || path.startsWith("/api/actions/")) {
      const s = requireSession(req, res);
      if (!s) return;
      if (path === "/api/actions") {
        if (req.method === "GET") return send(res, 200, { actions: actions.list() });
        if (req.method !== "POST") return sendText(res, 405, "method not allowed");
        if (s.role !== "admin") return send(res, 403, { error: "FORBIDDEN" });
        const type = (req.headers["content-type"] ?? "").toLowerCase();
        if (!type.startsWith("application/json")) return send(res, 400, { error: "CONTENT_TYPE" });
        const body = await readBody(req, 16 * 1024);
        if (body === null) return send(res, 400, { error: "BODY_TOO_LARGE" });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400, { error: "INVALID_JSON" });
        }
        const valid = validateAction(parsed);
        if (!valid.ok) return send(res, 400, { error: valid.code });
        const started = actions.start({ name: s.name, sub: s.sub, role: s.role }, valid.input);
        if (!started.ok) return send(res, 409, { error: "BUSY", running: started.running });
        return send(res, 202, { id: started.id });
      }
      if (req.method !== "GET") return sendText(res, 405, "method not allowed");
      let id: string;
      try {
        id = decodeURIComponent(path.slice("/api/actions/".length));
      } catch {
        return send(res, 404, { error: "NOT_FOUND" });
      }
      const action = actions.get(id);
      return action ? send(res, 200, action) : send(res, 404, { error: "NOT_FOUND" });
    }

    if (path === "/api/bricks" || path === "/api/audit") {
      if (req.method !== "GET") return sendText(res, 405, "method not allowed");
      if (!requireSession(req, res)) return;
      try {
        if (path === "/api/audit") return send(res, 200, { entries: readAudit(o.root) });
        bricksInFlight ??= bricksView(o).finally(() => (bricksInFlight = undefined));
        return send(res, 200, await bricksInFlight);
      } catch (e) {
        if (e instanceof RuntimeUnavailableError) return send(res, 503, { error: "RUNTIME_UNAVAILABLE", issues: e.issues });
        if (e instanceof PlugbricksError) return send(res, 400, { error: "INVALID_PLATFORM", issues: e.issues });
        throw e;
      }
    }

    if (path.startsWith("/api/") || path.startsWith("/auth/")) return send(res, 404, { error: "NOT_FOUND" });

    // Static UI; a GET that is not a file falls back to index.html (client-side routes).
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed");
    let decoded: string;
    try {
      decoded = decodeURIComponent(path === "/" ? "/index.html" : path);
    } catch {
      return sendText(res, 400, "malformed path");
    }
    const uiDir = resolve(o.uiDir);
    const wanted = resolve(uiDir, `.${decoded}`);
    const file = wanted.startsWith(uiDir + sep) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(uiDir, "index.html");
    if (!existsSync(file)) return sendText(res, 500, `the admin UI is not built: ${uiDir}/index.html is missing`);
    const html = file.endsWith(".html");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": html ? "no-store" : "public, max-age=31536000, immutable",
      ...(html ? { "content-security-policy": HTML_CSP } : {}),
    });
    if (req.method === "HEAD") return res.end();
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      // The details go to the terminal of whoever runs the admin, never to the browser.
      o.log?.(`admin: ${req.method} ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: "INTERNAL" });
      else res.end();
    });
  });

  const ready = new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolvePort(boundPort);
    });
  });
  void ready
    .then((port) => o.log?.(`plugbricks admin on http://127.0.0.1:${port}${o.dev ? " (dev mode: authentication is off)" : ""}`))
    .catch(() => {});
  return { server, ready, close: () => server.close() };
}

/** Reads a request body, or null when it grows past the limit; the caller answers 400, never 413. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve(null);
      return;
    }
    let size = 0;
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (text: string) => {
      if (tooLarge) return;
      size += Buffer.byteLength(text);
      if (size > limit) {
        tooLarge = true;
        body = "";
        return;
      }
      body += text;
    });
    req.on("end", () => resolve(tooLarge ? null : body));
    req.on("error", reject);
  });
}

/** The composed SDL in the router configuration, or null when the format is not the one we write. */
function federatedSdlOf(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { engineConfig?: { graphqlSchema?: unknown } };
    return typeof parsed.engineConfig?.graphqlSchema === "string" ? parsed.engineConfig.graphqlSchema : null;
  } catch {
    return null;
  }
}

function readAudit(root: string): unknown[] {
  const file = join(root, ".admin", "audit.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-200)
    .reverse()
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

type BricksView = Awaited<ReturnType<typeof bricksView>>;

/** One brick another brick needs, and why: a capability it requires, an entity it extends, or what its manifest declares. */
interface DependencyLink {
  brick: string;
  kind: "capability" | "extends" | "declared";
  /** The capability, the entities, or the manifest's own description. */
  label: string;
  optional: boolean;
  installed: boolean;
  enabled: boolean;
}

/**
 * The bricks `name` needs, from what is checked (the providers of its required capabilities, the owners of the
 * entities it extends) and from what its manifest says (`dependencies`). An optional capability
 * without an enabled provider is left out: nothing is wired. A brick that is needed twice shows once, for the
 * strongest reason: capability, then extends, then declared.
 */
function dependenciesOf(name: string, m: BrickManifest | undefined, status: ReturnType<typeof platformStatus>): DependencyLink[] {
  const found = new Map<string, DependencyLink>();
  const rank = { capability: 0, extends: 1, declared: 2 } as const;
  const add = (brick: string, kind: DependencyLink["kind"], label: string, optional: boolean) => {
    if (brick === name) return;
    const known = status.bricks.find((x) => x.name === brick);
    const link: DependencyLink = { brick, kind, label, optional, installed: known !== undefined, enabled: known?.enabled ?? false };
    const before = found.get(brick);
    if (!before) found.set(brick, link);
    else if (rank[kind] < rank[before.kind]) found.set(brick, { ...link, optional: before.optional && optional });
  };
  const locked = status.bricks.find((x) => x.name === name);
  for (const [cap, r] of Object.entries(locked?.requires ?? {})) {
    if (!r.optional) add(r.provider, "capability", cap, false);
    else {
      const provider = Object.hasOwn(status.capabilities, cap) ? status.capabilities[cap] : undefined;
      if (provider !== undefined && status.bricks.some((x) => x.name === provider && x.enabled)) add(provider, "capability", cap, true);
    }
  }
  for (const e of m?.extends ?? []) add(e.plugin, "extends", e.entities.join(", "), false);
  for (const d of m?.dependencies ?? []) add(d.plugin, "declared", d.description ?? "declared in its manifest", d.optional === true);
  return [...found.values()].sort((a, b) => a.brick.localeCompare(b.brick));
}

async function bricksView(o: AdminOptions) {
  const status = platformStatus(o.root);
  const project = readProject(o.root);
  const problems: Issue[] = [...status.problems];
  const addProblems = (issues: Issue[]) => {
    for (const i of issues) if (!problems.some((p) => p.code === i.code && p.path === i.path)) problems.push(i);
  };
  // Reading the plan or the runtime may fail (an unreadable copy, a composition error, a missing webPort, a name
  // conflict). The table still answers: the issues go to `problems`, and the router configuration is null.
  let live: Awaited<ReturnType<typeof statusRuntimeAsync>> | null = null;
  let plan: ReturnType<typeof planProject> | null = null;
  let manifests: ReturnType<typeof loadInstalledBricks> = new Map();
  try {
    live = await statusRuntimeAsync(o.root, o.runtime, status.problems, { ...o.runtimeDeps, k8s: o.k8s ?? o.runtimeDeps?.k8s });
  } catch (e) {
    if (e instanceof RuntimeUnavailableError) throw e;
    if (e instanceof PlugbricksError) addProblems(e.issues);
    else throw e;
  }
  try {
    plan = planProject(project);
  } catch (e) {
    if (e instanceof PlugbricksError) addProblems(e.issues);
    else throw e;
  }
  try {
    manifests = loadInstalledBricks(project);
  } catch (e) {
    if (e instanceof PlugbricksError) addProblems(e.issues);
    else throw e;
  }
  const router = plan?.router;
  // The composed SDL is inside the router configuration (engineConfig.graphqlSchema); the plan is the
  // source of truth for the hash, the size and the file the runtime reads.
  const routerConfig = router
    ? {
        sha256: router.configSha256,
        size: Buffer.byteLength(router.config, "utf8"),
        source: `.generated/${o.runtime}/router-config.json`,
        federatedSdl: federatedSdlOf(router.config),
        composition: {
          subgraphs: router.subgraphs.length,
          extendedEntities: [
            ...new Set(
              [...manifests]
                .filter(([brick]) => router.subgraphs.some((s) => s.brick === brick))
                .flatMap(([, m]) => (m.extends ?? []).flatMap((e) => e.entities)),
            ),
          ].sort(),
        },
      }
    : null;
  const liveBricks = new Map((live?.bricks ?? []).map((b) => [b.name, b]));
  const planned = live !== null;
  const bricks = status.bricks.map((b) => {
    const m = manifests.get(b.name);
    const services = liveBricks.get(b.name)?.services ?? [];
    // The same order as status --runtime: the brick shows its worst service, and the restarts of all of them.
    const worst = [...services].sort((a, x) => SEVERITY[x.state] - SEVERITY[a.state])[0];
    let removeBlockedBy: { code: string; message: string }[] = [];
    try {
      removeBlockedBy = removeRefusals(project, b.name).map((i) => ({ code: i.code, message: i.message }));
    } catch {
      // An unreadable copy can stop the refusal check too; the problem is already in `problems`.
    }
    return {
      name: b.name,
      version: b.version,
      tags: b.tags ?? [],
      enabled: b.enabled,
      deployed: services.some((s) => s.deployed),
      state: worst?.state ?? (b.enabled ? (planned ? "not deployed" : "unknown") : "stopped"),
      reason: worst?.reason ?? (b.enabled ? (planned ? null : "the platform cannot be planned") : "disabled in platform.json"),
      restarts: services.reduce((n, s) => n + s.restarts, 0),
      port: m?.services[0]?.port ?? null,
      subgraph: m?.subgraph !== undefined,
      // A web brick's entry page (D17), where its pages are published on this machine.
      webUrl: m?.web && b.webPort !== undefined ? `http://127.0.0.1:${b.webPort}${m.web.path ?? "/"}` : null,
      extends: (m?.extends ?? []).map((e) => `${e.entities.join(", ")} (${e.plugin})`).join("; "),
      provides: b.provides,
      requires: Object.entries(b.requires)
        .map(([cap, r]) => {
          if (!r.optional) return `${cap} from ${r.provider}`;
          const provider = Object.hasOwn(status.capabilities, cap) ? status.capabilities[cap] : undefined;
          return provider !== undefined && status.bricks.some((x) => x.name === provider && x.enabled)
            ? `${cap} from ${provider} (optional)`
            : `${cap} (optional, not provided)`;
        })
        .join(", "),
      // What `remove` would refuse it for, from the CLI's own check, so the UI can say so before trying.
      removeBlockedBy,
      dependsOn: dependenciesOf(b.name, m, status),
    };
  });
  const summary = {
    total: bricks.length,
    healthy: bricks.filter((b) => b.state === "healthy").length,
    down: bricks.filter((b) => b.state === "unhealthy").length,
    stopped: bricks.filter((b) => b.state === "stopped" || b.state === "not deployed").length,
  };
  return {
    platform: status.name,
    runtime: o.runtime,
    router: live?.router
      ? {
          state: live.router.state,
          address: live.router.address,
          image: live.router.image,
          digest: live.router.digest,
          subgraphs: live.router.subgraphs,
          config: routerConfig,
        }
      : null,
    summary,
    bricks,
    problems,
  };
}

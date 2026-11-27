// What a service that checks tokens (the created ones, D46) must accept and refuse, tried against a real container. The
// keys, the tokens and the JWKS are made here, with node:crypto alone; the service reads the JWKS from a busybox
// container of the same Docker network, as it would read its identity provider's.
import { createHmac, generateKeyPairSync, sign as rsaSign, type KeyObject } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const ISSUER = "http://127.0.0.1:18080/realms/plugbricks";
export const AUDIENCE = "plugbricks-router";

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export interface Keys {
  /** A token signed by the key the JWKS holds. */
  sign(claims: Record<string, unknown>, o?: { alg?: string; kid?: string; key?: KeyObject; secret?: string }): string;
  /** The public key as a JWKS document. */
  jwks: string;
  /** Another key, never published: what a forged token is signed with. */
  stranger: KeyObject;
}

export function makeKeys(kid = "k1"): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" };
  return {
    jwks: JSON.stringify({ keys: [jwk] }),
    stranger,
    sign(claims, o = {}) {
      const alg = o.alg ?? "RS256";
      const head = b64(JSON.stringify({ alg, typ: "JWT", kid: o.kid ?? kid }));
      const body = b64(JSON.stringify(claims));
      const input = `${head}.${body}`;
      if (alg === "none") return `${input}.`;
      if (alg === "HS256")
        return `${input}.${createHmac("sha256", o.secret ?? "")
          .update(input)
          .digest("base64url")}`;
      return `${input}.${rsaSign("sha256", Buffer.from(input), o.key ?? privateKey).toString("base64url")}`;
    },
  };
}

/** The claims of a token Keycloak would have given a service account of the platform. */
export function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "f2c1-uuid",
    preferred_username: "service-account-web",
    azp: "web",
    scope: "profile email",
    iat: now,
    exp: now + 300,
    ...extra,
  };
}

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

export interface Lab {
  network: string;
  /** The JWKS URL inside the network. */
  jwksUrl: string;
  stop(): void;
}

/** A network and a busybox that serves `jwks` at /jwks.json. `dir` must be a folder the Docker daemon can see. */
export function startLab(name: string, dir: string, jwks: string): Lab {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jwks.json"), jwks);
  const network = `${name}-net`;
  const container = `${name}-jwks`;
  docker("rm", "-f", container);
  docker("network", "rm", network);
  const made = docker("network", "create", network);
  if (made.status !== 0) throw new Error(made.stderr);
  const run = docker(
    "run",
    "-d",
    "--name",
    container,
    "--network",
    network,
    "--network-alias",
    "jwks",
    "-v",
    `${dir}:/www:ro`,
    "busybox:1.36",
    "httpd",
    "-f",
    "-p",
    "80",
    "-h",
    "/www",
  );
  if (run.status !== 0) throw new Error(run.stderr);
  return {
    network,
    jwksUrl: "http://jwks/jwks.json",
    stop() {
      docker("rm", "-f", container);
      docker("network", "rm", network);
    },
  };
}

export interface Running {
  /** http://127.0.0.1:<port> on this machine. */
  base: string;
  logs(): string;
  stop(): void;
}

/** Starts `image` on the lab's network with the environment given, port 4000 published on 127.0.0.1 only. */
export function startService(lab: Lab, name: string, image: string, env: Record<string, string>): Running {
  docker("rm", "-f", name);
  const args = ["run", "-d", "--name", name, "--network", lab.network, "-p", "127.0.0.1::4000"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  const run = docker(...args, image);
  if (run.status !== 0) throw new Error(run.stderr);
  const port = docker("port", name, "4000/tcp").stdout.trim().split("\n")[0].split(":").pop();
  return {
    base: `http://127.0.0.1:${port}`,
    logs: () => docker("logs", name).stdout + docker("logs", name).stderr,
    stop: () => void docker("rm", "-f", name),
  };
}

/** Waits until the service answers /health. */
export async function untilHealthy(svc: Running, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      if ((await fetch(`${svc.base}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the service did not answer /health in ${seconds}s:\n${svc.logs()}`);
}

/** POSTs a query to /graphql, with an Authorization header or without. */
export async function post(base: string, authorization?: string): Promise<{ status: number; body: string; challenge: string | null }> {
  const r = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ query: "{ __typename }" }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, body: await r.text(), challenge: r.headers.get("www-authenticate") };
}

/** What a service must answer to each token: [what it is, the Authorization header, the HTTP status]. */
export function cases(keys: Keys): [string, string | undefined, number][] {
  const bearer = (extra: Record<string, unknown> = {}, o: Parameters<Keys["sign"]>[1] = {}) => `Bearer ${keys.sign(claims(extra), o)}`;
  const without = (drop: string) => {
    const c = claims();
    delete c[drop];
    return `Bearer ${keys.sign(c)}`;
  };
  const past = Math.floor(Date.now() / 1000) - 60;
  return [
    ["no token", undefined, 401],
    ["a valid token", bearer(), 200],
    ["the scheme in capitals", bearer().replace("Bearer", "BEARER"), 200],
    ["an audience that is a list holding ours", bearer({ aud: ["other", AUDIENCE] }), 200],
    ["garbage", "Bearer a.b.c", 401],
    ["not a bearer", "Basic dXNlcjpwdw==", 401],
    ["another audience", bearer({ aud: "other" }), 401],
    ["another issuer", bearer({ iss: "http://evil.example" }), 401],
    ["an expired token", bearer({ exp: past }), 401],
    ["a token with no expiry", without("exp"), 401],
    ["a token with no subject", without("sub"), 401],
    ["a token signed by another key", bearer({}, { key: keys.stranger }), 401],
    ["alg none", bearer({}, { alg: "none" }), 401],
    ["HS256 with the public key as the secret", bearer({}, { alg: "HS256", secret: keys.jwks }), 401],
    ["a key id nobody published", bearer({}, { kid: "unknown" }), 401],
  ];
}

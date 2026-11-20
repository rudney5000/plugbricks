import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdmin, type AdminServer } from "../src/admin/server.js";
import { main } from "../src/cli.js";

// A real Keycloak, when its image is already on the machine (CI does not pull it): the whole
// authorization-code + PKCE flow, with a public client (no secret), a realm role in the ID token and
// a session. The image is not pulled here on purpose; see docs/keycloak.md.
const pkg = fileURLToPath(new URL("..", import.meta.url));
const image = "quay.io/keycloak/keycloak:26.7.3";
const container = "pbtest-keycloak-oidc";
const kcPort = 18080;
const appPort = 4100;
const work = join(pkg, ".test-work/oidc");
const project = join(work, "project");
const ui = join(work, "ui");
const realm = join(pkg, "test/fixtures/keycloak/realm.json");
const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
const hasImage = docker.status === 0 && spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" }).status === 0;

interface Jar {
  get: (host: string, name: string) => string | undefined;
  header: (host: string) => string;
  store: (host: string, cookies: string[]) => void;
}

function jar(): Jar {
  const jars = new Map<string, Map<string, string>>();
  const of = (host: string) => {
    let j = jars.get(host);
    if (!j) jars.set(host, (j = new Map()));
    return j;
  };
  return {
    get: (host, name) => of(host).get(name),
    header: (host) => [...of(host)].map(([k, v]) => `${k}=${v}`).join("; "),
    store: (host, cookies) => {
      for (const c of cookies) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        if (i > 0) of(host).set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
  };
}

async function waitForRealm(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${kcPort}/realms/plugbricks/.well-known/openid-configuration`);
      if (res.status === 200) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Keycloak did not answer in 60s");
}

describe.skipIf(!hasImage)("a real OIDC sign-in (Keycloak, public client)", () => {
  const cookies = jar();
  let admin: AdminServer | undefined;

  beforeAll(async () => {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    rmSync(work, { recursive: true, force: true });
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>admin ui</title>");
    mkdirSync(project, { recursive: true });
    expect(main(["init", "--name", "demo"], { cwd: project, stdout: () => {}, stderr: () => {} })).toBe(0);

    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-p",
        `127.0.0.1:${kcPort}:8080`,
        "-e",
        "KC_BOOTSTRAP_ADMIN_USERNAME=admin",
        "-e",
        "KC_BOOTSTRAP_ADMIN_PASSWORD=admin",
        "-e",
        `KC_HOSTNAME=http://127.0.0.1:${kcPort}`,
        "-v",
        `${realm}:/opt/keycloak/data/import/realm.json:ro`,
        image,
        "start-dev",
        "--import-realm",
      ],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    await waitForRealm();

    admin = startAdmin({
      root: project,
      runtime: "compose",
      port: appPort,
      dev: false,
      issuer: `http://127.0.0.1:${kcPort}/realms/plugbricks`,
      clientId: "plugbricks-admin",
      uiDir: ui,
      runtimeDeps: { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) },
    });
    await admin.ready;
  }, 180_000);

  afterAll(() => {
    admin?.close();
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  });

  async function req(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    const c = cookies.header(host);
    if (c) headers.set("cookie", c);
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    cookies.store(host, res.headers.getSetCookie());
    return res;
  }

  it("signs in through Keycloak and gets an admin session", async () => {
    const base = `http://127.0.0.1:${appPort}`;
    const login = await req(`${base}/auth/login`);
    expect(login.status).toBe(302);
    const idp = new URL(login.headers.get("location")!);
    expect(idp.origin).toBe(`http://127.0.0.1:${kcPort}`);

    const page = await req(idp.href);
    expect(page.status).toBe(200);
    const html = await page.text();
    const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
    expect(form, "the Keycloak login form").not.toBeNull();
    const action = form![1].replaceAll("&amp;", "&");
    const hidden = [...html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)]
      .map(([tag]) => [/name="([^"]*)"/.exec(tag)?.[1], /value="([^"]*)"/.exec(tag)?.[1] ?? ""] as const)
      .filter(([name]) => name !== undefined);
    const params = new URLSearchParams({ username: "demo", password: "demo", credentialId: "" });
    for (const [name, value] of hidden) params.set(name!, value);
    const body = params.toString();
    const posted = await req(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(posted.status).toBe(302);
    const callback = await req(posted.headers.get("location")!);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");

    const session = await req(`${base}/api/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, dev: false, role: "admin", name: "Demo User", project: "demo" });
  }, 300_000);
});

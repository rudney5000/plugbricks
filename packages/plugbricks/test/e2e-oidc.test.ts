import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdmin, type AdminServer } from "../src/admin/server.js";
import { main } from "../src/cli.js";
import { browser, signInThroughKeycloak } from "./helpers/oidc-browser.js";

// Real Keycloak sign-ins into `plugbricks admin`. Both blocks use the admin's port 4100, the redirect URI of the
// realm's public client, so they live in this one file: vitest runs the blocks of a file one after the other.
const pkg = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const appPort = 4100;
const appBase = `http://127.0.0.1:${appPort}`;
const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
const linuxDocker = docker.status === 0 && docker.stdout.trim() === "linux";

/** An admin UI folder with a page in it: these tests only sign in. */
function fakeUi(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>admin ui</title>");
  return dir;
}

async function waitForRealm(origin: string, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    try {
      const res = await fetch(`${origin}/realms/plugbricks/.well-known/openid-configuration`);
      if (res.status === 200) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Keycloak did not answer in ${seconds}s`);
}

// ---------- an external Keycloak (D15), when its image is already on the machine (CI does not pull it) ----------
// The whole authorization-code + PKCE flow, with a public client (no secret), a realm role in the ID token and a
// session. The image is not pulled here on purpose; see docs/keycloak.md.
const image = "quay.io/keycloak/keycloak:26.7.3";
const container = "pbtest-keycloak-oidc";
const kcPort = 18080;
const hasImage = linuxDocker && spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasImage)("a real OIDC sign-in (Keycloak, public client)", () => {
  const work = join(pkg, ".test-work/oidc");
  const project = join(work, "project");
  const realm = join(pkg, "test/fixtures/keycloak/realm.json");
  let admin: AdminServer | undefined;

  beforeAll(async () => {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    rmSync(work, { recursive: true, force: true });
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
    // start-dev builds Keycloak on every start: over a minute on a 4-CPU machine.
    await waitForRealm(`http://127.0.0.1:${kcPort}`, 180);
    admin = startAdmin({
      root: project,
      runtime: "compose",
      port: appPort,
      dev: false,
      issuer: `http://127.0.0.1:${kcPort}/realms/plugbricks`,
      clientId: "plugbricks-admin",
      uiDir: fakeUi(join(work, "ui")),
      runtimeDeps: { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) },
    });
    await admin.ready;
  }, 300_000);

  afterAll(() => {
    admin?.close();
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  });

  it("signs in through Keycloak and gets an admin session", async () => {
    const session = await signInThroughKeycloak(browser(), appBase, `http://127.0.0.1:${kcPort}`, "demo", "demo");
    expect(session).toMatchObject({ authenticated: true, dev: false, role: "admin", name: "Demo User", project: "demo" });
  }, 300_000);
});

// ---------- the keycloak brick (D18): Keycloak inside the platform, on Docker Compose ----------
// Its image is built from apis/keycloak (which pulls the official image). The realm ships without any user: one is
// created here with the brick's generated administrator, as a person would in the console, then signs into the admin.
const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const composeReady = linuxDocker && compose.status === 0;
const brickProject = "pbtest-kcbrick";
const webPort = 18091;

describe.skipIf(!composeReady)("the keycloak brick: a sign-in through the Keycloak the platform runs (D18)", () => {
  const work = join(pkg, ".test-work/oidc-brick");
  const project = join(work, "project");
  const origin = `http://127.0.0.1:${webPort}`;
  const cli = (args: string[]) => {
    const out: string[] = [];
    const code = main(args, { cwd: project, stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };
  let admin: AdminServer | undefined;

  beforeAll(async () => {
    const build = spawnSync("docker", ["build", "--quiet", "--tag", "plugbricks-example/keycloak:0.1.0", join(repo, "apis/keycloak")], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    // A project left over by an interrupted run would keep its database and its old passwords.
    spawnSync("docker", ["compose", "--project-name", brickProject, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
    rmSync(work, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    for (const brick of ["postgres", "keycloak"]) cpSync(join(pkg, "examples", brick), join(project, brick), { recursive: true });
    for (const args of [
      ["init", "--name", brickProject],
      ["add", "postgres"],
      ["add", "keycloak"],
    ]) {
      const r = cli(args);
      expect(r.code, `${args.join(" ")}\n${r.out}`).toBe(0);
    }
    const file = join(project, "platform.json");
    const platform = JSON.parse(readFileSync(file, "utf8"));
    expect(platform.bricks.keycloak.webPort, "add gives the first free port from 8080").toBe(8080);
    platform.bricks.keycloak.webPort = webPort;
    writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");
    // up returns once the healthcheck passes, which asks for the realm itself: Keycloak's own /health/ready says UP
    // while it is still creating its schema and importing the realm (observed, D18).
    const up = cli(["up"]);
    expect(up.code, up.out).toBe(0);
  }, 900_000);

  afterAll(() => {
    admin?.close();
    spawnSync("docker", ["compose", "--project-name", brickProject, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
  });

  it("answers as the issuer the browser reaches, as soon as up returns", async () => {
    const discovery = await fetch(`${origin}/realms/plugbricks/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    expect(((await discovery.json()) as { issuer: string }).issuer).toBe(`${origin}/realms/plugbricks`);
    // The console is on the brick's web path.
    expect([200, 302]).toContain((await fetch(`${origin}/admin/`, { redirect: "manual" })).status);
  });

  it("signs a user created in it into the admin, with the role given there", async () => {
    // The administrator's password is the brick's generated secret (D6), never a known one.
    const secrets = readFileSync(join(project, ".secrets/secrets.env"), "utf8");
    const password = /^PB_KEYCLOAK__ADMIN_PASSWORD=(.+)$/m.exec(secrets)?.[1];
    expect(password, "the generated administrator password").toMatch(/^[A-Za-z0-9]{32}$/);
    const token = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: "admin", password: password! }),
    });
    expect(token.status).toBe(200);
    const api = (path: string, init: RequestInit = {}) =>
      token
        .clone()
        .json()
        .then((t: { access_token: string }) =>
          fetch(`${origin}/admin/realms/plugbricks${path}`, {
            ...init,
            headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
          }),
        );

    // The realm ships without any user (D18).
    expect(await (await api("/users")).json()).toEqual([]);

    const userPassword = randomBytes(18).toString("base64url");
    const created = await api("/users", {
      method: "POST",
      body: JSON.stringify({
        username: "alice",
        enabled: true,
        email: "alice@example.test",
        emailVerified: true,
        firstName: "Alice",
        lastName: "Admin",
        credentials: [{ type: "password", value: userPassword, temporary: false }],
      }),
    });
    expect(created.status).toBe(201);
    const userId = created.headers.get("location")!.split("/").pop()!;
    const role = await (await api("/roles/plugbricks-admin")).json();
    expect((await api(`/users/${userId}/role-mappings/realm`, { method: "POST", body: JSON.stringify([role]) })).status).toBe(204);

    admin = startAdmin({
      root: project,
      runtime: "compose",
      port: appPort,
      dev: false,
      issuer: `${origin}/realms/plugbricks`,
      clientId: "plugbricks-admin",
      uiDir: fakeUi(join(work, "ui")),
      runtimeDeps: { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) },
    });
    await admin.ready;
    const session = await signInThroughKeycloak(browser(), appBase, origin, "alice", userPassword);
    expect(session).toMatchObject({ authenticated: true, dev: false, role: "admin", name: "Alice Admin", project: brickProject });
  }, 300_000);
});

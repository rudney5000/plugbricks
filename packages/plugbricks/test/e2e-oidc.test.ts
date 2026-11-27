import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAdmin, type AdminServer } from "../src/admin/server.js";
import { main } from "../src/cli.js";
import { platformOidcIssuer } from "../src/plan.js";
import { readProject } from "../src/platform.js";
import { browser, signInThroughKeycloak } from "./helpers/oidc-browser.js";
import { shape } from "./helpers/created-service.js";
import { exampleImage } from "./helpers/images.js";

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
const routerPort = 14110;

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
    for (const api of ["keycloak", "orders-api", "orders-web"]) {
      const build = spawnSync("docker", ["build", "--quiet", "--tag", exampleImage(api), join(repo, "apis", api)], {
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
    }
    // A project left over by an interrupted run would keep its database and its old passwords.
    spawnSync("docker", ["compose", "--project-name", brickProject, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
    rmSync(work, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    for (const brick of ["postgres", "keycloak", "orders-api", "orders-web"])
      cpSync(join(pkg, "examples", brick), join(project, brick), { recursive: true });
    for (const args of [
      ["init", "--name", brickProject],
      ["add", "postgres"],
      ["add", "keycloak"],
      // orders-web requires oidc optionally (D19): with keycloak here, it gets its own client.
      ["add", "orders-web"],
      // A subgraph, so the platform has a router; with keycloak providing oidc, it requires a token (D19).
      ["add", "orders-api"],
    ]) {
      const r = cli(args);
      expect(r.code, `${args.join(" ")}\n${r.out}`).toBe(0);
    }
    const file = join(project, "platform.json");
    const platform = JSON.parse(readFileSync(file, "utf8"));
    expect(platform.bricks.keycloak.webPort, "add gives the first free port from 8080").toBe(8080);
    platform.bricks.keycloak.webPort = webPort;
    platform.bricks["orders-web"].webPort = webPort + 1;
    platform.router = { port: routerPort };
    writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");
    // up returns once the healthcheck passes, which asks for the realm itself: Keycloak's own /health/ready says UP
    // while it is still creating its schema and importing the realm (observed, D18).
    const up = cli(["up"]);
    expect(up.code, up.out).toBe(0);
  }, 900_000);

  afterAll(() => {
    admin?.close();
    spawnSync("docker", ["compose", "--project-name", brickProject, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
  }, 120_000);

  it("answers as the issuer the browser reaches, as soon as up returns", async () => {
    const discovery = await fetch(`${origin}/realms/plugbricks/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    expect(((await discovery.json()) as { issuer: string }).issuer).toBe(`${origin}/realms/plugbricks`);
    // The console is on the brick's web path.
    expect([200, 302]).toContain((await fetch(`${origin}/admin/`, { redirect: "manual" })).status);
  });

  it("gives a brick that requires oidc its own client: a token for the router, from inside the platform (D19)", () => {
    // Only what the platform injected into orders-web: its token endpoint inside the platform, its id and its secret.
    const asked = spawnSync(
      "docker",
      [
        "compose",
        "--project-name",
        brickProject,
        "exec",
        "-T",
        "orders-web-app",
        "node",
        "-e",
        `const { OIDC_TOKEN_URL: url, OIDC_CLIENT_ID: id, OIDC_CLIENT_SECRET: secret } = process.env;
         const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
           body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
         const t = await r.json();
         const c = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url"));
         console.log(JSON.stringify({ status: r.status, url, id, iss: c.iss, aud: c.aud, azp: c.azp, roles: c.resource_access }));`,
      ],
      { encoding: "utf8" },
    );
    expect(asked.status, asked.stderr).toBe(0);
    const token = JSON.parse(asked.stdout.trim().split("\n").pop()!);
    expect(token).toMatchObject({
      status: 200,
      url: "http://keycloak-app:8080/realms/plugbricks/protocol/openid-connect/token",
      id: "orders-web",
      // The browser's issuer even though the token was asked inside the platform: what the router will require.
      iss: `${origin}/realms/plugbricks`,
      azp: "orders-web",
    });
    expect(token.aud).toContain("plugbricks-router");
    // D22: orders-web lists orders-api (queries by default), so its service account holds orders:read under the client
    // of orders-api, and nothing else of it: no orders:write. The roles are in the token, not looked up when it is used.
    expect(token.roles["orders-api"]).toEqual({ roles: ["orders:read"] });

    // The provision task ran once per up and is idempotent; its secret never went on a command line.
    const provision = spawnSync(
      "docker",
      ["compose", "--project-name", brickProject, "logs", "--no-log-prefix", "orders-web-provision-oidc"],
      {
        encoding: "utf8",
      },
    );
    expect(provision.stdout).toContain("create-client: created client orders-web in realm plugbricks");
  });

  it("runs its provision task again without harm, and refuses to take over a client it did not create", () => {
    const compose = (...args: string[]) =>
      spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          brickProject,
          "--file",
          join(project, ".generated/compose/compose.yaml"),
          "--env-file",
          join(project, ".secrets/secrets.env"),
          ...args,
        ],
        { encoding: "utf8" },
      );
    // Again, as the next up would: the client is ours, so its secret is set again and nothing else changes.
    const again = compose("run", "--rm", "--no-deps", "orders-web-provision-oidc");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("create-client: client orders-web already in realm plugbricks; its secret set again");
    expect(again.stdout).not.toContain("had no audience");

    // A consumer named like the admin's public client: refused, and that client stays public (the sign-in test below
    // still signs in with it).
    const taken = compose("run", "--rm", "--no-deps", "-e", "CLIENT_ID=plugbricks-admin", "orders-web-provision-oidc");
    expect(taken.status).toBe(1);
    expect(taken.stderr).toContain("already has a client plugbricks-admin that plugbricks did not create");
  }, 120_000);

  it("puts the router behind tokens: none 401, another issuer 401, orders-web's 200, and its page through it (D19)", async () => {
    const secrets = readFileSync(join(project, ".secrets/secrets.env"), "utf8");
    const secretOf = (name: string) => new RegExp(`^${name}=(.+)$`, "m").exec(secrets)![1];
    const tokenAt = async (realm: string, form: Record<string, string>) => {
      const r = await fetch(`${origin}/realms/${realm}/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
      expect(r.status, `token from realm ${realm}`).toBe(200);
      return ((await r.json()) as { access_token: string }).access_token;
    };
    const graphql = async (query: string, token?: string) => {
      const r = await fetch(`http://127.0.0.1:${routerPort}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ query }),
      });
      return { status: r.status, body: (await r.json()) as { data?: { createOrder?: { id: string; createdBy: string | null } } } };
    };

    // Without a token, nothing runs through the router, not even a read; its health stays open (Kubernetes probes).
    expect((await graphql("mutation { createOrder(total: 1) { id } }")).status).toBe(401);
    expect((await graphql("{ orders(limit: 1) { id } }")).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${routerPort}/health/ready`)).status).toBe(200);
    // A real Keycloak token, but from the master realm: another issuer and no audience for the router.
    const admin = await tokenAt("master", {
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: secretOf("PB_KEYCLOAK__ADMIN_PASSWORD"),
    });
    expect((await graphql("{ orders(limit: 1) { id } }", admin)).status).toBe(401);
    // orders-web's own client: what its server uses.
    const asOrdersWeb = () =>
      tokenAt("plugbricks", {
        grant_type: "client_credentials",
        client_id: "orders-web",
        client_secret: secretOf("PB_KEYCLOAK__ORDERS_WEB__CLIENT_SECRET"),
      });
    const readOnly = await asOrdersWeb();
    // D22: its token may read through the router, but createOrder is a mutation and orders asks for orders:write: the
    // router passes the token on, orders refuses it before the resolver runs. 401 is for a token that is not valid;
    // this one is, it is the caller that is not allowed.
    expect((await graphql("{ orders(limit: 1) { id } }", readOnly)).status).toBe(200);
    const refused = await graphql("mutation { createOrder(total: 1) { id } }", readOnly);
    expect(refused.body.data?.createOrder ?? null).toBeNull();
    expect(JSON.stringify(refused.body)).toMatch(/FORBIDDEN|forbidden/);
    // The operator gives it the write role in Keycloak (the console or kcadm), as it would any service account. A token
    // issued before keeps what it had: the roles are in the token for its 300 s.
    const kcadm = spawnSync(
      "docker",
      [
        "compose",
        "--project-name",
        brickProject,
        "exec",
        "-T",
        "-e",
        `KC_CLI_PASSWORD=${secretOf("PB_KEYCLOAK__ADMIN_PASSWORD")}`,
        "keycloak-app",
        "bash",
        "-c",
        [
          "set -e",
          "k=/opt/keycloak/bin/kcadm.sh; c=$(mktemp -d)",
          'login() { "$k" "$@" --config "$c/kcadm.config"; }',
          "login config credentials --server http://127.0.0.1:8080 --realm master --user admin >/dev/null",
          "login add-roles -r plugbricks --uusername service-account-orders-web --cclientid orders-api --rolename orders:write",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    expect(kcadm.status, kcadm.stderr).toBe(0);
    expect((await graphql("mutation { createOrder(total: 1) { id } }", readOnly)).body.data?.createOrder ?? null).toBeNull();
    // With a token asked after the grant, an order is created through the router.
    const own = await asOrdersWeb();
    const created = await graphql("mutation { createOrder(total: 42.5) { id createdBy } }", own);
    // 200 with data: the router passed the token on, and orders checked it again itself (D20).
    expect(created.status).toBe(200);
    expect(created.body.data?.createOrder?.id).toBeTruthy();
    // D20 point 4: orders recorded who created it, from the token it verified: orders-web's service account.
    expect(created.body.data?.createOrder?.createdBy).toBe("service-account-orders-web");

    // A service of the platform calling orders directly, past the router (D20): no token, or a forged identity
    // header, gets 401 from orders itself.
    const direct = (headers: Record<string, string>, query = "{ orders(limit: 1) { id } }") => {
      const r = spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          brickProject,
          "exec",
          "-T",
          "orders-web-app",
          "node",
          "-e",
          `const r = await fetch("http://orders-api-app:4000/graphql", { method: "POST", headers: ${JSON.stringify({ "content-type": "application/json", ...headers })}, body: JSON.stringify({ query: ${JSON.stringify(query)} }) }); console.log(r.status);`,
        ],
        { encoding: "utf8" },
      );
      expect(r.status, r.stderr).toBe(0);
      return Number(r.stdout.trim().split("\n").pop());
    };
    expect(direct({})).toBe(401);
    expect(direct({ "x-user-sub": "admin-forged" })).toBe(401);
    expect(direct({ authorization: `Bearer ${own}` })).toBe(200);
    // D22: past the router, a valid token without the role is refused by orders itself: 403, not 401 and not data.
    expect(direct({ authorization: `Bearer ${readOnly}` })).toBe(200);
    expect(direct({ authorization: `Bearer ${readOnly}` }, "mutation { createOrder(total: 1) { id } }")).toBe(403);
    const id = created.body.data!.createOrder!.id;

    // The page, rendered by orders-web's server with its token. No shipping brick here: no shipment field in the
    // schema, so the page asks without it and shows the shipment unavailable.
    const page = await (await fetch(`http://127.0.0.1:${webPort + 1}/orders`)).text();
    expect(page).toContain(`<tr><td>#${id}</td><td>42.50</td>`);
    expect(page).toContain("Unavailable");
    // Its "Refresh" asks its own server, never the router.
    const refreshed = (await (await fetch(`http://127.0.0.1:${webPort + 1}/api/orders`)).json()) as { rows: string };
    expect(refreshed.rows).toContain(`#${id}`);
    // Real docker execs and a kcadm login: well over vitest's 5 s.
  }, 60_000);

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
      // Found in the platform, as `plugbricks admin` does without --issuer (D19): the keycloak brick's issuer.
      issuer: platformOidcIssuer(readProject(project))!.issuer,
      clientId: "plugbricks-admin",
      uiDir: fakeUi(join(work, "ui")),
      runtimeDeps: { exec: () => ({ status: 0, stdout: "[]", stderr: "" }) },
    });
    await admin.ready;
    const session = await signInThroughKeycloak(browser(), appBase, origin, "alice", userPassword);
    expect(session).toMatchObject({ authenticated: true, dev: false, role: "admin", name: "Alice Admin", project: brickProject });
  }, 300_000);
});

// ---------- a service written by create, behind the router and the Keycloak of the platform (D46 to D49) ----------
// What the tests of the services alone (a JWKS and made-up tokens) cannot say: that the names the manifest gives (the
// roles, the scopes a dependency lists) are the ones Keycloak puts in the token, and that the router and the service each
// refuse what the schema asks them to. The caller is a brick of its own, as a web brick is: its service account holds the
// role of the queries and two of the scopes of the schema.
const stockProject = "pbtest-kcstock";
const stockKeycloak = 18101;
const stockRouter = 14121;

describe.skipIf(!composeReady)("a service written by create behind the router and Keycloak (D46 to D49)", () => {
  const work = join(pkg, ".test-work/oidc-stock");
  const project = join(work, "project");
  const origin = `http://127.0.0.1:${stockKeycloak}`;
  const cli = (args: string[]) => {
    const out: string[] = [];
    const code = main(args, { cwd: project, stdout: (l) => out.push(l), stderr: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };
  const compose = (...args: string[]) => spawnSync("docker", ["compose", "--project-name", stockProject, ...args], { encoding: "utf8" });
  let names = { type: "", field: "" };

  beforeAll(async () => {
    const build = spawnSync("docker", ["build", "--quiet", "--tag", exampleImage("keycloak"), join(repo, "apis", "keycloak")], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    compose("down", "--volumes", "--remove-orphans");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(project, "bricks"), { recursive: true });
    for (const brick of ["postgres", "keycloak"]) cpSync(join(pkg, "examples", brick), join(project, "bricks", brick), { recursive: true });
    expect(cli(["init", "--name", stockProject]).code).toBe(0);

    // The service, written by create, then given a mutation and rules on its schema, and the roles of a manifest.
    const created = cli(["create", "stock", "--kind", "api", "--lang", "node"]);
    expect(created.code, created.out).toBe(0);
    // create installed it as written; it is added again below, once its schema and its manifest are changed.
    expect(cli(["remove", "stock-api"]).code).toBe(0);
    const line = /^ {2}(docker build .*)$/m.exec(created.out)![1];
    const [cmd, ...args] = line.split(" ");
    names = shape(project, "stock-api", "node", { withInterface: false });
    const built = spawnSync(cmd, args, { cwd: project, encoding: "utf8" });
    expect(built.status, `${line}\n${built.stderr}`).toBe(0);
    const manifestFile = join(project, "bricks/stock-api/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.authorization = { queries: "stock:read", mutations: "stock:write" };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

    // The caller: a brick that asks for oidc (so it gets a client of its own) and lists the service, with the role of its
    // queries and two scopes of the schema. Its container does nothing; the test asks Keycloak for its token.
    mkdirSync(join(project, "bricks/caller"), { recursive: true });
    writeFileSync(
      join(project, "bricks/caller/plugin.json"),
      JSON.stringify({
        name: "caller",
        version: "0.1.0",
        description: "Holds a client of its own in Keycloak, for the test.",
        services: [{ name: "app", image: "busybox:1.36", port: 8080, args: ["sleep", "86400"], healthcheck: { exec: ["true"] } }],
        requires: { oidc: {} },
        dependencies: [{ plugin: "stock-api", operations: ["queries"], scopes: ["items:read", "items:secret"] }],
      }),
    );
    for (const args of [
      ["add", "postgres"],
      ["add", "keycloak"],
      ["add", "stock-api"],
      ["add", "caller"],
    ]) {
      const r = cli(args);
      expect(r.code, `${args.join(" ")}\n${r.out}`).toBe(0);
    }
    const file = join(project, "platform.json");
    const platform = JSON.parse(readFileSync(file, "utf8"));
    platform.bricks.keycloak.webPort = stockKeycloak;
    platform.router = { port: stockRouter };
    writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");
    const up = cli(["up"]);
    expect(up.code, up.out).toBe(0);
  }, 900_000);

  afterAll(() => {
    compose("down", "--volumes", "--remove-orphans");
  }, 120_000);

  const secrets = () => readFileSync(join(project, ".secrets/secrets.env"), "utf8");
  const callerToken = async () => {
    const secret = new RegExp("^PB_KEYCLOAK__CALLER__CLIENT_SECRET=(.+)$", "m").exec(secrets())![1];
    const r = await fetch(`${origin}/realms/plugbricks/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "caller", client_secret: secret }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { access_token: string }).access_token;
  };
  const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const throughRouter = async (query: string, token?: string) => {
    const r = await fetch(`http://127.0.0.1:${stockRouter}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    return {
      status: r.status,
      text,
      body: JSON.parse(text) as { data?: Record<string, unknown> | null; errors?: { message: string; path?: unknown[] }[] },
    };
  };
  /** A call from inside the service's own container to itself, past the router. */
  const direct = (query: string, authorization?: string) => {
    const headers = { "content-type": "application/json", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) };
    const r = compose(
      "exec",
      "-T",
      "stock-api-app",
      "node",
      "-e",
      `const r = await fetch("http://127.0.0.1:4000/graphql", { method: "POST", headers: ${JSON.stringify(headers)}, body: JSON.stringify({ query: ${JSON.stringify(query)} }) });
       console.log(JSON.stringify({ status: r.status, text: await r.text() }));`,
    );
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").pop()!) as { status: number; text: string };
  };

  it("puts the role of the queries and the scopes its dependency lists in the caller's token", async () => {
    expect((await throughRouter(`{ ${names.field} { id } }`)).status).toBe(401);
    const claims = claimsOf(await callerToken());
    // The role of the queries of stock-api on its own client, and not the one of its mutations (D22).
    expect(claims.resource_access["stock-api"]).toEqual({ roles: ["stock:read"] });
    // The two scopes the dependency lists (D44), and none of the others the schema asks for.
    const scopes = String(claims.scope).split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["items:read", "items:secret"]));
    for (const other of ["admin", "a", "b", "items:tag"]) expect(scopes).not.toContain(other);
  }, 60_000);

  it("applies the rules of the schema per field, through the router and past it", async () => {
    const token = await callerToken();
    const { field } = names;
    const ask = `{ ${field} { id name secret pair known } }`;
    // Through the router: items:read (the type) and items:secret are held, a and b (pair) are not.
    const answer = await throughRouter(ask, token);
    expect(answer.status, answer.text).toBe(200);
    const items = answer.body.data?.[field] as { id: string; name: string; secret: string | null; pair: string | null; known: string }[];
    expect(
      items.map((i) => [i.id, i.name, i.secret, i.pair, i.known]),
      answer.text,
    ).toEqual([
      ["1", "first", "s1", null, "k1"],
      ["2", "second", "s2", null, "k2"],
    ]);
    // The router redacts the field with its own error, and the service refused it too: its error comes back inside the
    // router's "Failed to fetch from Subgraph" (the router asks the subgraph for a protected field, then redacts it).
    const routerErrors = (answer.body.errors ?? []).filter(
      (e) => (e as { extensions?: { code?: string } }).extensions?.code === "UNAUTHORIZED_FIELD_OR_TYPE",
    );
    expect(
      routerErrors.map((e) => e.path),
      answer.text,
    ).toEqual([
      [field, 0, "pair"],
      [field, 1, "pair"],
    ]);
    expect(answer.text).toContain("forbidden: this token lacks what StockItem.pair asks for");

    // Past the router the service applies the same rules itself: the same fields, the same refusal for pair.
    const past = direct(ask, token);
    expect(past.status, past.text).toBe(200);
    const direct_ = JSON.parse(past.text);
    expect(direct_.data[field].map((i: { secret: string | null; pair: string | null }) => [i.secret, i.pair])).toEqual([
      ["s1", null],
      ["s2", null],
    ]);
    expect(direct_.errors.map((e: { path: unknown[]; extensions: { code: string } }) => [e.path.at(-1), e.extensions.code])).toEqual([
      ["pair", "FORBIDDEN"],
      ["pair", "FORBIDDEN"],
    ]);
    // No token past the router: 401 from the service itself (D46).
    expect(direct(`{ ${field} { id } }`).status).toBe(401);
  }, 120_000);

  it("refuses a mutation for lack of the role, then lets it through once the role is granted (D22, D48)", async () => {
    const before = await callerToken();
    // The router passes the token on; the service refuses the class of operation before any resolver runs.
    const refused = await throughRouter("mutation { touch }", before);
    expect(refused.body.data?.touch ?? null, refused.text).toBeNull();
    expect(refused.text).toMatch(/FORBIDDEN|forbidden/);
    const past = direct("mutation { touch }", before);
    expect(past.status, past.text).toBe(403);
    expect(past.text).toContain('the role \\"stock:write\\" of client \\"stock-api\\"');

    // The operator grants the role in Keycloak. A token issued before keeps what it had (300 s).
    const password = new RegExp("^PB_KEYCLOAK__ADMIN_PASSWORD=(.+)$", "m").exec(secrets())![1];
    const granted = compose(
      "exec",
      "-T",
      "-e",
      `KC_CLI_PASSWORD=${password}`,
      "keycloak-app",
      "bash",
      "-c",
      [
        "set -e",
        "k=/opt/keycloak/bin/kcadm.sh; c=$(mktemp -d)",
        'login() { "$k" "$@" --config "$c/kcadm.config"; }',
        "login config credentials --server http://127.0.0.1:8080 --realm master --user admin >/dev/null",
        "login add-roles -r plugbricks --uusername service-account-caller --cclientid stock-api --rolename stock:write",
      ].join("; "),
    );
    expect(granted.status, granted.stderr).toBe(0);
    expect(direct("mutation { touch }", before).status).toBe(403);
    const after = await callerToken();
    const done = await throughRouter("mutation { touch }", after);
    expect(done.body, done.text).toEqual({ data: { touch: true } });
    expect(JSON.parse(direct("mutation { touch }", after).text)).toEqual({ data: { touch: true } });
  }, 120_000);
});

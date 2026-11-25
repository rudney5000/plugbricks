import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { LiveStatus } from "../src/live.js";
import { schemaIssues, statusRuntimeSchema } from "../src/schemas.js";
import { get, through, until } from "./helpers/graphql.js";

// Runs the Compose driver against the real Docker: provisioning, secret injection, WAIT_TIMEOUT,
// down. Skipped, with the reason in the title, where no Linux Docker engine answers (macOS and
// Windows CI runners). The work dir is under the package: Docker installed as a snap cannot see /tmp.

const pkg = fileURLToPath(new URL("../", import.meta.url));
const workRoot = join(pkg, ".test-work/e2e");
const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const ready = docker.status === 0 && docker.stdout.trim() === "linux" && compose.status === 0;
const why = ready ? "" : " (skipped: needs a Linux Docker engine with the Compose v2 plugin)";

const projects: string[] = [];

function project(name: string, bricks: string[]): string {
  const work = join(workRoot, name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(pkg, "examples/postgres"), join(work, "postgres"), { recursive: true });
  for (const b of bricks) cpSync(join(pkg, "test/fixtures/e2e", b), join(work, b), { recursive: true });
  projects.push(name);
  // A project left over by an interrupted run would keep its volume and its old passwords.
  spawnSync("docker", ["compose", "--project-name", name, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
  return work;
}

/**
 * A platform with a subgraph gets a router published on 127.0.0.1:<router.port>. These projects stay up
 * until the end of the file, so each one gets its own port: two routers on 4000 would collide.
 */
function routerPort(work: string, port: number): void {
  const file = join(work, "platform.json");
  const platform = JSON.parse(readFileSync(file, "utf8"));
  platform.router = { port };
  writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");
}

function cli(work: string, args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { cwd: work, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

afterAll(() => {
  // Test projects only: their volumes go too.
  for (const p of projects)
    spawnSync("docker", ["compose", "--project-name", p, "down", "--volumes", "--remove-orphans"], { encoding: "utf8" });
});

describe("Docker Compose driver against a real Docker engine", () => {
  it.skipIf(!ready)(
    `provisions a database for the consumer and injects DATABASE_URL with its generated password${why}`,
    () => {
      const name = "pbtest-provision";
      const work = project(name, ["shop"]);
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "shop"],
      ])
        expect(cli(work, args).code).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, up.err).toBe(0);
      const q = spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "exec",
          "-T",
          "shop-api",
          "sh",
          "-c",
          'psql "$DATABASE_URL" -Atc "select current_user, current_database()"; printf %s "$PRICE"',
        ],
        { encoding: "utf8" },
      );
      expect(q.status, q.stderr).toBe(0);
      expect(q.stdout).toBe("shop|shop\ncosts $5");

      // A second up changes no file, and the password in the env file is the one the role got.
      const before = readFileSync(join(work, ".secrets/secrets.env"), "utf8");
      expect(cli(work, ["up"]).code).toBe(0);
      expect(readFileSync(join(work, ".secrets/secrets.env"), "utf8")).toBe(before);

      const down = cli(work, ["down"]);
      expect(down.code, down.err).toBe(0);
      const vols = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", `name=${name}_`], { encoding: "utf8" });
      expect(vols.stdout.trim().split("\n")).toEqual([`${name}_postgres-db-data`]);
    },
    240_000,
  );

  it.skipIf(!ready)(
    `runs the orders API on its own database: data kept across down/up, no access to another consumer's database${why}`,
    () => {
      const repo = fileURLToPath(new URL("../../../", import.meta.url));
      const build = spawnSync(
        "docker",
        ["build", "--quiet", "--tag", "plugbricks-example/orders-api:0.1.0", join(repo, "apis/orders-api")],
        {
          encoding: "utf8",
        },
      );
      expect(build.status, build.stderr).toBe(0);

      const name = "pbtest-orders";
      const work = project(name, ["shop"]);
      cpSync(join(pkg, "examples/orders-api"), join(work, "orders-api"), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shop"],
      ])
        expect(cli(work, args).code).toBe(0);
      routerPort(work, 14101);
      const up = cli(work, ["up"]);
      expect(up.code, up.err).toBe(0);

      // Only the router is published on the host (4b-4 tests it): query the API by its network name from a throwaway container.
      const gql = (query: string) => {
        const r = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            `${name}_default`,
            "node:22.23.5-alpine",
            "wget",
            "-qO-",
            "--header",
            "content-type: application/json",
            "--post-data",
            JSON.stringify({ query }),
            "http://orders-api-app:4000/graphql",
          ],
          { encoding: "utf8" },
        );
        expect(r.status, r.stderr).toBe(0);
        return JSON.parse(r.stdout);
      };
      const created = gql("mutation { createOrder(total: 42.5) { id total status } }");
      expect(created.data.createOrder).toMatchObject({ total: 42.5, status: "pending" });
      const id = created.data.createOrder.id;

      expect(cli(work, ["down"]).code).toBe(0);
      expect(cli(work, ["up"]).code).toBe(0);
      expect(gql(`{ order(id: "${id}") { id total } }`)).toEqual({ data: { order: { id, total: 42.5 } } });

      // orders-api's role cannot even connect to shop's database (the provision task revokes PUBLIC).
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8");
      const pw = /^PB_POSTGRES__ORDERS_API__CONSUMER_PASSWORD=(\w+)$/m.exec(secrets)![1];
      const probe = spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "exec",
          "-T",
          "shop-api",
          "psql",
          `postgres://orders-api:${pw}@postgres-db:5432/shop`,
          "-Atc",
          "select 1",
        ],
        { encoding: "utf8" },
      );
      expect(probe.status).not.toBe(0);
      expect(probe.stderr).toMatch(/permission denied for database "shop"/);
    },
    600_000,
  );

  it.skipIf(!ready)(
    `reports WAIT_TIMEOUT when a capability never becomes ready${why}`,
    () => {
      const name = "pbtest-timeout";
      const work = project(name, ["never", "patient"]);
      for (const args of [
        ["init", "--name", name],
        ["add", "never"],
        ["add", "patient"],
      ])
        expect(cli(work, args).code).toBe(0);
      const up = cli(work, ["up"]);
      expect(up.code).toBe(1);
      expect(up.err).toContain('error WAIT_TIMEOUT: "patient" gave up waiting for capability "slow" from "never" after 3s');
    },
    240_000,
  );
});

// ---------- the router in front of orders and shipping ----------
// Real requests through the router, on the loopback address it is published on, to the real orders and
// shipping APIs and real PostgreSQL databases: never to an API directly. The three scenarios of
// "the router in front of orders and shipping" SHARE ONE RUNNING PROJECT and run in order (an order is
// created in the first and read in the second): it saves two builds and two `up` of the same stack, about
// a minute. They are independent of every other project of this file, which has its own name and port.

const routerReady = (port: number) => until(`the router on ${port}`, async () => (await get(port, "/health/ready")) === 200);

/** The router container of a project: its id and the configuration hash it was created with. */
function routerContainer(project: string): { id: string; hash: string } | undefined {
  const ps = spawnSync("docker", ["compose", "--project-name", project, "ps", "--all", "--quiet", "router"], { encoding: "utf8" });
  const id = ps.stdout.trim().split("\n")[0];
  if (!id) return undefined;
  const hash = spawnSync("docker", ["inspect", "--format", '{{index .Config.Labels "plugbricks.router-config-sha256"}}', id], {
    encoding: "utf8",
  });
  return { id, hash: hash.stdout.trim() };
}

const containersOf = (project: string, ...extra: string[]) =>
  spawnSync("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, ...extra], { encoding: "utf8" }).stdout;

/** sha256 of every file of a folder: two equal snapshots mean nothing was written, changed or removed. */
function folderHash(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${entry}` : entry;
    if (statSync(join(dir, r)).isDirectory()) Object.assign(out, folderHash(dir, r));
    else
      out[r] = createHash("sha256")
        .update(readFileSync(join(dir, r)))
        .digest("hex");
  }
  return out;
}

let apisBuilt = false;
function buildExampleApis(): void {
  if (apisBuilt) return;
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  for (const api of ["orders-api", "shipping-api", "orders-web"]) {
    const build = spawnSync("docker", ["build", "--quiet", "--tag", `plugbricks-example/${api}:0.1.0`, join(repo, "apis", api)], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
  }
  apisBuilt = true;
}

let queueConsumerBuilt = false;
/** Builds the consumer image once: its /health describes a real publish/consume through the broker. */
function buildQueueConsumer(): void {
  if (queueConsumerBuilt) return;
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const build = spawnSync(
    "docker",
    ["build", "--quiet", "--tag", "plugbricks-example/queue-consumer:0.1.0", join(repo, "apis/queue-consumer")],
    {
      encoding: "utf8",
    },
  );
  expect(build.status, build.stderr).toBe(0);
  queueConsumerBuilt = true;
}

describe("the router in front of orders and shipping", () => {
  const name = "pbtest-router";
  const port = 14103;
  let work = "";
  let orderId = "";
  let tracking = "";
  let firstRouter: { id: string; hash: string };
  const ask = (label: string, query: string, variables?: Record<string, unknown>) => through(port, label, query, variables);
  const ORDER = "query($id: ID!) { order(id: $id) { id total status shipment { carrier trackingNumber status } } }";

  it.skipIf(!ready)(
    `serves one graph from two services: the order from orders and its shipment from shipping, in a single request${why}`,
    async () => {
      buildExampleApis();
      work = project(name, []);
      for (const brick of ["orders-api", "shipping-api"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shipping-api"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);
      routerPort(work, port);
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      await routerReady(port);
      console.log(
        `docker ps (project ${name}):\n${containersOf(name, "--format", "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")}`,
      );
      firstRouter = routerContainer(name)!;
      expect(firstRouter.hash).toMatch(/^[a-f0-9]{64}$/);

      // The playground is off, the readiness endpoint answers.
      expect(await get(port, "/")).toBe(404);
      expect(await get(port, "/health/ready")).toBe(200);
      // The router is the only thing published on the host, on the loopback address only.
      expect(containersOf(name, "--format", "{{.Ports}}")).not.toMatch(/0\.0\.0\.0:|\[::\]:/);
      expect(containersOf(name, "--format", "{{.Ports}}").match(/127\.0\.0\.1:\d+->/g)).toEqual([`127.0.0.1:${port}->`]);

      // Each API has its own database and role, and cannot even connect to the other's (checked here, on the
      // stack the requests below use; these assertions were a separate test that started the same stack again).
      const psql = (sql: string) =>
        spawnSync("docker", ["compose", "--project-name", name, "exec", "-T", "postgres-db", "psql", "-U", "postgres", "-Atc", sql], {
          encoding: "utf8",
        });
      const databases = psql("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1");
      expect(databases.stdout.trim().split("\n"), databases.stderr).toEqual(["orders-api", "postgres", "shipping-api"]);
      const roles = psql("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1");
      expect(roles.stdout.trim().split("\n"), roles.stderr).toEqual(["orders-api", "postgres", "shipping-api"]);
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8");
      const password = (consumer: string) =>
        new RegExp(`^PB_POSTGRES__${consumer.toUpperCase().replace(/-/g, "_")}__CONSUMER_PASSWORD=(\\w+)$`, "m").exec(secrets)![1];
      const connect = (role: string, database: string) =>
        spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            `${name}_default`,
            "postgres:16.4-alpine",
            "psql",
            `postgres://${role}:${password(role)}@postgres-db:5432/${database}`,
            "-Atc",
            "select current_user, current_database()",
          ],
          { encoding: "utf8" },
        );
      expect(connect("shipping-api", "shipping-api").stdout.trim()).toBe("shipping-api|shipping-api");
      const denied = connect("shipping-api", "orders-api");
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toMatch(/permission denied for database "orders-api"/);
      console.log(`shipping role on the orders database: ${denied.stderr.trim().split("\n")[0]}`);
      expect(connect("orders-api", "shipping-api").stderr).toMatch(/permission denied for database "shipping-api"/);

      // 1. An order, created through the router (the orders subgraph), asked for with its shipment before it is shipped.
      const created = await ask("createOrder", "mutation { createOrder(total: 42.5) { id total status } }");
      expect(created.body.errors).toBeUndefined();
      orderId = created.body.data.createOrder.id;
      expect(created.body.data.createOrder).toEqual({ id: orderId, total: 42.5, status: "pending" });
      const before = await ask("order before shipping", ORDER, { id: orderId });
      expect(before.body).toEqual({ data: { order: { id: orderId, total: 42.5, status: "pending", shipment: null } } });

      // 2. Shipped through the router (the shipping subgraph), then the same query: one request, two services.
      const shipped = await ask(
        "shipOrder",
        'mutation($id: ID!) { shipOrder(orderId: $id, carrier: "ups") { carrier trackingNumber status } }',
        { id: orderId },
      );
      expect(shipped.body.errors).toBeUndefined();
      tracking = shipped.body.data.shipOrder.trackingNumber;
      expect(shipped.body.data.shipOrder).toEqual({
        carrier: "ups",
        trackingNumber: expect.stringMatching(/^TRK-[0-9A-F]{10}$/),
        status: "SHIPPED",
      });
      const after = await ask("order after shipping", ORDER, { id: orderId });
      // total and status exist only in orders; carrier, trackingNumber and the shipment status only in shipping.
      expect(after.body).toEqual({
        data: {
          order: { id: orderId, total: 42.5, status: "pending", shipment: { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" } },
        },
      });

      // 3. A field that does not exist is a GraphQL validation error, and the router stays up.
      const unknown = await ask("unknown field", 'query { order(id: "1") { nope } }');
      expect(unknown.status).toBe(200); // the router reports GraphQL errors in the body, as the GraphQL over HTTP convention allows
      expect(unknown.body.data).toBeUndefined();
      expect(unknown.body.errors[0].message).toContain('Cannot query field "nope" on type "Order"');
      expect(await get(port, "/health/ready")).toBe(200);

      // Known limits (docs/decisions.md, D8), asserted so that the day one is fixed, this test says so: shipping
      // cannot know which orders exist (it has its own database), so it ships an order id that orders never created,
      // and that shipment is visible through the graph only by asking shipping directly, never through an Order.
      const ghost = await ask(
        "shipOrder for an order that does not exist",
        'mutation { shipOrder(orderId: "999999", carrier: "ups") { carrier status } }',
      );
      expect(ghost.body.data.shipOrder).toEqual({ carrier: "ups", status: "SHIPPED" });
      expect(
        (await ask("shipment of the unknown order, asked directly", 'query { shipment(orderId: "999999") { carrier status } }')).body.data
          .shipment,
      ).toEqual({
        carrier: "ups",
        status: "SHIPPED",
      });
      expect((await ask("the unknown order itself", 'query { order(id: "999999") { id shipment { carrier } } }')).body).toEqual({
        data: { order: null },
      });
    },
    900_000,
  );

  it.skipIf(!ready)(
    `accepts browser calls only from its allowed origins: a cross-site mutation is refused and runs nothing (D17)${why}`,
    async () => {
      const count = async () => (await ask("how many orders", "query { orders(limit: 500) { id } }")).body.data.orders.length;
      const before = await count();
      const mutation = JSON.stringify({ query: "mutation { createOrder(total: 1) { id } }" });
      const cross = async (origin: string, contentType: string) =>
        (
          await fetch(`http://127.0.0.1:${port}/graphql`, {
            method: "POST",
            headers: { origin, "content-type": contentType },
            body: mutation,
          })
        ).status;
      const preflight = async (origin: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        return { status: res.status, allow: res.headers.get("access-control-allow-origin") };
      };
      // A request a browser sends without asking first (text/plain), and one it would preflight (JSON): both refused.
      expect(await cross("http://evil.example", "text/plain")).toBe(403);
      expect(await cross("http://evil.example", "application/json")).toBe(403);
      expect((await preflight("http://evil.example")).status).toBe(403);
      // Nothing was created by the refused requests.
      expect(await count()).toBe(before);
      // The router's own origin is the only one allowed while the platform has no web brick: a request from it
      // runs. (A preflight from it gets 400: the router sees a same-origin request, which needs no preflight.)
      const own = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      expect(own.status).toBe(200);
      console.log(`cross-site mutation from http://evil.example: 403, orders before and after: ${before}`);
    },
    120_000,
  );

  it.skipIf(!ready)(
    `follows the composition: remove shipping drops the field and recreates the router, add brings it back, remove orders is refused${why}`,
    async () => {
      // remove shipping, then up: the router is recreated with a configuration that has no shipment.
      expect(cli(work, ["remove", "shipping-api"]).code).toBe(0);
      const removed = cli(work, ["up"]);
      expect(removed.code, `${removed.out}\n${removed.err}`).toBe(0);
      const withoutShipping = routerContainer(name)!;
      expect(withoutShipping.id).not.toBe(firstRouter.id);
      expect(withoutShipping.hash).not.toBe(firstRouter.hash);
      expect(containersOf(name, "--format", "{{.Names}}")).not.toContain("shipping-api-app");
      await routerReady(port);
      const gone = await ask("shipment after remove shipping", ORDER, { id: orderId });
      expect(gone.body.data).toBeUndefined();
      expect(gone.body.errors[0].message).toContain('Cannot query field "shipment" on type "Order"');
      // orders alone still works, with the order it kept.
      const alone = await ask("orders alone", "query($id: ID!) { order(id: $id) { id total status } }", { id: orderId });
      expect(alone.body).toEqual({ data: { order: { id: orderId, total: 42.5, status: "pending" } } });

      // add shipping again, then up: recreated again, not left stale; the same bricks give the same hash as at the start.
      expect(cli(work, ["add", "shipping-api"]).code).toBe(0);
      const added = cli(work, ["up"]);
      expect(added.code, `${added.out}\n${added.err}`).toBe(0);
      const again = routerContainer(name)!;
      expect(again.id).not.toBe(withoutShipping.id);
      expect(again.hash).not.toBe(withoutShipping.hash);
      expect(again.hash).toBe(firstRouter.hash);
      await routerReady(port);
      // The shipment is back, and so is its data: the shipping database kept it.
      const back = await ask("shipment after add shipping", ORDER, { id: orderId });
      expect(back.body).toEqual({
        data: {
          order: { id: orderId, total: 42.5, status: "pending", shipment: { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" } },
        },
      });

      // orders cannot be removed while shipping extends its Order entity, and nothing changes: no file, no container.
      const snapshot = folderHash(work);
      const refused = cli(work, ["remove", "orders-api"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/^error EXTENDS_IN_USE: cannot remove "orders-api": its entities are still extended by "shipping-api"/m);
      console.log(`remove orders: ${refused.err}`);
      expect(folderHash(work)).toEqual(snapshot);
      expect(routerContainer(name)!.id).toBe(again.id);
      expect(await get(port, "/health/ready")).toBe(200);
    },
    900_000,
  );

  it.skipIf(!ready)(
    `after down there is no router container, nothing is published and the volumes are kept; up brings the graph and its data back${why}`,
    async () => {
      const down = cli(work, ["down"]);
      expect(down.code, down.err).toBe(0);
      expect(containersOf(name, "--format", "{{.Names}}").trim()).toBe("");
      expect(routerContainer(name)).toBeUndefined();
      // Nothing listens on the published port any more.
      await expect(get(port, "/health/ready")).rejects.toThrow();
      // down never deletes what generate wrote, so the configuration is still there; and no volume is deleted (D3).
      expect(readFileSync(join(work, ".generated/compose/router-config.json"), "utf8")).toContain('"subgraphs"');
      const volumes = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", `name=${name}_`], { encoding: "utf8" })
        .stdout.trim()
        .split("\n");
      expect(volumes).toEqual([`${name}_postgres-db-data`]);
      console.log(
        `after down: containers=[${containersOf(name, "--format", "{{.Names}}").trim()}] volumes=[${volumes.join(", ")}] router-config.json kept`,
      );

      // up again brings the whole graph back, with the data of both databases.
      const again = cli(work, ["up"]);
      expect(again.code, `${again.out}\n${again.err}`).toBe(0);
      await routerReady(port);
      const back = await through(port, "order after down and up", ORDER, { id: orderId });
      expect(back.body).toEqual({
        data: {
          order: { id: orderId, total: 42.5, status: "pending", shipment: { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" } },
        },
      });
    },
    300_000,
  );
});

describe("a web brick in front of the router (D17)", () => {
  const name = "pbtest-web";
  const routerAt = 14105;
  const pageAt = 14106;
  const page = (path = "/orders") => fetch(`http://127.0.0.1:${pageAt}${path}`);

  it.skipIf(!ready)(
    `serves its page on its own loopback port, reads the orders through the router, and keeps them when shipping is down${why}`,
    async () => {
      buildExampleApis();
      const work = project(name, []);
      for (const brick of ["orders-api", "shipping-api", "orders-web"])
        cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shipping-api"],
        ["add", "orders-web"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);
      routerPort(work, routerAt);
      const file = join(work, "platform.json");
      const platform = JSON.parse(readFileSync(file, "utf8"));
      expect(platform.bricks["orders-web"].webPort, "add gives the first free port from 8080").toBe(8080);
      platform.bricks["orders-web"].webPort = pageAt;
      writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      await routerReady(routerAt);
      console.log(`docker ps (project ${name}):\n${containersOf(name, "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}")}`);

      // Two things are published, both on the loopback address only: the router and the page.
      const ports = containersOf(name, "--format", "{{.Ports}}");
      expect(ports).not.toMatch(/0\.0\.0\.0:|\[::\]:/);
      expect((ports.match(/127\.0\.0\.1:\d+->/g) ?? []).sort()).toEqual([`127.0.0.1:${pageAt}->`, `127.0.0.1:${routerAt}->`].sort());

      // An order created and shipped through the router shows on the page, rendered by its server through GRAPHQL_URL.
      const created = await through(routerAt, "createOrder", "mutation { createOrder(total: 42.5) { id } }");
      const id = created.body.data.createOrder.id as string;
      // Checked here, so that a failed mutation is reported as such and not, later, as a page without the shipment.
      const shipped = await through(routerAt, "shipOrder", `mutation { shipOrder(orderId: "${id}", carrier: "dhl") { status } }`);
      expect(shipped.body, "shipOrder through the router").toEqual({ data: { shipOrder: { status: "SHIPPED" } } });
      await until("the page", async () => (await page("/health")).status === 200);
      // The page's server calls the router, which calls shipping, at every request: one failed call right after `up`
      // shows that one page with the shipment "Unavailable" (the k3d test met it, run #86). Read it until it shows the
      // shipped order, and print the order's last row if it never does.
      const rowOf = (text: string) => text.match(new RegExp(`<tr><td>#${id}</td>.*?</tr>`))?.[0] ?? "(order not listed)";
      let html = "";
      try {
        await until("the page to show the shipped order", async () => {
          html = await (await page()).text();
          return html.includes(`#${id}`) && html.includes("dhl · SHIPPED");
        });
      } catch (e) {
        console.log(`last row of order #${id} on the page: ${rowOf(html)}`);
        throw e;
      }
      // The browser is told where the router is (PUBLIC_GRAPHQL_URL).
      expect(html).toContain(`data-graphql="http://127.0.0.1:${routerAt}/graphql"`);

      // What the browser does from the page: the router accepts the page's origins, and only them.
      const pageOrigins = [`http://127.0.0.1:${pageAt}`, `http://localhost:${pageAt}`];
      for (const origin of pageOrigins) {
        const pre = await fetch(`http://127.0.0.1:${routerAt}/graphql`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        expect([pre.status, pre.headers.get("access-control-allow-origin")], origin).toEqual([204, origin]);
      }
      const fromPage = await fetch(`http://127.0.0.1:${routerAt}/graphql`, {
        method: "POST",
        headers: { origin: pageOrigins[0], "content-type": "application/json" },
        body: JSON.stringify({ query: "{ orders(limit: 5) { id } }" }),
      });
      expect(fromPage.status).toBe(200);
      const elsewhere = await fetch(`http://127.0.0.1:${routerAt}/graphql`, {
        method: "POST",
        headers: { origin: "http://evil.example", "content-type": "text/plain" },
        body: JSON.stringify({ query: "mutation { createOrder(total: 1) { id } }" }),
      });
      expect(elsewhere.status).toBe(403);

      // Shipping stops: the page still lists the orders and says the shipment is unavailable, as in the mockup.
      const shipping = containersOf(name, "--filter", "name=shipping-api-app", "--format", "{{.Names}}").trim();
      expect(spawnSync("docker", ["stop", shipping], { encoding: "utf8" }).status).toBe(0);
      let degraded = "";
      await until("the degraded page", async () => {
        degraded = await (await page()).text();
        return degraded.includes("Unavailable");
      });
      expect(degraded).toContain(`#${id}`);
      expect(degraded).toContain("Shipping information is temporarily unavailable");
      console.log(`page with shipping stopped: order #${id} listed, shipment "Unavailable"`);

      const down = cli(work, ["down"]);
      expect(down.code, `${down.out}\n${down.err}`).toBe(0);
      expect(containersOf(name, "--format", "{{.Ports}}")).not.toContain("127.0.0.1");
    },
    900_000,
  );
});

describe("a platform with no subgraph", () => {
  it.skipIf(!ready)(
    `gets no router container and publishes nothing${why}`,
    () => {
      const name = "pbtest-nosubgraph";
      const work = project(name, []);
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
      ])
        expect(cli(work, args).code).toBe(0);
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const table = containersOf(name, "--format", "table {{.Names}}\t{{.Image}}\t{{.Ports}}");
      console.log(`docker ps (project ${name}):\n${table}`);
      expect(containersOf(name, "--format", "{{.Names}}")).not.toContain("router");
      expect(routerContainer(name)).toBeUndefined();
      // The database port exists inside the container only: no host mapping at all.
      expect(table).not.toContain("->");
      expect(existsSync(join(work, ".generated/compose/router-config.json"))).toBe(false);
    },
    300_000,
  );
});

// ---------- status --runtime against the running stack ----------
// What `status --runtime` reports is the runtime's own health state (D10): this checks it against a real
// stack, then stops one service and starts it again. Its own project and port (14104).

describe("status --runtime against a running platform", () => {
  const name = "pbtest-status";
  const port = 14104;

  /** status --runtime compose --json: the exit code and the parsed report (printed for the record). */
  function liveStatus(work: string, label: string): { code: number; report: LiveStatus; text: string } {
    const json = cli(work, ["status", "--runtime", "compose", "--json"]);
    const text = cli(work, ["status", "--runtime", "compose"]);
    console.log(`${label}: exit ${json.code}\n${text.out}${text.err ? `\n${text.err}` : ""}`);
    expect(json.err, label).not.toMatch(/RUNTIME_UNAVAILABLE/);
    const report = JSON.parse(json.out) as LiveStatus;
    expect(schemaIssues(statusRuntimeSchema.validate, report), label).toEqual([]);
    expect(text.code, label).toBe(json.code);
    return { code: json.code, report, text: `${json.out}\n${text.out}` };
  }
  const service = (r: LiveStatus, n: string) => r.bricks.flatMap((b) => b.services).find((s) => s.name === n)!;

  it.skipIf(!ready)(
    `reports every enabled service healthy, then a stopped service with exit code 3, then healthy again${why}`,
    async () => {
      buildExampleApis();
      const work = project(name, []);
      for (const brick of ["orders-api", "shipping-api"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shipping-api"],
      ])
        expect(cli(work, args).code).toBe(0);
      routerPort(work, port);
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      // 1. Healthy: every service healthy; the router runs (it has no health check in Compose), on 127.0.0.1.
      const healthy = liveStatus(work, "status --runtime, all up");
      expect(healthy.code).toBe(0);
      expect(healthy.report.state).toBe("healthy");
      for (const n of ["orders-api-app", "postgres-db", "shipping-api-app"]) expect(service(healthy.report, n).state, n).toBe("healthy");
      expect(healthy.report.router).toMatchObject({ state: "unknown", address: `127.0.0.1:${port}`, deployed: true });
      expect(healthy.report.router!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Nothing of the secrets file, and no environment variable, ever reaches the output.
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8")
        .split("\n")
        .filter((l) => /^PB_\w+=/.test(l))
        .map((l) => l.split("=")[1]);
      expect(secrets.length).toBeGreaterThan(0);
      for (const value of secrets) expect(healthy.text).not.toContain(value);
      for (const forbidden of ["DATABASE_URL", "PB_", "postgres://"]) expect(healthy.text).not.toContain(forbidden);

      // 2. Stop one subgraph: exit 3, stopped with its exit code, and visible under the router too.
      const stop = spawnSync("docker", ["compose", "--project-name", name, "stop", "shipping-api-app"], { encoding: "utf8" });
      expect(stop.status, stop.stderr).toBe(0);
      const stopped = liveStatus(work, "status --runtime, shipping-api-app stopped");
      expect(stopped.code).toBe(3);
      expect(stopped.report.state).toBe("degraded");
      expect(service(stopped.report, "shipping-api-app")).toMatchObject({ state: "stopped", deployed: true, enabled: true });
      expect(service(stopped.report, "shipping-api-app").reason).toMatch(/^exited with code \d+$/);
      expect(stopped.report.router!.subgraphs.find((g) => g.name === "shipping-api-app")!.state).toBe("stopped");
      expect(service(stopped.report, "orders-api-app").state).toBe("healthy");

      // 3. Start it again: healthy once its own health check passes.
      const start = spawnSync("docker", ["compose", "--project-name", name, "start", "shipping-api-app"], { encoding: "utf8" });
      expect(start.status, start.stderr).toBe(0);
      await until(
        "shipping-api-app healthy again",
        async () =>
          service(JSON.parse(cli(work, ["status", "--runtime", "compose", "--json"]).out), "shipping-api-app").state === "healthy",
        120_000,
      );
      const back = liveStatus(work, "status --runtime, shipping-api-app started again");
      expect(back.code).toBe(0);
      expect(service(back.report, "shipping-api-app").state).toBe("healthy");
    },
    900_000,
  );
});

// ---------- the queue capability, on a real Docker engine ----------
// One RabbitMQ brick provides `queue`; two consumer bricks share the same broker, each with its own
// AMQP_URL and QUEUE_NAME. The broker is never published, and the password is never printed.

describe("the queue capability with RabbitMQ", () => {
  const name = "pbtest-queue";

  it.skipIf(!ready)(
    `one broker serves two consumers, each with its own AMQP_URL and QUEUE_NAME${why}`,
    () => {
      const work = project(name, ["queue-a", "queue-b"]);
      cpSync(join(pkg, "examples/rabbitmq"), join(work, "rabbitmq"), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "rabbitmq"],
        ["add", "queue-a"],
        ["add", "queue-b"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const running = containersOf(name, "--filter", "status=running", "--format", "{{.Names}}").trim().split("\n").sort();
      expect(running).toEqual([`${name}-queue-a-app-1`, `${name}-queue-b-app-1`, `${name}-rabbitmq-broker-1`]);

      // Each consumer got its own vhost and user in AMQP_URL, and its own queue name. The shell prints
      // only "ok": AMQP_URL holds the generated password, so it is never printed (D6, D11, D12).
      const env = (service: string, queue: string) =>
        spawnSync(
          "docker",
          [
            "compose",
            "--project-name",
            name,
            "exec",
            "-T",
            service,
            "sh",
            "-c",
            `case "$AMQP_URL" in amqp://${queue}:*) ;; *) echo "AMQP_URL does not use the ${queue} user"; exit 1;; esac;` +
              `case "$AMQP_URL" in */${queue}) ;; *) echo "AMQP_URL does not use the ${queue} vhost"; exit 1;; esac;` +
              `[ "$QUEUE_NAME" = "${queue}" ] && echo ok`,
          ],
          { encoding: "utf8" },
        );
      for (const [service, queue] of [
        ["queue-a-app", "queue-a"],
        ["queue-b-app", "queue-b"],
      ] as const) {
        const r = env(service, queue);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.trim()).toBe("ok");
      }

      // The provision task created one vhost, one user and its permissions per consumer.
      const rabbit = (...args: string[]) =>
        spawnSync("docker", ["compose", "--project-name", name, "exec", "-T", "rabbitmq-broker", ...args], { encoding: "utf8" });
      const vhosts = rabbit("rabbitmqctl", "list_vhosts", "name");
      expect(vhosts.status, vhosts.stderr).toBe(0);
      expect(vhosts.stdout).toContain("queue-a");
      expect(vhosts.stdout).toContain("queue-b");
      const users = rabbit("rabbitmqctl", "list_users");
      expect(users.status, users.stderr).toBe(0);
      expect(users.stdout).toContain("queue-a");
      expect(users.stdout).toContain("queue-b");
      const permissions = rabbit("rabbitmqctl", "list_permissions", "-p", "queue-a");
      expect(permissions.status, permissions.stderr).toBe(0);
      expect(permissions.stdout).toContain("queue-a");

      // The broker answers and listens on AMQP; the management port is inside the platform network only.
      const ping = rabbit("rabbitmq-diagnostics", "-q", "ping");
      expect(ping.status, ping.stderr).toBe(0);
      const listeners = rabbit("rabbitmq-diagnostics", "-q", "listeners");
      expect(listeners.status, listeners.stderr).toBe(0);
      expect(listeners.stdout).toContain("5672");
      expect(containersOf(name, "--format", "{{.Ports}}")).not.toContain("->");

      // The generated file references the secret variables, never their values (the admin's and each consumer's).
      const compose = readFileSync(join(work, ".generated/compose/compose.yaml"), "utf8");
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8")
        .split("\n")
        .filter((l) => /^PB_\w+=/.test(l))
        .map((l) => l.split("=")[1]);
      expect(secrets).toHaveLength(3);
      for (const secret of secrets) expect(compose).not.toContain(secret);

      // down keeps the broker's data volume (retention: retain).
      expect(cli(work, ["down"]).code).toBe(0);
      const vols = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", `name=${name}_`], { encoding: "utf8" });
      expect(vols.stdout.trim().split("\n")).toEqual([`${name}_rabbitmq-broker-data`]);
    },
    300_000,
  );
});

// ---------- the queue capability, with a real consumer ----------
// `examples/queue-consumer` declares its queue, publishes one message and consumes it; its /health is
// 200 only after that round-trip, with the consumer's own vhost and user.

describe("the queue capability with a real consumer", () => {
  const name = "pbtest-queue-flow";

  it.skipIf(!ready)(
    `publishes and consumes a message through the broker${why}`,
    () => {
      buildQueueConsumer();
      const work = project(name, []);
      for (const brick of ["rabbitmq", "queue-consumer"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "rabbitmq"],
        ["add", "queue-consumer"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      // The healthcheck of the brick is this endpoint: `up` only returns once it answers 200, i.e. once a
      // message went through the broker and came back.
      const health = spawnSync(
        "docker",
        ["compose", "--project-name", name, "exec", "-T", "queue-consumer-app", "wget", "-qO-", "http://localhost:4000/health"],
        { encoding: "utf8" },
      );
      expect(health.status, health.stderr).toBe(0);
      expect(JSON.parse(health.stdout)).toMatchObject({ ok: true, connected: true, delivered: true, queue: "queue-consumer" });

      // Its own user and vhost (the shell prints only "ok": the URL holds the generated password).
      const env = spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "exec",
          "-T",
          "queue-consumer-app",
          "sh",
          "-c",
          'case "$AMQP_URL" in amqp://queue-consumer:*) ;; *) echo "wrong user"; exit 1;; esac;' +
            'case "$AMQP_URL" in */queue-consumer) ;; *) echo "wrong vhost"; exit 1;; esac; echo ok',
        ],
        { encoding: "utf8" },
      );
      expect(env.status, env.stderr).toBe(0);
      expect(env.stdout.trim()).toBe("ok");

      // The queue exists on the broker, in the consumer's vhost.
      const queues = spawnSync(
        "docker",
        ["compose", "--project-name", name, "exec", "-T", "rabbitmq-broker", "rabbitmqctl", "list_queues", "-p", "queue-consumer", "name"],
        { encoding: "utf8" },
      );
      expect(queues.status, queues.stderr).toBe(0);
      expect(queues.stdout).toContain("queue-consumer");

      expect(cli(work, ["down"]).code).toBe(0);
    },
    300_000,
  );
});

// ---------- the queue capability with NATS ----------
// Core NATS: a NATS_URL and a SUBJECT for the consumer, and a real publish/subscribe through a pinned
// nats-box client (no application to maintain for the test).

describe("the queue capability with NATS", () => {
  const name = "pbtest-nats";

  it.skipIf(!ready)(
    `publishes and receives a message through the broker${why}`,
    () => {
      const work = project(name, ["queue-a"]);
      cpSync(join(pkg, "examples/nats"), join(work, "nats"), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "nats"],
        ["add", "queue-a"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      // The consumer got the broker URL and its subject (no secret is involved in NATS core).
      const env = spawnSync(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "exec",
          "-T",
          "queue-a-app",
          "sh",
          "-c",
          '[ "$NATS_URL" = "nats://nats-broker:4222" ] && [ "$SUBJECT" = "queue-a" ] && echo ok',
        ],
        { encoding: "utf8" },
      );
      expect(env.status, env.stderr).toBe(0);
      expect(env.stdout.trim()).toBe("ok");

      // A pinned nats-box subscribes, another publishes; the subscriber's log shows the message.
      const network = `${name}_default`;
      const subscriber = `${name}-sub`;
      spawnSync("docker", ["rm", "-f", subscriber], { encoding: "utf8" });
      const sub = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          subscriber,
          "--network",
          network,
          "natsio/nats-box:0.19.2",
          "nats",
          "--server",
          "nats://nats-broker:4222",
          "sub",
          "hello",
          "--count",
          "1",
        ],
        { encoding: "utf8" },
      );
      expect(sub.status, sub.stderr).toBe(0);
      try {
        spawnSync("sleep", ["2"]);
        const pub = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            network,
            "natsio/nats-box:0.19.2",
            "nats",
            "--server",
            "nats://nats-broker:4222",
            "pub",
            "hello",
            "world",
          ],
          { encoding: "utf8" },
        );
        expect(pub.status, pub.stderr).toBe(0);
        const waited = spawnSync("docker", ["wait", subscriber], { encoding: "utf8" });
        expect(waited.status, waited.stderr).toBe(0);
        expect(waited.stdout.trim()).toBe("0");
        const logs = spawnSync("docker", ["logs", subscriber], { encoding: "utf8" });
        expect(logs.status, logs.stderr).toBe(0);
        expect(`${logs.stdout}${logs.stderr}`).toContain("Received on");
        expect(`${logs.stdout}${logs.stderr}`).toContain("world");
      } finally {
        spawnSync("docker", ["rm", "-f", subscriber], { encoding: "utf8" });
      }

      // Nothing is published on the host.
      expect(containersOf(name, "--format", "{{.Ports}}")).not.toContain("->");

      expect(cli(work, ["down"]).code).toBe(0);
    },
    300_000,
  );
});

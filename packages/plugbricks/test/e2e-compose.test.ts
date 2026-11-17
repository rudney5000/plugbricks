import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
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
      const build = spawnSync("docker", ["build", "--quiet", "--tag", "plugbricks-example/orders:0.1.0", join(repo, "apis/orders")], {
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);

      const name = "pbtest-orders";
      const work = project(name, ["shop"]);
      cpSync(join(pkg, "examples/orders"), join(work, "orders"), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders"],
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
            "http://orders-app:4000/graphql",
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

      // orders' role cannot even connect to shop's database (the provision task revokes PUBLIC).
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8");
      const pw = /^PB_POSTGRES__ORDERS__CONSUMER_PASSWORD=(\w+)$/m.exec(secrets)![1];
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
          `postgres://orders:${pw}@postgres-db:5432/shop`,
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
  for (const api of ["orders", "shipping"]) {
    const build = spawnSync("docker", ["build", "--quiet", "--tag", `plugbricks-example/${api}:0.1.0`, join(repo, "apis", api)], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
  }
  apisBuilt = true;
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
      for (const brick of ["orders", "shipping"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders"],
        ["add", "shipping"],
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
      expect(databases.stdout.trim().split("\n"), databases.stderr).toEqual(["orders", "postgres", "shipping"]);
      const roles = psql("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1");
      expect(roles.stdout.trim().split("\n"), roles.stderr).toEqual(["orders", "postgres", "shipping"]);
      const secrets = readFileSync(join(work, ".secrets/secrets.env"), "utf8");
      const password = (consumer: string) =>
        new RegExp(`^PB_POSTGRES__${consumer.toUpperCase()}__CONSUMER_PASSWORD=(\\w+)$`, "m").exec(secrets)![1];
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
      expect(connect("shipping", "shipping").stdout.trim()).toBe("shipping|shipping");
      const denied = connect("shipping", "orders");
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toMatch(/permission denied for database "orders"/);
      console.log(`shipping role on the orders database: ${denied.stderr.trim().split("\n")[0]}`);
      expect(connect("orders", "shipping").stderr).toMatch(/permission denied for database "shipping"/);

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
    `follows the composition: remove shipping drops the field and recreates the router, add brings it back, remove orders is refused${why}`,
    async () => {
      // remove shipping, then up: the router is recreated with a configuration that has no shipment.
      expect(cli(work, ["remove", "shipping"]).code).toBe(0);
      const removed = cli(work, ["up"]);
      expect(removed.code, `${removed.out}\n${removed.err}`).toBe(0);
      const withoutShipping = routerContainer(name)!;
      expect(withoutShipping.id).not.toBe(firstRouter.id);
      expect(withoutShipping.hash).not.toBe(firstRouter.hash);
      expect(containersOf(name, "--format", "{{.Names}}")).not.toContain("shipping-app");
      await routerReady(port);
      const gone = await ask("shipment after remove shipping", ORDER, { id: orderId });
      expect(gone.body.data).toBeUndefined();
      expect(gone.body.errors[0].message).toContain('Cannot query field "shipment" on type "Order"');
      // orders alone still works, with the order it kept.
      const alone = await ask("orders alone", "query($id: ID!) { order(id: $id) { id total status } }", { id: orderId });
      expect(alone.body).toEqual({ data: { order: { id: orderId, total: 42.5, status: "pending" } } });

      // add shipping again, then up: recreated again, not left stale; the same bricks give the same hash as at the start.
      expect(cli(work, ["add", "shipping"]).code).toBe(0);
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
      const refused = cli(work, ["remove", "orders"]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/^error EXTENDS_IN_USE: cannot remove "orders": its entities are still extended by "shipping"/m);
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

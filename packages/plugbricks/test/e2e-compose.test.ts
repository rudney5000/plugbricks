import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

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
    `runs orders and shipping on their own databases: shipping extends Order, cannot reach the orders database, data kept across down/up${why}`,
    () => {
      const repo = fileURLToPath(new URL("../../../", import.meta.url));
      for (const api of ["orders", "shipping"]) {
        const build = spawnSync("docker", ["build", "--quiet", "--tag", `plugbricks-example/${api}:0.1.0`, join(repo, "apis", api)], {
          encoding: "utf8",
        });
        expect(build.status, build.stderr).toBe(0);
      }

      const name = "pbtest-shipping";
      const work = project(name, []);
      for (const brick of ["orders", "shipping"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", name],
        ["add", "postgres"],
        ["add", "orders"],
        ["add", "shipping"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);
      routerPort(work, 14102);
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      const ps = spawnSync(
        "docker",
        ["ps", "--filter", `label=com.docker.compose.project=${name}`, "--format", "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"],
        { encoding: "utf8" },
      );
      console.log(`docker ps (project ${name}):\n${ps.stdout}`);
      // The router is the only thing published on the host, on the loopback address; the APIs are reached by their network names.
      expect(ps.stdout).not.toMatch(/0\.0\.0\.0:|\[::\]:/);
      expect(ps.stdout.match(/127\.0\.0\.1:\d+->/g)).toEqual(["127.0.0.1:14102->"]);

      const psql = (sql: string) =>
        spawnSync("docker", ["compose", "--project-name", name, "exec", "-T", "postgres-db", "psql", "-U", "postgres", "-Atc", sql], {
          encoding: "utf8",
        });
      const databases = psql("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1");
      expect(databases.stdout.trim().split("\n"), databases.stderr).toEqual(["orders", "postgres", "shipping"]);
      const roles = psql("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1");
      expect(roles.stdout.trim().split("\n"), roles.stderr).toEqual(["orders", "postgres", "shipping"]);
      console.log(`databases: ${databases.stdout.trim().split("\n").join(", ")}; roles: ${roles.stdout.trim().split("\n").join(", ")}`);

      // Throwaway containers on the Compose network: one for psql, one for the GraphQL calls.
      const network = `${name}_default`;
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
            network,
            "postgres:16.4-alpine",
            "psql",
            `postgres://${role}:${password(role)}@postgres-db:5432/${database}`,
            "-Atc",
            "select current_user, current_database()",
          ],
          {
            encoding: "utf8",
          },
        );
      expect(connect("shipping", "shipping").stdout.trim()).toBe("shipping|shipping");
      const denied = connect("shipping", "orders");
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toMatch(/permission denied for database "orders"/);
      console.log(`shipping role on the orders database: ${denied.stderr.trim().split("\n")[0]}`);
      expect(connect("orders", "shipping").stderr).toMatch(/permission denied for database "shipping"/);

      const gql = (host: string, query: string, variables?: Record<string, unknown>) => {
        const r = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            network,
            "node:22.23.5-alpine",
            "wget",
            "-qO-",
            "--header",
            "content-type: application/json",
            "--post-data",
            JSON.stringify({ query, variables }),
            `http://${host}:4000/graphql`,
          ],
          { encoding: "utf8" },
        );
        expect(r.status, r.stderr).toBe(0);
        return JSON.parse(r.stdout);
      };
      const id = gql("orders-app", "mutation { createOrder(total: 99.9) { id } }").data.createOrder.id;
      const shipped = gql(
        "shipping-app",
        'mutation($id: ID!) { shipOrder(orderId: $id, carrier: "ups") { carrier trackingNumber status } }',
        { id },
      );
      expect(shipped.errors).toBeUndefined();
      expect(shipped.data.shipOrder).toMatchObject({ carrier: "ups", status: "SHIPPED" });
      const tracking = shipped.data.shipOrder.trackingNumber;

      const readBack = () => ({
        order: gql("orders-app", "query($id: ID!) { order(id: $id) { id total status } }", { id }),
        shipment: gql("shipping-app", "query($id: ID!) { shipment(orderId: $id) { carrier trackingNumber status } }", { id }),
        // What the router will send to shipping to complete an Order it got from orders.
        entities: gql(
          "shipping-app",
          "query($r: [_Any!]!) { _entities(representations: $r) { ... on Order { id shipment { carrier trackingNumber status } } } }",
          {
            r: [{ __typename: "Order", id }],
          },
        ),
      });
      const expectState = (state: ReturnType<typeof readBack>) => {
        expect(state.order).toEqual({ data: { order: { id, total: 99.9, status: "pending" } } });
        expect(state.shipment).toEqual({ data: { shipment: { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" } } });
        expect(state.entities).toEqual({
          data: { _entities: [{ id, shipment: { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" } }] },
        });
      };
      const before = readBack();
      console.log(`_entities answer from shipping:\n${JSON.stringify(before.entities)}`);
      expectState(before);

      expect(cli(work, ["down"]).code).toBe(0);
      const again = cli(work, ["up"]);
      expect(again.code, `${again.out}\n${again.err}`).toBe(0);
      expectState(readBack());
    },
    900_000,
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

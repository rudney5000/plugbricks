import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, typeDefs } from "../src/app.js";
import { MIGRATIONS, migrate } from "../src/db.js";

// The API alone, against a throwaway PostgreSQL in Docker (port published on 127.0.0.1 only).
// Skipped, with the reason in the title, where no Linux Docker engine answers.

const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
const ready = docker.status === 0 && docker.stdout.trim() === "linux";
const why = ready ? "" : " (skipped: needs a Linux Docker engine)";
const IMAGE = "postgres:16.4-alpine";

let container = "";
let pool: pg.Pool;
let server: Server;
let base = "";

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  // The shape of "data" depends on the query sent, so it is not typed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
}

beforeAll(async () => {
  if (!ready) return;
  const run = spawnSync("docker", ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", IMAGE], {
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(run.stderr);
  container = run.stdout.trim();
  const port = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop();
  pool = new pg.Pool({ connectionString: `postgres://postgres:test@127.0.0.1:${port}/postgres`, max: 4 });
  for (let i = 0; ; i++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (i > 60) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await migrate(pool);
  server = createApp(pool);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (container) spawnSync("docker", ["rm", "-f", container]);
});

describe("orders API", () => {
  it("ships the same SDL as the brick", () => {
    const brick = readFileSync(new URL("../../../packages/plugbricks/examples/orders/schema.graphql", import.meta.url), "utf8");
    expect(brick).toBe(typeDefs);
  });

  it.skipIf(!ready)(`answers /health while the database answers${why}`, async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it.skipIf(!ready)(`creates an order, then reads it back alone and in the list${why}`, async () => {
    const created = await gql("mutation($t: Float!) { createOrder(total: $t) { id total status } }", { t: 12.345 });
    expect(created.errors).toBeUndefined();
    const order = created.data.createOrder;
    expect(order).toMatchObject({ total: 12.35, status: "pending" });
    expect((await gql("query($id: ID!) { order(id: $id) { id total } }", { id: order.id })).data.order).toEqual({
      id: order.id,
      total: 12.35,
    });
    expect((await gql("{ orders { id } }")).data.orders).toContainEqual({ id: order.id });
  });

  it.skipIf(!ready)(`rounds totals half away from zero, as the numeric column does${why}`, async () => {
    for (const [t, stored] of [
      [1.005, 1.01],
      [2.675, 2.68],
      [0.004, 0],
    ]) {
      const r = await gql("mutation($t: Float!) { createOrder(total: $t) { total } }", { t });
      expect(r.data.createOrder.total, String(t)).toBe(stored);
    }
  });

  it.skipIf(!ready)(`bounds the list: newest first, limit between 1 and 500${why}`, async () => {
    await gql("mutation { a: createOrder(total: 1) { id } b: createOrder(total: 2) { id } }");
    const two = (await gql("{ orders(limit: 2) { id } }")).data.orders.map((o: { id: string }) => BigInt(o.id));
    expect(two).toHaveLength(2);
    expect(two[0] > two[1]).toBe(true);
    for (const limit of [0, 501])
      expect((await gql(`{ orders(limit: ${limit}) { id } }`)).errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
  });

  it.skipIf(!ready)(`serves /health with a query string, and nothing but /health and /graphql${why}`, async () => {
    expect((await fetch(`${base}/health?probe=1`)).status).toBe(200);
    expect((await fetch(`${base}/graphqlx`)).status).toBe(404);
  });

  it.skipIf(!ready)(`finds an order by a 19-digit id${why}`, async () => {
    await pool.query("INSERT INTO orders (id, total) VALUES (9223372036854775807, 3)");
    expect((await gql('{ order(id: "9223372036854775807") { id total } }')).data.order).toEqual({ id: "9223372036854775807", total: 3 });
    await pool.query("DELETE FROM orders WHERE id = 9223372036854775807");
  });

  it.skipIf(!ready)(`returns null for an unknown or malformed id, without a database error${why}`, async () => {
    for (const id of ["999999", "abc", "-1", "007", "9223372036854775808", "1; drop table orders"]) {
      const r = await gql("query($id: ID!) { order(id: $id) { id } }", { id });
      expect(r, id).toEqual({ data: { order: null } });
    }
  });

  it.skipIf(!ready)(`refuses a negative or huge total with BAD_USER_INPUT${why}`, async () => {
    for (const t of [-1, 1e12]) {
      const r = await gql("mutation($t: Float!) { createOrder(total: $t) { id } }", { t });
      expect(r.errors?.[0].extensions?.code, String(t)).toBe("BAD_USER_INPUT");
    }
  });

  it.skipIf(!ready)(`exposes its SDL to the router (_service) with the @key of Order${why}`, async () => {
    const sdl: string = (await gql("{ _service { sdl } }")).data._service.sdl;
    expect(sdl).toContain('type Order @key(fields: "id")');
  });

  it.skipIf(!ready)(`resolves Order references for other subgraphs (_entities)${why}`, async () => {
    const id = (await gql("mutation { createOrder(total: 5) { id } }")).data.createOrder.id;
    const r = await gql("query($r: [_Any!]!) { _entities(representations: $r) { ... on Order { id total status } } }", {
      r: [
        { __typename: "Order", id },
        { __typename: "Order", id: "999999" },
      ],
    });
    expect(r).toEqual({ data: { _entities: [{ id, total: 5, status: "pending" }, null] } });
  });

  it.skipIf(!ready)(`applies migrations once, even when run again${why}`, async () => {
    expect(await migrate(pool)).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(MIGRATIONS.length);
  });

  it.skipIf(!ready)(`upgrades a database created before createdBy, keeping its orders (createdBy null)${why}`, async () => {
    // The state of an existing platform: only the first migration applied, with an order in it.
    await pool.query("DROP DATABASE IF EXISTS upgrade_from_v1");
    await pool.query("CREATE DATABASE upgrade_from_v1");
    const url = new URL(pool.options.connectionString!);
    url.pathname = "/upgrade_from_v1";
    const old = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
      await old.query("CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      await old.query(MIGRATIONS[0]);
      await old.query("INSERT INTO schema_migrations (version) VALUES (1)");
      await old.query("INSERT INTO orders (total) VALUES (5)");
      expect(await migrate(old)).toEqual([2]);
      expect((await old.query('SELECT total::float8 AS total, created_by AS "createdBy" FROM orders')).rows).toEqual([
        { total: 5, createdBy: null },
      ]);
    } finally {
      await old.end();
      await pool.query("DROP DATABASE IF EXISTS upgrade_from_v1");
    }
  });

  it.skipIf(!ready)(`records who created an order: null without a token check (D20 point 4)${why}`, async () => {
    const created = await gql("mutation { createOrder(total: 1) { id createdBy } }");
    expect(created.errors).toBeUndefined();
    expect(created.data.createOrder.createdBy).toBeNull();
  });

  it.skipIf(!ready)(`records the verified caller, never an identity header, and serves it on every read (D20 point 4)${why}`, async () => {
    // A check that knows one token: the caller's name is what the resolver must record.
    const app = createApp(pool, async (h) =>
      h === "Bearer good.to.ken" ? { subject: "sub-1", name: "service-account-orders-web" } : null,
    );
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/graphql`;
    const ask = async (query: string, variables?: Record<string, unknown>) =>
      (await (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer good.to.ken", "x-user-sub": "admin-forged" },
          body: JSON.stringify({ query, variables }),
        })
      ).json()) as { data?: any; errors?: unknown[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const created = await ask("mutation { createOrder(total: 2) { id createdBy } }");
      expect(created.errors).toBeUndefined();
      expect(created.data.createOrder.createdBy).toBe("service-account-orders-web");
      const id = created.data.createOrder.id;
      expect((await ask("query($id: ID!) { order(id: $id) { createdBy } }", { id })).data.order.createdBy).toBe(
        "service-account-orders-web",
      );
      expect((await ask("{ orders(limit: 5) { id createdBy } }")).data.orders).toContainEqual({
        id,
        createdBy: "service-account-orders-web",
      });
      // Through _entities too, as the router asks when another subgraph refers to the order.
      const entities = await ask("query($r: [_Any!]!) { _entities(representations: $r) { ... on Order { createdBy } } }", {
        r: [{ __typename: "Order", id }],
      });
      expect(entities.data._entities).toEqual([{ createdBy: "service-account-orders-web" }]);
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it.skipIf(!ready)(`answers /health with 503 when the database is gone${why}`, async () => {
    const dead = new pg.Pool({ connectionString: "postgres://postgres:test@127.0.0.1:1/postgres", connectionTimeoutMillis: 500 });
    const app = createApp(dead);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/health`);
      expect(res.status).toBe(503);
    } finally {
      await new Promise((r) => app.close(r));
      await dead.end();
    }
  });
});

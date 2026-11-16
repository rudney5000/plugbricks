import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, typeDefs } from "../src/app.js";
import { migrate } from "../src/db.js";

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
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
}

beforeAll(async () => {
  if (!ready) return;
  const run = spawnSync("docker", ["run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", IMAGE], { encoding: "utf8" });
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
  it("ships the same SDL as the brick and the project template", () => {
    for (const copy of ["packages/plugbricks/examples/orders/schema.graphql", "packages/create-plugbricks/template/services/orders/schema.graphql"]) {
      expect(readFileSync(new URL(`../../../${copy}`, import.meta.url), "utf8"), copy).toBe(typeDefs);
    }
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
    expect((await gql("query($id: ID!) { order(id: $id) { id total } }", { id: order.id })).data.order).toEqual({ id: order.id, total: 12.35 });
    expect((await gql("{ orders { id } }")).data.orders).toContainEqual({ id: order.id });
  });

  it.skipIf(!ready)(`returns null for an unknown or malformed id, without a database error${why}`, async () => {
    for (const id of ["999999", "abc", "-1", "1; drop table orders"]) {
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
    const r = await gql(
      'query($r: [_Any!]!) { _entities(representations: $r) { ... on Order { id total status } } }',
      { r: [{ __typename: "Order", id }, { __typename: "Order", id: "999999" }] },
    );
    expect(r).toEqual({ data: { _entities: [{ id, total: 5, status: "pending" }, null] } });
  });

  it.skipIf(!ready)(`applies migrations once, even when run again${why}`, async () => {
    expect(await migrate(pool)).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(1);
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

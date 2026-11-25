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

const SHIP = "mutation($id: ID!, $c: String!) { shipOrder(orderId: $id, carrier: $c) { carrier trackingNumber status } }";

describe("shipping API", () => {
  it("ships the same SDL as the brick", () => {
    const brick = readFileSync(new URL("../../../packages/plugbricks/examples/shipping-api/schema.graphql", import.meta.url), "utf8");
    expect(brick).toBe(typeDefs);
  });

  it.skipIf(!ready)(`answers /health while the database answers${why}`, async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it.skipIf(!ready)(`ships an order, then finds the shipment by order id${why}`, async () => {
    const shipped = await gql(SHIP, { id: "1001", c: "  ups " });
    expect(shipped.errors).toBeUndefined();
    expect(shipped.data.shipOrder).toEqual({
      carrier: "ups",
      trackingNumber: expect.stringMatching(/^TRK-[0-9A-F]{10}$/),
      status: "SHIPPED",
    });
    const found = await gql("query($id: ID!) { shipment(orderId: $id) { carrier trackingNumber status } }", { id: "1001" });
    expect(found).toEqual({ data: { shipment: shipped.data.shipOrder } });
  });

  it.skipIf(!ready)(`returns null for an order that was not shipped, or an id that cannot be an order id${why}`, async () => {
    for (const id of ["999999", "abc", "-1", "007", "9223372036854775808", "1; drop table shipments"]) {
      const r = await gql("query($id: ID!) { shipment(orderId: $id) { carrier } }", { id });
      expect(r, id).toEqual({ data: { shipment: null } });
    }
  });

  it.skipIf(!ready)(`ships an order once: a second shipment is refused with BAD_USER_INPUT${why}`, async () => {
    expect((await gql(SHIP, { id: "1002", c: "dhl" })).errors).toBeUndefined();
    const again = await gql(SHIP, { id: "1002", c: "ups" });
    expect(again.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
    expect(again.errors?.[0].message).toBe("order 1002 already has a shipment");
    const kept = await gql("query($id: ID!) { shipment(orderId: $id) { carrier } }", { id: "1002" });
    expect(kept.data.shipment.carrier).toBe("dhl");
  });

  it.skipIf(!ready)(`refuses a malformed order id and an empty or too long carrier with BAD_USER_INPUT${why}`, async () => {
    for (const [id, c] of [
      ["abc", "ups"],
      ["0", "ups"],
      ["1003", "   "],
      ["1003", "x".repeat(41)],
    ]) {
      const r = await gql(SHIP, { id, c });
      expect(r.errors?.[0].extensions?.code, `${id} ${c.length}`).toBe("BAD_USER_INPUT");
    }
    expect((await gql("query($id: ID!) { shipment(orderId: $id) { carrier } }", { id: "1003" })).data.shipment).toBeNull();
  });

  it.skipIf(!ready)(`exposes its SDL to the router (_service) with the @key of Order${why}`, async () => {
    const sdl: string = (await gql("{ _service { sdl } }")).data._service.sdl;
    expect(sdl).toContain('type Order @key(fields: "id")');
  });

  it.skipIf(!ready)(`resolves Order references for the router (_entities), with the shipment when there is one${why}`, async () => {
    await gql(SHIP, { id: "2001", c: "fedex" });
    const r = await gql(
      "query($r: [_Any!]!) { _entities(representations: $r) { ... on Order { id shipment { carrier trackingNumber status } } } }",
      {
        r: [
          { __typename: "Order", id: "2001" },
          // An order this subgraph never shipped, or that does not exist in orders: it only knows ids.
          { __typename: "Order", id: "999999" },
        ],
      },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data._entities).toEqual([
      { id: "2001", shipment: { carrier: "fedex", trackingNumber: expect.stringMatching(/^TRK-[0-9A-F]{10}$/), status: "SHIPPED" } },
      { id: "999999", shipment: null },
    ]);
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

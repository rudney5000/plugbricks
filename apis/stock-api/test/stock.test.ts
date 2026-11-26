import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The REST API of the example itself, so the adapter is tested against what it will meet.
import { createStockServer } from "../../stock-rest/server.js";
import { createApp } from "../src/app.js";
import { stockClient } from "../src/client.js";

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) => {
  server.closeAllConnections();
  server.close();
};

const servers: Server[] = [];
/** An adapter in front of `upstream`; what it logs is kept. */
async function adapter(upstream: string, timeoutMs?: number) {
  const logged: string[] = [];
  const server = createApp(stockClient(upstream, { timeoutMs }), (l) => logged.push(l));
  servers.push(server);
  const url = await listen(server);
  const ask = async (query: string, variables?: object) => {
    const response = await fetch(`${url}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data: Record<string, unknown>; errors?: { message: string; extensions?: { code?: string } }[] };
  };
  return { url, ask, logged };
}

const seen: string[] = [];
let rest: string;
let api: Awaited<ReturnType<typeof adapter>>;

beforeAll(async () => {
  const server = createStockServer();
  server.on("request", (req: IncomingMessage) => seen.push(`${req.method} ${req.url}`));
  servers.push(server);
  rest = await listen(server);
  api = await adapter(rest);
});
afterAll(() => servers.forEach(close));

describe("the stock adapter in front of the REST API", () => {
  it("lists the items and finds one by sku, null when there is none", async () => {
    expect((await api.ask("{ items { sku quantity } }")).data.items).toEqual([
      { sku: "BRK-1", quantity: 12 },
      { sku: "PLG-2", quantity: 0 },
    ]);
    expect((await api.ask('{ item(sku: "BRK-1") { name } }')).data.item).toEqual({ name: "Brick" });
    const none = await api.ask('{ item(sku: "NOPE") { name } }');
    expect(none).toEqual({ data: { item: null } });
  });

  it("restocks an item, and answers null for an unknown one", async () => {
    expect((await api.ask('mutation { restock(sku: "PLG-2", quantity: 4) { quantity } }')).data.restock).toEqual({ quantity: 4 });
    expect((await api.ask('mutation { restock(sku: "NOPE", quantity: 4) { quantity } }')).data.restock).toBeNull();
  });

  it("gives the caller the message of a request the REST API refuses", async () => {
    const r = await api.ask('mutation { restock(sku: "BRK-1", quantity: 5000) { quantity } }');
    expect(r.errors?.[0]).toMatchObject({
      message: "quantity must be a whole number between 1 and 1000",
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("refuses a sku off the contract without calling the REST API", async () => {
    const before = seen.length;
    for (const sku of ["../health", "BRK-1/restock", "a?b=c", "", "x".repeat(33), "%2e%2e"]) {
      const r = await api.ask("query ($sku: ID!) { item(sku: $sku) { name } }", { sku });
      expect(r.errors?.[0].extensions?.code, sku).toBe("BAD_USER_INPUT");
    }
    expect(seen.length).toBe(before);
  });

  it("resolves the references the router sends for other subgraphs", async () => {
    const r = await api.ask("query ($r: [_Any!]!) { _entities(representations: $r) { ... on Item { name } } }", {
      r: [
        { __typename: "Item", sku: "BRK-1" },
        { __typename: "Item", sku: "NOPE" },
        { __typename: "Item", sku: "../health" },
      ],
    });
    expect(r.data._entities).toEqual([{ name: "Brick" }, null, null]);
  });

  it("answers /health without asking the REST API", async () => {
    const before = seen.length;
    expect((await fetch(`${api.url}/health`)).status).toBe(200);
    expect(seen.length).toBe(before);
  });
});

describe("a REST API that cannot be used", () => {
  /** The error the caller gets, which must say nothing of the upstream, and what was logged. */
  const failure = async (upstream: string, timeoutMs?: number) => {
    const a = await adapter(upstream, timeoutMs);
    const r = await a.ask("{ items { sku } }");
    expect(r.errors?.[0]).toMatchObject({ message: "the stock service is unavailable", extensions: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
    return a.logged.join("\n");
  };
  const answering = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler!);
    servers.push(server);
    return listen(server);
  };

  it("is unreachable", async () => {
    const server = createServer();
    const gone = await listen(server);
    server.close();
    expect(await failure(gone)).toContain("GET /items");
  });

  it("fails, or answers something off the contract", async () => {
    expect(await failure(await answering((_req, res) => res.writeHead(500).end('{"message":"db password is x"}')))).toContain("HTTP 500");
    expect(await failure(await answering((_req, res) => res.writeHead(200).end('[{"sku":1}]')))).toContain("HTTP 200");
    expect(await failure(await answering((_req, res) => res.writeHead(200).end("<html>")))).toContain("GET /items");
  });

  it("redirects: the adapter does not follow", async () => {
    const before = seen.length;
    await failure(await answering((_req, res) => res.writeHead(302, { location: `${rest}/items` }).end()));
    expect(seen.length).toBe(before);
  });

  it("is too slow", async () => {
    expect(await failure(await answering(() => {}), 200)).toMatch(/timeout|aborted/i);
  });
});

describe("the contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../stock-rest/openapi.json", import.meta.url), "utf8"));

  it("lists every call the adapter makes", () => {
    const operations = Object.entries(contract.paths as Record<string, object>).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => ({ method: m.toUpperCase(), pattern: new RegExp(`^${path.replace("{sku}", "[^/]+")}$`) })),
    );
    expect(seen.length).toBeGreaterThan(5);
    for (const call of seen) {
      const [method, path] = call.split(" ");
      expect(
        operations.some((o) => o.method === method && o.pattern.test(path)),
        call,
      ).toBe(true);
    }
  });

  it("gives the sku the pattern the adapter checks", () => {
    expect(contract.components.parameters.Sku.schema.pattern).toBe("^[A-Za-z0-9-]{1,32}$");
  });
});

describe("the schema the brick ships", () => {
  it("is the one the adapter serves", () => {
    const brick = fileURLToPath(new URL("../../../packages/plugbricks/examples/stock-api/schema.graphql", import.meta.url));
    expect(readFileSync(new URL("../schema.graphql", import.meta.url), "utf8")).toBe(readFileSync(brick, "utf8"));
  });
});

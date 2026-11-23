import { createServer as createHttpServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrdersWebServer } from "../src/server.js";

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let router: Server;
let web: Server;
let webPort = 0;
let routerCalls = 0;

function ask(serverPort: number, path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port: serverPort, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  router = createHttpServer((_req, res) => {
    routerCalls++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { orders: [] } }));
  });
  await new Promise<void>((ok) => router.listen(0, "127.0.0.1", ok));
  const graphql = `http://127.0.0.1:${(router.address() as AddressInfo).port}/graphql`;
  webPort = await freePort();
  web = createOrdersWebServer({ graphql, publicGraphql: graphql, tokens: null, webOrigin: `http://127.0.0.1:${webPort}` });
  await new Promise<void>((ok) => web.listen(webPort, "127.0.0.1", ok));
});

afterAll(() => {
  web.close();
  router.close();
});

describe("the orders page server", () => {
  it("answers loopback hosts on the page and on the refresh", async () => {
    for (const host of [`127.0.0.1:${webPort}`, `localhost:${webPort}`, `[::1]:${webPort}`]) {
      const page = await ask(webPort, "/orders", { host });
      expect(page.status, host).toBe(200);
      const refresh = await ask(webPort, "/api/orders", { host });
      expect(refresh.status, host).toBe(200);
    }
  });

  it("refuses a wrong Host without calling the router", async () => {
    const before = routerCalls;
    const page = await ask(webPort, "/orders", { host: `evil.example:${webPort}` });
    expect(page.status).toBe(403);
    const refresh = await ask(webPort, "/api/orders", { host: `evil.example:${webPort}` });
    expect(refresh.status).toBe(403);
    const wrongPort = webPort === 65535 ? webPort - 1 : webPort + 1;
    expect((await ask(webPort, "/orders", { host: `127.0.0.1:${wrongPort}` })).status).toBe(403);
    expect(routerCalls).toBe(before);
  });

  it("refuses a foreign Origin", async () => {
    const before = routerCalls;
    const answer = await ask(webPort, "/orders", { host: `127.0.0.1:${webPort}`, origin: "http://evil.example" });
    expect(answer.status).toBe(403);
    expect(routerCalls).toBe(before);
  });

  it("keeps /health open for the container healthcheck", async () => {
    const answer = await ask(webPort, "/health", { host: "localhost:3000" });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("ok");
  });

  it("sends frame and referrer protections", async () => {
    const answer = await ask(webPort, "/orders", { host: `127.0.0.1:${webPort}` });
    expect(answer.headers["x-frame-options"]).toBe("DENY");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  });
});

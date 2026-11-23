import { createServer as createHttpServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrdersWebServer } from "../src/server.js";
import { TokenSource } from "../src/token.js";

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

describe("the orders page server with a token the router refuses", () => {
  /** A router that accepts only `accepted`, and a token endpoint that hands out t1, then t2, … */
  async function setup(accepted: string | null) {
    const seen: (string | undefined)[] = [];
    const r = createHttpServer((req, res) => {
      seen.push(req.headers.authorization);
      if (accepted === null || req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: "unauthorized" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { orders: [] } }));
    });
    await new Promise<void>((ok) => r.listen(0, "127.0.0.1", ok));
    let issued = 0;
    const http = (async () => new Response(JSON.stringify({ access_token: `t${++issued}`, expires_in: 300 }))) as typeof fetch;
    const tokens = new TokenSource("http://kc/token", "orders-web", "s", http);
    const port = await freePort();
    const graphql = `http://127.0.0.1:${(r.address() as AddressInfo).port}/graphql`;
    const w = createOrdersWebServer({ graphql, publicGraphql: graphql, tokens, webOrigin: `http://127.0.0.1:${port}` });
    await new Promise<void>((ok) => w.listen(port, "127.0.0.1", ok));
    return { seen, port, issued: () => issued, close: () => (w.close(), r.close()) };
  }

  it("drops the refused token and succeeds with a new one, at once", async () => {
    const s = await setup("t2");
    try {
      const answer = await ask(s.port, "/api/orders", { host: `127.0.0.1:${s.port}` });
      expect(answer.status).toBe(200);
      expect(answer.body).not.toContain("401");
      expect(s.seen).toEqual(["Bearer t1", "Bearer t2"]);
      expect(s.issued()).toBe(2);
    } finally {
      s.close();
    }
  });

  it("tries a new token only once, then says the router refused it", async () => {
    const s = await setup(null);
    try {
      const answer = await ask(s.port, "/api/orders", { host: `127.0.0.1:${s.port}` });
      expect(answer.body).toContain("refused this server&#39;s token (401)");
      expect(s.seen).toEqual(["Bearer t1", "Bearer t2"]);
    } finally {
      s.close();
    }
  });
});

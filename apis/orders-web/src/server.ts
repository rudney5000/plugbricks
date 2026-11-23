import { createServer, type IncomingMessage, type Server } from "node:http";
import { ORDERS_ONLY_QUERY, ORDERS_QUERY, pageHtml, readOrders, refreshJson, shipmentNotInSchema, type OrdersView } from "./page.js";
import { TokenSource } from "./token.js";

export interface OrdersWebOptions {
  graphql: string | null;
  publicGraphql: string | null;
  tokens: TokenSource | null;
  /** The browser's origin, from WEB_ORIGIN (the brick's webPort): the port the browser uses. */
  webOrigin?: string;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** The `Host` header split into its name and port, brackets of [::1] removed. */
function hostOf(value: string): { name: string; port: string | null } {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    const rest = raw.slice(end + 1);
    return { name: raw.slice(1, end), port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const i = raw.lastIndexOf(":");
  return i > 0 ? { name: raw.slice(0, i), port: raw.slice(i + 1) } : { name: raw, port: null };
}

function loopbackName(hostname: string): boolean {
  return LOOPBACK.has(hostname.replace(/^\[|\]$/g, ""));
}

export function createOrdersWebServer(o: OrdersWebOptions): Server {
  async function loadOrders(): Promise<OrdersView> {
    if (!o.graphql) return { orders: [], shippingUnavailable: false, error: "no router: this platform serves no subgraph" };
    try {
      const authorization: Record<string, string> = o.tokens ? { authorization: `Bearer ${await o.tokens.get()}` } : {};
      const ask = async (query: string) => {
        const res = await fetch(o.graphql!, {
          method: "POST",
          headers: { "content-type": "application/json", ...authorization },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(5000),
        });
        return { status: res.status, answer: await res.json() };
      };
      let { status, answer } = await ask(ORDERS_QUERY);
      if (status === 401) return { orders: [], shippingUnavailable: false, error: "the router refused this server's token (401)" };
      if (!shipmentNotInSchema(answer)) return readOrders(answer);
      ({ status, answer } = await ask(ORDERS_ONLY_QUERY));
      return readOrders(answer, true);
    } catch (e) {
      return { orders: [], shippingUnavailable: false, error: `the router did not answer (${(e as Error).message})` };
    }
  }

  // The browser reaches this server on 127.0.0.1:<webPort>: only requests addressed there (and from that origin,
  // when a browser sends one) are answered. Without WEB_ORIGIN (a direct run), the listening port is the reference.
  // /health stays open: the container healthcheck asks localhost on the container port, not the host's.
  const addressedToUs = (req: IncomingMessage): boolean => {
    const expected = o.webOrigin ? new URL(o.webOrigin).port : String(req.socket.localPort);
    const host = hostOf(req.headers.host ?? "");
    if (!loopbackName(host.name) || host.port !== expected) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const u = new URL(origin);
      return u.protocol === "http:" && loopbackName(u.hostname) && u.port === expected;
    } catch {
      return false;
    }
  };

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!addressedToUs(req)) {
      res.writeHead(403, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end("this page only answers on its loopback address");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
      return;
    }
    if (path === "/") {
      res.writeHead(302, { ...SECURITY_HEADERS, location: "/orders" }).end();
      return;
    }
    if (path === "/api/orders") {
      loadOrders().then((view) => res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS }).end(refreshJson(view)));
      return;
    }
    if (path !== "/orders") {
      res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end("not found");
      return;
    }
    loadOrders().then((view) => {
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          ...SECURITY_HEADERS,
          // The page's own script, which only calls this server.
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        .end(pageHtml(view, o.publicGraphql));
    });
  });
}

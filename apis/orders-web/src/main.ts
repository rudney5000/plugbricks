import { createServer } from "node:http";
import { ORDERS_ONLY_QUERY, ORDERS_QUERY, pageHtml, readOrders, refreshJson, shipmentNotInSchema, type OrdersView } from "./page.js";
import { TokenSource } from "./token.js";

// GRAPHQL_URL (the router inside the platform) and PUBLIC_GRAPHQL_URL (the router as this machine's browser reaches it)
// are set by plugbricks on the web service when the platform has a router (D17). OIDC_TOKEN_URL, OIDC_CLIENT_ID and
// OIDC_CLIENT_SECRET are injected when the platform has an oidc provider (D19): the router then requires a token, which
// this server asks for with its own client and sends with every request. The secret is never logged.
const port = Number(process.env.PORT ?? 3000);
const graphql = process.env.GRAPHQL_URL || null;
const publicGraphql = process.env.PUBLIC_GRAPHQL_URL || null;
const tokens = TokenSource.fromEnv(process.env);

async function loadOrders(): Promise<OrdersView> {
  if (!graphql) return { orders: [], shippingUnavailable: false, error: "no router: this platform serves no subgraph" };
  try {
    const authorization: Record<string, string> = tokens ? { authorization: `Bearer ${await tokens.get()}` } : {};
    const ask = async (query: string) => {
      const res = await fetch(graphql, {
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

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" }).end();
    return;
  }
  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (path === "/") {
    res.writeHead(302, { location: "/orders" }).end();
    return;
  }
  if (path === "/api/orders") {
    loadOrders().then((view) => res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS }).end(refreshJson(view)));
    return;
  }
  if (path !== "/orders") {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
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
      .end(pageHtml(view, publicGraphql));
  });
  // No host: every address, IPv6 included; the healthcheck asks localhost, which is ::1 in the image.
}).listen(port, () => {
  console.log(
    `orders-web on :${port}; router ${graphql ?? "none"}; browser router ${publicGraphql ?? "none"}; token ${tokens ? `from ${tokens.url} as ${tokens.clientId}` : "none"}`,
  );
});

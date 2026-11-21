import { createServer } from "node:http";
import { ORDERS_QUERY, pageHtml, readOrders, type OrdersView } from "./page.js";

// GRAPHQL_URL (the router inside the platform) and PUBLIC_GRAPHQL_URL (the router as this machine's
// browser reaches it) are set by plugbricks on the web service when the platform has a router (D17).
const port = Number(process.env.PORT ?? 3000);
const graphql = process.env.GRAPHQL_URL || null;
const publicGraphql = process.env.PUBLIC_GRAPHQL_URL || null;

async function loadOrders(): Promise<OrdersView> {
  if (!graphql) return { orders: [], shippingUnavailable: false, error: "no router: this platform serves no subgraph" };
  try {
    const res = await fetch(graphql, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: ORDERS_QUERY }),
      signal: AbortSignal.timeout(5000),
    });
    return readOrders(await res.json());
  } catch (e) {
    return { orders: [], shippingUnavailable: false, error: `the router did not answer (${(e as Error).message})` };
  }
}

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
  if (path !== "/orders") {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  loadOrders().then((view) => {
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // The page's own script, and fetch only to the router the platform gave it.
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${publicGraphql ? new URL(publicGraphql).origin : "'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      .end(pageHtml(view, publicGraphql));
  });
  // No host: every address, IPv6 included; the healthcheck asks localhost, which is ::1 in the image.
}).listen(port, () => {
  console.log(`orders-web on :${port}; router ${graphql ?? "none"}; browser router ${publicGraphql ?? "none"}`);
});

// The orders page of the shop: pure functions, so they are tested without a server or a router.

export interface OrderRow {
  id: string;
  total: number;
  status: string;
  /** null: not shipped yet. undefined: shipping did not answer for it. */
  shipment?: { carrier: string; status: string } | null;
}

export interface OrdersView {
  orders: OrderRow[];
  /** The router answered the orders but not their shipment (shipping is down or not installed). */
  shippingUnavailable: boolean;
  /** Set when no order could be read at all. */
  error?: string;
}

/** The query the page sends to the router, from the server (GRAPHQL_URL) and from the browser (PUBLIC_GRAPHQL_URL). */
export const ORDERS_QUERY = "{ orders(limit: 50) { id total status shipment { carrier status } } }";

/** The same without the shipment: for a platform where no brick serves it (shipping not installed). */
export const ORDERS_ONLY_QUERY = "{ orders(limit: 50) { id total status } }";

/**
 * The router refuses a whole query that asks for a field the composed schema does not have: without the shipping
 * brick there is no `shipment` on Order. Then the page asks again without it, and shows the shipment unavailable.
 */
export function shipmentNotInSchema(answer: { errors?: { message: string }[] }): boolean {
  return (answer.errors ?? []).some((e) => /Cannot query field "shipment"/.test(e.message));
}

interface GraphqlAnswer {
  data?: { orders?: { id: string; total: number; status: string; shipment?: { carrier: string; status: string } | null }[] } | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

/**
 * Reads the router's answer. A failed shipping subgraph makes the router return the orders with
 * errors whose path ends in "shipment": the orders are still shown, the shipment is marked unavailable.
 */
export function readOrders(answer: GraphqlAnswer, withoutShipment = false): OrdersView {
  const orders = answer.data?.orders;
  if (!orders) return { orders: [], shippingUnavailable: false, error: answer.errors?.[0]?.message ?? "no data" };
  const failed = new Set(
    (answer.errors ?? []).filter((e) => e.path?.[0] === "orders" && e.path.includes("shipment")).map((e) => Number(e.path![1])),
  );
  const anyShipmentError = withoutShipment || (answer.errors ?? []).some((e) => !e.path || e.path.includes("shipment"));
  return {
    orders: orders.map((o, i) => ({
      id: o.id,
      total: o.total,
      status: o.status,
      shipment: failed.has(i) || (anyShipmentError && !o.shipment) ? undefined : (o.shipment ?? null),
    })),
    shippingUnavailable: anyShipmentError,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function shipmentCell(o: OrderRow): string {
  if (o.shipment === undefined) return '<span class="pill warn">Unavailable</span>';
  if (o.shipment === null) return '<span class="muted">Not shipped</span>';
  return `${escapeHtml(o.shipment.carrier)} · ${escapeHtml(o.shipment.status)}`;
}

/** The table body; also what /api/orders returns to the page's "Refresh" (see BROWSER_SCRIPT). */
export function rowsHtml(view: OrdersView): string {
  if (view.error) return `<tr><td colspan="4" class="muted">Orders cannot be read: ${escapeHtml(view.error)}</td></tr>`;
  if (view.orders.length === 0) return '<tr><td colspan="4" class="muted">No order yet.</td></tr>';
  return view.orders
    .map(
      (o) =>
        `<tr><td>#${escapeHtml(o.id)}</td><td>${o.total.toFixed(2)}</td><td><span class="pill">${escapeHtml(o.status)}</span></td><td>${shipmentCell(o)}</td></tr>`,
    )
    .join("");
}

/**
 * The browser side: "Refresh" asks this page's own server (/api/orders, same origin), which asks the router with its
 * token (D19). A browser has no token to send, so it never calls the router itself; the rows come back already
 * escaped by rowsHtml.
 */
const BROWSER_SCRIPT = `
document.querySelector("#refresh").addEventListener("click", async () => {
  const status = document.querySelector("#status");
  status.textContent = "Asking the server …";
  try {
    const res = await fetch("/api/orders");
    const answer = await res.json();
    document.querySelector("#banner").hidden = !answer.shippingUnavailable;
    document.querySelector("tbody").innerHTML = answer.rows;
    status.textContent = "Refreshed at " + new Date().toLocaleTimeString() + " (HTTP " + res.status + ")";
  } catch (e) {
    status.textContent = "The server could not be reached: " + e.message;
  }
});
`;

/** What /api/orders answers: the rows, rendered and escaped by the server, and the shipping banner. */
export function refreshJson(view: OrdersView): string {
  return JSON.stringify({ rows: rowsHtml(view), shippingUnavailable: view.shippingUnavailable });
}

/** The whole page. `publicGraphql` is where the router is for a browser on this machine; null when there is no router. */
export function pageHtml(view: OrdersView, publicGraphql: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shop: Orders</title>
<style>
:root{color-scheme:light;--ink:#1b2330;--muted:#5a5548;--line:#e7e2d8;--accent:#2457d6}
body{margin:0;font-family:system-ui,sans-serif;color:var(--ink);background:#fff}
header{display:flex;gap:28px;align-items:center;padding:0 32px;min-height:60px;border-bottom:1px solid var(--line)}
header strong{font-size:18px}
main{max-width:1120px;padding:32px;box-sizing:border-box}
h1{font-size:24px;margin:0 0 16px}
.banner{background:#fff3d6;color:#8a5a00;border-radius:8px;padding:12px 16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;border:1px solid var(--line)}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--line)}
th{background:#f7f3ea;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px;background:#e8eefc;color:#1f3f96}
.pill.warn{background:#fff3d6;color:#8a5a00}
.muted{color:var(--muted)}
button{font:inherit;margin-top:16px;padding:9px 16px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
footer{margin-top:16px;font-size:13px;color:var(--muted);line-height:1.6}
</style>
</head>
<body>
<header><strong>Shop</strong><span>Orders</span></header>
<main data-graphql="${escapeHtml(publicGraphql ?? "")}">
<h1>Orders</h1>
<div id="banner" class="banner"${view.shippingUnavailable ? "" : " hidden"}>Shipping information is temporarily unavailable. Your orders are still shown.</div>
<table>
<thead><tr><th>Order</th><th>Total</th><th>Status</th><th>Shipment</th></tr></thead>
<tbody>${rowsHtml(view)}</tbody>
</table>
<button id="refresh" type="button">Refresh</button>
<footer>
<div id="status">Rendered by the server through the router (GRAPHQL_URL), with its own token when the platform checks tokens.</div>
<div>Served by the <b>orders-web</b> brick. Its data comes from the router${publicGraphql ? ` at <code>${escapeHtml(publicGraphql)}</code>` : ""}: the order fields from <b>orders</b>, the shipment from <b>shipping</b>.</div>
</footer>
</main>
<script>${BROWSER_SCRIPT}</script>
</body>
</html>
`;
}

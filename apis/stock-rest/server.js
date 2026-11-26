// The REST API of the example (openapi.json). It stands for a service that already exists: it knows nothing of GraphQL or
// of plugbricks, has no dependency, and keeps its data in memory.
import { createServer } from "node:http";

export const SEED = [
  { sku: "BRK-1", name: "Brick", quantity: 12 },
  { sku: "PLG-2", name: "Plug", quantity: 0 },
];

const MAX_BODY = 10_000;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_BODY) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

/** The server, on its own copy of the data. */
export function createStockServer(seed = SEED) {
  const items = new Map(seed.map((i) => [i.sku, { ...i }]));
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") return res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (req.method === "GET" && path === "/items") return send(res, 200, [...items.values()]);
    const match = /^\/items\/([A-Za-z0-9-]{1,32})(\/restock)?$/.exec(path);
    if (match) {
      const [, sku, restock] = match;
      const item = items.get(sku);
      if (req.method === "GET" && !restock) return item ? send(res, 200, item) : send(res, 404, { message: `no item ${sku}` });
      if (req.method === "POST" && restock) {
        if (!item) return send(res, 404, { message: `no item ${sku}` });
        let quantity;
        try {
          quantity = JSON.parse(await readBody(req)).quantity;
        } catch {
          return send(res, 400, { message: "the body must be a JSON object with a quantity" });
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          return send(res, 400, { message: "quantity must be a whole number between 1 and 1000" });
        }
        item.quantity += quantity;
        return send(res, 200, item);
      }
    }
    send(res, 404, { message: "not found" });
  });
}

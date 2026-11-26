import { createApp } from "./app.js";
import { stockClient } from "./client.js";

// STOCK_API_URL is the REST API this adapter fronts: the brick's manifest names it.
const url = process.env.STOCK_API_URL ?? "";
if (!/^https?:\/\//.test(url) || !URL.canParse(url)) {
  console.error("stock-api: STOCK_API_URL must be the http(s) address of the stock REST API");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4000);
const server = createApp(stockClient(url));
server.listen(port, () => console.log(`stock-api: listening on :${port} (/graphql, /health), in front of ${new URL(url).host}`));

// docker stop and Kubernetes send SIGTERM: finish the requests in flight.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close((err) => process.exit(err ? 1 : 0));
  });
}

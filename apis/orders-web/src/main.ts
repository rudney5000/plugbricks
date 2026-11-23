import { createOrdersWebServer } from "./server.js";
import { TokenSource } from "./token.js";

// GRAPHQL_URL (the router inside the platform) and PUBLIC_GRAPHQL_URL (the router as this machine's browser reaches it)
// are set by plugbricks on the web service when the platform has a router (D17). OIDC_TOKEN_URL, OIDC_CLIENT_ID and
// OIDC_CLIENT_SECRET are injected when the platform has an oidc provider (D19): the router then requires a token, which
// this server asks for with its own client and sends with every request. WEB_ORIGIN is the address the browser uses
// (the brick's webPort); the server only answers requests addressed to it. The secret is never logged.
const port = Number(process.env.PORT ?? 3000);
const graphql = process.env.GRAPHQL_URL || null;
const publicGraphql = process.env.PUBLIC_GRAPHQL_URL || null;
const tokens = TokenSource.fromEnv(process.env);
const server = createOrdersWebServer({
  graphql,
  publicGraphql,
  tokens: tokens ?? null,
  webOrigin: process.env.WEB_ORIGIN || undefined,
});

server.listen(port, () => {
  console.log(
    `orders-web on :${port}; router ${graphql ?? "none"}; browser router ${publicGraphql ?? "none"}; token ${tokens ? `from ${tokens.url} as ${tokens.clientId}` : "none"}`,
  );
});

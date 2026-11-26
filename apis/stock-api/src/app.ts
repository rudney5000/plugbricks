import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { GraphQLError, parse } from "graphql";
import { createYoga } from "graphql-yoga";
import { isSku, RefusedError, UpstreamError, type StockClient } from "./client.js";

/** The SDL shipped with the brick (examples/stock-api/schema.graphql holds the same text). */
export const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

// A GraphQLError is shown to the client as is; any other error is masked by Yoga.
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

const checked = (sku: string): string => {
  if (!isSku(sku)) throw badInput("sku must be 1 to 32 letters, digits or dashes");
  return sku;
};

/**
 * A call to the REST API, its failures turned into GraphQL errors: a refusal keeps its message, anything else says only
 * that the upstream is unavailable (the details, which name its address and paths, go to the log).
 */
async function upstream<T>(call: Promise<T>, log: (line: string) => void): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof RefusedError) throw badInput(e.message);
    if (!(e instanceof UpstreamError)) throw e;
    log(`stock-api: ${e.message}`);
    throw new GraphQLError("the stock service is unavailable", { extensions: { code: "UPSTREAM_UNAVAILABLE" } });
  }
}

function resolvers(stock: StockClient, log: (line: string) => void) {
  return {
    Query: {
      items: () => upstream(stock.list(), log),
      item: (_: unknown, args: { sku: string }) => upstream(stock.get(checked(args.sku)), log),
    },
    Mutation: {
      restock: (_: unknown, args: { sku: string; quantity: number }) => upstream(stock.restock(checked(args.sku), args.quantity), log),
    },
    Item: {
      // Called by the router with { __typename: "Item", sku } when another subgraph refers to an item. One REST call per
      // reference: with many of them, add an operation to the REST API that takes several skus and batch here.
      __resolveReference: (ref: { sku: string }) => (isSku(ref.sku) ? upstream(stock.get(ref.sku), log) : null),
    },
  };
}

/**
 * The HTTP server: GraphQL on /graphql, and /health, which answers 200 while the adapter runs, whether or not the REST API
 * does: restarting the adapter would not bring that API back. Nothing else is served.
 */
export function createApp(stock: StockClient, log: (line: string) => void = console.error): Server {
  const schema = buildSubgraphSchema([{ typeDefs: parse(typeDefs), resolvers: resolvers(stock, log) as never }]);
  const yoga = createYoga({ schema, graphqlEndpoint: "/graphql", landingPage: false, logging: "warn" });
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (path === "/graphql") return void yoga(req, res);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  });
}

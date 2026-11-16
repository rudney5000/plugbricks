import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { GraphQLError, parse } from "graphql";
import { createYoga } from "graphql-yoga";
import type pg from "pg";
import { createOrder, findOrder, listOrders } from "./db.js";

/** The SDL shipped with the brick (examples/orders/schema.graphql holds the same text). */
export const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

const MAX_TOTAL = 9_999_999_999.99;

function resolvers(pool: pg.Pool) {
  return {
    Query: {
      orders: () => listOrders(pool),
      order: (_: unknown, args: { id: string }) => findOrder(pool, args.id),
    },
    Mutation: {
      createOrder: (_: unknown, args: { total: number }) => {
        if (!Number.isFinite(args.total) || args.total < 0 || args.total > MAX_TOTAL) {
          // A GraphQLError is shown to the client as is; any other error is masked by Yoga.
          throw new GraphQLError(`total must be between 0 and ${MAX_TOTAL}`, { extensions: { code: "BAD_USER_INPUT" } });
        }
        return createOrder(pool, Math.round(args.total * 100) / 100);
      },
    },
    Order: {
      // Called by the router with { __typename: "Order", id } when another subgraph refers to an order.
      __resolveReference: (ref: { id: string }) => findOrder(pool, ref.id),
    },
  };
}

/**
 * The HTTP server: GraphQL on /graphql, and /health, which answers 200 only while the database
 * answers (the brick's healthcheck calls it). Nothing else is served.
 */
export function createApp(pool: pg.Pool): Server {
  const schema = buildSubgraphSchema([{ typeDefs: parse(typeDefs), resolvers: resolvers(pool) as never }]);
  const yoga = createYoga({ schema, graphqlEndpoint: "/graphql", landingPage: false, logging: "warn" });
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      pool
        .query("SELECT 1")
        .then(() => res.writeHead(200, { "content-type": "text/plain" }).end("ok\n"))
        .catch(() => res.writeHead(503, { "content-type": "text/plain" }).end("database unavailable\n"));
      return;
    }
    if (req.url?.startsWith("/graphql")) return yoga(req, res);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  });
}

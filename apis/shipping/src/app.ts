import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { GraphQLError, parse } from "graphql";
import { createYoga } from "graphql-yoga";
import type pg from "pg";
import type { Caller, TokenCheck } from "./auth.js";
import { createShipment, findShipment, isOrderId } from "./db.js";

/** The SDL shipped with the brick (examples/shipping/schema.graphql holds the same text). */
export const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

const MAX_CARRIER = 40;

// A GraphQLError is shown to the client as is; any other error is masked by Yoga.
const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

function resolvers(pool: pg.Pool) {
  return {
    Query: {
      shipment: (_: unknown, args: { orderId: string }) => findShipment(pool, args.orderId),
    },
    Mutation: {
      shipOrder: async (_: unknown, args: { orderId: string; carrier: string }) => {
        if (!isOrderId(args.orderId)) throw badInput("orderId must be an order id: a positive whole number without leading zeros");
        const carrier = args.carrier.trim();
        if (carrier.length < 1 || carrier.length > MAX_CARRIER) throw badInput(`carrier must be between 1 and ${MAX_CARRIER} characters`);
        const shipment = await createShipment(pool, args.orderId, carrier);
        if (!shipment) throw badInput(`order ${args.orderId} already has a shipment`);
        return shipment;
      },
    },
    Order: {
      // Called by the router with { __typename: "Order", id } when a query asks for fields of an order that
      // this subgraph adds. Orders are not stored here: the reference is all there is.
      __resolveReference: (ref: { id: string }) => ({ id: ref.id }),
      shipment: (order: { id: string }) => findShipment(pool, order.id),
    },
  };
}

/**
 * The HTTP server: GraphQL on /graphql, and /health, which answers 200 only while the database
 * answers (the brick's healthcheck calls it). Nothing else is served.
 */
export function createApp(pool: pg.Pool, checkToken?: TokenCheck): Server {
  const schema = buildSubgraphSchema([{ typeDefs: parse(typeDefs), resolvers: resolvers(pool) as never }]);
  // The resolvers find the caller, checked below, in their context (D20); undefined without a token check.
  const yoga = createYoga<{ caller?: Caller }>({ schema, graphqlEndpoint: "/graphql", landingPage: false, logging: "warn" });
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") {
      pool
        .query("SELECT 1")
        .then(() => res.writeHead(200, { "content-type": "text/plain" }).end("ok\n"))
        .catch(() => res.writeHead(503, { "content-type": "text/plain" }).end("database unavailable\n"));
      return;
    }
    if (path === "/graphql") {
      if (!checkToken) return yoga(req, res);
      // With the platform's oidc provider (D20): no valid token, no GraphQL, even past the router. /health stays open.
      checkToken(req.headers.authorization).then((caller) => {
        if (!caller) {
          res
            .writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="plugbricks"' })
            .end(JSON.stringify({ errors: [{ message: "unauthorized" }] }));
          return;
        }
        void yoga(req, res, { caller });
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  });
}

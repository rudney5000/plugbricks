import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSubgraphs, type SubgraphInput } from "../src/federation.js";

// Every example brick that serves a subgraph, composed together exactly as `plugbricks add` would
// compose them once all of them are installed. CI runs this with the rest of the tests, so an
// example whose schema stops composing with the others fails the build.
const examples = fileURLToPath(new URL("../examples/", import.meta.url));

function exampleSubgraphs(): SubgraphInput[] {
  const inputs: SubgraphInput[] = [];
  for (const brick of readdirSync(examples).sort()) {
    const m = JSON.parse(readFileSync(join(examples, brick, "plugin.json"), "utf8"));
    if (!m.subgraph) continue;
    const service = m.services.find((s: { name: string }) => s.name === m.subgraph.service);
    inputs.push({
      brick,
      file: `examples/${brick}/${m.subgraph.schema}`,
      sdl: readFileSync(join(examples, brick, m.subgraph.schema), "utf8"),
      // A gRPC service is reached at host:port, with its proto and its mapping (D35).
      url: m.subgraph.grpc
        ? `${brick}-${m.subgraph.service}:${service.port}`
        : `http://${brick}-${m.subgraph.service}:${service.port}${m.subgraph.path}`,
      extends: m.extends ?? [],
      ...(m.subgraph.grpc
        ? {
            grpc: {
              protoFile: `examples/${brick}/${m.subgraph.grpc.proto}`,
              proto: readFileSync(join(examples, brick, m.subgraph.grpc.proto), "utf8"),
              mappingFile: `examples/${brick}/${m.subgraph.grpc.mapping}`,
              mapping: readFileSync(join(examples, brick, m.subgraph.grpc.mapping), "utf8"),
            },
          }
        : {}),
    });
  }
  return inputs;
}

describe("the example bricks, composed together", () => {
  it("orders, shipping, the gRPC catalog and the REST adapter compose, and shipping extends the Order entity of orders", () => {
    const inputs = exampleSubgraphs();
    expect(inputs.map((i) => i.brick)).toEqual(["catalog-grpc", "orders-api", "shipping-api", "stock-api"]);
    expect(inputs.find((i) => i.brick === "shipping-api")?.extends).toEqual([{ plugin: "orders-api", entities: ["Order"] }]);
    const result = composeSubgraphs(inputs);
    expect(result.ok, result.ok ? "" : result.issues.map((i) => i.message).join("\n")).toBe(true);
    if (result.ok) expect(result.federation?.subgraphs).toEqual(["catalog-grpc", "orders-api", "shipping-api", "stock-api"]);
  });

  it("shipping alone is refused: its owner is missing", () => {
    const shippingOnly = exampleSubgraphs().filter((i) => i.brick === "shipping-api");
    const result = composeSubgraphs(shippingOnly);
    expect(result.ok === false && result.issues.map((i) => i.code)).toEqual(["EXTENDS_OWNER_MISSING"]);
  });
});

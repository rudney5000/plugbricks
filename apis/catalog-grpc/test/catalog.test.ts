import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog, startCatalog, type Product } from "../src/catalog.js";

// The service of the catalog example (D35), called as the router calls it: a gRPC client built from the same proto file.
const proto = fileURLToPath(new URL("../proto/service.proto", import.meta.url));

type Call<Req, Res> = (request: Req, done: (error: grpc.ServiceError | null, response: Res) => void) => void;
interface Client {
  QueryProducts: Call<object, { products: Product[] }>;
  QueryProduct: Call<{ id: string }, { product: Product | null }>;
  MutationRename: Call<{ id: string; name: string }, { rename: Product | null }>;
  LookupProductById: Call<{ keys: { id: string }[] }, { result: Product[] }>;
}

let server: grpc.Server;
let client: Client;
const ask = <Res>(call: (done: (error: grpc.ServiceError | null, response: Res) => void) => void) =>
  new Promise<Res>((resolve, reject) => call((error, response) => (error ? reject(error) : resolve(response))));

beforeAll(async () => {
  const started = await startCatalog(proto, "0");
  server = started.server;
  const Catalog = loadCatalog(proto);
  client = new Catalog(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(() => server.forceShutdown());

describe("the catalog service", () => {
  it("lists its products and finds one by id", async () => {
    const all = await ask<{ products: Product[] }>((done) => client.QueryProducts({}, done));
    expect(all.products.map((p) => p.id)).toEqual(["1", "2"]);
    const one = await ask<{ product: Product | null }>((done) => client.QueryProduct({ id: "2" }, done));
    expect(one.product).toMatchObject({ id: "2", name: "Plug", price: 3 });
  });

  it("answers no product for an unknown id", async () => {
    const none = await ask<{ product: Product | null }>((done) => client.QueryProduct({ id: "nope" }, done));
    expect(none.product).toBeNull();
  });

  it("renames a product, and the new name is the one it lists afterwards", async () => {
    const renamed = await ask<{ rename: Product | null }>((done) => client.MutationRename({ id: "1", name: "Lego" }, done));
    expect(renamed.rename).toMatchObject({ id: "1", name: "Lego" });
    const again = await ask<{ product: Product | null }>((done) => client.QueryProduct({ id: "1" }, done));
    expect(again.product?.name).toBe("Lego");
  });

  it("looks entities up by key, in the order of the keys and as many as the keys", async () => {
    const found = await ask<{ result: Product[] }>((done) =>
      client.LookupProductById({ keys: [{ id: "2" }, { id: "x" }, { id: "1" }] }, done),
    );
    expect(found.result.map((p) => p.id)).toEqual(["2", "", "1"]);
  });
});

describe("the proto the brick ships", () => {
  it("is the one the service loads: the copy in the brick is byte for byte the same", () => {
    const brick = fileURLToPath(new URL("../../../packages/plugbricks/examples/catalog-grpc/", import.meta.url));
    for (const [mine, theirs] of [
      ["proto/service.proto", "service.proto"],
      ["proto/mapping.json", "mapping.json"],
      ["schema.graphql", "schema.graphql"],
    ] as const) {
      expect(readFileSync(new URL(`../${mine}`, import.meta.url), "utf8"), mine).toBe(readFileSync(brick + theirs, "utf8"));
    }
  });
});

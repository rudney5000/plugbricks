import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";

// The catalog of the example (D35): the methods that `wgc grpc-service generate` wrote in proto/service.proto, one per
// root field of schema.graphql, and the entity lookup of the @key. The data is in memory: this is the shape of a gRPC
// subgraph, not a database.

export interface Product {
  id: string;
  name: string;
  price: number;
}

/** The service of a proto file, loaded with the names the proto uses (keepCase): `.service` for a server, `new` for a client. */
export function loadCatalog(protoFile: string): grpc.ServiceClientConstructor {
  const definition = loader.loadSync(protoFile, { keepCase: true, defaults: true });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as { service: { v1: { Catalog: grpc.ServiceClientConstructor } } };
  return pkg.service.v1.Catalog;
}

export const SEED: Product[] = [
  { id: "1", name: "Brick", price: 1.5 },
  { id: "2", name: "Plug", price: 3 },
];

type Unary<Req, Res> = grpc.handleUnaryCall<Req, Res>;

/** The methods of the service, on their own copy of the data. */
export function catalogMethods(seed: Product[] = SEED): grpc.UntypedServiceImplementation {
  const products = new Map(seed.map((p) => [p.id, { ...p }]));
  const QueryProducts: Unary<object, { products: Product[] }> = (_call, done) => done(null, { products: [...products.values()] });
  const QueryProduct: Unary<{ id: string }, { product: Product | null }> = (call, done) =>
    done(null, { product: products.get(call.request.id) ?? null });
  const MutationRename: Unary<{ id: string; name: string }, { rename: Product | null }> = (call, done) => {
    const product = products.get(call.request.id);
    if (product) product.name = call.request.name;
    done(null, { rename: product ?? null });
  };
  // The keys come in a list and the answer must keep its order and its length. A repeated field cannot hold a null, so a
  // key that is not in the catalog gets an empty Product (its id is ""): the router then has nothing to join it to.
  const LookupProductById: Unary<{ keys: { id: string }[] }, { result: Product[] }> = (call, done) =>
    done(null, { result: call.request.keys.map((k) => products.get(k.id) ?? { id: "", name: "", price: 0 }) });
  return { QueryProducts, QueryProduct, MutationRename, LookupProductById };
}

/** Starts the service on a port ("0" for any free one); resolves with the server and the port it listens on. */
export function startCatalog(protoFile: string, port: string, seed?: Product[]): Promise<{ server: grpc.Server; port: number }> {
  const server = new grpc.Server();
  server.addService(loadCatalog(protoFile).service, catalogMethods(seed));
  return new Promise((resolve, reject) => {
    // Plain text: the router and the service share the platform's private network (D35).
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (error, bound) => {
      if (error) reject(error);
      else resolve({ server, port: bound });
    });
  });
}

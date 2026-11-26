import * as grpc from "@grpc/grpc-js";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";

// The brick's healthcheck (it runs in the image, where only node is): asks the service for its products and exits 0 when it
// answers within two seconds, 1 otherwise.
const port = process.env.PORT ?? "50051";
const Catalog = loadCatalog(fileURLToPath(new URL("../proto/service.proto", import.meta.url)));
const client = new Catalog(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as {
  QueryProducts: (request: object, options: { deadline: number }, done: (error: grpc.ServiceError | null) => void) => void;
};
client.QueryProducts({}, { deadline: Date.now() + 2000 }, (error) => process.exit(error ? 1 : 0));

import { fileURLToPath } from "node:url";
import { startCatalog } from "./catalog.js";

const protoFile = fileURLToPath(new URL("../proto/service.proto", import.meta.url));
const { server, port } = await startCatalog(protoFile, process.env.PORT ?? "50051");
console.log(`catalog (gRPC) listening on ${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.tryShutdown(() => process.exit(0)));
}

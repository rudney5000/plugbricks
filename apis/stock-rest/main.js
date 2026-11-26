import { createStockServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const server = createStockServer();
server.listen(port, () => console.log(`stock (REST) listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));

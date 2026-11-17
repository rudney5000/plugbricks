import pg from "pg";
import { createApp } from "./app.js";
import { migrate } from "./db.js";

// DATABASE_URL is injected by plugbricks from the postgres brick. It holds a password: never log it.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("orders: DATABASE_URL is not set; it is injected by plugbricks when the brick requires database");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4000);

// Bounded waits: an unreachable database makes /health answer 503 within seconds instead of hanging.
const pool = new pg.Pool({
  connectionString: url,
  max: 10,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
});
// An idle client that loses its connection must not crash the process; the next query reconnects.
pool.on("error", (e) => console.error(`orders: idle database connection lost: ${e.message}`));

const applied = await migrate(pool);
if (applied.length) console.log(`orders: applied migrations ${applied.join(", ")}`);

const server = createApp(pool);
server.listen(port, () => console.log(`orders: listening on :${port} (/graphql, /health)`));

// docker stop and Kubernetes send SIGTERM: finish the requests in flight, then close the pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async (err) => {
      if (err) console.error(`orders: closing the server: ${err.message}`);
      try {
        await pool.end();
      } catch (e) {
        console.error(`orders: closing the database pool: ${(e as Error).message}`);
        process.exit(1);
      }
      process.exit(err ? 1 : 0);
    });
  });
}

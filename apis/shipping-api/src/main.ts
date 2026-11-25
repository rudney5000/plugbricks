import pg from "pg";
import { createApp } from "./app.js";
import { authorizationFromEnv, tokenCheckFromEnv } from "./auth.js";
import { migrate } from "./db.js";

// OIDC_ISSUER, OIDC_JWKS_URL and OIDC_AUDIENCE come with the oidc capability (D20): every request then needs a valid token.
// Checked first: a partial configuration stops the API before it touches the database.
const checkToken = (() => {
  try {
    return tokenCheckFromEnv(process.env);
  } catch (e) {
    console.error(`shipping: ${(e as Error).message}`);
    process.exit(1);
  }
})();
if (checkToken) console.log(`shipping: requests need a token from ${process.env.OIDC_ISSUER}`);

// AUTHORIZATION_QUERIES_ROLE and AUTHORIZATION_MUTATIONS_ROLE come from the brick's "authorization" block (D22): a valid token
// then also needs the role of the class of its operation. Set without the token check, they stop the API.
const authorization = (() => {
  try {
    return authorizationFromEnv(process.env);
  } catch (e) {
    console.error(`shipping: ${(e as Error).message}`);
    process.exit(1);
  }
})();
if (authorization) {
  const need = (["queries", "mutations"] as const).map((c) =>
    authorization[c] ? `${c} need "${authorization[c]}"` : `${c} are open to any valid token`,
  );
  console.log(`shipping: ${need.join(", ")} (roles of client "${authorization.client}")`);
}

// DATABASE_URL is injected by plugbricks from the postgres brick. It holds a password: never log it.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("shipping: DATABASE_URL is not set; it is injected by plugbricks when the brick requires database");
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
pool.on("error", (e) => console.error(`shipping: idle database connection lost: ${e.message}`));

const applied = await migrate(pool);
if (applied.length) console.log(`shipping: applied migrations ${applied.join(", ")}`);

const server = createApp(pool, checkToken, authorization);
server.listen(port, () => console.log(`shipping: listening on :${port} (/graphql, /health)`));

// docker stop and Kubernetes send SIGTERM: finish the requests in flight, then close the pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(async (err) => {
      if (err) console.error(`shipping: closing the server: ${err.message}`);
      try {
        await pool.end();
      } catch (e) {
        console.error(`shipping: closing the database pool: ${(e as Error).message}`);
        process.exit(1);
      }
      process.exit(err ? 1 : 0);
    });
  });
}

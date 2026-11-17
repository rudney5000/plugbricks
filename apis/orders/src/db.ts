import pg from "pg";

/**
 * Schema changes, applied in order, each once. Never edit or reorder an entry that was released:
 * append a new one. The database and its owner role are created by the postgres brick's provision
 * task; this service only manages its own tables.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE orders (
     id bigserial PRIMARY KEY,
     total numeric(12, 2) NOT NULL CHECK (total >= 0),
     status text NOT NULL DEFAULT 'pending',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** Any constant: identifies this service's migration lock among the advisory locks of the database. */
const MIGRATION_LOCK = 7_340_001;

/**
 * Applies the missing migrations in one transaction. An advisory lock makes concurrent starts
 * (two replicas, a restart during a rollout) wait for each other instead of racing.
 */
export async function migrate(pool: pg.Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: number[] = [];
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (done.has(version)) continue;
      await client.query(MIGRATIONS[i]);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      applied.push(version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface OrderRow {
  id: string;
  total: number;
  status: string;
}

const COLUMNS = "id::text AS id, total::float8 AS total, status";

/** Newest first, at most `limit` rows (the caller bounds it). */
export async function listOrders(pool: pg.Pool, limit: number): Promise<OrderRow[]> {
  return (await pool.query<OrderRow>(`SELECT ${COLUMNS} FROM orders ORDER BY id DESC LIMIT $1`, [limit])).rows;
}

const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** null for an id that does not exist, or that is not a canonical positive bigint (no sign, no leading zero). */
export async function findOrder(pool: pg.Pool, id: string): Promise<OrderRow | null> {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > MAX_BIGINT) return null;
  return (await pool.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function createOrder(pool: pg.Pool, total: number): Promise<OrderRow> {
  return (await pool.query<OrderRow>(`INSERT INTO orders (total) VALUES ($1) RETURNING ${COLUMNS}`, [total])).rows[0];
}

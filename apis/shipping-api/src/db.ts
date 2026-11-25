import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Schema changes, applied in order, each once. Never edit or reorder an entry that was released:
 * append a new one. The database and its owner role are created by the postgres brick's provision
 * task; this service only manages its own tables. It has no orders table: orders live in the
 * database of the orders brick, which this service cannot even connect to.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE shipments (
     order_id bigint PRIMARY KEY CHECK (order_id > 0),
     carrier text NOT NULL CHECK (char_length(carrier) BETWEEN 1 AND 40),
     tracking_number text NOT NULL,
     status text NOT NULL DEFAULT 'SHIPPED' CHECK (status IN ('PENDING', 'SHIPPED', 'DELIVERED')),
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** Any constant: identifies this service's migration lock among the advisory locks of the database. */
const MIGRATION_LOCK = 7_340_002;

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

export interface ShipmentRow {
  carrier: string;
  trackingNumber: string;
  status: "PENDING" | "SHIPPED" | "DELIVERED";
}

const COLUMNS = 'carrier, tracking_number AS "trackingNumber", status';
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/** An order id as the orders API writes it: a canonical positive bigint (no sign, no leading zero). */
export function isOrderId(id: string): boolean {
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= MAX_BIGINT;
}

/** null for an order that was not shipped, and for an id that cannot be an order id. */
export async function findShipment(pool: pg.Pool, orderId: string): Promise<ShipmentRow | null> {
  if (!isOrderId(orderId)) return null;
  return (await pool.query<ShipmentRow>(`SELECT ${COLUMNS} FROM shipments WHERE order_id = $1`, [orderId])).rows[0] ?? null;
}

/** Ships an order: status SHIPPED and a generated tracking number. null when the order already has a shipment. */
export async function createShipment(pool: pg.Pool, orderId: string, carrier: string): Promise<ShipmentRow | null> {
  const tracking = `TRK-${randomBytes(5).toString("hex").toUpperCase()}`;
  const result = await pool.query<ShipmentRow>(
    `INSERT INTO shipments (order_id, carrier, tracking_number) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING RETURNING ${COLUMNS}`,
    [orderId, carrier, tracking],
  );
  return result.rows[0] ?? null;
}

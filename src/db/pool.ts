import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/**
 * PostgreSQL pool + drizzle client. This module is the only place that knows
 * how to reach the database; repositories receive the client.
 */

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  pool: Pool;
  db: Database;
  /** Round-trip used by `/readyz`. */
  ping: () => Promise<void>;
  close: () => Promise<void>;
};

export function createDatabase(connectionString: string, options?: { max?: number }): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: options?.max ?? 10,
    application_name: 'identity_service',
  });

  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    ping: async () => {
      await db.execute(sql`SELECT 1`);
    },
    close: async () => {
      await pool.end();
    },
  };
}

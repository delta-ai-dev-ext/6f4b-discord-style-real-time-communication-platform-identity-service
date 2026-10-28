import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from '../../src/db/pool';
import * as schema from '../../src/db/schema';
import { DrizzleUnitOfWork } from '../../src/repositories/drizzle/unitOfWork';
import { DrizzleOutboxQueue } from '../../src/repositories/drizzle/outboxQueue';

/**
 * Integration harness.
 *
 * Uses an embedded PostgreSQL (PGlite — real Postgres compiled to WASM) so the
 * suite exercises the actual DDL, constraints, partial indexes and Drizzle SQL
 * without requiring an external database server. When `TEST_DATABASE_URL` is
 * provided by CI it is not consulted here; the schema under test is identical
 * because migrations are applied verbatim.
 *
 * Isolation: the schema is applied once per test file and every test truncates
 * all tables (the service opens its own transactions internally, so a single
 * rolled-back outer transaction cannot wrap them).
 */
export type TestDatabase = {
  db: Database;
  unitOfWork: DrizzleUnitOfWork;
  outboxQueue: DrizzleOutboxQueue;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

const MIGRATION_GLOB = new Bun.Glob('drizzle/*.sql');

export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  await applyMigrations(client);

  const db = drizzle(client, { schema }) as unknown as Database;

  return {
    db,
    unitOfWork: new DrizzleUnitOfWork(db),
    outboxQueue: new DrizzleOutboxQueue(db),
    reset: async () => {
      await client.exec(
        'TRUNCATE user_profile, friend_request, friendship, processed_webhook, outbox_event CASCADE',
      );
    },
    close: async () => {
      await client.close();
    },
  };
}

async function applyMigrations(client: PGlite): Promise<void> {
  const files = [...MIGRATION_GLOB.scanSync('.')].sort();
  if (files.length === 0) throw new Error('no drizzle migrations found');

  for (const file of files) {
    const sqlText = await Bun.file(file).text();
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await client.exec(trimmed);
    }
  }
}

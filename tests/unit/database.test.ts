import { afterEach, describe, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/pool';

/**
 * `createDatabase` is the only place that builds the pg pool. The connection
 * itself is exercised by the integration suite through PGlite; here we only
 * assert the handle wiring and that unreachable databases surface as errors
 * (which is what `/readyz` turns into a 503).
 */
describe('database handle', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  test('builds a pool, exposes a drizzle client and closes cleanly', async () => {
    const handle = createDatabase('postgresql://user:pass@127.0.0.1:1/identity_service', {
      max: 1,
    });
    cleanup = handle.close;

    expect(typeof handle.db.select).toBe('function');
    expect(typeof handle.ping).toBe('function');
    expect(typeof handle.pool.end).toBe('function');
    await handle.close();
    cleanup = undefined;
  });

  test('ping rejects when the database is unreachable', async () => {
    const handle = createDatabase('postgresql://user:pass@127.0.0.1:1/identity_service', {
      max: 1,
    });
    cleanup = handle.close;

    await expect(handle.ping()).rejects.toBeDefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { OutboxWorker } from '../../src/events/outboxWorker';
import { buildEnvelope } from '../../src/services/eventMapper';
import { silentLogger } from '../../src/observability/logger';
import { FRIEND_EVENTS_TOPIC } from '../../src/observability/metrics';
import type { OutboxMetrics } from '../../src/repositories/ports';
import { createTestDatabase, type TestDatabase } from './harness';
import { FakeEventPublisher } from '../mocks/inMemoryRepositories';
import { TRACEPARENT, USER_IDS } from '../mocks/fixtures';

let testDb: TestDatabase;

class RecordingMetrics implements OutboxMetrics {
  produceErrors: string[] = [];
  deadLettered: string[] = [];
  pending: number[] = [];

  recordProduceError(topic: string): void {
    this.produceErrors.push(topic);
  }

  setOutboxPending(_topic: string, count: number): void {
    this.pending.push(count);
  }

  recordDeadLettered(topic: string): void {
    this.deadLettered.push(topic);
  }
}

async function enqueue(eventId: string, attempts = 0): Promise<void> {
  await testDb.unitOfWork.run(async (tx) => {
    await tx.outbox.enqueue({
      eventId,
      topic: FRIEND_EVENTS_TOPIC,
      partitionKey: USER_IDS.bob,
      eventType: 'friend_request_sent',
      payload: { request_id: `req-${eventId.slice(-1)}` },
      headers: { trace_parent: TRACEPARENT },
    });
  });

  if (attempts > 0) {
    await testDb.db.execute(
      sql`update outbox_event set attempts = ${attempts} where event_id = ${eventId}`,
    );
  }
}

function makeWorker(maxAttempts: number) {
  const publisher = new FakeEventPublisher();
  const metrics = new RecordingMetrics();
  const worker = new OutboxWorker({
    queue: testDb.outboxQueue,
    publisher,
    metrics,
    logger: silentLogger,
    batchSize: 5,
    pollIntervalMs: 10,
    maxAttempts,
  });
  return { publisher, metrics, worker };
}

async function rows() {
  const result = await testDb.db.execute<{
    event_id: string;
    attempts: number;
    published_at: string | Date | null;
    last_error: string | null;
    payload: Record<string, unknown>;
    headers: Record<string, unknown>;
  }>(sql`select event_id, attempts, published_at, last_error, payload, headers from outbox_event order by created_at`);
  return result.rows;
}

/** Deterministic, valid uuid for outbox fixtures. */
function outboxId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  await testDb.unitOfWork.run(async (tx) => {
    for (const [userId, username] of [
      [USER_IDS.alice, 'alice'],
      [USER_IDS.bob, 'bob'],
    ] as const) {
      await tx.userProfiles.upsertFromWebhook({
        userId,
        username,
        displayName: username,
        avatarUrl: '',
        email: `${username}@example.com`,
      });
    }
  });
});

afterAll(async () => {
  await testDb.close();
});

describe('outbox drain against PostgreSQL', () => {
  test('marks rows published only after the broker acknowledged them', async () => {
    await enqueue(outboxId(1));
    const { publisher, metrics, worker } = makeWorker(3);
    await publisher.connect();

    const result = await worker.drainOnce();

    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    const [row] = await rows();
    expect(row?.published_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeNull();
    expect(publisher.published).toHaveLength(1);

    // The envelope is composed from the row so consumers get the platform contract.
    const envelope = buildEnvelope({
      eventId: row?.event_id as string,
      eventType: 'friend_request_sent',
      payload: row?.payload as Record<string, never>,
      headers: row?.headers as Record<string, never>,
      createdAt: new Date(),
    });
    expect(envelope.trace_parent).toBe(TRACEPARENT);
    expect(envelope.producer).toBe('identity_service');

    expect(metrics.pending.at(-1)).toBe(0);
  });

  test('retries a failed publish and keeps the row pending with last_error', async () => {
    await enqueue(outboxId(2));
    const { publisher, metrics, worker } = makeWorker(3);
    await publisher.connect();
    publisher.failNext(1);

    const failed = await worker.drainOnce();
    expect(failed.retried).toBe(1);
    expect(metrics.produceErrors).toEqual([FRIEND_EVENTS_TOPIC]);

    const [afterFailure] = await rows();
    expect(afterFailure?.published_at).toBeNull();
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.last_error).toContain('kafka unavailable');
    expect(metrics.pending.at(-1)).toBe(1);

    const retried = await worker.drainOnce();
    expect(retried.published).toBe(1);
    const [afterSuccess] = await rows();
    expect(afterSuccess?.published_at).not.toBeNull();
    expect(afterSuccess?.attempts).toBe(2);
  });

  test('dead-letters events that exhaust the retry budget', async () => {
    await enqueue(outboxId(3), 2);
    const { publisher, metrics, worker } = makeWorker(2);
    await publisher.connect();
    publisher.failNext(1);

    const result = await worker.drainOnce();

    expect(result).toEqual({ claimed: 1, published: 0, retried: 0, deadLettered: 1 });
    expect(metrics.deadLettered).toEqual([FRIEND_EVENTS_TOPIC]);

    const [row] = await rows();
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toContain('retry budget exhausted');
    expect(row?.published_at).not.toBeNull();
    expect(publisher.published).toHaveLength(0);
  });

  test('claims at most batchSize rows per drain and counts the remaining backlog', async () => {
    for (let index = 10; index < 17; index += 1) {
      await enqueue(outboxId(index));
    }
    const { publisher, metrics, worker } = makeWorker(3);
    await publisher.connect();

    const first = await worker.drainOnce();
    expect(first.claimed).toBe(5);
    expect(metrics.pending.at(-1)).toBe(2);

    const second = await worker.drainOnce();
    expect(second.claimed).toBe(2);
    expect(metrics.pending.at(-1)).toBe(0);

    const third = await worker.drainOnce();
    expect(third.claimed).toBe(0);
  });

  test('countPending only counts unpublished rows on the topic', async () => {
    await enqueue(outboxId(4));
    expect(await testDb.outboxQueue.countPending(FRIEND_EVENTS_TOPIC)).toBe(1);
    expect(await testDb.outboxQueue.countPending('other_topic')).toBe(0);
  });
});

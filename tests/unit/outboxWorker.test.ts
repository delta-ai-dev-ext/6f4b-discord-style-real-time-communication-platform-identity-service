import { describe, expect, test } from 'bun:test';
import type { OutboxMetrics } from '../../src/repositories/ports';
import type { PendingOutboxEvent } from '../../src/models/domain';
import { OutboxWorker } from '../../src/events/outboxWorker';
import { silentLogger } from '../../src/observability/logger';
import { FRIEND_EVENTS_TOPIC } from '../../src/observability/metrics';
import { FakeEventPublisher, InMemoryOutboxQueue, InMemoryUnitOfWork } from '../mocks/inMemoryRepositories';
import { USER_IDS } from '../mocks/fixtures';

class RecordingMetrics implements OutboxMetrics {
  produceErrors: string[] = [];
  deadLettered: string[] = [];
  pending: Array<{ topic: string; count: number }> = [];

  recordProduceError(topic: string): void {
    this.produceErrors.push(topic);
  }

  setOutboxPending(topic: string, count: number): void {
    this.pending.push({ topic, count });
  }

  recordDeadLettered(topic: string): void {
    this.deadLettered.push(topic);
  }
}

async function setup(options: { maxAttempts?: number } = {}) {
  const unitOfWork = new InMemoryUnitOfWork();
  const queue = new InMemoryOutboxQueue(unitOfWork.state);
  const publisher = new FakeEventPublisher();
  const metrics = new RecordingMetrics();
  const worker = new OutboxWorker({
    queue,
    publisher,
    metrics,
    logger: silentLogger,
    batchSize: 10,
    pollIntervalMs: 10,
    maxAttempts: options.maxAttempts ?? 3,
  });
  // `drainOnce` assumes a connected producer (as after `start()`).
  await publisher.connect();
  return { unitOfWork, queue, publisher, metrics, worker };
}

function pendingEvent(eventId: string, attempts = 0): PendingOutboxEvent {
  return {
    eventId,
    topic: FRIEND_EVENTS_TOPIC,
    partitionKey: USER_IDS.bob,
    eventType: 'friend_request_sent',
    payload: { request_id: 'req-1' },
    headers: { trace_parent: null },
    attempts,
    createdAt: new Date('2025-01-15T12:00:00.000Z'),
  };
}

describe('OutboxWorker', () => {
  test('publishes pending rows and updates the backlog gauge', async () => {
    const { unitOfWork, publisher, metrics, worker } = await setup();
    unitOfWork.state.outbox.push(pendingEvent('event-1'), pendingEvent('event-2'));

    const result = await worker.drainOnce();

    expect(result).toEqual({ claimed: 2, published: 2, retried: 0, deadLettered: 0 });
    expect(publisher.published.map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
    expect(unitOfWork.state.outbox).toHaveLength(0);
    expect(metrics.pending).toEqual([{ topic: FRIEND_EVENTS_TOPIC, count: 0 }]);
  });

  test('retries failed publishes, counting the producer error', async () => {
    const { unitOfWork, publisher, metrics, worker } = await setup();
    unitOfWork.state.outbox.push(pendingEvent('event-1'));
    publisher.failNext(1);

    const first = await worker.drainOnce();
    expect(first).toEqual({ claimed: 1, published: 0, retried: 1, deadLettered: 0 });
    expect(metrics.produceErrors).toEqual([FRIEND_EVENTS_TOPIC]);
    expect(unitOfWork.state.outbox[0]?.attempts).toBe(1);

    const second = await worker.drainOnce();
    expect(second.published).toBe(1);
    expect(unitOfWork.state.outbox).toHaveLength(0);
  });

  test('dead-letters rows that exceed the retry budget', async () => {
    const { unitOfWork, publisher, metrics, worker } = await setup({ maxAttempts: 2 });
    unitOfWork.state.outbox.push(pendingEvent('event-1', 2));
    publisher.failNext(5);

    const result = await worker.drainOnce();

    expect(result).toEqual({ claimed: 1, published: 0, retried: 0, deadLettered: 1 });
    expect(metrics.deadLettered).toEqual([FRIEND_EVENTS_TOPIC]);
    expect(unitOfWork.state.outbox).toHaveLength(0);
  });

  test('publisher exceptions are converted into retries, never crashes', async () => {
    const { unitOfWork, metrics, worker, publisher } = await setup();
    unitOfWork.state.outbox.push(pendingEvent('event-1'));
    publisher.failNext(1);

    const result = await worker.drainOnce();

    expect(result.retried).toBe(1);
    expect(metrics.produceErrors).toEqual([FRIEND_EVENTS_TOPIC]);
  });

  test('start connects the producer, polls, and stop drains gracefully', async () => {
    const { unitOfWork, publisher, worker } = await setup();
    expect(worker.getState()).toBe('idle');

    unitOfWork.state.outbox.push(pendingEvent('event-1'));
    await worker.start();
    expect(worker.getState()).toBe('running');
    expect(publisher.connectCalls).toBe(2);

    // Wait for the polling loop to pick the row up.
    for (let attempt = 0; attempt < 40 && publisher.published.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await worker.stop();
    expect(worker.getState()).toBe('stopped');
    expect(publisher.published).toHaveLength(1);
  });

  test('starting an already running worker is a no-op and stopping twice is safe', async () => {
    const { publisher, worker } = await setup();
    const before = publisher.connectCalls;
    await worker.start();
    await worker.start();
    expect(publisher.connectCalls).toBe(before + 1);

    await worker.stop();
    await worker.stop();
    expect(worker.getState()).toBe('stopped');
  });
});

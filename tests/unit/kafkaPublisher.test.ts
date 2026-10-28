import { describe, expect, test } from 'bun:test';
import type { Producer } from 'kafkajs';
import { KafkaEventPublisher } from '../../src/events/kafkaPublisher';
import { silentLogger } from '../../src/observability/logger';
import type { PendingOutboxEvent } from '../../src/models/domain';
import { TRACEPARENT, USER_IDS } from '../mocks/fixtures';

type SentMessage = {
  topic: string;
  messages: Array<{ key?: string; value?: string; headers?: Record<string, string> }>;
};

function fakeProducer(options: { failConnect?: boolean } = {}) {
  const sent: SentMessage[] = [];
  let connected = false;
  const producer = {
    connect: async () => {
      if (options.failConnect === true) throw new Error('broker unreachable');
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
    send: async (message: SentMessage) => {
      sent.push(message);
      return [];
    },
  };
  return { producer: producer as unknown as Producer, sent, isConnected: () => connected };
}

const event: PendingOutboxEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  topic: 'identity_friend_events',
  partitionKey: USER_IDS.bob,
  eventType: 'friend_request_sent',
  payload: { request_id: 'req-1' },
  headers: { trace_parent: TRACEPARENT },
  attempts: 0,
  createdAt: new Date('2025-01-15T12:00:00.000Z'),
};

function publisher(fake: ReturnType<typeof fakeProducer>): KafkaEventPublisher {
  return new KafkaEventPublisher({
    brokers: ['localhost:9092'],
    clientId: 'identity_service',
    ssl: false,
    logger: silentLogger,
    createProducer: () => fake.producer,
  });
}

describe('KafkaEventPublisher', () => {
  test('publishes the platform envelope keyed by recipient_user_id', async () => {
    const fake = fakeProducer();
    const kafka = publisher(fake);
    await kafka.connect();

    expect(kafka.isConnected()).toBe(true);
    await kafka.publish(event);

    const message = fake.sent[0];
    expect(message?.topic).toBe('identity_friend_events');
    expect(message?.messages[0]?.key).toBe(USER_IDS.bob);
    expect(message?.messages[0]?.headers).toEqual({ traceparent: TRACEPARENT });

    const envelope = JSON.parse(message?.messages[0]?.value ?? '{}') as Record<string, unknown>;
    expect(envelope).toEqual({
      event_id: event.eventId,
      event_type: 'friend_request_sent',
      occurred_at: '2025-01-15T12:00:00.000Z',
      producer: 'identity_service',
      version: 1,
      trace_parent: TRACEPARENT,
      data: { request_id: 'req-1' },
    });
  });

  test('refuses to publish before connecting', async () => {
    const fake = fakeProducer();
    const kafka = publisher(fake);

    await expect(kafka.publish(event)).rejects.toThrow('not connected');
    expect(fake.sent).toHaveLength(0);
  });

  test('connect is idempotent and surfaces broker failures', async () => {
    const fake = fakeProducer();
    const kafka = publisher(fake);
    await kafka.connect();
    await kafka.connect();
    expect(kafka.isConnected()).toBe(true);

    const failing = publisher(fakeProducer({ failConnect: true }));
    await expect(failing.connect()).rejects.toThrow('broker unreachable');
    expect(failing.isConnected()).toBe(false);
  });

  test('disconnect closes the producer and is safe to repeat', async () => {
    const fake = fakeProducer();
    const kafka = publisher(fake);
    await kafka.connect();
    await kafka.disconnect();
    expect(kafka.isConnected()).toBe(false);
    await kafka.disconnect();
  });

  test('omits the trace header when the envelope has no trace parent', async () => {
    const fake = fakeProducer();
    const kafka = publisher(fake);
    await kafka.connect();
    await kafka.publish({ ...event, headers: { trace_parent: null } });

    expect(fake.sent[0]?.messages[0]?.headers).toEqual({});
  });
});

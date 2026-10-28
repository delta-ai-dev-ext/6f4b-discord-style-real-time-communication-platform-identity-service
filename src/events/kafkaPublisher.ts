import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { PendingOutboxEvent } from '../models/domain';
import type { EventPublisher } from '../repositories/ports';
import type { LoggerPort } from '../observability/logger';
import { FRIEND_EVENTS_TOPIC } from '../observability/metrics';
import { buildEnvelope, TRACE_PARENT_HEADER } from '../services/eventMapper';

export type KafkaPublisherOptions = {
  brokers: string[];
  clientId: string;
  ssl: boolean;
  logger: LoggerPort;
  topic?: string;
  /** Test seam: build a producer for the given client. */
  createProducer?: (kafka: Kafka) => Producer;
};

/**
 * Kafka producer (only publisher in the service). Idempotence is enabled and
 * in-flight requests are capped at 1 so broker-side retries cannot reorder a
 * partition. Publishing only ever happens from the outbox worker.
 */
export class KafkaEventPublisher implements EventPublisher {
  readonly topic: string;

  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly logger: LoggerPort;
  private connected = false;
  private connecting: Promise<void> | undefined;

  constructor(options: KafkaPublisherOptions) {
    this.topic = options.topic ?? FRIEND_EVENTS_TOPIC;
    this.logger = options.logger;
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      ssl: options.ssl,
      logLevel: logLevel.NOTHING,
      retry: { initialRetryTime: 100, retries: 5 },
    });
    this.producer =
      options.createProducer?.(this.kafka) ??
      this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
      });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connecting ??= this.producer
      .connect()
      .then(() => {
        this.connected = true;
        this.logger.info('kafka producer connected');
      })
      .catch((error: unknown) => {
        this.logger.error('kafka producer connect failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    await this.connecting;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(event: PendingOutboxEvent): Promise<void> {
    if (!this.connected) {
      throw new Error('kafka producer is not connected');
    }

    const envelope = buildEnvelope({
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      headers: event.headers,
      createdAt: event.createdAt,
    });

    const traceParent = event.headers[TRACE_PARENT_HEADER];
    const headers: Record<string, string> = {};
    if (typeof traceParent === 'string') {
      headers['traceparent'] = traceParent;
    }

    await this.producer.send({
      topic: event.topic,
      messages: [
        {
          key: event.partitionKey,
          value: JSON.stringify(envelope),
          headers,
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect();
    this.connected = false;
    this.logger.info('kafka producer disconnected');
  }
}

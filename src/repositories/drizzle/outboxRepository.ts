import { outboxEvent, processedWebhook } from '../../db/schema';
import type { Database } from '../../db/pool';
import type { JsonObject, OutboxEventInsert } from '../../models/domain';
import type { OutboxRepository, ProcessedWebhookRepository } from '../ports';
import type { DbExecutor } from './userProfileRepository';

/** Drizzle adapter for the `processed_webhook` idempotency ledger. */
export class DrizzleProcessedWebhookRepository implements ProcessedWebhookRepository {
  private readonly exec: DbExecutor;

  constructor(exec: DbExecutor) {
    this.exec = exec;
  }

  private get db(): Database {
    return this.exec as unknown as Database;
  }

  async markProcessed(
    svixMessageId: string,
    eventType: string,
    receivedAt: Date,
  ): Promise<boolean> {
    const inserted = await this.db
      .insert(processedWebhook)
      .values({ svixMessageId, eventType, receivedAt })
      .onConflictDoNothing({ target: processedWebhook.svixMessageId })
      .returning({ svixMessageId: processedWebhook.svixMessageId });
    return inserted.length > 0;
  }
}

/** Drizzle adapter for the transactional outbox writes (ADR-002). */
export class DrizzleOutboxRepository implements OutboxRepository {
  private readonly exec: DbExecutor;

  constructor(exec: DbExecutor) {
    this.exec = exec;
  }

  private get db(): Database {
    return this.exec as unknown as Database;
  }

  async enqueue(event: OutboxEventInsert): Promise<void> {
    await this.db.insert(outboxEvent).values({
      eventId: event.eventId,
      topic: event.topic,
      partitionKey: event.partitionKey,
      eventType: event.eventType,
      payload: event.payload as JsonObject,
      headers: event.headers as JsonObject,
    });
  }
}

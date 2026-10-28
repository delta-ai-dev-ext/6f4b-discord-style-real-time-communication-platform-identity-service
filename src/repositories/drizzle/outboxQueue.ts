import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/pool';
import { outboxEvent } from '../../db/schema';
import type { PendingOutboxEvent } from '../../models/domain';
import type { OutboxDisposition, OutboxProcessResult, OutboxQueue } from '../ports';
import { toPendingOutboxEvent } from './rows';

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Outbox drain adapter.
 *
 * A single transaction claims the next pending rows with
 * `SELECT … FOR UPDATE SKIP LOCKED`, publishes them, and records the outcome
 * while the row locks are held. Multiple replicas can therefore drain the same
 * outbox concurrently without double-publishing a row.
 */
export class DrizzleOutboxQueue implements OutboxQueue {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async claimAndProcess(
    batchSize: number,
    handler: (event: PendingOutboxEvent) => Promise<OutboxDisposition>,
  ): Promise<OutboxProcessResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvent)
        .where(isNull(outboxEvent.publishedAt))
        .orderBy(asc(outboxEvent.createdAt), asc(outboxEvent.eventId))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      const result: OutboxProcessResult = {
        claimed: rows.length,
        published: 0,
        retried: 0,
        deadLettered: 0,
      };

      for (const row of rows) {
        const event = toPendingOutboxEvent(row);
        let disposition: OutboxDisposition;
        try {
          disposition = await handler(event);
        } catch (error) {
          disposition = { kind: 'retry', error: describeError(error) };
        }

        if (disposition.kind === 'published') {
          await tx
            .update(outboxEvent)
            .set({
              publishedAt: new Date(),
              attempts: sql`${outboxEvent.attempts} + 1`,
              lastError: null,
            })
            .where(eq(outboxEvent.eventId, event.eventId));
          result.published += 1;
          continue;
        }

        // Dead-lettered rows also leave the pending set (published_at is set)
        // so a permanently failing event cannot spin the worker forever; the
        // `last_error` column keeps the failure reason and the counter surfaces
        // the alert.
        await tx
          .update(outboxEvent)
          .set({
            attempts: sql`${outboxEvent.attempts} + 1`,
            lastError: disposition.error,
            ...(disposition.kind === 'dead_letter' ? { publishedAt: new Date() } : {}),
          })
          .where(eq(outboxEvent.eventId, event.eventId));

        if (disposition.kind === 'dead_letter') {
          result.deadLettered += 1;
        } else {
          result.retried += 1;
        }
      }

      return result;
    });
  }

  async countPending(topic: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxEvent)
      .where(and(isNull(outboxEvent.publishedAt), eq(outboxEvent.topic, topic)));
    return rows[0]?.count ?? 0;
  }
}

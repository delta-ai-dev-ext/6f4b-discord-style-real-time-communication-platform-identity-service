import type { LoggerPort } from '../observability/logger';
import type { ClockPort, IdGeneratorPort, ServiceMetrics, UnitOfWork } from '../repositories/ports';
import {
  buildFriendRequestStatusChangedData,
  buildOutboxEvent,
} from '../services/eventMapper';
import type { ClerkEvent } from './clerkEventMapper';
import { toProfileFromClerkUser, toProfilePatchFromClerkUser } from './clerkEventMapper';

export type WebhookDeps = {
  unitOfWork: UnitOfWork;
  metrics: ServiceMetrics;
  clock: ClockPort;
  ids: IdGeneratorPort;
  logger: LoggerPort;
};

export type HandleWebhookInput = {
  svixMessageId: string;
  event: ClerkEvent;
  traceParent?: string | null;
};

export type HandleWebhookResult = { processed: boolean; replay: boolean };

/**
 * Clerk webhook sync (architecture §3.4).
 *
 * Idempotent by Svix message id: the ledger row and the profile change commit
 * in one transaction, so a replay is a 200 no-op. `user.deleted` soft-deletes
 * the profile and cancels every pending request touching that user, emitting
 * `friend_request_cancelled` rows in the same transaction.
 */
export class ClerkWebhookService {
  private readonly deps: WebhookDeps;

  constructor(deps: WebhookDeps) {
    this.deps = deps;
  }

  async handle(input: HandleWebhookInput): Promise<HandleWebhookResult> {
    const { unitOfWork, metrics, clock, ids, logger } = this.deps;

    return unitOfWork.run(async (tx) => {
      const now = clock.now();
      const isNew = await tx.processedWebhooks.markProcessed(
        input.svixMessageId,
        input.event.type,
        now,
      );

      if (!isNew) {
        logger.info('clerk webhook replay ignored', {
          trace_id: input.traceParent ?? undefined,
          event_type: input.event.type,
        });
        return { processed: false, replay: true };
      }

      switch (input.event.type) {
        case 'user.created': {
          await tx.userProfiles.upsertFromWebhook(toProfileFromClerkUser(input.event.data));
          metrics.recordUserSynced('created');
          break;
        }
        case 'user.updated': {
          const updated = await tx.userProfiles.updateFromWebhook(
            input.event.data.id,
            toProfilePatchFromClerkUser(input.event.data),
          );
          if (updated === undefined) {
            // Missed `user.created`: heal the mirror from this payload.
            await tx.userProfiles.upsertFromWebhook(toProfileFromClerkUser(input.event.data));
            metrics.recordUserSynced('created');
          } else {
            metrics.recordUserSynced('updated');
          }
          break;
        }
        case 'user.deleted': {
          const softDeleted = await tx.userProfiles.softDelete(input.event.data.id, now);
          if (softDeleted) {
            metrics.recordUserSynced('deleted');
          }

          const cancelled = await tx.friendRequests.cancelPendingForUser(input.event.data.id, now);
          for (const request of cancelled) {
            await tx.outbox.enqueue(
              buildOutboxEvent({
                eventId: ids.newId(),
                eventType: 'friend_request_cancelled',
                partitionKey: request.recipientUserId,
                data: buildFriendRequestStatusChangedData(request),
                traceParent: input.traceParent ?? null,
                occurredAt: now,
              }),
            );
            metrics.recordFriendRequest('cancelled');
          }
          break;
        }
        default:
          // Unknown but validly signed event types are acknowledged and ignored.
          logger.warn('clerk webhook event type ignored', {
            trace_id: input.traceParent ?? undefined,
            event_type: input.event.type,
          });
          break;
      }

      return { processed: true, replay: false };
    });
  }
}

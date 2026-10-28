import { isUniqueViolation } from '../db/errors';
import type {
  FriendRequestRecord,
  FriendshipRecord,
  Page,
  UserProfileRecord,
} from '../models/domain';
import { errors } from '../models/errors';
import type { ClockPort, IdGeneratorPort, ServiceMetrics, UnitOfWork } from '../repositories/ports';
import { ensureCallerProfile } from './callerProfile';
import {
  buildFriendRequestSentData,
  buildFriendRequestStatusChangedData,
  buildFriendshipRemovedData,
  buildOutboxEvent,
} from './eventMapper';
import { requireRecipientPending, requireSenderPending } from './friendStateMachine';
import type { AuthClaims } from './profileService';

export type FriendServiceDeps = {
  unitOfWork: UnitOfWork;
  metrics: ServiceMetrics;
  clock: ClockPort;
  ids: IdGeneratorPort;
};

export type ListFriendRequestsQuery = {
  direction: 'incoming' | 'outgoing';
  status: FriendRequestRecord['status'];
  cursor?: string;
  limit: number;
};

export type ListFriendsQuery = {
  cursor?: string;
  limit: number;
};

/** W3C trace context of the request that triggered the state change. */
export type TraceInput = { traceParent?: string | null };

/**
 * Friend domain use cases. Every state change writes its outbox event in the
 * same transaction (ADR-002); nothing is published inline.
 */
export class FriendService {
  private readonly unitOfWork: UnitOfWork;
  private readonly metrics: ServiceMetrics;
  private readonly clock: ClockPort;
  private readonly ids: IdGeneratorPort;

  constructor(deps: FriendServiceDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.metrics = deps.metrics;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  async sendFriendRequest(
    claims: AuthClaims,
    username: string,
    trace: TraceInput = {},
  ): Promise<FriendRequestRecord> {
    return this.unitOfWork.run(async (tx) => {
      const sender = await ensureCallerProfile(tx, claims, this.metrics);
      const recipient = await tx.userProfiles.findActiveByUsername(username.toLowerCase());

      if (recipient === undefined) {
        throw errors.usernameNotFound();
      }
      if (recipient.userId === sender.userId) {
        throw errors.selfRequest();
      }
      if ((await tx.friendships.findPair(sender.userId, recipient.userId)) !== undefined) {
        throw errors.alreadyFriends();
      }
      if ((await tx.friendRequests.findPendingBetween(sender.userId, recipient.userId)) !== undefined) {
        throw errors.duplicateRequest();
      }

      const now = this.clock.now();
      const request: FriendRequestRecord = {
        requestId: this.ids.newId(),
        senderUserId: sender.userId,
        recipientUserId: recipient.userId,
        status: 'pending',
        createdAt: now,
        respondedAt: null,
      };

      try {
        await tx.friendRequests.insertPending(request);
      } catch (error) {
        // The partial unique pending-pair index backstops concurrent duplicates.
        if (isUniqueViolation(error)) throw errors.duplicateRequest();
        throw error;
      }

      await tx.outbox.enqueue(
        buildOutboxEvent({
          eventId: this.ids.newId(),
          eventType: 'friend_request_sent',
          partitionKey: recipient.userId,
          data: buildFriendRequestSentData(request, sender, recipient),
          traceParent: trace.traceParent ?? null,
          occurredAt: now,
        }),
      );

      this.metrics.recordFriendRequest('sent');
      return request;
    });
  }

  /** Recipient-only: pending → accepted plus the friendship row, atomically. */
  async acceptFriendRequest(
    claims: AuthClaims,
    requestId: string,
    trace: TraceInput = {},
  ): Promise<FriendshipRecord> {
    return this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      requireRecipientPending(await tx.friendRequests.findById(requestId), claims.userId);

      const now = this.clock.now();
      const transitioned = await tx.friendRequests.transition(
        requestId,
        'pending',
        'accepted',
        now,
      );
      if (transitioned === undefined) throw errors.requestNotPending();

      const friendship = await tx.friendships.insertPair(
        transitioned.senderUserId,
        transitioned.recipientUserId,
        now,
      );

      await tx.outbox.enqueue(
        buildOutboxEvent({
          eventId: this.ids.newId(),
          eventType: 'friend_request_accepted',
          partitionKey: transitioned.recipientUserId,
          data: buildFriendRequestStatusChangedData(transitioned),
          traceParent: trace.traceParent ?? null,
          occurredAt: now,
        }),
      );

      this.metrics.recordFriendRequest('accepted');
      return friendship;
    });
  }

  /** Recipient-only: pending → declined. */
  async declineFriendRequest(
    claims: AuthClaims,
    requestId: string,
    trace: TraceInput = {},
  ): Promise<FriendRequestRecord> {
    return this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      requireRecipientPending(await tx.friendRequests.findById(requestId), claims.userId);

      const now = this.clock.now();
      const transitioned = await tx.friendRequests.transition(
        requestId,
        'pending',
        'declined',
        now,
      );
      if (transitioned === undefined) throw errors.requestNotPending();

      await tx.outbox.enqueue(
        buildOutboxEvent({
          eventId: this.ids.newId(),
          eventType: 'friend_request_declined',
          partitionKey: transitioned.recipientUserId,
          data: buildFriendRequestStatusChangedData(transitioned),
          traceParent: trace.traceParent ?? null,
          occurredAt: now,
        }),
      );

      this.metrics.recordFriendRequest('declined');
      return transitioned;
    });
  }

  /** Sender-only: pending → cancelled. */
  async cancelFriendRequest(
    claims: AuthClaims,
    requestId: string,
    trace: TraceInput = {},
  ): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      requireSenderPending(await tx.friendRequests.findById(requestId), claims.userId);

      const now = this.clock.now();
      const transitioned = await tx.friendRequests.transition(
        requestId,
        'pending',
        'cancelled',
        now,
      );
      if (transitioned === undefined) throw errors.requestNotPending();

      await tx.outbox.enqueue(
        buildOutboxEvent({
          eventId: this.ids.newId(),
          eventType: 'friend_request_cancelled',
          partitionKey: transitioned.recipientUserId,
          data: buildFriendRequestStatusChangedData(transitioned),
          traceParent: trace.traceParent ?? null,
          occurredAt: now,
        }),
      );

      this.metrics.recordFriendRequest('cancelled');
    });
  }

  async listFriendRequests(
    claims: AuthClaims,
    query: ListFriendRequestsQuery,
  ): Promise<Page<FriendRequestRecord>> {
    return this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      return tx.friendRequests.list({
        userId: claims.userId,
        direction: query.direction,
        status: query.status,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    });
  }

  async listFriends(claims: AuthClaims, query: ListFriendsQuery): Promise<Page<UserProfileRecord>> {
    return this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      const page = await tx.friendships.listForUser(claims.userId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });

      const profiles = await tx.userProfiles.findActiveByIds(page.rows);
      const byId = new Map(profiles.map((profile) => [profile.userId, profile]));
      const rows = page.rows
        .map((userId) => byId.get(userId))
        .filter((profile): profile is UserProfileRecord => profile !== undefined);

      return { rows, nextCursor: page.nextCursor };
    });
  }

  /** Removes the mutual friendship and emits `friendship_removed` atomically. */
  async removeFriend(
    claims: AuthClaims,
    friendUserId: string,
    trace: TraceInput = {},
  ): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      await ensureCallerProfile(tx, claims, this.metrics);
      const pair = await tx.friendships.findPair(claims.userId, friendUserId);
      if (pair === undefined) throw errors.friendshipNotFound();

      const deleted = await tx.friendships.deletePair(pair.userIdA, pair.userIdB);
      if (!deleted) throw errors.friendshipNotFound();

      await tx.outbox.enqueue(
        buildOutboxEvent({
          eventId: this.ids.newId(),
          eventType: 'friendship_removed',
          partitionKey: pair.userIdA,
          data: buildFriendshipRemovedData(pair.userIdA, pair.userIdB),
          traceParent: trace.traceParent ?? null,
          occurredAt: this.clock.now(),
        }),
      );
    });
  }
}

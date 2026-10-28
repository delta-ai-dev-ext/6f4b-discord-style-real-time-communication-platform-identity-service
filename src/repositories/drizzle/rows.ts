import type {
  FriendRequestRow,
  FriendshipRow,
  OutboxEventRow,
  UserProfileRow,
} from '../../db/schema';
import type {
  FriendRequestRecord,
  FriendshipRecord,
  JsonObject,
  PendingOutboxEvent,
  UserProfileRecord,
} from '../../models/domain';

export function toUserProfileRecord(row: UserProfileRow): UserProfileRecord {
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    email: row.email,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function toFriendRequestRecord(row: FriendRequestRow): FriendRequestRecord {
  return {
    requestId: row.requestId,
    senderUserId: row.senderUserId,
    recipientUserId: row.recipientUserId,
    status: row.status,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt ?? null,
  };
}

export function toFriendshipRecord(row: FriendshipRow): FriendshipRecord {
  return {
    userIdA: row.userIdA,
    userIdB: row.userIdB,
    createdAt: row.createdAt,
  };
}

export function toPendingOutboxEvent(row: OutboxEventRow): PendingOutboxEvent {
  return {
    eventId: row.eventId,
    topic: row.topic,
    partitionKey: row.partitionKey,
    eventType: row.eventType,
    payload: row.payload as JsonObject,
    headers: row.headers as JsonObject,
    attempts: row.attempts,
    createdAt: row.createdAt,
  };
}

/** Orders an unordered pair for the `friendship` table (`user_id_a < user_id_b`). */
export function orderPair(userIdA: string, userIdB: string): [string, string] {
  return userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
}

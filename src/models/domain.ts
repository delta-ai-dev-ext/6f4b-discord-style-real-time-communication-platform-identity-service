/**
 * Domain records and value types shared by services and repositories.
 * They deliberately carry no HTTP or driver types.
 */

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export const FRIEND_REQUEST_STATUSES: readonly FriendRequestStatus[] = [
  'pending',
  'accepted',
  'declined',
  'cancelled',
];

export type UserProfileRecord = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type NewUserProfileRecord = {
  userId: string;
  /** Already lowercased by the caller. */
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
};

export type UserProfilePatch = {
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
};

export type FriendRequestRecord = {
  requestId: string;
  senderUserId: string;
  recipientUserId: string;
  status: FriendRequestStatus;
  createdAt: Date;
  respondedAt: Date | null;
};

export type FriendshipRecord = {
  userIdA: string;
  userIdB: string;
  createdAt: Date;
};

export type FriendEventType =
  | 'friend_request_sent'
  | 'friend_request_accepted'
  | 'friend_request_declined'
  | 'friend_request_cancelled'
  | 'friendship_removed';

/** Platform envelope (SYSTEM_DESIGN §5) published on `identity_friend_events`. */
export type EventEnvelope<TData> = {
  event_id: string;
  event_type: FriendEventType;
  occurred_at: string;
  producer: 'identity_service';
  version: number;
  trace_parent: string | null;
  data: TData;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type OutboxEventInsert = {
  eventId: string;
  topic: string;
  partitionKey: string;
  eventType: FriendEventType;
  payload: JsonObject;
  headers: JsonObject;
};

export type PendingOutboxEvent = {
  eventId: string;
  topic: string;
  partitionKey: string;
  eventType: string;
  payload: JsonObject;
  headers: JsonObject;
  attempts: number;
  createdAt: Date;
};

/** Cursor page shape used by list endpoints. */
export type Page<T> = {
  rows: T[];
  nextCursor: string | null;
};

import type {
  FriendEventType,
  FriendRequestRecord,
  JsonObject,
  OutboxEventInsert,
  UserProfileRecord,
} from '../models/domain';
import { FRIEND_EVENTS_TOPIC } from '../observability/metrics';

/**
 * Domain state → event payload mapping (pure, no I/O).
 *
 * `outbox_event.payload` holds the envelope `data` field; the remaining
 * envelope members come from the outbox row itself when the worker publishes
 * (event_id, event_type, occurred_at, headers.trace_parent).
 */

export const EVENT_VERSION = 1;
export const EVENT_PRODUCER = 'identity_service' as const;
export const TRACE_PARENT_HEADER = 'trace_parent';

export type FriendRequestSentData = {
  request_id: string;
  sender_user_id: string;
  sender_username: string;
  recipient_user_id: string;
  recipient_username: string;
  recipient_email: string;
};

export type FriendRequestStatusChangedData = {
  request_id: string;
  sender_user_id: string;
  recipient_user_id: string;
};

export type FriendshipRemovedData = {
  user_id_a: string;
  user_id_b: string;
};

export function buildFriendRequestSentData(
  request: FriendRequestRecord,
  sender: UserProfileRecord,
  recipient: UserProfileRecord,
): FriendRequestSentData {
  return {
    request_id: request.requestId,
    sender_user_id: sender.userId,
    sender_username: sender.username,
    recipient_user_id: recipient.userId,
    recipient_username: recipient.username,
    recipient_email: recipient.email,
  };
}

export function buildFriendRequestStatusChangedData(
  request: FriendRequestRecord,
): FriendRequestStatusChangedData {
  return {
    request_id: request.requestId,
    sender_user_id: request.senderUserId,
    recipient_user_id: request.recipientUserId,
  };
}

export function buildFriendshipRemovedData(
  userIdA: string,
  userIdB: string,
): FriendshipRemovedData {
  return { user_id_a: userIdA, user_id_b: userIdB };
}

export type OutboxEventInput = {
  eventId: string;
  eventType: FriendEventType;
  partitionKey: string;
  data: Record<string, unknown>;
  traceParent?: string | null;
  occurredAt?: Date;
};

/**
 * Builds the outbox row for a domain event. The caller supplies it inside the
 * same transaction as the state change (ADR-002).
 */
export function buildOutboxEvent(input: OutboxEventInput): OutboxEventInsert {
  const headers: JsonObject = {
    [TRACE_PARENT_HEADER]: input.traceParent ?? null,
  };
  if (input.occurredAt !== undefined) {
    headers['occurred_at'] = input.occurredAt.toISOString();
  }
  return {
    eventId: input.eventId,
    topic: FRIEND_EVENTS_TOPIC,
    partitionKey: input.partitionKey,
    eventType: input.eventType,
    payload: input.data as JsonObject,
    headers,
  };
}

export type PublishedEnvelope = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  producer: typeof EVENT_PRODUCER;
  version: number;
  trace_parent: string | null;
  data: JsonObject;
};

/** Composes the platform envelope the Kafka producer publishes as the value. */
export function buildEnvelope(event: {
  eventId: string;
  eventType: string;
  payload: JsonObject;
  headers: JsonObject;
  createdAt: Date;
}): PublishedEnvelope {
  const traceParent = event.headers[TRACE_PARENT_HEADER];
  const occurredAt = event.headers['occurred_at'];

  return {
    event_id: event.eventId,
    event_type: event.eventType,
    occurred_at:
      typeof occurredAt === 'string' ? occurredAt : event.createdAt.toISOString(),
    producer: EVENT_PRODUCER,
    version: EVENT_VERSION,
    trace_parent: typeof traceParent === 'string' ? traceParent : null,
    data: event.payload,
  };
}

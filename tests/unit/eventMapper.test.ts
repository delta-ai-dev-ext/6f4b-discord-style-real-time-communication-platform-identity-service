import { describe, expect, test } from 'bun:test';
import {
  buildEnvelope,
  buildFriendRequestSentData,
  buildFriendRequestStatusChangedData,
  buildFriendshipRemovedData,
  buildOutboxEvent,
  EVENT_PRODUCER,
  EVENT_VERSION,
} from '../../src/services/eventMapper';
import type { FriendRequestRecord, UserProfileRecord } from '../../src/models/domain';
import { USER_IDS, TRACEPARENT } from '../mocks/fixtures';

const request: FriendRequestRecord = {
  requestId: '00000000-0000-4000-8000-000000000001',
  senderUserId: USER_IDS.alice,
  recipientUserId: USER_IDS.bob,
  status: 'pending',
  createdAt: new Date('2025-01-15T12:00:00.000Z'),
  respondedAt: null,
};

function profile(userId: string, username: string, email: string): UserProfileRecord {
  return {
    userId,
    username,
    displayName: username,
    avatarUrl: '',
    email,
    createdAt: new Date('2025-01-15T11:00:00.000Z'),
    updatedAt: new Date('2025-01-15T11:00:00.000Z'),
    deletedAt: null,
  };
}

describe('event payload builders', () => {
  test('friend_request_sent carries both profiles and the recipient email', () => {
    const data = buildFriendRequestSentData(
      request,
      profile(USER_IDS.alice, 'alice', 'alice@example.com'),
      profile(USER_IDS.bob, 'bob', 'bob@example.com'),
    );

    expect(data).toEqual({
      request_id: request.requestId,
      sender_user_id: USER_IDS.alice,
      sender_username: 'alice',
      recipient_user_id: USER_IDS.bob,
      recipient_username: 'bob',
      recipient_email: 'bob@example.com',
    });
  });

  test('status change payloads carry only ids', () => {
    expect(buildFriendRequestStatusChangedData(request)).toEqual({
      request_id: request.requestId,
      sender_user_id: USER_IDS.alice,
      recipient_user_id: USER_IDS.bob,
    });
  });

  test('friendship_removed payload identifies the ordered pair', () => {
    expect(buildFriendshipRemovedData(USER_IDS.alice, USER_IDS.bob)).toEqual({
      user_id_a: USER_IDS.alice,
      user_id_b: USER_IDS.bob,
    });
  });
});

describe('outbox event building', () => {
  test('uses the platform topic, partition key and trace header', () => {
    const event = buildOutboxEvent({
      eventId: 'event-1',
      eventType: 'friend_request_accepted',
      partitionKey: USER_IDS.bob,
      data: buildFriendRequestStatusChangedData(request),
      traceParent: TRACEPARENT,
      occurredAt: new Date('2025-01-15T12:00:00.000Z'),
    });

    expect(event.topic).toBe('identity_friend_events');
    expect(event.partitionKey).toBe(USER_IDS.bob);
    expect(event.eventType).toBe('friend_request_accepted');
    expect(event.payload).toEqual(buildFriendRequestStatusChangedData(request));
    expect(event.headers).toEqual({
      trace_parent: TRACEPARENT,
      occurred_at: '2025-01-15T12:00:00.000Z',
    });
  });

  test('records a null trace parent when the request had none', () => {
    const event = buildOutboxEvent({
      eventId: 'event-2',
      eventType: 'friendship_removed',
      partitionKey: USER_IDS.alice,
      data: buildFriendshipRemovedData(USER_IDS.alice, USER_IDS.bob),
    });
    expect(event.headers).toEqual({ trace_parent: null });
  });
});

describe('envelope building', () => {
  test('composes the platform envelope', () => {
    const envelope = buildEnvelope({
      eventId: 'event-1',
      eventType: 'friend_request_sent',
      payload: { request_id: request.requestId },
      headers: { trace_parent: TRACEPARENT, occurred_at: '2025-01-15T12:00:00.000Z' },
      createdAt: new Date('2025-01-15T12:00:01.000Z'),
    });

    expect(envelope).toEqual({
      event_id: 'event-1',
      event_type: 'friend_request_sent',
      occurred_at: '2025-01-15T12:00:00.000Z',
      producer: EVENT_PRODUCER,
      version: EVENT_VERSION,
      trace_parent: TRACEPARENT,
      data: { request_id: request.requestId },
    });
  });

  test('falls back to created_at and a null trace parent', () => {
    const envelope = buildEnvelope({
      eventId: 'event-2',
      eventType: 'friend_request_declined',
      payload: {},
      headers: {},
      createdAt: new Date('2025-01-15T12:00:01.000Z'),
    });
    expect(envelope.occurred_at).toBe('2025-01-15T12:00:01.000Z');
    expect(envelope.trace_parent).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { Metrics } from '../../src/observability/metrics';
import type { FriendRequestRecord } from '../../src/models/domain';
import { DomainError, type ErrorCode } from '../../src/models/errors';
import type { TransactionContext, UnitOfWork } from '../../src/repositories/ports';
import { FriendService } from '../../src/services/friendService';
import type { AuthClaims } from '../../src/services/profileService';
import { InMemoryUnitOfWork } from '../mocks/inMemoryRepositories';
import { FakeClock, FakeIdGenerator, TRACEPARENT, USER_IDS } from '../mocks/fixtures';

function claims(userId: string, username: string): AuthClaims {
  return { userId, username, displayName: username, email: `${username}@example.com` };
}

const alice = claims(USER_IDS.alice, 'alice');
const bob = claims(USER_IDS.bob, 'bob');
const carol = claims(USER_IDS.carol, 'carol');

async function setup(options: { wrap?: (tx: TransactionContext) => TransactionContext } = {}) {
  const inner = new InMemoryUnitOfWork();
  const unitOfWork: UnitOfWork = {
    run: (work) =>
      inner.run(async (tx) => work(options.wrap === undefined ? tx : options.wrap(tx))),
  };
  const metrics = new Metrics();
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const service = new FriendService({ unitOfWork, metrics, clock, ids });
  await seedUsers(inner);
  return { service, metrics, clock, ids, state: inner.state, inner };
}

async function seedUsers(unitOfWork: InMemoryUnitOfWork): Promise<void> {
  const context = unitOfWork.context;
  for (const profile of [
    { userId: USER_IDS.alice, username: 'alice', email: 'alice@example.com' },
    { userId: USER_IDS.bob, username: 'bob', email: 'bob@example.com' },
    { userId: USER_IDS.carol, username: 'carol', email: 'carol@example.com' },
  ]) {
    await context.userProfiles.upsertFromWebhook({
      userId: profile.userId,
      username: profile.username,
      displayName: profile.username,
      avatarUrl: '',
      email: profile.email,
    });
  }
}

function expectDomainError(error: unknown, code: ErrorCode): void {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

describe('FriendService.sendFriendRequest', () => {
  test('creates a pending request and its outbox event in one transaction', async () => {
    const { service, state, metrics } = await setup();

    const request = await service.sendFriendRequest(alice, 'BOB', { traceParent: TRACEPARENT });

    expect(request.status).toBe('pending');
    expect(request.senderUserId).toBe(USER_IDS.alice);
    expect(request.recipientUserId).toBe(USER_IDS.bob);

    const event = state.outbox[0];
    expect(event?.eventType).toBe('friend_request_sent');
    expect(event?.partitionKey).toBe(USER_IDS.bob);
    expect(event?.headers['trace_parent']).toBe(TRACEPARENT);
    expect(event?.payload).toEqual({
      request_id: request.requestId,
      sender_user_id: USER_IDS.alice,
      sender_username: 'alice',
      recipient_user_id: USER_IDS.bob,
      recipient_username: 'bob',
      recipient_email: 'bob@example.com',
    });
    expect(state.requests).toHaveLength(1);
    expect(metrics.registry.getSingleMetric('identity_friend_requests_total')).toBeDefined();
  });

  test.each([
    ['unknown username', alice, 'nobody', 'username_not_found'],
    ['soft-deleted username', alice, 'carol', 'username_not_found'],
    ['self request', alice, 'ALICE', 'self_request'],
  ])('rejects %s', async (_name, caller, username, code) => {
    const { service, state, inner } = await setup();
    if (username === 'carol') {
      await inner.context.userProfiles.softDelete(USER_IDS.carol, new Date());
    }

    try {
      await service.sendFriendRequest(caller, username);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, code as ErrorCode);
    }
    expect(state.requests).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  test('rejects an existing friendship', async () => {
    const { service, inner } = await setup();
    await inner.context.friendships.insertPair(USER_IDS.alice, USER_IDS.bob, new Date());

    try {
      await service.sendFriendRequest(alice, 'bob');
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'already_friends');
    }
  });

  test('rejects a pending request in either direction', async () => {
    const { service } = await setup();
    await service.sendFriendRequest(bob, 'alice');

    try {
      await service.sendFriendRequest(alice, 'bob');
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'duplicate_request');
    }
  });

  test('maps a unique-violation race onto duplicate_request and rolls back', async () => {
    const { service, state } = await setup({
      wrap: (tx) => ({
        ...tx,
        friendRequests: {
          ...tx.friendRequests,
          findPendingBetween: async () => undefined,
          insertPending: async () => {
            const error = new Error('duplicate key value violates unique constraint');
            Object.assign(error, { code: '23505' });
            throw error;
          },
        },
      }),
    });

    try {
      await service.sendFriendRequest(alice, 'bob');
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'duplicate_request');
    }
    expect(state.requests).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });

  test('lazily creates the caller profile when the webhook was missed', async () => {
    const { service, state } = await setup();
    const dave = claims('44444444-4444-4444-8444-444444444444', 'dave');

    await service.sendFriendRequest(dave, 'bob');

    expect(state.profiles.some((profile) => profile.userId === dave.userId)).toBe(true);
  });

  test('a failing outbox write rolls back the friend request', async () => {
    const { service, state } = await setup({
      wrap: (tx) => ({
        ...tx,
        outbox: {
          enqueue: async () => {
            throw new Error('outbox insert failed');
          },
        },
      }),
    });

    await expect(service.sendFriendRequest(alice, 'bob')).rejects.toThrow('outbox insert failed');
    expect(state.requests).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
  });
});

describe('FriendService.acceptFriendRequest', () => {
  test('accepts a pending request, creates the friendship and emits one event', async () => {
    const { service, state } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');
    state.outbox.length = 0;

    const friendship = await service.acceptFriendRequest(bob, request.requestId, {
      traceParent: TRACEPARENT,
    });

    expect(friendship).toMatchObject({
      userIdA: USER_IDS.alice,
      userIdB: USER_IDS.bob,
    });
    const stored = state.requests.find((row) => row.requestId === request.requestId);
    expect(stored?.status).toBe('accepted');
    expect(stored?.respondedAt).not.toBeNull();

    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.eventType).toBe('friend_request_accepted');
    expect(state.outbox[0]?.partitionKey).toBe(USER_IDS.bob);
    expect(state.outbox[0]?.payload).toEqual({
      request_id: request.requestId,
      sender_user_id: USER_IDS.alice,
      recipient_user_id: USER_IDS.bob,
    });
  });

  test('is recipient-only and pending-only', async () => {
    const { service, state } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');

    try {
      await service.acceptFriendRequest(alice, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_found');
    }

    try {
      await service.acceptFriendRequest(carol, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_found');
    }

    await service.declineFriendRequest(bob, request.requestId);
    try {
      await service.acceptFriendRequest(bob, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_pending');
    }
    expect(state.friendships).toHaveLength(0);
  });

  test('accepting twice is a conflict and does not create a duplicate friendship', async () => {
    const { service, state } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');
    await service.acceptFriendRequest(bob, request.requestId);

    await expect(service.acceptFriendRequest(bob, request.requestId)).rejects.toThrow(DomainError);
    expect(state.friendships).toHaveLength(1);
  });
});

describe('FriendService.declineFriendRequest', () => {
  test('declines a pending request and emits friend_request_declined', async () => {
    const { service, state } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');
    state.outbox.length = 0;

    const declined = await service.declineFriendRequest(bob, request.requestId);

    expect(declined.status).toBe('declined');
    expect(state.outbox[0]?.eventType).toBe('friend_request_declined');
    expect(state.friendships).toHaveLength(0);
  });

  test('rejects a request addressed to someone else', async () => {
    const { service } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');

    try {
      await service.declineFriendRequest(carol, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_found');
    }
  });
});

describe('FriendService.cancelFriendRequest', () => {
  test('cancels a pending request as its sender', async () => {
    const { service, state } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');
    state.outbox.length = 0;

    await service.cancelFriendRequest(alice, request.requestId);

    const stored = state.requests.find((row) => row.requestId === request.requestId);
    expect(stored?.status).toBe('cancelled');
    expect(state.outbox[0]?.eventType).toBe('friend_request_cancelled');
  });

  test('is sender-only and pending-only', async () => {
    const { service } = await setup();
    const request = await service.sendFriendRequest(alice, 'bob');

    try {
      await service.cancelFriendRequest(bob, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_found');
    }

    await service.cancelFriendRequest(alice, request.requestId);
    try {
      await service.cancelFriendRequest(alice, request.requestId);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'request_not_pending');
    }
  });
});

describe('FriendService listing', () => {
  test('lists incoming requests by default ordering with cursor pagination', async () => {
    const { service, clock, state, inner } = await setup();

    const dave = claims('44444444-4444-4444-8444-444444444444', 'dave');
    await inner.context.userProfiles.upsertFromWebhook({
      userId: dave.userId,
      username: 'dave',
      displayName: 'dave',
      avatarUrl: '',
      email: 'dave@example.com',
    });

    const created: FriendRequestRecord[] = [];
    for (const sender of [alice, carol, dave]) {
      created.push(await service.sendFriendRequest(sender, 'bob'));
      clock.advanceMs(1_000);
    }

    const firstPage = await service.listFriendRequests(bob, {
      direction: 'incoming',
      status: 'pending',
      limit: 2,
    });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.rows[0]?.requestId).toBe(created[2]?.requestId);

    const secondPage = await service.listFriendRequests(bob, {
      direction: 'incoming',
      status: 'pending',
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.rows[0]?.requestId).toBe(created[0]?.requestId);

    const outgoing = await service.listFriendRequests(carol, {
      direction: 'outgoing',
      status: 'pending',
      limit: 10,
    });
    expect(outgoing.rows).toHaveLength(1);
    expect(outgoing.rows[0]?.requestId).toBe(created[1]?.requestId);

    const accepted = await service.listFriendRequests(bob, {
      direction: 'incoming',
      status: 'accepted',
      limit: 10,
    });
    expect(accepted.rows).toHaveLength(0);
    expect(state.requests).toHaveLength(3);
  });

  test('lists friends as public profiles in page order', async () => {
    const { service, inner, clock } = await setup();
    await inner.context.friendships.insertPair(USER_IDS.alice, USER_IDS.bob, clock.now());
    clock.advanceMs(1_000);
    await inner.context.friendships.insertPair(USER_IDS.alice, USER_IDS.carol, clock.now());

    const page = await service.listFriends(alice, { limit: 1 });
    expect(page.rows.map((profile) => profile.username)).toEqual(['carol']);
    expect(page.nextCursor).not.toBeNull();

    const next = await service.listFriends(alice, {
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.rows.map((profile) => profile.username)).toEqual(['bob']);
    expect(next.nextCursor).toBeNull();
  });

  test('returns an empty friend list for a user with no friendships', async () => {
    const { service } = await setup();
    const page = await service.listFriends(carol, { limit: 10 });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });
});

describe('FriendService.removeFriend', () => {
  test('removes the mutual friendship and emits friendship_removed', async () => {
    const { service, state, inner } = await setup();
    await inner.context.friendships.insertPair(USER_IDS.alice, USER_IDS.bob, new Date());
    state.outbox.length = 0;

    await service.removeFriend(bob, USER_IDS.alice, { traceParent: TRACEPARENT });

    expect(state.friendships).toHaveLength(0);
    expect(state.outbox[0]?.eventType).toBe('friendship_removed');
    expect(state.outbox[0]?.partitionKey).toBe(USER_IDS.alice);
    expect(state.outbox[0]?.payload).toEqual({
      user_id_a: USER_IDS.alice,
      user_id_b: USER_IDS.bob,
    });
  });

  test('rejects removing a non-friend', async () => {
    const { service } = await setup();
    try {
      await service.removeFriend(alice, USER_IDS.carol);
      throw new Error('expected error');
    } catch (error) {
      expectDomainError(error, 'friendship_not_found');
    }
  });

  test('a failed delete does not emit an event', async () => {
    const { service, state } = await setup({
      wrap: (tx) => ({
        ...tx,
        friendships: {
          ...tx.friendships,
          findPair: async () => ({
            userIdA: USER_IDS.alice,
            userIdB: USER_IDS.bob,
            createdAt: new Date(),
          }),
          deletePair: async () => false,
        },
      }),
    });

    await expect(service.removeFriend(alice, USER_IDS.bob)).rejects.toThrow(DomainError);
    expect(state.outbox).toHaveLength(0);
  });
});

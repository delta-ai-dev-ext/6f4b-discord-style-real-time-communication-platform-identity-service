import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { FriendRequestRecord } from '../../src/models/domain';
import { createTransactionContext } from '../../src/repositories/drizzle/unitOfWork';
import { createTestDatabase, type TestDatabase } from './harness';
import { USER_IDS } from '../mocks/fixtures';

let testDb: TestDatabase;

const now = new Date('2025-01-15T12:00:00.000Z');

function request(
  overrides: Partial<FriendRequestRecord> & { requestId: string },
): FriendRequestRecord {
  return {
    senderUserId: USER_IDS.alice,
    recipientUserId: USER_IDS.bob,
    status: 'pending',
    createdAt: now,
    respondedAt: null,
    ...overrides,
  };
}

async function seedUser(
  userId: string,
  username: string,
  options: { email?: string; deletedAt?: Date } = {},
): Promise<void> {
  await testDb.unitOfWork.run(async (tx) => {
    await tx.userProfiles.upsertFromWebhook({
      userId,
      username,
      displayName: username,
      avatarUrl: 'https://cdn.example.com/x.png',
      email: options.email ?? `${username}@example.com`,
    });
    if (options.deletedAt !== undefined) {
      await tx.userProfiles.softDelete(userId, options.deletedAt);
    }
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
});

afterAll(async () => {
  await testDb.close();
});

describe('migration & schema contract', () => {
  test('creates the five documented tables plus the status enum', async () => {
    const result = await testDb.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'friend_request',
      'friendship',
      'outbox_event',
      'processed_webhook',
      'user_profile',
    ]);

    const enumValues = await testDb.db.execute<{ label: string }>(
      sql`select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'friend_request_status' order by e.enumsortorder`,
    );
    expect(enumValues.rows.map((row) => row.label)).toEqual([
      'pending',
      'accepted',
      'declined',
      'cancelled',
    ]);
  });

  test('enforces the username uniqueness, format and pending-pair constraints', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await expect(seedUser(USER_IDS.bob, 'alice')).rejects.toThrow();

    // The repository lowercases the username, so a mixed-case duplicate still collides.
    await expect(
      testDb.unitOfWork.run(async (tx) => {
        await tx.userProfiles.insertIfAbsent({
          userId: USER_IDS.carol,
          username: 'ALICE',
          displayName: 'Carol',
          avatarUrl: '',
          email: '',
        });
      }),
    ).rejects.toThrow();

    // The CHECK constraint rejects identifiers outside ^[a-z0-9._-]{2,32}$.
    await expect(
      (async () => {
        await testDb.db.execute(
          sql`insert into user_profile (user_id, username, display_name) values (${USER_IDS.carol}, ${'Bad Name'}, ${'Carol'})`,
        );
      })(),
    ).rejects.toThrow();
  });

  test('rejects a self friend request at the database level', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await expect(
      testDb.unitOfWork.run(async (tx) => {
        await tx.friendRequests.insertPending(
          request({ requestId: '00000000-0000-4000-8000-0000000000a1', recipientUserId: USER_IDS.alice }),
        );
      }),
    ).rejects.toThrow();
  });

  test('allows a new pending request after the previous one left pending', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');

    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendRequests.insertPending(
        request({ requestId: '00000000-0000-4000-8000-0000000000b1' }),
      );
    });

    await expect(
      testDb.unitOfWork.run(async (tx) => {
        await tx.friendRequests.insertPending(
          request({ requestId: '00000000-0000-4000-8000-0000000000b2' }),
        );
      }),
    ).rejects.toThrow();

    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendRequests.transition(
        '00000000-0000-4000-8000-0000000000b1',
        'pending',
        'cancelled',
        now,
      );
      await tx.friendRequests.insertPending(
        request({ requestId: '00000000-0000-4000-8000-0000000000b3' }),
      );
    });

    const count = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from friend_request`,
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  test('stores friendships only as an ordered pair', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');

    await testDb.unitOfWork.run(async (tx) => {
      const friendship = await tx.friendships.insertPair(USER_IDS.bob, USER_IDS.alice, now);
      expect(friendship.userIdA < friendship.userIdB).toBe(true);
      const again = await tx.friendships.insertPair(USER_IDS.alice, USER_IDS.bob, now);
      expect(again.userIdA).toBe(friendship.userIdA);
    });

    await expect(
      (async () => {
        await testDb.db.execute(
          sql`insert into friendship (user_id_a, user_id_b) values (${USER_IDS.bob}, ${USER_IDS.alice})`,
        );
      })(),
    ).rejects.toThrow();
  });
});

describe('DrizzleUserProfileRepository', () => {
  test('insertIfAbsent is idempotent and never overwrites webhook fields', async () => {
    await seedUser(USER_IDS.alice, 'alice', { email: 'webhook@example.com' });

    await testDb.unitOfWork.run(async (tx) => {
      const result = await tx.userProfiles.insertIfAbsent({
        userId: USER_IDS.alice,
        username: 'from_claims',
        displayName: 'Claims Name',
        avatarUrl: '',
        email: 'claims@example.com',
      });
      expect(result.inserted).toBe(false);
      expect(result.profile.username).toBe('alice');
      expect(result.profile.email).toBe('webhook@example.com');
    });
  });

  test('lookups are case-insensitive and exclude soft-deleted profiles', async () => {
    await seedUser(USER_IDS.alice, 'alice');

    await testDb.unitOfWork.run(async (tx) => {
      expect((await tx.userProfiles.findActiveByUsername('ALICE'))?.userId).toBe(USER_IDS.alice);
      expect(await tx.userProfiles.findActiveByUsername('nobody')).toBeUndefined();

      await tx.userProfiles.softDelete(USER_IDS.alice, now);
      expect(await tx.userProfiles.findActiveByUsername('alice')).toBeUndefined();
      expect(await tx.userProfiles.findActiveById(USER_IDS.alice)).toBeUndefined();
      expect((await tx.userProfiles.findById(USER_IDS.alice))?.deletedAt).toEqual(now);
    });
  });

  test('findActiveByIds omits deleted and unknown ids', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');
    await testDb.unitOfWork.run(async (tx) => {
      await tx.userProfiles.softDelete(USER_IDS.bob, now);
    });

    await testDb.unitOfWork.run(async (tx) => {
      const rows = await tx.userProfiles.findActiveByIds([
        USER_IDS.alice,
        USER_IDS.bob,
        '99999999-9999-4999-8999-999999999999',
      ]);
      expect(rows.map((row) => row.userId)).toEqual([USER_IDS.alice]);
      expect(await tx.userProfiles.findActiveByIds([])).toEqual([]);
    });
  });

  test('updateFromWebhook patches fields and reports missing rows', async () => {
    await seedUser(USER_IDS.alice, 'alice');

    await testDb.unitOfWork.run(async (tx) => {
      const updated = await tx.userProfiles.updateFromWebhook(USER_IDS.alice, {
        username: 'ALICE_NEW',
        email: 'new@example.com',
      });
      expect(updated?.username).toBe('alice_new');
      expect(updated?.email).toBe('new@example.com');
      expect(updated?.displayName).toBe('alice');

      expect(
        await tx.userProfiles.updateFromWebhook('99999999-9999-4999-8999-999999999999', {
          email: 'x@example.com',
        }),
      ).toBeUndefined();
    });
  });

  test('softDelete is idempotent and user.created resurrects a deleted row', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await testDb.unitOfWork.run(async (tx) => {
      expect(await tx.userProfiles.softDelete(USER_IDS.alice, now)).toBe(true);
      expect(await tx.userProfiles.softDelete(USER_IDS.alice, now)).toBe(false);

      const resurrected = await tx.userProfiles.upsertFromWebhook({
        userId: USER_IDS.alice,
        username: 'alice',
        displayName: 'Alice',
        avatarUrl: '',
        email: 'alice@example.com',
      });
      expect(resurrected.deletedAt).toBeNull();
    });
  });
});

describe('DrizzleFriendRequestRepository', () => {
  async function seedPair(): Promise<void> {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');
    await seedUser(USER_IDS.carol, 'carol');
  }

  test('finds a pending request in either direction', async () => {
    await seedPair();
    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendRequests.insertPending(
        request({ requestId: '00000000-0000-4000-8000-0000000000c1' }),
      );
    });

    await testDb.unitOfWork.run(async (tx) => {
      const forward = await tx.friendRequests.findPendingBetween(USER_IDS.alice, USER_IDS.bob);
      const reverse = await tx.friendRequests.findPendingBetween(USER_IDS.bob, USER_IDS.alice);
      expect(forward?.requestId).toBe('00000000-0000-4000-8000-0000000000c1');
      expect(reverse?.requestId).toBe(forward?.requestId);
      expect(await tx.friendRequests.hasPendingEitherDirection(USER_IDS.alice, USER_IDS.carol)).toBe(
        false,
      );
    });
  });

  test('transition is guarded by the current status', async () => {
    await seedPair();
    const requestId = '00000000-0000-4000-8000-0000000000c2';
    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendRequests.insertPending(request({ requestId }));
    });

    await testDb.unitOfWork.run(async (tx) => {
      const respondedAt = new Date('2025-01-15T13:00:00.000Z');
      const accepted = await tx.friendRequests.transition(requestId, 'pending', 'accepted', respondedAt);
      expect(accepted?.status).toBe('accepted');
      expect(accepted?.respondedAt).toEqual(respondedAt);

      const second = await tx.friendRequests.transition(requestId, 'pending', 'declined', respondedAt);
      expect(second).toBeUndefined();
    });
  });

  test('lists by direction and status with keyset cursors', async () => {
    await seedPair();
    const senderIds = [
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000003',
      'aaaaaaaa-0000-4000-8000-000000000004',
      'aaaaaaaa-0000-4000-8000-000000000005',
    ];
    for (const [index, senderId] of senderIds.entries()) {
      await seedUser(senderId, `sender${index}`);
    }

    const created: string[] = [];
    await testDb.unitOfWork.run(async (tx) => {
      for (const [index, senderId] of senderIds.entries()) {
        const requestId = `00000000-0000-4000-8000-0000000001${index.toString().padStart(2, '0')}`;
        created.push(requestId);
        await tx.friendRequests.insertPending(
          request({
            requestId,
            senderUserId: senderId,
            createdAt: new Date(now.getTime() + index * 1_000),
          }),
        );
      }
    });

    const first = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.list({
        userId: USER_IDS.bob,
        direction: 'incoming',
        status: 'pending',
        limit: 2,
      }),
    );
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]?.requestId).toBe(created[4] as string);
    expect(first.nextCursor).not.toBeNull();

    const second = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.list({
        userId: USER_IDS.bob,
        direction: 'incoming',
        status: 'pending',
        limit: 2,
        cursor: first.nextCursor as string,
      }),
    );
    expect(second.rows.map((row) => row.requestId)).toEqual([
      created[2] as string,
      created[1] as string,
    ]);

    const third = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.list({
        userId: USER_IDS.bob,
        direction: 'incoming',
        status: 'pending',
        limit: 2,
        cursor: second.nextCursor as string,
      }),
    );
    expect(third.rows.map((row) => row.requestId)).toEqual([created[0] as string]);
    expect(third.nextCursor).toBeNull();

    const outgoing = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.list({
        userId: senderIds[0] as string,
        direction: 'outgoing',
        status: 'pending',
        limit: 10,
      }),
    );
    expect(outgoing.rows).toHaveLength(1);

    const declined = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.list({
        userId: USER_IDS.bob,
        direction: 'incoming',
        status: 'declined',
        limit: 10,
      }),
    );
    expect(declined.rows).toHaveLength(0);
  });

  test('cancelPendingForUser cancels every pending request touching the user', async () => {
    await seedPair();
    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendRequests.insertPending(
        request({ requestId: '00000000-0000-4000-8000-0000000000d1' }),
      );
      await tx.friendRequests.insertPending(
        request({
          requestId: '00000000-0000-4000-8000-0000000000d2',
          senderUserId: USER_IDS.alice,
          recipientUserId: USER_IDS.carol,
        }),
      );
    });

    const cancelled = await testDb.unitOfWork.run(async (tx) =>
      tx.friendRequests.cancelPendingForUser(USER_IDS.alice, new Date('2025-01-15T14:00:00.000Z')),
    );

    expect(cancelled).toHaveLength(2);
    expect(cancelled.every((row) => row.status === 'cancelled')).toBe(true);
  });
});

describe('DrizzleFriendshipRepository', () => {
  beforeEach(async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');
    await seedUser(USER_IDS.carol, 'carol');
  });

  test('lists friends of either side with pagination and deletes the pair', async () => {
    await testDb.unitOfWork.run(async (tx) => {
      await tx.friendships.insertPair(USER_IDS.alice, USER_IDS.bob, new Date(now.getTime()));
      await tx.friendships.insertPair(
        USER_IDS.carol,
        USER_IDS.alice,
        new Date(now.getTime() + 1_000),
      );
    });

    const first = await testDb.unitOfWork.run(async (tx) =>
      tx.friendships.listForUser(USER_IDS.alice, { limit: 1 }),
    );
    expect(first.rows).toEqual([USER_IDS.carol]);
    expect(first.nextCursor).not.toBeNull();

    const second = await testDb.unitOfWork.run(async (tx) =>
      tx.friendships.listForUser(USER_IDS.alice, {
        limit: 1,
        cursor: first.nextCursor as string,
      }),
    );
    expect(second.rows).toEqual([USER_IDS.bob]);
    expect(second.nextCursor).toBeNull();

    await testDb.unitOfWork.run(async (tx) => {
      expect(await tx.friendships.deletePair(USER_IDS.bob, USER_IDS.alice)).toBe(true);
      expect(await tx.friendships.deletePair(USER_IDS.bob, USER_IDS.alice)).toBe(false);
      expect(await tx.friendships.findPair(USER_IDS.alice, USER_IDS.bob)).toBeUndefined();
    });
  });
});

describe('DrizzleProcessedWebhookRepository', () => {
  test('markProcessed reports replays', async () => {
    await testDb.unitOfWork.run(async (tx) => {
      expect(await tx.processedWebhooks.markProcessed('msg_1', 'user.created', now)).toBe(true);
      expect(await tx.processedWebhooks.markProcessed('msg_1', 'user.created', now)).toBe(false);
    });

    const rows = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from processed_webhook`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
});

describe('DrizzleUnitOfWork', () => {
  test('rolls back every write when the transaction body throws', async () => {
    await seedUser(USER_IDS.alice, 'alice');
    await seedUser(USER_IDS.bob, 'bob');

    await expect(
      testDb.unitOfWork.run(async (tx) => {
        await tx.friendRequests.insertPending(
          request({ requestId: '00000000-0000-4000-8000-0000000000e1' }),
        );
        await tx.outbox.enqueue({
          eventId: '00000000-0000-4000-8000-0000000000e2',
          topic: 'identity_friend_events',
          partitionKey: USER_IDS.bob,
          eventType: 'friend_request_sent',
          payload: { request_id: 'x' },
          headers: { trace_parent: null },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const requests = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from friend_request`,
    );
    const outbox = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from outbox_event`,
    );
    expect(requests.rows[0]?.count).toBe(0);
    expect(outbox.rows[0]?.count).toBe(0);
  });

  test('createTransactionContext exposes every repository port', () => {
    const context = createTransactionContext(testDb.db);
    expect(Object.keys(context).sort()).toEqual([
      'friendRequests',
      'friendships',
      'outbox',
      'processedWebhooks',
      'userProfiles',
    ]);
  });
});

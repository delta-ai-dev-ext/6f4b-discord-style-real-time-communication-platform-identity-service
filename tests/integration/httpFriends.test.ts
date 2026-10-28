import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './harness';
import { ALICE_TOKEN, BOB_TOKEN, CAROL_TOKEN, createTestApp, type TestApp } from './testApp';
import { errorCode, json, postWebhook, seedUser } from './helpers';
import { clerkUserPayload, TRACEPARENT, USER_IDS } from '../mocks/fixtures';

let testDb: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  app = createTestApp(testDb);
});

afterAll(async () => {
  await testDb.close();
});

async function sendRequest(
  token: string,
  username: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('POST', '/v1/friend-requests', {
    token,
    body: { username },
    headers,
  });
}

describe('POST /v1/friend-requests', () => {
  test('creates a pending request and enqueues the event with the trace context', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');

    const response = await sendRequest(ALICE_TOKEN, 'BOB', { traceparent: TRACEPARENT });
    expect(response.status).toBe(201);

    const body = await json(response);
    expect(body).toMatchObject({
      sender_user_id: USER_IDS.alice,
      recipient_user_id: USER_IDS.bob,
      status: 'pending',
      responded_at: null,
    });
    expect(typeof body['request_id']).toBe('string');

    // The event row is committed in the same transaction as the request.
    const rows = await testDb.db.execute<{
      event_type: string;
      partition_key: string;
      headers: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>(sql`select event_type, partition_key, headers, payload from outbox_event`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.event_type).toBe('friend_request_sent');
    expect(rows.rows[0]?.partition_key).toBe(USER_IDS.bob);
    expect(rows.rows[0]?.headers['trace_parent']).toBe(TRACEPARENT);
    expect(rows.rows[0]?.payload).toMatchObject({
      sender_username: 'alice',
      recipient_username: 'bob',
      recipient_email: 'bob@example.com',
    });
  });

  test('rejects unknown usernames with 404 username_not_found', async () => {
    const response = await sendRequest(ALICE_TOKEN, 'ghost');
    expect(response.status).toBe(404);
    expect(errorCode(await json(response))).toBe('username_not_found');
  });

  test('rejects self requests with 400 self_request', async () => {
    const response = await sendRequest(ALICE_TOKEN, 'ALICE');
    expect(response.status).toBe(400);
    expect(errorCode(await json(response))).toBe('self_request');
  });

  test('rejects duplicates in either direction with 409 duplicate_request', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    expect((await sendRequest(ALICE_TOKEN, 'bob')).status).toBe(201);

    const duplicate = await sendRequest(ALICE_TOKEN, 'bob');
    expect(duplicate.status).toBe(409);
    expect(errorCode(await json(duplicate))).toBe('duplicate_request');

    const reverse = await sendRequest(BOB_TOKEN, 'alice');
    expect(reverse.status).toBe(409);
    expect(errorCode(await json(reverse))).toBe('duplicate_request');
  });

  test('rejects requests to existing friends with 409 already_friends', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    const requestId = created['request_id'] as string;

    const accepted = await app.request(
      'POST',
      `/v1/friend-requests/${requestId}/accept`,
      { token: BOB_TOKEN },
    );
    expect(accepted.status).toBe(200);

    const response = await sendRequest(ALICE_TOKEN, 'bob');
    expect(response.status).toBe(409);
    expect(errorCode(await json(response))).toBe('already_friends');
  });

  test('rejects invalid payloads with 400 validation_error', async () => {
    const response = await app.request('POST', '/v1/friend-requests', {
      token: ALICE_TOKEN,
      body: { username: 'no spaces allowed' },
    });
    expect(response.status).toBe(400);
    expect(errorCode(await json(response))).toBe('validation_error');
  });

  test('enforces the per-user rate limit with 429 rate_limited', async () => {
    const limited = createTestApp(testDb, { rateLimitPerMinute: 2 });
    await seedUser(app, USER_IDS.bob, 'bob');
    await seedUser(app, USER_IDS.carol, 'carol');

    expect(
      (
        await limited.request('POST', '/v1/friend-requests', {
          token: ALICE_TOKEN,
          body: { username: 'bob' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await limited.request('POST', '/v1/friend-requests', {
          token: ALICE_TOKEN,
          body: { username: 'carol' },
        })
      ).status,
    ).toBe(201);

    const rejected = await limited.request('POST', '/v1/friend-requests', {
      token: ALICE_TOKEN,
      body: { username: 'bob' },
    });
    expect(rejected.status).toBe(429);
    expect(errorCode(await json(rejected))).toBe('rate_limited');
  });
});

describe('GET /v1/friend-requests', () => {
  test('lists incoming pending requests with cursors and validates filters', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const first = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    await sendRequest(CAROL_TOKEN, 'bob');

    const response = await app.request('GET', '/v1/friend-requests', { token: BOB_TOKEN });
    expect(response.status).toBe(200);

    const body = await json(response);
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(body['next_cursor']).toBeNull();

    const paged = await app.request('GET', '/v1/friend-requests?limit=1&direction=incoming', {
      token: BOB_TOKEN,
    });
    const pagedBody = await json(paged);
    expect((pagedBody['data'] as unknown[]).length).toBe(1);
    const cursor = pagedBody['next_cursor'] as string;
    expect(cursor).not.toBeNull();

    const secondPage = await json(
      await app.request(
        'GET',
        `/v1/friend-requests?limit=1&direction=incoming&cursor=${encodeURIComponent(cursor)}`,
        { token: BOB_TOKEN },
      ),
    );
    expect((secondPage['data'] as unknown[]).length).toBe(1);
    expect(secondPage['next_cursor']).toBeNull();

    const outgoing = await json(
      await app.request('GET', '/v1/friend-requests?direction=outgoing', { token: ALICE_TOKEN }),
    );
    expect((outgoing['data'] as Array<Record<string, unknown>>)[0]?.['request_id']).toBe(
      first['request_id'],
    );

    const acceptedFilter = await json(
      await app.request('GET', '/v1/friend-requests?status=accepted', { token: BOB_TOKEN }),
    );
    expect(acceptedFilter['data']).toEqual([]);
  });

  test.each([
    ['invalid direction', '/v1/friend-requests?direction=sideways'],
    ['invalid status', '/v1/friend-requests?status=maybe'],
    ['invalid limit', '/v1/friend-requests?limit=0'],
    ['malformed cursor', '/v1/friend-requests?cursor=not-a-cursor'],
  ])('rejects %s with 400', async (_name, path) => {
    const response = await app.request('GET', path, { token: BOB_TOKEN });
    expect(response.status).toBe(400);
  });
});

describe('friend-request transitions', () => {
  test('recipient accepts and the friendship becomes visible to both sides', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    const requestId = created['request_id'] as string;

    const accepted = await app.request('POST', `/v1/friend-requests/${requestId}/accept`, {
      token: BOB_TOKEN,
    });
    expect(accepted.status).toBe(200);
    const friendship = await json(accepted);
    expect(friendship).toMatchObject({ user_id_a: USER_IDS.alice, user_id_b: USER_IDS.bob });

    for (const [token, expectedFriend] of [
      [ALICE_TOKEN, USER_IDS.bob],
      [BOB_TOKEN, USER_IDS.alice],
    ] as const) {
      const friends = await json(await app.request('GET', '/v1/friends', { token }));
      const data = friends['data'] as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0]?.['user_id']).toBe(expectedFriend);
      expect(friends['next_cursor']).toBeNull();
    }
  });

  test('accept is recipient-only (404) and pending-only (409)', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    const requestId = created['request_id'] as string;

    const wrongActor = await app.request('POST', `/v1/friend-requests/${requestId}/accept`, {
      token: CAROL_TOKEN,
    });
    expect(wrongActor.status).toBe(404);
    expect(errorCode(await json(wrongActor))).toBe('request_not_found');

    expect(
      (
        await app.request('POST', `/v1/friend-requests/${requestId}/accept`, {
          token: BOB_TOKEN,
        })
      ).status,
    ).toBe(200);

    const replay = await app.request('POST', `/v1/friend-requests/${requestId}/accept`, {
      token: BOB_TOKEN,
    });
    expect(replay.status).toBe(409);
    expect(errorCode(await json(replay))).toBe('request_not_pending');
  });

  test('recipient declines with 200 and the request leaves the pending list', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));

    const declined = await app.request(
      'POST',
      `/v1/friend-requests/${created['request_id'] as string}/decline`,
      { token: BOB_TOKEN },
    );
    expect(declined.status).toBe(200);
    const body = await json(declined);
    expect(body['status']).toBe('declined');
    expect(body['responded_at']).not.toBeNull();

    const pending = await json(
      await app.request('GET', '/v1/friend-requests', { token: BOB_TOKEN }),
    );
    expect(pending['data']).toEqual([]);
  });

  test('sender cancels with 204; other users get 404', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    const requestId = created['request_id'] as string;

    const foreign = await app.request('DELETE', `/v1/friend-requests/${requestId}`, {
      token: CAROL_TOKEN,
    });
    expect(foreign.status).toBe(404);

    const cancelled = await app.request('DELETE', `/v1/friend-requests/${requestId}`, {
      token: ALICE_TOKEN,
    });
    expect(cancelled.status).toBe(204);

    const again = await app.request('DELETE', `/v1/friend-requests/${requestId}`, {
      token: ALICE_TOKEN,
    });
    expect(again.status).toBe(409);
  });

  test('removing a friend returns 204 and a second removal 404', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');
    const created = await json(await sendRequest(ALICE_TOKEN, 'bob'));
    await app.request('POST', `/v1/friend-requests/${created['request_id'] as string}/accept`, {
      token: BOB_TOKEN,
    });

    const removed = await app.request('DELETE', `/v1/friends/${USER_IDS.bob}`, {
      token: ALICE_TOKEN,
    });
    expect(removed.status).toBe(204);

    const again = await app.request('DELETE', `/v1/friends/${USER_IDS.bob}`, {
      token: ALICE_TOKEN,
    });
    expect(again.status).toBe(404);
    expect(errorCode(await json(again))).toBe('friendship_not_found');

    const rows = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from outbox_event where event_type = 'friendship_removed'`,
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
});

describe('POST /v1/webhooks/clerk', () => {
  test('accepts a signed user.created event and is idempotent by message id', async () => {
    const first = await postWebhook(app, 'user.created', clerkUserPayload(), 'msg_1');
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ status: 'ok' });

    const replay = await postWebhook(
      app,
      'user.created',
      clerkUserPayload({ username: 'renamed' }),
      'msg_1',
    );
    expect(replay.status).toBe(200);

    const profile = await json(
      await app.request('GET', '/v1/users/by-username/alice', { token: ALICE_TOKEN }),
    );
    expect(profile['username']).toBe('alice');
  });

  test('applies user.updated and user.deleted correctly', async () => {
    await seedUser(app, USER_IDS.bob, 'bob');

    const updated = await postWebhook(
      app,
      'user.updated',
      clerkUserPayload({ id: USER_IDS.bob, username: 'bob_new', email: 'bob_new@example.com' }),
    );
    expect(updated.status).toBe(200);
    const profile = await json(
      await app.request('GET', '/v1/users/by-username/bob_new', { token: ALICE_TOKEN }),
    );
    expect(profile['user_id']).toBe(USER_IDS.bob);

    const created = await json(await sendRequest(ALICE_TOKEN, 'bob_new'));
    const deleted = await postWebhook(
      app,
      'user.deleted',
      clerkUserPayload({ id: USER_IDS.bob, username: 'bob_new', deleted: true }),
    );
    expect(deleted.status).toBe(200);

    const cancelled = await testDb.db.execute<{ status: string }>(
      sql`select status from friend_request where request_id = ${created['request_id'] as string}`,
    );
    expect(cancelled.rows[0]?.status).toBe('cancelled');

    const lookup = await app.request('GET', '/v1/users/by-username/bob_new', {
      token: ALICE_TOKEN,
    });
    expect(lookup.status).toBe(404);
  });

  test('rejects unsigned deliveries with 401 invalid_signature', async () => {
    const body = JSON.stringify({ type: 'user.created', data: clerkUserPayload() });
    const response = await app.request('POST', '/v1/webhooks/clerk', {
      rawBody: body,
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_unsigned',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,deadbeef',
      },
    });

    expect(response.status).toBe(401);
    expect(errorCode(await json(response))).toBe('invalid_signature');

    const metrics = await (await app.request('GET', '/metrics')).text();
    expect(metrics).toContain('identity_clerk_webhook_failures_total{reason="signature"} 1');
  });

  test('rejects missing svix headers with 401', async () => {
    const body = JSON.stringify({ type: 'user.created', data: clerkUserPayload() });
    const response = await app.request('POST', '/v1/webhooks/clerk', {
      rawBody: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
  });

  test('accepts a delivery whose body was parsed from the exact raw bytes', async () => {
    const data = clerkUserPayload({ id: USER_IDS.carol, username: 'carol' });
    // Extra whitespace proves the raw body (not a re-serialised copy) is signed.
    const body = JSON.stringify({ type: 'user.created', data }, null, 2);
    const { svixHeaders } = await import('../mocks/svix');
    const headers = await svixHeaders({
      signingSecret: app.signingSecret,
      messageId: 'msg_pretty',
      body,
    });

    const response = await app.request('POST', '/v1/webhooks/clerk', { rawBody: body, headers });
    expect(response.status).toBe(200);
    expect(
      (
        await app.request('GET', '/v1/users/by-username/carol', {
          token: ALICE_TOKEN,
        })
      ).status,
    ).toBe(200);
  });
});

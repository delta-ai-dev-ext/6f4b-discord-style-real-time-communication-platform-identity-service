import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from './harness';
import { ALICE_TOKEN, createTestApp, type TestApp } from './testApp';
import { clerkEvent, clerkUserPayload, USER_IDS } from '../mocks/fixtures';
import { svixHeaders } from '../mocks/svix';

let testDb: TestDatabase;
let app: TestApp;

async function postWebhook(
  type: 'user.created' | 'user.updated' | 'user.deleted',
  data: Record<string, unknown>,
  messageId = crypto.randomUUID(),
): Promise<Response> {
  const body = JSON.stringify(clerkEvent(type, data));
  const headers = await svixHeaders({
    signingSecret: app.signingSecret,
    messageId,
    body,
  });
  return app.request('POST', '/v1/webhooks/clerk', { rawBody: body, headers });
}

async function seedUser(
  userId: string,
  username: string,
  email = `${username}@example.com`,
): Promise<void> {
  const response = await postWebhook(
    'user.created',
    clerkUserPayload({ id: userId, username, email }),
  );
  expect(response.status).toBe(200);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

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

describe('probes', () => {
  test('healthz is dependency-free and always 200', async () => {
    app.setProducerConnected(false);
    app.setDatabaseReady(false);

    const response = await app.request('GET', '/healthz');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: 'ok' });
  });

  test('readyz requires both the database and the producer', async () => {
    expect((await app.request('GET', '/readyz')).status).toBe(200);

    app.setProducerConnected(false);
    const producerDown = await app.request('GET', '/readyz');
    expect(producerDown.status).toBe(503);
    expect(await json(producerDown)).toEqual({ status: 'degraded' });

    app.setProducerConnected(true);
    app.setDatabaseReady(false);
    const databaseDown = await app.request('GET', '/readyz');
    expect(databaseDown.status).toBe(503);

    app.setDatabaseReady(true);
    app.setShuttingDown(true);
    const draining = await app.request('GET', '/readyz');
    expect(draining.status).toBe(503);
  });

  test('exposes the documented metrics', async () => {
    await app.request('GET', '/v1/me', { token: ALICE_TOKEN });

    const response = await app.request('GET', '/metrics');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('identity_friend_requests_total');
    expect(body).toContain('http_request_duration_seconds');
    expect(body).toContain('route="GET /v1/me"');
    expect(body).toContain('method="GET"');
    expect(body).toContain('status_class="2xx"');
  });
});

describe('GET /v1/me', () => {
  test('bootstraps the caller profile from claims (ADR-001)', async () => {
    const response = await app.request('GET', '/v1/me', { token: ALICE_TOKEN });
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body).toEqual({
      user_id: USER_IDS.alice,
      username: 'alice',
      display_name: 'alice name',
      avatar_url: '',
      email: 'alice@example.com',
      created_at: expect.any(String) as unknown as string,
      updated_at: expect.any(String) as unknown as string,
    });

    const metrics = await (await app.request('GET', '/metrics')).text();
    expect(metrics).toContain('identity_users_synced_total{event="created"} 1');
  });

  test('rejects missing and invalid tokens with 401', async () => {
    const missing = await app.request('GET', '/v1/me');
    expect(missing.status).toBe(401);
    expect(await json(missing)).toEqual({
      error: { code: 'unauthorized', message: 'A valid session token is required.' },
    });

    const malformed = await app.request('GET', '/v1/me', { token: 'not-a-token' });
    expect(malformed.status).toBe(401);
    expect(((await json(malformed))['error'] as Record<string, unknown>)['code']).toBe(
      'unauthorized',
    );
  });

  test('rejects every /v1 route while shutting down with 503', async () => {
    app.setShuttingDown(true);
    const response = await app.request('GET', '/v1/me', { token: ALICE_TOKEN });
    expect(response.status).toBe(503);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'service_unavailable',
    );
  });
});

describe('GET /v1/users/by-username/{username}', () => {
  test('resolves usernames case-insensitively', async () => {
    await seedUser(USER_IDS.bob, 'pixel_pioneer');

    const response = await app.request('GET', '/v1/users/by-username/PIXEL_PIONEER', {
      token: ALICE_TOKEN,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      user_id: USER_IDS.bob,
      username: 'pixel_pioneer',
      display_name: 'Alice Anderson',
      avatar_url: 'https://cdn.example.com/alice.png',
    });
  });

  test('returns 404 username_not_found for unknown and deleted users', async () => {
    const unknown = await app.request('GET', '/v1/users/by-username/ghost', {
      token: ALICE_TOKEN,
    });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({
      error: {
        code: 'username_not_found',
        message: 'No active user found with that username.',
      },
    });

    await seedUser(USER_IDS.bob, 'bob');
    expect(
      (await postWebhook('user.deleted', clerkUserPayload({ id: USER_IDS.bob, username: 'bob' })))
        .status,
    ).toBe(200);

    const deleted = await app.request('GET', '/v1/users/by-username/bob', { token: ALICE_TOKEN });
    expect(deleted.status).toBe(404);
  });

  test('records lookup outcomes in the metrics', async () => {
    await seedUser(USER_IDS.bob, 'bob');
    await app.request('GET', '/v1/users/by-username/bob', { token: ALICE_TOKEN });
    await app.request('GET', '/v1/users/by-username/ghost', { token: ALICE_TOKEN });

    const metrics = await (await app.request('GET', '/metrics')).text();
    expect(metrics).toContain('identity_username_lookups_total{result="found"} 1');
    expect(metrics).toContain('identity_username_lookups_total{result="not_found"} 1');
  });
});

describe('POST /v1/users:batch', () => {
  test('resolves a subset of ids', async () => {
    await seedUser(USER_IDS.bob, 'bob');
    await seedUser(USER_IDS.carol, 'carol');

    const response = await app.request('POST', '/v1/users:batch', {
      token: ALICE_TOKEN,
      body: {
        user_ids: [USER_IDS.bob, USER_IDS.carol, '99999999-9999-4999-8999-999999999999'],
      },
    });

    expect(response.status).toBe(200);
    const body = (await json(response))['data'] as Array<Record<string, unknown>>;
    expect(body.map((profile) => profile['user_id'])).toEqual([USER_IDS.bob, USER_IDS.carol]);
  });

  test('rejects more than 100 ids with 422 batch_limit_exceeded', async () => {
    const user_ids = Array.from({ length: 101 }, (_value, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );

    const response = await app.request('POST', '/v1/users:batch', {
      token: ALICE_TOKEN,
      body: { user_ids },
    });

    expect(response.status).toBe(422);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'batch_limit_exceeded',
    );
  });

  test.each([
    ['empty list', { user_ids: [] }],
    ['missing field', {}],
    ['non-uuid ids', { user_ids: ['nope'] }],
  ])('rejects %s with 400', async (_name, body) => {
    const response = await app.request('POST', '/v1/users:batch', {
      token: ALICE_TOKEN,
      body,
    });
    expect(response.status).toBe(400);
    expect(((await json(response))['error'] as Record<string, unknown>)['code']).toBe(
      'validation_error',
    );
  });
});

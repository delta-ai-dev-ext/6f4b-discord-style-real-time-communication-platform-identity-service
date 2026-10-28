import { describe, expect, test } from 'bun:test';
import { Metrics } from '../../src/observability/metrics';
import { silentLogger } from '../../src/observability/logger';
import type { UnitOfWork } from '../../src/repositories/ports';
import { ClerkWebhookService } from '../../src/webhooks/clerkWebhookService';
import { clerkEventSchema } from '../../src/webhooks/clerkEventMapper';
import { InMemoryUnitOfWork } from '../mocks/inMemoryRepositories';
import { clerkEvent, clerkUserPayload, FakeClock, FakeIdGenerator, USER_IDS } from '../mocks/fixtures';

async function setup() {
  const inner = new InMemoryUnitOfWork();
  const unitOfWork: UnitOfWork = { run: (work) => inner.run(work) };
  const metrics = new Metrics();
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const service = new ClerkWebhookService({
    unitOfWork,
    metrics,
    clock,
    ids,
    logger: silentLogger,
  });
  return { service, metrics, clock, ids, state: inner.state, inner };
}

function parsed(type: 'user.created' | 'user.updated' | 'user.deleted', data = clerkUserPayload()) {
  return clerkEventSchema.parse(clerkEvent(type, data));
}

describe('ClerkWebhookService', () => {
  test('user.created inserts the mirrored profile', async () => {
    const { service, state } = await setup();

    const result = await service.handle({ svixMessageId: 'msg_1', event: parsed('user.created') });

    expect(result).toEqual({ processed: true, replay: false });
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({
      userId: USER_IDS.alice,
      username: 'alice',
      displayName: 'Alice Anderson',
      avatarUrl: 'https://cdn.example.com/alice.png',
      email: 'alice@example.com',
      deletedAt: null,
    });
  });

  test('user.updated patches mirrored fields', async () => {
    const { service, state } = await setup();
    await service.handle({ svixMessageId: 'msg_1', event: parsed('user.created') });

    await service.handle({
      svixMessageId: 'msg_2',
      event: parsed(
        'user.updated',
        clerkUserPayload({ username: 'alice_renamed', email: 'new@example.com' }),
      ),
    });

    expect(state.profiles[0]).toMatchObject({
      username: 'alice_renamed',
      email: 'new@example.com',
    });
    expect(state.profiles).toHaveLength(1);
  });

  test('user.updated heals a missed user.created', async () => {
    const { service, state } = await setup();

    await service.handle({ svixMessageId: 'msg_updated_only', event: parsed('user.updated') });

    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]?.username).toBe('alice');
  });

  test('user.deleted soft-deletes and cancels every pending request', async () => {
    const { service, state, inner } = await setup();
    await service.handle({ svixMessageId: 'msg_1', event: parsed('user.created') });
    await service.handle({
      svixMessageId: 'msg_2',
      event: parsed('user.created', clerkUserPayload({ id: USER_IDS.bob, username: 'bob' })),
    });
    await service.handle({
      svixMessageId: 'msg_3',
      event: parsed('user.created', clerkUserPayload({ id: USER_IDS.carol, username: 'carol' })),
    });

    const context = inner.context;
    await context.friendRequests.insertPending({
      requestId: '00000000-0000-4000-8000-00000000000a',
      senderUserId: USER_IDS.bob,
      recipientUserId: USER_IDS.alice,
      status: 'pending',
      createdAt: new Date(),
      respondedAt: null,
    });
    await context.friendRequests.insertPending({
      requestId: '00000000-0000-4000-8000-00000000000b',
      senderUserId: USER_IDS.alice,
      recipientUserId: USER_IDS.carol,
      status: 'pending',
      createdAt: new Date(),
      respondedAt: null,
    });
    state.outbox.length = 0;

    await service.handle({
      svixMessageId: 'msg_4',
      event: parsed(
        'user.deleted',
        clerkUserPayload({ deleted: true }),
      ),
    });

    const aliceProfile = state.profiles.find((profile) => profile.userId === USER_IDS.alice);
    expect(aliceProfile?.deletedAt).toBeInstanceOf(Date);
    expect(state.requests.every((request) => request.status === 'cancelled')).toBe(true);
    expect(state.outbox).toHaveLength(2);
    expect(state.outbox.every((event) => event.eventType === 'friend_request_cancelled')).toBe(true);
    expect(state.outbox[0]?.payload).toMatchObject({ sender_user_id: USER_IDS.bob });
  });

  test('replays are 200 no-ops keyed by the Svix message id', async () => {
    const { service, state } = await setup();
    await service.handle({ svixMessageId: 'msg_1', event: parsed('user.created') });

    const replay = await service.handle({
      svixMessageId: 'msg_1',
      event: parsed(
        'user.updated',
        clerkUserPayload({ username: 'should_not_apply' }),
      ),
    });

    expect(replay).toEqual({ processed: false, replay: true });
    expect(state.profiles[0]?.username).toBe('alice');
  });

  test('unknown event types are recorded and ignored', async () => {
    const { service, state } = await setup();
    const result = await service.handle({
      svixMessageId: 'msg_unknown',
      event: clerkEventSchema.parse({ type: 'session.created', data: clerkUserPayload() }),
    });

    expect(result).toEqual({ processed: true, replay: false });
    expect(state.profiles).toHaveLength(0);
    expect(state.processed.get('msg_unknown')).toBe('session.created');
  });

  test('deleting an unknown user is idempotent and emits no events', async () => {
    const { service, state } = await setup();
    const result = await service.handle({
      svixMessageId: 'msg_delete_unknown',
      event: parsed('user.deleted', clerkUserPayload({ deleted: true })),
    });

    expect(result.processed).toBe(true);
    expect(state.outbox).toHaveLength(0);
  });

  test('a failing profile write leaves no processed_webhook row (svix can retry)', async () => {
    const inner = new InMemoryUnitOfWork();
    const unitOfWork: UnitOfWork = {
      run: (work) =>
        inner.run((tx) =>
          work({
            ...tx,
            userProfiles: {
              ...tx.userProfiles,
              upsertFromWebhook: async () => {
                throw new Error('db down');
              },
            },
          }),
        ),
    };
    const service = new ClerkWebhookService({
      unitOfWork,
      metrics: new Metrics(),
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: silentLogger,
    });

    await expect(
      service.handle({ svixMessageId: 'msg_fail', event: parsed('user.created') }),
    ).rejects.toThrow('db down');
    expect(inner.state.processed.has('msg_fail')).toBe(false);
  });
});

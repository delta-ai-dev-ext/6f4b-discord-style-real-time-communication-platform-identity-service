import { describe, expect, test } from 'bun:test';
import { Metrics } from '../../src/observability/metrics';
import { DomainError } from '../../src/models/errors';
import { ProfileService, type AuthClaims } from '../../src/services/profileService';
import { InMemoryUnitOfWork } from '../mocks/inMemoryRepositories';
import { FakeIdGenerator, USER_IDS } from '../mocks/fixtures';

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    userId: USER_IDS.alice,
    username: 'alice',
    displayName: 'Alice Anderson',
    email: 'alice@example.com',
    ...overrides,
  };
}

function setup() {
  const unitOfWork = new InMemoryUnitOfWork();
  const metrics = new Metrics();
  const service = new ProfileService({ unitOfWork, metrics });
  return { unitOfWork, metrics, service };
}

async function seedProfile(
  unitOfWork: InMemoryUnitOfWork,
  input: { userId: string; username: string; email?: string },
): Promise<void> {
  await unitOfWork.context.userProfiles.upsertFromWebhook({
    userId: input.userId,
    username: input.username,
    displayName: input.username,
    avatarUrl: '',
    email: input.email ?? '',
  });
}

describe('ProfileService', () => {
  test('getMyProfile lazily bootstraps the caller from JWT claims', async () => {
    const { service, unitOfWork, metrics } = setup();

    const profile = await service.getMyProfile(claims());

    expect(profile.userId).toBe(USER_IDS.alice);
    expect(profile.username).toBe('alice');
    expect(profile.displayName).toBe('Alice Anderson');
    expect(profile.email).toBe('alice@example.com');
    expect(unitOfWork.state.profiles).toHaveLength(1);
    expect(await metrics.registry.getSingleMetric('identity_users_synced_total')?.get()).toBeDefined();
  });

  test('getMyProfile never overwrites a webhook-maintained profile', async () => {
    const { service, unitOfWork } = setup();
    await seedProfile(unitOfWork, {
      userId: USER_IDS.alice,
      username: 'alice_webhook',
      email: 'webhook@example.com',
    });

    const profile = await service.getMyProfile(claims());

    expect(profile.username).toBe('alice_webhook');
    expect(profile.email).toBe('webhook@example.com');
    expect(unitOfWork.state.profiles).toHaveLength(1);
  });

  test('username lookup is case-insensitive and excludes soft-deleted users', async () => {
    const { service, unitOfWork } = setup();
    await seedProfile(unitOfWork, { userId: USER_IDS.bob, username: 'bob' });

    const found = await service.getByUsername(claims(), 'BOB');
    expect(found.userId).toBe(USER_IDS.bob);

    await unitOfWork.context.userProfiles.softDelete(USER_IDS.bob, new Date());
    await expect(service.getByUsername(claims(), 'bob')).rejects.toThrow(DomainError);
  });

  test('unknown usernames raise username_not_found', async () => {
    const { service } = setup();
    try {
      await service.getByUsername(claims(), 'nobody');
      throw new Error('expected error');
    } catch (error) {
      expect((error as DomainError).code).toBe('username_not_found');
      expect((error as DomainError).status).toBe(404);
    }
  });

  test('batch lookup omits unknown and deleted ids', async () => {
    const { service, unitOfWork } = setup();
    await seedProfile(unitOfWork, { userId: USER_IDS.bob, username: 'bob' });
    await seedProfile(unitOfWork, { userId: USER_IDS.carol, username: 'carol' });
    await unitOfWork.context.userProfiles.softDelete(USER_IDS.carol, new Date());

    const profiles = await service.getPublicProfilesByIds(claims(), [
      USER_IDS.bob,
      USER_IDS.carol,
      '99999999-9999-4999-8999-999999999999',
    ]);

    expect(profiles.map((profile) => profile.userId)).toEqual([USER_IDS.bob]);
  });

  test('batch limits are enforced as documented', async () => {
    const { service } = setup();
    const ids = Array.from({ length: 101 }, (_value, index) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );

    try {
      await service.getPublicProfilesByIds(claims(), ids);
      throw new Error('expected error');
    } catch (error) {
      expect((error as DomainError).code).toBe('batch_limit_exceeded');
      expect((error as DomainError).status).toBe(422);
    }

    try {
      await service.getPublicProfilesByIds(claims(), []);
      throw new Error('expected error');
    } catch (error) {
      expect((error as DomainError).code).toBe('validation_error');
    }
  });

  test('batch lookup deduplicates requested ids', async () => {
    const { service, unitOfWork } = setup();
    await seedProfile(unitOfWork, { userId: USER_IDS.bob, username: 'bob' });

    const profiles = await service.getPublicProfilesByIds(claims(), [USER_IDS.bob, USER_IDS.bob]);
    expect(profiles).toHaveLength(1);
  });

  test('id generator seam is available for deterministic fixtures', () => {
    expect(new FakeIdGenerator().newId()).toBe('00000000-0000-4000-8000-000000000001');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  clerkEventSchema,
  displayNameOf,
  primaryEmail,
  sanitizeUsername,
  toProfileFromClerkUser,
  toProfilePatchFromClerkUser,
} from '../../src/webhooks/clerkEventMapper';
import { clerkUserPayload, USER_IDS } from '../mocks/fixtures';

describe('Clerk event mapping', () => {
  test('maps a full user record onto mirror fields', () => {
    const profile = toProfileFromClerkUser(
      clerkEventSchema.parse({ type: 'user.created', data: clerkUserPayload() }).data,
    );

    expect(profile).toEqual({
      userId: USER_IDS.alice,
      username: 'alice',
      displayName: 'Alice Anderson',
      avatarUrl: 'https://cdn.example.com/alice.png',
      email: 'alice@example.com',
    });
  });

  test('lowercases and sanitizes the username; falls back when unusable', () => {
    expect(sanitizeUsername('  Pixel.Pioneer!! ', USER_IDS.alice)).toBe('pixel.pioneer');
    expect(sanitizeUsername('a', USER_IDS.alice)).toBe('user-111111111111');
    expect(sanitizeUsername('', USER_IDS.alice)).toBe('user-111111111111');
    expect(sanitizeUsername('x'.repeat(40), USER_IDS.alice)).toHaveLength(32);
  });

  test('prefers the primary email address', () => {
    const data = clerkEventSchema.parse({ type: 'user.updated', data: clerkUserPayload() }).data;
    expect(primaryEmail(data)).toBe('alice@example.com');
  });

  test('falls back to the first email when no primary is flagged', () => {
    const payload = clerkUserPayload();
    payload['primary_email_address_id'] = null;
    const data = clerkEventSchema.parse({ type: 'user.updated', data: payload }).data;
    expect(primaryEmail(data)).toBe('secondary@example.com');
  });

  test('returns an empty email when none are provided', () => {
    const data = clerkEventSchema.parse({
      type: 'user.updated',
      data: { id: USER_IDS.alice, username: 'alice' },
    }).data;
    expect(primaryEmail(data)).toBe('');
  });

  test('display name falls back to the username', () => {
    const data = clerkEventSchema.parse({
      type: 'user.updated',
      data: { id: USER_IDS.alice, username: 'alice', first_name: null, last_name: ' ' },
    }).data;
    expect(displayNameOf(data, 'alice')).toBe('alice');
  });

  test('patch exposes only the mirrored fields', () => {
    const data = clerkEventSchema.parse({
      type: 'user.updated',
      data: clerkUserPayload({ username: 'ALICE2' }),
    }).data;
    expect(toProfilePatchFromClerkUser(data)).toEqual({
      username: 'alice2',
      displayName: 'Alice Anderson',
      avatarUrl: 'https://cdn.example.com/alice.png',
      email: 'alice@example.com',
    });
  });

  test('rejects events with a non-uuid user id or missing fields', () => {
    expect(
      clerkEventSchema.safeParse({ type: 'user.created', data: { id: 'user_2abc' } }).success,
    ).toBe(false);
    expect(clerkEventSchema.safeParse({ type: 'user.created' }).success).toBe(false);
  });
});

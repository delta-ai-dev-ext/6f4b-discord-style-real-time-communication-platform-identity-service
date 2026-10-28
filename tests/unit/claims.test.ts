import { describe, expect, test } from 'bun:test';
import { fallbackUsername, mapClaims } from '../../src/auth/claims';
import { extractBearerToken } from '../../src/auth/clerkAuth';
import { DomainError } from '../../src/models/errors';
import { USER_IDS } from '../mocks/fixtures';

describe('claim mapping', () => {
  test.each([
    [
      'custom session template',
      {
        sub: USER_IDS.alice,
        username: 'Pixel_Pioneer',
        email: 'pixel@example.com',
        name: 'Pixel Pioneer',
      },
      {
        userId: USER_IDS.alice,
        username: 'Pixel_Pioneer',
        email: 'pixel@example.com',
        displayName: 'Pixel Pioneer',
      },
    ],
    [
      'missing username falls back to a stable alias',
      { sub: USER_IDS.bob, email: 'bob@example.com' },
      {
        userId: USER_IDS.bob,
        username: fallbackUsername(USER_IDS.bob),
        email: 'bob@example.com',
        displayName: fallbackUsername(USER_IDS.bob),
      },
    ],
    [
      'invalid username is replaced by the alias',
      { sub: USER_IDS.carol, username: 'a' },
      {
        userId: USER_IDS.carol,
        username: fallbackUsername(USER_IDS.carol),
        email: '',
        displayName: fallbackUsername(USER_IDS.carol),
      },
    ],
    [
      'blank display name falls back to the username',
      { sub: USER_IDS.alice, username: 'alice', name: '   ' },
      { userId: USER_IDS.alice, username: 'alice', email: '', displayName: 'alice' },
    ],
  ])('maps %s', (_name, payload, expected) => {
    expect(mapClaims(payload)).toEqual(expected);
  });

  test.each([
    ['missing payload', undefined],
    ['missing sub', { username: 'alice' }],
    ['non string sub', { sub: 42 }],
    ['non uuid sub', { sub: 'user_2abc' }],
  ])('rejects %s with 401 unauthorized', (_name, payload) => {
    try {
      mapClaims(payload as never);
      throw new Error('expected unauthorized');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('unauthorized');
      expect((error as DomainError).status).toBe(401);
    }
  });

  test('fallbackUsername is derived from the user id', () => {
    expect(fallbackUsername(USER_IDS.alice)).toBe('user-111111111111');
  });
});

describe('bearer token extraction', () => {
  test.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer lower', 'lower'],
    ['  Bearer   spaced  ', 'spaced'],
  ])('extracts from %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  test.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['wrong scheme', 'Basic abc'],
    ['no token', 'Bearer   '],
  ])('rejects %s', (_name, header) => {
    expect(() => extractBearerToken(header)).toThrow(DomainError);
  });
});

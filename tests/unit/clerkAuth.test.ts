import { describe, expect, test } from 'bun:test';
import { ClerkTokenVerifier } from '../../src/auth/clerkAuth';
import { DomainError } from '../../src/models/errors';
import { USER_IDS } from '../mocks/fixtures';

describe('ClerkTokenVerifier', () => {
  test('verifies offline with the configured public key and maps claims', async () => {
    const calls: Array<{ token: string; jwtKey: string }> = [];
    const verifier = new ClerkTokenVerifier({
      jwtKey: 'jwt-key',
      verifyFn: async (token, options) => {
        calls.push({ token, jwtKey: options.jwtKey });
        return { sub: USER_IDS.alice, username: 'alice', email: 'alice@example.com' };
      },
    });

    const claims = await verifier.verify('session-token');

    expect(claims).toEqual({
      userId: USER_IDS.alice,
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'alice',
    });
    expect(calls).toEqual([{ token: 'session-token', jwtKey: 'jwt-key' }]);
  });

  test('maps verification failures to 401 without leaking the token', async () => {
    const verifier = new ClerkTokenVerifier({
      jwtKey: 'jwt-key',
      verifyFn: async () => {
        throw new Error('signature mismatch for token super-secret');
      },
    });

    await expect(verifier.verify('super-secret')).rejects.toThrow(DomainError);
    try {
      await verifier.verify('super-secret');
    } catch (error) {
      expect((error as DomainError).status).toBe(401);
      expect((error as DomainError).message).not.toContain('super-secret');
    }
  });

  test('rejects an empty token and an undefined payload', async () => {
    const emptyVerifier = new ClerkTokenVerifier({ jwtKey: 'k' });
    await expect(emptyVerifier.verify('  ')).rejects.toThrow(DomainError);

    const undefinedVerifier = new ClerkTokenVerifier({
      jwtKey: 'k',
      verifyFn: async () => undefined,
    });
    await expect(undefinedVerifier.verify('token')).rejects.toThrow(DomainError);
  });
});

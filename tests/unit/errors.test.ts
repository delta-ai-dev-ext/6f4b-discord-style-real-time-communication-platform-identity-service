import { describe, expect, test } from 'bun:test';
import { type ERROR_CODES, DomainError, errors, toErrorBody } from '../../src/models/errors';

describe('domain errors', () => {
  const statusCases: Array<[keyof typeof ERROR_CODES, number]> = [
    ['validation_error', 400],
    ['self_request', 400],
    ['unauthorized', 401],
    ['invalid_signature', 401],
    ['username_not_found', 404],
    ['request_not_found', 404],
    ['friendship_not_found', 404],
    ['duplicate_request', 409],
    ['already_friends', 409],
    ['request_not_pending', 409],
    ['batch_limit_exceeded', 422],
    ['rate_limited', 429],
    ['internal_error', 500],
  ];

  test.each(statusCases)('maps %s to status %i', (code, status) => {
    const error = new DomainError(code, 'boom');
    expect(error.status).toBe(status);
    expect(toErrorBody(error)).toEqual({
      status,
      body: { error: { code, message: 'boom' } },
    });
  });

  test('error factories expose the stable platform codes', () => {
    expect(errors.usernameNotFound().code).toBe('username_not_found');
    expect(errors.requestNotFound().code).toBe('request_not_found');
    expect(errors.requestNotFoundForSender().message).toContain('sent by you');
    expect(errors.friendshipNotFound().code).toBe('friendship_not_found');
    expect(errors.selfRequest().status).toBe(400);
    expect(errors.duplicateRequest().status).toBe(409);
    expect(errors.alreadyFriends().status).toBe(409);
    expect(errors.requestNotPending().status).toBe(409);
    expect(errors.batchLimitExceeded(100).message).toContain('100');
    expect(errors.rateLimited().status).toBe(429);
    expect(errors.invalidSignature().status).toBe(401);
    expect(errors.unavailable().status).toBe(503);
  });

  test('details are only included when provided', () => {
    const withDetails = errors.validation([{ path: 'username', message: 'invalid' }]);
    expect(withDetails.toBody().error.details).toEqual([
      { path: 'username', message: 'invalid' },
    ]);
    expect(errors.unauthorized().toBody().error.details).toBeUndefined();
  });

  test('unknown errors become internal_error without leaking details', () => {
    const mapped = toErrorBody(new Error('connection refused for postgres://secret'));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
    });
  });
});

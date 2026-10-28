import { describe, expect, test } from 'bun:test';
import {
  canTransition,
  requireRecipientPending,
  requireSenderPending,
  targetStatus,
} from '../../src/services/friendStateMachine';
import type { FriendRequestRecord } from '../../src/models/domain';
import { DomainError, type ErrorCode } from '../../src/models/errors';
import { USER_IDS } from '../mocks/fixtures';

function request(overrides: Partial<FriendRequestRecord> = {}): FriendRequestRecord {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    senderUserId: USER_IDS.alice,
    recipientUserId: USER_IDS.bob,
    status: 'pending',
    createdAt: new Date('2025-01-15T12:00:00.000Z'),
    respondedAt: null,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: ErrorCode): void {
  try {
    fn();
    throw new Error('expected a domain error');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe('friend request state machine', () => {
  const guardCases: Array<{
    name: string;
    record: FriendRequestRecord | undefined;
    actor: string;
    guard: 'recipient' | 'sender';
    expected: string | null;
  }> = [
    { name: 'recipient accepts pending', record: request(), actor: USER_IDS.bob, guard: 'recipient', expected: null },
    { name: 'sender cannot accept own request', record: request(), actor: USER_IDS.alice, guard: 'recipient', expected: 'request_not_found' },
    { name: 'missing request', record: undefined, actor: USER_IDS.bob, guard: 'recipient', expected: 'request_not_found' },
    { name: 'already accepted', record: request({ status: 'accepted' }), actor: USER_IDS.bob, guard: 'recipient', expected: 'request_not_pending' },
    { name: 'already declined', record: request({ status: 'declined' }), actor: USER_IDS.bob, guard: 'recipient', expected: 'request_not_pending' },
    { name: 'cancelled request', record: request({ status: 'cancelled' }), actor: USER_IDS.bob, guard: 'recipient', expected: 'request_not_pending' },
    { name: 'sender cancels pending', record: request(), actor: USER_IDS.alice, guard: 'sender', expected: null },
    { name: 'recipient cannot cancel', record: request(), actor: USER_IDS.bob, guard: 'sender', expected: 'request_not_found' },
    { name: 'sender cannot cancel accepted', record: request({ status: 'accepted' }), actor: USER_IDS.alice, guard: 'sender', expected: 'request_not_pending' },
    { name: 'missing request for cancel', record: undefined, actor: USER_IDS.alice, guard: 'sender', expected: 'request_not_found' },
  ];

  test.each(guardCases)('$name', ({ record, actor, guard, expected }) => {
    const run = () =>
      guard === 'recipient' ? requireRecipientPending(record, actor) : requireSenderPending(record, actor);

    if (expected === null) {
      expect(run).not.toThrow();
    } else {
      expectCode(run, expected as ErrorCode);
    }
  });

  test('only pending requests can transition', () => {
    for (const status of ['accepted', 'declined', 'cancelled'] as const) {
      expect(canTransition(request({ status }), 'accept', USER_IDS.bob)).toBe(false);
    }
    expect(canTransition(request(), 'accept', USER_IDS.bob)).toBe(true);
    expect(canTransition(request(), 'accept', USER_IDS.alice)).toBe(false);
    expect(canTransition(request(), 'cancel', USER_IDS.alice)).toBe(true);
    expect(canTransition(request(), 'cancel', USER_IDS.bob)).toBe(false);
  });

  test('actions map to their terminal status', () => {
    expect(targetStatus('accept')).toBe('accepted');
    expect(targetStatus('decline')).toBe('declined');
    expect(targetStatus('cancel')).toBe('cancelled');
  });
});

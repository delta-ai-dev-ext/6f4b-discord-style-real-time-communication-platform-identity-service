import type { FriendRequestRecord, FriendRequestStatus } from '../models/domain';
import { errors } from '../models/errors';

/**
 * Friend-request state machine (pure functions).
 *
 * Transitions are only ever legal from `pending`; accept/decline are
 * recipient-only and cancel is sender-only. Every illegal move maps onto a
 * stable platform error code.
 */

export type FriendRequestAction = 'accept' | 'decline' | 'cancel';

const ACTION_TARGET: Record<FriendRequestAction, FriendRequestStatus> = {
  accept: 'accepted',
  decline: 'declined',
  cancel: 'cancelled',
};

export function targetStatus(action: FriendRequestAction): FriendRequestStatus {
  return ACTION_TARGET[action];
}

/**
 * Guards the recipient-only actions (accept, decline):
 * missing/foreign request → `request_not_found`, non-pending → `request_not_pending`.
 */
export function requireRecipientPending(
  request: FriendRequestRecord | undefined,
  actorUserId: string,
): FriendRequestRecord {
  if (request === undefined || request.recipientUserId !== actorUserId) {
    throw errors.requestNotFound();
  }
  if (request.status !== 'pending') {
    throw errors.requestNotPending();
  }
  return request;
}

/** Guards the sender-only cancel action. */
export function requireSenderPending(
  request: FriendRequestRecord | undefined,
  actorUserId: string,
): FriendRequestRecord {
  if (request === undefined || request.senderUserId !== actorUserId) {
    throw errors.requestNotFoundForSender();
  }
  if (request.status !== 'pending') {
    throw errors.requestNotPending();
  }
  return request;
}

/** Whether the request may move to `action`'s target state (no throwing). */
export function canTransition(
  request: FriendRequestRecord,
  action: FriendRequestAction,
  actorUserId: string,
): boolean {
  if (request.status !== 'pending') return false;
  return action === 'cancel'
    ? request.senderUserId === actorUserId
    : request.recipientUserId === actorUserId;
}

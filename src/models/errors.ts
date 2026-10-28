/**
 * Domain errors carry a stable machine-readable `code` plus the HTTP status
 * the transport layer must use. Services throw these; controllers only map
 * them onto the platform error contract `{error: {code, message, details?}}`.
 */

export const ERROR_CODES = {
  validation_error: 400,
  unauthorized: 401,
  invalid_signature: 401,
  username_not_found: 404,
  request_not_found: 404,
  friendship_not_found: 404,
  self_request: 400,
  duplicate_request: 409,
  already_friends: 409,
  request_not_pending: 409,
  batch_limit_exceeded: 422,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = ERROR_CODES[code];
    if (details !== undefined) {
      this.details = details;
    }
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) {
      body.error.details = this.details;
    }
    return body;
  }
}

export const errors = {
  validation: (details?: unknown) =>
    new DomainError('validation_error', 'Request body is invalid.', details),
  unauthorized: (message = 'A valid session token is required.') =>
    new DomainError('unauthorized', message),
  invalidSignature: () =>
    new DomainError('invalid_signature', 'Webhook signature verification failed.'),
  usernameNotFound: () =>
    new DomainError('username_not_found', 'No active user found with that username.'),
  requestNotFound: () =>
    new DomainError('request_not_found', 'No pending friend request addressed to you with that id.'),
  /** Cancel and accept/decline differ in who owns the request. */
  requestNotFoundForSender: () =>
    new DomainError('request_not_found', 'No pending friend request sent by you with that id.'),
  friendshipNotFound: () =>
    new DomainError('friendship_not_found', 'You are not friends with this user.'),
  selfRequest: () => new DomainError('self_request', 'You cannot send a friend request to yourself.'),
  duplicateRequest: () =>
    new DomainError('duplicate_request', 'A pending friend request already exists between you.'),
  alreadyFriends: () =>
    new DomainError('already_friends', 'You are already friends with this user.'),
  requestNotPending: () =>
    new DomainError('request_not_pending', 'This friend request is no longer pending.'),
  batchLimitExceeded: (limit: number) =>
    new DomainError('batch_limit_exceeded', `A batch may contain at most ${limit} user ids.`),
  rateLimited: () =>
    new DomainError('rate_limited', 'Too many friend requests. Please try again later.'),
  unavailable: () =>
    new DomainError('service_unavailable', 'The service is shutting down or unavailable.'),
  internal: (details?: unknown) =>
    new DomainError('internal_error', 'An unexpected error occurred.', details),
};

/** Maps any thrown value onto the platform error contract. */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof DomainError) {
    return { status: error.status, body: error.toBody() };
  }
  return { status: 500, body: errors.internal().toBody() };
}

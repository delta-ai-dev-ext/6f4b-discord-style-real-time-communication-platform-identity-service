import type {
  FriendRequestRecord,
  FriendshipRecord,
  NewUserProfileRecord,
  OutboxEventInsert,
  Page,
  PendingOutboxEvent,
  UserProfilePatch,
  UserProfileRecord,
} from '../models/domain';

/**
 * Repository ports (hexagonal architecture): services depend only on these
 * interfaces, the Drizzle adapters and the in-memory test adapters implement
 * them. No HTTP or driver types leak through.
 */

export interface UserProfileRepository {
  /** Case-insensitive exact match; excludes soft-deleted rows. */
  findActiveByUsername(username: string): Promise<UserProfileRecord | undefined>;
  findActiveById(userId: string): Promise<UserProfileRecord | undefined>;
  findActiveByIds(userIds: string[]): Promise<UserProfileRecord[]>;
  /** Includes soft-deleted rows — used by the webhook sync path. */
  findById(userId: string): Promise<UserProfileRecord | undefined>;
  /**
   * ADR-001 lazy bootstrap: insert-if-absent only. Returns the existing row
   * untouched when present (never overwrites webhook-maintained fields).
   */
  insertIfAbsent(profile: NewUserProfileRecord): Promise<{ inserted: boolean; profile: UserProfileRecord }>;
  /** `user.created`: insert or refresh the full mirrored record. */
  upsertFromWebhook(profile: NewUserProfileRecord): Promise<UserProfileRecord>;
  /** `user.updated`: patch the mirrored fields, leaving `deleted_at` alone. */
  updateFromWebhook(userId: string, patch: UserProfilePatch): Promise<UserProfileRecord | undefined>;
  /** `user.deleted`: sets `deleted_at` when the row exists and is active. */
  softDelete(userId: string, deletedAt: Date): Promise<boolean>;
}

export interface FriendRequestListParams {
  userId: string;
  direction: 'incoming' | 'outgoing';
  status: FriendRequestRecord['status'];
  limit: number;
  cursor?: string;
}

export interface FriendRequestRepository {
  insertPending(request: FriendRequestRecord): Promise<FriendRequestRecord>;
  findById(requestId: string): Promise<FriendRequestRecord | undefined>;
  /** Pending request between the pair, in either direction. */
  findPendingBetween(userIdA: string, userIdB: string): Promise<FriendRequestRecord | undefined>;
  list(params: FriendRequestListParams): Promise<Page<FriendRequestRecord>>;
  /**
   * Guarded transition: only applies when the row is still in `from`.
   * Returns `undefined` when the guard failed (state already moved).
   */
  transition(
    requestId: string,
    from: FriendRequestRecord['status'],
    to: FriendRequestRecord['status'],
    respondedAt: Date,
  ): Promise<FriendRequestRecord | undefined>;
  /** Webhook-driven cancellation of every pending request touching `userId`. */
  cancelPendingForUser(userId: string, respondedAt: Date): Promise<FriendRequestRecord[]>;
  /** Whether a pending request already exists in either direction. */
  hasPendingEitherDirection(userIdA: string, userIdB: string): Promise<boolean>;
}

export interface FriendshipRepository {
  findPair(userIdA: string, userIdB: string): Promise<FriendshipRecord | undefined>;
  /** Inserts the ordered pair; conflicting insert returns the existing row. */
  insertPair(userIdA: string, userIdB: string, createdAt: Date): Promise<FriendshipRecord>;
  listForUser(userId: string, params: { limit: number; cursor?: string }): Promise<Page<string>>;
  deletePair(userIdA: string, userIdB: string): Promise<boolean>;
}

export interface ProcessedWebhookRepository {
  /** Returns `true` when this delivery is new, `false` for a replay. */
  markProcessed(svixMessageId: string, eventType: string, receivedAt: Date): Promise<boolean>;
}

export interface OutboxRepository {
  enqueue(event: OutboxEventInsert): Promise<void>;
}

/** Read/write access handed to a unit of work (a single transaction). */
export interface TransactionContext {
  userProfiles: UserProfileRepository;
  friendRequests: FriendRequestRepository;
  friendships: FriendshipRepository;
  processedWebhooks: ProcessedWebhookRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export type OutboxDisposition =
  | { kind: 'published' }
  | { kind: 'retry'; error: string }
  | { kind: 'dead_letter'; error: string };

export type OutboxProcessResult = {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
};

/**
 * Outbox drain port (ADR-002). `claimAndProcess` claims pending rows with
 * `SELECT … FOR UPDATE SKIP LOCKED` inside one transaction and applies the
 * disposition returned by the handler while the locks are still held.
 */
export interface OutboxQueue {
  claimAndProcess(
    batchSize: number,
    handler: (event: PendingOutboxEvent) => Promise<OutboxDisposition>,
  ): Promise<OutboxProcessResult>;
  countPending(topic: string): Promise<number>;
}

/** Publishes one event to Kafka; the outbox worker consumes this port. */
export interface EventPublisher {
  topic: string;
  publish(event: PendingOutboxEvent): Promise<void>;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

export interface IdGeneratorPort {
  newId(): string;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
};

/**
 * The slice of the metrics registry services are allowed to touch. Keeping it
 * narrow means business logic never imports `prom-client`.
 */
export interface ServiceMetrics {
  recordFriendRequest(outcome: 'sent' | 'accepted' | 'declined' | 'cancelled'): void;
  recordUsernameLookup(result: 'found' | 'not_found'): void;
  recordUserSynced(event: 'created' | 'updated' | 'deleted'): void;
}

/** Metrics the outbox worker is allowed to record. */
export interface OutboxMetrics {
  recordProduceError(topic: string): void;
  setOutboxPending(topic: string, count: number): void;
  recordDeadLettered(topic: string): void;
}

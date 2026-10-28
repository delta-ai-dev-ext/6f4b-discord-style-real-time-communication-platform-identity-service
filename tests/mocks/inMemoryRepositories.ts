import type {
  FriendRequestRecord,
  FriendshipRecord,
  NewUserProfileRecord,
  OutboxEventInsert,
  Page,
  PendingOutboxEvent,
  UserProfilePatch,
  UserProfileRecord,
} from '../../src/models/domain';
import { decodeCursor, encodeCursor } from '../../src/services/cursor';
import type {
  EventPublisher,
  FriendRequestListParams,
  FriendRequestRepository,
  FriendshipRepository,
  OutboxDisposition,
  OutboxProcessResult,
  OutboxQueue,
  OutboxRepository,
  ProcessedWebhookRepository,
  TransactionContext,
  UnitOfWork,
  UserProfileRepository,
} from '../../src/repositories/ports';

export type InMemoryState = {
  profiles: UserProfileRecord[];
  requests: FriendRequestRecord[];
  friendships: FriendshipRecord[];
  processed: Map<string, string>;
  outbox: PendingOutboxEvent[];
};

type Snapshot = {
  profiles: UserProfileRecord[];
  requests: FriendRequestRecord[];
  friendships: FriendshipRecord[];
  processed: [string, string][];
  outbox: PendingOutboxEvent[];
};

function cloneState(state: InMemoryState): Snapshot {
  return {
    profiles: state.profiles.map((profile) => ({ ...profile })),
    requests: state.requests.map((request) => ({ ...request })),
    friendships: state.friendships.map((friendship) => ({ ...friendship })),
    processed: [...state.processed.entries()],
    outbox: state.outbox.map((event) => ({ ...event })),
  };
}

function restoreState(state: InMemoryState, snapshot: Snapshot): void {
  state.profiles = snapshot.profiles.map((profile) => ({ ...profile }));
  state.requests = snapshot.requests.map((request) => ({ ...request }));
  state.friendships = snapshot.friendships.map((friendship) => ({ ...friendship }));
  state.processed = new Map(snapshot.processed);
  state.outbox = snapshot.outbox.map((event) => ({ ...event }));
}

export class InMemoryUserProfileRepository implements UserProfileRepository {
  constructor(private readonly state: InMemoryState) {}

  async findActiveByUsername(username: string): Promise<UserProfileRecord | undefined> {
    return this.state.profiles.find(
      (profile) =>
        profile.username === username.toLowerCase() && profile.deletedAt === null,
    );
  }

  async findActiveById(userId: string): Promise<UserProfileRecord | undefined> {
    return this.state.profiles.find(
      (profile) => profile.userId === userId && profile.deletedAt === null,
    );
  }

  async findActiveByIds(userIds: string[]): Promise<UserProfileRecord[]> {
    return this.state.profiles.filter(
      (profile) => userIds.includes(profile.userId) && profile.deletedAt === null,
    );
  }

  async findById(userId: string): Promise<UserProfileRecord | undefined> {
    return this.state.profiles.find((profile) => profile.userId === userId);
  }

  async insertIfAbsent(
    profile: NewUserProfileRecord,
  ): Promise<{ inserted: boolean; profile: UserProfileRecord }> {
    const existing = await this.findById(profile.userId);
    if (existing !== undefined) return { inserted: false, profile: existing };

    const created: UserProfileRecord = {
      ...profile,
      username: profile.username.toLowerCase(),
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    this.state.profiles.push(created);
    return { inserted: true, profile: created };
  }

  async upsertFromWebhook(profile: NewUserProfileRecord): Promise<UserProfileRecord> {
    const existing = await this.findById(profile.userId);
    if (existing === undefined) {
      const created: UserProfileRecord = {
        ...profile,
        username: profile.username.toLowerCase(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      this.state.profiles.push(created);
      return created;
    }

    existing.username = profile.username.toLowerCase();
    existing.displayName = profile.displayName;
    existing.avatarUrl = profile.avatarUrl;
    existing.email = profile.email;
    existing.deletedAt = null;
    existing.updatedAt = new Date();
    return existing;
  }

  async updateFromWebhook(
    userId: string,
    patch: UserProfilePatch,
  ): Promise<UserProfileRecord | undefined> {
    const existing = await this.findById(userId);
    if (existing === undefined) return undefined;
    if (patch.username !== undefined) existing.username = patch.username.toLowerCase();
    if (patch.displayName !== undefined) existing.displayName = patch.displayName;
    if (patch.avatarUrl !== undefined) existing.avatarUrl = patch.avatarUrl;
    if (patch.email !== undefined) existing.email = patch.email;
    existing.updatedAt = new Date();
    return existing;
  }

  async softDelete(userId: string, deletedAt: Date): Promise<boolean> {
    const existing = await this.findById(userId);
    if (existing === undefined || existing.deletedAt !== null) return false;
    existing.deletedAt = deletedAt;
    return true;
  }
}

export class InMemoryFriendRequestRepository implements FriendRequestRepository {
  constructor(private readonly state: InMemoryState) {}

  async insertPending(request: FriendRequestRecord): Promise<FriendRequestRecord> {
    const duplicate = this.state.requests.find(
      (candidate) =>
        candidate.status === 'pending' &&
        candidate.senderUserId === request.senderUserId &&
        candidate.recipientUserId === request.recipientUserId,
    );
    if (duplicate !== undefined) {
      const error = new Error('duplicate key value violates unique constraint');
      Object.assign(error, { code: '23505', constraint: 'friend_request_pending_pair_idx' });
      throw error;
    }
    const stored: FriendRequestRecord = { ...request, status: 'pending' };
    this.state.requests.push(stored);
    return stored;
  }

  async findById(requestId: string): Promise<FriendRequestRecord | undefined> {
    return this.state.requests.find((request) => request.requestId === requestId);
  }

  async findPendingBetween(
    userIdA: string,
    userIdB: string,
  ): Promise<FriendRequestRecord | undefined> {
    return this.state.requests.find(
      (request) =>
        request.status === 'pending' &&
        ((request.senderUserId === userIdA && request.recipientUserId === userIdB) ||
          (request.senderUserId === userIdB && request.recipientUserId === userIdA)),
    );
  }

  async hasPendingEitherDirection(userIdA: string, userIdB: string): Promise<boolean> {
    return (await this.findPendingBetween(userIdA, userIdB)) !== undefined;
  }

  async list(params: FriendRequestListParams): Promise<Page<FriendRequestRecord>> {
    const ownerId = params.direction === 'incoming' ? 'recipientUserId' : 'senderUserId';
    const filtered = this.state.requests
      .filter(
        (request) =>
          request[ownerId] === params.userId && request.status === params.status,
      )
      .sort((a, b) => {
        const delta = b.createdAt.getTime() - a.createdAt.getTime();
        return delta !== 0 ? delta : b.requestId.localeCompare(a.requestId);
      });

    const start = params.cursor === undefined ? 0 : Number(decodeCursor(params.cursor)[0]);
    const page = filtered.slice(start, start + params.limit);
    const nextIndex = start + params.limit;
    const nextCursor =
      nextIndex < filtered.length ? encodeCursor([nextIndex, 'offset']) : null;

    return { rows: page, nextCursor };
  }

  async transition(
    requestId: string,
    from: FriendRequestRecord['status'],
    to: FriendRequestRecord['status'],
    respondedAt: Date,
  ): Promise<FriendRequestRecord | undefined> {
    const request = this.state.requests.find((candidate) => candidate.requestId === requestId);
    if (request === undefined || request.status !== from) return undefined;
    request.status = to;
    request.respondedAt = respondedAt;
    return request;
  }

  async cancelPendingForUser(
    userId: string,
    respondedAt: Date,
  ): Promise<FriendRequestRecord[]> {
    const cancelled: FriendRequestRecord[] = [];
    for (const request of this.state.requests) {
      if (
        request.status === 'pending' &&
        (request.senderUserId === userId || request.recipientUserId === userId)
      ) {
        request.status = 'cancelled';
        request.respondedAt = respondedAt;
        cancelled.push(request);
      }
    }
    return cancelled;
  }
}

export class InMemoryFriendshipRepository implements FriendshipRepository {
  constructor(private readonly state: InMemoryState) {}

  private order(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  async findPair(userIdA: string, userIdB: string): Promise<FriendshipRecord | undefined> {
    const [a, b] = this.order(userIdA, userIdB);
    return this.state.friendships.find(
      (friendship) => friendship.userIdA === a && friendship.userIdB === b,
    );
  }

  async insertPair(
    userIdA: string,
    userIdB: string,
    createdAt: Date,
  ): Promise<FriendshipRecord> {
    const existing = await this.findPair(userIdA, userIdB);
    if (existing !== undefined) return existing;
    const [a, b] = this.order(userIdA, userIdB);
    const created: FriendshipRecord = { userIdA: a, userIdB: b, createdAt };
    this.state.friendships.push(created);
    return created;
  }

  async listForUser(
    userId: string,
    params: { limit: number; cursor?: string },
  ): Promise<Page<string>> {
    const rows = this.state.friendships
      .filter((friendship) => friendship.userIdA === userId || friendship.userIdB === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((friendship) => (friendship.userIdA === userId ? friendship.userIdB : friendship.userIdA));

    const start = params.cursor === undefined ? 0 : Number(decodeCursor(params.cursor)[0]);
    const page = rows.slice(start, start + params.limit);
    const nextIndex = start + params.limit;
    const nextCursor = nextIndex < rows.length ? encodeCursor([nextIndex, 'offset']) : null;
    return { rows: page, nextCursor };
  }

  async deletePair(userIdA: string, userIdB: string): Promise<boolean> {
    const [a, b] = this.order(userIdA, userIdB);
    const index = this.state.friendships.findIndex(
      (friendship) => friendship.userIdA === a && friendship.userIdB === b,
    );
    if (index < 0) return false;
    this.state.friendships.splice(index, 1);
    return true;
  }
}

export class InMemoryProcessedWebhookRepository implements ProcessedWebhookRepository {
  constructor(private readonly state: InMemoryState) {}

  async markProcessed(
    svixMessageId: string,
    eventType: string,
    _receivedAt: Date,
  ): Promise<boolean> {
    if (this.state.processed.has(svixMessageId)) return false;
    this.state.processed.set(svixMessageId, eventType);
    return true;
  }
}

export class InMemoryOutboxRepository implements OutboxRepository {
  constructor(private readonly state: InMemoryState) {}

  async enqueue(event: OutboxEventInsert): Promise<void> {
    this.state.outbox.push({
      eventId: event.eventId,
      topic: event.topic,
      partitionKey: event.partitionKey,
      eventType: event.eventType,
      payload: event.payload,
      headers: event.headers,
      attempts: 0,
      createdAt: new Date(),
    });
  }
}

/**
 * In-memory unit of work with transactional semantics: the state is snapshot
 * before the callback and restored when it throws.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  readonly state: InMemoryState;

  constructor(state?: InMemoryState) {
    this.state =
      state ??
      {
        profiles: [],
        requests: [],
        friendships: [],
        processed: new Map<string, string>(),
        outbox: [],
      };
  }

  get context(): TransactionContext {
    return {
      userProfiles: new InMemoryUserProfileRepository(this.state),
      friendRequests: new InMemoryFriendRequestRepository(this.state),
      friendships: new InMemoryFriendshipRepository(this.state),
      processedWebhooks: new InMemoryProcessedWebhookRepository(this.state),
      outbox: new InMemoryOutboxRepository(this.state),
    };
  }

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const snapshot = cloneState(this.state);
    try {
      return await work(this.context);
    } catch (error) {
      restoreState(this.state, snapshot);
      throw error;
    }
  }
}

/** Records published outbox events; can be scripted to fail N times. */
export class FakeEventPublisher implements EventPublisher {
  readonly topic = 'identity_friend_events';
  readonly published: PendingOutboxEvent[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  private connected = false;
  private failures = 0;

  failNext(times = 1): void {
    this.failures = times;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  async publish(event: PendingOutboxEvent): Promise<void> {
    if (!this.connected) throw new Error('not connected');
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('kafka unavailable');
    }
    this.published.push(event);
  }
}

/** Outbox queue backed by the in-memory state. */
export class InMemoryOutboxQueue implements OutboxQueue {
  constructor(private readonly state: InMemoryState) {}

  async claimAndProcess(
    batchSize: number,
    handler: (event: PendingOutboxEvent) => Promise<OutboxDisposition>,
  ): Promise<OutboxProcessResult> {
    const pending = this.state.outbox.slice(0, batchSize);
    const result: OutboxProcessResult = {
      claimed: pending.length,
      published: 0,
      retried: 0,
      deadLettered: 0,
    };

    for (const event of pending) {
      const disposition = await handler(event);
      if (disposition.kind === 'published') {
        this.state.outbox = this.state.outbox.filter((row) => row.eventId !== event.eventId);
        result.published += 1;
        continue;
      }
      event.attempts += 1;
      event.headers = { ...event.headers, last_error: disposition.error };
      if (disposition.kind === 'dead_letter') {
        this.state.outbox = this.state.outbox.filter((row) => row.eventId !== event.eventId);
        result.deadLettered += 1;
      } else {
        result.retried += 1;
      }
    }

    return result;
  }

  async countPending(topic: string): Promise<number> {
    return this.state.outbox.filter((event) => event.topic === topic).length;
  }
}

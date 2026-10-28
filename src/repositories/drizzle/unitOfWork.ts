import type { Database } from '../../db/pool';
import type { TransactionContext, UnitOfWork } from '../ports';
import { DrizzleFriendRequestRepository } from './friendRequestRepository';
import { DrizzleFriendshipRepository } from './friendshipRepository';
import {
  DrizzleOutboxRepository,
  DrizzleProcessedWebhookRepository,
} from './outboxRepository';
import { DrizzleUserProfileRepository } from './userProfileRepository';

/** Builds the repository bundle bound to one connection/transaction. */
export function createTransactionContext(exec: Database | Parameters<Parameters<Database['transaction']>[0]>[0]): TransactionContext {
  return {
    userProfiles: new DrizzleUserProfileRepository(exec),
    friendRequests: new DrizzleFriendRequestRepository(exec),
    friendships: new DrizzleFriendshipRepository(exec),
    processedWebhooks: new DrizzleProcessedWebhookRepository(exec),
    outbox: new DrizzleOutboxRepository(exec),
  };
}

/**
 * Drizzle-backed unit of work: every callback runs inside a single PostgreSQL
 * transaction, so friend-request transitions, friendship writes and outbox
 * rows commit (or roll back) together.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(createTransactionContext(tx)));
  }
}

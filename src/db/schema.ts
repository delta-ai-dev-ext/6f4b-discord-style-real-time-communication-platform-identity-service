import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of the normative PostgreSQL schema in
 * `docs/architecture.md` §4. Identifiers stay snake_case; all timestamps are
 * `timestamptz`; every primary key is a `uuid`.
 */

/** `pending → accepted | declined | cancelled`; terminal states never move. */
export const friendRequestStatus = pgEnum('friend_request_status', [
  'pending',
  'accepted',
  'declined',
  'cancelled',
]);

/**
 * Mirror of Clerk users. `deleted_at` soft-deletes: the row (and therefore the
 * username) stays reserved, but lookups exclude it.
 */
export const userProfile = pgTable(
  'user_profile',
  {
    userId: uuid('user_id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url').notNull().default(''),
    email: text('email').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Named explicitly so the constraint name stays part of the schema contract.
    unique('user_profile_username_unique').on(table.username),
    index('user_profile_deleted_at_idx').on(table.deletedAt),
    check('user_profile_username_format', sql`${table.username} ~ '^[a-z0-9._-]{2,32}$'`),
  ],
);

/** Friend-request lifecycle rows; history is retained after the pending state. */
export const friendRequest = pgTable(
  'friend_request',
  {
    requestId: uuid('request_id').primaryKey(),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => userProfile.userId),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => userProfile.userId),
    status: friendRequestStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (table) => [
    check('friend_request_no_self', sql`${table.senderUserId} <> ${table.recipientUserId}`),
    // At most one live (pending) request per ordered pair.
    uniqueIndex('friend_request_pending_pair_idx')
      .on(table.senderUserId, table.recipientUserId)
      .where(sql`status = 'pending'`),
    index('friend_request_recipient_pending_idx')
      .on(table.recipientUserId, table.createdAt.desc())
      .where(sql`status = 'pending'`),
    index('friend_request_sender_pending_idx')
      .on(table.senderUserId, table.createdAt.desc())
      .where(sql`status = 'pending'`),
  ],
);

/** Unordered mutual pair stored with `user_id_a < user_id_b`. */
export const friendship = pgTable(
  'friendship',
  {
    userIdA: uuid('user_id_a')
      .notNull()
      .references(() => userProfile.userId),
    userIdB: uuid('user_id_b')
      .notNull()
      .references(() => userProfile.userId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userIdA, table.userIdB] }),
    check('friendship_pair_ordered', sql`${table.userIdA} < ${table.userIdB}`),
    index('friendship_b_idx').on(table.userIdB),
  ],
);

/** Idempotency ledger for Clerk (Svix) deliveries. */
export const processedWebhook = pgTable('processed_webhook', {
  svixMessageId: text('svix_message_id').primaryKey(),
  eventType: text('event_type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Transactional outbox (ADR-002). `published_at IS NULL` means pending. */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    eventId: uuid('event_id').primaryKey(),
    topic: text('topic').notNull().default('identity_friend_events'),
    partitionKey: uuid('partition_key').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (table) => [
    index('outbox_event_pending_idx')
      .on(table.createdAt)
      .where(sql`published_at IS NULL`),
  ],
);

export type UserProfileRow = typeof userProfile.$inferSelect;
export type FriendRequestRow = typeof friendRequest.$inferSelect;
export type FriendshipRow = typeof friendship.$inferSelect;
export type ProcessedWebhookRow = typeof processedWebhook.$inferSelect;
export type OutboxEventRow = typeof outboxEvent.$inferSelect;

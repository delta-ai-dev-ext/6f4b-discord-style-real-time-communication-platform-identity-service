import { and, eq, or, sql } from 'drizzle-orm';
import { friendRequest } from '../../db/schema';
import type { Database } from '../../db/pool';
import type { FriendRequestRecord, Page } from '../../models/domain';
import { encodeCursor } from '../../services/cursor';
import { decodeCursor } from '../../services/cursor';
import type { FriendRequestListParams, FriendRequestRepository } from '../ports';
import type { DbExecutor } from './userProfileRepository';
import { toFriendRequestRecord } from './rows';

/** Drizzle adapter for `friend_request` (state machine persistence). */
export class DrizzleFriendRequestRepository implements FriendRequestRepository {
  private readonly exec: DbExecutor;

  constructor(exec: DbExecutor) {
    this.exec = exec;
  }

  private get db(): Database {
    return this.exec as unknown as Database;
  }

  async insertPending(request: FriendRequestRecord): Promise<FriendRequestRecord> {
    const rows = await this.db
      .insert(friendRequest)
      .values({
        requestId: request.requestId,
        senderUserId: request.senderUserId,
        recipientUserId: request.recipientUserId,
        status: 'pending',
        createdAt: request.createdAt,
        respondedAt: null,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('friend_request insert returned no row');
    return toFriendRequestRecord(row);
  }

  async findById(requestId: string): Promise<FriendRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.requestId, requestId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toFriendRequestRecord(row);
  }

  async findPendingBetween(
    userIdA: string,
    userIdB: string,
  ): Promise<FriendRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(friendRequest)
      .where(
        and(
          eq(friendRequest.status, 'pending'),
          or(
            and(
              eq(friendRequest.senderUserId, userIdA),
              eq(friendRequest.recipientUserId, userIdB),
            ),
            and(
              eq(friendRequest.senderUserId, userIdB),
              eq(friendRequest.recipientUserId, userIdA),
            ),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toFriendRequestRecord(row);
  }

  async hasPendingEitherDirection(userIdA: string, userIdB: string): Promise<boolean> {
    return (await this.findPendingBetween(userIdA, userIdB)) !== undefined;
  }

  async list(params: FriendRequestListParams): Promise<Page<FriendRequestRecord>> {
    const ownerColumn =
      params.direction === 'incoming' ? friendRequest.recipientUserId : friendRequest.senderUserId;

    const filters = [eq(ownerColumn, params.userId), eq(friendRequest.status, params.status)];
    if (params.cursor !== undefined) {
      const [cursorCreatedAt, cursorId] = decodeCursor(params.cursor);
      if (cursorCreatedAt === undefined || cursorId === undefined) {
        throw new Error('invalid cursor');
      }
      // Rows strictly "after" the cursor in (created_at DESC, request_id DESC) order.
      filters.push(
        sql`(${friendRequest.createdAt}, ${friendRequest.requestId}) < (${new Date(Number(cursorCreatedAt))}, ${cursorId})`,
      );
    }

    const rows = await this.db
      .select()
      .from(friendRequest)
      .where(and(...filters))
      .orderBy(
        sql`${friendRequest.createdAt} DESC`,
        sql`${friendRequest.requestId} DESC`,
      )
      .limit(params.limit + 1);

    const page = rows.slice(0, params.limit).map(toFriendRequestRecord);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > params.limit && last !== undefined
        ? encodeCursor([last.createdAt.getTime(), last.requestId])
        : null;

    return { rows: page, nextCursor };
  }

  async transition(
    requestId: string,
    from: FriendRequestRecord['status'],
    to: FriendRequestRecord['status'],
    respondedAt: Date,
  ): Promise<FriendRequestRecord | undefined> {
    const rows = await this.db
      .update(friendRequest)
      .set({ status: to, respondedAt })
      .where(and(eq(friendRequest.requestId, requestId), eq(friendRequest.status, from)))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toFriendRequestRecord(row);
  }

  async cancelPendingForUser(userId: string, respondedAt: Date): Promise<FriendRequestRecord[]> {
    const rows = await this.db
      .update(friendRequest)
      .set({ status: 'cancelled', respondedAt })
      .where(
        and(
          eq(friendRequest.status, 'pending'),
          or(
            eq(friendRequest.senderUserId, userId),
            eq(friendRequest.recipientUserId, userId),
          ),
        ),
      )
      .returning();
    return rows.map(toFriendRequestRecord);
  }
}

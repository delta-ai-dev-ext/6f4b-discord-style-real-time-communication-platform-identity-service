import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/pool';
import { friendship } from '../../db/schema';
import type { FriendshipRecord, Page } from '../../models/domain';
import { decodeCursor, encodeCursor } from '../../services/cursor';
import type { FriendshipRepository } from '../ports';
import { orderPair, toFriendshipRecord } from './rows';
import type { DbExecutor } from './userProfileRepository';

/** Drizzle adapter for the ordered-pair `friendship` table. */
export class DrizzleFriendshipRepository implements FriendshipRepository {
  private readonly exec: DbExecutor;

  constructor(exec: DbExecutor) {
    this.exec = exec;
  }

  private get db(): Database {
    return this.exec as Database;
  }

  async findPair(userIdA: string, userIdB: string): Promise<FriendshipRecord | undefined> {
    const [a, b] = orderPair(userIdA, userIdB);
    const rows = await this.db
      .select()
      .from(friendship)
      .where(and(eq(friendship.userIdA, a), eq(friendship.userIdB, b)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toFriendshipRecord(row);
  }

  async insertPair(
    userIdA: string,
    userIdB: string,
    createdAt: Date,
  ): Promise<FriendshipRecord> {
    const [a, b] = orderPair(userIdA, userIdB);
    const rows = await this.db
      .insert(friendship)
      .values({ userIdA: a, userIdB: b, createdAt })
      .onConflictDoNothing({ target: [friendship.userIdA, friendship.userIdB] })
      .returning();

    const row = rows[0];
    if (row !== undefined) return toFriendshipRecord(row);

    const existing = await this.db
      .select()
      .from(friendship)
      .where(and(eq(friendship.userIdA, a), eq(friendship.userIdB, b)))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) {
      throw new Error('friendship insert conflicted without an existing row');
    }
    return toFriendshipRecord(existingRow);
  }

  async listForUser(
    userId: string,
    params: { limit: number; cursor?: string },
  ): Promise<Page<string>> {
    const filters = [
      sql`(${friendship.userIdA} = ${userId} OR ${friendship.userIdB} = ${userId})`,
    ];

    if (params.cursor !== undefined) {
      const [createdAtMs, cursorA, cursorB] = decodeCursor(params.cursor);
      if (createdAtMs === undefined || cursorA === undefined || cursorB === undefined) {
        throw new Error('invalid cursor');
      }
      filters.push(
        sql`(${friendship.createdAt}, ${friendship.userIdA}, ${friendship.userIdB}) < (${new Date(Number(createdAtMs))}, ${cursorA}, ${cursorB})`,
      );
    }

    const rows = await this.db
      .select()
      .from(friendship)
      .where(and(...filters))
      .orderBy(
        sql`${friendship.createdAt} DESC`,
        sql`${friendship.userIdA} DESC`,
        sql`${friendship.userIdB} DESC`,
      )
      .limit(params.limit + 1);

    const pageRows = rows.slice(0, params.limit);
    const friendIds = pageRows.map((row) => (row.userIdA === userId ? row.userIdB : row.userIdA));
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > params.limit && last !== undefined
        ? encodeCursor([last.createdAt.getTime(), last.userIdA, last.userIdB])
        : null;

    return { rows: friendIds, nextCursor };
  }

  async deletePair(userIdA: string, userIdB: string): Promise<boolean> {
    const [a, b] = orderPair(userIdA, userIdB);
    const rows = await this.db
      .delete(friendship)
      .where(and(eq(friendship.userIdA, a), eq(friendship.userIdB, b)))
      .returning({ userIdA: friendship.userIdA });
    return rows.length > 0;
  }
}

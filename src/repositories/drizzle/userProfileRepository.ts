import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../db/pool';
import { userProfile } from '../../db/schema';
import type {
  NewUserProfileRecord,
  UserProfilePatch,
  UserProfileRecord,
} from '../../models/domain';
import type { UserProfileRepository } from '../ports';
import { toUserProfileRecord } from './rows';

type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbExecutor = Database | DbTransaction;

/** Drizzle adapter for the `user_profile` mirror table. */
export class DrizzleUserProfileRepository implements UserProfileRepository {
  private readonly exec: DbExecutor;

  constructor(exec: DbExecutor) {
    this.exec = exec;
  }

  /** The transaction handle exposes the same query builder surface. */
  private get db(): Database {
    return this.exec as Database;
  }

  async findActiveByUsername(username: string): Promise<UserProfileRecord | undefined> {
    const rows = await this.db
      .select()
      .from(userProfile)
      .where(and(eq(userProfile.username, username.toLowerCase()), isNull(userProfile.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toUserProfileRecord(row);
  }

  async findActiveById(userId: string): Promise<UserProfileRecord | undefined> {
    const rows = await this.db
      .select()
      .from(userProfile)
      .where(and(eq(userProfile.userId, userId), isNull(userProfile.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toUserProfileRecord(row);
  }

  async findActiveByIds(userIds: string[]): Promise<UserProfileRecord[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(userProfile)
      .where(and(inArray(userProfile.userId, userIds), isNull(userProfile.deletedAt)));
    return rows.map(toUserProfileRecord);
  }

  async findById(userId: string): Promise<UserProfileRecord | undefined> {
    const rows = await this.db
      .select()
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toUserProfileRecord(row);
  }

  async insertIfAbsent(
    profile: NewUserProfileRecord,
  ): Promise<{ inserted: boolean; profile: UserProfileRecord }> {
    const inserted = await this.db
      .insert(userProfile)
      .values({
        userId: profile.userId,
        username: profile.username.toLowerCase(),
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        email: profile.email,
      })
      .onConflictDoNothing({ target: userProfile.userId })
      .returning();

    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { inserted: true, profile: toUserProfileRecord(insertedRow) };
    }

    const existing = await this.findById(profile.userId);
    if (existing === undefined) {
      // Should be unreachable: the conflict target is the primary key.
      throw new Error('user_profile insert conflicted without an existing row');
    }
    return { inserted: false, profile: existing };
  }

  async upsertFromWebhook(profile: NewUserProfileRecord): Promise<UserProfileRecord> {
    const now = new Date();
    const rows = await this.db
      .insert(userProfile)
      .values({
        userId: profile.userId,
        username: profile.username.toLowerCase(),
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        email: profile.email,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          username: profile.username.toLowerCase(),
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          email: profile.email,
          updatedAt: now,
          deletedAt: null,
        },
      })
      .returning();

    const row = rows[0];
    if (row === undefined) {
      throw new Error('user_profile upsert returned no row');
    }
    return toUserProfileRecord(row);
  }

  async updateFromWebhook(
    userId: string,
    patch: UserProfilePatch,
  ): Promise<UserProfileRecord | undefined> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.username !== undefined) updates['username'] = patch.username.toLowerCase();
    if (patch.displayName !== undefined) updates['displayName'] = patch.displayName;
    if (patch.avatarUrl !== undefined) updates['avatarUrl'] = patch.avatarUrl;
    if (patch.email !== undefined) updates['email'] = patch.email;

    const rows = await this.db
      .update(userProfile)
      .set(updates)
      .where(eq(userProfile.userId, userId))
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toUserProfileRecord(row);
  }

  async softDelete(userId: string, deletedAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(userProfile)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(and(eq(userProfile.userId, userId), isNull(userProfile.deletedAt)))
      .returning({ userId: userProfile.userId });
    return rows.length > 0;
  }
}

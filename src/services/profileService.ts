import { errors } from '../models/errors';
import type { UserProfileRecord } from '../models/domain';
import type { ServiceMetrics, TransactionContext, UnitOfWork } from '../repositories/ports';
import { ensureCallerProfile } from './callerProfile';

/** Verified Clerk session claims attached to the request context. */
export type AuthClaims = {
  userId: string;
  username: string;
  displayName?: string;
  email: string;
};

export const BATCH_LIMIT = 100;

export type ProfileServiceDeps = {
  unitOfWork: UnitOfWork;
  metrics: ServiceMetrics;
};

/**
 * Profile mirror use cases: own profile (with ADR-001 lazy bootstrap), exact
 * case-insensitive username lookup and batch resolution.
 */
export class ProfileService {
  private readonly unitOfWork: UnitOfWork;
  private readonly metrics: ServiceMetrics;

  constructor(deps: ProfileServiceDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.metrics = deps.metrics;
  }

  /**
   * ADR-001: insert-if-absent from the verified claims. Never overwrites
   * webhook-maintained fields and never touches third-party rows.
   */
  async ensureCallerProfile(tx: TransactionContext, claims: AuthClaims): Promise<UserProfileRecord> {
    return ensureCallerProfile(tx, claims, this.metrics);
  }

  async getMyProfile(claims: AuthClaims): Promise<UserProfileRecord> {
    return this.unitOfWork.run(async (tx) => this.ensureCallerProfile(tx, claims));
  }

  async getByUsername(claims: AuthClaims, username: string): Promise<UserProfileRecord> {
    return this.unitOfWork.run(async (tx) => {
      await this.ensureCallerProfile(tx, claims);

      const profile = await tx.userProfiles.findActiveByUsername(username.toLowerCase());
      if (profile === undefined) {
        this.metrics.recordUsernameLookup('not_found');
        throw errors.usernameNotFound();
      }

      this.metrics.recordUsernameLookup('found');
      return profile;
    });
  }

  /** Ids that do not resolve to an active user are silently omitted. */
  async getPublicProfilesByIds(claims: AuthClaims, userIds: string[]): Promise<UserProfileRecord[]> {
    if (userIds.length === 0) {
      throw errors.validation({ user_ids: 'user_ids must contain at least one id' });
    }
    if (userIds.length > BATCH_LIMIT) {
      throw errors.batchLimitExceeded(BATCH_LIMIT);
    }

    return this.unitOfWork.run(async (tx) => {
      await this.ensureCallerProfile(tx, claims);
      const unique = [...new Set(userIds)];
      return tx.userProfiles.findActiveByIds(unique);
    });
  }
}

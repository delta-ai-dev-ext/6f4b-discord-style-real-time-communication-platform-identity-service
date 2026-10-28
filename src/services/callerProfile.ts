import type { UserProfileRecord } from '../models/domain';
import type { ServiceMetrics, TransactionContext } from '../repositories/ports';
import type { AuthClaims } from './profileService';

/**
 * ADR-001 lazy bootstrap, shared by every profile-touching use case:
 * insert-if-absent from the verified JWT claims, never overwriting a
 * webhook-maintained row, and counting `identity_users_synced_total{event=created}`.
 */
export async function ensureCallerProfile(
  tx: TransactionContext,
  claims: AuthClaims,
  metrics: ServiceMetrics,
): Promise<UserProfileRecord> {
  const username = claims.username.toLowerCase();
  const { inserted, profile } = await tx.userProfiles.insertIfAbsent({
    userId: claims.userId,
    username,
    displayName: claims.displayName ?? username,
    avatarUrl: '',
    email: claims.email,
  });

  if (inserted) {
    metrics.recordUserSynced('created');
  }

  return profile;
}

import { z } from 'zod';
import { errors } from '../models/errors';
import type { AuthClaims } from '../services/profileService';

/**
 * Claim mapping for offline Clerk session verification.
 *
 * The session token template carries `sub` (platform user id), `username` and
 * `email`. `sub` is mandatory and must be a uuid, matching the database
 * primary key. Optional `name` becomes the lazily bootstrapped display name.
 */

const uuidSchema = z.string().uuid();
const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,32}$/);

export type ClerkJwtPayload = {
  sub?: unknown;
  username?: unknown;
  email?: unknown;
  name?: unknown;
  exp?: unknown;
  [key: string]: unknown;
};

export function fallbackUsername(userId: string): string {
  return `user-${userId.replace(/-/g, '').slice(0, 12)}`;
}

/** Pure mapping: verified JWT payload → request auth context. */
export function mapClaims(payload: ClerkJwtPayload | null | undefined): AuthClaims {
  if (payload === null || payload === undefined) {
    throw errors.unauthorized('Session token could not be verified.');
  }

  const sub = payload['sub'];
  if (typeof sub !== 'string' || uuidSchema.safeParse(sub).success === false) {
    throw errors.unauthorized('Session token is missing a valid subject claim.');
  }

  const rawUsername = payload['username'];
  const parsedUsername =
    typeof rawUsername === 'string' ? usernameSchema.safeParse(rawUsername) : undefined;
  const username =
    parsedUsername !== undefined && parsedUsername.success
      ? parsedUsername.data
      : fallbackUsername(sub);

  const rawEmail = payload['email'];
  const email = typeof rawEmail === 'string' ? rawEmail : '';

  const rawName = payload['name'];
  const displayName =
    typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : username;

  return { userId: sub, username, displayName, email };
}

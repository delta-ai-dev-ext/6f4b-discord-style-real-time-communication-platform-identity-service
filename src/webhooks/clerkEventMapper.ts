import { z } from 'zod';
import type { NewUserProfileRecord, UserProfilePatch } from '../models/domain';
import { fallbackUsername } from '../auth/claims';

/**
 * Clerk webhook payload → profile mirror fields. Pure mapping, no I/O.
 */

export const clerkUserDataSchema = z.object({
  id: z.string().uuid('Clerk user id must be a uuid (platform user id)'),
  username: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  image_url: z.string().nullish(),
  primary_email_address_id: z.string().nullish(),
  email_addresses: z
    .array(
      z.object({
        id: z.string().nullish(),
        email_address: z.string().nullish(),
      }),
    )
    .nullish(),
  deleted: z.boolean().nullish(),
});

export const clerkEventSchema = z.object({
  type: z.string().min(1),
  data: clerkUserDataSchema,
});

export type ClerkUserData = z.infer<typeof clerkUserDataSchema>;
export type ClerkEvent = z.infer<typeof clerkEventSchema>;

export const SUPPORTED_CLERK_EVENT_TYPES = ['user.created', 'user.updated', 'user.deleted'] as const;
export type SupportedClerkEventType = (typeof SUPPORTED_CLERK_EVENT_TYPES)[number];

export function primaryEmail(data: ClerkUserData): string {
  const addresses = data.email_addresses ?? [];
  const primaryId = data.primary_email_address_id ?? undefined;
  const preferred = addresses.find((address) => address.id === primaryId);
  const chosen = preferred ?? addresses[0];
  return chosen?.email_address ?? '';
}

export function sanitizeUsername(raw: string, userId: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 32);
  return normalized.length >= 2 ? normalized : fallbackUsername(userId);
}

export function displayNameOf(data: ClerkUserData, username: string): string {
  const parts = [data.first_name, data.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);
  const joined = parts.join(' ');
  return joined.length > 0 ? joined : username;
}

/** Maps `user.created` / `user.updated` payloads onto the mirror fields. */
export function toProfileFromClerkUser(data: ClerkUserData): NewUserProfileRecord {
  const username = sanitizeUsername(data.username ?? '', data.id);
  return {
    userId: data.id,
    username,
    displayName: displayNameOf(data, username),
    avatarUrl: data.image_url ?? '',
    email: primaryEmail(data),
  };
}

export function toProfilePatchFromClerkUser(data: ClerkUserData): UserProfilePatch {
  const profile = toProfileFromClerkUser(data);
  return {
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
  };
}

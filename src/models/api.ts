import { z } from 'zod';
import type {
  FriendRequestRecord,
  FriendRequestStatus,
  FriendshipRecord,
  UserProfileRecord,
} from './domain';

/**
 * Runtime-validated API contract, mirroring `docs/openapi_spec.yaml`.
 * Wire fields are snake_case; validated values are the single source of truth
 * for controllers.
 */

export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{2,32}$/;
export const BATCH_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_PATTERN, 'username must match ^[A-Za-z0-9._-]{2,32}$');

export const usernamePathSchema = z.object({ username: usernameSchema });

export const userProfileSchema = z.object({
  user_id: z.string().uuid(),
  username: z.string(),
  display_name: z.string(),
  avatar_url: z.string(),
  email: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const publicProfileSchema = userProfileSchema.pick({
  user_id: true,
  username: true,
  display_name: true,
  avatar_url: true,
});

export type PublicProfileDto = z.infer<typeof publicProfileSchema>;
export type UserProfileDto = z.infer<typeof userProfileSchema>;

export const batchUserLookupSchema = z.object({
  user_ids: z
    .array(z.string().uuid('user_ids must contain uuid values'))
    .min(1, 'user_ids must contain at least one id'),
});

export const batchUserLookupResponseSchema = z.object({ data: z.array(publicProfileSchema) });

export const sendFriendRequestSchema = z.object({ username: usernameSchema });

export const friendRequestStatusSchema = z.enum(['pending', 'accepted', 'declined', 'cancelled']);

export const friendRequestSchema = z.object({
  request_id: z.string().uuid(),
  sender_user_id: z.string().uuid(),
  recipient_user_id: z.string().uuid(),
  status: friendRequestStatusSchema,
  created_at: z.string(),
  responded_at: z.string().nullable(),
});

export type FriendRequestDto = z.infer<typeof friendRequestSchema>;

export const friendshipSchema = z.object({
  user_id_a: z.string().uuid(),
  user_id_b: z.string().uuid(),
  created_at: z.string(),
});

export type FriendshipDto = z.infer<typeof friendshipSchema>;

export const friendRequestListQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).default('incoming'),
  status: friendRequestStatusSchema.default('pending'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_LIMIT),
});

export type FriendRequestListQuery = z.infer<typeof friendRequestListQuerySchema>;

export const friendListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_LIMIT),
});

export type FriendListQuery = z.infer<typeof friendListQuerySchema>;

export const uuidParamSchema = z.object({ request_id: z.string().uuid() });
export const friendIdParamSchema = z.object({ user_id: z.string().uuid() });

export const friendRequestListResponseSchema = z.object({
  data: z.array(friendRequestSchema),
  next_cursor: z.string().nullable(),
});

export const friendListResponseSchema = z.object({
  data: z.array(publicProfileSchema),
  next_cursor: z.string().nullable(),
});

export type FriendRequestListResponseDto = z.infer<typeof friendRequestListResponseSchema>;
export type FriendListResponseDto = z.infer<typeof friendListResponseSchema>;

export const healthStatusSchema = z.object({ status: z.enum(['ok', 'degraded']) });
export const webhookAckSchema = z.object({ status: z.literal('ok') });

export function toPublicProfile(record: UserProfileRecord): PublicProfileDto {
  return {
    user_id: record.userId,
    username: record.username,
    display_name: record.displayName,
    avatar_url: record.avatarUrl,
  };
}

export function toUserProfile(record: UserProfileRecord): UserProfileDto {
  return {
    ...toPublicProfile(record),
    email: record.email,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export function toFriendRequest(record: FriendRequestRecord): FriendRequestDto {
  return {
    request_id: record.requestId,
    sender_user_id: record.senderUserId,
    recipient_user_id: record.recipientUserId,
    status: record.status,
    created_at: record.createdAt.toISOString(),
    responded_at: record.respondedAt === null ? null : record.respondedAt.toISOString(),
  };
}

export function toFriendship(record: FriendshipRecord): FriendshipDto {
  return {
    user_id_a: record.userIdA,
    user_id_b: record.userIdB,
    created_at: record.createdAt.toISOString(),
  };
}

export type { FriendRequestStatus };

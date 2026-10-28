import {
  batchUserLookupSchema,
  toPublicProfile,
  toUserProfile,
  usernameSchema,
  type PublicProfileDto,
  type UserProfileDto,
} from '../models/api';
import type { ProfileService } from '../services/profileService';
import { parseOrThrow, type ApiResult, type RequestContext } from './types';

/** Thin controller for the profile/username surface. */
export class ProfileController {
  private readonly profiles: ProfileService;

  constructor(profiles: ProfileService) {
    this.profiles = profiles;
  }

  async getMyProfile(ctx: RequestContext): Promise<ApiResult<UserProfileDto>> {
    const profile = await this.profiles.getMyProfile(ctx.claims);
    return { status: 200, body: toUserProfile(profile) };
  }

  async getUserByUsername(
    ctx: RequestContext,
    params: unknown,
  ): Promise<ApiResult<PublicProfileDto>> {
    const username = parseOrThrow(usernameSchema, readParam(params, 'username'));
    const profile = await this.profiles.getByUsername(ctx.claims, username);
    return { status: 200, body: toPublicProfile(profile) };
  }

  async batchGetUsers(
    ctx: RequestContext,
    body: unknown,
  ): Promise<ApiResult<{ data: PublicProfileDto[] }>> {
    const input = parseOrThrow(batchUserLookupSchema, body);
    const profiles = await this.profiles.getPublicProfilesByIds(ctx.claims, input.user_ids);
    return { status: 200, body: { data: profiles.map(toPublicProfile) } };
  }
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as Record<string, unknown>)[key];
}

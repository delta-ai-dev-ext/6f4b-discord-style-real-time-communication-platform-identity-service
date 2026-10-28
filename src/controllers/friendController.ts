import { errors } from '../models/errors';
import {
  friendListQuerySchema,
  friendRequestListQuerySchema,
  sendFriendRequestSchema,
  toFriendRequest,
  toFriendship,
  toPublicProfile,
  uuidParamSchema,
  friendIdParamSchema,
  type FriendRequestDto,
  type FriendListResponseDto,
  type FriendshipDto,
  type PublicProfileDto,
} from '../models/api';
import type { FriendService } from '../services/friendService';
import type { TokenBucketRateLimiter } from '../services/rateLimiter';
import { parseOrThrow, type ApiResult, type RequestContext } from './types';

/** Thin controller for the friend-request and friendship surface. */
export class FriendController {
  private readonly friends: FriendService;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(friends: FriendService, limiter: TokenBucketRateLimiter) {
    this.friends = friends;
    this.limiter = limiter;
  }

  async sendFriendRequest(
    ctx: RequestContext,
    body: unknown,
  ): Promise<ApiResult<FriendRequestDto>> {
    const input = parseOrThrow(sendFriendRequestSchema, body);

    // Per-pod token bucket keyed by the verified caller: no request is created
    // once the budget is exhausted.
    if (!this.limiter.tryConsume(ctx.claims.userId)) {
      throw errors.rateLimited();
    }

    const request = await this.friends.sendFriendRequest(ctx.claims, input.username, {
      traceParent: ctx.trace.traceparent,
    });
    return { status: 201, body: toFriendRequest(request) };
  }

  async listFriendRequests(
    ctx: RequestContext,
    query: unknown,
  ): Promise<ApiResult<{ data: FriendRequestDto[]; next_cursor: string | null }>> {
    const filters = parseOrThrow(friendRequestListQuerySchema, query);
    const page = await this.friends.listFriendRequests(ctx.claims, filters);
    return {
      status: 200,
      body: { data: page.rows.map(toFriendRequest), next_cursor: page.nextCursor },
    };
  }

  async acceptFriendRequest(
    ctx: RequestContext,
    params: unknown,
  ): Promise<ApiResult<FriendshipDto>> {
    const { request_id: requestId } = parseOrThrow(uuidParamSchema, params);
    const friendship = await this.friends.acceptFriendRequest(ctx.claims, requestId, {
      traceParent: ctx.trace.traceparent,
    });
    return { status: 200, body: toFriendship(friendship) };
  }

  async declineFriendRequest(
    ctx: RequestContext,
    params: unknown,
  ): Promise<ApiResult<FriendRequestDto>> {
    const { request_id: requestId } = parseOrThrow(uuidParamSchema, params);
    const request = await this.friends.declineFriendRequest(ctx.claims, requestId, {
      traceParent: ctx.trace.traceparent,
    });
    return { status: 200, body: toFriendRequest(request) };
  }

  async cancelFriendRequest(ctx: RequestContext, params: unknown): Promise<ApiResult<null>> {
    const { request_id: requestId } = parseOrThrow(uuidParamSchema, params);
    await this.friends.cancelFriendRequest(ctx.claims, requestId, {
      traceParent: ctx.trace.traceparent,
    });
    return { status: 204, body: null };
  }

  async listFriends(ctx: RequestContext, query: unknown): Promise<ApiResult<FriendListResponseDto>> {
    const filters = parseOrThrow(friendListQuerySchema, query);
    const page = await this.friends.listFriends(ctx.claims, filters);
    const data: PublicProfileDto[] = page.rows.map(toPublicProfile);
    return { status: 200, body: { data, next_cursor: page.nextCursor } };
  }

  async removeFriend(ctx: RequestContext, params: unknown): Promise<ApiResult<null>> {
    const { user_id: friendUserId } = parseOrThrow(friendIdParamSchema, params);
    await this.friends.removeFriend(ctx.claims, friendUserId, {
      traceParent: ctx.trace.traceparent,
    });
    return { status: 204, body: null };
  }
}

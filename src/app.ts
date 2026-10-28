import { Elysia, type Context } from 'elysia';
import { extractBearerToken, type TokenVerifier } from './auth/clerkAuth';
import type { FriendController } from './controllers/friendController';
import type { ProfileController } from './controllers/profileController';
import type { ApiResult, RequestContext } from './controllers/types';
import type { WebhookController } from './webhooks/clerkWebhookController';
import type { LoggerPort } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { errors, toErrorBody } from './models/errors';
import { resolveTraceContext, type TraceContext } from './observability/trace';

export type HealthProbe = {
  checkDatabase(): Promise<void>;
  isProducerConnected(): boolean;
  isShuttingDown(): boolean;
};

export type AppDependencies = {
  profiles: ProfileController;
  friends: FriendController;
  webhooks: WebhookController;
  verifier: TokenVerifier;
  metrics: Metrics;
  logger: LoggerPort;
  health: HealthProbe;
};

type RouteInput = {
  request: Request;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
};

type AuthedHandler = (input: RouteInput, ctx: RequestContext) => Promise<ApiResult<unknown>>;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderResult(result: ApiResult<unknown>): Response {
  if (result.status === 204 || result.body === null || result.body === undefined) {
    return new Response(null, { status: result.status });
  }
  return jsonResponse(result.body, result.status);
}

function toRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') output[key] = entry;
  }
  return output;
}

function toQueryRecord(value: unknown): Record<string, string | undefined> {
  if (typeof value !== 'object' || value === null) return {};
  const output: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') output[key] = entry;
    else if (entry === undefined || entry === null) output[key] = undefined;
  }
  return output;
}

/**
 * HTTP composition root. Routes stay thin: authenticate (except probes and the
 * signature-authenticated webhook), delegate to a controller, map errors onto
 * the platform contract, and record latency/logs/metrics for every route.
 */
export function createApp(deps: AppDependencies): Elysia {
  const app = new Elysia({ name: 'identity_service' });

  const observe = async (
    template: string,
    method: string,
    trace: TraceContext,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const startedAt = performance.now();
    let status = 500;
    let errorCode: string | undefined;

    try {
      const response = await run();
      status = response.status;
      return response;
    } catch (error) {
      const mapped = toErrorBody(error);
      status = mapped.status;
      errorCode = mapped.body.error.code;

      if (status >= 500) {
        deps.logger.error('request failed', {
          route: template,
          method,
          status_code: status,
          trace_id: trace.traceId,
          error_code: errorCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return jsonResponse(mapped.body, mapped.status);
    } finally {
      deps.metrics.observeRequest(template, method, status, (performance.now() - startedAt) / 1000);
      deps.logger.info('request completed', {
        route: template,
        method,
        status_code: status,
        trace_id: trace.traceId,
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
      });
    }
  };

  const authed = (template: string, method: string, handler: AuthedHandler) => {
    return async (context: Context): Promise<Response> => {
      const trace = resolveTraceContext(context.request.headers.get('traceparent'));
      return observe(template, method, trace, async () => {
        if (deps.health.isShuttingDown()) {
          throw errors.unavailable();
        }

        const claims = await deps.verifier.verify(
          extractBearerToken(context.request.headers.get('authorization')),
        );

        const input: RouteInput = {
          request: context.request,
          params: toRecord(context.params),
          query: toQueryRecord(context.query),
          body: context.body,
        };

        return renderResult(await handler(input, { claims, trace }));
      });
    };
  };

  app
    .get(
      '/v1/me',
      authed('GET /v1/me', 'GET', async (_input, ctx) => deps.profiles.getMyProfile(ctx)),
    )
    .get(
      '/v1/users/by-username/:username',
      authed('GET /v1/users/by-username/{username}', 'GET', async (input, ctx) =>
        deps.profiles.getUserByUsername(ctx, input.params),
      ),
    )
    .post(
      '/v1/users:batch',
      authed('POST /v1/users:batch', 'POST', async (input, ctx) =>
        deps.profiles.batchGetUsers(ctx, input.body),
      ),
    )
    .post(
      '/v1/friend-requests',
      authed('POST /v1/friend-requests', 'POST', async (input, ctx) =>
        deps.friends.sendFriendRequest(ctx, input.body),
      ),
    )
    .get(
      '/v1/friend-requests',
      authed('GET /v1/friend-requests', 'GET', async (input, ctx) =>
        deps.friends.listFriendRequests(ctx, input.query),
      ),
    )
    .post(
      '/v1/friend-requests/:request_id/accept',
      authed('POST /v1/friend-requests/{request_id}/accept', 'POST', async (input, ctx) =>
        deps.friends.acceptFriendRequest(ctx, input.params),
      ),
    )
    .post(
      '/v1/friend-requests/:request_id/decline',
      authed('POST /v1/friend-requests/{request_id}/decline', 'POST', async (input, ctx) =>
        deps.friends.declineFriendRequest(ctx, input.params),
      ),
    )
    .delete(
      '/v1/friend-requests/:request_id',
      authed('DELETE /v1/friend-requests/{request_id}', 'DELETE', async (input, ctx) =>
        deps.friends.cancelFriendRequest(ctx, input.params),
      ),
    )
    .get(
      '/v1/friends',
      authed('GET /v1/friends', 'GET', async (input, ctx) =>
        deps.friends.listFriends(ctx, input.query),
      ),
    )
    .delete(
      '/v1/friends/:user_id',
      authed('DELETE /v1/friends/{user_id}', 'DELETE', async (input, ctx) =>
        deps.friends.removeFriend(ctx, input.params),
      ),
    )
    .post(
      '/v1/webhooks/clerk',
      async (context: Context): Promise<Response> => {
        const trace = resolveTraceContext(context.request.headers.get('traceparent'));
        return observe('POST /v1/webhooks/clerk', 'POST', trace, async () => {
          const rawBody = typeof context.body === 'string' ? context.body : '';
          const result = await deps.webhooks.handleClerkWebhook({
            rawBody,
            headers: context.request.headers,
            trace,
          });
          return renderResult(result);
        });
      },
      { parse: 'text' },
    )
    .get('/healthz', () => jsonResponse({ status: 'ok' }, 200))
    .get('/readyz', async (): Promise<Response> => {
      if (deps.health.isShuttingDown()) {
        return jsonResponse({ status: 'degraded' }, 503);
      }
      try {
        await deps.health.checkDatabase();
      } catch {
        return jsonResponse({ status: 'degraded' }, 503);
      }
      if (!deps.health.isProducerConnected()) {
        return jsonResponse({ status: 'degraded' }, 503);
      }
      return jsonResponse({ status: 'ok' }, 200);
    })
    .get('/metrics', async (): Promise<Response> => {
      const { body, contentType } = await deps.metrics.render();
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    });

  return app;
}

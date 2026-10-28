import { createApp } from '../../src/app';
import { ProfileController } from '../../src/controllers/profileController';
import { FriendController } from '../../src/controllers/friendController';
import { WebhookController } from '../../src/webhooks/clerkWebhookController';
import { ClerkWebhookService } from '../../src/webhooks/clerkWebhookService';
import { ClerkWebhookVerifier } from '../../src/webhooks/clerkWebhookVerifier';
import { ProfileService } from '../../src/services/profileService';
import { FriendService } from '../../src/services/friendService';
import { TokenBucketRateLimiter } from '../../src/services/rateLimiter';
import { systemClock } from '../../src/repositories/ports';
import type { TokenVerifier } from '../../src/auth/clerkAuth';
import { createMetrics, type Metrics } from '../../src/observability/metrics';
import { silentLogger } from '../../src/observability/logger';
import { mapClaims } from '../../src/auth/claims';
import { cryptoIdGenerator } from '../../src/services/idGenerator';
import { errors } from '../../src/models/errors';
import type { TestDatabase } from './harness';
import { generateSigningSecret } from '../mocks/svix';
import { USER_IDS } from '../mocks/fixtures';

/**
 * Full HTTP stack wired against the integration database. Only the Clerk token
 * verifier is stubbed (it would need a real Clerk-signed JWT); webhook
 * verification uses the real `verifyWebhook` path with a generated secret.
 */
export type TestApp = {
  signingSecret: string;
  metrics: Metrics;
  limiter: TokenBucketRateLimiter;
  request: (
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    },
  ) => Promise<Response>;
  setShuttingDown: (value: boolean) => void;
  setProducerConnected: (value: boolean) => void;
  setDatabaseReady: (value: boolean) => void;
};

/** Tokens are `t:<user_id>:<username>`; anything else is rejected as 401. */
export const stubVerifier: TokenVerifier = {
  verify: async (token: string) => {
    const match = /^t:([0-9a-f-]+):([A-Za-z0-9._-]+)$/.exec(token);
    if (match === null) throw errors.unauthorized('Session token could not be verified.');
    const [, userId, username] = match;
    return mapClaims({
      sub: userId,
      username,
      email: `${username}@example.com`,
      name: `${username} name`,
    });
  },
};

export function tokenFor(userId: string, username: string): string {
  return `t:${userId}:${username}`;
}

export const ALICE_TOKEN = tokenFor(USER_IDS.alice, 'alice');
export const BOB_TOKEN = tokenFor(USER_IDS.bob, 'bob');
export const CAROL_TOKEN = tokenFor(USER_IDS.carol, 'carol');

export function createTestApp(
  db: TestDatabase,
  options: { rateLimitPerMinute?: number } = {},
): TestApp {
  const metrics = createMetrics(false);
  const profiles = new ProfileService({ unitOfWork: db.unitOfWork, metrics });
  const friends = new FriendService({
    unitOfWork: db.unitOfWork,
    metrics,
    clock: systemClock,
    ids: cryptoIdGenerator,
  });
  const webhooks = new ClerkWebhookService({
    unitOfWork: db.unitOfWork,
    metrics,
    clock: systemClock,
    ids: cryptoIdGenerator,
    logger: silentLogger,
  });

  const signingSecret = generateSigningSecret();
  const limiter = new TokenBucketRateLimiter(options.rateLimitPerMinute ?? 20);
  const state = { shuttingDown: false, producerConnected: true, databaseReady: true };

  const app = createApp({
    profiles: new ProfileController(profiles),
    friends: new FriendController(friends, limiter),
    webhooks: new WebhookController({
      webhooks,
      verifier: new ClerkWebhookVerifier({ signingSecret }),
      metrics,
    }),
    verifier: stubVerifier,
    metrics,
    logger: silentLogger,
    health: {
      checkDatabase: async () => {
        if (!state.databaseReady) throw new Error('db unavailable');
      },
      isProducerConnected: () => state.producerConnected,
      isShuttingDown: () => state.shuttingDown,
    },
  });

  return {
    signingSecret,
    metrics,
    limiter,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
      const body =
        options.rawBody !== undefined
          ? options.rawBody
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body);
      if (options.body !== undefined && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
      return app.handle(new Request(`http://localhost${path}`, { method, headers, body }));
    },
    setShuttingDown: (value) => {
      state.shuttingDown = value;
    },
    setProducerConnected: (value) => {
      state.producerConnected = value;
    },
    setDatabaseReady: (value) => {
      state.databaseReady = value;
    },
  };
}

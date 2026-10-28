import { createApp } from './app';
import { ClerkTokenVerifier } from './auth/clerkAuth';
import { loadConfig, type AppConfig } from './config';
import { FriendController } from './controllers/friendController';
import { ProfileController } from './controllers/profileController';
import { createDatabase, type DatabaseHandle } from './db/pool';
import { KafkaEventPublisher } from './events/kafkaPublisher';
import { OutboxWorker } from './events/outboxWorker';
import { createLogger, type LoggerPort } from './observability/logger';
import { createMetrics, FRIEND_EVENTS_TOPIC, type Metrics } from './observability/metrics';
import { DrizzleOutboxQueue } from './repositories/drizzle/outboxQueue';
import { DrizzleUnitOfWork } from './repositories/drizzle/unitOfWork';
import { systemClock } from './repositories/ports';
import { FriendService } from './services/friendService';
import { ProfileService } from './services/profileService';
import { cryptoIdGenerator } from './services/idGenerator';
import { TokenBucketRateLimiter } from './services/rateLimiter';
import { WebhookController } from './webhooks/clerkWebhookController';
import { ClerkWebhookService } from './webhooks/clerkWebhookService';
import { ClerkWebhookVerifier } from './webhooks/clerkWebhookVerifier';

const SHUTDOWN_GRACE_MS = 20_000;

type RunningService = {
  app: ReturnType<typeof createApp>;
  worker: OutboxWorker;
  publisher: KafkaEventPublisher;
  database: DatabaseHandle;
  metrics: Metrics;
  logger: LoggerPort;
  /** Flipped during graceful shutdown so new `/v1/*` requests get 503. */
  state: { shuttingDown: boolean };
};

/**
 * Boots the pod: validated config → logger/metrics → database → producer →
 * outbox worker → HTTP listener. Fails fast on invalid configuration.
 */
export function buildRuntime(config: AppConfig): RunningService {
  const logger = createLogger(config.logLevel);
  const metrics = createMetrics();
  const database = createDatabase(config.databaseUrl);
  const unitOfWork = new DrizzleUnitOfWork(database.db);

  const profiles = new ProfileService({ unitOfWork, metrics });
  const friends = new FriendService({
    unitOfWork,
    metrics,
    clock: systemClock,
    ids: cryptoIdGenerator,
  });
  const webhooks = new ClerkWebhookService({
    unitOfWork,
    metrics,
    clock: systemClock,
    ids: cryptoIdGenerator,
    logger,
  });

  const publisher = new KafkaEventPublisher({
    brokers: config.kafkaBrokers,
    clientId: config.kafkaClientId,
    ssl: config.kafkaSsl,
    logger,
  });
  const queue = new DrizzleOutboxQueue(database.db);
  const worker = new OutboxWorker({
    queue,
    publisher,
    metrics,
    logger,
    batchSize: config.outboxBatchSize,
    pollIntervalMs: config.outboxPollIntervalMs,
    maxAttempts: config.outboxMaxAttempts,
  });

  const verifier = new ClerkTokenVerifier({ jwtKey: config.clerkJwtKey });
  const webhookVerifier = new ClerkWebhookVerifier({
    signingSecret: config.clerkWebhookSigningSecret,
  });
  const limiter = new TokenBucketRateLimiter(config.friendRequestRateLimitPerMinute);

  let shuttingDown = false;
  const state = {
    get shuttingDown(): boolean {
      return shuttingDown;
    },
    set shuttingDown(value: boolean) {
      shuttingDown = value;
    },
  };
  const app = createApp({
    profiles: new ProfileController(profiles),
    friends: new FriendController(friends, limiter),
    webhooks: new WebhookController({ webhooks, verifier: webhookVerifier, metrics }),
    verifier,
    metrics,
    logger,
    health: {
      checkDatabase: () => database.ping(),
      isProducerConnected: () => publisher.isConnected(),
      isShuttingDown: () => state.shuttingDown,
    },
  });
  app.onStart(() => {
    metrics.setOutboxPending(FRIEND_EVENTS_TOPIC, 0);
  });

  return { app, worker, publisher, database, metrics, logger, state };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = buildRuntime(config);
  const { app, worker, publisher, database, logger, metrics, state } = runtime;

  if (config.metricsPort !== undefined && config.metricsPort !== config.port) {
    Bun.serve({
      port: config.metricsPort,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (pathname !== '/metrics') return new Response('not found', { status: 404 });
        const { body, contentType } = await metrics.render();
        return new Response(body, { status: 200, headers: { 'content-type': contentType } });
      },
    });
  }

  // Kafka may be unavailable at boot; readiness stays `degraded` while the
  // producer keeps retrying — requests still succeed because publishing is
  // asynchronous (outbox rows stay pending).
  const startWorker = async (): Promise<void> => {
    try {
      await worker.start();
    } catch (error) {
      logger.error('outbox worker failed to start; retrying', {
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => {
        void startWorker();
      }, Math.max(config.outboxPollIntervalMs, 1_000));
    }
  };
  await startWorker();

  app.listen(config.port);
  logger.info('identity_service listening', { port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.shuttingDown = true;
    logger.info('graceful shutdown initiated', { signal });
    const deadline = setTimeout(() => {
      logger.error('graceful shutdown deadline exceeded, exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);

    try {
      // 1. stop intake (readiness is gated by `shuttingDown`).
      await app.stop();
      // 2. drain the outbox worker.
      await worker.stop();
      // 3. flush + close the Kafka producer.
      await publisher.disconnect();
      // 4. close the database pool.
      await database.close();
    } catch (error) {
      logger.error('graceful shutdown step failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(deadline);
    }

    logger.info('graceful shutdown complete', { signal });
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

if (import.meta.main) {
  void main();
}

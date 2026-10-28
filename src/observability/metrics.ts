import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The exact metric set from `docs/architecture.md` §7. Labels stay
 * low-cardinality: never user ids, request ids or timestamps.
 */

export type FriendRequestOutcome = 'sent' | 'accepted' | 'declined' | 'cancelled';
export type UsernameLookupResult = 'found' | 'not_found';
export type UserSyncEvent = 'created' | 'updated' | 'deleted';
export type WebhookFailureReason = 'signature' | 'parse' | 'db' | 'retry_exhausted';

export const FRIEND_EVENTS_TOPIC = 'identity_friend_events';

export class Metrics {
  readonly registry: Registry;

  readonly friendRequestsTotal: Counter<'outcome'>;
  readonly usernameLookupsTotal: Counter<'result'>;
  readonly usersSyncedTotal: Counter<'event'>;
  readonly httpRequestDurationSeconds: Histogram<'route' | 'method' | 'status_class'>;
  readonly clerkWebhookFailuresTotal: Counter<'reason'>;
  readonly kafkaProduceErrorsTotal: Counter<'topic'>;
  readonly outboxEventsPending: Gauge<'topic'>;
  readonly outboxEventsDeadLetteredTotal: Counter<'topic'>;

  constructor(registry: Registry = new Registry()) {
    this.registry = registry;

    this.friendRequestsTotal = new Counter({
      name: 'identity_friend_requests_total',
      help: 'Friend-request lifecycle outcomes',
      labelNames: ['outcome'] as const,
      registers: [registry],
    });

    this.usernameLookupsTotal = new Counter({
      name: 'identity_username_lookups_total',
      help: 'Username resolution results',
      labelNames: ['result'] as const,
      registers: [registry],
    });

    this.usersSyncedTotal = new Counter({
      name: 'identity_users_synced_total',
      help: 'Profile mirror changes (webhook and lazy upsert paths)',
      labelNames: ['event'] as const,
      registers: [registry],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'API latency per route',
      labelNames: ['route', 'method', 'status_class'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    });

    this.clerkWebhookFailuresTotal = new Counter({
      name: 'identity_clerk_webhook_failures_total',
      help: 'Clerk webhook processing failures by reason',
      labelNames: ['reason'] as const,
      registers: [registry],
    });

    this.kafkaProduceErrorsTotal = new Counter({
      name: 'kafka_produce_errors_total',
      help: 'Kafka producer errors by topic',
      labelNames: ['topic'] as const,
      registers: [registry],
    });

    this.outboxEventsPending = new Gauge({
      name: 'identity_outbox_events_pending',
      help: 'Outbox rows not yet published',
      labelNames: ['topic'] as const,
      registers: [registry],
    });

    this.outboxEventsDeadLetteredTotal = new Counter({
      name: 'identity_outbox_events_dead_lettered_total',
      help: 'Outbox events that exceeded the retry budget',
      labelNames: ['topic'] as const,
      registers: [registry],
    });
  }

  recordFriendRequest(outcome: FriendRequestOutcome): void {
    this.friendRequestsTotal.inc({ outcome });
  }

  recordUsernameLookup(result: UsernameLookupResult): void {
    this.usernameLookupsTotal.inc({ result });
  }

  recordUserSynced(event: UserSyncEvent): void {
    this.usersSyncedTotal.inc({ event });
  }

  observeRequest(route: string, method: string, statusCode: number, durationSeconds: number): void {
    this.httpRequestDurationSeconds.observe(
      { route, method, status_class: statusClass(statusCode) },
      durationSeconds,
    );
  }

  recordWebhookFailure(reason: WebhookFailureReason): void {
    this.clerkWebhookFailuresTotal.inc({ reason });
  }

  recordProduceError(topic: string): void {
    this.kafkaProduceErrorsTotal.inc({ topic });
  }

  setOutboxPending(topic: string, count: number): void {
    this.outboxEventsPending.set({ topic }, count);
  }

  recordDeadLettered(topic: string): void {
    this.outboxEventsDeadLetteredTotal.inc({ topic });
  }

  async render(): Promise<{ body: string; contentType: string }> {
    return { body: await this.registry.metrics(), contentType: this.registry.contentType };
  }
}

export function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

/** Process-level metrics (`process_cpu_*`, `nodejs_*`, …) on the same registry. */
export function createMetrics(withDefaultMetrics = true): Metrics {
  const registry = new Registry();
  const metrics = new Metrics(registry);
  if (withDefaultMetrics) {
    collectDefaultMetrics({ register: registry, prefix: '' });
  }
  return metrics;
}

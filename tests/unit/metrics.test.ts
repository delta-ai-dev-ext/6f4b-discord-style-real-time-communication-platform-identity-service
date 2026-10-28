import { describe, expect, test } from 'bun:test';
import { createMetrics, FRIEND_EVENTS_TOPIC, Metrics, statusClass } from '../../src/observability/metrics';

type MetricMeta = { name: string; labelNames: string[] };

function meta(metric: unknown): MetricMeta {
  return metric as MetricMeta;
}

describe('metrics registry', () => {
  test('registers exactly the documented metric names and label sets', async () => {
    const metrics = new Metrics();

    expect(meta(metrics.friendRequestsTotal).name).toBe('identity_friend_requests_total');
    expect(meta(metrics.friendRequestsTotal).labelNames).toEqual(['outcome']);
    expect(meta(metrics.usernameLookupsTotal).labelNames).toEqual(['result']);
    expect(meta(metrics.usersSyncedTotal).labelNames).toEqual(['event']);
    expect(meta(metrics.httpRequestDurationSeconds).labelNames).toEqual([
      'route',
      'method',
      'status_class',
    ]);
    expect(meta(metrics.clerkWebhookFailuresTotal).labelNames).toEqual(['reason']);
    expect(meta(metrics.kafkaProduceErrorsTotal).labelNames).toEqual(['topic']);
    expect(meta(metrics.outboxEventsPending).labelNames).toEqual(['topic']);
    expect(meta(metrics.outboxEventsDeadLetteredTotal).labelNames).toEqual(['topic']);

    const json = await metrics.registry.getMetricsAsJSON();
    const byName = new Map(json.map((metric) => [metric.name, String(metric.type)]));
    expect(byName.get('identity_friend_requests_total')).toBe('counter');
    expect(byName.get('identity_username_lookups_total')).toBe('counter');
    expect(byName.get('identity_users_synced_total')).toBe('counter');
    expect(byName.get('http_request_duration_seconds')).toBe('histogram');
    expect(byName.get('identity_clerk_webhook_failures_total')).toBe('counter');
    expect(byName.get('kafka_produce_errors_total')).toBe('counter');
    expect(byName.get('identity_outbox_events_pending')).toBe('gauge');
    expect(byName.get('identity_outbox_events_dead_lettered_total')).toBe('counter');
  });

  test('observes low-cardinality labels for requests', async () => {
    const metrics = new Metrics();
    metrics.observeRequest('GET /v1/me', 'GET', 200, 0.01);
    metrics.observeRequest('GET /v1/me', 'GET', 404, 0.02);
    metrics.observeRequest('POST /v1/friend-requests', 'POST', 500, 0.03);

    const rendered = await metrics.render();
    expect(rendered.contentType).toContain('text/plain');
    expect(rendered.body).toContain('http_request_duration_seconds_bucket');
    expect(rendered.body).toContain('route="GET /v1/me"');
    expect(rendered.body).toContain('status_class="4xx"');
    expect(rendered.body).toContain('status_class="5xx"');
  });

  test('records business and outbox metrics', async () => {
    const metrics = new Metrics();
    metrics.recordFriendRequest('sent');
    metrics.recordFriendRequest('accepted');
    metrics.recordUsernameLookup('found');
    metrics.recordUsernameLookup('not_found');
    metrics.recordUserSynced('created');
    metrics.recordWebhookFailure('signature');
    metrics.recordProduceError(FRIEND_EVENTS_TOPIC);
    metrics.setOutboxPending(FRIEND_EVENTS_TOPIC, 7);
    metrics.recordDeadLettered(FRIEND_EVENTS_TOPIC);

    const body = (await metrics.render()).body;
    expect(body).toContain('identity_friend_requests_total{outcome="sent"} 1');
    expect(body).toContain('identity_friend_requests_total{outcome="accepted"} 1');
    expect(body).toContain('identity_username_lookups_total{result="not_found"} 1');
    expect(body).toContain('identity_users_synced_total{event="created"} 1');
    expect(body).toContain('identity_clerk_webhook_failures_total{reason="signature"} 1');
    expect(body).toContain('kafka_produce_errors_total{topic="identity_friend_events"} 1');
    expect(body).toContain('identity_outbox_events_pending{topic="identity_friend_events"} 7');
    expect(body).toContain('identity_outbox_events_dead_lettered_total{topic="identity_friend_events"} 1');
  });

  test('statusClass buckets statuses', () => {
    expect(statusClass(100)).toBe('1xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(302)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });

  test('createMetrics can include process metrics', async () => {
    const metrics = createMetrics(true);
    const { body } = await metrics.render();
    expect(body).toContain('identity_friend_requests_total');
    expect(body).toContain('process_cpu_user_seconds_total');
  });
});

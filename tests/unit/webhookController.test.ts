import { describe, expect, test } from 'bun:test';
import { Metrics } from '../../src/observability/metrics';
import { silentLogger } from '../../src/observability/logger';
import { DomainError } from '../../src/models/errors';
import type { UnitOfWork } from '../../src/repositories/ports';
import { resolveTraceContext } from '../../src/observability/trace';
import { WebhookController } from '../../src/webhooks/clerkWebhookController';
import { ClerkWebhookService } from '../../src/webhooks/clerkWebhookService';
import type { WebhookVerification, WebhookVerifier } from '../../src/webhooks/clerkWebhookVerifier';
import { clerkEventSchema } from '../../src/webhooks/clerkEventMapper';
import { InMemoryUnitOfWork } from '../mocks/inMemoryRepositories';
import { clerkEvent, clerkUserPayload, FakeClock, FakeIdGenerator } from '../mocks/fixtures';

function setup(verification: WebhookVerification | (() => Promise<WebhookVerification>)) {
  const inner = new InMemoryUnitOfWork();
  const unitOfWork: UnitOfWork = { run: (work) => inner.run(work) };
  const metrics = new Metrics();
  const webhooks = new ClerkWebhookService({
    unitOfWork,
    metrics,
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    logger: silentLogger,
  });
  const seenRequests: Request[] = [];
  const verifier: WebhookVerifier = {
    verify: async (request) => {
      seenRequests.push(request);
      return typeof verification === 'function' ? verification() : verification;
    },
  };
  const controller = new WebhookController({ webhooks, verifier, metrics });
  return { controller, metrics, state: inner.state, seenRequests };
}

const validVerification: WebhookVerification = {
  ok: true,
  event: clerkEventSchema.parse(clerkEvent('user.created', clerkUserPayload())),
};

function headers(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'svix-id': 'msg_1',
    'svix-timestamp': '1737038400',
    'svix-signature': 'v1,abc',
    'content-type': 'application/json',
    ...overrides,
  });
}

const rawBody = JSON.stringify(clerkEvent('user.created', clerkUserPayload()));

describe('WebhookController', () => {
  test('acknowledges a verified event', async () => {
    const { controller, state } = setup(validVerification);

    const result = await controller.handleClerkWebhook({
      rawBody,
      headers: headers(),
      trace: resolveTraceContext(undefined),
    });

    expect(result).toEqual({ status: 200, body: { status: 'ok' } });
    expect(state.profiles).toHaveLength(1);
  });

  test('passes the untouched raw body to the verifier', async () => {
    const { controller, seenRequests } = setup(validVerification);

    await controller.handleClerkWebhook({
      rawBody,
      headers: headers(),
      trace: resolveTraceContext(undefined),
    });

    expect(await seenRequests[0]?.text()).toBe(rawBody);
  });

  test('returns 401 when the signature is invalid', async () => {
    const { controller, metrics } = setup({ ok: false, reason: 'signature' });

    try {
      await controller.handleClerkWebhook({
        rawBody,
        headers: headers(),
        trace: resolveTraceContext(undefined),
      });
      throw new Error('expected error');
    } catch (error) {
      expect((error as DomainError).status).toBe(401);
      expect((error as DomainError).code).toBe('invalid_signature');
    }

    const rendered = await metrics.render();
    expect(rendered.body).toContain(
      'identity_clerk_webhook_failures_total{reason="signature"} 1',
    );
  });

  test('returns 401 when the svix-id header is missing', async () => {
    const { controller, metrics } = setup(validVerification);

    await expect(
      controller.handleClerkWebhook({
        rawBody,
        headers: new Headers({ 'content-type': 'application/json' }),
        trace: resolveTraceContext(undefined),
      }),
    ).rejects.toThrow(DomainError);

    const rendered = await metrics.render();
    expect(rendered.body).toContain('identity_clerk_webhook_failures_total{reason="signature"}');
  });

  test('parse failures after a valid signature are 500s so Svix retries', async () => {
    const { controller, metrics } = setup({ ok: false, reason: 'parse' });

    try {
      await controller.handleClerkWebhook({
        rawBody,
        headers: headers(),
        trace: resolveTraceContext(undefined),
      });
      throw new Error('expected error');
    } catch (error) {
      expect((error as DomainError).status).toBe(500);
    }

    const rendered = await metrics.render();
    expect(rendered.body).toContain('identity_clerk_webhook_failures_total{reason="parse"} 1');
  });

  test('processing failures are counted as db failures', async () => {
    const verification: WebhookVerification = { ok: true, event: validVerification.ok ? validVerification.event : (undefined as never) };
    const inner = new InMemoryUnitOfWork();
    const metrics = new Metrics();
    const controller = new WebhookController({
      webhooks: new ClerkWebhookService({
        unitOfWork: {
          run: async (work) =>
            inner.run((tx) =>
              work({
                ...tx,
                processedWebhooks: {
                  markProcessed: async () => {
                    throw new Error('db down');
                  },
                },
              }),
            ),
        },
        metrics,
        clock: new FakeClock(),
        ids: new FakeIdGenerator(),
        logger: silentLogger,
      }),
      verifier: { verify: async () => verification },
      metrics,
    });

    await expect(
      controller.handleClerkWebhook({
        rawBody,
        headers: headers(),
        trace: resolveTraceContext(undefined),
      }),
    ).rejects.toThrow('db down');

    const rendered = await metrics.render();
    expect(rendered.body).toContain('identity_clerk_webhook_failures_total{reason="db"} 1');
  });
});

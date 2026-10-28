import { errors } from '../models/errors';
import type { TraceContext } from '../observability/trace';
import type { Metrics } from '../observability/metrics';
import type { ClerkWebhookService } from '../webhooks/clerkWebhookService';
import type { WebhookVerifier } from '../webhooks/clerkWebhookVerifier';
import type { ApiResult } from '../controllers/types';

export type ClerkWebhookInput = {
  /** Untouched request body — Svix signatures cover the exact bytes. */
  rawBody: string;
  headers: Headers;
  trace: TraceContext;
};

/**
 * Webhook controller: authenticate by signature (never by JWT), then delegate
 * to the idempotent sync service. Verification failures are `401`; anything
 * that fails after the signature check is `500` so Svix retries.
 */
export class WebhookController {
  private readonly webhooks: ClerkWebhookService;
  private readonly verifier: WebhookVerifier;
  private readonly metrics: Metrics;

  constructor(deps: { webhooks: ClerkWebhookService; verifier: WebhookVerifier; metrics: Metrics }) {
    this.webhooks = deps.webhooks;
    this.verifier = deps.verifier;
    this.metrics = deps.metrics;
  }

  async handleClerkWebhook(input: ClerkWebhookInput): Promise<ApiResult<{ status: 'ok' }>> {
    const messageId = input.headers.get('svix-id');
    if (messageId === null || messageId.trim() === '') {
      this.metrics.recordWebhookFailure('signature');
      throw errors.invalidSignature();
    }

    const request = new Request('http://identity_service/v1/webhooks/clerk', {
      method: 'POST',
      headers: input.headers,
      body: input.rawBody,
    });

    const verification = await this.verifier.verify(request);
    if (!verification.ok) {
      this.metrics.recordWebhookFailure(verification.reason);
      if (verification.reason === 'signature') throw errors.invalidSignature();
      throw errors.internal();
    }

    try {
      await this.webhooks.handle({
        svixMessageId: messageId,
        event: verification.event,
        traceParent: input.trace.traceparent,
      });
    } catch (error) {
      this.metrics.recordWebhookFailure('db');
      throw error;
    }

    return { status: 200, body: { status: 'ok' } };
  }
}

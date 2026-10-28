import { verifyWebhook } from '@clerk/backend/webhooks';
import { clerkEventSchema, type ClerkEvent } from './clerkEventMapper';

/**
 * Svix signature verification for `POST /v1/webhooks/clerk`.
 *
 * `verifyWebhook` from `@clerk/backend/webhooks` is the Clerk-recommended path
 * (no generic `svix` dependency). It verifies the raw request body against
 * `CLERK_WEBHOOK_SIGNING_SECRET`; the route therefore hands over a Request
 * built from the untouched raw body.
 */

export type WebhookVerifierFn = (
  request: Request,
  options: { signingSecret: string },
) => Promise<unknown>;

export type WebhookVerification =
  | { ok: true; event: ClerkEvent }
  | { ok: false; reason: 'signature' | 'parse' };

export interface WebhookVerifier {
  verify(request: Request): Promise<WebhookVerification>;
}

export class ClerkWebhookVerifier implements WebhookVerifier {
  private readonly signingSecret: string;
  private readonly verifyFn: WebhookVerifierFn;

  constructor(options: { signingSecret: string; verifyFn?: WebhookVerifierFn }) {
    this.signingSecret = options.signingSecret;
    this.verifyFn = options.verifyFn ?? (verifyWebhook as unknown as WebhookVerifierFn);
  }

  async verify(request: Request): Promise<WebhookVerification> {
    let payload: unknown;
    try {
      payload = await this.verifyFn(request, { signingSecret: this.signingSecret });
    } catch {
      return { ok: false, reason: 'signature' };
    }

    const parsed = clerkEventSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: 'parse' };
    }

    return { ok: true, event: parsed.data };
  }
}

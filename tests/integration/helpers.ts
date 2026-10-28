import { expect } from 'bun:test';
import { clerkEvent, clerkUserPayload } from '../mocks/fixtures';
import { svixHeaders } from '../mocks/svix';
import type { TestApp } from './testApp';

/**
 * Shared HTTP-level helpers for the integration suite: they exercise the real
 * Clerk webhook route (signature verification included) to seed mirror rows.
 */

export function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

export function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

export async function postWebhook(
  app: TestApp,
  type: 'user.created' | 'user.updated' | 'user.deleted',
  data: Record<string, unknown>,
  messageId: string = crypto.randomUUID(),
): Promise<Response> {
  const body = JSON.stringify(clerkEvent(type, data));
  const headers = await svixHeaders({
    signingSecret: app.signingSecret,
    messageId,
    body,
  });
  return app.request('POST', '/v1/webhooks/clerk', { rawBody: body, headers });
}

export async function seedUser(
  app: TestApp,
  userId: string,
  username: string,
  email = `${username}@example.com`,
): Promise<void> {
  const response = await postWebhook(
    app,
    'user.created',
    clerkUserPayload({ id: userId, username, email }),
  );
  expect(response.status).toBe(200);
}

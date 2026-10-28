/**
 * Svix / Standard Webhooks signing helpers for webhook contract tests.
 *
 * Signature = base64(HMAC-SHA256(base64decode(secret without `whsec_`),
 * `${messageId}.${timestamp}.${rawBody}`)), sent as `svix-signature: v1,<sig>`.
 */

export function generateSigningSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `whsec_${btoa(binary)}`;
}

export async function signSvix(
  signingSecret: string,
  messageId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const rawSecret = signingSecret.replace(/^whsec_/, '');
  const keyBytes = Uint8Array.from(atob(rawSecret), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${messageId}.${timestamp}.${body}`),
  );
  const base64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return `v1,${base64}`;
}

export async function svixHeaders(options: {
  signingSecret: string;
  messageId: string;
  body: string;
  timestamp?: number;
}): Promise<Record<string, string>> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await signSvix(
    options.signingSecret,
    options.messageId,
    timestamp,
    options.body,
  );
  return {
    'content-type': 'application/json',
    'svix-id': options.messageId,
    'svix-timestamp': String(timestamp),
    'svix-signature': signature,
  };
}

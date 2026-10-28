import { errors } from '../models/errors';

/**
 * Opaque keyset-page cursors. The payload is a base64url JSON array of the
 * ordering-key components (e.g. `[createdAtEpochMs, id]`); clients must treat
 * the value as opaque.
 */

export function encodeCursor(parts: readonly (string | number)[]): string {
  const json = JSON.stringify(parts);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): string[] {
  try {
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
      throw new Error('unexpected cursor payload');
    }
    return parsed.map((part) => String(part));
  } catch {
    throw errors.validation({ cursor: 'cursor is not a valid continuation cursor' });
  }
}

export function decodeCursorNumber(cursor: string, index: number): number {
  const parts = decodeCursor(cursor);
  const raw = parts[index];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw errors.validation({ cursor: 'cursor is not a valid continuation cursor' });
  }
  return value;
}

export function decodeCursorString(cursor: string, index: number): string {
  const parts = decodeCursor(cursor);
  const value = parts[index];
  if (value === undefined || value === '') {
    throw errors.validation({ cursor: 'cursor is not a valid continuation cursor' });
  }
  return value;
}

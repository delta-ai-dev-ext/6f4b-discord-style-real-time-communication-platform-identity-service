import type { ClockPort, IdGeneratorPort } from '../../src/repositories/ports';

/** Deterministic clock: tests never depend on wall-clock time. */
export class FakeClock implements ClockPort {
  private current: Date;

  constructor(initial: Date = new Date('2025-01-15T12:00:00.000Z')) {
    this.current = initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date);
  }
}

/** Deterministic uuid-shaped id generator. */
export class FakeIdGenerator implements IdGeneratorPort {
  private counter: number;

  constructor(start = 0) {
    this.counter = start;
  }

  newId(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

export const USER_IDS = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
  carol: '33333333-3333-4333-8333-333333333333',
} as const;

export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

export function clerkUserPayload(
  overrides: Partial<{
    id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    image_url: string;
    email: string;
    deleted: boolean;
  }> = {},
): Record<string, unknown> {
  const id = overrides.id ?? USER_IDS.alice;
  return {
    id,
    username: overrides.username ?? 'alice',
    first_name: overrides.first_name ?? 'Alice',
    last_name: overrides.last_name ?? 'Anderson',
    image_url: overrides.image_url ?? 'https://cdn.example.com/alice.png',
    primary_email_address_id: 'idn_1',
    email_addresses: [
      { id: 'idn_2', email_address: 'secondary@example.com' },
      { id: 'idn_1', email_address: overrides.email ?? 'alice@example.com' },
    ],
    deleted: overrides.deleted ?? false,
  };
}

export function clerkEvent(
  type: 'user.created' | 'user.updated' | 'user.deleted',
  data: Record<string, unknown> = clerkUserPayload(),
): { type: string; data: Record<string, unknown> } {
  return { type, data };
}

import { differenceInMilliseconds } from 'date-fns';
import { systemClock, type ClockPort } from '../repositories/ports';

/**
 * Per-pod fixed-window limiter (no shared state, per SYSTEM_DESIGN §7).
 * Sized by `FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE`; keys are verified user ids
 * so one noisy caller cannot exhaust another caller's budget.
 */

type Window = { windowStart: number; count: number };

export class TokenBucketRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: ClockPort;
  private readonly windows = new Map<string, Window>();

  constructor(limitPerMinute: number, options?: { windowMs?: number; clock?: ClockPort }) {
    this.limit = Math.max(1, Math.floor(limitPerMinute));
    this.windowMs = options?.windowMs ?? 60_000;
    this.clock = options?.clock ?? systemClock;
  }

  /** Consumes one token; returns `false` when the caller is over budget. */
  tryConsume(key: string): boolean {
    const now = this.clock.now();
    const current = this.windows.get(key);

    if (current === undefined || differenceInMilliseconds(now, current.windowStart) >= this.windowMs) {
      this.windows.set(key, { windowStart: now.getTime(), count: 1 });
      this.evict(now.getTime());
      return true;
    }

    if (current.count >= this.limit) return false;

    current.count += 1;
    return true;
  }

  /** Remaining budget for a key (used by tests and diagnostics). */
  remaining(key: string): number {
    const current = this.windows.get(key);
    if (current === undefined) return this.limit;
    if (differenceInMilliseconds(this.clock.now(), current.windowStart) >= this.windowMs) {
      return this.limit;
    }
    return Math.max(0, this.limit - current.count);
  }

  private evict(nowMs: number): void {
    // Bounded memory: drop stale windows whenever a new one is created.
    for (const [key, window] of this.windows) {
      if (nowMs - window.windowStart >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}

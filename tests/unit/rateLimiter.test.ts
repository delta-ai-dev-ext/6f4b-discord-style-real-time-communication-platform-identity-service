import { describe, expect, test } from 'bun:test';
import { TokenBucketRateLimiter } from '../../src/services/rateLimiter';
import { FakeClock } from '../mocks/fixtures';

describe('token bucket rate limiter', () => {
  test('allows the configured budget per window and then rejects', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketRateLimiter(3, { clock });

    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.tryConsume('alice')).toBe(false);
    expect(limiter.remaining('alice')).toBe(0);
  });

  test('windows are per caller and reset after a minute', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketRateLimiter(1, { clock });

    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.tryConsume('alice')).toBe(false);
    expect(limiter.tryConsume('bob')).toBe(true);

    clock.advanceMs(59_999);
    expect(limiter.tryConsume('alice')).toBe(false);

    clock.advanceMs(1);
    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.remaining('bob')).toBe(1);
  });

  test('remaining reflects the current budget and expires with the window', () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketRateLimiter(2, { clock });

    expect(limiter.remaining('carol')).toBe(2);
    limiter.tryConsume('carol');
    expect(limiter.remaining('carol')).toBe(1);
    clock.advanceMs(60_000);
    expect(limiter.remaining('carol')).toBe(2);
  });

  test('never allows a zero or negative budget', () => {
    const limiter = new TokenBucketRateLimiter(0);
    expect(limiter.tryConsume('alice')).toBe(true);
    expect(limiter.tryConsume('alice')).toBe(false);
  });
});

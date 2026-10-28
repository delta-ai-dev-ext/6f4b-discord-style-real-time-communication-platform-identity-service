import { describe, expect, test } from 'bun:test';
import {
  parseTraceparent,
  resolveTraceContext,
  traceIdFromHeader,
} from '../../src/observability/trace';
import { TRACE_ID, TRACEPARENT } from '../mocks/fixtures';

describe('trace context', () => {
  const cases: Array<[string, string | null | undefined, boolean]> = [
    ['valid header', TRACEPARENT, true],
    ['uppercase hex', TRACEPARENT.toUpperCase(), true],
    ['missing header', undefined, false],
    ['null header', null, false],
    ['empty header', '', false],
    ['wrong field count', '00-abc-01', false],
    ['all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, false],
    ['all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`, false],
    ['forbidden version ff', `ff-${TRACE_ID}-00f067aa0ba902b7-01`, false],
    ['future version 01', `01-${TRACE_ID}-00f067aa0ba902b7-01`, true],
    ['short trace id', `00-abc-00f067aa0ba902b7-01`, false],
  ];

  test.each(cases)('parseTraceparent handles %s', (_name, header, expected) => {
    const parsed = parseTraceparent(header);
    if (expected) {
      expect(parsed).toBeDefined();
      expect(parsed?.traceId).toBe(TRACE_ID);
      expect(parsed?.spanId).toBe('00f067aa0ba902b7');
    } else {
      expect(parsed).toBeUndefined();
    }
  });

  test('resolveTraceContext continues an inbound trace', () => {
    const resolved = resolveTraceContext(TRACEPARENT);
    expect(resolved.traceId).toBe(TRACE_ID);
    expect(resolved.traceparent).toBe(TRACEPARENT);
  });

  test('resolveTraceContext starts a fresh trace when absent', () => {
    const resolved = resolveTraceContext(undefined);
    expect(resolved.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(resolved.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(resolved.traceparent).toBe(`00-${resolved.traceId}-${resolved.spanId}-01`);
    expect(resolveTraceContext(undefined).traceId).not.toBe(resolved.traceId);
  });

  test('traceIdFromHeader exposes only the trace id', () => {
    expect(traceIdFromHeader(TRACEPARENT)).toBe(TRACE_ID);
    expect(traceIdFromHeader('garbage')).toBeUndefined();
  });
});

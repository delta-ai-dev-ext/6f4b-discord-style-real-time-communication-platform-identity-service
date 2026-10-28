/**
 * W3C Trace Context helpers.
 *
 * The service accepts `traceparent` from inbound HTTP, uses the trace id in
 * every structured log line (`trace_id`), stores the header in
 * `outbox_event.headers` and republishes it in the Kafka envelope
 * (`trace_parent`) so consumers continue the same trace.
 */

const TRACE_PARENT_PATTERN = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

export type TraceContext = {
  traceparent: string;
  traceId: string;
  spanId: string;
};

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isAllZero(hex: string): boolean {
  return /^0+$/.test(hex);
}

/** Parses a W3C `traceparent` header, returning `undefined` when malformed. */
export function parseTraceparent(headerValue: string | null | undefined): TraceContext | undefined {
  if (typeof headerValue !== 'string') return undefined;
  const match = TRACE_PARENT_PATTERN.exec(headerValue.trim().toLowerCase());
  if (match === null) return undefined;

  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff') return undefined;
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  if (isAllZero(traceId) || isAllZero(spanId)) return undefined;

  return {
    traceparent: `${version}-${traceId}-${spanId}-${flags}`,
    traceId,
    spanId,
  };
}

/** Continues an inbound trace, or starts a fresh one when absent/invalid. */
export function resolveTraceContext(headerValue: string | null | undefined): TraceContext {
  const parsed = parseTraceparent(headerValue);
  if (parsed !== undefined) return parsed;

  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    traceId,
    spanId,
  };
}

/** Derives a trace id suitable for logging when only a header is available. */
export function traceIdFromHeader(headerValue: string | null | undefined): string | undefined {
  return parseTraceparent(headerValue)?.traceId;
}

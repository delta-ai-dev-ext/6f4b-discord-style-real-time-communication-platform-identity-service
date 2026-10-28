import { afterEach, describe, expect, test } from 'bun:test';
import { createLogger, redact, SERVICE_NAME, silentLogger } from '../../src/observability/logger';

/** Captures JSON log lines written to stdout. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never;
  return {
    lines,
    restore: () => {
      process.stdout.write = original as never;
    },
  };
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
}

describe('structured logger', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test('redacts secrets and emails', () => {
    const redacted = redact({
      route: 'POST /v1/webhooks/clerk',
      authorization: 'Bearer secret',
      'svix-signature': 'v1,abc',
      email: 'alice@example.com',
      status_code: 200,
    });

    expect(redacted).toEqual({
      route: 'POST /v1/webhooks/clerk',
      authorization: '[redacted]',
      'svix-signature': '[redacted]',
      email: '[redacted]',
      status_code: 200,
    });
    expect(redact(undefined)).toBeUndefined();
  });

  test('emits JSON lines carrying the service name and request context', async () => {
    const capture = captureStdout();
    restore = capture.restore;

    const logger = createLogger('info');
    logger.info('request completed', {
      route: 'GET /v1/me',
      method: 'GET',
      status_code: 200,
      trace_id: 'abc',
      email: 'alice@example.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [line] = parseLines(capture.lines);
    expect(line?.['service']).toBe(SERVICE_NAME);
    expect(line?.['level']).toBe('info');
    expect(line?.['message']).toBe('request completed');
    expect(line?.['route']).toBe('GET /v1/me');
    expect(line?.['status_code']).toBe(200);
    expect(line?.['trace_id']).toBe('abc');
    expect(line?.['email']).toBe('[redacted]');
    expect(typeof line?.['timestamp']).toBe('string');
  });

  test('respects the configured level', async () => {
    const capture = captureStdout();
    restore = capture.restore;

    const logger = createLogger('error');
    logger.info('dropped');
    logger.error('kept');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const lines = parseLines(capture.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['message']).toBe('kept');
  });

  test('child loggers inherit bindings', async () => {
    const capture = captureStdout();
    restore = capture.restore;

    const child = createLogger('debug').child({ component: 'outbox' });
    child.debug('polled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [line] = parseLines(capture.lines);
    expect(line?.['component']).toBe('outbox');
    expect(line?.['service']).toBe(SERVICE_NAME);
  });

  test('silent logger is a no-op', () => {
    expect(() => {
      silentLogger.debug('a');
      silentLogger.info('b');
      silentLogger.warn('c');
      silentLogger.error('d');
      silentLogger.child({ component: 'x' }).info('e');
    }).not.toThrow();
  });
});

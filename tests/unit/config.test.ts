import { describe, expect, test } from 'bun:test';
import { ConfigError, configSchema, loadConfig, parseConfig, resetConfigCache } from '../../src/config';

const validEnv = {
  DATABASE_URL: 'postgresql://user:secret@db:5432/identity_service',
  KAFKA_BROKERS: 'broker-1:9092, broker-2:9092',
  CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----abc',
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test',
};

describe('config', () => {
  test('applies documented defaults', () => {
    const config = parseConfig({ ...validEnv });

    expect(config).toEqual({
      port: 8080,
      logLevel: 'info',
      databaseUrl: validEnv.DATABASE_URL,
      kafkaBrokers: ['broker-1:9092', 'broker-2:9092'],
      kafkaClientId: 'identity_service',
      kafkaSsl: false,
      clerkJwtKey: validEnv.CLERK_JWT_KEY,
      clerkWebhookSigningSecret: validEnv.CLERK_WEBHOOK_SIGNING_SECRET,
      outboxPollIntervalMs: 100,
      outboxBatchSize: 100,
      outboxMaxAttempts: 10,
      friendRequestRateLimitPerMinute: 20,
    });
    expect(config.metricsPort).toBeUndefined();
  });

  test('parses overrides and optional metrics port', () => {
    const config = parseConfig({
      ...validEnv,
      PORT: '3000',
      LOG_LEVEL: 'debug',
      KAFKA_CLIENT_ID: 'identity-1',
      KAFKA_SSL: 'true',
      OUTBOX_POLL_INTERVAL_MS: '25',
      OUTBOX_BATCH_SIZE: '7',
      OUTBOX_MAX_ATTEMPTS: '3',
      FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE: '5',
      METRICS_PORT: '9100',
    });

    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('debug');
    expect(config.kafkaClientId).toBe('identity-1');
    expect(config.kafkaSsl).toBe(true);
    expect(config.outboxPollIntervalMs).toBe(25);
    expect(config.outboxBatchSize).toBe(7);
    expect(config.outboxMaxAttempts).toBe(3);
    expect(config.friendRequestRateLimitPerMinute).toBe(5);
    expect(config.metricsPort).toBe(9100);
  });

  test.each([
    ['empty broker list', { ...validEnv, KAFKA_BROKERS: ' , ' }],
    ['non-postgres dsn', { ...validEnv, DATABASE_URL: 'mysql://db/identity' }],
    ['unsupported log level', { ...validEnv, LOG_LEVEL: 'trace' }],
    ['non numeric port', { ...validEnv, PORT: 'eighty' }],
    ['zero batch size', { ...validEnv, OUTBOX_BATCH_SIZE: '0' }],
  ])('rejects %s', (_name, env) => {
    expect(() => parseConfig(env)).toThrow(ConfigError);
  });

  test('lists every missing required variable', () => {
    try {
      parseConfig({});
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues).toContain('DATABASE_URL is required');
      expect(issues).toContain('KAFKA_BROKERS is required');
      expect(issues).toContain('CLERK_JWT_KEY is required');
      expect(issues).toContain('CLERK_WEBHOOK_SIGNING_SECRET is required');
      expect(issues).toHaveLength(4);
    }
  });

  test('rejects an invalid boolean flag with an actionable message', () => {
    expect(() => configSchema.parse({ ...validEnv, KAFKA_SSL: 'maybe' })).toThrow();
  });

  test('memoizes loadConfig and can be reset', () => {
    resetConfigCache();
    const first = loadConfig(validEnv);
    const second = loadConfig({ ...validEnv, PORT: '9' });
    expect(second.port).toBe(first.port);
    resetConfigCache();
    expect(loadConfig({ ...validEnv, PORT: '9' }).port).toBe(9);
    resetConfigCache();
  });
});

import { z } from 'zod';

/**
 * Configuration is entirely environment driven (12-factor) and validated once
 * at boot with zod. Any invalid or missing value fails the process before the
 * first request is served — never at request time.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === '') {
      return false;
    }
    ctx.addIssue({
      code: 'custom',
      message: `expected a boolean value, received "${value}"`,
    });
    return z.NEVER;
  });

const positiveInt = (defaultValue: number) =>
  z
    .union([z.string(), z.number()])
    .default(defaultValue)
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: 'custom', message: `expected a positive integer, received "${value}"` });
        return z.NEVER;
      }
      return parsed;
    });

const logLevels = ['debug', 'info', 'warn', 'error'] as const;

export const configSchema = z.object({
  PORT: positiveInt(8080),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  KAFKA_BROKERS: z
    .string()
    .min(1, 'KAFKA_BROKERS is required')
    .transform((value, ctx) => {
      const brokers = value
        .split(',')
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0);
      if (brokers.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'KAFKA_BROKERS must list at least one broker' });
        return z.NEVER;
      }
      return brokers;
    }),
  KAFKA_CLIENT_ID: z.string().min(1).default('identity_service'),
  KAFKA_SSL: booleanish.default(false),
  CLERK_JWT_KEY: z.string().min(1, 'CLERK_JWT_KEY is required'),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1, 'CLERK_WEBHOOK_SIGNING_SECRET is required'),
  OUTBOX_POLL_INTERVAL_MS: positiveInt(100),
  OUTBOX_BATCH_SIZE: positiveInt(100),
  OUTBOX_MAX_ATTEMPTS: positiveInt(10),
  FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE: positiveInt(20),
  METRICS_PORT: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return undefined;
      const parsed = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: 'custom', message: `expected a positive integer, received "${value}"` });
        return z.NEVER;
      }
      return parsed;
    }),
});

export type AppConfig = {
  port: number;
  logLevel: (typeof logLevels)[number];
  databaseUrl: string;
  kafkaBrokers: string[];
  kafkaClientId: string;
  kafkaSsl: boolean;
  clerkJwtKey: string;
  clerkWebhookSigningSecret: string;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxMaxAttempts: number;
  friendRequestRateLimitPerMinute: number;
  metricsPort?: number;
};

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type EnvSource = Record<string, string | undefined>;

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'KAFKA_BROKERS',
  'CLERK_JWT_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
] as const;

/**
 * Validates a raw environment record. Throws {@link ConfigError} listing every
 * problem found so a booting pod fails fast with actionable output.
 */
export function parseConfig(source: EnvSource): AppConfig {
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = source[key];
    return value === undefined || value.trim() === '';
  });

  const result = configSchema.safeParse(source);
  const issues: string[] = missing.map((key) => `${key} is required`);

  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const message = path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      if (!issues.includes(`${path} is required`)) {
        issues.push(message);
      }
    }
  }

  if (issues.length > 0 || !result.success) {
    throw new ConfigError(issues.length > 0 ? issues : ['configuration could not be parsed']);
  }

  const parsed = result.data;
  const config: AppConfig = {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    kafkaBrokers: parsed.KAFKA_BROKERS,
    kafkaClientId: parsed.KAFKA_CLIENT_ID,
    kafkaSsl: parsed.KAFKA_SSL,
    clerkJwtKey: parsed.CLERK_JWT_KEY,
    clerkWebhookSigningSecret: parsed.CLERK_WEBHOOK_SIGNING_SECRET,
    outboxPollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: parsed.OUTBOX_BATCH_SIZE,
    outboxMaxAttempts: parsed.OUTBOX_MAX_ATTEMPTS,
    friendRequestRateLimitPerMinute: parsed.FRIEND_REQUEST_RATE_LIMIT_PER_MINUTE,
  };

  if (parsed.METRICS_PORT !== undefined) {
    config.metricsPort = parsed.METRICS_PORT;
  }

  return config;
}

let cached: AppConfig | undefined;

/** Lazily validated process configuration for the running pod. */
export function loadConfig(source: EnvSource = process.env): AppConfig {
  cached ??= parseConfig(source);
  return cached;
}

/** Test helper: forget the memoized configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}
